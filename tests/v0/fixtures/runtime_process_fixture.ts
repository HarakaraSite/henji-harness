import { main } from '../../../v0/agent/runtime_cli.ts';

const DUMMY_CREDENTIAL = 'offline-dummy-credential';
const MODES = [
  'argv-success',
  'planner-argv-success',
  'argv-context-success',
  'argv-skill-success',
  'argv-filesystem-rejection-success',
  'argv-json-success',
  'argv-json-failure-recovery',
  'argv-delegation-success',
  'stdin-success',
  'planner-stdin-success',
  'runtime-failure',
  'invalid-selection',
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

const delegateToolResponse = (): Response =>
  workToolResponse('delegate_to_planner', { task: 'child planning task' }, 'delegate-1');

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
  : fixtureMode === 'planner-argv-success'
  ? 'planner argv task'
  : fixtureMode === 'argv-context-success'
  ? 'context task'
  : fixtureMode === 'argv-skill-success'
  ? 'skill task'
  : fixtureMode === 'argv-filesystem-rejection-success'
  ? 'filesystem rejection task'
  : fixtureMode === 'argv-json-success'
  ? 'json argv task'
  : fixtureMode === 'argv-json-failure-recovery'
  ? 'failure recovery task'
  : fixtureMode === 'argv-delegation-success'
  ? 'delegation task'
  : fixtureMode === 'stdin-success'
  ? 'piped task'
  : fixtureMode === 'planner-stdin-success'
  ? 'planner piped task'
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
  const messages = typeof body === 'object' && body !== null &&
      Array.isArray((body as { messages?: unknown }).messages)
    ? (body as { messages: unknown[] }).messages
    : undefined;
  if (!messages || messages.length === 0) {
    throw new Error('provider request task mismatch');
  }
  if (fixtureMode === 'argv-delegation-success') {
    const serialized = JSON.stringify(body);
    if (requestCount === 1) {
      if (
        JSON.stringify(messages[0]) !== JSON.stringify({ role: 'user', content: expectedTask }) ||
        !serialized.includes('delegate_to_planner')
      ) throw new Error('parent delegation request mismatch');
      return Promise.resolve(delegateToolResponse());
    }
    if (requestCount === 2) {
      const tools = (body as { tools?: unknown }).tools;
      if (
        !Array.isArray(tools) ||
        tools.map((tool) =>
            typeof tool === 'object' && tool !== null &&
              typeof (tool as { function?: unknown }).function === 'object'
              ? ((tool as { function: { name?: unknown } }).function.name)
              : undefined
          ).join(',') !== 'read,submit_json_result' ||
        !serialized.includes('child planning task') ||
        serialized.includes('delegate_to_planner') || serialized.includes('parent delegation')
      ) throw new Error('child delegation request mismatch');
      return Promise.resolve(response('child plan'));
    }
    if (requestCount === 3) {
      if (
        JSON.stringify(messages[0]) !== JSON.stringify({ role: 'user', content: expectedTask }) ||
        !toolResultTexts(body as Record<string, unknown>).some((text) =>
          text ===
            '{"ok":true,"agent":"planner","output":{"kind":"text","text":"child plan"},"usage":{"modelRequests":1,"externalRequests":1}}'
        )
      ) throw new Error('parent delegation result mismatch');
      return Promise.resolve(response('parent answer'));
    }
    throw new Error('delegation request sequence exceeded');
  }
  if (fixtureMode === 'argv-skill-success') {
    const serialized = JSON.stringify(body);
    if (requestCount === 1) {
      if (
        !serialized.includes('Available project skills.') ||
        !serialized.includes('./.claude/skills/process-skill') ||
        serialized.includes('PROCESS-SKILL-BODY') ||
        serialized.includes('HIGH-PRIORITY-SKILL-BODY') ||
        serialized.includes(workspaceOption ?? 'WORKSPACE-UNAVAILABLE')
      ) throw new Error('provider request skill manifest mismatch');
      const tools = (body as { tools?: unknown }).tools;
      if (
        !Array.isArray(tools) ||
        tools.map((tool) =>
            typeof tool === 'object' && tool !== null &&
              typeof (tool as { function?: unknown }).function === 'object'
              ? ((tool as { function: { name?: unknown } }).function.name)
              : undefined
          ).join(',') !== 'bash,delegate_to_planner,edit,read,skill,submit_json_result,write'
      ) throw new Error('provider request skill tool topology mismatch');
    } else if (requestCount === 2) {
      if (
        !serialized.includes('PROCESS-SKILL-BODY') || serialized.includes(workspaceOption ?? '')
      ) {
        throw new Error('provider request skill result mismatch');
      }
    } else throw new Error('provider request exceeded skill sequence');
  } else if (fixtureMode === 'planner-argv-success' || fixtureMode === 'planner-stdin-success') {
    const serialized = JSON.stringify(body);
    const systemMessages = messages.filter((message) =>
      typeof message === 'object' && message !== null &&
      (message as { role?: unknown }).role === 'system'
    );
    const tools = (body as { tools?: unknown }).tools;
    if (
      requestCount !== 1 || systemMessages.length !== 1 ||
      !(systemMessages[0] as { content?: unknown }).content?.toString().endsWith(
        'You are the built-in planner agent. Inspect the available workspace context needed for the task and produce a clear implementation plan. Do not mutate the workspace.',
      ) ||
      !Array.isArray(tools) ||
      tools.map((tool) =>
          typeof tool === 'object' && tool !== null &&
            typeof (tool as { function?: unknown }).function === 'object'
            ? ((tool as { function: { name?: unknown } }).function.name)
            : undefined
        ).join(',') !== 'read,submit_json_result' ||
      serialized.includes('name":"bash') || serialized.includes('name":"edit') ||
      serialized.includes('name":"write')
    ) throw new Error('planner provider request mismatch');
  } else if (fixtureMode === 'argv-context-success') {
    const systemMessages = messages.filter((message) =>
      typeof message === 'object' && message !== null &&
      (message as { role?: unknown }).role === 'system'
    );
    if (
      systemMessages.length !== 1 ||
      JSON.stringify(messages[0]) !== JSON.stringify({
          role: 'system',
          content:
            'Project context instructions loaded from AGENTS.md. Follow them when working in this workspace.\n\n## ./AGENTS.md\n\nprocess instructions',
        }) ||
      JSON.stringify(messages[1]) !== JSON.stringify({ role: 'user', content: expectedTask })
    ) throw new Error('provider request context mismatch');
  } else if (fixtureMode === 'argv-filesystem-rejection-success') {
    if (
      messages.length !== 1 ||
      JSON.stringify(messages[0]) !== JSON.stringify({
          role: 'user',
          content: expectedTask,
        })
    ) throw new Error('provider request unexpectedly contained system context');
    const serialized = JSON.stringify(body);
    for (
      const marker of [
        'PARENT-INSTRUCTION-MARKER',
        'SIBLING-INSTRUCTION-MARKER',
        'SYMLINK-TARGET-MARKER',
        'UPPERCASE-FALLBACK-MARKER',
      ]
    ) {
      if (serialized.includes(marker)) throw new Error('instruction marker leaked to provider');
    }
  } else if (
    typeof (messages[0] as { content?: unknown })?.content !== 'string' ||
    (messages[0] as { content: string }).content !== expectedTask
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
  if (fixtureMode === 'argv-context-success') {
    return Promise.resolve(response('context answer'));
  }
  if (fixtureMode === 'argv-skill-success') {
    return requestCount === 1
      ? Promise.resolve(workToolResponse('skill', { name: 'process-skill' }, 'skill-1'))
      : Promise.resolve(response('skill answer'));
  }
  if (fixtureMode === 'argv-filesystem-rejection-success') {
    return Promise.resolve(response('filesystem answer'));
  }
  if (fixtureMode === 'planner-argv-success' || fixtureMode === 'planner-stdin-success') {
    return Promise.resolve(response('planner answer'));
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

const stdinIsTerminal = fixtureMode !== 'stdin-success' && fixtureMode !== 'planner-stdin-success';
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
  if (fixtureMode === 'argv-filesystem-rejection-success') {
    const setup = await new Deno.Command('/bin/bash', {
      args: [
        '--noprofile',
        '--norc',
        '-c',
        'printf SYMLINK-TARGET-MARKER > symlink-target.txt; ln -s symlink-target.txt AGENTS.md',
      ],
      cwd: workspaceRoot,
      clearEnv: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdout: 'null',
      stderr: 'null',
    }).output();
    if (!setup.success) throw new Error('filesystem rejection workspace setup failed');
    await Deno.writeTextFile(`${workspaceRoot}/AGENTS.MD`, 'UPPERCASE-FALLBACK-MARKER');
  }
  if (fixtureMode === 'argv-context-success') {
    await Deno.writeTextFile(`${workspaceRoot}/AGENTS.md`, 'process instructions\n');
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
