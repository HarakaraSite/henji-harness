import { assert, assertEquals } from './test_helpers.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
  tasks: Record<string, string>;
};
const cli = await Deno.readTextFile('v0/agent/failure_diagnostic_cli.ts');
const launcher = await Deno.readTextFile(
  'v0/agent/failure_diagnostic_cli_launcher.sh',
);
const machine = await Deno.readTextFile('v0/agent/henji_machine_launcher.sh');

Deno.test('diagnostic CLI tasks and launchers keep the exact read/delete capability split', () => {
  const direct = `${DENO} task --config deno.v0.json agent:failure-diagnostic-cli:test`;
  const process = `${DENO} task --config deno.v0.json agent:failure-diagnostic-cli:process:test`;
  const topology = `${DENO} task --config deno.v0.json agent:failure-diagnostic-cli:topology:test`;
  assertEquals(
    config.tasks['agent:failure-diagnostic-cli:test'],
    `${DENO} test --no-prompt --allow-read=/tmp --allow-write=/tmp --allow-env=HENJI_SESSION_STATE_ROOT,XDG_STATE_HOME,HOME --allow-sys=uid tests/v0/failure_diagnostic_cli_test.ts`,
  );
  assertEquals(
    config.tasks['agent:failure-diagnostic-cli:process:test'],
    `${DENO} test --no-prompt --allow-read=.,/tmp --allow-write=/tmp --allow-run=/bin/sh,${DENO} --allow-sys=uid tests/v0/failure_diagnostic_cli_process_test.ts`,
  );
  assertEquals(
    config.tasks['agent:failure-diagnostic-cli:topology:test'],
    `${DENO} test --no-prompt --allow-read=deno.v0.json,v0/agent tests/v0/failure_diagnostic_cli_topology_test.ts`,
  );
  const test = config.tasks['v0:test'];
  const gate = config.tasks['v0:gate'];
  const testSegments = test.split(' && ');
  assertEquals(testSegments.filter((segment) => segment === direct).length, 1);
  assertEquals(testSegments.filter((segment) => segment === process).length, 1);
  assertEquals(
    testSegments.filter((segment) => segment === topology).length,
    1,
  );
  assertEquals(
    gate.split(' && ').filter((segment) => segment === `${DENO} task --config deno.v0.json v0:test`)
      .length,
    1,
  );
  assert(launcher.includes('failure_diagnostic_cli.ts'));
  assert(launcher.includes('--allow-read="$repo_root"'));
  assert(launcher.includes('--allow-read="$workspace"'));
  assert(launcher.includes('--allow-read="$state_root"'));
  assert(launcher.includes('--allow-write="$selected_path"'));
  assert(launcher.includes('--allow-write="$lock_path"'));
  assert(launcher.includes('--allow-read="$locks_dir"'));
  assert(!launcher.includes('--allow-net'));
  assert(!launcher.includes('--allow-run'));
  assert(!launcher.includes('openrouter-api-key'));
  assert(launcher.includes('diagnostics_dir=$state_root/$digest/diagnostics'));
  assert(
    launcher.includes('lock_path=$state_root/$digest/locks/.diagnostics.lock'),
  );
  assert(launcher.includes('selected_path=$diagnostics_dir/$3.json'));
  assert(machine.includes('if [ "${1-}" = \'diagnostics\' ]; then'));
  assert(machine.includes('exec "$diagnostic_launcher" "$@"'));
  assert(machine.includes('exec "$session_launcher" "$@"'));
});

Deno.test('diagnostic readback stays outside provider, runtime, session, and TUI import graphs', () => {
  assert(!cli.includes('openrouter'));
  assert(!cli.includes('runtime'));
  assert(!cli.includes('session.ts'));
  assert(!cli.includes('session_store'));
  assert(!cli.includes('tui'));
  assert(!launcher.includes('HENJI_OPENROUTER_API_KEY'));
  assert(!launcher.includes('--allow-write="$workspace"'));
  assert(!launcher.includes('--allow-write="$state_root"'));
  assert(!launcher.includes('--allow-write="$diagnostics_dir"'));
  assert(!launcher.includes('--allow-write="$sibling_path"'));
});
