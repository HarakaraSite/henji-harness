import { assert, assertEquals } from './test_helpers.ts';
import { DENO_COMMAND } from '../../v0/eval/live_corpus_credential_launcher.ts';

Deno.test('launcher tasks have fixed permissions and production task is unreachable from v0 gate', async () => {
  const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
    tasks: Record<string, string>;
  };
  const directTask =
    `${DENO_COMMAND} task --config deno.v0.json agent:corpus:eval:live:credential-launcher:test`;
  const processTask =
    `${DENO_COMMAND} task --config deno.v0.json agent:corpus:eval:live:credential-launcher:process:test`;
  const topologyTask =
    `${DENO_COMMAND} task --config deno.v0.json agent:corpus:eval:live:credential-launcher:topology:test`;
  const productionTask = config.tasks['agent:corpus:eval:live:sentinel:credential-file'];
  assertEquals(
    config.tasks['agent:corpus:eval:live:credential-launcher:test'],
    `${DENO_COMMAND} test --no-prompt tests/v0/live_corpus_credential_launcher_test.ts`,
  );
  assertEquals(
    config.tasks['agent:corpus:eval:live:credential-launcher:process:test'],
    `${DENO_COMMAND} test --no-prompt --allow-run=${DENO_COMMAND} tests/v0/live_corpus_credential_launcher_process_test.ts`,
  );
  assertEquals(
    config.tasks['agent:corpus:eval:live:credential-launcher:topology:test'],
    `${DENO_COMMAND} test --no-prompt --allow-read=deno.v0.json tests/v0/live_corpus_credential_launcher_topology_test.ts`,
  );
  assertEquals(
    productionTask,
    `${DENO_COMMAND} run --no-prompt --allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key --allow-run=${DENO_COMMAND} --allow-sys=uid v0/eval/live_corpus_credential_launcher.ts`,
  );
  const gate = config.tasks['v0:gate'];
  assert(typeof gate === 'string');
  const segments = gate.split('&&').map((segment) => segment.trim());
  assertEquals(segments.filter((segment) => segment === directTask).length, 1);
  assertEquals(segments.filter((segment) => segment === processTask).length, 1);
  assertEquals(segments.filter((segment) => segment === topologyTask).length, 1);
  assertEquals(segments.filter((segment) => segment.includes('credential-file')).length, 0);
  assertEquals(
    segments.filter((segment) => segment.includes('live_corpus_cli.ts sentinel')).length,
    0,
  );
  assertEquals(
    segments.filter((segment) => segment.includes('live_corpus_cli.ts canonical')).length,
    0,
  );
  assertEquals(
    productionTask.split(/\s+/).filter((token) => token.startsWith('--allow-sys=')),
    ['--allow-sys=uid'],
  );
  assert(!productionTask.includes('--allow-env'));
  assert(!productionTask.includes('--allow-net'));
  assert(!productionTask.includes('--allow-write'));
});
