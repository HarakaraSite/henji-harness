import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  AgentFreshRuntimeComparisonError,
  createFreshRuntimeComparisonToolForTest,
  createFreshRuntimeRunSpecs,
  FRESH_RUNTIME_COMPARISON_CASE,
  runFreshRuntimeComparison,
  runFreshRuntimeComparisonForTest,
  validateAgentFreshRuntimeComparisonResult,
  validateFreshRuntimeComparisonCase,
  validateFreshRuntimeRunPair,
} from '../../v0/agent/fresh_runtime_comparison.ts';
import { renderAgentFreshRuntimeComparisonReport } from '../../v0/agent/fresh_runtime_comparison_report.ts';

const REPORT = `agent_definition_fresh_runtime_comparison
schema_version: 1
case_id: v1.default-max-steps-comparison
shared:
  task_identifier: v1.default-max-steps-comparison
  workspace_entry_count: 2
  model_identity: model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0
  initial_transcript_count: 0
  planner_model_request_ceiling: 0
  max_external_request_ceiling: 0
  max_wall_time_micros: 1000000
  script_id: five-step-uppercase-v1
  tool_fixture_id: uppercase-text-v1
current:
  run_ordinal: 1
  definition_id: default
  manifest_identity: henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58
  envelope_identity: henji-agent-replay-envelope:v1:sha256:d2100020f44dbb1072d39c3ad83f5adc842f120d6725c26e4188bd61a352a0e8
  max_steps: 8
  state: completed
  stop_reason: final
  committed: true
  model_requests: 5
  external_requests: 0
  steps: 5
  tool_calls: 4
  tool_results: 4
  causal_tool_path: 1:uppercase_text:success > 2:uppercase_text:success > 3:uppercase_text:success > 4:uppercase_text:success
  duration_micros: 1250
  provider_token_usage: unsupported
  cost: unsupported
variant:
  run_ordinal: 2
  definition_id: default-max-steps-4
  manifest_identity: henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389
  envelope_identity: henji-agent-replay-envelope:v1:sha256:09251dd6a3028d50efe09dbe31e2cbc19418556c3c659ee1d5ebd12c9212b633
  max_steps: 4
  state: stopped
  stop_reason: max_steps
  committed: false
  model_requests: 4
  external_requests: 0
  steps: 4
  tool_calls: 4
  tool_results: 4
  causal_tool_path: 1:uppercase_text:success > 2:uppercase_text:success > 3:uppercase_text:success > 4:uppercase_text:success
  duration_micros: 1250
  provider_token_usage: unsupported
  cost: unsupported
allowed_envelope_diff:
  definition_id: default -> default-max-steps-4
  max_steps: 8 -> 4
  parent_model_request_ceiling: 8 -> 4
  aggregate_model_request_ceiling: 8 -> 4
  manifest_identity: henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58 -> henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389
  envelope_identity: henji-agent-replay-envelope:v1:sha256:d2100020f44dbb1072d39c3ad83f5adc842f120d6725c26e4188bd61a352a0e8 -> henji-agent-replay-envelope:v1:sha256:09251dd6a3028d50efe09dbe31e2cbc19418556c3c659ee1d5ebd12c9212b633
execution_delta:
  state: completed -> stopped
  stop_reason: final -> max_steps
  committed: true -> false
  model_requests: 5 -> 4
  external_requests: 0 -> 0
  steps: 5 -> 4
  tool_calls: 4 -> 4
  tool_results: 4 -> 4
  duration_micros: 1250 -> 1250
  provider_token_usage: unsupported -> unsupported
  cost: unsupported -> unsupported
`;

const expectComparisonFailure = async (fn: () => unknown | Promise<unknown>): Promise<void> => {
  await assertRejects(async () => {
    try {
      await fn();
    } catch (error) {
      assert(error instanceof AgentFreshRuntimeComparisonError);
      assertEquals(error.name, 'AgentFreshRuntimeComparisonError');
      assertEquals(error.message, 'agent fresh-runtime comparison failed');
      throw error;
    }
  });
};

Deno.test('fresh runtime fixed case and pair have exact known identities', async () => {
  const comparisonCase = validateFreshRuntimeComparisonCase(FRESH_RUNTIME_COMPARISON_CASE);
  assert(Object.isFrozen(comparisonCase));
  const pair = await createFreshRuntimeRunSpecs(comparisonCase);
  assert(Object.isFrozen(pair));
  assert(pair.current.definition !== pair.variant.definition);
  assert(pair.current.manifest !== pair.variant.manifest);
  assertEquals(
    pair.current.manifest.identity,
    'henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58',
  );
  assertEquals(
    pair.variant.manifest.identity,
    'henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389',
  );
  assertEquals(
    pair.current.envelope.identity,
    'henji-agent-replay-envelope:v1:sha256:d2100020f44dbb1072d39c3ad83f5adc842f120d6725c26e4188bd61a352a0e8',
  );
  assertEquals(
    pair.variant.envelope.identity,
    'henji-agent-replay-envelope:v1:sha256:09251dd6a3028d50efe09dbe31e2cbc19418556c3c659ee1d5ebd12c9212b633',
  );
  assertEquals(pair.current.envelope.budget, {
    maxSteps: 8,
    modelRequests: { parent: 8, planner: 0, aggregate: 8 },
    maxExternalRequests: 0,
    maxWallTimeMicros: 1_000_000,
  });
  assertEquals(pair.variant.envelope.budget, {
    maxSteps: 4,
    modelRequests: { parent: 4, planner: 0, aggregate: 4 },
    maxExternalRequests: 0,
    maxWallTimeMicros: 1_000_000,
  });
});

Deno.test('fresh runtime fixture tool enforces per-run order, reuse, and extra-call bounds', async () => {
  const first = createFreshRuntimeComparisonToolForTest();
  const second = createFreshRuntimeComparisonToolForTest();
  assert(first !== second);
  await expectComparisonFailure(() => first.execute({ text: 'two' }));
  assertEquals(first.execute({ text: 'one' }), 'ONE');
  await expectComparisonFailure(() => first.execute({ text: 'one' }));
  assertEquals(first.execute({ text: 'two' }), 'TWO');
  assertEquals(first.execute({ text: 'three' }), 'THREE');
  assertEquals(first.execute({ text: 'four' }), 'FOUR');
  first.verifyComplete();
  await expectComparisonFailure(() => first.execute({ text: 'four' }));
  assertEquals(second.execute({ text: 'one' }), 'ONE');
  assertEquals(second.execute({ text: 'two' }), 'TWO');
  assertEquals(second.execute({ text: 'three' }), 'THREE');
  assertEquals(second.execute({ text: 'four' }), 'FOUR');
  second.verifyComplete();
});

Deno.test('fresh runtime owns all run-local construction and sanitizes bounded faults', async () => {
  const constructions: string[] = [];
  const result = await runFreshRuntimeComparisonForTest(undefined, 'current-first', {
    onConstruct: (kind, side, position) => constructions.push(`${position}:${side}:${kind}`),
  });
  assertEquals(constructions, [
    'first:current:evaluator',
    'second:variant:evaluator',
    'first:current:model',
    'first:current:tool',
    'first:current:registry',
    'first:current:clock',
    'first:current:abort',
    'first:current:counters',
    'first:current:transcript',
    'first:current:recorder',
    'first:current:commit',
    'second:variant:model',
    'second:variant:tool',
    'second:variant:registry',
    'second:variant:clock',
    'second:variant:abort',
    'second:variant:counters',
    'second:variant:transcript',
    'second:variant:recorder',
    'second:variant:commit',
  ]);
  assertEquals(result.current.counts, {
    modelRequests: 5,
    externalRequests: 0,
    steps: 5,
    toolCalls: 4,
    toolResults: 4,
  });

  const reversedConstructions: string[] = [];
  await runFreshRuntimeComparisonForTest(undefined, 'variant-first', {
    onConstruct: (kind, side, position) =>
      reversedConstructions.push(`${position}:${side}:${kind}`),
  });
  assertEquals(reversedConstructions, [
    'second:current:evaluator',
    'first:variant:evaluator',
    'first:variant:model',
    'first:variant:tool',
    'first:variant:registry',
    'first:variant:clock',
    'first:variant:abort',
    'first:variant:counters',
    'first:variant:transcript',
    'first:variant:recorder',
    'first:variant:commit',
    'second:current:model',
    'second:current:tool',
    'second:current:registry',
    'second:current:clock',
    'second:current:abort',
    'second:current:counters',
    'second:current:transcript',
    'second:current:recorder',
    'second:current:commit',
  ]);
  assertEquals(result.variant.counts, {
    modelRequests: 4,
    externalRequests: 0,
    steps: 4,
    toolCalls: 4,
    toolResults: 4,
  });

  const phases = [
    'setup',
    'model',
    'tool',
    'observer',
    'recorder',
    'clock',
    'correlation',
  ] as const;
  for (const executionOrder of ['current-first', 'variant-first'] as const) {
    for (const phase of phases) {
      await expectComparisonFailure(() =>
        runFreshRuntimeComparisonForTest(undefined, executionOrder, {
          failure: { phase, position: 'any' },
        })
      );
    }
  }
});

Deno.test('fresh runtime second-position faults follow a settled first run', async () => {
  const phases = ['model', 'tool', 'observer', 'recorder', 'clock'] as const;
  for (const executionOrder of ['current-first', 'variant-first'] as const) {
    const firstSide = executionOrder === 'current-first' ? 'current' : 'variant';
    const secondSide = executionOrder === 'current-first' ? 'variant' : 'current';
    for (const phase of phases) {
      const progress: string[] = [];
      let returned = false;
      await expectComparisonFailure(async () => {
        const result = await runFreshRuntimeComparisonForTest(undefined, executionOrder, {
          failure: { phase, position: 'second' },
          onConstruct: (kind, side, position) => progress.push(`${position}:${side}:${kind}`),
          onRunComplete: (side, position) => progress.push(`${position}:${side}:settled`),
        });
        returned = true;
        return result;
      });
      assertEquals(returned, false);
      const settledIndex = progress.indexOf(`first:${firstSide}:settled`);
      const secondConstructionIndex = progress.indexOf(`second:${secondSide}:model`);
      assert(settledIndex >= 0, `first ${firstSide} run did not settle`);
      assert(
        secondConstructionIndex > settledIndex,
        `second ${secondSide} run started before first settlement`,
      );
      assertEquals(progress.at(-1), `second:${secondSide}:commit`);
    }
  }
});

Deno.test('fresh runtime partial-second failure follows second model progress', async () => {
  for (const executionOrder of ['current-first', 'variant-first'] as const) {
    const firstSide = executionOrder === 'current-first' ? 'current' : 'variant';
    const secondSide = executionOrder === 'current-first' ? 'variant' : 'current';
    const progress: string[] = [];
    let returned = false;
    let partialResult: unknown;
    await expectComparisonFailure(async () => {
      partialResult = await runFreshRuntimeComparisonForTest(undefined, executionOrder, {
        failure: { phase: 'partial-second-run', position: 'second' },
        onConstruct: (kind, side, position) => progress.push(`${position}:${side}:${kind}`),
        onRunComplete: (side, position) => progress.push(`${position}:${side}:settled`),
        onProgress: (marker, side, position, ordinal) =>
          progress.push(`${position}:${side}:${marker}:${ordinal}`),
      });
      returned = true;
      return partialResult;
    });
    assertEquals(returned, false);
    assertEquals(partialResult, undefined);
    const settledIndex = progress.indexOf(`first:${firstSide}:settled`);
    const secondConstructionIndex = progress.indexOf(`second:${secondSide}:model`);
    const secondModelProgressIndex = progress.indexOf(
      `second:${secondSide}:model-settled-recorded:1`,
    );
    assert(settledIndex >= 0, `first ${firstSide} run did not settle`);
    assert(
      secondConstructionIndex > settledIndex,
      `second ${secondSide} construction was not observable after settlement`,
    );
    assert(
      secondModelProgressIndex > settledIndex,
      `second ${secondSide} model settlement was not recorded after first settlement`,
    );
    assertEquals(progress.at(-1), `second:${secondSide}:model-settled-recorded:1`);
  }
});

Deno.test('fresh runtime executes isolated five-step fixture and correlates records exactly', async () => {
  const result = await runFreshRuntimeComparison();
  assertEquals(result.current.state, 'completed');
  assertEquals(result.current.record.outcome.stopReason, 'final');
  assertEquals(result.current.record.outcome.committed, true);
  assertEquals(result.current.counts, {
    modelRequests: 5,
    externalRequests: 0,
    steps: 5,
    toolCalls: 4,
    toolResults: 4,
  });
  assertEquals(result.current.record.transcript.length, 10);
  assertEquals(result.variant.state, 'stopped');
  assertEquals(result.variant.record.outcome.stopReason, 'max_steps');
  assertEquals(result.variant.record.outcome.committed, false);
  assertEquals(result.variant.counts, {
    modelRequests: 4,
    externalRequests: 0,
    steps: 4,
    toolCalls: 4,
    toolResults: 4,
  });
  assertEquals(result.variant.record.transcript.length, 9);
  assertEquals(result.current.causalToolPath, [
    { ordinal: 1, name: 'uppercase_text', outcome: 'success' },
    { ordinal: 2, name: 'uppercase_text', outcome: 'success' },
    { ordinal: 3, name: 'uppercase_text', outcome: 'success' },
    { ordinal: 4, name: 'uppercase_text', outcome: 'success' },
  ]);
  assertEquals(result.variant.causalToolPath, result.current.causalToolPath);
  assertEquals(result.executionDelta.durationMicros, { current: 1250, variant: 1250 });
  assertEquals(result.current.record.usage.providerTokenUsage, 'unsupported');
  assertEquals(result.current.record.usage.cost, 'unsupported');
});

Deno.test('fresh runtime result and report are exact, bounded, and non-sensitive', async () => {
  const result = await runFreshRuntimeComparison();
  assertEquals(renderAgentFreshRuntimeComparisonReport(result), REPORT);
  assertEquals(new TextEncoder().encode(REPORT).byteLength < 16 * 1024, true);
  assert(!REPORT.includes('Complete four uppercase checks'));
  for (
    const marker of [
      'task-body-marker',
      'workspace-content-marker',
      'absolute-path-marker',
      'credential-marker',
      'raw-provider-marker',
      'progress-marker',
      'unbounded-tool-marker',
      '[object Object]',
      'winner',
      'score',
      'recommendation',
      'promotion',
    ]
  ) assert(!REPORT.includes(marker), marker);
  assertEquals(REPORT.startsWith('\n'), false);
  assertEquals(REPORT.includes('\r'), false);
  assertEquals(REPORT.endsWith('\n'), true);
  assertEquals(REPORT.endsWith('\n\n'), false);
  assertEquals(REPORT.split('\n').some((line) => line.endsWith(' ')), false);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.shared));
  assert(Object.isFrozen(result.current));
  assert(Object.isFrozen(result.current.counts));
  assert(Object.isFrozen(result.current.record));
  assert(Object.isFrozen(result.allowedEnvelopeDiff));
  assert(Object.isFrozen(result.executionDelta));
});

Deno.test('fresh runtime pair rejects unauthorized condition and identity mutations before use', async () => {
  const pair = await createFreshRuntimeRunSpecs();
  const mutations = [
    {
      current: {
        ...pair.current,
        envelope: { ...pair.current.envelope, task: 'task-body-marker' },
      },
    },
    {
      current: {
        ...pair.current,
        envelope: { ...pair.current.envelope, modelIdentity: 'model:fake:wrong' },
      },
    },
    {
      current: {
        ...pair.current,
        envelope: { ...pair.current.envelope, identity: pair.variant.envelope.identity },
      },
    },
    {
      variant: {
        ...pair.variant,
        manifest: { ...pair.variant.manifest, parameters: { maxSteps: 8 } },
      },
    },
    { variant: { ...pair.variant, definitionId: 'default' } },
    { current: { ...pair.current, side: 'variant' } },
    { current: { ...pair.current, runOrdinal: 2 } },
  ];
  for (const mutation of mutations) {
    await expectComparisonFailure(() =>
      validateFreshRuntimeRunPair({
        current: mutation.current ?? pair.current,
        variant: mutation.variant ?? pair.variant,
      })
    );
  }
  await expectComparisonFailure(() =>
    validateFreshRuntimeRunPair({
      current: pair.current,
      variant: {
        ...pair.variant,
        definition: Object.freeze({ ...pair.variant.definition, systemInstruction: null }),
      },
    })
  );
});

Deno.test('fresh runtime rejects every case condition and derived ceiling mutation', async () => {
  const base = FRESH_RUNTIME_COMPARISON_CASE;
  const mutations = [
    { ...base, task: 'task-body-marker' },
    {
      ...base,
      workspace: { entries: [{ path: 'AGENTS.md', digest: 'workspace-content-marker' }] },
    },
    { ...base, modelIdentity: 'model:fake:wrong' },
    { ...base, initialTranscript: [{ role: 'user', content: { kind: 'text', text: 'prior' } }] },
    { ...base, ceilings: { ...base.ceilings, plannerModelRequests: 1 } },
    { ...base, ceilings: { ...base.ceilings, maxExternalRequests: 1 } },
    { ...base, ceilings: { ...base.ceilings, maxWallTimeMicros: 999_999 } },
    { ...base, scriptId: 'other-script' },
    { ...base, toolFixtureId: 'other-tool' },
  ];
  for (const mutation of mutations) {
    await expectComparisonFailure(() => createFreshRuntimeRunSpecs(mutation));
  }

  const pair = await createFreshRuntimeRunSpecs();
  const currentResources = [...pair.current.manifest.resources];
  const resourceMutations = [
    currentResources.slice(1),
    [...currentResources, currentResources.at(-1)],
    [...currentResources.slice(1), currentResources[0]],
    currentResources.map((resource, index) => index === 0 ? 'model:wrong:profile' : resource),
  ];
  for (const resources of resourceMutations) {
    await expectComparisonFailure(() =>
      validateFreshRuntimeRunPair({
        current: {
          ...pair.current,
          manifest: { ...pair.current.manifest, resources },
        },
        variant: pair.variant,
      })
    );
  }
  for (
    const budget of [
      { ...pair.current.envelope.budget, modelRequests: { parent: 7, planner: 0, aggregate: 8 } },
      { ...pair.current.envelope.budget, modelRequests: { parent: 8, planner: 0, aggregate: 7 } },
      { ...pair.current.envelope.budget, maxSteps: 7 },
    ]
  ) {
    await expectComparisonFailure(() =>
      validateFreshRuntimeRunPair({
        current: {
          ...pair.current,
          envelope: { ...pair.current.envelope, budget },
        },
        variant: pair.variant,
      })
    );
  }
});

Deno.test('fresh runtime result validator enforces exact shape and accepts only duration variation', async () => {
  const result = await runFreshRuntimeComparison();
  assertEquals(Object.getOwnPropertyNames(result), [
    'schemaVersion',
    'caseId',
    'shared',
    'current',
    'variant',
    'allowedEnvelopeDiff',
    'executionDelta',
  ]);
  assertEquals(Object.getOwnPropertyNames(result.shared), [
    'taskIdentifier',
    'workspaceEntryCount',
    'modelIdentity',
    'initialTranscriptCount',
    'plannerModelRequestCeiling',
    'maxExternalRequestCeiling',
    'maxWallTimeMicros',
    'scriptId',
    'toolFixtureId',
  ]);
  assertEquals(Object.getOwnPropertyNames(result.current), [
    'runOrdinal',
    'definitionId',
    'manifestIdentity',
    'envelopeIdentity',
    'maxSteps',
    'state',
    'counts',
    'record',
    'causalToolPath',
  ]);
  const varied = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  (varied.current as Record<string, unknown>).record = {
    ...(varied.current as Record<string, unknown>).record as Record<string, unknown>,
    durationMicros: 2_000,
  };
  (varied.executionDelta as Record<string, unknown>).durationMicros = {
    current: 2_000,
    variant: 1_250,
  };
  const accepted = validateAgentFreshRuntimeComparisonResult(varied);
  assertEquals(accepted.current.record.durationMicros, 2_000);
  assertEquals(accepted.variant.record.durationMicros, 1_250);
});

Deno.test('fresh runtime result validator rejects fabricated state, counts, and delta', async () => {
  const result = await runFreshRuntimeComparison();
  const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  const cases = [
    { ...json, current: { ...(json.current as Record<string, unknown>), state: 'stopped' } },
    {
      ...json,
      variant: {
        ...(json.variant as Record<string, unknown>),
        counts: {
          ...(json.variant as Record<string, unknown>).counts as Record<string, unknown>,
          modelRequests: 5,
        },
      },
    },
    {
      ...json,
      executionDelta: {
        ...(json.executionDelta as Record<string, unknown>),
        committed: { current: false, variant: false },
      },
    },
    {
      ...json,
      allowedEnvelopeDiff: {
        ...(json.allowedEnvelopeDiff as Record<string, unknown>),
        maxSteps: { current: 8, variant: 8 },
      },
    },
    {
      ...json,
      current: {
        ...(json.current as Record<string, unknown>),
        manifestIdentity: 'henji-agent-resolved-manifest:v1:sha256:wrong',
      },
    },
  ];
  for (const candidate of cases) {
    let rejected = false;
    try {
      validateAgentFreshRuntimeComparisonResult(candidate);
    } catch (error) {
      rejected = error instanceof AgentFreshRuntimeComparisonError;
    }
    assert(rejected);
  }
});

Deno.test('fresh runtime semantic result is invariant when execution order is reversed', async () => {
  const currentFirst = await runFreshRuntimeComparison();
  const variantFirst = await runFreshRuntimeComparison(undefined, 'variant-first');
  assertEquals(JSON.stringify(currentFirst), JSON.stringify(variantFirst));
});
