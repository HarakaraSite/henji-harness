import { assert, assertEquals } from './test_helpers.ts';
import {
  createSessionPersistence,
  DenoSessionStore,
  selectStateRoot,
} from '../../v0/agent/session_store.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const FIXTURE = `${Deno.cwd()}/tests/v0/fixtures/session_lock_process_fixture.ts`;
const TUI_FIXTURE = `${Deno.cwd()}/tests/v0/fixtures/session_tui_process_fixture.ts`;
const transcript = [
  { role: 'user' as const, content: { kind: 'text' as const, text: 'task' } },
  { role: 'assistant' as const, content: { kind: 'text' as const, text: 'answer' } },
];

const launcherSource = await Deno.readTextFile('v0/agent/session_launcher.sh');

const launcherArgs = async (
  root: string,
  args: readonly string[],
  xdgStateHome = `${root}/xdg state `,
): Promise<readonly string[]> => {
  const fakeDeno = `${root}/fake-deno`;
  const launcher = `${root}/session-launcher.sh`;
  const capture = `${root}/argv.txt`;
  await Deno.writeTextFile(
    fakeDeno,
    '#!/bin/sh\n: > "$HENJI_LAUNCH_CAPTURE"\nfor arg in "$@"; do printf \'%s\\n\' "$arg" >> "$HENJI_LAUNCH_CAPTURE"; done\n',
  );
  await Deno.chmod(fakeDeno, 0o700);
  await Deno.writeTextFile(
    launcher,
    launcherSource.replace(
      'deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno',
      `deno=${fakeDeno}`,
    ),
  );
  const command = new Deno.Command('/bin/sh', {
    args: [launcher, ...args],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: `${root}/home`,
      XDG_STATE_HOME: xdgStateHome,
      HENJI_LAUNCH_CAPTURE: capture,
    },
    stdout: 'piped',
    stderr: 'piped',
  });
  const result = await command.output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  const captured = await Deno.readTextFile(capture);
  return captured === '' ? [] : captured.trimEnd().split('\n');
};

const expectedLauncherChildArgs = (
  root: string,
  args: readonly string[],
  xdgStateHome = `${root}/xdg state `,
): readonly string[] => {
  const persistent = !args.includes('--no-session');
  const stateRoot = `${xdgStateHome}/henji-harness`;
  return [
    'run',
    '--no-prompt',
    '--no-remote',
    '--allow-env=HENJI_OPENROUTER_API_KEY,HENJI_SESSION_STATE_ROOT',
    '--allow-net=openrouter.ai',
    '--allow-read=/',
    '--allow-write=/',
    ...(persistent ? [`--allow-read=${stateRoot}`, `--allow-write=${stateRoot}`] : []),
    '--allow-run=/bin/bash',
    `${root}/tui_cli.ts`,
    ...args,
  ];
};

Deno.test('pinned Deno process lock is nonblocking and becomes available after owner close', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-process-' });
  const workspace = `${root}/workspace`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(`${root}/state`, workspace);
  const handle = await store.allocate('default');
  const persistence = createSessionPersistence(handle, workspace, 'default');
  persistence.commit(transcript, 2, '2026-08-27T00:00:01.000Z');
  const command = new Deno.Command(DENO, {
    args: [
      'run',
      '--no-prompt',
      '--no-remote',
      `--allow-read=/tmp`,
      `--allow-write=/tmp`,
      FIXTURE,
      `${root}/state`,
      workspace,
      handle.id,
    ],
    stdout: 'piped',
    stderr: 'piped',
  });
  const child = command.output();
  const [status, stdout] = await Promise.all([
    child.then((value) => value),
    child.then((value) => new TextDecoder().decode(value.stdout)),
  ]);
  assert(!status.success);
  assertEquals(stdout.trim(), 'session_busy');
  await persistence.close();
  const reopened = await store.openExisting(handle.id);
  await reopened.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('child-process TUI empty exit removes the exact session directory and lock', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-tui-process-' });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const child = await new Deno.Command(DENO, {
    args: [
      'run',
      '--no-prompt',
      '--no-remote',
      '--allow-read=/tmp,v0',
      '--allow-write=/tmp',
      TUI_FIXTURE,
      state,
      workspace,
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assert(
    child.success,
    new TextDecoder().decode(child.stderr) || new TextDecoder().decode(child.stdout),
  );
  const store = new DenoSessionStore(state, workspace);
  const paths = await store.pathsPromise;
  assertEquals([...Deno.readDirSync(paths.sessions)].map((entry) => entry.name), []);
  assertEquals(
    [...Deno.readDirSync(paths.locks)].map((entry) => entry.name).sort(),
    ['.index.lock'],
  );
  await Deno.remove(root, { recursive: true });
});

Deno.test('launcher preserves exact child argv for every selector and flag order', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-launcher-' });
  const session = '11111111-1111-4111-8111-111111111111';
  const matrix: readonly (readonly string[])[] = [
    [],
    ['--continue'],
    ['--session', session],
    ['--no-session'],
    ['--agent', 'planner'],
    ['--agent', 'planner', '--continue'],
    ['--continue', '--agent', 'planner'],
    ['--agent', 'planner', '--session', session],
    ['--session', session, '--agent', 'planner'],
    ['--agent', 'default', '--no-session'],
    ['--no-session', '--agent', 'default'],
  ];
  for (const args of matrix) {
    assertEquals(await launcherArgs(root, args), expectedLauncherChildArgs(root, args));
  }
  const fallbackXdg = '   ';
  const fallbackRoot = `${root}/home/.local/state/henji-harness`;
  assertEquals(
    await launcherArgs(root, ['--continue'], fallbackXdg),
    expectedLauncherChildArgs(root, ['--continue'], `${root}/home/.local/state`),
  );
  assertEquals(
    selectStateRoot({ XDG_STATE_HOME: fallbackXdg, HOME: `${root}/home` }),
    fallbackRoot,
  );
  await Deno.remove(root, { recursive: true });
});
