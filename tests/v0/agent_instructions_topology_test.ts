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

  const gate = config.tasks['v0:gate'];
  assert(typeof gate === 'string');
  assertEquals(count(gate, 'agent:instructions:test'), 1);
  assertEquals(count(gate, 'agent:instructions:topology:test'), 1);
  assertEquals(count(gate, 'v0/agent/agent_instructions.ts'), 1);
  assertEquals(count(gate, 'tests/v0/agent_instructions_test.ts'), 1);
  assertEquals(count(gate, 'tests/v0/agent_instructions_topology_test.ts'), 1);
  const gateTokens = gate.split(/\s+/);
  assert(!gateTokens.includes('agent:run'));
  assert(!gateTokens.includes('agent:acceptance'));
  assertEquals(count(gate, 'credential-file'), 0);
});
