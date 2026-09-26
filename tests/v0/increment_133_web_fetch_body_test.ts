import { createWebFetchTool } from '../../v0/agent/tools/web_fetch.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { runAgent } from '../../v0/agent/core/loop.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const boundedWait = async (promise: Promise<void>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('HTTP body did not stop')), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

Deno.test('HTTP error waits for body cancellation before returning its existing error', async () => {
  const cancelling = deferred();
  const release = deferred();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelling.resolve();
        return release.promise;
      },
    }),
    { status: 503 },
  );
  const tool = createWebFetchTool(() => Promise.resolve(response));
  let settled = false;
  const result = Promise.resolve(tool.execute({ url: 'https://example.com/unavailable' })).then(
    () => {
      settled = true;
      throw new Error('expected HTTP error');
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await Promise.race([
      cancelling.promise,
      result.then(() => {
        throw new Error('tool returned without cancelling its HTTP error body');
      }),
    ]);
    assert(!settled, 'tool did not await body cancellation');
  } finally {
    release.resolve();
  }
  const error = await result;
  assert(error instanceof Error);
  assert(error.message === 'web_fetch request failed (503) for https://example.com/unavailable');
  assert(response.body?.locked === false);
});

/** Real HTTP response keeps producing bytes until the client relinquishes the body. */
const continuousResponse = (status: number) => {
  const cancelled = deferred();
  let timer: ReturnType<typeof setInterval> | undefined;
  let writes = 0;
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, () => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = () => {
          writes++;
          controller.enqueue(new TextEncoder().encode('ongoing body\n'));
        };
        write();
        timer = setInterval(write, 10);
      },
      cancel: () => {
        clearInterval(timer);
        timer = undefined;
        cancelled.resolve();
      },
    });
    return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/continuous`,
    cancelled: cancelled.promise,
    writes: () => writes,
    close: async () => {
      clearInterval(timer);
      await server.shutdown();
    },
  };
};

Deno.test('web_fetch HTTP 503 closes its actual response and stops continuous server output', async () => {
  const server = continuousResponse(503);
  let response: Response | undefined;
  const tool = createWebFetchTool(async (input, init) => {
    response = await fetch(input, init);
    return response;
  });
  try {
    let error: unknown;
    try {
      await tool.execute({ url: server.url });
    } catch (value) {
      error = value;
    }
    assert(
      error instanceof Error &&
        error.message === `web_fetch request failed (503) for ${server.url}`,
    );
    assert(response?.bodyUsed === true && response.body?.locked === false);
    await boundedWait(server.cancelled);
    const writes = server.writes();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(server.writes() === writes, 'HTTP error left the server sending its body');
  } finally {
    await server.close();
  }
});

Deno.test('web_fetch user cancellation ends a real HTTP body before the cancelled turn', async () => {
  const server = continuousResponse(200);
  const turn = new AbortController();
  const received = deferred();
  let response: Response | undefined;
  const registry = new Registry([createWebFetchTool(async (input, init) => {
    response = await fetch(input, init);
    received.resolve();
    return response;
  })]);
  const result = runAgent(
    'fetch continuous HTTP body',
    {
      generate: () =>
        Promise.resolve({
          kind: 'tool_calls',
          calls: [{
            callId: 'cancel-http-body',
            name: 'web_fetch',
            arguments: { url: server.url },
          }],
        }),
    },
    registry,
    { signal: turn.signal },
  );
  try {
    await Promise.race([
      received.promise,
      result.then(() => {
        throw new Error('HTTP request failed before response');
      }),
    ]);
    // The tool begins reading the response in the current microtask turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    turn.abort('user cancelled');
    const outcome = await result;
    assert(!outcome.ok && outcome.stopReason === 'cancelled', JSON.stringify(outcome));
    assert(response?.bodyUsed === true && response.body?.locked === false);
    await boundedWait(server.cancelled);
  } finally {
    turn.abort();
    await server.close();
  }
});
