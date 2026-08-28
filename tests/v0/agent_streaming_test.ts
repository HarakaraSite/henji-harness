import { assert, assertEquals } from './test_helpers.ts';
import { type AgentEvent, EventDeliveryError } from '../../v0/agent/events.ts';
import { runAgentTurn } from '../../v0/agent/loop.ts';
import { TurnCancellationOwner } from '../../v0/agent/cancellation.ts';
import { AGENT_SESSION_UNAVAILABLE, AgentSession } from '../../v0/agent/session.ts';
import {
  MAX_ASSISTANT_PROGRESS_TEXT_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SSE_DATA_EVENTS,
  OpenRouterAgentError,
  OpenRouterAgentModel,
} from '../../v0/agent/openrouter_model.ts';
import { createFixtureTool, Registry } from '../../v0/agent/tools.ts';
import type { ModelRequest } from '../../v0/agent/contracts.ts';

const encoder = new TextEncoder();
const ENDPOINT = 'https://offline.invalid/api/v1/chat/completions';
const CREDENTIAL = 'offline-streaming-credential';

const request = (): ModelRequest => ({
  transcript: [{
    role: 'user',
    content: { kind: 'text', text: 'stream task' },
  }],
  tools: [createFixtureTool()],
});

const streamResponse = (body: string, split = 0): Response => {
  const bytes = encoder.encode(body);
  let cancelled = false;
  const chunks: Uint8Array[] = [];
  if (split <= 0) chunks.push(bytes);
  else {for (let offset = 0; offset < bytes.byteLength; offset += split) {
      chunks.push(bytes.slice(offset, offset + split));
    }}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
  Object.defineProperty(response, 'offlineCancelled', {
    value: () => cancelled,
  });
  return response;
};

const rawStreamResponse = (body: Uint8Array): Response => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  Object.defineProperty(response, 'offlineCancelled', { value: () => cancelled });
  return response;
};

const modelFor = (response: Response): OpenRouterAgentModel =>
  new OpenRouterAgentModel({
    fetcher: () => Promise.resolve(response),
    credential: CREDENTIAL,
    endpoint: ENDPOINT,
    responseMode: 'sse',
  });

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const gatedSseResponse = (
  body: string,
  cleanup: 'await' | 'fail',
): {
  readonly response: Response;
  readonly setProviderSignal: (signal: AbortSignal | null | undefined) => void;
  readonly cleanup: { resolve(): void };
  readonly state: { cancelCalled: boolean; signalAbortedAtCancel: boolean };
} => {
  let resolveCleanup!: () => void;
  const cleanupPromise = new Promise<void>((resolve) => resolveCleanup = resolve);
  const state = { cancelCalled: false, signalAbortedAtCancel: false };
  let providerSignal: AbortSignal | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
    },
    cancel() {
      state.cancelCalled = true;
      state.signalAbortedAtCancel = providerSignal?.aborted === true;
      if (cleanup === 'fail') return Promise.reject(new Error('offline cleanup marker'));
      return cleanupPromise;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  return {
    response,
    setProviderSignal: (signal) => providerSignal = signal ?? undefined,
    cleanup: { resolve: resolveCleanup },
    state,
  };
};

const gatedModelFor = (
  gated: ReturnType<typeof gatedSseResponse>,
): OpenRouterAgentModel =>
  new OpenRouterAgentModel({
    fetcher: (_input, init) => {
      gated.setProviderSignal(init?.signal);
      return Promise.resolve(gated.response);
    },
    credential: CREDENTIAL,
    endpoint: ENDPOINT,
    responseMode: 'sse',
  });

const finalEvents = (id: string, text: string): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: 'stop',
      }],
    })
  }\n\n` +
  `data: ${
    JSON.stringify({
      id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }\n\n` +
  'data: [DONE]\n\n';

const toolEvents = (): string => {
  const id = 'chatcmpl-tool';
  const first = {
    id,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 1,
          id: 'call-1',
          type: 'function',
          function: { name: 'uppercase_text', arguments: '{' },
        }],
      },
      finish_reason: null,
    }],
  };
  const second = {
    id,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-0',
          type: 'function',
          function: { name: 'uppercase_text', arguments: '{"text":"' },
        }],
      },
      finish_reason: null,
    }],
  };
  const third = {
    id,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [
          { index: 1, function: { arguments: '}' } },
          { index: 0, function: { arguments: 'hello 🐣"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  };
  return [first, second, third].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') +
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }\n\n` +
    'data: [DONE]\n\n';
};

const assertAdapterError = async (
  operation: () => Promise<unknown>,
  code: OpenRouterAgentError['code'],
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof OpenRouterAgentError);
    assertEquals(error.code, code);
    assert(!error.message.includes(CREDENTIAL));
    assert(!JSON.stringify(error).includes('PROVIDER_BODY_MARKER'));
    return;
  }
  throw new Error('expected adapter error');
};

Deno.test('SSE final assembly handles BOM, comments, arbitrary UTF-8 splits, and usage', async () => {
  const response = streamResponse(
    `\ufeff: OPENROUTER PROCESSING\r\n` +
      'event: message\r\n' +
      finalEvents('chatcmpl-final', 'hello 🐣'),
    1,
  );
  const snapshots: string[] = [];
  const result = await modelFor(response).generate(request(), {
    reportAssistantProgress: (snapshot) => snapshots.push(snapshot),
  });
  assertEquals(result, { kind: 'final', text: 'hello 🐣' });
  assertEquals(snapshots, ['hello 🐣']);
});

Deno.test('SSE tool fragments assemble by index and parse only after terminal validation', async () => {
  const result = await modelFor(streamResponse(toolEvents(), 2)).generate(
    request(),
  );
  assertEquals(result, {
    kind: 'tool_calls',
    calls: [
      {
        callId: 'call-0',
        name: 'uppercase_text',
        arguments: { text: 'hello 🐣' },
      },
      { callId: 'call-1', name: 'uppercase_text', arguments: {} },
    ],
  });
});

Deno.test('SSE accepts one bounded documented usage frame and rejects duplicate terminal frames', async () => {
  const id = 'chatcmpl-usage-frame';
  const semantic = `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: 'answer' },
        finish_reason: 'stop',
      }],
    })
  }\n\n`;
  const usage = `data: ${
    JSON.stringify({
      id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })
  }\n\n`;
  const done = 'data: [DONE]\n\n';
  assertEquals(
    await modelFor(streamResponse(semantic + usage + done)).generate(request()),
    { kind: 'final', text: 'answer' },
  );
  const extraMetadataUsage = `data: ${
    JSON.stringify({
      id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        cost: 0,
      },
    })
  }\n\n`;
  assertEquals(
    await modelFor(streamResponse(semantic + extraMetadataUsage + done)).generate(request()),
    { kind: 'final', text: 'answer' },
  );
  await assertAdapterError(
    () => modelFor(streamResponse(semantic + semantic + done)).generate(request()),
    'response_error',
  );
  await assertAdapterError(
    () => modelFor(streamResponse(semantic + usage + usage + done)).generate(request()),
    'response_error',
  );
});

Deno.test('SSE ownership, terminal, and malformed data failures are sanitized before progress', async () => {
  const cases = [
    `data: ${
      JSON.stringify({
        id: 'one',
        choices: [{
          index: 0,
          delta: { content: 'partial' },
          finish_reason: null,
        }],
      })
    }\n\n` +
    `data: ${
      JSON.stringify({
        id: 'two',
        choices: [{
          index: 0,
          delta: { content: 'late' },
          finish_reason: 'stop',
        }],
      })
    }\n\n` +
    'data: [DONE]\n\n',
    `data: ${
      JSON.stringify({
        id: 'one',
        choices: [{
          index: 1,
          delta: { content: 'bad' },
          finish_reason: 'stop',
        }],
      })
    }\n\n` +
    'data: [DONE]\n\n',
    'data: {"id":"one","choices":[{"index":0,"delta":{"content":"bad"},"finish_reason":"stop"}]}\n\n',
    `data: ${
      JSON.stringify({
        id: 'one',
        choices: [{
          index: 0,
          delta: { content: 'bad' },
          finish_reason: 'stop',
        }],
      })
    }\n\n` +
    'data: {"error":"PROVIDER_BODY_MARKER"}\n\n' +
    'data: [DONE]\n\n',
  ];
  const expectedSnapshots = [['partial'], [], ['bad'], ['bad']];
  for (const [index, body] of cases.entries()) {
    const snapshots: string[] = [];
    await assertAdapterError(
      () =>
        modelFor(streamResponse(body)).generate(request(), {
          reportAssistantProgress: (snapshot) => snapshots.push(snapshot),
        }),
      'response_error',
    );
    assertEquals(snapshots, expectedSnapshots[index]);
  }
});

Deno.test('SSE text snapshots ignore empty deltas and stop at the exact update bound', async () => {
  const id = 'chatcmpl-update-bound';
  const fragments = [
    ...Array.from({ length: 257 }, () => 'x'),
    ...Array.from({ length: 4 }, () => ''),
  ];
  const body = fragments.map((content) =>
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })
    }\n\n`
  ).join('') +
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
    }\n\n` +
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }\n\n` + 'data: [DONE]\n\n';
  const events: AgentEvent[] = [];
  const result = await runAgentTurn(
    'task',
    [],
    modelFor(streamResponse(body)),
    new Registry([]),
    {
      eventSink: (event) => events.push(event),
    },
  );
  const snapshots = events.filter((event) => event.kind === 'assistant_progress').map((event) =>
    event.text
  );
  assert(result.ok);
  assertEquals(result.finalText, 'x'.repeat(257));
  assertEquals(snapshots.length, 256);
  assertEquals(snapshots.at(-1), 'x'.repeat(256));
  assert(MAX_RESPONSE_BYTES >= body.length);
});

Deno.test('SSE empty deltas do not consume a direct adapter snapshot', async () => {
  const id = 'chatcmpl-empty-deltas';
  const body = [
    { id, choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] },
    ...Array.from({ length: 256 }, () => ({
      id,
      choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
    })),
    { id, choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] },
    {
      id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
    {
      id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const snapshots: string[] = [];
  const result = await modelFor(streamResponse(body)).generate(request(), {
    reportAssistantProgress: (snapshot) => snapshots.push(snapshot),
  });
  assertEquals(result, { kind: 'final', text: 'ab' });
  assertEquals(snapshots, ['a', 'ab']);
});

Deno.test('SSE live text freezes at the largest complete UTF-8 prefix while final text continues', async () => {
  const id = 'chatcmpl-text-bound';
  const first = 'a'.repeat(MAX_ASSISTANT_PROGRESS_TEXT_BYTES - 4);
  const body = [
    { id, choices: [{ index: 0, delta: { content: first }, finish_reason: null }] },
    { id, choices: [{ index: 0, delta: { content: '🐣' }, finish_reason: null }] },
    { id, choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] },
    {
      id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
    {
      id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const snapshots: string[] = [];
  const result = await modelFor(streamResponse(body)).generate(request(), {
    reportAssistantProgress: (snapshot) => snapshots.push(snapshot),
  });
  assertEquals(result, {
    kind: 'final',
    text: `${first}🐣b`,
  });
  assertEquals(snapshots, [first, `${first}🐣`]);
  assertEquals(encoder.encode(snapshots.at(-1)!).byteLength, MAX_ASSISTANT_PROGRESS_TEXT_BYTES);
});

Deno.test('SSE timeout after headers is sanitized and settles the reader', async () => {
  let aborted = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const id = 'chatcmpl-timeout';
  const first = encoder.encode(`data: ${
    JSON.stringify({
      id,
      choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
    })
  }\n\n`);
  const response = await new Promise<Response>((resolve) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(first);
      },
      cancel() {
        aborted = true;
      },
    });
    resolve(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  });
  const model = new OpenRouterAgentModel({
    fetcher: (_input, init) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        controllerRef?.error(new Error('offline timeout'));
      }, { once: true });
      return Promise.resolve(response);
    },
    credential: CREDENTIAL,
    endpoint: ENDPOINT,
    responseMode: 'sse',
    timeoutMs: 5,
  });
  await assertAdapterError(() => model.generate(request()), 'transport_error');
  assert(aborted);
});

Deno.test('SSE framing rejects malformed UTF-8 and bounds raw bytes and data events', async () => {
  const malformed = rawStreamResponse(
    new Uint8Array([
      0x64,
      0x61,
      0x74,
      0x61,
      0x3a,
      0x20,
      0xc3,
      0x28,
      0x0a,
      0x0a,
    ]),
  );
  await assertAdapterError(() => modelFor(malformed).generate(request()), 'response_error');
  const exactFinal = finalEvents('chatcmpl-exact-body', 'ok');
  const exactBytes = encoder.encode(exactFinal);
  const padding = MAX_RESPONSE_BYTES - exactBytes.byteLength;
  const exact = `:${'x'.repeat(padding - 2)}\n${exactFinal}`;
  assertEquals(encoder.encode(exact).byteLength, MAX_RESPONSE_BYTES);
  const exactResponse = streamResponse(exact);
  assertEquals(await modelFor(exactResponse).generate(request()), { kind: 'final', text: 'ok' });

  const oversized = streamResponse(`:${'x'.repeat(MAX_RESPONSE_BYTES)}\n`);
  await assertAdapterError(() => modelFor(oversized).generate(request()), 'limit_exceeded');

  const id = 'chatcmpl-event-bound';
  const events = Array.from(
    { length: MAX_SSE_DATA_EVENTS + 1 },
    () =>
      `data: ${
        JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: null }] })
      }\n\n`,
  ).join('');
  const eventResponse = streamResponse(events);
  await assertAdapterError(() => modelFor(eventResponse).generate(request()), 'limit_exceeded');
});

Deno.test('SSE requires the event-stream media type and sanitizes reader failures', async () => {
  const jsonResponse = new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assertAdapterError(() => modelFor(jsonResponse).generate(request()), 'response_error');
  const failedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('PROVIDER_BODY_MARKER'));
    },
  });
  const failedResponse = new Response(failedBody, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  await assertAdapterError(() => modelFor(failedResponse).generate(request()), 'transport_error');
});

Deno.test('loop emits bounded assistant snapshots before one authoritative completed event', async () => {
  const events: AgentEvent[] = [];
  const result = await runAgentTurn(
    'task',
    [],
    {
      generate: (_request, options) => {
        options?.reportAssistantProgress?.('one');
        options?.reportAssistantProgress?.('two');
        options?.reportAssistantProgress?.('\ud800');
        return Promise.resolve({ kind: 'final', text: 'authoritative' });
      },
    },
    new Registry([]),
    { eventSink: (event) => events.push(event) },
  );
  assert(result.ok);
  assertEquals(
    events.filter((event) => event.kind === 'assistant_progress').map((event) => event.text),
    [
      'one',
      'two',
    ],
  );
  assertEquals(
    events.filter((event) => event.kind === 'assistant_message').length,
    1,
  );
  assertEquals(events.at(-1)?.kind, 'turn_end');
});

Deno.test('loop latches assistant progress sink failure and prevents completed result', async () => {
  let retained: (() => void) | undefined;
  let modelCaught = false;
  let signalAbortedWhenCaught = false;
  const events: AgentEvent[] = [];
  const cancellation = new TurnCancellationOwner();
  const result = runAgentTurn(
    'task',
    [],
    {
      generate: (_request, options) => {
        retained = () => options?.reportAssistantProgress?.('late');
        try {
          options?.reportAssistantProgress?.('will fail');
        } catch (error) {
          modelCaught = error instanceof EventDeliveryError;
          signalAbortedWhenCaught = options?.signal?.aborted === true;
          return Promise.resolve({ kind: 'final' as const, text: 'must not commit' });
        }
        return Promise.resolve({ kind: 'final', text: 'must not commit' });
      },
    },
    new Registry([]),
    {
      eventSink: (event) => {
        events.push(event);
        if (event.kind === 'assistant_progress') {
          throw new Error('sink failure');
        }
      },
      cancellation,
    },
  );
  let failed: unknown;
  try {
    await result;
  } catch (error) {
    failed = error;
  }
  assert(failed instanceof EventDeliveryError);
  assert(modelCaught);
  assert(signalAbortedWhenCaught);
  assertEquals(events.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_progress',
  ]);
  assertEquals(cancellation.state, 'cancel_requested');
  retained?.();
});

Deno.test('AgentSession gates SSE progress delivery failure until reader cleanup settles', async () => {
  const id = 'chatcmpl-progress-failure';
  const gated = gatedSseResponse(
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      })
    }\n\n`,
    'await',
  );
  const events: AgentEvent[] = [];
  let commits = 0;
  const model = gatedModelFor(gated);
  const session = new AgentSession(model, new Registry([]), {
    eventSink: (event) => {
      events.push(event);
      if (event.kind === 'assistant_progress') throw new Error('offline sink failure');
    },
    persistence: {
      record: undefined,
      commit: () => commits += 1,
      rollback: () => {},
      close: () => {},
    },
  });
  let settled = false;
  const pending = session.submit('gated progress');
  void pending.then(() => settled = true, () => settled = true);
  await waitFor(() => gated.state.cancelCalled, 'SSE reader cancellation');
  assert(gated.state.signalAbortedAtCancel);
  assertEquals(session.cancelActiveTurn(), 'already_requested');
  assert(!settled, 'SSE cleanup must gate outward settlement');
  assertEquals(commits, 0);
  assertEquals(events.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_progress',
  ]);
  gated.cleanup.resolve();
  let failure: unknown;
  try {
    await pending;
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof EventDeliveryError);
  assertEquals(session.transcriptSnapshot(), []);
  assertEquals(events.filter((event) => event.kind === 'turn_end'), []);
  assertEquals(session.cancelActiveTurn(), 'idle');
});

Deno.test('AgentSession retains progress EventDeliveryError and poisons on SSE cleanup failure', async () => {
  const id = 'chatcmpl-progress-cleanup-failure';
  const gated = gatedSseResponse(
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      })
    }\n\n`,
    'fail',
  );
  const events: AgentEvent[] = [];
  let commits = 0;
  const session = new AgentSession(gatedModelFor(gated), new Registry([]), {
    eventSink: (event) => {
      events.push(event);
      if (event.kind === 'assistant_progress') throw new Error('offline sink failure');
    },
    persistence: {
      record: undefined,
      commit: () => commits += 1,
      rollback: () => {},
      close: () => {},
    },
  });
  const pending = session.submit('poisoned progress');
  let failure: unknown;
  const settled = pending.then(
    () => {},
    (error) => failure = error,
  );
  await waitFor(() => gated.state.cancelCalled, 'failed SSE reader cancellation');
  assert(gated.state.signalAbortedAtCancel);
  await settled;
  assert(failure instanceof EventDeliveryError);
  assertEquals(commits, 0);
  assertEquals(session.transcriptSnapshot(), []);
  assertEquals(events.filter((event) => event.kind === 'turn_end'), []);
  let unavailable: unknown;
  try {
    await session.submit('must not restart');
  } catch (error) {
    unavailable = error;
  }
  assert(unavailable instanceof Error);
  assertEquals(unavailable.message, AGENT_SESSION_UNAVAILABLE);
});

Deno.test('SSE default-size boundary remains bounded and default JSON mode is unchanged', async () => {
  const calls: RequestInit[] = [];
  const json = new OpenRouterAgentModel({
    fetcher: (_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'json' } }],
          }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    },
    credential: CREDENTIAL,
    endpoint: ENDPOINT,
  });
  assertEquals(await json.generate(request()), { kind: 'final', text: 'json' });
  assertEquals(JSON.parse(calls[0].body as string).stream, false);
  assert(MAX_RESPONSE_BYTES === 1_048_576);
});
