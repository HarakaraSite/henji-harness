import { assert, assertEquals } from './test_helpers.ts';
import { DENO_COMMAND, SECRET_ENV } from '../../v0/agent/work_tools_sentinel_launcher.ts';

const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
  tasks: Record<string, string>;
};

Deno.test('sentinel topology keeps production task out of local gates and preserves credential boundary', () => {
  const direct = `${DENO_COMMAND} task --config deno.v0.json agent:work-tools:sentinel:test`;
  const process =
    `${DENO_COMMAND} task --config deno.v0.json agent:work-tools:sentinel:process:test`;
  const topology =
    `${DENO_COMMAND} task --config deno.v0.json agent:work-tools:sentinel:topology:test`;
  assertEquals(
    config.tasks['agent:work-tools:sentinel:test'],
    `${DENO_COMMAND} test --no-prompt --allow-read=/tmp --allow-write=/tmp --allow-run=/bin/bash tests/v0/work_tools_sentinel_test.ts`,
  );
  assertEquals(
    config.tasks['agent:work-tools:sentinel:process:test'],
    `${DENO_COMMAND} test --no-prompt --allow-read=/tmp --allow-write=/tmp --allow-run=${DENO_COMMAND} tests/v0/work_tools_sentinel_process_test.ts`,
  );
  assertEquals(
    config.tasks['agent:work-tools:sentinel:topology:test'],
    `${DENO_COMMAND} test --no-prompt --allow-read=deno.v0.json tests/v0/work_tools_sentinel_topology_test.ts`,
  );
  const production = config.tasks['agent:work-tools:sentinel:credential-file'];
  assert(typeof production === 'string');
  assertEquals(
    config.tasks['agent:run'],
    `${DENO_COMMAND} run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=. --allow-write=. --allow-run=/bin/bash v0/agent/runtime_cli.ts`,
  );
  assertEquals(
    config.tasks['agent:acceptance'],
    `${DENO_COMMAND} run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai v0/agent/real_provider_acceptance.ts`,
  );
  assertEquals(
    config.tasks['agent:corpus:eval:live:sentinel:credential-file'],
    `${DENO_COMMAND} run --no-prompt --allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key --allow-run=${DENO_COMMAND} --allow-sys=uid v0/eval/live_corpus_credential_launcher.ts`,
  );
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
    assert(!config.tasks[localTask].includes('agent:work-tools:sentinel:credential-file'));
  }
  const gate = config.tasks['v0:gate'];
  const test = config.tasks['v0:test'];
  const gateSegments = gate.split(' && ');
  const testSegments = test.split(' && ');
  assertEquals(
    gateSegments.filter((segment) =>
      segment === `${DENO_COMMAND} task --config deno.v0.json v0:test`
    ).length,
    1,
  );
  assertEquals(testSegments.filter((segment) => segment === direct).length, 1);
  assertEquals(testSegments.filter((segment) => segment === process).length, 1);
  assertEquals(testSegments.filter((segment) => segment === topology).length, 1);
  for (const segments of [gateSegments, testSegments]) {
    assertEquals(
      segments.filter((segment) => segment.includes('agent:work-tools:sentinel:credential-file'))
        .length,
      0,
    );
    assertEquals(
      segments.filter((segment) => segment.includes('live_corpus_cli.ts sentinel')).length,
      0,
    );
    assert(!segments.includes(`${DENO_COMMAND} task --config deno.v0.json agent:run`));
  }
  assertEquals(SECRET_ENV, 'HENJI_OPENROUTER_API_KEY');
});
