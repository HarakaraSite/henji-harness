import { assert, assertEquals } from './test_helpers.ts';
import {
  createOpenRouterAgentModel,
  OpenRouterAgentError,
  OpenRouterAgentModel,
  type OpenRouterAgentModelOptions,
} from '../../v0/agent/openrouter_model.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { createCorpusRegistry } from '../../v0/agent/registries.ts';
import { createFixtureTool, Registry } from '../../v0/agent/tools.ts';
import { type ModelRequest } from '../../v0/agent/contracts.ts';

const ENDPOINT = 'https://offline.invalid/api/v1/chat/completions';
const DUMMY_CREDENTIAL = 'dummy-credential-marker';

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
});
