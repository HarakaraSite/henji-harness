import { assert, assertEquals } from './test_helpers.ts';
import { DENO_COMMAND, SECRET_ENV } from '../../v0/agent/planner_delegation_sentinel_launcher.ts';

const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
  tasks: Record<string, string>;
};

Deno.test('planner sentinel topology fixes permissions and keeps Gate S unreachable locally', () => {
  const direct =
    `${DENO_COMMAND} task --config deno.v0.json agent:planner-delegation:sentinel:test`;
  const process =
    `${DENO_COMMAND} task --config deno.v0.json agent:planner-delegation:sentinel:process:test`;
  const topology =
    `${DENO_COMMAND} task --config deno.v0.json agent:planner-delegation:sentinel:topology:test`;
  assertEquals(
    config.tasks['agent:planner-delegation:sentinel:test'],
    `${DENO_COMMAND} test --no-prompt --allow-read=/tmp --allow-write=/tmp tests/v0/planner_delegation_sentinel_test.ts`,
  );
  assertEquals(
    config.tasks['agent:planner-delegation:sentinel:process:test'],
    `${DENO_COMMAND} test --no-prompt --allow-read=/tmp --allow-write=/tmp --allow-run=${DENO_COMMAND} tests/v0/planner_delegation_sentinel_process_test.ts`,
  );
  assertEquals(
    config.tasks['agent:planner-delegation:sentinel:topology:test'],
    `${DENO_COMMAND} test --no-prompt --allow-read=deno.v0.json tests/v0/planner_delegation_sentinel_topology_test.ts`,
  );
  const production = config.tasks['agent:planner-delegation:sentinel:credential-file'];
  assert(typeof production === 'string');
  assert(
    production.includes(
      '--allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key,/tmp',
    ),
  );
  assert(production.includes('--allow-write=/tmp'));
  assert(production.includes(`--allow-run=${DENO_COMMAND}`));
  assert(production.includes('--allow-sys=uid'));
  assert(!production.includes('--allow-env'));
  assert(!production.includes('--allow-net'));
  assert(!production.includes('--allow-run=/bin/bash'));
  for (const localTask of ['v0:check', 'v0:test', 'v0:gate'] as const) {
    assert(!config.tasks[localTask].includes('agent:planner-delegation:sentinel:credential-file'));
  }
  const gate = config.tasks['v0:gate'];
  const segments = gate.split('&&').map((segment) => segment.trim());
  assertEquals(segments.filter((segment) => segment === direct).length, 1);
  assertEquals(segments.filter((segment) => segment === process).length, 1);
  assertEquals(segments.filter((segment) => segment === topology).length, 1);
  assertEquals(
    segments.filter((segment) => segment.includes('planner-delegation:sentinel:credential-file'))
      .length,
    0,
  );
  assertEquals(SECRET_ENV, 'HENJI_OPENROUTER_API_KEY');
});
