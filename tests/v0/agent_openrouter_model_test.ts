import { assert, assertEquals } from './test_helpers.ts';
import {
  createOpenRouterAgentModel,
  OpenRouterAgentError,
  OpenRouterAgentModel,
  type OpenRouterAgentModelOptions,
  type OpenRouterAgentProfile,
} from '../../v0/agent/openrouter_model.ts';
import { PROFILE } from '../../v0/model.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { createCorpusRegistry } from '../../v0/agent/registries.ts';
import { createFixtureTool, Registry } from '../../v0/agent/tools.ts';
import { type ModelRequest } from '../../v0/agent/contracts.ts';
import { TurnCancelledError } from '../../v0/agent/cancellation.ts';

const ENDPOINT = 'https://offline.invalid/api/v1/chat/completions';
const DUMMY_CREDENTIAL = 'dummy-credential-marker';

const ALTERNATE_PROFILE: OpenRouterAgentProfile = {
  id: 'offline-alternate-profile',
  model: 'offline/alternate-model',
  origin: 'https://alternate.invalid',
  path: '/v1/chat/completions',
  method: 'POST',
  secretEnv: 'OFFLINE_ALTERNATE_KEY',
  maxCompletionTokens: 37,
  stream: false,
};

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

const response = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const finalPayload = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});

const toolPayload = (overrides: Record<string, unknown> = {}) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'uppercase_text', arguments: '{"text":"hello"}' },
      }],
      ...overrides,
    },
  }],
});

const request = (): ModelRequest => ({
  transcript: [{ role: 'user', content: { kind: 'text', text: 'hello' } }],
  tools: [createFixtureTool()],
});

const runtimeRequest = (): ModelRequest => ({
  transcript: [{ role: 'user', content: { kind: 'text', text: 'json task' } }],
  tools: createCorpusRegistry().definitions(),
});

const makeFetcher = (responses: readonly Response[], calls: FetchCall[]) => {
  let index = 0;
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    const next = responses[index++];
    if (!next) throw new Error('unexpected extra request');
    return Promise.resolve(next);
  };
};

const options = (fetcher: typeof fetch, extra: Partial<OpenRouterAgentModelOptions> = {}) => ({
  fetcher,
  credential: DUMMY_CREDENTIAL,
  endpoint: ENDPOINT,
  ...extra,
});

const parsedBody = (call: FetchCall): Record<string, unknown> => {
  assert(typeof call.init?.body === 'string');
  return JSON.parse(call.init.body) as Record<string, unknown>;
};

const assertSafeError = async (operation: () => Promise<unknown>, requestCount: 0 | 1) => {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof OpenRouterAgentError);
    assertEquals(error.requestCount, requestCount);
    assert(!error.message.includes(DUMMY_CREDENTIAL));
    assert(!error.message.includes('PROVIDER_BODY_MARKER'));
    assert(!JSON.stringify(error).includes(DUMMY_CREDENTIAL));
    return error;
  }
  throw new Error('expected a sanitized adapter error');
};

Deno.test('text response encodes fixed OpenAI-compatible controls and decodes final text', async () => {
  const calls: FetchCall[] = [];
  const model = new OpenRouterAgentModel(
    options(makeFetcher([response(finalPayload('answer'))], calls)),
  );
  const result = await model.generate(request());
  assertEquals(result, { kind: 'final', text: 'answer' });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].input, ENDPOINT);
  assertEquals(calls[0].init?.method, 'POST');
  assertEquals(calls[0].init?.redirect, 'error');
  assertEquals(calls[0].init?.headers, {
    'content-type': 'application/json',
    authorization: `Bearer ${DUMMY_CREDENTIAL}`,
  });
  const body = parsedBody(calls[0]);
  assertEquals(body.model, 'google/gemini-3.7-flash');
  assertEquals(body.stream, false);
  assertEquals(body.max_completion_tokens, 1024);
  assertEquals(body.messages, [{ role: 'user', content: 'hello' }]);
  assertEquals(body.tools, [{
    type: 'function',
    function: {
      name: 'uppercase_text',
      description: 'Convert one input text to uppercase.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  }]);
  assert(!JSON.stringify(result).includes(DUMMY_CREDENTIAL));
});

Deno.test('explicit structural profile controls derived endpoint and request wire', async () => {
  const calls: FetchCall[] = [];
  const model = new OpenRouterAgentModel({
    fetcher: makeFetcher([response(finalPayload('alternate'))], calls),
    credential: DUMMY_CREDENTIAL,
    profile: ALTERNATE_PROFILE,
  });

  assertEquals(await model.generate(request()), { kind: 'final', text: 'alternate' });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].input, 'https://alternate.invalid/v1/chat/completions');
  assertEquals(calls[0].init?.method, 'POST');
  const body = parsedBody(calls[0]);
  assertEquals(body.model, 'offline/alternate-model');
  assertEquals(body.stream, false);
  assertEquals(body.max_completion_tokens, 37);
});

Deno.test('omitted profile and explicit canonical PROFILE have byte-equivalent default wire', async () => {
  const omittedCalls: FetchCall[] = [];
  const explicitCalls: FetchCall[] = [];
  const omitted = new OpenRouterAgentModel({
    fetcher: makeFetcher([response(finalPayload('omitted'))], omittedCalls),
    credential: DUMMY_CREDENTIAL,
  });
  const explicit = new OpenRouterAgentModel({
    fetcher: makeFetcher([response(finalPayload('explicit'))], explicitCalls),
    credential: DUMMY_CREDENTIAL,
    profile: PROFILE,
  });

  assertEquals(await omitted.generate(request()), { kind: 'final', text: 'omitted' });
  assertEquals(await explicit.generate(request()), { kind: 'final', text: 'explicit' });
  assertEquals(omittedCalls[0].input, explicitCalls[0].input);
  assertEquals(omittedCalls[0].init?.method, explicitCalls[0].init?.method);
  assertEquals(omittedCalls[0].init?.headers, explicitCalls[0].init?.headers);
  assertEquals(omittedCalls[0].init?.body, explicitCalls[0].init?.body);
});

Deno.test('explicit test endpoint remains higher priority than profile-derived endpoint', async () => {
  const calls: FetchCall[] = [];
  const model = new OpenRouterAgentModel({
    fetcher: makeFetcher([response(finalPayload('override'))], calls),
    credential: DUMMY_CREDENTIAL,
    endpoint: ENDPOINT,
    profile: ALTERNATE_PROFILE,
  });

  assertEquals(await model.generate(request()), { kind: 'final', text: 'override' });
  assertEquals(calls[0].input, ENDPOINT);
});

Deno.test('text final accepts an explicitly null tool_calls field', async () => {
  const calls: FetchCall[] = [];
  const payload = {
    choices: [{ message: { role: 'assistant', content: 'answer', tool_calls: null } }],
  };
  const model = new OpenRouterAgentModel(options(makeFetcher([response(payload)], calls)));
  assertEquals(await model.generate(request()), { kind: 'final', text: 'answer' });
  assertEquals(calls.length, 1);
});

Deno.test('adapter serializes the exact object-root JSON submission definition and arguments', async () => {
  const calls: FetchCall[] = [];
  const json = '{"emoji":"🐣","nested":[1,null]}';
  const payload = toolPayload({
    tool_calls: [{
      id: 'submit-1',
      type: 'function',
      function: { name: 'submit_json_result', arguments: JSON.stringify({ json }) },
    }],
  });
  const model = new OpenRouterAgentModel(options(makeFetcher([response(payload)], calls)));
  assertEquals(await model.generate(runtimeRequest()), {
    kind: 'tool_calls',
    calls: [{ callId: 'submit-1', name: 'submit_json_result', arguments: { json } }],
  });
  const body = parsedBody(calls[0]);
  assertEquals(body.tools, [
    {
      type: 'function',
      function: {
        name: 'character_count',
        description: 'Count Unicode code points in one input text.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'count_json_array_items',
        description: 'Count the items in one JSON array string.',
        parameters: {
          type: 'object',
          properties: { json: { type: 'string' } },
          required: ['json'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_json_object_keys',
        description: 'List the sorted keys of one object in an explicitly allowed local JSON file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            objectKey: { type: 'string' },
          },
          required: ['path', 'objectKey'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'submit_json_result',
        description:
          'Submit the final answer when it is a JSON value. Call it as the only tool call in the assistant batch. Pass the complete JSON text in `json`. Use the normal assistant final response for plain text.',
        parameters: {
          type: 'object',
          properties: { json: { type: 'string' } },
          required: ['json'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'uppercase_text',
        description: 'Convert one input text to uppercase.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
  ]);
});

Deno.test('adapter composes with runAgent and preserves two-request causal tool round', async () => {
  const calls: FetchCall[] = [];
  const fetcher = makeFetcher([response(toolPayload()), response(finalPayload('HELLO'))], calls);
  const model = createOpenRouterAgentModel(options(fetcher));
  const outcome = await runAgent('hello', model, new Registry([createFixtureTool()]));
  assert(outcome.ok);
  assertEquals(outcome.finalText, 'HELLO');
  assertEquals(outcome.steps, 2);
  assertEquals(outcome.toolCallCount, 1);
  assertEquals(outcome.toolResultCount, 1);
  assertEquals(calls.length, 2);

  const first = parsedBody(calls[0]);
  assertEquals(first.tools, [{
    type: 'function',
    function: {
      name: 'uppercase_text',
      description: 'Convert one input text to uppercase.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  }]);
  assertEquals(first.messages, [{ role: 'user', content: 'hello' }]);

  const second = parsedBody(calls[1]);
  assertEquals(second.messages, [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'uppercase_text', arguments: '{"text":"hello"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'HELLO' },
  ]);
});

Deno.test('system instruction is exactly once and first on every causal request', async () => {
  const calls: FetchCall[] = [];
  const instruction =
    'Project context instructions loaded from AGENTS.md.\n\n## ./AGENTS.md\n\nlocal';
  const fetcher = makeFetcher([response(toolPayload()), response(finalPayload('HELLO'))], calls);
  const model = createOpenRouterAgentModel(options(fetcher));
  const outcome = await runAgent('hello', model, new Registry([createFixtureTool()]), {
    systemInstruction: instruction,
  });
  assert(outcome.ok);
  assertEquals(calls.length, 2);
  for (const call of calls) {
    const body = parsedBody(call);
    assertEquals(
      (body.messages as Array<Record<string, unknown>>).filter((message) =>
        message.role === 'system'
      ).length,
      1,
    );
    assertEquals((body.messages as Array<Record<string, unknown>>)[0], {
      role: 'system',
      content: instruction,
    });
  }
  assertEquals((parsedBody(calls[0]).messages as Array<Record<string, unknown>>)[1], {
    role: 'user',
    content: 'hello',
  });
  assertEquals((parsedBody(calls[1]).messages as Array<Record<string, unknown>>).slice(0, 2), [
    { role: 'system', content: instruction },
    { role: 'user', content: 'hello' },
  ]);
});

Deno.test('valid tool arguments decode to provider-neutral JsonValue calls', async () => {
  const calls: FetchCall[] = [];
  const model = new OpenRouterAgentModel(options(makeFetcher([response(toolPayload())], calls)));
  const result = await model.generate(request());
  assertEquals(result, {
    kind: 'tool_calls',
    calls: [{ callId: 'call-1', name: 'uppercase_text', arguments: { text: 'hello' } }],
  });
  assertEquals(calls.length, 1);
});

Deno.test('unsupported provider result shapes fail closed without partial calls or leakage', async () => {
  const cases: readonly [string, unknown][] = [
    [
      'invalid JSON arguments',
      toolPayload({
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'uppercase_text', arguments: '{' },
        }],
      }),
    ],
    [
      'missing call id',
      toolPayload({
        tool_calls: [{
          id: '',
          type: 'function',
          function: { name: 'uppercase_text', arguments: '{}' },
        }],
      }),
    ],
    [
      'missing function name',
      toolPayload({
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: '', arguments: '{}' } }],
      }),
    ],
    [
      'non-function call',
      toolPayload({
        tool_calls: [{
          id: 'call-1',
          type: 'custom',
          function: { name: 'uppercase_text', arguments: '{}' },
        }],
      }),
    ],
    ['multiple choices', {
      choices: [{ message: { content: 'one' } }, { message: { content: 'two' } }],
    }],
    ['mixed text and tools', toolPayload({ content: 'text' })],
    ['missing message', { choices: [{ finish_reason: 'stop' }] }],
    ['empty result', { choices: [{ message: { role: 'assistant', content: '' } }] }],
  ];
  for (const [name, payload] of cases) {
    const calls: FetchCall[] = [];
    const model = new OpenRouterAgentModel(
      options(makeFetcher([response(payload)], calls)),
    );
    const error = await assertSafeError(() => model.generate(request()), 1);
    assert(error.message.length > 0, name);
    assertEquals(calls.length, 1, name);
  }
});

Deno.test('bounded response cancels an oversized body', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const calls: FetchCall[] = [];
  const fetcher = makeFetcher([new Response(body, { status: 200 })], calls);
  const model = new OpenRouterAgentModel(options(fetcher));
  const error = await assertSafeError(() => model.generate(request()), 1);
  assertEquals(error.code, 'limit_exceeded');
  assert(cancelled);
  assertEquals(calls.length, 1);
});

Deno.test('deadline remains active while reading the response body', async () => {
  let aborted = false;
  const fetcher = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          controller.error(new Error('aborted'));
        }, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  const started = Date.now();
  const model = new OpenRouterAgentModel(options(fetcher, { timeoutMs: 15 }));
  const error = await assertSafeError(() => model.generate(request()), 1);
  assertEquals(error.code, 'transport_error');
  assert(aborted);
  assert(Date.now() - started < 1000);
});

Deno.test('transport and HTTP failures make exactly one request with sanitized errors', async () => {
  const transportCalls: FetchCall[] = [];
  const rejecting = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    transportCalls.push({ input, init });
    return Promise.reject(new Error('PROVIDER_BODY_MARKER'));
  };
  const transportModel = new OpenRouterAgentModel(options(rejecting));
  const transportError = await assertSafeError(() => transportModel.generate(request()), 1);
  assertEquals(transportError.code, 'transport_error');
  assertEquals(transportCalls.length, 1);

  const httpCalls: FetchCall[] = [];
  const httpModel = new OpenRouterAgentModel(
    options(makeFetcher([response({ error: 'PROVIDER_BODY_MARKER' }, 503)], httpCalls)),
  );
  const httpError = await assertSafeError(() => httpModel.generate(request()), 1);
  assertEquals(httpError.code, 'http_error');
  assertEquals(httpCalls.length, 1);
});

Deno.test('missing credential and invalid preflight never call fetch', async () => {
  let credentialReads = 0;
  let fetchCalls = 0;
  const fetcher = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(response(finalPayload('unreachable')));
  };
  const missing = new OpenRouterAgentModel({
    fetcher,
    endpoint: ENDPOINT,
    credentialSource: () => {
      credentialReads += 1;
      return undefined;
    },
  });
  const error = await assertSafeError(() => missing.generate(request()), 0);
  assertEquals(error.code, 'missing_credential');
  assertEquals(credentialReads, 1);
  assertEquals(fetchCalls, 0);

  const invalidRequest = {
    transcript: [{ role: 'user', content: { kind: 'text', text: 'x' } }],
    tools: [{ name: '', description: 'invalid', inputSchema: {} }],
  } as unknown as ModelRequest;
  const invalidModel = new OpenRouterAgentModel(options(fetcher));
  const invalidError = await assertSafeError(() => invalidModel.generate(invalidRequest), 0);
  assertEquals(invalidError.code, 'invalid_input');
  assertEquals(fetchCalls, 0);

  let invalidInstructionCredentialReads = 0;
  const invalidInstruction = new OpenRouterAgentModel({
    fetcher,
    endpoint: ENDPOINT,
    credentialSource: () => {
      invalidInstructionCredentialReads += 1;
      return DUMMY_CREDENTIAL;
    },
  });
  const invalidInstructionError = await assertSafeError(
    () =>
      invalidInstruction.generate({
        ...request(),
        systemInstruction: 'valid\0but invalid',
      }),
    0,
  );
  assertEquals(invalidInstructionError.code, 'invalid_input');
  assertEquals(invalidInstructionCredentialReads, 0);
});

Deno.test('async credential resolution rechecks cancellation and refreshes each request', async () => {
  let fetchCalls = 0;
  const aborting = new AbortController();
  const cancelledModel = new OpenRouterAgentModel({
    endpoint: ENDPOINT,
    fetcher: () => {
      fetchCalls += 1;
      return Promise.resolve(response(finalPayload('must not fetch')));
    },
    credentialSource: async () => {
      await Promise.resolve();
      aborting.abort('test cancellation');
      return 'async-cancellation-token';
    },
  });
  let cancelled = false;
  try {
    await cancelledModel.generate(request(), { signal: aborting.signal });
  } catch (error) {
    assert(error instanceof TurnCancelledError);
    cancelled = true;
  }
  assert(cancelled);
  assertEquals(fetchCalls, 0);

  const calls: FetchCall[] = [];
  let credentialReads = 0;
  const refreshed = new OpenRouterAgentModel({
    endpoint: ENDPOINT,
    fetcher: makeFetcher([
      response(finalPayload('first')),
      response(finalPayload('second')),
    ], calls),
    credentialSource: async () => {
      credentialReads += 1;
      await Promise.resolve();
      return `per-request-token-${credentialReads}`;
    },
  });
  assertEquals(await refreshed.generate(request()), { kind: 'final', text: 'first' });
  assertEquals(await refreshed.generate(request()), { kind: 'final', text: 'second' });
  assertEquals(credentialReads, 2);
  assertEquals(calls.length, 2);
  assertEquals(
    (calls[0].init?.headers as Record<string, string>).authorization,
    'Bearer per-request-token-1',
  );
  assertEquals(
    (calls[1].init?.headers as Record<string, string>).authorization,
    'Bearer per-request-token-2',
  );

  const failing = new OpenRouterAgentModel({
    endpoint: ENDPOINT,
    fetcher: () => {
      fetchCalls += 1;
      return Promise.resolve(response(finalPayload('must not fetch')));
    },
    credentialSource: async () => {
      await Promise.resolve();
      throw new Error('credential-file-path-and-secret');
    },
  });
  const failure = await assertSafeError(() => failing.generate(request()), 0);
  assertEquals(failure.code, 'missing_credential');
  assert(!failure.message.includes('credential-file-path-and-secret'));
  assertEquals(fetchCalls, 0);

  let commits = 0;
  const persistent = new AgentSession(failing, new Registry([]), {
    persistence: {
      id: 'offline-session',
      record: undefined,
      commit: () => commits += 1,
      rollback: () => {},
      close: () => {},
    },
  });
  const outcome = await persistent.submit('credential failure must not commit');
  assert(!outcome.ok);
  assertEquals(commits, 0);
  assertEquals(persistent.transcriptSnapshot(), []);
});

Deno.test('message and full request bounds fail before request starts', async () => {
  let fetchCalls = 0;
  const fetcher = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(response(finalPayload('unreachable')));
  };
  const model = new OpenRouterAgentModel(options(fetcher));
  const tooManyMessages: ModelRequest = {
    transcript: [{ role: 'user', content: { kind: 'text', text: 'x'.repeat(76 * 1024) } }],
    tools: [],
  };
  const messageError = await assertSafeError(() => model.generate(tooManyMessages), 0);
  assertEquals(messageError.code, 'limit_exceeded');
  assertEquals(fetchCalls, 0);

  const tooLargeRequest: ModelRequest = {
    transcript: [{ role: 'user', content: { kind: 'text', text: 'small' } }],
    tools: [{ name: 'large', description: 'x'.repeat(260 * 1024), inputSchema: {} }],
  };
  const requestError = await assertSafeError(() => model.generate(tooLargeRequest), 0);
  assertEquals(requestError.code, 'limit_exceeded');
  assertEquals(fetchCalls, 0);

  const systemBoundError = await assertSafeError(() =>
    model.generate({
      transcript: [{ role: 'user', content: { kind: 'text', text: 'small' } }],
      tools: [],
      systemInstruction: 's'.repeat(76 * 1024),
    }), 0);
  assertEquals(systemBoundError.code, 'limit_exceeded');
  assertEquals(fetchCalls, 0);
});

Deno.test('an individually accepted system message can tip a near-256 KiB request', async () => {
  const largeTool = {
    name: 'near_limit',
    description: 'x'.repeat(192 * 1024),
    inputSchema: {},
  };
  const nearLimitRequest: ModelRequest = {
    transcript: [{ role: 'user', content: { kind: 'text', text: 'small' } }],
    tools: [largeTool],
  };
  const baselineCalls: FetchCall[] = [];
  let baselineCredentialReads = 0;
  const baselineModel = new OpenRouterAgentModel({
    fetcher: makeFetcher([response(finalPayload('baseline'))], baselineCalls),
    endpoint: ENDPOINT,
    credentialSource: () => {
      baselineCredentialReads += 1;
      return DUMMY_CREDENTIAL;
    },
  });
  assertEquals(await baselineModel.generate(nearLimitRequest), { kind: 'final', text: 'baseline' });
  assertEquals(baselineCredentialReads, 1);
  assertEquals(baselineCalls.length, 1);
  assert(typeof baselineCalls[0].init?.body === 'string');
  assert(new TextEncoder().encode(baselineCalls[0].init?.body as string).byteLength < 256 * 1024);

  const systemInstruction = 's'.repeat(64 * 1024);
  const acceptedSystemCalls: FetchCall[] = [];
  let acceptedSystemCredentialReads = 0;
  const acceptedSystemModel = new OpenRouterAgentModel({
    fetcher: makeFetcher([response(finalPayload('accepted'))], acceptedSystemCalls),
    endpoint: ENDPOINT,
    credentialSource: () => {
      acceptedSystemCredentialReads += 1;
      return DUMMY_CREDENTIAL;
    },
  });
  assertEquals(
    await acceptedSystemModel.generate({
      ...nearLimitRequest,
      tools: [],
      systemInstruction,
    }),
    { kind: 'final', text: 'accepted' },
  );
  assertEquals(acceptedSystemCredentialReads, 1);
  assertEquals(acceptedSystemCalls.length, 1);

  const systemCalls: FetchCall[] = [];
  let systemCredentialReads = 0;
  const systemModel = new OpenRouterAgentModel({
    fetcher: makeFetcher([response(finalPayload('unreachable'))], systemCalls),
    endpoint: ENDPOINT,
    credentialSource: () => {
      systemCredentialReads += 1;
      return DUMMY_CREDENTIAL;
    },
  });
  const error = await assertSafeError(
    () =>
      systemModel.generate({
        ...nearLimitRequest,
        systemInstruction,
      }),
    0,
  );
  assertEquals(error.code, 'limit_exceeded');
  assertEquals(systemCredentialReads, 0);
  assertEquals(systemCalls.length, 0);
});
