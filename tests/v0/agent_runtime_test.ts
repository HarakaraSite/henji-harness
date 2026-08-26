import { assert, assertEquals } from './test_helpers.ts';
import { type LoopOutcome } from '../../v0/agent/contracts.ts';
import { FIXED_JSON_PATH, MAX_STEPS, runRuntime, type RuntimeRun } from '../../v0/agent/runtime.ts';
import { main, MAX_TASK_BYTES, readBoundedStdin } from '../../v0/agent/runtime_cli.ts';

const DUMMY_CREDENTIAL = 'offline-dummy-credential';

const response = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const finalPayload = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});

const toolPayload = (
  calls: readonly { id: string; name: string; arguments: unknown }[],
) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    },
  }],
});

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

const fetchSequence = (
  responses: readonly Response[],
  calls: FetchCall[] = [],
): typeof fetch => {
  let index = 0;
  return (input, init) => {
    calls.push({ input, init });
    const next = responses[index++];
    if (!next) throw new Error('unexpected extra request');
    return Promise.resolve(next);
  };
};

const runtime = (
  responses: readonly Response[],
  extra: Parameters<typeof runRuntime>[1] = {},
): Promise<RuntimeRun> =>
  runRuntime('offline task', {
    fetcher: fetchSequence(responses),
    credential: DUMMY_CREDENTIAL,
    ...extra,
  });

const requestBody = (call: FetchCall): Record<string, unknown> => {
  assert(typeof call.init?.body === 'string');
  return JSON.parse(call.init.body) as Record<string, unknown>;
};

const taskBytes = (length: number): Uint8Array => new TextEncoder().encode('x'.repeat(length));

const streamFor = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const runWithOutput = async (
  args: readonly string[],
  options: {
    readonly terminal?: boolean;
    readonly stdin?: Uint8Array;
    readonly run?: (task: string) => Promise<RuntimeRun>;
  } = {},
) => {
  let stdout = '';
  let stderr = '';
  let taskSeen: string | undefined;
  const exit = await main(args, {
    stdinIsTerminal: () => options.terminal ?? false,
    stdin: options.stdin === undefined ? undefined : streamFor(options.stdin),
    run: options.run ?? ((task) => {
      taskSeen = task;
      return Promise.resolve({
        outcome: {
          ok: true,
          task,
          outcome: 'final',
          stopReason: 'final',
          finalText: 'answer',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
        requestCount: 1,
      });
    }),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { exit, stdout, stderr, taskSeen };
};

Deno.test('normal runtime builds one stable five-tool registry and returns final-only output data', async () => {
  const calls: FetchCall[] = [];
  const result = await runRuntime('offline task', {
    fetcher: fetchSequence([response(finalPayload('answer'))], calls),
    credential: DUMMY_CREDENTIAL,
  });
  assert(result.outcome.ok);
  assertEquals(result.outcome.finalText, 'answer');
  assertEquals(result.outcome.steps, 1);
  assertEquals(result.requestCount, 1);
  assertEquals(
    (requestBody(calls[0]).tools as Array<Record<string, unknown>>).map((
      tool,
    ) => (tool.function as Record<string, unknown>).name),
    [
      'character_count',
      'count_json_array_items',
      'list_json_object_keys',
      'submit_json_result',
      'uppercase_text',
    ],
  );
  assertEquals(MAX_STEPS, 8);
});

Deno.test('normal runtime completes one-tool and sequential two-tool rounds', async () => {
  const one = await runtime([
    response(
      toolPayload([{
        id: 'u1',
        name: 'uppercase_text',
        arguments: { text: 'hello' },
      }]),
    ),
    response(finalPayload('HELLO')),
  ]);
  assert(one.outcome.ok);
  assertEquals(one.outcome.steps, 2);
  assertEquals(one.outcome.toolCallCount, 1);
  assertEquals(one.outcome.toolResultCount, 1);
  assertEquals(one.requestCount, 2);

  const two = await runtime([
    response(toolPayload([{
      id: 'l1',
      name: 'list_json_object_keys',
      arguments: { path: FIXED_JSON_PATH, objectKey: 'tasks' },
    }])),
    response(toolPayload([{
      id: 'c1',
      name: 'count_json_array_items',
      arguments: { json: '["alpha","beta"]' },
    }])),
    response(finalPayload('{"count":2}')),
  ], {
    readFile: (path) => {
      assertEquals(path, FIXED_JSON_PATH);
      return Promise.resolve(new TextEncoder().encode('{"tasks":{"alpha":1,"beta":2}}'));
    },
  });
  assert(two.outcome.ok);
  assertEquals(two.outcome.finalText, '{"count":2}');
  assertEquals(two.outcome.steps, 3);
  assertEquals(two.outcome.toolCallCount, 2);
  assertEquals(two.outcome.toolResultCount, 2);
  assertEquals(two.requestCount, 3);
});

Deno.test('one model response can dispatch multiple state-free calls in order', async () => {
  const calls: FetchCall[] = [];
  const result = await runRuntime('offline task', {
    fetcher: fetchSequence([
      response(toolPayload([
        { id: 'c1', name: 'character_count', arguments: { text: 'Henji 🐣' } },
        { id: 'u1', name: 'uppercase_text', arguments: { text: 'hello' } },
      ])),
      response(finalPayload('7 / HELLO')),
    ], calls),
    credential: DUMMY_CREDENTIAL,
  });
  assert(result.outcome.ok);
  assertEquals(result.outcome.toolCallCount, 2);
  assertEquals(result.outcome.toolResultCount, 2);
  assertEquals(result.outcome.transcript[2], {
    role: 'tool',
    content: [
      {
        kind: 'tool_result',
        callId: 'c1',
        name: 'character_count',
        text: '{"count":7}',
        outcome: 'success',
      },
      {
        kind: 'tool_result',
        callId: 'u1',
        name: 'uppercase_text',
        text: 'HELLO',
        outcome: 'success',
      },
    ],
  });
});

Deno.test('unknown, invalid, and execution tool errors are recoverable within the bound', async () => {
  const cases: readonly [string, unknown, string][] = [
    ['unknown', { name: 'missing_tool', arguments: {} }, 'unknown tool'],
    [
      'invalid',
      { name: 'uppercase_text', arguments: { text: 1 } },
      'invalid arguments',
    ],
    ['execution', {
      name: 'list_json_object_keys',
      arguments: { path: FIXED_JSON_PATH, objectKey: 'tasks' },
    }, 'tool execution error'],
  ];
  for (const [name, call, expected] of cases) {
    const callValue = call as { name: string; arguments: unknown };
    const result = await runtime([
      response(
        toolPayload([{
          id: name,
          name: callValue.name,
          arguments: callValue.arguments,
        }]),
      ),
      response(finalPayload(`${name} recovered`)),
    ], {
      readFile: () => Promise.reject(new Error('offline injected failure')),
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, `${name} recovered`);
    const toolMessage = result.outcome.transcript[2];
    assert(toolMessage.role === 'tool');
    assert(toolMessage.content[0].outcome === 'error');
    assert(toolMessage.content[0].text.includes(expected));
  }
});

Deno.test('fixed JSON path rejects before invoking the reader', async () => {
  let reads = 0;
  const result = await runtime([
    response(toolPayload([{
      id: 'bad-path',
      name: 'list_json_object_keys',
      arguments: { path: 'other.json', objectKey: 'tasks' },
    }])),
    response(finalPayload('recovered')),
  ], {
    readFile: () => {
      reads += 1;
      return Promise.resolve(new Uint8Array());
    },
  });
  assert(result.outcome.ok);
  assertEquals(reads, 0);
  assert(result.outcome.transcript[2].role === 'tool');
  assert(
    result.outcome.transcript[2].content[0].text.startsWith(
      'invalid arguments:',
    ),
  );
});

Deno.test('eight tool responses execute the last local batch without a ninth fetch', async () => {
  const calls: FetchCall[] = [];
  const responses = Array.from(
    { length: 8 },
    (_, index) =>
      response(toolPayload([{
        id: `loop-${index + 1}`,
        name: 'uppercase_text',
        arguments: { text: 'loop' },
      }])),
  );
  const result = await runRuntime('loop', {
    fetcher: fetchSequence(responses, calls),
    credential: DUMMY_CREDENTIAL,
  });
  assert(!result.outcome.ok);
  assertEquals(result.outcome.stopReason, 'max_steps');
  assertEquals(result.outcome.steps, 8);
  assertEquals(result.outcome.toolCallCount, 8);
  assertEquals(result.outcome.toolResultCount, 8);
  assertEquals(result.requestCount, 8);
  assertEquals(calls.length, 8);
});

Deno.test('missing credential and first transport failure perform no application retry', async () => {
  let fetches = 0;
  const missing = await runRuntime('task', {
    fetcher: () => {
      fetches += 1;
      return Promise.resolve(response(finalPayload('unreachable')));
    },
    credentialSource: () => undefined,
  });
  assert(!missing.outcome.ok);
  assertEquals(missing.requestCount, 0);
  assertEquals(fetches, 0);

  const transport = await runRuntime('task', {
    fetcher: () => {
      fetches += 1;
      return Promise.reject(new Error('provider body marker'));
    },
    credential: DUMMY_CREDENTIAL,
  });
  assert(!transport.outcome.ok);
  assertEquals(transport.outcome.steps, 1);
  assertEquals(transport.requestCount, 1);
  assertEquals(fetches, 1);
});

Deno.test('CLI accepts one normalized argv task or one normalized pipe task', async () => {
  const argv = await runWithOutput(['--task', '  hello  '], { terminal: true });
  assertEquals(argv.exit, 0);
  assertEquals(argv.taskSeen, 'hello');
  assertEquals(argv.stdout, 'answer\n');
  assertEquals(argv.stderr, '');

  const alreadyNewline = await runWithOutput(['--task', 'hello'], {
    terminal: true,
    run: (task) =>
      Promise.resolve({
        outcome: {
          ok: true,
          task,
          outcome: 'final',
          stopReason: 'final',
          finalText: 'answer\n',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
        requestCount: 1,
      }),
  });
  assertEquals(alreadyNewline.exit, 0);
  assertEquals(alreadyNewline.stdout, 'answer\n');
  assertEquals(alreadyNewline.stderr, '');

  const piped = await runWithOutput([], {
    terminal: false,
    stdin: new TextEncoder().encode('  piped task\n'),
  });
  assertEquals(piped.exit, 0);
  assertEquals(piped.taskSeen, 'piped task');
  assertEquals(piped.stdout, 'answer\n');
  assertEquals(piped.stderr, '');
});

Deno.test('CLI rejects duplicate, missing, unknown, positional, and ambiguous input', async () => {
  const invalidArgs: readonly (readonly string[])[] = [
    ['--task', 'one', '--task', 'two'],
    ['--task'],
    ['--unknown'],
    ['positional'],
  ];
  for (const args of invalidArgs) {
    const result = await runWithOutput(args, { terminal: true });
    assertEquals(result.exit, 1);
    assertEquals(result.stdout, '');
    const parsed = JSON.parse(result.stderr);
    assertEquals(parsed.error, {
      code: 'invalid_input',
      message: 'invalid agent invocation',
    });
    assertEquals(parsed.requestCount, 0);
  }
  const terminalWithoutTask = await runWithOutput([], { terminal: true });
  assertEquals(terminalWithoutTask.exit, 1);
  const ambiguous = await runWithOutput(['--task', 'hello'], {
    terminal: false,
    stdin: new TextEncoder().encode('ignored'),
  });
  assertEquals(ambiguous.exit, 1);
  assertEquals(ambiguous.stdout, '');
  assertEquals(JSON.parse(ambiguous.stderr).error.code, 'invalid_input');
});

Deno.test('CLI rejects blank, invalid UTF-8, and the 65,537-byte raw boundary', async () => {
  for (
    const input of [
      new TextEncoder().encode(' \n\t '),
      new Uint8Array([0xc3, 0x28]),
    ]
  ) {
    const result = await runWithOutput([], { stdin: input });
    assertEquals(result.exit, 1);
    assertEquals(result.stdout, '');
    assertEquals(JSON.parse(result.stderr).error.code, 'invalid_input');
  }
  const exact = await runWithOutput([], {
    stdin: taskBytes(MAX_TASK_BYTES),
    run: (task) =>
      Promise.resolve({
        outcome: {
          ok: true,
          task,
          outcome: 'final',
          stopReason: 'final',
          finalText: 'exact',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
        requestCount: 1,
      }),
  });
  assertEquals(exact.exit, 0);
  const oversized = await runWithOutput([], {
    stdin: taskBytes(MAX_TASK_BYTES + 1),
  });
  assertEquals(oversized.exit, 1);
  assertEquals(JSON.parse(oversized.stderr).error.code, 'invalid_input');
});

Deno.test('CLI failure output is one allowlisted sanitized JSON line', async () => {
  const outcome: LoopOutcome = {
    ok: false,
    task: 'secret task marker',
    outcome: 'contract_failure',
    stopReason: 'contract_failure',
    error: 'credential and provider body marker',
    steps: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    transcript: [],
  };
  const result = await runWithOutput(['--task', 'task'], {
    terminal: true,
    run: () => Promise.resolve({ outcome, requestCount: 2 }),
  });
  assertEquals(result.exit, 1);
  assertEquals(result.stdout, '');
  const line = JSON.parse(result.stderr);
  assertEquals(line, {
    ok: false,
    outcome: 'contract_failure',
    stopReason: 'contract_failure',
    steps: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    requestCount: 2,
    error: { code: 'agent_failure', message: 'agent run failed' },
  });
  assert(!result.stderr.includes('secret task marker'));
  assert(!result.stderr.includes('credential'));
  assert(!result.stderr.includes('provider body marker'));
});

Deno.test('CLI preserves counters when a later runtime request fails without retry', async () => {
  const calls: FetchCall[] = [];
  let fetchStarts = 0;
  const fetcher: typeof fetch = (input, init) => {
    fetchStarts += 1;
    calls.push({ input, init });
    if (fetchStarts === 1) {
      return Promise.resolve(response(toolPayload([{
        id: 'later-failure-call',
        name: 'uppercase_text',
        arguments: { text: 'hello' },
      }])));
    }
    return Promise.reject(new Error('PROVIDER_BODY_MARKER'));
  };
  let stdout = '';
  let stderr = '';
  const exit = await main(['--task', 'later failure'], {
    stdinIsTerminal: () => true,
    runtimeSeam: { fetcher, credential: DUMMY_CREDENTIAL },
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(exit, 1);
  assertEquals(stdout, '');
  assertEquals(JSON.parse(stderr), {
    ok: false,
    outcome: 'contract_failure',
    stopReason: 'contract_failure',
    steps: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    requestCount: 2,
    error: { code: 'agent_failure', message: 'agent run failed' },
  });
  assertEquals(fetchStarts, 2);
  assertEquals(calls.length, 2);
  assert(!stderr.includes('PROVIDER_BODY_MARKER'));
});

Deno.test('CLI max-step failure preserves bounded counters and exact error schema', async () => {
  const outcome: LoopOutcome = {
    ok: false,
    task: 'task',
    outcome: 'max_steps',
    stopReason: 'max_steps',
    steps: 8,
    toolCallCount: 8,
    toolResultCount: 8,
    transcript: [],
  };
  const result = await runWithOutput(['--task', 'task'], {
    terminal: true,
    run: () => Promise.resolve({ outcome, requestCount: 8 }),
  });
  assertEquals(result.exit, 1);
  assertEquals(result.stdout, '');
  assertEquals(JSON.parse(result.stderr), {
    ok: false,
    outcome: 'max_steps',
    stopReason: 'max_steps',
    steps: 8,
    toolCallCount: 8,
    toolResultCount: 8,
    requestCount: 8,
    error: { code: 'max_steps', message: 'agent request limit reached' },
  });
});

Deno.test('bounded stdin stops at the first oversized chunk without buffering it', async () => {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.enqueue(taskBytes(MAX_TASK_BYTES + 1));
      controller.close();
    },
  });
  let rejected = false;
  try {
    await readBoundedStdin(stream);
  } catch {
    rejected = true;
  }
  assert(rejected);
  assertEquals(reads, 1);
});
