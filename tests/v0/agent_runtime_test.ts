import { assert, assertEquals } from './test_helpers.ts';
import { MAX_STEPS, runRuntime, type RuntimeRun } from '../../v0/agent/runtime.ts';
import { main, MAX_TASK_BYTES } from '../../v0/agent/runtime_cli.ts';

const DUMMY_CREDENTIAL = 'offline-dummy-credential';
const encoder = new TextEncoder();

const response = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const finalPayload = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});
const toolPayload = (calls: readonly { id: string; name: string; arguments: unknown }[]) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    },
  }],
});
type FetchCall = { input: RequestInfo | URL; init?: RequestInit };
const fetchSequence = (responses: readonly Response[], calls: FetchCall[] = []): typeof fetch => {
  let index = 0;
  return (input, init) => {
    calls.push({ input, init });
    const next = responses[index++];
    if (!next) throw new Error('unexpected extra request');
    return Promise.resolve(next);
  };
};
const withWorkspace = async <T>(fn: (root: string) => Promise<T>): Promise<T> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-runtime-' });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};
const run = (root: string, responses: readonly Response[], extra: Record<string, unknown> = {}) =>
  runRuntime('offline task', {
    workspaceRoot: root,
    fetcher: fetchSequence(responses),
    credential: DUMMY_CREDENTIAL,
    ...extra,
  });
const requestBody = (call: FetchCall): Record<string, unknown> => {
  assert(typeof call.init?.body === 'string');
  return JSON.parse(call.init.body) as Record<string, unknown>;
};
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
  const exit = await main(args, {
    stdinIsTerminal: () => options.terminal ?? false,
    stdin: options.stdin === undefined ? undefined : streamFor(options.stdin),
    run: options.run ?? ((task) =>
      Promise.resolve({
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
      })),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { exit, stdout, stderr };
};

Deno.test('normal runtime exposes exactly the production five-tool registry', async () => {
  await withWorkspace(async (root) => {
    const calls: FetchCall[] = [];
    const result = await runRuntime('offline task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('answer'))], calls),
      credential: DUMMY_CREDENTIAL,
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'answer');
    assertEquals(result.requestCount, 1);
    assertEquals(
      (requestBody(calls[0]).tools as Array<Record<string, unknown>>).map((tool) =>
        (tool.function as Record<string, unknown>).name
      ),
      ['bash', 'edit', 'read', 'submit_json_result', 'write'],
    );
    assertEquals(MAX_STEPS, 8);
  });
});

Deno.test('normal runtime discovers workspace instructions once as a system message', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(`${root}/AGENTS.md`, '  local runtime instructions\n');
    const calls: FetchCall[] = [];
    const result = await runRuntime('offline task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('answer'))], calls),
      credential: DUMMY_CREDENTIAL,
    });
    assert(result.outcome.ok);
    assertEquals(calls.length, 1);
    const messages = requestBody(calls[0]).messages as Array<Record<string, unknown>>;
    assertEquals(messages, [
      {
        role: 'system',
        content:
          'Project context instructions loaded from AGENTS.md. Follow them when working in this workspace.\n\n## ./AGENTS.md\n\nlocal runtime instructions',
      },
      { role: 'user', content: 'offline task' },
    ]);
    assert(!JSON.stringify(result.outcome.transcript).includes('local runtime instructions'));
  });
});

Deno.test('runtime executes causal write/read/edit/bash work rounds', async () => {
  await withWorkspace(async (root) => {
    const result = await run(root, [
      response(
        toolPayload([{ id: 'w', name: 'write', arguments: { path: 'note.txt', content: 'one' } }]),
      ),
      response(toolPayload([{ id: 'r', name: 'read', arguments: { path: './note.txt' } }])),
      response(
        toolPayload([{
          id: 'e',
          name: 'edit',
          arguments: { path: 'note.txt', edits: [{ oldText: 'one', newText: 'two' }] },
        }]),
      ),
      response(toolPayload([{ id: 'b', name: 'bash', arguments: { command: 'cat note.txt' } }])),
      response(finalPayload('done')),
    ]);
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'done');
    assertEquals(await Deno.readTextFile(`${root}/note.txt`), 'two');
    assertEquals(result.outcome.toolCallCount, 4);
    assert(result.outcome.transcript[2].role === 'tool');
    assert(result.outcome.transcript[2].content[0].text.includes('"bytes":3'));
  });
});

Deno.test('multiple local work calls remain ordered and errors are recoverable', async () => {
  await withWorkspace(async (root) => {
    const result = await run(root, [
      response(toolPayload([
        { id: 'bad', name: 'read', arguments: { path: '../outside' } },
        { id: 'bash', name: 'bash', arguments: { command: 'printf out; printf err >&2; exit 7' } },
      ])),
      response(finalPayload('recovered')),
    ]);
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'recovered');
    assert(result.outcome.transcript[2].role === 'tool');
    assertEquals(result.outcome.transcript[2].content.map((item) => item.name), ['read', 'bash']);
    assert(
      result.outcome.transcript[2].content[0].text.includes('path must stay within workspace'),
    );
    assert(result.outcome.transcript[2].content[1].text.includes('"exitCode":7'));
  });
});

Deno.test('terminal submission on request eight makes no ninth request', async () => {
  await withWorkspace(async (root) => {
    const responses = Array.from(
      { length: 7 },
      (_, index) =>
        response(toolPayload([{ id: `r${index}`, name: 'bash', arguments: { command: 'true' } }])),
    );
    responses.push(
      response(
        toolPayload([{
          id: 'terminal',
          name: 'submit_json_result',
          arguments: { json: '{"ok":true}' },
        }]),
      ),
    );
    let requests = 0;
    const sequence = fetchSequence(responses);
    const result = await runRuntime('loop', {
      workspaceRoot: root,
      fetcher: (input, init) => {
        requests += 1;
        return sequence(input, init);
      },
      credential: DUMMY_CREDENTIAL,
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.stopReason, 'tool_terminal');
    assertEquals(result.outcome.finalText, '{"ok":true}');
    assertEquals(requests, 8);
  });
});

Deno.test('eight nonterminal rounds end at max_steps with eight fetches', async () => {
  await withWorkspace(async (root) => {
    const responses = Array.from(
      { length: 8 },
      (_, index) =>
        response(toolPayload([{ id: `${index}`, name: 'bash', arguments: { command: 'true' } }])),
    );
    let fetches = 0;
    const sequence = fetchSequence(responses);
    const result = await runRuntime('loop', {
      workspaceRoot: root,
      fetcher: (input, init) => {
        fetches += 1;
        return sequence(input, init);
      },
      credential: DUMMY_CREDENTIAL,
    });
    assert(!result.outcome.ok);
    assertEquals(result.outcome.stopReason, 'max_steps');
    assertEquals(result.requestCount, 8);
    assertEquals(fetches, 8);
  });
});

Deno.test('missing credential and transport failure retain retry zero', async () => {
  await withWorkspace(async (root) => {
    let fetches = 0;
    const missing = await runRuntime('task', {
      workspaceRoot: root,
      credentialSource: () => undefined,
      fetcher: () => {
        fetches += 1;
        return Promise.resolve(response(finalPayload('never')));
      },
    });
    assert(!missing.outcome.ok);
    assertEquals(missing.requestCount, 0);
    assertEquals(fetches, 0);
    const transport = await runRuntime('task', {
      workspaceRoot: root,
      credential: DUMMY_CREDENTIAL,
      fetcher: () => {
        fetches += 1;
        return Promise.reject(new Error('provider marker'));
      },
    });
    assert(!transport.outcome.ok);
    assertEquals(transport.requestCount, 1);
    assertEquals(fetches, 1);
  });
});

Deno.test('CLI keeps final-only channels and input contract', async () => {
  const argv = await runWithOutput(['--task', '  hello  '], { terminal: true });
  assertEquals(argv.exit, 0);
  assertEquals(argv.stdout, 'answer\n');
  assertEquals(argv.stderr, '');
  const invalid = await runWithOutput(['--unknown'], { terminal: true });
  assertEquals(invalid.exit, 1);
  assertEquals(invalid.stdout, '');
  assertEquals(JSON.parse(invalid.stderr).error.code, 'invalid_input');
  const oversized = await runWithOutput([], {
    stdin: encoder.encode('x'.repeat(MAX_TASK_BYTES + 1)),
  });
  assertEquals(oversized.exit, 1);
  assertEquals(oversized.stdout, '');
  assertEquals(JSON.parse(oversized.stderr).error.code, 'invalid_input');
});

Deno.test('CLI rejects duplicate, missing, positional, and ambiguous task sources', async () => {
  for (
    const args of [
      ['--task', 'one', '--task', 'two'],
      ['--task'],
      ['positional'],
    ]
  ) {
    const result = await runWithOutput(args, { terminal: true });
    assertEquals(result.exit, 1);
    assertEquals(result.stdout, '');
    assertEquals(JSON.parse(result.stderr).error.code, 'invalid_input');
  }
  const ambiguous = await runWithOutput(['--task', 'hello'], {
    stdin: encoder.encode('ignored'),
    terminal: false,
  });
  assertEquals(ambiguous.exit, 1);
  assertEquals(ambiguous.stdout, '');
  assertEquals(JSON.parse(ambiguous.stderr).error.code, 'invalid_input');
});

Deno.test('CLI rejects blank and malformed UTF-8 piped tasks before the runner', async () => {
  for (const input of [encoder.encode(' \n\t '), new Uint8Array([0xc3, 0x28])]) {
    const result = await runWithOutput([], { stdin: input });
    assertEquals(result.exit, 1);
    assertEquals(result.stdout, '');
    assertEquals(JSON.parse(result.stderr).error.code, 'invalid_input');
  }
});

Deno.test('CLI maps later runtime failures to one generic sanitized line', async () => {
  const result = await runWithOutput(['--task', 'hello'], {
    terminal: true,
    run: (task) =>
      Promise.resolve({
        outcome: {
          ok: false,
          task,
          outcome: 'contract_failure',
          stopReason: 'contract_failure',
          error: 'provider-sensitive-marker',
          steps: 2,
          toolCallCount: 1,
          toolResultCount: 1,
          transcript: [],
        },
        requestCount: 2,
      }),
  });
  assertEquals(result.exit, 1);
  assertEquals(result.stdout, '');
  assertEquals(JSON.parse(result.stderr), {
    ok: false,
    outcome: 'contract_failure',
    stopReason: 'contract_failure',
    steps: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    requestCount: 2,
    error: { code: 'agent_failure', message: 'agent run failed' },
  });
  assert(!result.stderr.includes('provider-sensitive-marker'));
});
