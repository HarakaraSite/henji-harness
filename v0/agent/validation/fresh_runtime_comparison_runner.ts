import {
  AgentFreshRuntimeComparisonError,
  type AgentFreshRuntimeComparisonResultV1,
  type FreshRuntimeComparisonTestHooks,
} from './fresh_runtime_comparison_contract.ts';
import {
  createFreshRuntimeRunSpecs,
  createFreshRuntimeRunSpecsForTest,
  FRESH_RUNTIME_COMPARISON_CASE,
  validateFreshRuntimeComparisonCase,
} from './fresh_runtime_comparison_case.ts';
import { executeRun, type RunExecution } from './fresh_runtime_comparison_execution.ts';
import {
  runResult,
  validateAgentFreshRuntimeComparisonResult,
} from './fresh_runtime_comparison_result.ts';
import { failureFor, invalid, normalizeTestHooks } from './fresh_runtime_comparison_value.ts';

const runFreshRuntimeComparisonInternal = async (
  comparisonCase: unknown = FRESH_RUNTIME_COMPARISON_CASE,
  executionOrder: 'current-first' | 'variant-first' = 'current-first',
  hooks?: FreshRuntimeComparisonTestHooks,
): Promise<AgentFreshRuntimeComparisonResultV1> => {
  try {
    failureFor(hooks, 'setup', undefined);
    if (executionOrder !== 'current-first' && executionOrder !== 'variant-first') return invalid();
    const snapshot = validateFreshRuntimeComparisonCase(comparisonCase);
    const pair = hooks === undefined
      ? await createFreshRuntimeRunSpecs(snapshot)
      : await createFreshRuntimeRunSpecsForTest(snapshot, hooks, executionOrder);
    let currentExecution: RunExecution;
    let variantExecution: RunExecution;
    if (executionOrder === 'variant-first') {
      variantExecution = await executeRun(pair.variant, 'first', hooks);
      currentExecution = await executeRun(pair.current, 'second', hooks);
    } else {
      currentExecution = await executeRun(pair.current, 'first', hooks);
      variantExecution = await executeRun(pair.variant, 'second', hooks);
    }
    failureFor(hooks, 'correlation', undefined);
    const current = runResult(pair.current, currentExecution);
    const variant = runResult(pair.variant, variantExecution);
    const result = Object.freeze({
      schemaVersion: 1 as const,
      caseId: snapshot.caseId,
      shared: Object.freeze({
        taskIdentifier: snapshot.caseId,
        workspaceEntryCount: 2 as const,
        modelIdentity: snapshot.modelIdentity,
        initialTranscriptCount: 0 as const,
        plannerModelRequestCeiling: snapshot.ceilings.plannerModelRequests,
        maxExternalRequestCeiling: snapshot.ceilings.maxExternalRequests,
        maxWallTimeMicros: snapshot.ceilings.maxWallTimeMicros,
        scriptId: snapshot.scriptId,
        toolFixtureId: snapshot.toolFixtureId,
      }),
      current,
      variant,
      allowedEnvelopeDiff: Object.freeze({
        definitionId: Object.freeze({
          current: current.definitionId,
          variant: variant.definitionId,
        }),
        maxSteps: Object.freeze({ current: current.maxSteps, variant: variant.maxSteps }),
        parentModelRequestCeiling: Object.freeze({
          current: pair.current.envelope.budget.modelRequests.parent as 64,
          variant: pair.variant.envelope.budget.modelRequests.parent as 4,
        }),
        aggregateModelRequestCeiling: Object.freeze({
          current: pair.current.envelope.budget.modelRequests.aggregate as 64,
          variant: pair.variant.envelope.budget.modelRequests.aggregate as 4,
        }),
        manifestIdentity: Object.freeze({
          current: current.manifestIdentity,
          variant: variant.manifestIdentity,
        }),
        envelopeIdentity: Object.freeze({
          current: current.envelopeIdentity,
          variant: variant.envelopeIdentity,
        }),
      }),
      executionDelta: Object.freeze({
        state: Object.freeze({ current: current.state, variant: variant.state }),
        stopReason: Object.freeze({
          current: current.record.outcome.stopReason as 'final',
          variant: variant.record.outcome.stopReason as 'max_steps',
        }),
        committed: Object.freeze({
          current: current.record.outcome.committed,
          variant: variant.record.outcome.committed,
        }),
        modelRequests: Object.freeze({
          current: current.counts.modelRequests,
          variant: variant.counts.modelRequests,
        }),
        externalRequests: Object.freeze({
          current: current.counts.externalRequests,
          variant: variant.counts.externalRequests,
        }),
        steps: Object.freeze({ current: current.counts.steps, variant: variant.counts.steps }),
        toolCalls: Object.freeze({
          current: current.counts.toolCalls,
          variant: variant.counts.toolCalls,
        }),
        toolResults: Object.freeze({
          current: current.counts.toolResults,
          variant: variant.counts.toolResults,
        }),
        durationMicros: Object.freeze({
          current: current.record.durationMicros,
          variant: variant.record.durationMicros,
        }),
        providerTokenUsage: Object.freeze({
          current: 'unsupported' as const,
          variant: 'unsupported' as const,
        }),
        cost: Object.freeze({ current: 'unsupported' as const, variant: 'unsupported' as const }),
      }),
    });
    return validateAgentFreshRuntimeComparisonResult(result);
  } catch {
    throw new AgentFreshRuntimeComparisonError();
  }
};

export const runFreshRuntimeComparison = (
  comparisonCase: unknown = FRESH_RUNTIME_COMPARISON_CASE,
  executionOrder: 'current-first' | 'variant-first' = 'current-first',
): Promise<AgentFreshRuntimeComparisonResultV1> =>
  runFreshRuntimeComparisonInternal(comparisonCase, executionOrder);

/** Test-only bounded runner seam for construction accounting and sanitized fault injection. */
export const runFreshRuntimeComparisonForTest = (
  comparisonCase: unknown = FRESH_RUNTIME_COMPARISON_CASE,
  executionOrder: 'current-first' | 'variant-first' = 'current-first',
  hooks?: FreshRuntimeComparisonTestHooks,
): Promise<AgentFreshRuntimeComparisonResultV1> => {
  try {
    return runFreshRuntimeComparisonInternal(
      comparisonCase,
      executionOrder,
      normalizeTestHooks(hooks),
    );
  } catch {
    return Promise.reject(new AgentFreshRuntimeComparisonError());
  }
};

export const runAgentFreshRuntimeComparison = runFreshRuntimeComparison;
export const createFreshRuntimeComparison = runFreshRuntimeComparison;
