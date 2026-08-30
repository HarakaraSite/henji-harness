import {
  type AgentFreshRuntimeComparisonResultV1,
  FRESH_RUNTIME_COMPARISON_CASE_ID,
  validateAgentFreshRuntimeComparisonResult,
} from './fresh_runtime_comparison.ts';

const encoder = new TextEncoder();
const MAX_REPORT_BYTES = 16 * 1024;

const pair = <T>(value: { readonly current: T; readonly variant: T }): string =>
  `${value.current} -> ${value.variant}`;

const causal = (
  result: AgentFreshRuntimeComparisonResultV1['current'],
): string =>
  result.causalToolPath.map((node) => `${node.ordinal}:${node.name}:${node.outcome}`).join(' > ');

/** Render a validated comparison as the fixed, bounded, non-sensitive plain-text report. */
export const renderAgentFreshRuntimeComparisonReport = (value: unknown): string => {
  const result = validateAgentFreshRuntimeComparisonResult(value);
  const lines = [
    'agent_definition_fresh_runtime_comparison',
    'schema_version: 1',
    `case_id: ${FRESH_RUNTIME_COMPARISON_CASE_ID}`,
    'shared:',
    `  task_identifier: ${result.shared.taskIdentifier}`,
    `  workspace_entry_count: ${result.shared.workspaceEntryCount}`,
    `  model_identity: ${result.shared.modelIdentity}`,
    `  initial_transcript_count: ${result.shared.initialTranscriptCount}`,
    `  planner_model_request_ceiling: ${result.shared.plannerModelRequestCeiling}`,
    `  max_external_request_ceiling: ${result.shared.maxExternalRequestCeiling}`,
    `  max_wall_time_micros: ${result.shared.maxWallTimeMicros}`,
    `  script_id: ${result.shared.scriptId}`,
    `  tool_fixture_id: ${result.shared.toolFixtureId}`,
    'current:',
    `  run_ordinal: ${result.current.runOrdinal}`,
    `  definition_id: ${result.current.definitionId}`,
    `  manifest_identity: ${result.current.manifestIdentity}`,
    `  envelope_identity: ${result.current.envelopeIdentity}`,
    `  max_steps: ${result.current.maxSteps}`,
    `  state: ${result.current.state}`,
    `  stop_reason: ${result.current.record.outcome.stopReason}`,
    `  committed: ${result.current.record.outcome.committed}`,
    `  model_requests: ${result.current.counts.modelRequests}`,
    `  external_requests: ${result.current.counts.externalRequests}`,
    `  steps: ${result.current.counts.steps}`,
    `  tool_calls: ${result.current.counts.toolCalls}`,
    `  tool_results: ${result.current.counts.toolResults}`,
    `  causal_tool_path: ${causal(result.current)}`,
    `  duration_micros: ${result.current.record.durationMicros}`,
    `  provider_token_usage: ${result.current.record.usage.providerTokenUsage}`,
    `  cost: ${result.current.record.usage.cost}`,
    'variant:',
    `  run_ordinal: ${result.variant.runOrdinal}`,
    `  definition_id: ${result.variant.definitionId}`,
    `  manifest_identity: ${result.variant.manifestIdentity}`,
    `  envelope_identity: ${result.variant.envelopeIdentity}`,
    `  max_steps: ${result.variant.maxSteps}`,
    `  state: ${result.variant.state}`,
    `  stop_reason: ${result.variant.record.outcome.stopReason}`,
    `  committed: ${result.variant.record.outcome.committed}`,
    `  model_requests: ${result.variant.counts.modelRequests}`,
    `  external_requests: ${result.variant.counts.externalRequests}`,
    `  steps: ${result.variant.counts.steps}`,
    `  tool_calls: ${result.variant.counts.toolCalls}`,
    `  tool_results: ${result.variant.counts.toolResults}`,
    `  causal_tool_path: ${causal(result.variant)}`,
    `  duration_micros: ${result.variant.record.durationMicros}`,
    `  provider_token_usage: ${result.variant.record.usage.providerTokenUsage}`,
    `  cost: ${result.variant.record.usage.cost}`,
    'allowed_envelope_diff:',
    `  definition_id: ${pair(result.allowedEnvelopeDiff.definitionId)}`,
    `  max_steps: ${pair(result.allowedEnvelopeDiff.maxSteps)}`,
    `  parent_model_request_ceiling: ${pair(result.allowedEnvelopeDiff.parentModelRequestCeiling)}`,
    `  aggregate_model_request_ceiling: ${
      pair(result.allowedEnvelopeDiff.aggregateModelRequestCeiling)
    }`,
    `  manifest_identity: ${pair(result.allowedEnvelopeDiff.manifestIdentity)}`,
    `  envelope_identity: ${pair(result.allowedEnvelopeDiff.envelopeIdentity)}`,
    'execution_delta:',
    `  state: ${pair(result.executionDelta.state)}`,
    `  stop_reason: ${pair(result.executionDelta.stopReason)}`,
    `  committed: ${pair(result.executionDelta.committed)}`,
    `  model_requests: ${pair(result.executionDelta.modelRequests)}`,
    `  external_requests: ${pair(result.executionDelta.externalRequests)}`,
    `  steps: ${pair(result.executionDelta.steps)}`,
    `  tool_calls: ${pair(result.executionDelta.toolCalls)}`,
    `  tool_results: ${pair(result.executionDelta.toolResults)}`,
    `  duration_micros: ${pair(result.executionDelta.durationMicros)}`,
    `  provider_token_usage: ${pair(result.executionDelta.providerTokenUsage)}`,
    `  cost: ${pair(result.executionDelta.cost)}`,
  ];
  const report = `${lines.join('\n')}\n`;
  if (encoder.encode(report).byteLength > MAX_REPORT_BYTES) {
    throw new Error('agent fresh-runtime comparison report exceeds bound');
  }
  return report;
};

export const renderFreshRuntimeComparisonReport = renderAgentFreshRuntimeComparisonReport;
export const freshRuntimeComparisonReport = renderAgentFreshRuntimeComparisonReport;
