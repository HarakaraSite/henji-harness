import { assert, assertEquals } from './test_helpers.ts';

const DENO_COMMAND = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const ROOT = Deno.cwd();
const FIXTURE = `${ROOT}/tests/v0/fixtures/runtime_process_fixture.ts`;
const OUTPUT_LIMIT = 16 * 1024;
const DEADLINE_MS = 2_000;
const SAFETY_DEADLINE_MS = 100;
const SAFETY_MAX_DURATION_MS = 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type FixtureMode =
  | 'argv-success'
  | 'planner-argv-success'
  | 'argv-context-success'
  | 'argv-skill-success'
  | 'argv-filesystem-rejection-success'
  | 'argv-json-success'
  | 'argv-json-failure-recovery'
  | 'argv-delegation-success'
  | 'stdin-success'
  | 'planner-stdin-success'
  | 'runtime-failure'
  | 'invalid-selection'
  | 'tty';

interface CapturedOutput {
  readonly text: string;
  readonly overflow: boolean;
}

interface ProcessResult {
  readonly status: Deno.CommandStatus;
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
  readonly killed: boolean;
  readonly durationMs: number;
  readonly argv: readonly string[];
  readonly workspaceRoot?: string;
}

interface ProcessOptions {
  readonly retainWorkspace?: boolean;
}

interface ChildInvocation {
  readonly argv: readonly string[];
  readonly clearEnv: true;
  readonly env: Record<string, never>;
  readonly ambientPermissions: readonly [];
}

const childInvocation = (
  mode: FixtureMode,
  applicationArgs: readonly string[] = [],
  workspaceRoot = '/tmp',
): ChildInvocation => ({
  argv: [
    'run',
    '--no-prompt',
    '--no-remote',
    `--allow-read=${workspaceRoot}`,
    `--allow-write=${workspaceRoot}`,
    '--allow-run=/bin/bash',
    FIXTURE,
    mode,
    '--workspace-root',
    workspaceRoot,
    ...applicationArgs,
  ],
  clearEnv: true,
  env: {},
  ambientPermissions: [],
});

const capture = async (
  stream: ReadableStream<Uint8Array>,
  stop: () => void,
): Promise<CapturedOutput> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (total + item.value.byteLength > OUTPUT_LIMIT) {
        overflow = true;
        stop();
        break;
      }
      chunks.push(item.value);
      total += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: decoder.decode(bytes), overflow };
};

const runRawProcess = async (
  argv: readonly string[],
  stdin: Uint8Array | undefined = undefined,
  deadlineMs = DEADLINE_MS,
): Promise<ProcessResult> => {
  const child = new Deno.Command(DENO_COMMAND, {
    args: [...argv],
    cwd: ROOT,
    clearEnv: true,
    env: {},
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let killed = false;
  const stop = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited between capture and kill.
    }
  };
  const started = performance.now();
  const timer = setTimeout(stop, deadlineMs);
  const stdout = capture(child.stdout, stop);
  const stderr = capture(child.stderr, stop);
  const writer = child.stdin.getWriter();
  try {
    if (stdin !== undefined) await writer.write(stdin);
    await writer.close();
  } catch {
    stop();
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // The child may have closed stdin while the parent was writing.
    }
  }
  const [status, capturedStdout, capturedStderr] = await Promise.all([
    child.status,
    stdout,
    stderr,
  ]);
  clearTimeout(timer);
  return {
    status,
    stdout: capturedStdout,
    stderr: capturedStderr,
    killed,
    durationMs: performance.now() - started,
    argv,
  };
};

const runProcess = async (
  mode: FixtureMode,
  applicationArgs: readonly string[] = [],
  stdin: Uint8Array | undefined = undefined,
  options: ProcessOptions = {},
): Promise<ProcessResult> => {
  const workspaceRoot = await Deno.makeTempDir({ prefix: 'henji-process-parent-' });
  const cleanup = async (): Promise<void> => {
    try {
      await Deno.remove(workspaceRoot, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  try {
    const invocation = childInvocation(mode, applicationArgs, workspaceRoot);
    const result = await runRawProcess(invocation.argv, stdin);
    if (options.retainWorkspace) return { ...result, workspaceRoot };
    await cleanup();
    return result;
  } catch (error) {
    await cleanup();
    throw error;
  }
};

const runProcessWithDisposableLayout = async (
  mode: FixtureMode,
  applicationArgs: readonly string[],
  setup: (containerRoot: string, workspaceRoot: string) => Promise<void>,
): Promise<ProcessResult> => {
  const containerRoot = await Deno.makeTempDir({ prefix: 'henji-process-layout-' });
  const workspaceRoot = `${containerRoot}/workspace`;
  await Deno.mkdir(workspaceRoot);
  try {
    await setup(containerRoot, workspaceRoot);
    return await runRawProcess(
      childInvocation(mode, applicationArgs, workspaceRoot).argv,
    );
  } finally {
    await Deno.remove(containerRoot, { recursive: true });
  }
};

const createActualSymlink = async (target: string, link: string): Promise<void> => {
  const command = new Deno.Command(DENO_COMMAND, {
    args: [
      'eval',
      '--no-remote',
      'await Deno.symlink(Deno.args[0], Deno.args[1]);',
      '--',
      target,
      link,
    ],
    clearEnv: true,
    env: {},
    stdin: 'null',
    stdout: 'null',
    stderr: 'piped',
  });
  const output = await command.output();
  if (!output.success) throw new Error('symlink setup child failed');
};

const expectedFailure = {
  ok: false,
  outcome: 'contract_failure',
  stopReason: 'contract_failure',
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  requestCount: 0,
  error: { code: 'invalid_input', message: 'invalid agent invocation' },
};

const parseFailure = (
  text: string,
  expected: Record<string, unknown>,
): Record<string, unknown> => {
  assert(text.endsWith('\n'));
  assertEquals(text.indexOf('\n'), text.length - 1);
  assertEquals(text, `${JSON.stringify(expected)}\n`);
  return JSON.parse(text.slice(0, -1)) as Record<string, unknown>;
};

const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
  tasks: Record<string, string>;
};
const productionTasks = {
  run:
    '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=. --allow-write=. --allow-run=/bin/bash v0/agent/runtime_cli.ts',
  acceptance:
    '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai v0/agent/real_provider_acceptance.ts',
};

Deno.test('offline process topology keeps child isolated and production tasks untouched', () => {
  assertEquals(config.tasks['agent:run'], productionTasks.run);
  assertEquals(config.tasks['agent:acceptance'], productionTasks.acceptance);
  const focusedTask = `${DENO_COMMAND} task --config deno.v0.json agent:runtime:process:test`;
  assertEquals(
    config.tasks['agent:runtime:process:test'],
    `${DENO_COMMAND} test --no-prompt --allow-run=${DENO_COMMAND} --allow-read=deno.v0.json,/tmp --allow-write=/tmp tests/v0/agent_runtime_process_test.ts`,
  );
  const selectionTask =
    `${DENO_COMMAND} task --config deno.v0.json agent:definition-selection:test`;
  assertEquals(
    config.tasks['agent:definition-selection:test'],
    `${DENO_COMMAND} test --no-prompt tests/v0/agent_catalog_test.ts`,
  );
  const gate = config.tasks['v0:gate'];
  const test = config.tasks['v0:test'];
  assert(typeof gate === 'string');
  const gateSegments = gate.split(' && ');
  const testSegments = test.split(' && ');
  assertEquals(
    gateSegments.filter((segment) =>
      segment === `${DENO_COMMAND} task --config deno.v0.json v0:test`
    ).length,
    1,
  );
  assertEquals(testSegments.filter((segment) => segment === focusedTask).length, 1);
  assertEquals(testSegments.filter((segment) => segment === selectionTask).length, 1);
  for (const segments of [gateSegments, testSegments]) {
    const taskNames = segments.flatMap((segment) => {
      const tokens = segment.split(/\s+/);
      return tokens.length === 5 && tokens[0] === DENO_COMMAND && tokens[1] === 'task' &&
          tokens[2] === '--config' && tokens[3] === 'deno.v0.json'
        ? [tokens[4]]
        : [];
    });
    assertEquals(taskNames.filter((name) => name === 'agent:run'), []);
    assertEquals(taskNames.filter((name) => name === 'agent:acceptance'), []);
    assertEquals(taskNames.filter((name) => name.includes('credential-file')), []);
  }
  const invocation = childInvocation('argv-success', ['--task', '  argv task  ']);
  const argv = invocation.argv;
  assertEquals(argv.slice(0, 3), ['run', '--no-prompt', '--no-remote']);
  assertEquals(argv.slice(3, 6), [
    '--allow-read=/tmp',
    '--allow-write=/tmp',
    '--allow-run=/bin/bash',
  ]);
  assertEquals(invocation.clearEnv, true);
  assertEquals(invocation.env, {});
  assertEquals(invocation.ambientPermissions, []);
});

Deno.test('offline argv process uses actual argv and captures final-only output', async () => {
  const result = await runProcess('argv-success', ['--task', '  argv task  ']);
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, 'offline argv answer\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assert(result.durationMs < DEADLINE_MS);
  assertEquals(result.argv.slice(-2), ['--task', '  argv task  ']);
  assert(result.argv.includes('--workspace-root'));
});

Deno.test('offline planner argv process selects the planner capability registry', async () => {
  const result = await runProcess(
    'planner-argv-success',
    ['--agent', 'planner', '--task', '  planner argv task  '],
  );
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, 'planner answer\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assert(result.durationMs < DEADLINE_MS);
});

Deno.test('offline process loads a workspace instruction as system context', async () => {
  const result = await runProcess('argv-context-success', ['--task', '  context task  ']);
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, 'context answer\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assert(result.durationMs < DEADLINE_MS);
});

Deno.test('offline process loads a project skill on demand and exits naturally', async () => {
  const result = await runProcessWithDisposableLayout(
    'argv-skill-success',
    ['--task', '  skill task  '],
    async (containerRoot, workspaceRoot) => {
      await Deno.mkdir(`${workspaceRoot}/.zot/skills`, { recursive: true });
      await Deno.mkdir(`${containerRoot}/symlink-skill`);
      await Deno.writeTextFile(
        `${containerRoot}/symlink-skill/SKILL.md`,
        '---\ndescription: Must be skipped.\n---\nHIGH-PRIORITY-SKILL-BODY',
      );
      await createActualSymlink(
        `${containerRoot}/symlink-skill`,
        `${workspaceRoot}/.zot/skills/process-skill`,
      );
      await Deno.mkdir(`${workspaceRoot}/.claude/skills/process-skill`, { recursive: true });
      await Deno.writeTextFile(
        `${workspaceRoot}/.claude/skills/process-skill/SKILL.md`,
        '---\ndescription: Process skill.\n---\nPROCESS-SKILL-BODY',
      );
    },
  );
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, 'skill answer\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assert(result.durationMs < DEADLINE_MS);
});

Deno.test('offline process skips symlink context and keeps parent/sibling markers invisible', async () => {
  const result = await runProcessWithDisposableLayout(
    'argv-filesystem-rejection-success',
    ['--task', '  filesystem rejection task  '],
    async (containerRoot, _workspaceRoot) => {
      await Deno.writeTextFile(`${containerRoot}/AGENTS.md`, 'PARENT-INSTRUCTION-MARKER');
      await Deno.mkdir(`${containerRoot}/sibling`);
      await Deno.writeTextFile(
        `${containerRoot}/sibling/AGENTS.md`,
        'SIBLING-INSTRUCTION-MARKER',
      );
    },
  );
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, 'filesystem answer\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assert(result.durationMs < DEADLINE_MS);
});

Deno.test('offline piped process sends stdin bytes and captures final-only output', async () => {
  const result = await runProcess('stdin-success', [], encoder.encode('  piped task\n'));
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, 'offline stdin answer\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assert(result.durationMs < DEADLINE_MS);
});

Deno.test('offline planner piped process resolves before reading stdin and runs once', async () => {
  const result = await runProcess(
    'planner-stdin-success',
    ['--agent', 'planner'],
    encoder.encode('  planner piped task\n'),
  );
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, 'planner answer\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assert(result.durationMs < DEADLINE_MS);
});

Deno.test('offline argv process prints canonical JSON submitted by the terminal tool', async () => {
  const result = await runProcess(
    'argv-json-success',
    ['--task', '  json argv task  '],
    undefined,
    {
      retainWorkspace: true,
    },
  );
  assert(result.workspaceRoot !== undefined);
  try {
    assert(result.status.success);
    assertEquals(result.status.code, 0);
    assertEquals(result.stdout.text, '{"ok":true,"items":[1,2]}\n');
    assertEquals(result.stderr.text, '');
    assert(!result.killed);
    assert(!result.stdout.overflow && !result.stderr.overflow);
    assert(result.durationMs < DEADLINE_MS);
    assertEquals(await Deno.readTextFile(`${result.workspaceRoot}/process.txt`), 'two');
  } finally {
    await Deno.remove(result.workspaceRoot, { recursive: true });
  }
});

Deno.test('offline process validates rejection recovery and bounded Bash timeout', async () => {
  const result = await runProcess(
    'argv-json-failure-recovery',
    ['--task', '  failure recovery task  '],
  );
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, '{"ok":true,"recovered":true}\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(result.durationMs < 1_500);
  assert(!result.stdout.overflow && !result.stderr.overflow);
});

Deno.test('offline process runs one bounded synchronous planner delegation', async () => {
  const result = await runProcess(
    'argv-delegation-success',
    ['--task', '  delegation task  '],
  );
  assert(result.status.success);
  assertEquals(result.status.code, 0);
  assertEquals(result.stdout.text, 'parent answer\n');
  assertEquals(result.stderr.text, '');
  assert(!result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assert(result.durationMs < DEADLINE_MS);
});

Deno.test('offline preflight failure never reaches the fake provider', async () => {
  const result = await runProcess('tty', ['--unknown']);
  assert(!result.status.success);
  assertEquals(result.status.code, 1);
  assertEquals(result.stdout.text, '');
  assertEquals(parseFailure(result.stderr.text, expectedFailure), expectedFailure);
  assert(!result.stderr.text.includes('sensitive-marker'));
  assert(!result.killed);
});

Deno.test('offline invalid agent selection is sanitized before fake provider or stdin use', async () => {
  const result = await runProcess('invalid-selection', ['--agent', 'unknown', '--task', 'valid']);
  assert(!result.status.success);
  assertEquals(result.status.code, 1);
  assertEquals(result.stdout.text, '');
  assertEquals(parseFailure(result.stderr.text, expectedFailure), expectedFailure);
  assert(!result.stderr.text.includes('sensitive-marker'));
  assert(!result.killed);
});

Deno.test('offline runtime failure is sanitized at the process boundary', async () => {
  const result = await runProcess('runtime-failure', ['--task', 'valid']);
  assert(!result.status.success);
  assertEquals(result.status.code, 1);
  assertEquals(result.stdout.text, '');
  const expected = {
    ...expectedFailure,
    steps: 1,
    requestCount: 1,
    error: { code: 'agent_failure', message: 'agent run failed' },
  };
  assertEquals(parseFailure(result.stderr.text, expected), expected);
  assert(!result.stderr.text.includes('sensitive-marker-provider-body'));
  assert(!result.killed);
});

Deno.test('terminal no-task process exits naturally before the hard deadline', async () => {
  const result = await runProcess('tty');
  assert(!result.status.success);
  assertEquals(result.status.code, 1);
  assertEquals(result.stdout.text, '');
  assertEquals(parseFailure(result.stderr.text, expectedFailure), expectedFailure);
  assert(!result.killed);
  assert(result.durationMs < DEADLINE_MS);
});

Deno.test('process harness timeout kills and reaps a permission-free run child', async () => {
  const result = await runRawProcess(
    [
      'run',
      '--no-prompt',
      '--no-remote',
      '-',
    ],
    encoder.encode('setInterval(() => {}, 1000); await new Promise(() => {});'),
    SAFETY_DEADLINE_MS,
  );
  assert(!result.status.success);
  assert(result.killed);
  assert(!result.stdout.overflow && !result.stderr.overflow);
  assertEquals(result.stdout.text, '');
  assertEquals(result.stderr.text, '');
  assert(result.durationMs < SAFETY_MAX_DURATION_MS);
  assert(result.argv.includes('--no-remote'));
  assert(!result.argv.some((item) => item.startsWith('--allow-')));
});

Deno.test('process harness stdout overflow kills and reaps the child', async () => {
  const result = await runRawProcess(
    [
      'run',
      '--no-prompt',
      '--no-remote',
      '-',
    ],
    encoder.encode(
      `setInterval(() => {}, 1000); await Deno.stdout.write(new Uint8Array(${
        OUTPUT_LIMIT + 1
      })); await new Promise(() => {});`,
    ),
    SAFETY_DEADLINE_MS,
  );
  assert(!result.status.success);
  assert(result.killed);
  assert(result.stdout.overflow);
  assert(!result.stderr.overflow);
  assert(result.durationMs < SAFETY_MAX_DURATION_MS);
  assert(!result.argv.some((item) => item.startsWith('--allow-')));
});

Deno.test('process harness stderr overflow kills and reaps the child', async () => {
  const result = await runRawProcess(
    [
      'run',
      '--no-prompt',
      '--no-remote',
      '-',
    ],
    encoder.encode(
      `setInterval(() => {}, 1000); await Deno.stderr.write(new Uint8Array(${
        OUTPUT_LIMIT + 1
      })); await new Promise(() => {});`,
    ),
    SAFETY_DEADLINE_MS,
  );
  assert(!result.status.success);
  assert(result.killed);
  assert(!result.stdout.overflow);
  assert(result.stderr.overflow);
  assert(result.durationMs < SAFETY_MAX_DURATION_MS);
  assert(!result.argv.some((item) => item.startsWith('--allow-')));
});
