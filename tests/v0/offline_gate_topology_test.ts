import { assert, assertEquals } from './test_helpers.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const TOPOLOGY_TASK = 'v0:offline-gate:topology:test';
const TOPOLOGY_FILE = 'tests/v0/offline_gate_topology_test.ts';
const STEP79_SOURCE_FILES = [
  'v0/agent/canonical_identity.ts',
  'v0/agent/replay_value.ts',
  'v0/agent/replay_envelope.ts',
  'v0/agent/execution_record.ts',
] as const;
const STEP79_FORBIDDEN_SOURCE_PATTERNS = [
  /\bfrom ['"](?:\.\/|\.\.\/)(?:runtime|events|session|openrouter)(?:\.ts)?['"]/,
  /\bDeno\./,
  /\bfetch\s*\(/,
  /\bprocess\./,
  /\bBun\./,
] as const;

const CHECK_TARGETS = [
  'v0/cli/main.ts',
  'v0/agent/cli.ts',
  'v0/agent/runtime.ts',
  'v0/agent/execution_context.ts',
  'v0/agent/cancellation.ts',
  'v0/agent/context.ts',
  'v0/agent/planner_delegation.ts',
  'v0/agent/agent_definition.ts',
  'v0/agent/agent_identity.ts',
  'v0/agent/resource_identity.ts',
  'v0/agent/canonical_identity.ts',
  'v0/agent/replay_value.ts',
  'v0/agent/replay_envelope.ts',
  'v0/agent/execution_record.ts',
  'v0/agent/resolved_manifest.ts',
  'v0/agent/comparison_variant.ts',
  'v0/agent/agent_catalog.ts',
  'v0/agent/agent_instructions.ts',
  'v0/agent/events.ts',
  'v0/agent/steering.ts',
  'v0/agent/loop.ts',
  'v0/agent/session.ts',
  'v0/agent/skills.ts',
  'v0/agent/registries.ts',
  'v0/agent/work_tools.ts',
  'v0/agent/runtime_cli.ts',
  'v0/agent/tui_cli.ts',
  'v0/agent/openrouter_model.ts',
  'v0/agent/real_provider_acceptance.ts',
  'v0/agent/real_json_keys_task.ts',
  'v0/agent/real_multi_tool_task.ts',
  'v0/agent/two_tool_task_selection.ts',
  'v0/agent/work_tools_sentinel.ts',
  'v0/agent/work_tools_sentinel_launcher.ts',
  'v0/corpus/task_corpus.ts',
  'v0/eval/scripted_corpus_model.ts',
  'v0/eval/offline_corpus_runner.ts',
  'v0/eval/offline_corpus_cli.ts',
  'v0/eval/live_corpus_runner.ts',
  'v0/eval/live_corpus_cli.ts',
  'v0/eval/live_corpus_credential_launcher.ts',
  'v0/tui/terminal.ts',
  'v0/tui/input.ts',
  'v0/tui/render.ts',
  'v0/tui/controller.ts',
  'tests/v0/v0_test.ts',
  'tests/v0/agent_instructions_test.ts',
  'tests/v0/agent_instructions_topology_test.ts',
  'tests/v0/agent_skills_test.ts',
  'tests/v0/agent_skills_topology_test.ts',
  'tests/v0/agent_session_test.ts',
  'tests/v0/agent_cancellation_test.ts',
  'tests/v0/agent_context_test.ts',
  'tests/v0/agent_loop_test.ts',
  'tests/v0/agent_steering_test.ts',
  'tests/v0/agent_tool_progress_test.ts',
  'tests/v0/agent_runtime_test.ts',
  'tests/v0/agent_definition_test.ts',
  'tests/v0/agent_resolved_manifest_test.ts',
  'tests/v0/agent_comparison_variant_test.ts',
  'tests/v0/planner_delegation_test.ts',
  'tests/v0/agent_catalog_test.ts',
  'tests/v0/agent_work_tools_test.ts',
  'tests/v0/agent_runtime_process_test.ts',
  'tests/v0/work_tools_sentinel_test.ts',
  'tests/v0/work_tools_sentinel_process_test.ts',
  'tests/v0/work_tools_sentinel_topology_test.ts',
  'tests/v0/fixtures/runtime_process_fixture.ts',
  'tests/v0/agent_openrouter_model_test.ts',
  'tests/v0/agent_streaming_test.ts',
  'tests/v0/real_provider_acceptance_test.ts',
  'tests/v0/two_tool_task_selection_test.ts',
  'tests/v0/json_object_keys_tool_test.ts',
  'tests/v0/task_corpus_test.ts',
  'tests/v0/offline_corpus_runner_test.ts',
  'tests/v0/live_corpus_runner_test.ts',
  'tests/v0/live_corpus_credential_launcher_test.ts',
  'tests/v0/live_corpus_credential_launcher_process_test.ts',
  'tests/v0/live_corpus_credential_launcher_topology_test.ts',
  'tests/v0/fixtures/live_corpus_credential_launcher_fake_child.ts',
  'tests/v0/tui_input_test.ts',
  'tests/v0/tui_render_test.ts',
  'tests/v0/tui_controller_test.ts',
  'tests/v0/tui_process_test.ts',
  'tests/v0/tui_topology_test.ts',
  'tests/v0/fixtures/tui_process_fixture.ts',
  'v0/extensions-src/task-planner/r1/main.ts',
  'v0/agent/planner_delegation_sentinel.ts',
  'v0/agent/planner_delegation_sentinel_launcher.ts',
  'tests/v0/planner_delegation_sentinel_test.ts',
  'tests/v0/planner_delegation_sentinel_process_test.ts',
  'tests/v0/planner_delegation_sentinel_topology_test.ts',
  'tests/v0/fixtures/planner_delegation_sentinel_process_fixture.ts',
  'v0/extensions-src/task-planner/r2/main.ts',
  TOPOLOGY_FILE,
] as const;
const EXPECTED_CHECK = [DENO, 'check', ...CHECK_TARGETS];
const EXPECTED_FMT = [
  DENO,
  'fmt',
  '--check',
  '--config',
  'deno.v0.json',
  'v0',
  'tests/v0',
];
const EXPECTED_LINT = [
  DENO,
  'lint',
  '--config',
  'deno.v0.json',
  'v0',
  'tests/v0',
];

const EXPECTED_LEAVES = [
  'v0:offline-gate:topology:test',
  'v0:legacy:test',
  'agent:test',
  'agent:resolved-manifest:test',
  'agent:comparison-variant:test',
  'agent:replay-record:test',
  'agent:definition:test',
  'agent:definition-selection:test',
  'agent:planner-delegation:test',
  'agent:instructions:test',
  'agent:instructions:topology:test',
  'agent:skills:test',
  'agent:skills:topology:test',
  'agent:session:test',
  'agent:session-store:test',
  'agent:session:process:test',
  'agent:session:tui:test',
  'agent:sessions:test',
  'agent:sessions:topology:test',
  'agent:cancellation:test',
  'agent:context:test',
  'agent:steering:test',
  'agent:tool-progress:test',
  'agent:streaming:test',
  'agent:transport:test',
  'agent:runtime:test',
  'agent:runtime:process:test',
  'agent:work-tools:test',
  'agent:tui:test',
  'agent:tui:process:test',
  'agent:tui:topology:test',
  'agent:selection:test',
  'agent:json-keys:test',
  'agent:corpus:test',
  'agent:corpus:eval:test',
  'agent:corpus:eval:live:test',
  'agent:corpus:eval:live:credential-launcher:test',
  'agent:corpus:eval:live:credential-launcher:process:test',
  'agent:corpus:eval:live:credential-launcher:topology:test',
  'agent:work-tools:sentinel:test',
  'agent:work-tools:sentinel:process:test',
  'agent:work-tools:sentinel:topology:test',
  'agent:planner-delegation:sentinel:test',
  'agent:planner-delegation:sentinel:process:test',
  'agent:planner-delegation:sentinel:topology:test',
  'agent:acceptance:test',
] as const;

type Manifest = { tasks: Record<string, string> };
type ParsedLeaf = { permissions: string[]; targets: string[] };

const targets: Record<string, string[]> = {};
const assignTarget = (file: string, ...taskNames: string[]): void => {
  for (const taskName of taskNames) targets[taskName] = [`tests/v0/${file}`];
};
assignTarget('offline_gate_topology_test.ts', TOPOLOGY_TASK);
assignTarget('v0_test.ts', 'v0:legacy:test');
assignTarget('agent_loop_test.ts', 'agent:test');
assignTarget('agent_definition_test.ts', 'agent:definition:test');
assignTarget('agent_resolved_manifest_test.ts', 'agent:resolved-manifest:test');
assignTarget('agent_comparison_variant_test.ts', 'agent:comparison-variant:test');
assignTarget('agent_replay_record_test.ts', 'agent:replay-record:test');
assignTarget('agent_catalog_test.ts', 'agent:definition-selection:test');
assignTarget('planner_delegation_test.ts', 'agent:planner-delegation:test');
assignTarget('agent_instructions_test.ts', 'agent:instructions:test');
assignTarget(
  'agent_instructions_topology_test.ts',
  'agent:instructions:topology:test',
);
assignTarget('agent_skills_test.ts', 'agent:skills:test');
assignTarget('agent_skills_topology_test.ts', 'agent:skills:topology:test');
assignTarget('agent_session_test.ts', 'agent:session:test');
assignTarget('agent_session_store_test.ts', 'agent:session-store:test');
assignTarget('agent_session_process_test.ts', 'agent:session:process:test');
assignTarget('agent_session_tui_test.ts', 'agent:session:tui:test');
assignTarget('agent_session_cli_test.ts', 'agent:sessions:test');
assignTarget('agent_session_topology_test.ts', 'agent:sessions:topology:test');
assignTarget('agent_cancellation_test.ts', 'agent:cancellation:test');
assignTarget('agent_context_test.ts', 'agent:context:test');
assignTarget('agent_steering_test.ts', 'agent:steering:test');
assignTarget('agent_tool_progress_test.ts', 'agent:tool-progress:test');
assignTarget('agent_streaming_test.ts', 'agent:streaming:test');
assignTarget('agent_openrouter_model_test.ts', 'agent:transport:test');
assignTarget('agent_runtime_test.ts', 'agent:runtime:test');
assignTarget('agent_runtime_process_test.ts', 'agent:runtime:process:test');
assignTarget('agent_work_tools_test.ts', 'agent:work-tools:test');
targets['agent:tui:test'] = [
  'tests/v0/tui_input_test.ts',
  'tests/v0/tui_render_test.ts',
  'tests/v0/tui_controller_test.ts',
];
assignTarget('tui_process_test.ts', 'agent:tui:process:test');
assignTarget('tui_topology_test.ts', 'agent:tui:topology:test');
assignTarget('two_tool_task_selection_test.ts', 'agent:selection:test');
assignTarget('json_object_keys_tool_test.ts', 'agent:json-keys:test');
assignTarget('task_corpus_test.ts', 'agent:corpus:test');
assignTarget('offline_corpus_runner_test.ts', 'agent:corpus:eval:test');
assignTarget('live_corpus_runner_test.ts', 'agent:corpus:eval:live:test');
assignTarget(
  'live_corpus_credential_launcher_test.ts',
  'agent:corpus:eval:live:credential-launcher:test',
);
assignTarget(
  'live_corpus_credential_launcher_process_test.ts',
  'agent:corpus:eval:live:credential-launcher:process:test',
);
assignTarget(
  'live_corpus_credential_launcher_topology_test.ts',
  'agent:corpus:eval:live:credential-launcher:topology:test',
);
assignTarget('work_tools_sentinel_test.ts', 'agent:work-tools:sentinel:test');
assignTarget(
  'work_tools_sentinel_process_test.ts',
  'agent:work-tools:sentinel:process:test',
);
assignTarget(
  'work_tools_sentinel_topology_test.ts',
  'agent:work-tools:sentinel:topology:test',
);
assignTarget(
  'planner_delegation_sentinel_test.ts',
  'agent:planner-delegation:sentinel:test',
);
assignTarget(
  'planner_delegation_sentinel_process_test.ts',
  'agent:planner-delegation:sentinel:process:test',
);
assignTarget(
  'planner_delegation_sentinel_topology_test.ts',
  'agent:planner-delegation:sentinel:topology:test',
);
assignTarget('real_provider_acceptance_test.ts', 'agent:acceptance:test');

const permissions: Record<string, string[]> = {};
const assignPermission = (flags: string[], ...taskNames: string[]): void => {
  for (const taskName of taskNames) permissions[taskName] = flags;
};
assignPermission(
  [],
  'agent:acceptance:test',
  'agent:cancellation:test',
  'agent:context:test',
  'agent:corpus:eval:live:credential-launcher:test',
  'agent:definition-selection:test',
  'agent:definition:test',
  'agent:resolved-manifest:test',
  'agent:comparison-variant:test',
  'agent:replay-record:test',
  'agent:instructions:test',
  'agent:planner-delegation:test',
  'agent:selection:test',
  'agent:session:test',
  'agent:skills:test',
  'agent:steering:test',
  'agent:streaming:test',
  'agent:test',
  'agent:tool-progress:test',
  'agent:transport:test',
  'agent:tui:test',
);
assignPermission(
  ['--allow-read=deno.v0.json'],
  'agent:corpus:eval:live:credential-launcher:topology:test',
  'agent:instructions:topology:test',
  'agent:json-keys:test',
  'agent:planner-delegation:sentinel:topology:test',
  'agent:skills:topology:test',
  'agent:tui:topology:test',
  'agent:work-tools:sentinel:topology:test',
);
assignPermission(
  ['--allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json'],
  'agent:corpus:test',
  'agent:corpus:eval:test',
  'agent:corpus:eval:live:test',
);
assignPermission(
  ['--allow-read=/tmp', '--allow-write=/tmp'],
  'agent:planner-delegation:sentinel:test',
  'agent:session-store:test',
  'agent:session:tui:test',
  'agent:sessions:test',
);
assignPermission(
  ['--allow-read=/tmp', '--allow-write=/tmp', '--allow-run=/bin/bash'],
  'agent:runtime:test',
  'agent:work-tools:sentinel:test',
  'agent:work-tools:test',
);
assignPermission(
  ['--allow-read=/tmp', '--allow-write=/tmp', `--allow-run=${DENO}`],
  'agent:planner-delegation:sentinel:process:test',
  'agent:work-tools:sentinel:process:test',
);
assignPermission(
  [`--allow-run=${DENO}`],
  'agent:corpus:eval:live:credential-launcher:process:test',
);
assignPermission(
  [
    `--allow-run=${DENO}`,
    '--allow-read=deno.v0.json,/tmp',
    '--allow-write=/tmp',
  ],
  'agent:runtime:process:test',
);
assignPermission(
  [`--allow-run=${DENO},/bin/sh`, '--allow-read=/tmp,v0', '--allow-write=/tmp'],
  'agent:session:process:test',
);
assignPermission(
  ['--allow-read=deno.v0.json,v0/agent'],
  'agent:sessions:topology:test',
);
assignPermission(['--allow-run=/usr/bin/script'], 'agent:tui:process:test');
assignPermission(
  [
    '--allow-read=v0/extensions-src,/tmp',
    '--allow-write=/tmp',
    `--allow-run=${DENO}`,
    '--allow-net=127.0.0.1',
  ],
  'v0:legacy:test',
);
assignPermission(['--allow-read=deno.v0.json,tests/v0,v0/agent'], TOPOLOGY_TASK);

const taskInvocation = (taskName: string): string =>
  `${DENO} task --config deno.v0.json ${taskName}`;

const parseSimpleCommand = (command: string): string[] | null => {
  if (
    !command || !/^[A-Za-z0-9_./:,=-]+(?: [A-Za-z0-9_./:,=-]+)*$/.test(command)
  ) return null;
  return command.split(' ');
};

const splitChain = (command: string): string[] | null => {
  if (
    !/^[A-Za-z0-9_:/.,=-]+(?: [A-Za-z0-9_:/.,=-]+)*(?: && [A-Za-z0-9_:/.,=-]+(?: [A-Za-z0-9_:/.,=-]+)*)*$/
      .test(
        command,
      )
  ) return null;
  return command.split(' && ');
};

const parseComposition = (command: string): string[] | null => {
  const segments = splitChain(command);
  if (!segments) return null;
  const names: string[] = [];
  for (const segment of segments) {
    const tokens = segment.split(' ');
    if (
      tokens.length !== 5 ||
      tokens[0] !== DENO ||
      tokens[1] !== 'task' ||
      tokens[2] !== '--config' ||
      tokens[3] !== 'deno.v0.json'
    ) return null;
    names.push(tokens[4]);
  }
  return names;
};

const parseLeaf = (command: string): ParsedLeaf | null => {
  if (!/^[A-Za-z0-9_:/.,=-]+(?: [A-Za-z0-9_:/.,=-]+)*$/.test(command)) {
    return null;
  }
  const tokens = command.split(' ');
  if (
    tokens.length < 4 || tokens[0] !== DENO || tokens[1] !== 'test' ||
    tokens[2] !== '--no-prompt'
  ) {
    return null;
  }
  const firstTarget = tokens.findIndex((token, index) =>
    index >= 3 && token.startsWith('tests/v0/')
  );
  if (firstTarget < 3) return null;
  const permissions = tokens.slice(3, firstTarget);
  const testTargets = tokens.slice(firstTarget);
  if (
    testTargets.some((target) => !/^tests\/v0\/[A-Za-z0-9_]+_test\.ts$/.test(target))
  ) return null;
  if (permissions.some((flag) => !flag.startsWith('--allow-'))) return null;
  return { permissions, targets: testTargets };
};

const sorted = (values: Iterable<string>): string[] => [...values].sort();
const cloneManifest = (manifest: Manifest): Manifest => ({
  tasks: { ...manifest.tasks },
});
const withEdges = (
  manifest: Manifest,
  taskName: string,
  edges: string[],
): Manifest => {
  const copy = cloneManifest(manifest);
  copy.tasks[taskName] = edges.map(taskInvocation).join(' && ');
  return copy;
};
const withTaskValue = (
  manifest: Manifest,
  taskName: string,
  value: string,
): Manifest => {
  const copy = cloneManifest(manifest);
  copy.tasks[taskName] = value;
  return copy;
};

const validateManifest = (manifest: Manifest, directFiles: string[]): void => {
  assert(manifest && typeof manifest === 'object' && manifest.tasks);
  const tasks = manifest.tasks;
  const testTaskNames = Object.keys(tasks).filter(
    (name) => name.endsWith(':test') && name !== 'v0:test',
  );
  assertEquals(
    sorted(testTaskNames),
    sorted(EXPECTED_LEAVES),
    'test task inventory drifted',
  );

  const testEdges = parseComposition(tasks['v0:test']);
  assertEquals(testEdges, [...EXPECTED_LEAVES], 'v0:test composition drifted');
  const gateEdges = parseComposition(tasks['v0:gate']);
  assertEquals(
    gateEdges,
    [TOPOLOGY_TASK, 'v0:check', 'v0:fmt', 'v0:lint', 'v0:test'],
    'v0:gate composition drifted',
  );
  assertEquals(
    parseSimpleCommand(tasks['v0:check']),
    EXPECTED_CHECK,
    'v0:check drifted',
  );
  assertEquals(
    parseSimpleCommand(tasks['v0:fmt']),
    EXPECTED_FMT,
    'v0:fmt drifted',
  );
  assertEquals(
    parseSimpleCommand(tasks['v0:lint']),
    EXPECTED_LINT,
    'v0:lint drifted',
  );

  for (const taskName of EXPECTED_LEAVES) {
    const parsed = parseLeaf(tasks[taskName]);
    assert(parsed, `invalid leaf grammar for ${taskName}`);
    assertEquals(
      parsed.permissions,
      permissions[taskName],
      `permission drift for ${taskName}`,
    );
    assertEquals(
      parsed.targets,
      targets[taskName],
      `target drift for ${taskName}`,
    );
  }

  const owned = new Map<string, number>();
  for (const taskName of EXPECTED_LEAVES) {
    for (const target of targets[taskName]) {
      owned.set(target, (owned.get(target) ?? 0) + 1);
    }
  }
  assertEquals(
    sorted(owned.keys()),
    sorted(directFiles),
    'direct test inventory drifted',
  );
  for (const file of directFiles) {
    assertEquals(owned.get(file), 1, `ownership drift for ${file}`);
  }
  assertEquals(owned.size, 48, 'expected 48 directly-owned tests');

  const active = new Set<string>();
  const visit = (taskName: string): void => {
    if (active.has(taskName)) {
      throw new Error(`task graph cycle at ${taskName}`);
    }
    if (
      EXPECTED_LEAVES.includes(taskName as (typeof EXPECTED_LEAVES)[number])
    ) return;
    if (
      taskName === 'v0:check' || taskName === 'v0:fmt' || taskName === 'v0:lint'
    ) return;
    if (taskName !== 'v0:test' && taskName !== 'v0:gate') {
      throw new Error(`unapproved reachable task ${taskName}`);
    }
    active.add(taskName);
    for (const edge of parseComposition(tasks[taskName]) ?? []) visit(edge);
    active.delete(taskName);
  };
  visit('v0:gate');
};

const directFiles: string[] = [];
for await (const entry of Deno.readDir('tests/v0')) {
  if (entry.isFile && entry.name.endsWith('_test.ts')) {
    directFiles.push(`tests/v0/${entry.name}`);
  }
}
directFiles.sort();
const manifest = JSON.parse(
  await Deno.readTextFile('deno.v0.json'),
) as Manifest;
const step79SourceInventory = await Promise.all(
  STEP79_SOURCE_FILES.map(async (file) => [file, await Deno.readTextFile(file)] as const),
);

Deno.test('offline gate has exact bounded leaf ownership and composition', () => {
  validateManifest(manifest, directFiles);
  for (const [file, source] of step79SourceInventory) {
    for (const pattern of STEP79_FORBIDDEN_SOURCE_PATTERNS) {
      assert(!pattern.test(source), `Step 79 source isolation drifted: ${file}`);
    }
  }
});

Deno.test('offline gate parser rejects unsafe grammar, topology, permissions, and targets', () => {
  const testEdges = parseComposition(manifest.tasks['v0:test'])!;
  const gateEdges = parseComposition(manifest.tasks['v0:gate'])!;
  const targetTask = 'agent:test';
  const targetCommand = manifest.tasks[targetTask];
  const mutations: Array<{ name: string; manifest: Manifest }> = [
    {
      name: 'remove outer topology edge',
      manifest: withEdges(manifest, 'v0:gate', gateEdges.slice(1)),
    },
    {
      name: 'remove inner topology edge',
      manifest: withEdges(manifest, 'v0:test', testEdges.slice(1)),
    },
    {
      name: 'v0:test self cycle',
      manifest: withEdges(manifest, 'v0:test', [
        'v0:test',
        ...testEdges.slice(1),
      ]),
    },
    {
      name: 'v0:gate self cycle',
      manifest: withEdges(manifest, 'v0:gate', [
        'v0:gate',
        ...gateEdges.slice(1),
      ]),
    },
    {
      name: 'v0:gate/v0:test mutual cycle',
      manifest: withEdges(manifest, 'v0:test', [
        'v0:gate',
        ...testEdges.slice(1),
      ]),
    },
    {
      name: 'v0:check production chain',
      manifest: withTaskValue(
        manifest,
        'v0:check',
        `${manifest.tasks['v0:check']} && ${taskInvocation('agent:acceptance')}`,
      ),
    },
    {
      name: 'v0:fmt provider chain',
      manifest: withTaskValue(
        manifest,
        'v0:fmt',
        `${manifest.tasks['v0:fmt']} && ${taskInvocation('agent:run')}`,
      ),
    },
    {
      name: 'v0:lint credential chain',
      manifest: withTaskValue(
        manifest,
        'v0:lint',
        `${manifest.tasks['v0:lint']} && ${
          taskInvocation('agent:work-tools:sentinel:credential-file')
        }`,
      ),
    },
    {
      name: 'extra task edge',
      manifest: withEdges(manifest, 'v0:test', [...testEdges, 'agent:run']),
    },
    {
      name: 'missing task edge',
      manifest: withEdges(manifest, 'v0:test', testEdges.slice(0, -1)),
    },
    {
      name: 'duplicate task edge',
      manifest: withEdges(manifest, 'v0:test', [...testEdges, testEdges[0]]),
    },
    {
      name: 'reordered task edge',
      manifest: withEdges(manifest, 'v0:test', [
        testEdges[1],
        testEdges[0],
        ...testEdges.slice(2),
      ]),
    },
    {
      name: 'production task edge',
      manifest: withEdges(manifest, 'v0:test', [
        testEdges[0],
        'agent:acceptance',
        ...testEdges.slice(2),
      ]),
    },
    {
      name: 'provider task edge',
      manifest: withEdges(manifest, 'v0:test', [
        testEdges[0],
        'agent:run',
        ...testEdges.slice(2),
      ]),
    },
    {
      name: 'live task edge',
      manifest: withEdges(manifest, 'v0:test', [
        testEdges[0],
        'agent:corpus:eval:live:sentinel',
        ...testEdges.slice(2),
      ]),
    },
    {
      name: 'credential task edge',
      manifest: withEdges(manifest, 'v0:test', [
        testEdges[0],
        'agent:work-tools:sentinel:credential-file',
        ...testEdges.slice(2),
      ]),
    },
    {
      name: 'added permission',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          '--no-prompt',
          '--no-prompt --allow-read=/tmp',
        );
        return copy;
      })(),
    },
    {
      name: 'removed permission',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:legacy:test'] = manifest.tasks['v0:legacy:test'].replace(
          '--allow-write=/tmp ',
          '',
        );
        return copy;
      })(),
    },
    {
      name: 'widened permission',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:legacy:test'] = manifest.tasks['v0:legacy:test'].replace(
          '--allow-net=127.0.0.1',
          '--allow-net=127.0.0.1,example.com',
        );
        return copy;
      })(),
    },
    {
      name: 'reordered permission',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:legacy:test'] = manifest.tasks['v0:legacy:test'].replace(
          '--allow-read=v0/extensions-src,/tmp --allow-write=/tmp',
          '--allow-write=/tmp --allow-read=v0/extensions-src,/tmp',
        );
        return copy;
      })(),
    },
    {
      name: 'duplicate existing permission',
      manifest: withTaskValue(
        manifest,
        'v0:legacy:test',
        manifest.tasks['v0:legacy:test'].replace(
          '--allow-write=/tmp',
          '--allow-write=/tmp --allow-write=/tmp',
        ),
      ),
    },
    {
      name: 'differently assigned permission',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          '--no-prompt',
          '--no-prompt --allow-net=127.0.0.1',
        );
        return copy;
      })(),
    },
    {
      name: 'unknown permission flag',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          '--no-prompt',
          '--no-prompt --allow-unknown=x',
        );
        return copy;
      })(),
    },
    {
      name: 'directory target',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          'tests/v0/agent_loop_test.ts',
          'tests/v0',
        );
        return copy;
      })(),
    },
    {
      name: 'glob target',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          'tests/v0/agent_loop_test.ts',
          'tests/v0/*_test.ts',
        );
        return copy;
      })(),
    },
    {
      name: 'dynamic target',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          'tests/v0/agent_loop_test.ts',
          '$TARGET',
        );
        return copy;
      })(),
    },
    {
      name: 'extra positional target',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = `${targetCommand} tests/v0/agent_context_test.ts`;
        return copy;
      })(),
    },
    {
      name: 'omitted target',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          ' tests/v0/agent_loop_test.ts',
          '',
        );
        return copy;
      })(),
    },
    {
      name: 'duplicate target',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = `${targetCommand} tests/v0/agent_loop_test.ts`;
        return copy;
      })(),
    },
    {
      name: 'unowned direct file',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          'tests/v0/agent_loop_test.ts',
          'tests/v0/not_owned_test.ts',
        );
        return copy;
      })(),
    },
    {
      name: 'non-direct test file',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks[targetTask] = targetCommand.replace(
          'tests/v0/agent_loop_test.ts',
          'tests/v0/fixtures/runtime_process_fixture_test.ts',
        );
        return copy;
      })(),
    },
    {
      name: 'quoting',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = manifest.tasks['v0:test'].replace(
          'agent:test',
          "'agent:test'",
        );
        return copy;
      })(),
    },
    {
      name: 'command substitution',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = manifest.tasks['v0:test'].replace(
          'agent:test',
          '$(agent:test)',
        );
        return copy;
      })(),
    },
    {
      name: 'variable expansion',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = manifest.tasks['v0:test'].replace(
          'agent:test',
          '$TASK',
        );
        return copy;
      })(),
    },
    {
      name: 'redirection',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = `${manifest.tasks['v0:test']} > /tmp/out`;
        return copy;
      })(),
    },
    {
      name: 'pipeline',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = `${manifest.tasks['v0:test']} | cat`;
        return copy;
      })(),
    },
    {
      name: 'grouping',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = `(${manifest.tasks['v0:test']})`;
        return copy;
      })(),
    },
    {
      name: 'newline separator',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = manifest.tasks['v0:test'].replace(' && ', '\n');
        return copy;
      })(),
    },
    {
      name: 'semicolon separator',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = manifest.tasks['v0:test'].replace(' && ', ';');
        return copy;
      })(),
    },
    {
      name: 'alternate separator',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = manifest.tasks['v0:test'].replace(
          ' && ',
          ' || ',
        );
        return copy;
      })(),
    },
    {
      name: 'unexpected whitespace',
      manifest: (() => {
        const copy = cloneManifest(manifest);
        copy.tasks['v0:test'] = manifest.tasks['v0:test'].replace(
          ' && ',
          '  && ',
        );
        return copy;
      })(),
    },
  ];

  for (const mutation of mutations) {
    let rejected = false;
    try {
      validateManifest(mutation.manifest, directFiles);
    } catch {
      rejected = true;
    }
    assert(rejected, `mutation was accepted: ${mutation.name}`);
  }
});
