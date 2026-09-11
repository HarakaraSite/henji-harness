import {
  MAX_BUFFERED_RESPONSE_BYTES,
  OpenRouterAgentError,
  OpenRouterAgentModel,
  type OpenRouterAgentProfile,
} from '../../v0/agent/provider/openrouter_model.ts';
import {
  createTurnExecutionContext,
  ParentTurnExecutionContext,
} from '../../v0/agent/core/execution_context.ts';
import { runAgent } from '../../v0/agent/core/loop.ts';
import { createPlannerDelegationTool } from '../../v0/agent/tools/planner_delegation.ts';
import {
  FakeProviderEvidenceDraftStore,
  ProviderEvidenceRecorder,
} from '../../v0/agent/provider/provider_evidence.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import { AgentSession } from '../../v0/agent/session/session.ts';
import { FailureDiagnosticOwner } from '../../v0/agent/session/failure_diagnostic.ts';
import { createJsonResultSubmissionTool, Registry } from '../../v0/agent/tools/tools.ts';
import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import {
  main as failureDiagnosticMain,
  parseFailureDiagnosticArgs,
} from '../../v0/agent/cli/failure_diagnostic_cli.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { DenoProviderEvidenceStore } from '../../v0/agent/provider/provider_evidence_store.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
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
      '/fixed/present',
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

const plannerDelegationStream = (id = 'gen-planner'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'delegate-large',
            type: 'function',
            function: {
              name: 'delegate_to_planner',
              arguments: JSON.stringify({ task: 'large plan' }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
  }\n\n${usage(id, 'tool_calls')}data: [DONE]\n\n`;

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
  assertEquals(evidence.requests[0].response?.rawBody, '{"error":"temporary upstream failure"}');
  assertEquals(evidence.requests[0].response?.headers['x-provider'], 'test-upstream');
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
  assertEquals(recorder.snapshot().requests.map((entry) => entry.response?.rawBody), [
    'attempt-1',
    'attempt-2',
    'attempt-3',
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
  const store = new FakeProviderEvidenceDraftStore();
  const recorder = new ProviderEvidenceRecorder(
    '11111111-1111-4111-8111-111111111111',
    1,
    '2026-09-02T00:00:00.000Z',
    store,
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
  await recorder.persist();
  const evidence = await store.read(recorder.evidenceId);
  assertEquals(seen.requests, 1);
  assertEquals(evidence.requests.length, 1);
  assertEquals(
    evidence.requests[0].request.requestBodyBytes,
    evidence.requests[0].request.requestBody.length,
  );
  assertEquals(evidence.requests[0].response?.status, 200);
  assert(evidence.requests[0].response?.rawBody?.includes('late') === false);
  assertEquals(evidence.requests[0].sseEvents.length, 3);
  assert(evidence.requests[0].sseEvents[0].data.includes('"content":"hello"'));
  assert(evidence.requests[0].sseEvents[1].data.includes('"usage"'));
  assert(evidence.requests[0].sseEvents.some((event) => event.data === '[DONE]'));
  assertEquals(
    evidence.requests[0].parserTransitions.filter((transition) => transition.kind === 'terminal')
      .length,
    1,
  );
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
    // The existing unsupported-media classification is expected; evidence must retain the body.
  }
  assertEquals(
    unsupportedRecorder.snapshot().requests[0].response?.rawBody,
    'raw unsupported-media body',
  );
});

Deno.test('Worker production physical I/O selects SSE on the actual model path', async () => {
  const counter = createWorkerRequestCounter();
  const bodies: string[] = [];
  const bindings = createProductionPhysicalIo(counter, {
    credentialSource: () => 'provider-free-test-credential',
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
  assertEquals(evidence.requests[0].sseEvents.map((event) => event.data), [
    textStream('worker-production-sse').split('data: ')[1].split('\n\n')[0],
    textStream('worker-production-sse').split('data: ')[2].split('\n\n')[0],
    '[DONE]',
  ]);
  assertEquals(
    evidence.requests[0].parserTransitions.filter((transition) => transition.kind === 'terminal')
      .length,
    1,
  );
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

Deno.test('SSE above 1 MiB and 4096 events reaches terminal result with exact evidence', async () => {
  const fixture = largeEnvelopeStream();
  const encoded = new TextEncoder().encode(fixture.raw);
  assert(encoded.byteLength > 1024 * 1024);
  const recorder = new ProviderEvidenceRecorder(
    '88888888-8888-4888-8888-888888888888',
    1,
    '2026-09-10T00:00:00.000Z',
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

  const retained = recorder.snapshot().requests[0];
  assertEquals(retained.response?.rawBodyBytes, encoded.byteLength);
  assertEquals(retained.response?.rawBody, fixture.raw);
  assertEquals(retained.response?.rawBodyBase64, encoded.toBase64());
  assertEquals(retained.sseEvents.length, 4_102);
  assert((retained.sseEvents[0].responseBodyOffset ?? 0) < encoded.byteLength);
  assertEquals(retained.sseEvents.at(-1)?.responseBodyOffset, encoded.byteLength);
  assert(
    retained.sseEvents.every((event, index, events) =>
      index === 0 || event.responseBodyOffset >= events[index - 1].responseBodyOffset
    ),
  );
});

Deno.test('evidence snapshots materialize exactly the bytes received so far', () => {
  const recorder = new ProviderEvidenceRecorder(
    '99999999-9999-4999-8999-999999999999',
    1,
    '2026-09-10T00:00:00.000Z',
  );
  recorder.startRequest({
    lane: 'parent',
    modelStep: 1,
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    method: 'POST',
    requestBody: '{}',
  });
  recorder.recordResponse({ status: 200, headers: {} });
  recorder.appendResponseBytes(new TextEncoder().encode('first-'));
  assertEquals(recorder.snapshot().requests[0].response, {
    status: 200,
    headers: {},
    rawBodyBytes: 6,
    rawBody: 'first-',
    rawBodyBase64: new TextEncoder().encode('first-').toBase64(),
  });
  recorder.appendResponseBytes(new TextEncoder().encode('second'));
  assertEquals(recorder.snapshot().requests[0].response, {
    status: 200,
    headers: {},
    rawBodyBytes: 12,
    rawBody: 'first-second',
    rawBodyBase64: new TextEncoder().encode('first-second').toBase64(),
  });
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

Deno.test('planner result above 76 KiB reaches the parent continuation request', async () => {
  const plannerText = 'p'.repeat(300_000);
  const seen = { requests: 0 };
  let parentToolContent: string | undefined;
  const model = new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: (_input, init) => {
      seen.requests += 1;
      if (seen.requests === 2) {
        const body = JSON.parse(String(init?.body)) as {
          readonly messages?: readonly {
            readonly role?: unknown;
            readonly content?: unknown;
          }[];
        };
        const toolMessage = body.messages?.find((message) => message.role === 'tool');
        assert(toolMessage !== undefined);
        assert(typeof toolMessage.content === 'string');
        parentToolContent = toolMessage.content;
        assert(
          new TextEncoder().encode(JSON.stringify(body.messages)).byteLength > 76 * 1024,
        );
      }
      const responseBody = seen.requests === 1
        ? plannerDelegationStream()
        : textStream('gen-parent-final');
      return Promise.resolve(
        new Response(responseBody, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'x-generation-id': `gen-${seen.requests}`,
          },
        }),
      );
    },
  });
  const outcome = await runAgent(
    'parent task',
    model,
    new Registry([createPlannerDelegationTool((_task, child) => {
      assert(child.claimModelRequest());
      return {
        externalRequests: 1,
        outcome: {
          ok: true,
          task: 'large plan',
          outcome: 'final',
          stopReason: 'final',
          finalText: plannerText,
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
      };
    })]),
    { executionContext: new ParentTurnExecutionContext(1) },
  );
  assert(outcome.ok);
  assertEquals(outcome.finalText, 'hello');
  assertEquals(seen.requests, 2);
  assert(parentToolContent?.includes(plannerText));
});

Deno.test('documented tool accounting dispatches normally through the same transport', async () => {
  const seen = { requests: 0 };
  const store = new FakeProviderEvidenceDraftStore();
  const model = modelFor(toolStream(), seen);
  const events: unknown[] = [];
  const session = new AgentSession(model, new Registry([createJsonResultSubmissionTool()]), {
    eventSink: (event) => events.push(event),
    providerEvidenceStore: store,
    providerRequestCount: () => seen.requests,
  });
  const outcome = await session.submit('submit');
  assert(outcome.ok);
  assertEquals(outcome.stopReason, 'tool_terminal');
  assertEquals(outcome.finalText, '{"ok":true}');
  const assistant = outcome.transcript.find((message) => message.role === 'assistant');
  assertEquals(
    assistant?.providerState?.provider === 'openrouter'
      ? assistant.providerState.reasoningDetails
      : undefined,
    [
      { type: 'reasoning.text', text: 'tool continuity' },
    ],
  );
  assertEquals(seen.requests, 1);
  assert(outcome.providerEvidenceId !== undefined);
  const evidence = await store.read(outcome.providerEvidenceId!);
  assertEquals(evidence.requests[0].request.lane, 'parent');
  assertEquals(evidence.outcome, 'tool_terminal');
  assertEquals(evidence.turnProviderRequestCount, 1);
  assert(evidence.runtimeEvents.some((event) => event.kind === 'tool_call'));
  assert(evidence.runtimeEvents.some((event) => event.kind === 'tool_result'));
  assert(events.some((event) => (event as { readonly kind?: string }).kind === 'turn_end'));
});

Deno.test('OpenRouter mixed assistant text and tool calls remain visible and continue', async () => {
  const bodies: unknown[] = [];
  const store = new FakeProviderEvidenceDraftStore();
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
      providerEvidenceStore: store,
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
  assert(outcome.providerEvidenceId !== undefined);
  const evidence = await store.read(outcome.providerEvidenceId);
  const mixedResult = evidence.runtimeEvents.find((event) =>
    event.kind === 'model_result' && event.result.kind === 'tool_calls'
  );
  assert(mixedResult?.kind === 'model_result' && mixedResult.result.kind === 'tool_calls');
  assertEquals(mixedResult.result.text, 'I will read the current source first.');

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

Deno.test('post-terminal content is rejected and diagnostic ID reaches the saved artifact', async () => {
  const seen = { requests: 0 };
  const store = new FakeProviderEvidenceDraftStore();
  const diagnostics: string[] = [];
  const model = modelFor(failingPostTerminalStream(), seen);
  const session = new AgentSession(model, new Registry([]), {
    providerEvidenceStore: store,
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
  assert(typeof outcome.providerEvidenceId === 'string');
  const evidence = await store.read(outcome.providerEvidenceId!);
  const failure = evidence.requests[0].parserTransitions.find((transition) =>
    transition.kind === 'failure'
  );
  assertEquals(failure?.reason, 'data_after_terminal');
  assertEquals(failure?.field, 'choices[0].delta.content');
  assertEquals(evidence.outcome, 'contract_failure');
  assertEquals(evidence.turnProviderRequestCount, 1);
  assertEquals(diagnostics, [outcome.diagnostic?.diagnosticId]);
  assertEquals(
    await store.readDiagnosticLink(outcome.diagnostic!.diagnosticId),
    outcome.providerEvidenceId,
  );
});

Deno.test('evidence persistence failure does not replace a valid provider result', async () => {
  const seen = { requests: 0 };
  const store = new FakeProviderEvidenceDraftStore();
  store.failWrites();
  const events: AgentEvent[] = [];
  const session = new AgentSession(modelFor(textStream('gen-persist'), seen), new Registry([]), {
    eventSink: (event) => events.push(event),
    providerEvidenceStore: store,
    providerRequestCount: () => seen.requests,
  });
  const outcome = await session.submit('persist');
  assert(outcome.ok);
  assertEquals(outcome.finalText, 'hello');
  assertEquals(outcome.providerEvidenceDurability, 'failed');
  assertEquals(outcome.providerEvidencePersistenceError, 'provider_evidence_io_failure');
  const turnEnd = events.find((event) => event.kind === 'turn_end');
  assert(turnEnd?.kind === 'turn_end');
  assertEquals(turnEnd.providerEvidenceDurability, 'failed');
  assertEquals(turnEnd.providerEvidencePersistenceError, 'provider_evidence_io_failure');

  const linkSeen = { requests: 0 };
  const linkStore = new FakeProviderEvidenceDraftStore();
  linkStore.failLinks();
  const linkSession = new AgentSession(
    modelFor(failingPostTerminalStream(), linkSeen),
    new Registry([]),
    { providerEvidenceStore: linkStore, providerRequestCount: () => linkSeen.requests },
  );
  const linkOutcome = await linkSession.submit('link');
  assert(!linkOutcome.ok);
  assert(typeof linkOutcome.providerEvidenceId === 'string');
  assertEquals(linkOutcome.providerEvidenceDurability, 'yes');
  assertEquals(linkOutcome.providerEvidencePersistenceError, 'provider_evidence_io_failure');
  assertEquals(
    (await linkStore.read(linkOutcome.providerEvidenceId!)).evidenceId,
    linkOutcome.providerEvidenceId,
  );
});

Deno.test('Deno evidence store and diagnostics readback retain one parent/planner artifact', async () => {
  const tempRoot = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-provider-evidence-' });
  const workspaceRoot = `${tempRoot}/workspace`;
  const stateRoot = `${tempRoot}/state`;
  await Deno.mkdir(workspaceRoot);
  const evidenceId = '55555555-5555-4555-8555-555555555555';
  const diagnosticId = '33333333-3333-4333-8333-333333333333';
  try {
    const store = new DenoProviderEvidenceStore(stateRoot, workspaceRoot);
    assertEquals(await store.list(), []);
    const recorder = new ProviderEvidenceRecorder(evidenceId, 1, '2026-09-02T00:00:00.000Z');
    recorder.startRequest({
      lane: 'parent',
      modelStep: 1,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      requestBody: '{"lane":"parent"}',
      requestMetadata: { contentType: 'application/json', responseMode: 'sse' },
    });
    recorder.recordResponse({
      status: 200,
      headers: { 'x-provider-evidence': 'retained', Authorization: 'response-metadata' },
    });
    recorder.appendResponseBytes(new TextEncoder().encode('parent-response'));
    recorder.startRequest({
      lane: 'planner',
      modelStep: 1,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      requestBody: '{"lane":"planner"}',
      requestMetadata: { contentType: 'application/json', responseMode: 'sse' },
    });
    recorder.recordResponse({ status: 200, headers: { 'x-provider-evidence': 'retained' } });
    recorder.appendResponseBytes(new TextEncoder().encode('planner-response'));
    recorder.finalize({
      diagnosticId,
      outcome: {
        ok: true,
        task: 'readback',
        outcome: 'final',
        stopReason: 'final',
        finalText: 'ok',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
    });
    const build = buildManifest();
    await store.write({
      ...recorder.snapshot(),
      schemaVersion: 2,
      sessionId: '77777777-7777-4777-8777-777777777777',
      build,
      definition: await builtinDefinitionRef('default', build),
    });
    await store.linkDiagnostic(diagnosticId, evidenceId);
    assertEquals((await Deno.lstat(stateRoot)).mode! & 0o777, 0o700);

    const listed: string[] = [];
    const listStatus = await failureDiagnosticMain(['evidence', 'list'], {
      stateRoot,
      workspaceRoot,
      writeStdout: (text) => {
        listed.push(text);
      },
    });
    assertEquals(listStatus, 0);
    const listPayload = JSON.parse(listed.join('')) as {
      readonly evidence: readonly { readonly evidenceId: string }[];
    };
    assertEquals(listPayload.evidence.map((entry) => entry.evidenceId), [evidenceId]);

    const shown: string[] = [];
    const showStatus = await failureDiagnosticMain(['evidence', 'show', '--id', evidenceId], {
      stateRoot,
      workspaceRoot,
      writeStdout: (text) => {
        shown.push(text);
      },
    });
    assertEquals(showStatus, 0);
    const artifact = JSON.parse(shown.join('')) as {
      readonly evidenceId: string;
      readonly requests: readonly {
        readonly request: { readonly lane: string };
        readonly response?: { readonly headers: Readonly<Record<string, string>> };
      }[];
    };
    assertEquals(artifact.evidenceId, evidenceId);
    assertEquals(artifact.requests.map((entry) => entry.request.lane), ['parent', 'planner']);
    assertEquals(artifact.requests[0].response?.headers.Authorization, 'response-metadata');

    const shownByDiagnostic: string[] = [];
    const diagnosticShowStatus = await failureDiagnosticMain(
      ['evidence', 'show', '--id', diagnosticId],
      {
        stateRoot,
        workspaceRoot,
        writeStdout: (text) => {
          shownByDiagnostic.push(text);
        },
      },
    );
    assertEquals(diagnosticShowStatus, 0);
    assertEquals(
      (JSON.parse(shownByDiagnostic.join('')) as { readonly evidenceId: string }).evidenceId,
      evidenceId,
    );
    const missingErrors: string[] = [];
    await failureDiagnosticMain(
      ['evidence', 'show', '--id', '77777777-7777-4777-8777-777777777777'],
      {
        stateRoot,
        workspaceRoot,
        writeStderr: (text) => {
          missingErrors.push(text);
        },
      },
    );
    assertEquals(
      (JSON.parse(missingErrors.join('')) as { readonly error: { readonly code: string } }).error
        .code,
      'provider_evidence_not_found',
    );
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test('diagnostics evidence commands have read-only list/show grammar', () => {
  assertEquals(parseFailureDiagnosticArgs(['evidence', 'list']), { kind: 'evidence_list' });
  assertEquals(
    parseFailureDiagnosticArgs([
      'evidence',
      'show',
      '--id',
      '11111111-1111-4111-8111-111111111111',
    ]),
    { kind: 'evidence_show', id: '11111111-1111-4111-8111-111111111111' },
  );
});

Deno.test('retained UI keeps provider evidence out of the conversation log', () => {
  const evidenceId = '44444444-4444-4444-8444-444444444444';
  const state = reduceUiEvent(createUiState(), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
    providerEvidenceId: evidenceId,
  });
  assertEquals(state.log.entries, []);

  const linkedFailureState = reduceUiEvent(createUiState(), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
    providerEvidenceId: evidenceId,
    providerEvidenceDurability: 'yes',
    providerEvidencePersistenceError: 'provider_evidence_io_failure',
  });
  assertEquals(linkedFailureState.log.entries, []);

  const failedState = reduceUiEvent(createUiState(), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
    providerEvidenceId: evidenceId,
    providerEvidenceDurability: 'failed',
    providerEvidencePersistenceError: 'provider_evidence_io_failure',
  });
  assertEquals(failedState.log.entries, []);
});
