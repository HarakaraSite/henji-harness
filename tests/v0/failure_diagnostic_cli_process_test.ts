import { assert, assertEquals } from './test_helpers.ts';
import {
  DenoFailureDiagnosticStore,
  failureDiagnosticPaths,
} from '../../v0/agent/failure_diagnostic_store.ts';
import { createFailureDiagnostic } from '../../v0/agent/failure_diagnostic.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const LAUNCHER = Deno.cwd() + '/v0/agent/failure_diagnostic_cli_launcher.sh';
const MACHINE = Deno.cwd() + '/v0/agent/henji_machine_launcher.sh';
const PROBE = Deno.cwd() +
  '/tests/v0/fixtures/failure_diagnostic_permission_probe.ts';
const decoder = new TextDecoder();
const IDS = [
  '00000000-0000-4000-8000-000000000031',
  '00000000-0000-4000-8000-000000000032',
] as const;

const runLauncher = async (
  workspace: string,
  state: string,
  args: readonly string[],
): Promise<Deno.CommandOutput> =>
  await new Deno.Command('/bin/sh', {
    args: [LAUNCHER, ...args],
    cwd: workspace,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp',
      HENJI_SESSION_STATE_ROOT: state,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output();

const runMachine = async (
  workspace: string,
  state: string,
  args: readonly string[],
): Promise<Deno.CommandOutput> =>
  await new Deno.Command('/bin/sh', {
    args: [MACHINE, ...args],
    cwd: workspace,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp',
      HENJI_SESSION_STATE_ROOT: state,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output();

const value = (id: string, occurredAt: string) =>
  createFailureDiagnostic({
    stage: 'response_parse',
    code: 'response_error',
    lane: 'parent',
    providerRequestCount: 1,
    httpStatus: 200,
    parseReason: 'invalid_sse_json',
    turnNumber: 1,
    modelStep: 1,
    occurredAt,
  }, { uuid: () => id, now: () => occurredAt });

Deno.test('diagnostic launcher provides restartable readback and exact deletion across workspaces', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-diagnostic-process-',
  });
  const workspace = root + '/workspace';
  const otherWorkspace = root + '/other-workspace';
  const state = root + '/state';
  try {
    await Deno.mkdir(workspace);
    await Deno.mkdir(otherWorkspace);
    const store = new DenoFailureDiagnosticStore(state, workspace);
    const first = value(IDS[0], '2026-09-02T00:00:00.000Z');
    const second = value(IDS[1], '2026-09-02T00:00:01.000Z');
    await store.write(first);
    await store.write(second);

    const invalid = await runLauncher(workspace, state, ['diagnostics']);
    assert(!invalid.success);
    assertEquals(
      decoder.decode(invalid.stderr),
      '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}\n',
    );
    const readList = await runLauncher(workspace, state, ['list']);
    assert(readList.success);
    assertEquals(
      decoder.decode(readList.stdout),
      JSON.stringify({ schemaVersion: 1, diagnostics: [first, second] }) + '\n',
    );
    assertEquals(decoder.decode(readList.stderr), '');
    const machineReadList = await runMachine(workspace, state, [
      'diagnostics',
      'list',
    ]);
    assert(machineReadList.success);
    assertEquals(
      decoder.decode(machineReadList.stdout),
      decoder.decode(readList.stdout),
    );
    assertEquals(decoder.decode(machineReadList.stderr), '');
    const latest = await runLauncher(workspace, state, ['latest']);
    assert(latest.success);
    assertEquals(decoder.decode(latest.stdout), JSON.stringify(second) + '\n');
    const shown = await runLauncher(workspace, state, [
      'show',
      '--id',
      first.diagnosticId,
    ]);
    assert(shown.success);
    assertEquals(decoder.decode(shown.stdout), JSON.stringify(first) + '\n');

    const other = await runLauncher(otherWorkspace, state, ['list']);
    assert(other.success);
    assertEquals(
      decoder.decode(other.stdout),
      '{"schemaVersion":1,"diagnostics":[]}\n',
    );

    const deleted = await runLauncher(workspace, state, [
      'delete',
      '--id',
      first.diagnosticId,
      '--yes',
    ]);
    assert(deleted.success, decoder.decode(deleted.stderr));
    assertEquals(
      decoder.decode(deleted.stdout),
      '{"ok":true,"deleted":"' + first.diagnosticId + '"}\n',
    );
    assertEquals(decoder.decode(deleted.stderr), '');
    const paths = await failureDiagnosticPaths(state, workspace);
    assert(
      !(await Deno.lstat(paths.diagnostics + '/' + first.diagnosticId + '.json')
        .catch(() => undefined)),
    );
    assert(
      (await Deno.lstat(
        paths.diagnostics + '/' + second.diagnosticId + '.json',
      )).isFile,
    );
    assert((await Deno.lstat(paths.diagnostics)).isDirectory);
    assert((await Deno.lstat(paths.locks)).isDirectory);

    const restarted = await runLauncher(workspace, state, [
      'show',
      '--id',
      second.diagnosticId,
    ]);
    assert(restarted.success);
    assertEquals(
      decoder.decode(restarted.stdout),
      JSON.stringify(second) + '\n',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('delete launcher grants write only to the selected record and fixed diagnostic lock', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-diagnostic-permission-',
  });
  const workspace = root + '/workspace';
  const state = root + '/state';
  try {
    await Deno.mkdir(workspace);
    const store = new DenoFailureDiagnosticStore(state, workspace);
    const selected = value(IDS[0], '2026-09-02T00:00:00.000Z');
    const sibling = value(IDS[1], '2026-09-02T00:00:01.000Z');
    await store.write(selected);
    await store.write(sibling);
    const paths = await failureDiagnosticPaths(state, workspace);
    const sessions = paths.root + '/sessions';
    const contexts = paths.root + '/contexts';
    const other = root + '/other-namespace';
    await Deno.mkdir(sessions);
    await Deno.mkdir(contexts);
    await Deno.mkdir(other);

    const probe = await new Deno.Command(DENO, {
      args: [
        'run',
        '--no-prompt',
        '--no-remote',
        '--allow-read=' + Deno.cwd(),
        '--allow-read=' + workspace,
        '--allow-read=' + paths.diagnostics,
        '--allow-read=' + paths.lock,
        '--allow-write=' + paths.diagnostics + '/' + selected.diagnosticId +
        '.json',
        '--allow-write=' + paths.lock,
        PROBE,
        paths.diagnostics + '/' + selected.diagnosticId + '.json',
        paths.lock,
        paths.diagnostics + '/' + sibling.diagnosticId + '.json',
        sessions,
        contexts,
        other,
      ],
      cwd: Deno.cwd(),
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(probe.success);
    assertEquals(JSON.parse(decoder.decode(probe.stdout)), {
      selected: true,
      lock: true,
      sibling: false,
      sessions: false,
      contexts: false,
      other: false,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
