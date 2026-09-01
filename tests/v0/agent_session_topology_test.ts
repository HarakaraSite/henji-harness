import { assert, assertEquals } from './test_helpers.ts';

const tasks = JSON.parse(await Deno.readTextFile('deno.v0.json')).tasks as Record<string, string>;
const launcher = await Deno.readTextFile('v0/agent/session_launcher.sh');
const managementLauncher = await Deno.readTextFile('v0/agent/session_cli_launcher.sh');

Deno.test('persistent commands use side-effect-free launcher topology', () => {
  assert(tasks['agent:tui'] === 'v0/agent/session_launcher.sh');
  assert(tasks['agent:sessions'] === 'v0/agent/session_cli_launcher.sh');
  assert(!launcher.includes('--allow-env=HENJI_OPENROUTER_API_KEY'));
  assert(launcher.includes('HENJI_SESSION_STATE_ROOT="$state_root" exec'));
  assert(launcher.includes('HENJI_SESSION_STATE_ROOT="$state_root" exec "$deno" run'));
  assert(!launcher.includes('--allow-env=XDG_STATE_HOME,HOME'));
  assert(launcher.includes('--allow-net=openrouter.ai'));
  assert(launcher.includes('--allow-sys=uid'));
  assert(launcher.includes('--allow-read="$workspace"'));
  assert(launcher.includes('--allow-write="$workspace"'));
  assert(
    launcher.includes('--allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key'),
  );
  assert(launcher.includes('--no-remote'));
  assert(managementLauncher.includes('--allow-env=HENJI_SESSION_STATE_ROOT'));
  assert(managementLauncher.includes('HENJI_SESSION_STATE_ROOT="$state_root" exec'));
  assert(!launcher.includes('agent:run'));
});

Deno.test('TUI parser task is wired as a focused offline task', () => {
  assertEquals(tasks['agent:session-store:test']?.includes('agent_session_store_test.ts'), true);
  assertEquals(
    tasks['agent:session:process:test']?.includes('agent_session_process_test.ts'),
    true,
  );
  assertEquals(tasks['agent:sessions:test']?.includes('agent_session_cli_test.ts'), true);
});
