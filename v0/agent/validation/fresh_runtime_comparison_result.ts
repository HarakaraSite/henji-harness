import type { Message } from '../core/contracts.ts';
import type {
  AgentReplayEnvelopeIdentity,
  AgentReplayEnvelopeV1,
} from '../session/replay_envelope.ts';
import type { AgentResolvedManifestIdentity } from '../definitions/resolved_manifest.ts';
import { type AgentExecutionRecordV1, validateAgentExecutionRecord } from './execution_record.ts';
import {
  type AgentFreshRuntimeCausalToolNode,
  type AgentFreshRuntimeComparisonResultV1,
  type AgentFreshRuntimeRunResult,
  FRESH_RUNTIME_COMPARISON_CASE_ID,
  FRESH_RUNTIME_MAX_WALL_TIME_MICROS,
  FRESH_RUNTIME_MODEL_IDENTITY,
  FRESH_RUNTIME_SCRIPT_ID,
  FRESH_RUNTIME_TASK,
  FRESH_RUNTIME_TOOL_FIXTURE_ID,
  type FreshRuntimeRunSpec,
} from './fresh_runtime_comparison_contract.ts';
import {
  CURRENT_ENVELOPE_ID,
  CURRENT_MANIFEST_ID,
  expectedEnvelopeIdentity,
  expectedManifestIdentity,
  MODEL_ID,
  VARIANT_ENVELOPE_ID,
  VARIANT_MANIFEST_ID,
} from './fresh_runtime_comparison_case.ts';
import { type RunExecution, SCRIPT_CALLS } from './fresh_runtime_comparison_execution.ts';
import {
  equalJson,
  exactArray,
  exactDataProperties,
  invalid,
  plain,
} from './fresh_runtime_comparison_value.ts';

const causalPath = (record: AgentExecutionRecordV1): readonly AgentFreshRuntimeCausalToolNode[] => {
  if (record.toolCalls.length > 32 || record.toolResults.length > 32) return invalid();
  const resultByCall = new Map(record.toolResults.map((result) => [result.callOrdinal, result]));
  return Object.freeze(record.toolCalls.map((call) => {
    const result = resultByCall.get(call.ordinal);
    if (result === undefined) return invalid();
    return Object.freeze({ ordinal: call.ordinal, name: call.name, outcome: result.outcome });
  }));
};

export const runResult = (
  spec: FreshRuntimeRunSpec,
  execution: RunExecution,
): AgentFreshRuntimeRunResult => {
  const record = validateAgentExecutionRecord(execution.record, spec.envelope);
  const expected = spec.side === 'current'
    ? { state: 'completed' as const, stopReason: 'final' as const, model: 5 }
    : { state: 'stopped' as const, stopReason: 'max_steps' as const, model: 4 };
  if (
    record.runOrdinal !== spec.runOrdinal || record.manifestIdentity !== spec.manifest.identity ||
    record.envelopeIdentity !== spec.envelope.identity ||
    record.outcome.stopReason !== expected.stopReason ||
    record.outcome.ok !== (spec.side === 'current') ||
    record.outcome.committed !== execution.committed ||
    record.usage.modelRequests.aggregate !== expected.model ||
    record.usage.steps !== expected.model ||
    record.usage.externalRequests !== 0 || record.usage.toolCalls.aggregate !== 4 ||
    record.usage.toolResults.aggregate !== 4
  ) return invalid();
  const path = causalPath(record);
  if (
    path.length !== 4 ||
    path.some((node, index) =>
      node.ordinal !== index + 1 || node.name !== 'uppercase_text' || node.outcome !== 'success'
    )
  ) return invalid();
  return Object.freeze({
    runOrdinal: spec.runOrdinal,
    definitionId: spec.definitionId,
    manifestIdentity: spec.manifest.identity,
    envelopeIdentity: spec.envelope.identity,
    maxSteps: spec.manifest.parameters.maxSteps as 64 | 4,
    state: expected.state,
    counts: Object.freeze({
      modelRequests: record.usage.modelRequests.aggregate,
      externalRequests: record.usage.externalRequests,
      steps: record.usage.steps,
      toolCalls: record.usage.toolCalls.aggregate,
      toolResults: record.usage.toolResults.aggregate,
    }),
    record,
    causalToolPath: path,
  });
};

const expectedResultShape = (value: unknown): value is AgentFreshRuntimeComparisonResultV1 => {
  if (
    !plain(value) || !exactDataProperties(value, [
      'schemaVersion',
      'caseId',
      'shared',
      'current',
      'variant',
      'allowedEnvelopeDiff',
      'executionDelta',
    ]) || value.schemaVersion !== 1 || value.caseId !== FRESH_RUNTIME_COMPARISON_CASE_ID
  ) return false;
  return true;
};

const validateFixedRunRecord = (
  record: AgentExecutionRecordV1,
  side: 'current' | 'variant',
): void => {
  const expectedModelCalls: Array<{
    readonly ordinal: number;
    readonly role: 'parent';
    readonly roleOrdinal: number;
    readonly resultKind: 'tool_calls' | 'final';
  }> = SCRIPT_CALLS.map((_, index) => ({
    ordinal: index + 1,
    role: 'parent' as const,
    roleOrdinal: index + 1,
    resultKind: 'tool_calls' as const,
  }));
  if (side === 'current') {
    expectedModelCalls.push({
      ordinal: SCRIPT_CALLS.length + 1,
      role: 'parent',
      roleOrdinal: SCRIPT_CALLS.length + 1,
      resultKind: 'final',
    });
  }
  const expectedToolCalls = SCRIPT_CALLS.map((call, index) => ({
    ordinal: index + 1,
    role: 'parent' as const,
    roleOrdinal: index + 1,
    modelCallOrdinal: index + 1,
    callId: call.callId,
    name: call.name,
    arguments: call.arguments,
  }));
  const expectedToolResults = SCRIPT_CALLS.map((call, index) => ({
    ordinal: index + 1,
    role: 'parent' as const,
    roleOrdinal: index + 1,
    callOrdinal: index + 1,
    callId: call.callId,
    name: call.name,
    outcome: 'success' as const,
    terminal: 'none' as const,
    result: { text: (call.arguments as { readonly text: string }).text.toUpperCase() },
  }));
  const expectedTranscript: Message[] = [
    { role: 'user', content: { kind: 'text', text: FRESH_RUNTIME_TASK } },
  ];
  for (let index = 0; index < SCRIPT_CALLS.length; index += 1) {
    const call = SCRIPT_CALLS[index];
    const result = expectedToolResults[index];
    expectedTranscript.push({
      role: 'assistant',
      content: [{ kind: 'tool_call', ...call }],
    });
    expectedTranscript.push({
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: result.callId,
        name: result.name,
        text: result.result.text,
        outcome: result.outcome,
      }],
    });
  }
  if (side === 'current') {
    expectedTranscript.push({
      role: 'assistant',
      content: { kind: 'text', text: 'comparison complete' },
    });
  }
  if (
    !equalJson(record.modelCalls, expectedModelCalls) ||
    !equalJson(record.toolCalls, expectedToolCalls) ||
    !equalJson(record.toolResults, expectedToolResults) ||
    !equalJson(record.transcript, expectedTranscript)
  ) return invalid();
};

/** Validate and freeze the bounded result; no result is accepted as a partial comparison. */
export const validateAgentFreshRuntimeComparisonResult = (
  value: unknown,
): AgentFreshRuntimeComparisonResultV1 => {
  try {
    if (!expectedResultShape(value)) return invalid();
    const shared = value.shared;
    if (
      !plain(shared) || !exactDataProperties(shared, [
        'taskIdentifier',
        'workspaceEntryCount',
        'modelIdentity',
        'initialTranscriptCount',
        'plannerModelRequestCeiling',
        'maxExternalRequestCeiling',
        'maxWallTimeMicros',
        'scriptId',
        'toolFixtureId',
      ]) || shared.taskIdentifier !== FRESH_RUNTIME_COMPARISON_CASE_ID ||
      shared.workspaceEntryCount !== 2 ||
      shared.modelIdentity !== FRESH_RUNTIME_MODEL_IDENTITY ||
      shared.initialTranscriptCount !== 0 ||
      shared.plannerModelRequestCeiling !== 0 || shared.maxExternalRequestCeiling !== 0 ||
      shared.maxWallTimeMicros !== FRESH_RUNTIME_MAX_WALL_TIME_MICROS ||
      shared.scriptId !== FRESH_RUNTIME_SCRIPT_ID ||
      shared.toolFixtureId !== FRESH_RUNTIME_TOOL_FIXTURE_ID
    ) return invalid();
    const current = value.current;
    const variant = value.variant;
    const validateRun = (run: unknown, side: 'current' | 'variant'): AgentFreshRuntimeRunResult => {
      if (
        !plain(run) || !exactDataProperties(run, [
          'runOrdinal',
          'definitionId',
          'manifestIdentity',
          'envelopeIdentity',
          'maxSteps',
          'state',
          'counts',
          'record',
          'causalToolPath',
        ])
      ) return invalid();
      const expected = side === 'current'
        ? {
          ordinal: 1,
          definitionId: 'default',
          maxSteps: 64,
          state: 'completed',
          stop: 'final',
          model: 5,
        }
        : {
          ordinal: 2,
          definitionId: 'default-max-steps-4',
          maxSteps: 4,
          state: 'stopped',
          stop: 'max_steps',
          model: 4,
        };
      if (
        run.runOrdinal !== expected.ordinal || run.definitionId !== expected.definitionId ||
        run.manifestIdentity !== expectedManifestIdentity(side) ||
        run.envelopeIdentity !== expectedEnvelopeIdentity(side) ||
        run.maxSteps !== expected.maxSteps || run.state !== expected.state
      ) return invalid();
      const counts = run.counts;
      if (
        !plain(counts) ||
        !exactDataProperties(counts, [
          'modelRequests',
          'externalRequests',
          'steps',
          'toolCalls',
          'toolResults',
        ]) ||
        counts.modelRequests !== expected.model || counts.externalRequests !== 0 ||
        counts.steps !== expected.model || counts.toolCalls !== 4 || counts.toolResults !== 4
      ) return invalid();
      const path = run.causalToolPath;
      if (!exactArray(path) || path.length !== 4) return invalid();
      for (let index = 0; index < path.length; index += 1) {
        const node = path[index];
        if (
          !plain(node) || !exactDataProperties(node, ['ordinal', 'name', 'outcome']) ||
          node.ordinal !== index + 1 || node.name !== 'uppercase_text' || node.outcome !== 'success'
        ) return invalid();
      }
      const nodes = path as readonly AgentFreshRuntimeCausalToolNode[];
      const record = validateAgentExecutionRecord(run.record, {
        schemaVersion: 1,
        caseId: FRESH_RUNTIME_COMPARISON_CASE_ID,
        task: FRESH_RUNTIME_TASK,
        workspace: { entries: [] },
        modelIdentity: FRESH_RUNTIME_MODEL_IDENTITY,
        budget: {
          maxSteps: run.maxSteps,
          modelRequests: { parent: run.maxSteps, planner: 0, aggregate: run.maxSteps },
          maxExternalRequests: 0,
          maxWallTimeMicros: FRESH_RUNTIME_MAX_WALL_TIME_MICROS,
        },
        initialTranscript: [],
        manifest: {
          schemaVersion: 1,
          definitionId: run.definitionId,
          resources: [],
          parameters: { maxSteps: run.maxSteps },
          identity: run.manifestIdentity,
        },
        identity: run.envelopeIdentity,
      } as unknown as AgentReplayEnvelopeV1);
      validateFixedRunRecord(record, side);
      if (
        record.outcome.stopReason !== expected.stop ||
        record.outcome.committed !== (side === 'current') ||
        record.runOrdinal !== expected.ordinal ||
        record.manifestIdentity !== expectedManifestIdentity(side) ||
        record.envelopeIdentity !== expectedEnvelopeIdentity(side) ||
        record.usage.steps !== expected.model ||
        record.usage.modelRequests.parent !== expected.model ||
        record.usage.modelRequests.planner !== 0 ||
        record.usage.modelRequests.aggregate !== expected.model ||
        record.usage.externalRequests !== 0 ||
        record.usage.toolCalls.parent !== 4 || record.usage.toolCalls.planner !== 0 ||
        record.usage.toolCalls.aggregate !== 4 ||
        record.usage.toolResults.parent !== 4 || record.usage.toolResults.planner !== 0 ||
        record.usage.toolResults.aggregate !== 4 ||
        record.usage.providerTokenUsage !== 'unsupported' || record.usage.cost !== 'unsupported'
      ) return invalid();
      return Object.freeze({
        runOrdinal: run.runOrdinal as 1 | 2,
        definitionId: run.definitionId as 'default' | 'default-max-steps-4',
        manifestIdentity: run.manifestIdentity as AgentResolvedManifestIdentity,
        envelopeIdentity: run.envelopeIdentity as AgentReplayEnvelopeIdentity,
        maxSteps: run.maxSteps as 64 | 4,
        state: run.state as 'completed' | 'stopped',
        counts: Object.freeze({
          modelRequests: counts.modelRequests,
          externalRequests: counts.externalRequests,
          steps: counts.steps,
          toolCalls: counts.toolCalls,
          toolResults: counts.toolResults,
        }),
        record,
        causalToolPath: Object.freeze(nodes.map((node) =>
          Object.freeze({
            ordinal: node.ordinal,
            name: node.name,
            outcome: node.outcome,
          })
        )),
      }) as unknown as AgentFreshRuntimeRunResult;
    };
    const validatedCurrent = validateRun(current, 'current');
    const validatedVariant = validateRun(variant, 'variant');
    const allowed = value.allowedEnvelopeDiff;
    if (
      !plain(allowed) || !exactDataProperties(allowed, [
        'definitionId',
        'maxSteps',
        'parentModelRequestCeiling',
        'aggregateModelRequestCeiling',
        'manifestIdentity',
        'envelopeIdentity',
      ])
    ) return invalid();
    const pairKeys = [
      ['definitionId', 'default', 'default-max-steps-4'],
      ['maxSteps', 64, 4],
      ['parentModelRequestCeiling', 64, 4],
      ['aggregateModelRequestCeiling', 64, 4],
      ['manifestIdentity', CURRENT_MANIFEST_ID, VARIANT_MANIFEST_ID],
      ['envelopeIdentity', CURRENT_ENVELOPE_ID, VARIANT_ENVELOPE_ID],
    ] as const;
    for (const [key, expectedCurrent, expectedVariant] of pairKeys) {
      const pair = allowed[key];
      if (
        !plain(pair) || !exactDataProperties(pair, ['current', 'variant']) ||
        pair.current !== expectedCurrent || pair.variant !== expectedVariant
      ) return invalid();
    }
    const delta = value.executionDelta;
    if (
      !plain(delta) || !exactDataProperties(delta, [
        'state',
        'stopReason',
        'committed',
        'modelRequests',
        'externalRequests',
        'steps',
        'toolCalls',
        'toolResults',
        'durationMicros',
        'providerTokenUsage',
        'cost',
      ])
    ) return invalid();
    const deltaValues = [
      ['state', 'completed', 'stopped'],
      ['stopReason', 'final', 'max_steps'],
      ['committed', true, false],
      ['modelRequests', 5, 4],
      ['externalRequests', 0, 0],
      ['steps', 5, 4],
      ['toolCalls', 4, 4],
      ['toolResults', 4, 4],
      ['providerTokenUsage', 'unsupported', 'unsupported'],
      ['cost', 'unsupported', 'unsupported'],
    ] as const;
    for (const [key, expectedCurrent, expectedVariant] of deltaValues) {
      const pair = delta[key];
      if (
        !plain(pair) || !exactDataProperties(pair, ['current', 'variant']) ||
        pair.current !== expectedCurrent || pair.variant !== expectedVariant
      ) return invalid();
    }
    const duration = delta.durationMicros;
    if (
      !plain(duration) || !exactDataProperties(duration, ['current', 'variant']) ||
      duration.current !== validatedCurrent.record.durationMicros ||
      duration.variant !== validatedVariant.record.durationMicros
    ) return invalid();
    return Object.freeze({
      schemaVersion: 1 as const,
      caseId: FRESH_RUNTIME_COMPARISON_CASE_ID,
      shared: Object.freeze({ ...shared, modelIdentity: MODEL_ID }),
      current: validatedCurrent,
      variant: validatedVariant,
      allowedEnvelopeDiff: Object.freeze({
        definitionId: Object.freeze({ ...allowed.definitionId }),
        maxSteps: Object.freeze({ ...allowed.maxSteps }),
        parentModelRequestCeiling: Object.freeze({ ...allowed.parentModelRequestCeiling }),
        aggregateModelRequestCeiling: Object.freeze({ ...allowed.aggregateModelRequestCeiling }),
        manifestIdentity: Object.freeze({ ...allowed.manifestIdentity }),
        envelopeIdentity: Object.freeze({ ...allowed.envelopeIdentity }),
      }),
      executionDelta: Object.freeze({
        state: Object.freeze({ ...delta.state }),
        stopReason: Object.freeze({ ...delta.stopReason }),
        committed: Object.freeze({ ...delta.committed }),
        modelRequests: Object.freeze({ ...delta.modelRequests }),
        externalRequests: Object.freeze({ ...delta.externalRequests }),
        steps: Object.freeze({ ...delta.steps }),
        toolCalls: Object.freeze({ ...delta.toolCalls }),
        toolResults: Object.freeze({ ...delta.toolResults }),
        durationMicros: Object.freeze({ ...delta.durationMicros }),
        providerTokenUsage: Object.freeze({ ...delta.providerTokenUsage }),
        cost: Object.freeze({ ...delta.cost }),
      }),
    });
  } catch {
    return invalid();
  }
};
