import { assert, assertEquals } from './test_helpers.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
  tasks: Record<string, string>;
};

Deno.test('agent:tui has the exact trusted-local production permission topology', () => {
  assertEquals(
    config.tasks['agent:tui'],
    'v0/agent/session_launcher.sh',
  );
  assertEquals(
    config.tasks['agent:run'],
    `${DENO} run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=. --allow-write=. --allow-run=/bin/bash v0/agent/runtime_cli.ts`,
  );
  assert(!config.tasks['agent:tui'].includes('credential'));
  assert(!config.tasks['agent:tui'].includes('tests/'));
});

Deno.test('local TUI gate runs only local tests and check includes all TUI paths', () => {
  const check = config.tasks['v0:check'];
  const gate = config.tasks['v0:gate'];
  for (
    const path of [
      'v0/agent/tui_cli.ts',
      'v0/tui/terminal.ts',
      'v0/tui/input.ts',
      'v0/tui/render.ts',
      'v0/tui/controller.ts',
      'tests/v0/tui_input_test.ts',
      'tests/v0/tui_render_test.ts',
      'tests/v0/tui_controller_test.ts',
      'tests/v0/tui_process_test.ts',
      'tests/v0/tui_topology_test.ts',
      'tests/v0/fixtures/tui_process_fixture.ts',
    ]
  ) assert(check.includes(path));
  assert(check.includes('v0/agent/agent_catalog.ts'));
  assert(check.includes('tests/v0/agent_catalog_test.ts'));
  const gateSegments = gate.split(' && ');
  const testSegments = config.tasks['v0:test'].split(' && ');
  assertEquals(
    gateSegments.filter((segment) => segment === `${DENO} task --config deno.v0.json v0:test`)
      .length,
    1,
  );
  for (const task of ['agent:tui:test', 'agent:tui:process:test', 'agent:tui:topology:test']) {
    const invocation = `${DENO} task --config deno.v0.json ${task}`;
    assertEquals(testSegments.filter((segment) => segment === invocation).length, 1);
  }
  for (const composition of [gateSegments, testSegments]) {
    assert(!composition.includes(`${DENO} task --config deno.v0.json agent:run`));
    assert(!composition.includes(`${DENO} task --config deno.v0.json agent:acceptance`));
    assert(!composition.some((segment) => segment.includes('credential-file')));
  }
});

Deno.test('TUI local process task grants only script execution and topology task only config read', () => {
  assertEquals(
    config.tasks['agent:tui:process:test'],
    `${DENO} test --no-prompt --allow-run=/usr/bin/script tests/v0/tui_process_test.ts`,
  );
  assertEquals(
    config.tasks['agent:tui:topology:test'],
    `${DENO} test --no-prompt --allow-read=deno.v0.json tests/v0/tui_topology_test.ts`,
  );
});

Deno.test('tool progress focused task is permission-free and is wired once into the offline gate', () => {
  assertEquals(
    config.tasks['agent:tool-progress:test'],
    `${DENO} test --no-prompt tests/v0/agent_tool_progress_test.ts`,
  );
  assert(config.tasks['v0:check'].includes('tests/v0/agent_tool_progress_test.ts'));
  const gate = config.tasks['v0:gate'];
  const test = config.tasks['v0:test'];
  assertEquals(gate.split(`${DENO} task --config deno.v0.json v0:test`).length - 1, 1);
  assertEquals(
    test.split(`${DENO} task --config deno.v0.json agent:tool-progress:test`).length - 1,
    1,
  );
});
