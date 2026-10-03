import { TurnCancelledError } from '../../v0/agent/core/cancellation.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { createWebFetchTool, MAX_WEB_FETCH_BYTES } from '../../v0/agent/tools/web_fetch.ts';
import type { Workspace } from '../../v0/agent/tools/work_tool_contract.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertBytes = (actual: Uint8Array, expected: Uint8Array): void => {
  assert(actual.byteLength === expected.byteLength, 'byte lengths differ');
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`byte differs at offset ${index}`);
    }
  }
};

const responseWithBytes = (
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
): Response => {
  const response = new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: { 'content-type': contentType },
  });
  Object.defineProperty(response, 'url', {
    value: 'https://example.com/final',
  });
  return response;
};

const temporaryWorkspace = async (): Promise<{
  readonly root: string;
  readonly workspace: Workspace;
  readonly close: () => Promise<void>;
}> => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-web-download-',
  });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  return {
    root,
    workspace: { root: await Deno.realPath(workspaceRoot) },
    close: () => Deno.remove(root, { recursive: true }),
  };
};

const failure = async (run: () => unknown | PromiseLike<unknown>): Promise<unknown> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
};

const waitForFileBytes = async (path: string, expected: Uint8Array): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const actual = await Deno.readFile(path);
      if (actual.byteLength === expected.byteLength) {
        assertBytes(actual, expected);
        return;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`download did not write its first chunk to ${path}`);
};

Deno.test('Increment 172 web_fetch streams complete binary downloads larger than 1 MiB', async () => {
  const fixture = await temporaryWorkspace();
  try {
    const bytes = Uint8Array.from(
      { length: MAX_WEB_FETCH_BYTES + 73_123 },
      (_, index) => index % 251,
    );
    const tool = createWebFetchTool(
      () => Promise.resolve(responseWithBytes(bytes)),
      {
        workspace: fixture.workspace,
      },
    );
    const output = await tool.execute({
      url: 'https://example.com/archive',
      save_to: 'downloads/archive.zip',
    });
    assert(typeof output === 'string');
    assert(
      output.includes(`Saved: ${fixture.workspace.root}/downloads/archive.zip`),
    );
    assert(output.includes('URL: https://example.com/final'));
    assert(output.includes('Status: 200'));
    assert(output.includes('Content-Type: application/octet-stream'));
    assert(output.includes(`Bytes: ${bytes.byteLength}`));
    assertBytes(
      await Deno.readFile(`${fixture.workspace.root}/downloads/archive.zip`),
      bytes,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test('Increment 172 bundled web_fetch saves binary bytes from a loopback HTTP response', async () => {
  const fixture = await temporaryWorkspace();
  const bytes = Uint8Array.from({ length: 128_321 }, (_, index) => (index * 13) % 256);
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen: () => {} },
    () =>
      new Response(bytes.slice().buffer as ArrayBuffer, {
        headers: { 'content-type': 'application/octet-stream' },
      }),
  );
  try {
    const tool = createWebFetchTool(fetch, { workspace: fixture.workspace });
    const output = await new Registry([tool]).dispatch({
      callId: 'increment-172-loopback',
      name: 'web_fetch',
      arguments: {
        url: `http://127.0.0.1:${server.addr.port}/archive`,
        save_to: 'download/archive.bin',
      },
    });
    assert(output.terminal === null);
    assert(output.content.kind === 'tool_result');
    assert(output.content.outcome === 'success');
    assert(output.content.text.includes('Status: 200'));
    assert(output.content.text.includes('Content-Type: application/octet-stream'));
    assert(output.content.text.includes(`Bytes: ${bytes.byteLength}`));
    assertBytes(
      await Deno.readFile(`${fixture.workspace.root}/download/archive.bin`),
      bytes,
    );
  } finally {
    await server.shutdown();
    await fixture.close();
  }
});

Deno.test('Increment 172 web_fetch accepts an absolute /tmp download path', async () => {
  const fixture = await temporaryWorkspace();
  try {
    const bytes = new Uint8Array([0, 255, 12, 128]);
    const path = `${fixture.root}/outside-workspace.bin`;
    const tool = createWebFetchTool(
      () => Promise.resolve(responseWithBytes(bytes)),
      {
        workspace: fixture.workspace,
      },
    );
    const output = await tool.execute({
      url: 'https://example.com/blob',
      save_to: path,
    });
    assert(typeof output === 'string' && output.includes(`Saved: ${path}`));
    assertBytes(await Deno.readFile(path), bytes);
    const relativeTmpPath = `${fixture.root}/relative-parent.bin`;
    const relativeOutput = await tool.execute({
      url: 'https://example.com/blob',
      save_to: '../relative-parent.bin',
    });
    assert(
      typeof relativeOutput === 'string' && relativeOutput.includes(relativeTmpPath),
    );
    assertBytes(await Deno.readFile(relativeTmpPath), bytes);
  } finally {
    await fixture.close();
  }
});

Deno.test('Increment 172 web_fetch follows symlinks whose resolved paths stay in the workspace', async () => {
  const fixture = await temporaryWorkspace();
  try {
    const realDirectory = `${fixture.workspace.root}/real-directory`;
    await Deno.mkdir(realDirectory);
    await Deno.symlink(realDirectory, `${fixture.workspace.root}/linked-directory`);
    const bytes = new Uint8Array([0, 3, 9, 255]);
    const tool = createWebFetchTool(() => Promise.resolve(responseWithBytes(bytes)), {
      workspace: fixture.workspace,
    });
    const result = await tool.execute({
      url: 'https://example.com/blob',
      save_to: 'linked-directory/file.bin',
    });
    assert(
      typeof result === 'string' && result.includes(`${realDirectory}/file.bin`),
    );
    assertBytes(await Deno.readFile(`${realDirectory}/file.bin`), bytes);
  } finally {
    await fixture.close();
  }
});

Deno.test('Increment 172 web_fetch rejects outside paths and symlink escapes before fetch', async () => {
  const fixture = await temporaryWorkspace();
  try {
    const outside = Deno.cwd();
    await Deno.symlink(outside, `${fixture.workspace.root}/escape`);
    let calls = 0;
    const tool = createWebFetchTool(() => {
      calls += 1;
      return Promise.resolve(responseWithBytes(new Uint8Array([1])));
    }, { workspace: fixture.workspace });
    for (
      const saveTo of [
        `${outside}/increment-172-outside.bin`,
        'escape/increment-172-symlink.bin',
        `../../../${outside.slice(1)}/increment-172-parent.bin`,
      ]
    ) {
      const error = await failure(() =>
        tool.execute({
          url: 'https://example.com/blob',
          save_to: saveTo,
        })
      );
      assert(error instanceof Error, `expected rejection for ${saveTo}`);
    }
    assert(calls === 0, 'rejected paths reached the fetcher');
    const entries = await Array.fromAsync(Deno.readDir(fixture.workspace.root));
    assert(entries.length === 1 && entries[0]?.name === 'escape');
  } finally {
    await fixture.close();
  }
});

Deno.test('Increment 172 web_fetch keeps downloaded HTML raw while display fetch extracts text', async () => {
  const fixture = await temporaryWorkspace();
  try {
    const source = '<html><body><p>Visible &amp; raw</p></body></html>';
    const bytes = new TextEncoder().encode(source);
    const tool = createWebFetchTool(
      () => Promise.resolve(responseWithBytes(bytes, 'text/html; charset=utf-8')),
      { workspace: fixture.workspace },
    );
    const displayed = await tool.execute({ url: 'https://example.com/page' });
    assert(
      typeof displayed === 'string' && displayed.includes('Visible & raw'),
    );
    assert(!displayed.includes('<p>'));
    const saved = await tool.execute({
      url: 'https://example.com/page',
      save_to: 'page.html',
    });
    assert(typeof saved === 'string');
    assertBytes(
      await Deno.readFile(`${fixture.workspace.root}/page.html`),
      bytes,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test('Increment 172 web_fetch rejects existing targets before fetch and preserves their bytes', async () => {
  const fixture = await temporaryWorkspace();
  try {
    const path = `${fixture.workspace.root}/existing.bin`;
    const original = new Uint8Array([8, 6, 7, 5, 3, 0, 9]);
    await Deno.writeFile(path, original);
    let calls = 0;
    const tool = createWebFetchTool(() => {
      calls += 1;
      return Promise.resolve(responseWithBytes(new Uint8Array([1, 2, 3])));
    }, { workspace: fixture.workspace });
    const error = await failure(() =>
      tool.execute({
        url: 'https://example.com/replacement',
        save_to: path,
      })
    );
    assert(error instanceof Error && error.message.includes('already exists'));
    assert(calls === 0, 'existing target reached the fetcher');
    assertBytes(await Deno.readFile(path), original);
  } finally {
    await fixture.close();
  }
});

Deno.test('Increment 172 web_fetch cancellation does not report a partial download as successful', async () => {
  const fixture = await temporaryWorkspace();
  const controller = new AbortController();
  let streamCancelled = false;
  try {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (stream) => stream.enqueue(new Uint8Array([1, 2, 3])),
        cancel: () => {
          streamCancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/octet-stream' } },
    );
    Object.defineProperty(response, 'url', {
      value: 'https://example.com/slow',
    });
    const tool = createWebFetchTool(() => Promise.resolve(response), {
      workspace: fixture.workspace,
    });
    const result = tool.execute({
      url: 'https://example.com/slow',
      save_to: 'partial.bin',
    }, {
      signal: controller.signal,
    });
    const errorPromise = failure(() => result);
    const partialPath = `${fixture.workspace.root}/partial.bin`;
    await waitForFileBytes(partialPath, new Uint8Array([1, 2, 3]));
    controller.abort('user cancelled');
    const error = await errorPromise;
    assert(error instanceof TurnCancelledError);
    assert(streamCancelled, 'cancellation did not close the response body');
    assertBytes(await Deno.readFile(partialPath), new Uint8Array([1, 2, 3]));
  } finally {
    controller.abort();
    await fixture.close();
  }
});
