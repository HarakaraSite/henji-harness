import {
  MAX_BUFFERED_RESPONSE_BYTES,
  OpenRouterAgentError,
  OpenRouterAgentModel,
  type OpenRouterAgentProfile,
} from '../../v0/agent/provider/openrouter_model.ts';
import { createTurnExecutionContext } from '../../v0/agent/core/execution_context.ts';
import { runAgent } from '../../v0/agent/core/loop.ts';
import {
  type ProviderEvidenceObservation,
  ProviderEvidenceRecorder,
  validateProviderEvidenceObservation,
} from '../../v0/agent/provider/provider_evidence.ts';
import { AgentSession } from '../../v0/agent/session/session.ts';
import { FailureDiagnosticOwner } from '../../v0/agent/session/failure_diagnostic.ts';
import { createJsonResultSubmissionTool, Registry } from '../../v0/agent/tools/tools.ts';
import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import {
  createProductionPhysicalIo,
  createWorkerRequestCounter,
} from '../../v0/agent/worker/worker_physical_io.ts';
import {
  credentialFilePresenceAt,
  type CredentialFileSystem,
} from '../../v0/agent/provider/credential_file.ts';
import { decodeResponse } from '../../v0/agent/provider/openrouter_response.ts';
import { MAX_CONVERSATION_TEXT_BYTES } from '../../v0/resource_limits.ts';
import { isTurnCancelledError } from '../../v0/agent/core/cancellation.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const PROFILE: OpenRouterAgentProfile = {
  id: 'test-profile',
  model: 'test/model',
  origin: 'https://openrouter.ai',
  path: '/api/v1/chat/completions',
  method: 'POST',
  secretEnv: 'HENJI_TEST_KEY',
  maxCompletionTokens: 128,
  stream: false,
};

Deno.test('credential presence probe distinguishes absence without opening credential bytes', async () => {
  let opens = 0;
  const filesystem = (
    lstat: CredentialFileSystem['lstat'],
  ): CredentialFileSystem => ({
    lstat,
    open: () => {
      opens += 1;
      return Promise.reject(new Error('credential must not be opened'));
    },
    effectiveUid: () => 1000,
  });
  assertEquals(
    await credentialFilePresenceAt(
      '/fixed/missing',
      filesystem(() => Promise.reject(new Deno.errors.NotFound())),
    ),
    'missing',
  );
  assertEquals(
    await credentialFilePresenceAt(
      '/fixed/unavailable',
      filesystem(() => Promise.reject(new Deno.errors.PermissionDenied())),
    ),
    'unknown',
  );
  assertEquals(
    await credentialFilePresenceAt(
      '/fixed/symlink',
      filesystem(() =>
        Promise.resolve({
          isFile: false,
          isSymlink: true,
          mode: 0o777,
          size: 0,
          uid: 1000,
        })
      ),
    ),
    'unknown',
  );
  assertEquals(
    await credentialFilePresenceAt(
      '/fixed/present',
      filesystem(() =>
        Promise.resolve({
          isFile: true,
          isSymlink: false,
          mode: 0o600,
          size: 64,
          uid: 1000,
        })
      ),
    ),
    'present',
  );
  assertEquals(opens, 0);
});

const request: ModelRequest = {
  transcript: [{ role: 'user', content: { kind: 'text', text: 'hello' } }],
  tools: [],
};

const usage = (id: string, finishReason: 'stop' | 'tool_calls'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { content: '', role: 'assistant' },
        finish_reason: finishReason,
        native_finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        cost: 0.01,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
  }\n\n`;

const textStream = (id = 'gen-text'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      }],
    })
  }\n\n${usage(id, 'stop')}data: [DONE]\n\n`;

const largeTextStream = (text: string, id = 'gen-large-text'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: 'stop',
      }],
    })
  }\n\n${usage(id, 'stop')}data: [DONE]\n\n`;

const largeEnvelopeStream = (eventCount = 4_100): {
  readonly raw: string;
  readonly chunks: readonly Uint8Array[];
} => {
  const id = 'gen-large-envelope';
  const frames = Array.from({ length: eventCount }, (_, index) =>
    `data: ${
      JSON.stringify({
        id,
        model: 'deepseek/deepseek-v4-pro-0813',
        provider: `provider-metadata-${'m'.repeat(220)}`,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: 'x' },
          finish_reason: index === eventCount - 1 ? 'stop' : null,
        }],
      })
    }\n\n`);
  frames.push(usage(id, 'stop'), 'data: [DONE]\n\n');
  const groups: string[] = [];
  for (let index = 0; index < frames.length; index += 500) {
    groups.push(frames.slice(index, index + 500).join(''));
  }
  return {
    raw: groups.join(''),
    chunks: groups.map((group) => new TextEncoder().encode(group)),
  };
};

const responseFromChunks = (chunks: readonly Uint8Array[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );

const capturedOpenRouterError = async (action: () => unknown | Promise<unknown>) => {
  try {
    await action();
  } catch (error) {
    assert(error instanceof OpenRouterAgentError);
    return error;
  }
  throw new Error('expected OpenRouterAgentError');
};

const toolStream = (id = 'gen-tool'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          reasoning_details: [{ type: 'reasoning.text', text: 'tool continuity' }],
          tool_calls: [{
            index: 0,
            id: 'submit-1',
            type: 'function',
            function: {
              name: 'submit_json_result',
              arguments: JSON.stringify({ json: '{"ok":true}' }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
  }\n\n${usage(id, 'tool_calls')}data: [DONE]\n\n`;

const mixedToolStream = (id = 'gen-mixed-tool'): string => {
  const event = (delta: unknown, finishReason: 'tool_calls' | null = null): string =>
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })
    }\n\n`;
  return `${event({ role: 'assistant', content: 'I will read the current source first.' })}${
    event({
      tool_calls: [{
        index: 0,
        id: 'read-mixed-1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"README.md"}' },
      }],
    })
  }${event({ content: '' }, 'tool_calls')}${usage(id, 'tool_calls')}data: [DONE]\n\n`;
};

const nullMetadataContinuationStream = (id = 'gen-mimo-tool'): string => {
  const event = (delta: unknown, finishReason: 'tool_calls' | null = null): string =>
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })
    }\n\n`;
  return `${event({ role: 'assistant', content: 'I will inspect the README files.' })}${
    event({
      tool_calls: [{
        index: 0,
        id: 'call-b2e69840',
        type: 'function',
        function: { name: 'bash', arguments: '' },
      }],
    })
  }${
    event({
      tool_calls: [{
        index: 0,
        id: null,
        type: 'function',
        function: { name: null, arguments: '{"command": ' },
      }],
    })
  }${
    event({
      tool_calls: [{
        index: 0,
        id: null,
        type: 'function',
        function: { name: null, arguments: '"pwd"}' },
      }],
    })
  }${event({}, 'tool_calls')}data: [DONE]\n\n`;
};

const nullableToolContinuationStream = (id = 'gen-nullable-tool'): string => {
  const event = (delta: unknown, finishReason: 'tool_calls' | null = null): string =>
    `data: ${
      JSON.stringify({ id, choices: [{ index: 0, delta, finish_reason: finishReason }] })
    }\n\n`;
  return `${
    event({
      tool_calls: [{
        index: 0,
        id: 'read-nullable-1',
        type: 'function',
        function: { name: 'read', arguments: '' },
      }],
    })
  }${
    event({
      tool_calls: [{ index: 0, id: null, type: null, function: null }],
    })
  }${
    event({
      tool_calls: [{
        index: 0,
        id: null,
        type: null,
        function: { name: null, arguments: null },
      }],
    })
  }${
    event({
      tool_calls: [{
        index: 0,
        id: null,
        type: null,
        function: { name: null, arguments: '{"limit":10,"path":"README.md"}' },
      }],
    })
  }${event({}, 'tool_calls')}data: [DONE]\n\n`;
};

const failingPostTerminalStream = (): string =>
  `${textStream('gen-failure').replace('data: [DONE]\n\n', '')}data: ${
    JSON.stringify({
      id: 'gen-failure',
      choices: [{ index: 0, delta: { content: 'late content' }, finish_reason: null }],
    })
  }\n\n`;

const modelFor = (
  body: string,
  seen: { requests: number },
  contentType = 'text/event-stream; charset=utf-8',
): OpenRouterAgentModel =>
  new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: (_input, init) => {
      seen.requests += 1;
      assert(init?.headers !== undefined);
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            'content-type': contentType,
            'x-generation-id': `gen-${seen.requests}`,
          },
        }),
      );
    },
  });

Deno.test('OpenRouter retries a pre-SSE 5xx inside one logical model step', async () => {
  const bodies: string[] = [];
  let requests = 0;
  const recorder = new ProviderEvidenceRecorder(
    '24242424-2424-4242-8242-242424242424',
    1,
    '2026-09-10T00:00:00.000Z',
  );
  const model = new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: (_input, init) => {
      requests += 1;
      bodies.push(String(init?.body));
      if (requests === 1) {
        return Promise.resolve(
          new Response('{"error":"temporary upstream failure"}', {
            status: 502,
            headers: { 'content-type': 'application/json', 'x-provider': 'test-upstream' },
          }),
        );
      }
      return Promise.resolve(
        new Response(toolStream('gen-after-retry'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
      );
    },
  });
  const outcome = await runAgent(
    'submit once',
    model,
    new Registry([createJsonResultSubmissionTool()]),
    {
      executionContext: createTurnExecutionContext(
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        recorder,
      ),
    },
  );

  assert(outcome.ok);
  assertEquals(outcome.stopReason, 'tool_terminal');
  assertEquals(outcome.steps, 1);
  assertEquals(outcome.toolCallCount, 1);
  assertEquals(outcome.toolResultCount, 1);
  assertEquals(requests, 2);
  assertEquals(bodies[0], bodies[1]);
  const evidence = recorder.snapshot();
  assertEquals(evidence.requests.map((entry) => entry.request.modelStep), [1, 1]);
  assertEquals(evidence.requests.map((entry) => entry.response?.status), [502, 200]);
  assertEquals(Object.keys(evidence.requests[0].response ?? {}), ['status']);
  assertEquals(
    evidence.runtimeEvents.filter((event) => event.kind === 'tool_call').length,
    1,
  );
  assertEquals(
    evidence.runtimeEvents.filter((event) => event.kind === 'tool_result').length,
    1,
  );
});

Deno.test('OpenRouter exhausts two 5xx retries and reports physical attempts', async () => {
  let requests = 0;
  const recorder = new ProviderEvidenceRecorder(
    '25252525-2525-4252-8252-252525252525',
    1,
    '2026-09-10T00:00:00.000Z',
  );
  const model = new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: () => {
      requests += 1;
      return Promise.resolve(
        new Response(`attempt-${requests}`, {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    },
  });
  const owner = new FailureDiagnosticOwner(1, {
    uuid: () => '26262626-2626-4262-8262-262626262626',
    now: () => '2026-09-10T00:00:00.000Z',
  });
  const outcome = await runAgent('fail after retries', model, new Registry([]), {
    diagnosticOwner: owner,
    turnProviderRequestCount: () => requests,
    executionContext: createTurnExecutionContext(
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recorder,
    ),
  });

  assert(!outcome.ok);
  assertEquals(requests, 3);
  assertEquals(outcome.steps, 1);
  assertEquals(outcome.diagnostic?.providerRequestCount, 3);
  assertEquals(outcome.diagnostic?.retryCount, 2);
  assertEquals(outcome.diagnostic?.httpStatus, 502);
  assertEquals(recorder.snapshot().requests.map((entry) => entry.response?.status), [
    502,
    502,
    502,
  ]);
});

Deno.test('OpenRouter cancel during 5xx backoff prevents another attempt', async () => {
  let requests = 0;
  const controller = new AbortController();
  const model = new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: () => {
      requests += 1;
      return Promise.resolve(new Response('retry later', { status: 503 }));
    },
  });
  const pending = model.generate(request, { signal: controller.signal });
  setTimeout(() => controller.abort('user cancelled'), 20);
  try {
    await pending;
    throw new Error('expected cancellation');
  } catch (error) {
    assert(isTurnCancelledError(error));
  }
  assertEquals(requests, 1);
});

Deno.test('OpenRouter does not retry 429 or an SSE stream failure', async () => {
  let rateLimitedRequests = 0;
  const rateLimited = await capturedOpenRouterError(() =>
    new OpenRouterAgentModel({
      profile: PROFILE,
      responseMode: 'sse',
      credential: 'dummy-credential-value',
      fetcher: () => {
        rateLimitedRequests += 1;
        return Promise.resolve(new Response('rate limited', { status: 429 }));
      },
    }).generate(request)
  );
  assertEquals(rateLimited.code, 'http_error');
  assertEquals(rateLimited.requestCount, 1);
  assertEquals(rateLimitedRequests, 1);

  let streamRequests = 0;
  const streamFailure = await capturedOpenRouterError(() =>
    new OpenRouterAgentModel({
      profile: PROFILE,
      responseMode: 'sse',
      credential: 'dummy-credential-value',
      fetcher: () => {
        streamRequests += 1;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"id":"partial"}\n\n'));
                controller.error(new Error('stream interrupted'));
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      },
    }).generate(request)
  );
  assertEquals(streamFailure.requestCount, 1);
  assertEquals(streamRequests, 1);
});

Deno.test('documented text accounting reaches ModelResult through HTTP and SSE', async () => {
  const seen = { requests: 0 };
  const recorder = new ProviderEvidenceRecorder(
    '11111111-1111-4111-8111-111111111111',
    1,
    '2026-09-02T00:00:00.000Z',
  );
  const model = modelFor(textStream(), seen);
  const result = await model.generate(request, {
    providerEvidence: recorder,
    providerEvidenceLane: 'parent',
    modelStep: 1,
  });
  assertEquals(result, { kind: 'final', text: 'hello' });
  recorder.finalize({
    outcome: {
      ok: true,
      task: 'hello',
      outcome: 'final',
      stopReason: 'final',
      finalText: 'hello',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      turnProviderRequestCount: seen.requests,
      runtimeProviderRequestCount: seen.requests,
      transcript: [],
    },
  });
  const evidence = recorder.snapshot();
  assertEquals(seen.requests, 1);
  assertEquals(evidence.requests.length, 1);
  assert(!JSON.stringify(evidence.requests[0].request).includes('requestBody'));
  assertEquals(evidence.requests[0].response?.status, 200);
  assertEquals(Object.keys(evidence.requests[0].response ?? {}), ['status']);
  assertEquals(evidence.requests[0].parserTransitions.length, 0);
  assertEquals(evidence.outcome, 'final');
  assertEquals(evidence.turnProviderRequestCount, 1);
  assertEquals(evidence.runtimeProviderRequestCount, 1);
  const serialized = JSON.stringify(evidence);
  assert(!serialized.includes('dummy-credential-value'));
  assert(!serialized.toLowerCase().includes('authorization'));

  const unsupportedRecorder = new ProviderEvidenceRecorder(
    '66666666-6666-4666-8666-666666666666',
    1,
    '2026-09-02T00:00:00.000Z',
  );
  try {
    await modelFor('raw unsupported-media body', { requests: 0 }, 'application/json').generate(
      request,
      { providerEvidence: unsupportedRecorder, providerEvidenceLane: 'parent', modelStep: 1 },
    );
  } catch {
    // The existing unsupported-media classification is expected.
  }
  assertEquals(unsupportedRecorder.snapshot().requests[0].response?.status, 200);
});

Deno.test('Worker production physical I/O selects SSE on the actual model path', async () => {
  const counter = createWorkerRequestCounter();
  const bodies: string[] = [];
  const bindings = createProductionPhysicalIo(counter, {
    credentialSources: { 'openrouter-api-key': () => 'provider-free-test-credential' },
    fetcher: (_input, init) => {
      bodies.push(String(init?.body));
      return Promise.resolve(
        new Response(textStream('worker-production-sse'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
      );
    },
  });
  const recorder = new ProviderEvidenceRecorder(
    '77777777-7777-4777-8777-777777777777',
    1,
    '2026-09-04T00:00:00.000Z',
  );
  const result = await bindings.createModel('parent').generate(request, {
    providerEvidence: recorder,
    providerEvidenceLane: 'parent',
    providerEvidencePhase: 'user_turn',
    modelStep: 1,
  });
  assertEquals(result, { kind: 'final', text: 'hello' });
  recorder.finalize({
    outcome: {
      ok: true,
      task: 'worker production SSE',
      outcome: 'final',
      stopReason: 'final',
      finalText: 'hello',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
      turnProviderRequestCount: 1,
      runtimeProviderRequestCount: 1,
    },
  });
  const evidence = recorder.snapshot();
  assertEquals(counter.count(), 1);
  assertEquals(bodies.length, 1);
  assertEquals((JSON.parse(bodies[0]) as { readonly stream?: unknown }).stream, true);
  assertEquals(evidence.requests[0].request.requestMetadata.responseMode, 'sse');
  assert(!JSON.stringify(evidence.requests[0]).includes('sseEvents'));
  assertEquals(evidence.requests[0].parserTransitions.length, 0);
});

Deno.test('assistant output above 64 KiB remains reachable through the provider adapter', async () => {
  const text = 'x'.repeat(300_000);
  const seen = { requests: 0 };
  const progress: string[] = [];
  const result = await modelFor(largeTextStream(text), seen).generate(request, {
    reportAssistantProgress: (snapshot) => progress.push(snapshot),
  });
  assertEquals(result, { kind: 'final', text });
  assertEquals(seen.requests, 1);
  assert(progress.at(-1) === text);
});

Deno.test('SSE above 1 MiB and 4096 events reaches terminal result without raw evidence', async () => {
  const fixture = largeEnvelopeStream();
  const encoded = new TextEncoder().encode(fixture.raw);
  assert(encoded.byteLength > 1024 * 1024);
  const observations: ProviderEvidenceObservation[] = [];
  const recorder = new ProviderEvidenceRecorder(
    '88888888-8888-4888-8888-888888888888',
    1,
    '2026-09-10T00:00:00.000Z',
    (observation) => {
      assert(validateProviderEvidenceObservation(observation));
      observations.push(observation);
      return observations.length;
    },
    false,
  );
  const model = new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: () => Promise.resolve(responseFromChunks(fixture.chunks)),
  });

  const result = await model.generate(request, {
    providerEvidence: recorder,
    providerEvidenceLane: 'parent',
    modelStep: 1,
  });
  assertEquals(result, { kind: 'final', text: 'x'.repeat(4_100) });

  assertEquals(recorder.snapshot().requests, []);
  const response = observations.find((observation) => observation.kind === 'response_start');
  assert(response?.kind === 'response_start');
  assertEquals(response.response, { status: 200 });
  assertEquals(observations.map((observation) => observation.kind), [
    'request_start',
    'response_start',
  ]);
  assert(JSON.stringify(observations).length < 2_000);
});

Deno.test('malformed tool call yields a short field-specific request fact', async () => {
  const observations: ProviderEvidenceObservation[] = [];
  const recorder = new ProviderEvidenceRecorder(
    '89898989-8989-4989-8989-898989898989',
    1,
    '2026-09-10T00:00:00.000Z',
    (observation) => {
      assert(validateProviderEvidenceObservation(observation));
      observations.push(observation);
    },
    false,
  );
  const model = new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'json',
    credential: 'dummy-credential-value',
    fetcher: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'bash', arguments: 9 },
                }],
              },
            }],
          }),
          { status: 200 },
        ),
      ),
  });
  let failed = false;
  try {
    await model.generate(request, { providerEvidence: recorder, modelStep: 1 });
  } catch {
    failed = true;
  }
  assert(failed);
  const parser = observations.find((observation) => observation.kind === 'parser_transition');
  assert(parser?.kind === 'parser_transition');
  assertEquals(
    parser.transition.field,
    'response.choices[0].message.tool_calls[0].function.arguments',
  );
  assertEquals(parser.transition.expectedShape, 'JSON string');
  assertEquals(parser.transition.actualShape, 'number');
  const failure = observations.find((observation) => observation.kind === 'request_failure');
  assert(failure?.kind === 'request_failure');
  assertEquals(failure.failure.stage, 'response_parse');
  assertEquals(failure.failure.httpStatus, 200);
  assert(!JSON.stringify(observations).includes('dummy-credential-value'));
});

Deno.test('SSE parser facts identify the rejected content and tool argument fields', async () => {
  const cases = [
    {
      delta: { role: 'assistant', content: 42 },
      reason: 'unsupported_delta_shape',
      field: 'choices[0].delta.content',
      expectedShape: 'string or null',
      actualShape: 'number',
    },
    {
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'bash', arguments: 9 },
        }],
      },
      reason: 'invalid_tool_arguments',
      field: 'choices[0].delta.tool_calls[0].function.arguments',
      expectedShape: 'string',
      actualShape: 'number',
    },
  ] as const;
  for (const item of cases) {
    const observations: ProviderEvidenceObservation[] = [];
    const recorder = new ProviderEvidenceRecorder(
      undefined,
      1,
      undefined,
      (observation) => {
        assert(validateProviderEvidenceObservation(observation));
        observations.push(observation);
      },
      false,
    );
    const frame = `data: ${
      JSON.stringify({
        id: 'gen-invalid',
        choices: [{ index: 0, delta: item.delta, finish_reason: null }],
      })
    }\n\n`;
    const model = new OpenRouterAgentModel({
      profile: PROFILE,
      responseMode: 'sse',
      credential: 'dummy-credential-value',
      fetcher: () => Promise.resolve(responseFromChunks([new TextEncoder().encode(frame)])),
    });
    const error = await capturedOpenRouterError(() =>
      model.generate(request, { providerEvidence: recorder, modelStep: 1 })
    );
    assertEquals(error.failureFact.parseReason, item.reason);
    assertEquals(error.failureFact.field, item.field);
    assertEquals(error.failureFact.expectedShape, item.expectedShape);
    assertEquals(error.failureFact.actualShape, item.actualShape);
    const parser = observations.find((observation) => observation.kind === 'parser_transition');
    assert(parser?.kind === 'parser_transition');
    assertEquals(parser.transition.field, item.field);
    assertEquals(parser.transition.expectedShape, item.expectedShape);
    assertEquals(parser.transition.actualShape, item.actualShape);
    const failure = observations.find((observation) => observation.kind === 'request_failure');
    assert(failure?.kind === 'request_failure');
    assertEquals(failure.failure.httpStatus, 200);
    assert(!JSON.stringify(observations).includes('dummy-credential-value'));
  }
});

Deno.test('buffered response and assistant semantic limits remain unchanged', async () => {
  const bufferedError = await capturedOpenRouterError(() =>
    new OpenRouterAgentModel({
      profile: PROFILE,
      responseMode: 'json',
      credential: 'dummy-credential-value',
      fetcher: () =>
        Promise.resolve(
          new Response('x'.repeat(MAX_BUFFERED_RESPONSE_BYTES + 1), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    }).generate(request)
  );
  assertEquals(bufferedError.code, 'limit_exceeded');
  assertEquals(bufferedError.failureFact.parseReason, 'response_body_too_large');

  const semanticError = await capturedOpenRouterError(() =>
    decodeResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: 'x'.repeat(MAX_CONVERSATION_TEXT_BYTES + 1),
        },
      }],
    })
  );
  assertEquals(semanticError.code, 'limit_exceeded');
  assertEquals(semanticError.failureFact.parseReason, 'response_body_too_large');
});

Deno.test('documented tool accounting dispatches normally through the same transport', async () => {
  const seen = { requests: 0 };
  const model = modelFor(toolStream(), seen);
  const events: unknown[] = [];
  const session = new AgentSession(model, new Registry([createJsonResultSubmissionTool()]), {
    eventSink: (event) => events.push(event),
    providerRequestCount: () => seen.requests,
  });
  const outcome = await session.submit('submit');
  assert(outcome.ok);
  assertEquals(outcome.stopReason, 'tool_terminal');
  assertEquals(outcome.finalText, '{"ok":true}');
  const assistant = outcome.transcript.find((message) => message.role === 'assistant');
  assertEquals(
    assistant?.providerState !== undefined && 'reasoningDetails' in assistant.providerState
      ? assistant.providerState.reasoningDetails
      : undefined,
    [
      { type: 'reasoning.text', text: 'tool continuity' },
    ],
  );
  assertEquals(seen.requests, 1);
  assert(events.some((event) => (event as { readonly kind?: string }).kind === 'tool_call'));
  assert(events.some((event) => (event as { readonly kind?: string }).kind === 'tool_result'));
  assert(events.some((event) => (event as { readonly kind?: string }).kind === 'turn_end'));
});

Deno.test('OpenRouter mixed assistant text and tool calls remain visible and continue', async () => {
  const bodies: unknown[] = [];
  let requestNumber = 0;
  const model = new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      requestNumber += 1;
      return Promise.resolve(
        new Response(
          requestNumber === 1 ? mixedToolStream() : textStream('gen-mixed-final'),
          { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        ),
      );
    },
  });
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    model,
    new Registry([{
      name: 'read',
      description: 'Read the current source.',
      inputSchema: { type: 'object' },
      execute: () => '# current source',
    }]),
    {
      eventSink: (event) => events.push(event),
    },
  );
  const outcome = await session.submit('inspect current source');

  assert(outcome.ok);
  assertEquals(outcome.finalText, 'hello');
  assertEquals(requestNumber, 2);
  const assistant = outcome.transcript.find((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
  );
  assert(assistant?.role === 'assistant' && Array.isArray(assistant.content));
  assertEquals(assistant.text, 'I will read the current source first.');
  assertEquals(assistant.content, [{
    kind: 'tool_call',
    callId: 'read-mixed-1',
    name: 'read',
    arguments: { path: 'README.md' },
  }]);
  const assistantEventIndex = events.findIndex((event) =>
    event.kind === 'assistant_message' && event.message.text !== undefined
  );
  const toolCallEventIndex = events.findIndex((event) => event.kind === 'tool_call');
  assert(assistantEventIndex >= 0 && toolCallEventIndex > assistantEventIndex);

  const continuation = bodies[1] as {
    readonly messages: readonly {
      readonly role: string;
      readonly content: unknown;
      readonly tool_calls?: readonly unknown[];
    }[];
  };
  const replayed = continuation.messages.find((message) =>
    message.role === 'assistant' && Array.isArray(message.tool_calls)
  );
  assertEquals(replayed?.content, 'I will read the current source first.');
  assertEquals(replayed?.tool_calls, [{
    id: 'read-mixed-1',
    type: 'function',
    function: { name: 'read', arguments: '{"path":"README.md"}' },
  }]);
});

Deno.test('OpenCode Go Chat accepts null tool metadata in MiMo continuation chunks', async () => {
  const seen = { requests: 0 };
  const result = await modelFor(nullMetadataContinuationStream(), seen).generate(request);
  assertEquals(result, {
    kind: 'tool_calls',
    calls: [{ callId: 'call-b2e69840', name: 'bash', arguments: { command: 'pwd' } }],
    text: 'I will inspect the README files.',
  });
  assertEquals(seen.requests, 1);
});

Deno.test('Chat SSE retains tool call metadata across null continuation fields', async () => {
  const seen = { requests: 0 };
  const result = await modelFor(nullableToolContinuationStream(), seen).generate(request);
  assertEquals(result, {
    kind: 'tool_calls',
    calls: [{
      callId: 'read-nullable-1',
      name: 'read',
      arguments: { limit: 10, path: 'README.md' },
    }],
  });
  assertEquals(seen.requests, 1);
});

Deno.test('Chat SSE dispatches a complete function call without type or contiguous index', async () => {
  const seen = { requests: 0 };
  const body = `data: ${
    JSON.stringify({
      id: 'gen-minimal-tool',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 3,
            id: 'read-minimal-1',
            function: { name: 'read', arguments: '{"path":"README.md"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
  }\n\ndata: [DONE]\n\n`;
  const result = await modelFor(body, seen).generate(request);
  assertEquals(result, {
    kind: 'tool_calls',
    calls: [{ callId: 'read-minimal-1', name: 'read', arguments: { path: 'README.md' } }],
  });
  assertEquals(seen.requests, 1);
});

Deno.test('OpenRouter JSON response preserves text attached to tool calls', () => {
  assertEquals(
    decodeResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: 'I will inspect the source.',
          tool_calls: [{
            id: 'read-json-1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"README.md"}' },
          }],
        },
      }],
    }),
    {
      kind: 'tool_calls',
      calls: [{
        callId: 'read-json-1',
        name: 'read',
        arguments: { path: 'README.md' },
      }],
      text: 'I will inspect the source.',
    },
  );
});

Deno.test('Chat JSON response accepts a complete function call without type metadata', () => {
  assertEquals(
    decodeResponse({
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'read-json-minimal-1',
            function: { name: 'read', arguments: '{"path":"README.md"}' },
          }],
        },
      }],
    }),
    {
      kind: 'tool_calls',
      calls: [{
        callId: 'read-json-minimal-1',
        name: 'read',
        arguments: { path: 'README.md' },
      }],
    },
  );
});

Deno.test('post-terminal content is rejected with a durable diagnostic', async () => {
  const seen = { requests: 0 };
  const diagnostics: string[] = [];
  const model = modelFor(failingPostTerminalStream(), seen);
  const session = new AgentSession(model, new Registry([]), {
    providerRequestCount: () => seen.requests,
    diagnosticOwnerFactory: (turn) =>
      new FailureDiagnosticOwner(turn, {
        uuid: () => '22222222-2222-4222-8222-222222222222',
        now: () => '2026-09-02T00:00:00.000Z',
        persist: (diagnostic) => {
          diagnostics.push(diagnostic.diagnosticId);
        },
      }),
  });
  const outcome = await session.submit('fail');
  assert(!outcome.ok);
  assertEquals(outcome.diagnostic?.parseReason, 'data_after_terminal');
  assertEquals(outcome.stopReason, 'contract_failure');
  assertEquals(outcome.turnProviderRequestCount, 1);
  assertEquals(diagnostics, [outcome.diagnostic?.diagnosticId]);
});
