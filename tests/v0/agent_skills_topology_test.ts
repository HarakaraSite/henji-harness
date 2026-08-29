import { assert, assertEquals } from './test_helpers.ts';
import { createCorpusRegistry, createWorkToolsRegistry } from '../../v0/agent/registries.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
  tasks: Record<string, string>;
};

Deno.test('skill tasks are permission-bounded and production permissions are unchanged', () => {
  assertEquals(
    config.tasks['agent:skills:test'],
    `${DENO} test --no-prompt tests/v0/agent_skills_test.ts`,
  );
  assertEquals(
    config.tasks['agent:skills:topology:test'],
    `${DENO} test --no-prompt --allow-read=deno.v0.json tests/v0/agent_skills_topology_test.ts`,
  );
  assertEquals(
    config.tasks['agent:run'],
    `${DENO} run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=. --allow-write=. --allow-run=/bin/bash v0/agent/runtime_cli.ts`,
  );
  for (const task of ['agent:skills:test', 'agent:skills:topology:test']) {
    assert(!config.tasks[task].includes('--allow-env'));
    assert(!config.tasks[task].includes('--allow-net'));
    assert(!config.tasks[task].includes('--allow-write'));
    assert(!config.tasks[task].includes('--allow-run'));
  }
});

Deno.test('local compositions include both skill suites once and exclude production/provider tasks', () => {
  const gateSegments = config.tasks['v0:gate'].split(' && ');
  const testSegments = config.tasks['v0:test'].split(' && ');
  for (const task of ['agent:skills:test', 'agent:skills:topology:test']) {
    const command = `${DENO} task --config deno.v0.json ${task}`;
    assertEquals(testSegments.filter((segment) => segment === command).length, 1);
  }
  assertEquals(
    gateSegments.filter((segment) => segment === `${DENO} task --config deno.v0.json v0:test`)
      .length,
    1,
  );
  for (const composition of [gateSegments, testSegments]) {
    for (
      const forbidden of [
        'agent:run',
        'agent:acceptance',
        'agent:corpus:eval:live:sentinel',
        'agent:corpus:eval:live:canonical',
        'agent:work-tools:sentinel:credential-file',
      ]
    ) {
      assert(!composition.includes(`${DENO} task --config deno.v0.json ${forbidden}`));
    }
  }
});

Deno.test('corpus registry remains separate from conditional production skill topology', () => {
  assertEquals(
    createCorpusRegistry(() => Promise.resolve(new Uint8Array())).definitions().map((tool) =>
      tool.name
    ),
    [
      'character_count',
      'count_json_array_items',
      'list_json_object_keys',
      'submit_json_result',
      'uppercase_text',
    ],
  );
  assertEquals(
    createWorkToolsRegistry({ root: '/workspace' }).definitions().map((tool) => tool.name),
    [
      'bash',
      'edit',
      'read',
      'submit_json_result',
      'write',
    ],
  );
});
