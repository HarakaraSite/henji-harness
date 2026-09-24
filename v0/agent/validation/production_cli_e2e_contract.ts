import type { StoredExecutionEvent } from '../history/history_store_contract.ts';
import { PRODUCTION_PROFILE } from '../provider/provider_profile.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import { DEFAULT_AGENT_MAX_STEPS } from '../definitions/agent_definition.ts';
import type { StoredWorkerExecutionArtifact } from '../worker/worker_execution_artifact.ts';

export const PRODUCTION_CLI_E2E_SCHEMA_VERSION = 2 as const;
export const PRODUCTION_CLI_E2E_TASK_ID = 'production-cli-basic-read-v1' as const;
export const PRODUCTION_CLI_E2E_CONFIRMATION = '--confirm-external-call' as const;
export const PRODUCTION_CLI_E2E_TASK =
  'Use the read tool exactly once to read e2e-input.txt. After receiving the tool result, ' +
  'return exactly the file contents as the final response, with no explanation or formatting. ' +
  'Do not call any other tool and do not infer or invent the contents before using read.';
export const PRODUCTION_CLI_E2E_EXPECTED_REQUESTS = 2 as const;
export const PRODUCTION_CLI_E2E_CHILD_DEADLINE_MS = 120_000 as const;

const ROUTE_PROFILE_ID = modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION);

export type ProductionCliE2eStage =
  | 'preflight'
  | 'process'
  | 'cli_contract'
  | 'execution_artifact'
  | 'history'
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
  | 'history_read_failed'
  | 'request_fact_mismatch'
  | 'tool_history_mismatch'
  | 'session_transcript_present';

export interface ProductionCliE2ePaths {
  readonly runRoot: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly noncePath: string;
  readonly childStdoutPath: string;
  readonly childStderrPath: string;
  readonly executionsPath: string;
  readonly historyPath: string;
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
  readonly historyPath: string;
  readonly executionId: string;
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
  readonly historyPath: string | null;
  readonly childStarted: boolean;
  readonly childExitCode: number | null;
  readonly childSignal: string | null;
  readonly executionCount: number | null;
  readonly historyEventCount: number | null;
  readonly executionId: string | null;
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
  readonly historyEvents: readonly StoredExecutionEvent[] | null;
  readonly historyReadError?: string;
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
  historyPath: paths?.historyPath ?? null,
  childStarted: false,
  childExitCode: null,
  childSignal: null,
  executionCount: null,
  historyEventCount: null,
  executionId: null,
  externalRequests: null,
  retryCount: 0,
});

const observationOf = (event: StoredExecutionEvent): Record<string, unknown> | undefined => {
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.observation === 'object' && payload.observation !== null
    ? payload.observation as Record<string, unknown>
    : undefined;
};

const runtimeOf = (event: StoredExecutionEvent): Record<string, unknown> | undefined => {
  if (event.kind !== 'runtime_event') return undefined;
  const observation = observationOf(event);
  return observation?.kind === 'runtime_event' &&
      typeof observation.event === 'object' && observation.event !== null
    ? observation.event as Record<string, unknown>
    : undefined;
};

const validRequestFacts = (events: readonly StoredExecutionEvent[]): boolean => {
  const starts = events.filter((event) => event.kind === 'provider_request_start');
  const responses = events.filter((event) => event.kind === 'provider_response_start');
  if (
    starts.length !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS ||
    responses.length !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS
  ) return false;
  return starts.every((event, index) => {
    const request = observationOf(event)?.request as Record<string, unknown> | undefined;
    const metadata = request?.requestMetadata as Record<string, unknown> | undefined;
    const response = responses.find((item) =>
      observationOf(item)?.requestOrdinal === request?.ordinal
    );
    const result = response === undefined
      ? undefined
      : observationOf(response)?.response as Record<string, unknown> | undefined;
    return request?.ordinal === index + 1 &&
      request.contextRequestOrdinal === index + 1 &&
      request.modelStep === index + 1 &&
      request.lane === 'parent' &&
      request.endpoint === PRODUCTION_PROFILE.origin + PRODUCTION_PROFILE.path &&
      metadata?.provider === ROOT_DEFAULT_MODEL_SELECTION.provider &&
      metadata.api === ROOT_DEFAULT_MODEL_SELECTION.api &&
      metadata.modelId === ROOT_DEFAULT_MODEL_SELECTION.modelId &&
      result?.status === 200;
  });
};

const validToolHistory = (events: readonly StoredExecutionEvent[], nonce: string): boolean => {
  const runtime = events.map(runtimeOf).filter((event) => event !== undefined);
  const completed = runtime.filter((event) =>
    event.kind === 'model_result' || event.kind === 'tool_call' || event.kind === 'tool_result'
  );
  if (completed.length !== 4) return false;
  const [firstModel, call, result, secondModel] = completed;
  const modelResult = firstModel.result as Record<string, unknown> | undefined;
  const calls = modelResult?.calls as Record<string, unknown>[] | undefined;
  const toolCall = call.call as Record<string, unknown> | undefined;
  const toolResult = result.result as Record<string, unknown> | undefined;
  const final = secondModel.result as Record<string, unknown> | undefined;
  return firstModel.kind === 'model_result' && firstModel.modelStep === 1 &&
    modelResult?.kind === 'tool_calls' && calls?.length === 1 &&
    call.kind === 'tool_call' && toolCall?.name === 'read' &&
    (toolCall.arguments as Record<string, unknown> | undefined)?.path === 'e2e-input.txt' &&
    result.kind === 'tool_result' && toolResult?.callId === toolCall.callId &&
    toolResult?.name === 'read' && toolResult.outcome === 'success' &&
    toolResult.text === nonce && secondModel.kind === 'model_result' &&
    secondModel.modelStep === 2 && final?.kind === 'final' && final.text === nonce;
};

const failure = (
  observation: ProductionCliE2eObservation,
  stage: ProductionCliE2eStage,
  code: ProductionCliE2eCode,
  detail?: string,
): ProductionCliE2eFailureReport => {
  const execution = observation.executions?.at(0);
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
    historyEventCount: observation.historyEvents?.length ?? null,
    executionId: execution?.executionId ?? null,
    externalRequests: execution?.outcome?.runtimeProviderRequestCount ?? null,
    retryCount: 0,
  };
};

export const evaluateProductionCliE2e = (
  observation: ProductionCliE2eObservation,
): ProductionCliE2eReport => {
  const { child, executions, historyEvents, nonce } = observation;
  if (!child.started) return failure(observation, 'process', 'child_spawn_failed', child.error);
  if (child.timedOut) return failure(observation, 'process', 'child_deadline');
  if (child.exitCode !== 0) return failure(observation, 'process', 'child_exit');
  if (child.stderr !== '') return failure(observation, 'cli_contract', 'child_stderr');
  if (child.stdout !== nonce + '\n') return failure(observation, 'cli_contract', 'child_stdout');
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
  const outcome = artifact.outcome;
  if (
    artifact.agent !== 'default' || artifact.definition.resourceKind !== 'agent-definition' ||
    artifact.definition.resourceId !== 'builtin/default' || artifact.manifest.role !== 'parent' ||
    artifact.manifest.profileId !== ROUTE_PROFILE_ID ||
    artifact.manifest.maxSteps !== DEFAULT_AGENT_MAX_STEPS ||
    artifact.command.kind !== 'turn' || artifact.command.task !== PRODUCTION_CLI_E2E_TASK ||
    artifact.storeResult !== 'committed' || artifact.acknowledgement !== 'accepted_sent' ||
    artifact.settlement !== 'committed' || outcome?.ok !== true ||
    outcome.outcome !== 'final' || outcome.stopReason !== 'final' ||
    outcome.finalText !== nonce || outcome.steps !== 2 ||
    outcome.toolCallCount !== 1 || outcome.toolResultCount !== 1 ||
    outcome.turnProviderRequestCount !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS ||
    outcome.runtimeProviderRequestCount !== PRODUCTION_CLI_E2E_EXPECTED_REQUESTS
  ) return failure(observation, 'execution_artifact', 'execution_contract_mismatch');
  if (historyEvents === null) {
    return failure(observation, 'history', 'history_read_failed', observation.historyReadError);
  }
  if (!validRequestFacts(historyEvents)) {
    return failure(observation, 'history', 'request_fact_mismatch');
  }
  if (!validToolHistory(historyEvents, nonce)) {
    return failure(observation, 'model_behavior', 'tool_history_mismatch');
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
    externalRequests: PRODUCTION_CLI_E2E_EXPECTED_REQUESTS,
    steps: 2,
    toolOrder: ['read'],
    stopReason: 'final',
    retryCount: 0,
  };
};
