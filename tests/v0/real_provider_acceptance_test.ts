import { assert, assertEquals } from './test_helpers.ts';
import {
  type AcceptanceDependencies,
  evaluateAcceptanceOutcome,
  EXPECTED_FINAL_TEXT,
  FIXED_TASK,
  FIXED_TOOL_INPUT_TEXT,
  FIXED_TOOL_NAME,
  runAcceptance,
} from '../../v0/agent/real_provider_acceptance.ts';
import { FixtureModel } from '../../v0/agent/fixture_model.ts';
import { createFixtureTool, Registry } from '../../v0/agent/tools.ts';
import { runAgent } from '../../v0/agent/loop.ts';

const DUMMY_CREDENTIAL = 'dummy-step-seven-credential';
const PROVIDER_BODY_MARKER = 'provider-body-marker';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

const response = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const toolCall = (name = FIXED_TOOL_NAME, argumentsValue = { text: FIXED_TOOL_INPUT_TEXT }) => ({
  id: 'step-seven-call',
  type: 'function',
  function: { name, arguments: JSON.stringify(argumentsValue) },
});

const toolResponse = (calls = [toolCall()]) => ({
  choices: [{
    message: { role: 'assistant', content: null, tool_calls: calls },
  }],
});

const finalResponse = (text = EXPECTED_FINAL_TEXT) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});

const acceptanceArgs = (): readonly string[] => ['--confirm-external-call', '--task', FIXED_TASK];

const makeFetcher = (responses: readonly Response[], calls: FetchCall[]) => {
  let index = 0;
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    const next = responses[index++];
    if (!next) throw new Error('unexpected third request');
    return Promise.resolve(next);
  };
};

const dependencies = (
  fetcher: typeof fetch,
  extra: Partial<AcceptanceDependencies> = {},
): AcceptanceDependencies => ({
  fetcher,
  credential: DUMMY_CREDENTIAL,
  ...extra,
});

const parseOutput = (run: Awaited<ReturnType<typeof runAcceptance>>): Record<string, unknown> => {
  assertEquals(run.output.split('\n').length, 1);
  return JSON.parse(run.output) as Record<string, unknown>;
};

const assertFailure = (
  run: Awaited<ReturnType<typeof runAcceptance>>,
  expectedRequests: number,
): Record<string, unknown> => {
  assertEquals(run.exitCode, 1);
  const output = parseOutput(run);
  assertEquals(output.ok, false);
  assertEquals(output.requestCount, expectedRequests);
  const error = output.error as Record<string, unknown>;
  assert(typeof error?.code === 'string');
  assert(typeof error?.message === 'string');
  return output;
};

const allowedOutputKeys = new Set([
  'ok',
  'profile',
  'outcome',
  'stopReason',
  'steps',
  'toolCallCount',
  'toolResultCount',
  'requestCount',
  'finalText',
  'error',
  'code',
  'message',
]);

const assertAllowlisted = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) assertAllowlisted(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    assert(allowedOutputKeys.has(key), `unexpected output key: ${key}`);
    assertAllowlisted(nested);
  }
};

Deno.test('exact fixed acceptance succeeds through two fake-fetch requests', async () => {
  const calls: FetchCall[] = [];
  const run = await runAcceptance(
    acceptanceArgs(),
    dependencies(makeFetcher([response(toolResponse()), response(finalResponse())], calls)),
  );
  assertEquals(run.exitCode, 0);
  const output = parseOutput(run);
  assertEquals(output, {
    ok: true,
    profile: 'openrouter-google-gemini-3.7-flash-vertex-v0',
    outcome: 'final',
    stopReason: 'final',
    steps: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    requestCount: 2,
    finalText: EXPECTED_FINAL_TEXT,
  });
  assertEquals(calls.length, 2);
  assertEquals(calls[0].input, ENDPOINT);
  const secondBody = JSON.parse(String(calls[1].init?.body)) as {
    messages: readonly Record<string, unknown>[];
  };
  assertEquals(secondBody.messages.map((message) => message.role), ['user', 'assistant', 'tool']);
  assertEquals(secondBody.messages[2], {
    role: 'tool',
    tool_call_id: 'step-seven-call',
    content: EXPECTED_FINAL_TEXT,
  });
});

Deno.test('initial final response is bounded at one request and never dispatches a tool', async () => {
  const calls: FetchCall[] = [];
  const run = await runAcceptance(
    acceptanceArgs(),
    dependencies(makeFetcher([response(finalResponse())], calls)),
  );
  const output = assertFailure(run, 1);
  assertEquals(output.steps, 1);
  assertEquals(output.toolCallCount, 0);
  assertEquals(output.toolResultCount, 0);
  assertEquals(calls.length, 1);
  assertEquals((output.error as Record<string, unknown>).code, 'acceptance_contract');
});

Deno.test('unexpected first responses fail before a second request', async () => {
  const cases = [
    [toolCall('different_tool'), toolCall()],
    [toolCall(FIXED_TOOL_NAME, { text: 'wrong' })],
    [toolCall(), toolCall()],
  ] as const;
  for (const callsInResponse of cases) {
    const calls: FetchCall[] = [];
    const run = await runAcceptance(
      acceptanceArgs(),
      dependencies(makeFetcher([response(toolResponse([...callsInResponse]))], calls)),
    );
    const output = assertFailure(run, 1);
    assertEquals(output.toolCallCount, 0);
    assertEquals(output.toolResultCount, 0);
    assertEquals(calls.length, 1);
  }
});

Deno.test('second response failures stop at two requests without a third request', async () => {
  const cases = [
    response(toolResponse([toolCall('different_tool')])),
    response(toolResponse([toolCall(), toolCall()])),
    response(finalResponse('wrong final')),
    response({ choices: [{ message: { role: 'assistant', content: '' } }] }),
  ];
  for (const second of cases) {
    const calls: FetchCall[] = [];
    const run = await runAcceptance(
      acceptanceArgs(),
      dependencies(makeFetcher([response(toolResponse()), second], calls)),
    );
    const output = assertFailure(run, 2);
    assertEquals(output.steps, 2);
    assertEquals(output.toolCallCount, 1);
    assertEquals(output.toolResultCount, 1);
    assertEquals(calls.length, 2);
  }
});

Deno.test('missing credential fails before fetch and first transport failures are one request', async () => {
  let credentialReads = 0;
  let fetchCalls = 0;
  const missing = await runAcceptance(acceptanceArgs(), {
    credentialSource: () => {
      credentialReads += 1;
      return undefined;
    },
    fetcher: () => {
      fetchCalls += 1;
      return Promise.resolve(response(finalResponse()));
    },
  });
  assertFailure(missing, 0);
  assertEquals(credentialReads, 1);
  assertEquals(fetchCalls, 0);

  const calls: FetchCall[] = [];
  const rejecting = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input: _input, init });
    return Promise.reject(new Error(PROVIDER_BODY_MARKER));
  };
  assertFailure(await runAcceptance(acceptanceArgs(), dependencies(rejecting)), 1);
  assertEquals(calls.length, 1);
});

Deno.test('second transport failure is bounded at two requests', async () => {
  const calls: FetchCall[] = [];
  const secondFailure = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    if (calls.length === 1) return Promise.resolve(response(toolResponse()));
    return Promise.reject(new Error(PROVIDER_BODY_MARKER));
  };
  assertFailure(await runAcceptance(acceptanceArgs(), dependencies(secondFailure)), 2);
  assertEquals(calls.length, 2);

  const httpCalls: FetchCall[] = [];
  const httpSecond = makeFetcher([
    response(toolResponse()),
    response({ error: PROVIDER_BODY_MARKER }, 503),
  ], httpCalls);
  assertFailure(await runAcceptance(acceptanceArgs(), dependencies(httpSecond)), 2);
  assertEquals(httpCalls.length, 2);
});

Deno.test('HTTP and body-deadline failures stay bounded without extra requests', async () => {
  const httpCalls: FetchCall[] = [];
  const httpFirst = makeFetcher([response({ error: PROVIDER_BODY_MARKER }, 503)], httpCalls);
  assertFailure(await runAcceptance(acceptanceArgs(), dependencies(httpFirst)), 1);
  assertEquals(httpCalls.length, 1);

  let aborted = false;
  const timeoutCalls: FetchCall[] = [];
  const stalled = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    timeoutCalls.push({ input, init });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          controller.error(new Error('body timeout'));
        }, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  assertFailure(
    await runAcceptance(acceptanceArgs(), dependencies(stalled, { timeoutMs: 15 })),
    1,
  );
  assert(aborted);
  assertEquals(timeoutCalls.length, 1);

  let secondAborted = false;
  const secondTimeoutCalls: FetchCall[] = [];
  const secondStalled = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    secondTimeoutCalls.push({ input, init });
    if (secondTimeoutCalls.length === 1) return Promise.resolve(response(toolResponse()));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          secondAborted = true;
          controller.error(new Error('body timeout'));
        }, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  assertFailure(
    await runAcceptance(acceptanceArgs(), dependencies(secondStalled, { timeoutMs: 15 })),
    2,
  );
  assert(secondAborted);
  assertEquals(secondTimeoutCalls.length, 2);
});

Deno.test('confirmation and task preflight rejects malformed CLI input at request zero', async () => {
  const invalidCases: readonly (readonly string[])[] = [
    [],
    ['--task', FIXED_TASK],
    ['--confirm-external-call'],
    ['--confirm-external-call', '--task'],
    ['--confirm-external-call', '--task', FIXED_TASK, '--task', FIXED_TASK],
    ['--confirm-external-call', '--confirm-external-call', '--task', FIXED_TASK],
    ['--confirm-external-call', '--unknown', '--task', FIXED_TASK],
    ['--confirm-external-call', '--task', 'different task'],
    ['--confirm-external-call', '--task', 'x'.repeat(1025)],
  ];
  for (const args of invalidCases) {
    let credentialReads = 0;
    let fetchCalls = 0;
    const run = await runAcceptance(args, {
      credentialSource: () => {
        credentialReads += 1;
        return DUMMY_CREDENTIAL;
      },
      fetcher: () => {
        fetchCalls += 1;
        return Promise.resolve(response(finalResponse()));
      },
    });
    assertFailure(run, 0);
    assertEquals(credentialReads, 0);
    assertEquals(fetchCalls, 0);
  }
});

Deno.test('complete-tuple evaluator rejects a request-count mismatch', async () => {
  const model = new FixtureModel([
    {
      kind: 'tool_calls',
      calls: [{
        callId: 'call',
        name: FIXED_TOOL_NAME,
        arguments: { text: FIXED_TOOL_INPUT_TEXT },
      }],
    },
    { kind: 'final', text: EXPECTED_FINAL_TEXT },
  ]);
  const outcome = await runAgent(
    FIXED_TASK,
    model,
    new Registry([createFixtureTool()]),
    { maxSteps: 2 },
  );
  assert(evaluateAcceptanceOutcome(outcome, 1) === undefined);
  assert(evaluateAcceptanceOutcome(outcome, 2)?.ok === true);
});

Deno.test('failure output is recursively allowlisted and redacted', async () => {
  const calls: FetchCall[] = [];
  const rejecting = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    const error = Object.assign(new Error(PROVIDER_BODY_MARKER), {
      authorization: DUMMY_CREDENTIAL,
      headers: { authorization: DUMMY_CREDENTIAL },
      transcript: [{ role: 'user', content: 'secret transcript' }],
    });
    return Promise.reject(error);
  };
  const run = await runAcceptance(acceptanceArgs(), dependencies(rejecting));
  const output = assertFailure(run, 1);
  assertAllowlisted(output);
  const serialized = JSON.stringify(output);
  assert(!serialized.includes(DUMMY_CREDENTIAL));
  assert(!serialized.includes(PROVIDER_BODY_MARKER));
  assert(!serialized.includes('transcript'));
  assert(!serialized.includes('authorization'));
  assertEquals(calls.length, 1);
});
