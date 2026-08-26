import { main } from '../../../v0/agent/runtime_cli.ts';

const DUMMY_CREDENTIAL = 'offline-dummy-credential';
const MODES = [
  'argv-success',
  'argv-json-success',
  'argv-json-failure-recovery',
  'stdin-success',
  'runtime-failure',
  'tty',
] as const;
type FixtureMode = (typeof MODES)[number];

const response = (text: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const jsonToolResponse = (json: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'submit-1',
            type: 'function',
            function: { name: 'submit_json_result', arguments: JSON.stringify({ json }) },
          }],
        },
      }],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );

const workToolResponse = (name: string, argumentsValue: unknown, id: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(argumentsValue) },
          }],
        },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const mode = Deno.args[0] as string | undefined;
if (!mode || !MODES.includes(mode as FixtureMode)) {
  throw new Error('invalid runtime process fixture mode');
}

const fixtureMode = mode as FixtureMode;
const rawApplicationArgs = Deno.args.slice(1);
const workspaceOption = rawApplicationArgs[0] === '--workspace-root'
  ? rawApplicationArgs[1]
  : undefined;
if (rawApplicationArgs[0] === '--workspace-root' && workspaceOption === undefined) {
  throw new Error('missing runtime process workspace');
}
const applicationArgs = workspaceOption === undefined
  ? rawApplicationArgs
  : rawApplicationArgs.slice(2);
const expectedTask = fixtureMode === 'argv-success'
  ? 'argv task'
  : fixtureMode === 'argv-json-success'
  ? 'json argv task'
  : fixtureMode === 'argv-json-failure-recovery'
  ? 'failure recovery task'
  : fixtureMode === 'stdin-success'
  ? 'piped task'
  : fixtureMode === 'runtime-failure'
  ? 'valid'
  : undefined;

let requestCount = 0;
const toolResultTexts = (body: Record<string, unknown>): string[] => {
  const messages = body.messages;
  if (!Array.isArray(messages)) throw new Error('provider request messages invalid');
  return messages.flatMap((message) => {
    if (
      typeof message === 'object' && message !== null &&
      (message as { role?: unknown }).role === 'tool' &&
      typeof (message as { content?: unknown }).content === 'string'
    ) return [(message as { content: string }).content];
    return [];
  });
};
const expectToolResults = (body: Record<string, unknown>, expected: readonly string[]): void => {
  const actual = toolResultTexts(body);
  if (actual.length !== expected.length || actual.some((text, index) => text !== expected[index])) {
    throw new Error('provider request did not contain expected prior tool results');
  }
};
const expectBashTimeout = (text: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('bash timeout result was not JSON');
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { timedOut?: unknown }).timedOut !== true ||
    ((parsed as { signal?: unknown }).signal === null &&
      (parsed as { exitCode?: unknown }).exitCode === null)
  ) throw new Error('bash timeout result was not bounded and reaped');
};
const fakeFetch: typeof fetch = (_input, init) => {
  requestCount += 1;
  if (expectedTask === undefined) throw new Error('unexpected provider request');
  if (typeof init?.body !== 'string') throw new Error('provider request body missing');
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    throw new Error('provider request body invalid');
  }
  if (
    typeof body !== 'object' || body === null ||
    !Array.isArray((body as { messages?: unknown }).messages) ||
    (body as { messages: unknown[] }).messages.length === 0 ||
    typeof (body as { messages: [{ content?: unknown }] }).messages[0]?.content !== 'string' ||
    (body as { messages: [{ content: string }] }).messages[0].content !== expectedTask
  ) {
    throw new Error('provider request task mismatch');
  }
  if (fixtureMode === 'argv-json-success' || fixtureMode === 'argv-json-failure-recovery') {
    const typedBody = body as Record<string, unknown>;
    const priorResults = toolResultTexts(typedBody);
    if (requestCount === 1 && priorResults.length !== 0) {
      throw new Error('first provider request unexpectedly contained tool results');
    }
    if (fixtureMode === 'argv-json-success') {
      if (requestCount === 2) {
        expectToolResults(typedBody, ['{"path":"process.txt","bytes":3}']);
      } else if (requestCount === 3) {
        expectToolResults(typedBody, [
          '{"path":"process.txt","bytes":3}',
          'one',
        ]);
      } else if (requestCount === 4) {
        expectToolResults(typedBody, [
          '{"path":"process.txt","bytes":3}',
          'one',
          '{"path":"process.txt","edits":1,"bytes":3}',
        ]);
      } else if (requestCount === 5) {
        const expected = [
          '{"path":"process.txt","bytes":3}',
          'one',
          '{"path":"process.txt","edits":1,"bytes":3}',
        ];
        if (
          priorResults.length !== 4 ||
          priorResults.slice(0, 3).some((text, index) => text !== expected[index])
        ) throw new Error('provider request did not contain expected prior work results');
        let bashResult: unknown;
        try {
          bashResult = JSON.parse(priorResults[3]);
        } catch {
          throw new Error('bash result was not JSON');
        }
        if (
          typeof bashResult !== 'object' || bashResult === null ||
          (bashResult as { stdout?: unknown }).stdout !== 'two' ||
          (bashResult as { stderr?: unknown }).stderr !== 'err' ||
          (bashResult as { exitCode?: unknown }).exitCode !== 0 ||
          (bashResult as { signal?: unknown }).signal !== null ||
          (bashResult as { timedOut?: unknown }).timedOut !== false
        ) throw new Error('provider request did not contain expected bash result');
      } else if (requestCount > 5) {
        throw new Error('provider request exceeded successful process sequence');
      }
    } else if (requestCount === 2) {
      if (
        priorResults.length !== 3 ||
        priorResults[0] !== 'invalid arguments: path must stay within workspace' ||
        priorResults[1] !== 'invalid arguments: path must not contain a symlink'
      ) throw new Error('provider request did not contain expected rejection results');
      expectBashTimeout(priorResults[2]);
    } else if (requestCount > 2) {
      throw new Error('provider request exceeded failure recovery sequence');
    }
  }
  if (fixtureMode === 'runtime-failure') {
    return Promise.reject(new Error('sensitive-marker-provider-body'));
  }
  if (fixtureMode === 'argv-json-success') {
    if (requestCount === 1) {
      return Promise.resolve(
        workToolResponse('write', { path: 'process.txt', content: 'one' }, 'write-1'),
      );
    }
    if (requestCount === 2) {
      return Promise.resolve(workToolResponse('read', { path: 'process.txt' }, 'read-1'));
    }
    if (requestCount === 3) {
      return Promise.resolve(
        workToolResponse('edit', {
          path: 'process.txt',
          edits: [{ oldText: 'one', newText: 'two' }],
        }, 'edit-1'),
      );
    }
    if (requestCount === 4) {
      return Promise.resolve(
        workToolResponse('bash', { command: 'cat process.txt; printf err >&2' }, 'bash-1'),
      );
    }
    return Promise.resolve(jsonToolResponse('{"ok":true,"items":[1,2]}'));
  }
  if (fixtureMode === 'argv-json-failure-recovery') {
    if (requestCount === 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'bad-traversal',
                    type: 'function',
                    function: { name: 'read', arguments: JSON.stringify({ path: '../outside' }) },
                  },
                  {
                    id: 'bad-symlink',
                    type: 'function',
                    function: { name: 'read', arguments: JSON.stringify({ path: 'link.txt' }) },
                  },
                  {
                    id: 'timeout',
                    type: 'function',
                    function: {
                      name: 'bash',
                      arguments: JSON.stringify({ command: 'sleep 2 & wait', timeoutMs: 25 }),
                    },
                  },
                ],
              },
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    if (requestCount === 2) {
      return Promise.resolve(jsonToolResponse('{"ok":true,"recovered":true}'));
    }
    throw new Error('unexpected failure recovery request');
  }
  const finalText = fixtureMode === 'argv-success' ? 'offline argv answer' : 'offline stdin answer';
  return Promise.resolve(response(finalText));
};

const stdinIsTerminal = fixtureMode !== 'stdin-success';
const workspaceRoot = workspaceOption ?? await Deno.makeTempDir({ prefix: 'henji-process-work-' });
const ownsWorkspace = workspaceOption === undefined;
try {
  if (fixtureMode === 'argv-json-failure-recovery') {
    const setup = await new Deno.Command('/bin/bash', {
      args: [
        '--noprofile',
        '--norc',
        '-c',
        'printf target > target.txt; ln -s target.txt link.txt',
      ],
      cwd: workspaceRoot,
      clearEnv: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdout: 'null',
      stderr: 'null',
    }).output();
    if (!setup.success) throw new Error('failure recovery workspace setup failed');
  }
  const exit = await main(applicationArgs, {
    stdinIsTerminal: () => stdinIsTerminal,
    runtimeSeam: {
      credential: DUMMY_CREDENTIAL,
      fetcher: fakeFetch,
      workspaceRoot,
    },
  });
  Deno.exitCode = exit;
} finally {
  if (ownsWorkspace) await Deno.remove(workspaceRoot, { recursive: true });
}
