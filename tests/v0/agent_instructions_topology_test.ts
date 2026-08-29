import { assert, assertEquals } from './test_helpers.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
  tasks: Record<string, string>;
};

const count = (value: string, needle: string): number => value.split(needle).length - 1;

Deno.test('instruction tasks and gate wiring preserve the normal permission boundary', () => {
  assertEquals(
    config.tasks['agent:run'],
    `${DENO} run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=. --allow-write=. --allow-run=/bin/bash v0/agent/runtime_cli.ts`,
  );
  assertEquals(
    config.tasks['agent:instructions:test'],
    `${DENO} test --no-prompt tests/v0/agent_instructions_test.ts`,
  );
  assertEquals(
    config.tasks['agent:instructions:topology:test'],
    `${DENO} test --no-prompt --allow-read=deno.v0.json tests/v0/agent_instructions_topology_test.ts`,
  );
  assert(!config.tasks['agent:run'].includes('--allow-read=/'));
  assert(!config.tasks['agent:run'].includes('$HOME'));
  assert(!config.tasks['agent:run'].includes('ZOT_HOME'));
  assert(!config.tasks['agent:run'].includes('AGENTS.MD'));

  const check = config.tasks['v0:check'];
  assertEquals(count(check, 'v0/agent/agent_instructions.ts'), 1);
  assertEquals(count(check, 'tests/v0/agent_instructions_test.ts'), 1);
  assertEquals(count(check, 'tests/v0/agent_instructions_topology_test.ts'), 1);
  const gate = config.tasks['v0:gate'];
  const test = config.tasks['v0:test'];
  const gateSegments = gate.split(' && ');
  const testInvocation = `${DENO} task --config deno.v0.json agent:instructions:test`;
  const topologyInvocation = `${DENO} task --config deno.v0.json agent:instructions:topology:test`;
  assertEquals(
    gateSegments.filter((segment) => segment === `${DENO} task --config deno.v0.json v0:test`)
      .length,
    1,
  );
  assertEquals(test.split(' && ').filter((segment) => segment === testInvocation).length, 1);
  assertEquals(test.split(' && ').filter((segment) => segment === topologyInvocation).length, 1);
  for (const composition of [test, gate]) {
    const segments = composition.split(' && ');
    assertEquals(
      segments.filter((segment) => segment === `${DENO} task --config deno.v0.json agent:run`)
        .length,
      0,
    );
    assertEquals(
      segments.filter((segment) =>
        segment === `${DENO} task --config deno.v0.json agent:acceptance`
      ).length,
      0,
    );
    assertEquals(segments.filter((segment) => segment.includes('credential-file')).length, 0);
  }
});
