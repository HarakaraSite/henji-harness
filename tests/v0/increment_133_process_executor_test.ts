import {
  LinuxProcessExecutor,
  runtimeProcessRunnerLaunch,
  sourceProcessRunnerLaunch,
} from '../../v0/agent/runtime/process_executor.ts';
import type { ProcessRunnerLaunch } from '../../v0/agent/runtime/process_contract.ts';

const assert = (
  condition: unknown,
  message = 'assertion failed',
): void => {
  if (!condition) throw new Error(message);
};
const equal = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};
const text = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  await new Response(stream).text();
const launch = (): ProcessRunnerLaunch => {
  const binary = Deno.env.get('HENJI_TEST_PROCESS_RUNNER');
  return binary === undefined
    ? sourceProcessRunnerLaunch()
    : runtimeProcessRunnerLaunch(binary, ['--internal-process-runner']);
};
const command = (value: string, cwd = '/tmp') => ({
  executable: '/bin/bash',
  args: ['--noprofile', '--norc', '-c', value],
  cwd,
  env: {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  },
});
const waitForFile = async (file: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    try {
      await Deno.stat(file);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('command did not reach its ready point');
};

Deno.test('process executor separates terminal, control FD, output, and command status', async () => {
  const owner = new LinuxProcessExecutor(launch());
  try {
    const operation = owner.start(command(
      'if (exec 4</dev/tty) 2>/dev/null; then printf tty-shared; else printf tty-separated; fi; ' +
        'test ! -e /proc/$$/fd/3 || printf control-inherited; printf stderr >&2; exit 143',
    ));
    equal(owner.activeOperations, 1);
    const stdout = text(operation.stdout);
    const stderr = text(operation.stderr);
    equal(await operation.status, { exitCode: 143, signal: null });
    equal(await stdout, 'tty-separated');
    equal(await stderr, 'stderr');
    await operation.closed;
    equal(owner.activeOperations, 0);
    const signalled = owner.start(command('kill -TERM $$'));
    const out = text(signalled.stdout);
    const err = text(signalled.stderr);
    equal(await signalled.status, { exitCode: null, signal: 'SIGTERM' });
    await Promise.all([out, err, signalled.closed]);
  } finally {
    await owner.close();
  }
});

Deno.test('capture cancellation drains retained background writers until natural release', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-writer-' });
  const owner = new LinuxProcessExecutor(launch());
  try {
    const operation = owner.start(command(
      '(sleep .15; head -c 1048576 /dev/zero; printf done > done) & printf ready',
      root,
    ));
    equal(await operation.status, { exitCode: 0, signal: null });
    assert(owner.activeOperations === 1);
    await Promise.all([operation.stdout.cancel(), operation.stderr.cancel()]);
    await operation.closed;
    equal(await Deno.readTextFile(`${root}/done`), 'done');
    equal(owner.activeOperations, 0);
  } finally {
    await owner.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('group stop escalates while preserving the command SIGKILL status', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-stop-' });
  const owner = new LinuxProcessExecutor(launch());
  try {
    const operation = owner.start(command(
      "trap '' TERM; printf '%s' $$ > ready; while :; do sleep 10; done",
      root,
    ));
    const stdout = text(operation.stdout);
    const stderr = text(operation.stderr);
    await waitForFile(`${root}/ready`);
    await operation.stop();
    equal(await operation.status, { exitCode: null, signal: 'SIGKILL' });
    await Promise.all([stdout, stderr, operation.closed]);
    equal(owner.activeOperations, 0);
  } finally {
    await owner.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('owner close cleans normally returned background groups', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-close-' });
  const owner = new LinuxProcessExecutor(launch());
  try {
    const operation = owner.start(
      command('sleep 30 & printf %s $! > background', root),
    );
    equal(await operation.status, { exitCode: 0, signal: null });
    const background = Number(await Deno.readTextFile(`${root}/background`));
    await owner.close();
    await operation.closed;
    equal(owner.activeOperations, 0);
    const observation = await new Deno.Command('/bin/bash', {
      args: [
        '--noprofile',
        '--norc',
        '-c',
        'if IFS= read -r stat 2>/dev/null < "/proc/$1/stat"; then ' +
        'fields=${stat##*) }; set -- $fields; printf %s "$1"; fi',
        'henji-test-process',
        String(background),
      ],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).output();
    const state = new TextDecoder().decode(observation.stdout);
    assert(state === '' || state === 'Z', 'background still live');
  } finally {
    await owner.close();
    await Deno.remove(root, { recursive: true });
  }
});
