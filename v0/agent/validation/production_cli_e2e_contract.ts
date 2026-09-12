import type { StoredProviderEvidence } from '../provider/provider_evidence.ts';
import { PRODUCTION_PROFILE } from '../provider/provider_profile.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import { DEFAULT_AGENT_MAX_STEPS } from '../definitions/agent_definition.ts';
import type { StoredWorkerExecutionArtifact } from '../worker/worker_execution_artifact.ts';

export const PRODUCTION_CLI_E2E_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_CLI_E2E_TASK_ID = 'production-cli-basic-read-v1' as const;
export const PRODUCTION_CLI_E2E_CONFIRMATION = '--confirm-external-call' as const;
export const PRODUCTION_CLI_E2E_TASK =
  'Use the read tool exactly once to read e2e-input.txt. After receiving the tool result, ' +
  'return exactly the file contents as the final response, with no explanation or formatting. ' +
  'Do not call any other tool and do not infer or invent the contents before using read.';
export const PRODUCTION_CLI_E2E_EXPECTED_REQUESTS = 2 as const;
export const PRODUCTION_CLI_E2E_CHILD_DEADLINE_MS = 120_000 as const;

const PRODUCTION_CLI_E2E_ROUTE_PROFILE_ID = modelRouteProfileId(
  ROOT_DEFAULT_MODEL_SELECTION,
);

export type ProductionCliE2eStage =
  | 'preflight'
  | 'process'
  | 'cli_contract'
  | 'execution_artifact'
  | 'provider_evidence'
  | 'model_behavior';

export type ProductionCliE2eCode =
  | 'invalid_invocation'
  | 'run_layout_failed'
  | 'child_spawn_failed'
  | 'child_deadline'
  | 'child_exit'
  | 'child_stderr'
  | 'child_stdout'
  | 'execution_read_failed'
  | 'execution_count_mismatch'
  | 'execution_contract_mismatch'
  | 'protocol_trace_mismatch'
  | 'evidence_read_failed'
  | 'evidence_count_mismatch'
  | 'evidence_link_mismatch'
  | 'evidence_request_mismatch'
  | 'evidence_runtime_mismatch'
  | 'session_transcript_present';

export interface ProductionCliE2ePaths {
  readonly runRoot: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly noncePath: string;
  readonly childStdoutPath: string;
  readonly childStderrPath: string;
  readonly executionsPath: string;
  readonly evidencePath: string;
}

export interface ProductionCliE2eChildResult {
  readonly started: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

interface ReportBase {
  readonly schemaVersion: typeof PRODUCTION_CLI_E2E_SCHEMA_VERSION;
  readonly taskId: typeof PRODUCTION_CLI_E2E_TASK_ID;
  readonly profile: typeof PRODUCTION_PROFILE.id;
  readonly retryCount: 0;
}

export interface ProductionCliE2eSuccessReport extends ReportBase {
  readonly ok: true;
  readonly outcome: 'passed';
  readonly runRoot: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly noncePath: string;
  readonly childStdoutPath: string;
  readonly childStderrPath: string;
  readonly executionsPath: string;
  readonly evidencePath: string;
  readonly executionId: string;
  readonly providerEvidenceId: string;
  readonly externalRequests: typeof PRODUCTION_CLI_E2E_EXPECTED_REQUESTS;
  readonly steps: 2;
  readonly toolOrder: readonly ['read'];
  readonly stopReason: 'final';
}

export interface ProductionCliE2eFailureReport extends ReportBase {
  readonly ok: false;
  readonly outcome: 'failed';
  readonly stage: ProductionCliE2eStage;
  readonly code: ProductionCliE2eCode;
  readonly detail?: string;
  readonly runRoot: string | null;
  readonly workspaceRoot: string | null;
  readonly stateRoot: string | null;
  readonly noncePath: string | null;
  readonly childStdoutPath: string | null;
  readonly childStderrPath: string | null;
  readonly executionsPath: string | null;
  readonly evidencePath: string | null;
  readonly childStarted: boolean;
  readonly childExitCode: number | null;
  readonly childSignal: string | null;
  readonly executionCount: number | null;
  readonly evidenceCount: number | null;
  readonly executionId: string | null;
  readonly providerEvidenceId: string | null;
  readonly externalRequests: number | null;
}

export type ProductionCliE2eReport =
  | ProductionCliE2eSuccessReport
  | ProductionCliE2eFailureReport;

export interface ProductionCliE2eObservation {
  readonly paths: ProductionCliE2ePaths;
  readonly nonce: string;
  readonly child: ProductionCliE2eChildResult;
  readonly executions: readonly StoredWorkerExecutionArtifact[] | null;
  readonly executionReadError?: string;
  readonly evidence: readonly StoredProviderEvidence[] | null;
  readonly evidenceReadError?: string;
  readonly sessionTranscriptExists: boolean | null;
}

export const preflightFailureReport = (
  code: Extract<ProductionCliE2eCode, 'invalid_invocation' | 'run_layout_failed'>,
  detail?: string,
  paths?: ProductionCliE2ePaths,
): ProductionCliE2eFailureReport => ({
  schemaVersion: PRODUCTION_CLI_E2E_SCHEMA_VERSION,
  taskId: PRODUCTION_CLI_E2E_TASK_ID,
  profile: PRODUCTION_PROFILE.id,
  ok: false,
  outcome: 'failed',
  stage: 'preflight',
  code,
  ...(detail === undefined ? {} : { detail }),
  runRoot: paths?.runRoot ?? null,
  workspaceRoot: paths?.workspaceRoot ?? null,
  stateRoot: paths?.stateRoot ?? null,
  noncePath: paths?.noncePath ?? null,
  childStdoutPath: paths?.childStdoutPath ?? null,
  childStderrPath: paths?.childStderrPath ?? null,
  executionsPath: paths?.executionsPath ?? null,
  evidencePath: paths?.evidencePath ?? null,
  childStarted: false,
  childExitCode: null,
  childSignal: null,
  executionCount: null,
  evidenceCount: null,
  executionId: null,
  providerEvidenceId: null,
  externalRequests: null,
  retryCount: 0,
});

const orderedTrace = (artifact: StoredWorkerExecutionArtifact): boolean => {
  const trace = artifact.protocolTrace;
  let cursor = 0;
  const find = (
    predicate: (entry: StoredWorkerExecutionArtifact['protocolTrace'][number]) => boolean,
  ) => {
    const index = trace.findIndex((entry, position) => position >= cursor && predicate(entry));
    if (index < 0) return false;
    cursor = index + 1;
    return true;
  };
  return find((entry) => entry.semanticSubtype === 'start') &&
    find((entry) => entry.semanticSubtype === 'module_pre_read') &&
    find((entry) => entry.semanticSubtype === 'module_import_start') &&
    find((entry) => entry.semanticSubtype === 'module_imported') &&
    find((entry) => entry.semanticSubtype === 'ready') &&
    find((entry) => entry.semanticSubtype === 'turn') &&
    find((entry) => entry.kind === 'effect_observation') &&
    find((entry) => entry.semanticSubtype === 'commit_proposal') &&
    find((entry) =>
      entry.semanticSubtype === 'commit_acknowledgement' && entry.ackAccepted === true
    ) && find((entry) => entry.semanticSubtype === 'turn_end');
};

const requestMatchesProduction = (record: StoredProviderEvidence['requests'][number]): boolean => {
  if (
    record.response?.status !== 200 || record.sseEvents.length === 0 ||
    record.parserTransitions.length === 0 ||
    record.request.endpoint !== `${PRODUCTION_PROFILE.origin}${PRODUCTION_PROFILE.path}` ||
    record.request.method !== PRODUCTION_PROFILE.method ||
    record.request.lane !== 'parent' || record.request.phase !== 'user_turn' ||
    record.request.requestMetadata.contentType !== 'application/json' ||
    record.request.requestMetadata.redirect !== 'error' ||
    record.request.requestMetadata.responseMode !== 'sse' ||
    record.request.requestMetadata.origin !== 'root_model' ||
    record.request.requestMetadata.provider !== ROOT_DEFAULT_MODEL_SELECTION.provider ||
    record.request.requestMetadata.api !== ROOT_DEFAULT_MODEL_SELECTION.api ||
    record.request.requestMetadata.modelId !== ROOT_DEFAULT_MODEL_SELECTION.modelId ||
    record.request.requestMetadata.authProfile !== ROOT_DEFAULT_MODEL_SELECTION.authProfile ||
    record.request.requestMetadata.protocol !== 'sse'
  ) return false;
  const requestKeys = Object.keys(record.request).sort();
  const expectedRequestKeys = [
    'endpoint',
    'lane',
    'method',
    'modelStep',
    'ordinal',
    'phase',
    'requestBody',
    'requestBodyBytes',
    'requestMetadata',
  ];
  if (
    requestKeys.length !== expectedRequestKeys.length ||
    requestKeys.some((key, index) => key !== expectedRequestKeys[index])
  ) return false;
  const metadataKeys = Object.keys(record.request.requestMetadata).sort();
  const expectedMetadataKeys = [
    'api',
    'authProfile',
    'contentType',
    'modelId',
    'origin',
    'protocol',
    'provider',
    'redirect',
    'responseMode',
  ];
  if (
    metadataKeys.length !== expectedMetadataKeys.length ||
    metadataKeys.some((key, index) => key !== expectedMetadataKeys[index])
  ) {
    return false;
  }
  try {
    const body = JSON.parse(record.request.requestBody) as Record<string, unknown>;
    return body.model === PRODUCTION_PROFILE.model && body.stream === true;
  } catch {
    return false;
  }
};

const runtimeMatchesScenario = (evidence: StoredProviderEvidence, nonce: string): boolean => {
  const completed = evidence.runtimeEvents.filter((event) =>
    event.kind !== 'assistant_progress' && event.kind !== 'tool_progress'
  );
  if (completed.length !== 5) return false;
  const [firstModel, toolCall, toolResult, secondModel, outcome] = completed;
  if (
    firstModel.kind !== 'model_result' || firstModel.modelStep !== 1 ||
    firstModel.result.kind !== 'tool_calls' || firstModel.result.calls.length !== 1
  ) return false;
  const call = firstModel.result.calls[0];
  if (
    call.name !== 'read' || typeof call.arguments !== 'object' || call.arguments === null ||
    Array.isArray(call.arguments) ||
    (call.arguments as Record<string, unknown>).path !== 'e2e-input.txt'
  ) return false;
  if (
    toolCall.kind !== 'tool_call' || toolCall.modelStep !== 1 ||
    toolCall.call.callId !== call.callId || toolCall.call.name !== 'read'
  ) return false;
  if (
    toolResult.kind !== 'tool_result' || toolResult.modelStep !== 1 ||
    toolResult.result.callId !== call.callId || toolResult.result.name !== 'read' ||
    toolResult.result.outcome !== 'success' || toolResult.result.text !== nonce
  ) return false;
  return secondModel.kind === 'model_result' && secondModel.modelStep === 2 &&
    secondModel.result.kind === 'final' && secondModel.result.text === nonce &&
    outcome.kind === 'turn_outcome' && outcome.outcome === 'final';
};

const observedExternalRequests = (
  executions: readonly StoredWorkerExecutionArtifact[] | null,
  evidence: readonly StoredProviderEvidence[] | null,
): number | null => {
  if (evidence !== null) return evidence.reduce((sum, item) => sum + item.requests.length, 0);
  const count = executions?.at(0)?.outcome.runtimeProviderRequestCount;
  return typeof count === 'number' ? count : null;
};

const failure = (
  observation: ProductionCliE2eObservation,
  stage: ProductionCliE2eStage,
  code: ProductionCliE2eCode,
  detail?: string,
): ProductionCliE2eFailureReport => {
  const execution = observation.executions?.at(0);
  const evidence = observation.evidence?.at(0);
  return {
    schemaVersion: PRODUCTION_CLI_E2E_SCHEMA_VERSION,
    taskId: PRODUCTION_CLI_E2E_TASK_ID,
    profile: PRODUCTION_PROFILE.id,
    ok: false,
    outcome: 'failed',
    stage,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...observation.paths,
    childStarted: observation.child.started,
    childExitCode: observation.child.exitCode,
    childSignal: observation.child.signal,
    executionCount: observation.executions?.length ?? null,
    evidenceCount: observation.evidence?.length ?? null,
    executionId: execution?.executionId ?? null,
    providerEvidenceId: execution?.providerEvidenceId ?? evidence?.evidenceId ?? null,
    externalRequests: observedExternalRequests(observation.executions, observation.evidence),
    retryCount: 0,
  };
};

/** Evaluate one retained production CLI run without invoking a provider or reading a credential. */
export const evaluateProductionCliE2e = (
  observation: ProductionCliE2eObservation,
): ProductionCliE2eReport => {
  const { child, executions, evidence, nonce } = observation;
  if (!child.started) {
    return failure(observation, 'process', 'child_spawn_failed', child.error);
  }
  if (child.timedOut) return failure(observation, 'process', 'child_deadline');
  if (child.exitCode !== 0) return failure(observation, 'process', 'child_exit');
  if (child.stderr !== '') return failure(observation, 'cli_contract', 'child_stderr');
  if (child.stdout !== `${nonce}\n`) {
    return failure(observation, 'cli_contract', 'child_stdout');
  }
  if (executions === null) {
    return failure(
      observation,
      'execution_artifact',
      'execution_read_failed',
      observation.executionReadError,
    );
  }
  if (executions.length !== 1) {
    return failure(observation, 'execution_artifact', 'execution_count_mismatch');
  }
  const artifact = executions[0];
  if (
    artifact.agent !== 'default' || artifact.definition.resourceKind !== 'agent-definition' ||
    artifact.definition.resourceId !== 'builtin/default' || artifact.manifest.role !== 'parent' ||
    artifact.manifest.profileId !== PRODUCTION_CLI_E2E_ROUTE_PROFILE_ID ||
    artifact.manifest.maxSteps !== DEFAULT_AGENT_MAX_STEPS ||
    artifact.command.kind !== 'turn' || artifact.command.task !== PRODUCTION_CLI_E2E_TASK ||
    artifact.storeResult !== 'committed' || artifact.acknowledgement !== 'accepted_sent' ||
    artifact.settlement !== 'committed' || artifact.outcome.ok !== true ||
    artifact.outcome.outcome !== 'final' || artifact.outcome.stopReason !== 'final' ||
    artifact.outcome.finalText !== nonce || artifact.outcome.steps !== 2 ||
    artifact.outcome.toolCallCount !== 1 || artifact.outcome.toolResultCount !== 1 ||
    artifact.outcome.turnProviderRequestCount !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS ||
    artifact.outcome.runtimeProviderRequestCount !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS ||
    artifact.providerEvidenceDurability !== 'yes' ||
    typeof artifact.providerEvidenceId !== 'string'
  ) return failure(observation, 'execution_artifact', 'execution_contract_mismatch');
  if (!orderedTrace(artifact)) {
    return failure(observation, 'execution_artifact', 'protocol_trace_mismatch');
  }
  if (evidence === null) {
    return failure(
      observation,
      'provider_evidence',
      'evidence_read_failed',
      observation.evidenceReadError,
    );
  }
  if (evidence.length !== 1) {
    return failure(observation, 'provider_evidence', 'evidence_count_mismatch');
  }
  const retained = evidence[0];
  if (
    retained.evidenceId !== artifact.providerEvidenceId ||
    retained.sessionId !== artifact.sessionId || retained.turnNumber !== artifact.turn ||
    retained.build.buildId !== artifact.build.buildId ||
    JSON.stringify(retained.definition) !== JSON.stringify(artifact.definition)
  ) {
    return failure(observation, 'provider_evidence', 'evidence_link_mismatch');
  }
  if (
    retained.requests.length !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS ||
    retained.requests.some((record, index) =>
      record.request.ordinal !== index + 1 || record.request.modelStep !== index + 1 ||
      !requestMatchesProduction(record)
    ) || retained.turnProviderRequestCount !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS ||
    retained.runtimeProviderRequestCount !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS ||
    retained.outcome !== 'final'
  ) return failure(observation, 'provider_evidence', 'evidence_request_mismatch');
  if (!runtimeMatchesScenario(retained, nonce)) {
    return failure(observation, 'model_behavior', 'evidence_runtime_mismatch');
  }
  if (observation.sessionTranscriptExists !== false) {
    return failure(observation, 'execution_artifact', 'session_transcript_present');
  }
  return {
    schemaVersion: PRODUCTION_CLI_E2E_SCHEMA_VERSION,
    taskId: PRODUCTION_CLI_E2E_TASK_ID,
    profile: PRODUCTION_PROFILE.id,
    ok: true,
    outcome: 'passed',
    ...observation.paths,
    executionId: artifact.executionId,
    providerEvidenceId: retained.evidenceId,
    externalRequests: PRODUCTION_CLI_E2E_EXPECTED_REQUESTS,
    steps: 2,
    toolOrder: ['read'],
    stopReason: 'final',
    retryCount: 0,
  };
};
