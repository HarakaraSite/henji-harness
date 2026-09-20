import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { JsonValue, LoopOutcome, Message } from '../core/contracts.ts';
import {
  type ProviderEvidenceParserTransition,
  type ProviderEvidenceRequestRecord,
  type ProviderEvidenceRuntimeEvent,
  type ProviderEvidenceSseEvent,
  type ProviderEvidenceStore,
  type ProviderEvidenceV3,
  type ProviderEvidenceV4,
  type ProviderEvidenceV5,
  type StoredProviderEvidence,
  validateProviderEvidence,
  validateProviderEvidenceObservation,
  validateProviderEvidenceV1,
} from '../provider/provider_evidence.ts';
import { isJsonValue } from '../provider/openrouter_value.ts';
import { isModelSelection } from '../provider/model_catalog.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import {
  canonicalJson,
  canonicalJsonBytes,
  type ContextBlobInput,
  type ContextModelRequestDelta,
  type ContextModelRequestRecord,
  type ContextOccurrenceInput,
  type ContextRelationStage,
  type ContextRequestPurpose,
  type ContextSourceRelation,
  type ExecutionContextManifestV2,
  type ExecutionContextRelation,
  jsonBlob,
  textBlob,
  validateContextModelRequestDelta,
  validateContextModelRequestRecord,
  validateExecutionContextManifest,
  validateWorkerContextSnapshot,
  type WorkerContextSnapshot,
} from './context_attribution.ts';
import { ProviderEvidenceStoreError } from '../provider/provider_evidence_store.ts';
import {
  decodeFailureDiagnostic,
  encodeFailureDiagnostic,
  type FailureDiagnosticV1,
  validateFailureDiagnostic,
} from '../session/failure_diagnostic.ts';
import {
  type FailureDiagnosticStore,
  FailureDiagnosticStoreError,
  MAX_FAILURE_DIAGNOSTIC_BYTES,
  MAX_FAILURE_DIAGNOSTICS,
} from '../session/failure_diagnostic_store.ts';
import {
  type DefinitionRevisionRef,
  isSessionId,
  MAX_VALID_SESSIONS_PER_WORKSPACE,
  type SemanticContextCheckpointV1,
  type SessionRecord,
  SessionStoreError,
  type StoredSessionRecord,
  type WorkerSessionHandle,
  type WorkerSessionListResult,
  type WorkerSessionStorePort,
} from '../session/session_store_contract.ts';
import {
  causalTranscriptIndex,
  metadataFromStoredRecord,
  validateSemanticContextCheckpoint,
  validateSessionRecordV6,
  validRevisionRef,
} from '../session/session_record_codec.ts';
import { acquireLock, ensureDirectory, type Lock } from '../session/deno_session_store_io.ts';
import { sessionPaths, workspaceDigest } from '../session/session_store_paths.ts';
import { isBuildManifest } from '../runtime/build_manifest.ts';
import {
  type StoredWorkerExecutionArtifact,
  validateWorkerExecutionArtifact,
  type WorkerExecutionArtifactV5,
  type WorkerExecutionArtifactV7,
} from '../worker/worker_execution_artifact.ts';
import { recalledExecutionProjectionText } from '../worker/recalled_execution_context.ts';
import type { WorkerReadyMessage } from '../worker/worker_protocol.ts';
import { WORKER_STAGE_CODES } from '../worker/worker_stage_probe.ts';
import {
  type WorkerExecutionArtifactStore,
  WorkerExecutionArtifactStoreError,
} from '../worker/worker_execution_artifact_store.ts';
import type {
  BeginExecutionInput,
  CanonicalTurnCommitInput,
  ExecutionEventInput,
  ExecutionEventKind,
  ExecutionOutcome,
  HistoryCaptureResult,
  HistoryExecutionInput,
  HistoryPersistencePort,
  HistoryStoreErrorCode,
  NonCanonicalExecutionInput,
  ReconcileExecutionInput,
  StoredExecutionEffect,
  StoredExecutionEvent,
  StoredExecutionRow,
} from './history_store_contract.ts';
import { HistoryStoreError } from './history_store_contract.ts';
import {
  chunkHumanHistoryDetail,
  HUMAN_HISTORY_DETAIL_SCALARS,
  HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
  HUMAN_HISTORY_PAGE_EXECUTIONS,
  type HumanHistoryCursorV1,
  type HumanHistoryDetailChunkV1,
  type HumanHistoryEntryV1,
  type HumanHistoryExportRecordV1,
  type HumanHistoryPageRequest,
  type HumanHistoryPageV1,
  type HumanHistoryProjectionInput,
  type HumanHistoryReadPort,
  type HumanHistorySearchHitV1,
  type HumanHistorySearchRequest,
  projectHumanHistoryExecution,
} from './human_history.ts';

const SCHEMA_VERSION = 5;
const BUSY_TIMEOUT_MS = 250;
const encoder = new TextEncoder();
const contextDigestSync = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const contextManifestDigestSync = (
  manifest: Pick<
    ExecutionContextManifestV2,
    | 'schemaVersion'
    | 'requestCount'
    | 'requests'
    | 'externalRelations'
  >,
): string =>
  contextDigestSync(
    canonicalJsonBytes(
      manifest as unknown as import('../core/contracts.ts').JsonValue,
    ),
  );
const contextOccurrenceDigestSync = (
  occurrence: Pick<
    ContextOccurrenceInput,
    'occurrenceId' | 'kind' | 'content' | 'sourceRelations'
  >,
): string =>
  contextDigestSync(canonicalJsonBytes({
    occurrenceId: occurrence.occurrenceId,
    kind: occurrence.kind,
    content: occurrence.content,
    sourceRelations: occurrence.sourceRelations.map((source) => ({
      ...source,
      contentDigest: source.contentDigest ?? occurrence.content.digest,
    })),
  } as unknown as JsonValue));
const contextRevisionDigestSync = (
  delta: Pick<
    ContextModelRequestDelta,
    | 'lane'
    | 'purpose'
    | 'baseRevisionDigest'
    | 'resultItemCount'
    | 'splices'
  >,
): string =>
  contextDigestSync(canonicalJsonBytes({
    schemaVersion: 2,
    lane: delta.lane,
    sequenceKind: delta.purpose,
    baseRevisionDigest: delta.baseRevisionDigest ?? null,
    splices: delta.splices,
    resultItemCount: delta.resultItemCount,
  } as unknown as JsonValue));
const decoder = new TextDecoder();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HUMAN_CURSOR_PREFIX = 'h1:';

const scalarMatchOffsets = (text: string, query: string): readonly number[] => {
  const source = [...text];
  const needle = [...query];
  const offsets: number[] = [];
  if (needle.length === 0 || needle.length > source.length) return offsets;
  for (let offset = 0; offset <= source.length - needle.length; offset += 1) {
    let matches = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (source[offset + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) offsets.push(offset);
  }
  return offsets;
};

const uint8ToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const encodeHumanCursor = (cursor: HumanHistoryCursorV1): string =>
  `${HUMAN_CURSOR_PREFIX}${btoa(JSON.stringify(cursor))}`;

const decodeHumanCursor = (
  value: string | undefined,
): HumanHistoryCursorV1 | undefined => {
  if (value === undefined || !value.startsWith(HUMAN_CURSOR_PREFIX)) {
    return undefined;
  }
  try {
    const cursor = JSON.parse(
      atob(value.slice(HUMAN_CURSOR_PREFIX.length)),
    ) as Partial<
      HumanHistoryCursorV1
    >;
    if (
      cursor.schemaVersion !== 1 || !Number.isSafeInteger(cursor.turn) ||
      Number(cursor.turn) < 1 || typeof cursor.createdAt !== 'string' ||
      !ISO_TIMESTAMP.test(cursor.createdAt) ||
      typeof cursor.executionId !== 'string' ||
      !UUID_V4.test(cursor.executionId)
    ) return undefined;
    return cursor as HumanHistoryCursorV1;
  } catch {
    return undefined;
  }
};

const humanCursorFor = (row: StoredExecutionRow): HumanHistoryCursorV1 => ({
  schemaVersion: 1,
  turn: row.turn,
  createdAt: row.createdAt,
  executionId: row.executionId,
});

const isHumanTextContent = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (value as { readonly kind?: unknown }).kind === 'text' &&
  typeof (value as { readonly text?: unknown }).text === 'string';

const isHumanToolCall = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (value as { readonly kind?: unknown }).kind === 'tool_call' &&
  typeof (value as { readonly callId?: unknown }).callId === 'string' &&
  typeof (value as { readonly name?: unknown }).name === 'string' &&
  isJsonValue((value as { readonly arguments?: unknown }).arguments);

const isHumanToolResult = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (value as { readonly kind?: unknown }).kind === 'tool_result' &&
  typeof (value as { readonly callId?: unknown }).callId === 'string' &&
  typeof (value as { readonly name?: unknown }).name === 'string' &&
  typeof (value as { readonly text?: unknown }).text === 'string' &&
  ((value as { readonly outcome?: unknown }).outcome === 'success' ||
    (value as { readonly outcome?: unknown }).outcome === 'error');

const isHumanMessage = (value: unknown): value is Message => {
  if (
    !isJsonValue(value) || typeof value !== 'object' || value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const message = value as {
    readonly role?: unknown;
    readonly content?: unknown;
    readonly text?: unknown;
  };
  if (message.role === 'user') return isHumanTextContent(message.content);
  if (message.role === 'assistant') {
    return isHumanTextContent(message.content) ||
      Array.isArray(message.content) &&
        message.content.every(isHumanToolCall) &&
        (message.text === undefined || typeof message.text === 'string');
  }
  return message.role === 'tool' && Array.isArray(message.content) &&
    message.content.every(isHumanToolResult);
};

const parseCanonicalMessage = (value: unknown): Message => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new HistoryStoreError('history_invalid');
  }
  if (!isHumanMessage(parsed)) throw new HistoryStoreError('history_invalid');
  if (parsed.role === 'user') {
    return {
      role: 'user',
      content: { kind: 'text', text: parsed.content.text },
    };
  }
  if (parsed.role === 'assistant') {
    const content = Array.isArray(parsed.content)
      ? parsed.content.map((call) => ({
        kind: 'tool_call' as const,
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      }))
      : {
        kind: 'text' as const,
        text: (parsed.content as import('../core/contracts.ts').TextContent).text,
      };
    return {
      role: 'assistant',
      content,
      ...(parsed.text === undefined ? {} : { text: parsed.text }),
      ...(parsed.providerState === undefined
        ? {}
        : { providerState: structuredClone(parsed.providerState) }),
    };
  }
  return {
    role: 'tool',
    content: parsed.content.map((result) => ({
      kind: 'tool_result' as const,
      callId: result.callId,
      name: result.name,
      text: result.text,
      outcome: result.outcome,
      ...('terminal' in result ? { terminal: result.terminal } : {}),
    })),
  };
};
const EXECUTION_EVENT_KINDS: ReadonlySet<ExecutionEventKind> = new Set([
  'execution_admitted',
  'turn_dispatch_requested',
  'turn_dispatch_sent',
  'turn_dispatch_failed',
  'cancel_requested',
  'cancel_sent',
  'cancel_failed',
  'cancel_received',
  'cancel_escalated',
  'worker_stage_snapshot',
  'steer_requested',
  'steer_sent',
  'steer_failed',
  'acknowledgement_requested',
  'acknowledgement_sent',
  'acknowledgement_failed',
  'runtime_event',
  'effect_observation',
  'provider_request_start',
  'provider_response_start',
  'provider_response_bytes',
  'provider_sse_event',
  'provider_parser_transition',
  'context_observation',
  'execution_settled',
  'execution_reconciled',
]);
const HOST_EXECUTION_EVENT_KINDS: ReadonlySet<ExecutionEventKind> = new Set([
  'execution_admitted',
  'turn_dispatch_requested',
  'turn_dispatch_sent',
  'turn_dispatch_failed',
  'cancel_requested',
  'cancel_sent',
  'cancel_failed',
  'cancel_escalated',
  'worker_stage_snapshot',
  'steer_requested',
  'steer_sent',
  'steer_failed',
  'acknowledgement_requested',
  'acknowledgement_sent',
  'acknowledgement_failed',
  'execution_settled',
  'execution_reconciled',
]);

type SqlRow = Record<string, unknown>;

const historyCode = (error: unknown): HistoryStoreErrorCode => {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked/u.test(message)
    ? 'history_busy'
    : 'history_io_failure';
};

const sessionError = (error: unknown): SessionStoreError => {
  if (error instanceof SessionStoreError) return error;
  if (error instanceof HistoryStoreError) {
    return new SessionStoreError(
      error.code === 'history_busy'
        ? 'session_busy'
        : error.code === 'history_invalid'
        ? 'session_invalid'
        : 'session_io_failure',
    );
  }
  return new SessionStoreError(
    historyCode(error) === 'history_busy' ? 'session_busy' : 'session_io_failure',
  );
};

const historyError = (error: unknown): HistoryStoreError =>
  error instanceof HistoryStoreError ? error : new HistoryStoreError(historyCode(error));

const normalizedOutcome = (outcome: LoopOutcome): ExecutionOutcome =>
  outcome.outcome === 'final' || outcome.outcome === 'tool_terminal'
    ? 'completed'
    : outcome.outcome === 'cancelled'
    ? 'cancelled'
    : 'failed';

const jsonPayload = (
  value: unknown,
): import('../core/contracts.ts').JsonValue => {
  try {
    if (!isJsonValue(value)) throw new Error('payload is not JSON');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('payload is not JSON');
    return JSON.parse(encoded) as import('../core/contracts.ts').JsonValue;
  } catch {
    throw new HistoryStoreError('history_invalid');
  }
};

const exactObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
};
const validText = (value: unknown, allowEmpty = false): value is string =>
  typeof value === 'string' && (allowEmpty || value.length > 0) &&
  !value.includes('\0');
const validPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const validNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  isJsonValue(value);
const validCorrelation = (value: unknown): boolean =>
  exactObject(value, [
    'session',
    'instanceCorrelation',
    'workerGeneration',
    'baseStateRevision',
    'command',
  ]) && validText(value.session) && validText(value.instanceCorrelation) &&
  validText(value.workerGeneration) &&
  validPositiveInteger(value.baseStateRevision) &&
  validText(value.command);
const validToolCall = (value: unknown): boolean =>
  exactObject(value, ['callId', 'name', 'arguments']) &&
  validText(value.callId) &&
  validText(value.name) && isJsonValue(value.arguments);
const validToolResult = (value: unknown): boolean =>
  exactObject(value, ['kind', 'callId', 'name', 'text', 'outcome'], [
    'terminal',
  ]) &&
  value.kind === 'tool_result' && validText(value.callId) &&
  validText(value.name) &&
  typeof value.text === 'string' &&
  (value.outcome === 'success' || value.outcome === 'error') &&
  (value.terminal === undefined || value.terminal === 'json_result') &&
  (value.terminal === undefined || value.outcome === 'success');
const validUserMessage = (value: unknown): boolean =>
  exactObject(value, ['role', 'content']) && value.role === 'user' &&
  exactObject(value.content, ['kind', 'text']) &&
  value.content.kind === 'text' &&
  typeof value.content.text === 'string';
const validAssistantMessage = (value: unknown): boolean => {
  if (
    !exactObject(value, ['role', 'content'], ['text', 'providerState']) ||
    value.role !== 'assistant'
  ) {
    return false;
  }
  const contentValid = typeof value.content === 'object' && value.content !== null &&
      !Array.isArray(value.content) &&
      exactObject(value.content, ['kind', 'text']) &&
      value.content.kind === 'text' && typeof value.content.text === 'string' ||
    Array.isArray(value.content) &&
      value.content.every((call) =>
        exactObject(call, ['kind', 'callId', 'name', 'arguments']) &&
        call.kind === 'tool_call' &&
        validText(call.callId) && validText(call.name) &&
        isJsonValue(call.arguments)
      );
  return contentValid &&
    (value.text === undefined || typeof value.text === 'string') &&
    (value.providerState === undefined ||
      validProviderState(value.providerState));
};
const validProviderState = (value: unknown): boolean =>
  value === undefined ||
  (exactObject(value, ['provider', 'reasoningDetails']) &&
    value.provider === 'openrouter-chat' &&
    Array.isArray(value.reasoningDetails) &&
    value.reasoningDetails.every(isJsonValue)) ||
  (exactObject(value, ['provider', 'replayItems'], ['model']) &&
    typeof value.provider === 'string' && value.provider.length > 0 &&
    Array.isArray(value.replayItems) && value.replayItems.every(isJsonValue) &&
    (value.model === undefined ||
      (typeof value.model === 'string' && value.model.length > 0)));
const validMessage = (value: unknown): boolean => {
  if (!validJsonObject(value) || typeof value.role !== 'string') return false;
  if (value.role === 'user') return validUserMessage(value);
  if (value.role === 'assistant') return validAssistantMessage(value);
  return value.role === 'tool' && exactObject(value, ['role', 'content']) &&
    Array.isArray(value.content) && value.content.length > 0 &&
    value.content.every(validToolResult);
};
const validLoopOutcome = (value: unknown): boolean => {
  if (
    !validJsonObject(value) || !exactObject(value, [
      'ok',
      'task',
      'outcome',
      'stopReason',
      'steps',
      'toolCallCount',
      'toolResultCount',
      'transcript',
    ], [
      'finalText',
      'terminalKind',
      'error',
      'diagnostic',
      'diagnosticDurability',
      'diagnosticPersistenceError',
      'providerEvidenceId',
      'providerEvidenceDurability',
      'providerEvidencePersistenceError',
      'turnProviderRequestCount',
      'runtimeProviderRequestCount',
      'executionArtifactId',
      'executionArtifactDurability',
      'executionArtifactPersistenceError',
      'executionAdmissionDurability',
      'executionAdmissionPersistenceError',
      'executionJournalDurability',
      'executionJournalPersistenceError',
      'executionObservationDurability',
      'executionObservationPersistenceError',
    ]) || typeof value.ok !== 'boolean' || !validText(value.task) ||
    typeof value.outcome !== 'string' || typeof value.stopReason !== 'string' ||
    value.outcome !== value.stopReason ||
    !['final', 'tool_terminal', 'max_steps', 'contract_failure', 'cancelled']
      .includes(
        value.outcome,
      ) ||
    !validNonNegativeInteger(value.steps) ||
    !validNonNegativeInteger(value.toolCallCount) ||
    !validNonNegativeInteger(value.toolResultCount) ||
    !Array.isArray(value.transcript) ||
    !value.transcript.every(validMessage)
  ) return false;
  return (value.finalText === undefined ||
    typeof value.finalText === 'string') &&
    (value.terminalKind === undefined ||
      value.terminalKind === 'json_result') &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.diagnostic === undefined ||
      validateFailureDiagnostic(value.diagnostic)) &&
    (value.diagnosticDurability === undefined ||
      value.diagnosticDurability === 'yes' ||
      value.diagnosticDurability === 'failed' ||
      value.diagnosticDurability === 'unknown') &&
    (value.diagnosticPersistenceError === undefined ||
      [
        'diagnostic_not_found',
        'diagnostic_busy',
        'diagnostic_invalid',
        'diagnostic_capacity',
        'diagnostic_io_failure',
      ].includes(value.diagnosticPersistenceError as string)) &&
    (value.providerEvidenceId === undefined ||
      UUID_V4.test(value.providerEvidenceId as string)) &&
    (value.providerEvidenceDurability === undefined ||
      value.providerEvidenceDurability === 'yes' ||
      value.providerEvidenceDurability === 'failed' ||
      value.providerEvidenceDurability === 'unknown') &&
    (value.providerEvidencePersistenceError === undefined ||
      [
        'provider_evidence_not_found',
        'provider_evidence_invalid',
        'provider_evidence_io_failure',
      ]
        .includes(value.providerEvidencePersistenceError as string)) &&
    (value.turnProviderRequestCount === undefined ||
      validNonNegativeInteger(value.turnProviderRequestCount)) &&
    (value.runtimeProviderRequestCount === undefined ||
      validNonNegativeInteger(value.runtimeProviderRequestCount)) &&
    (value.executionArtifactId === undefined ||
      UUID_V4.test(value.executionArtifactId as string)) &&
    (value.executionArtifactDurability === undefined ||
      value.executionArtifactDurability === 'yes' ||
      value.executionArtifactDurability === 'failed' ||
      value.executionArtifactDurability === 'unknown') &&
    (value.executionArtifactPersistenceError === undefined ||
      value.executionArtifactPersistenceError ===
        'worker_execution_artifact_io_failure' ||
      value.executionArtifactPersistenceError ===
        'worker_execution_artifact_invalid') &&
    (value.executionAdmissionDurability === undefined ||
      value.executionAdmissionDurability === 'failed') &&
    (value.executionAdmissionPersistenceError === undefined ||
      value.executionAdmissionPersistenceError === 'history_busy' ||
      value.executionAdmissionPersistenceError === 'history_invalid' ||
      value.executionAdmissionPersistenceError === 'history_io_failure') &&
    (value.executionJournalDurability === undefined ||
      value.executionJournalDurability === 'failed') &&
    (value.executionJournalPersistenceError === undefined ||
      value.executionJournalPersistenceError === 'history_busy' ||
      value.executionJournalPersistenceError === 'history_invalid' ||
      value.executionJournalPersistenceError === 'history_io_failure') &&
    (value.executionObservationDurability === undefined ||
      value.executionObservationDurability === 'failed') &&
    (value.executionObservationPersistenceError === undefined ||
      value.executionObservationPersistenceError === 'history_busy' ||
      value.executionObservationPersistenceError === 'history_invalid' ||
      value.executionObservationPersistenceError === 'history_io_failure');
};
const validAgentEvent = (value: unknown): boolean => {
  if (
    !exactObject(value, ['kind', 'turn'], [
      'message',
      'text',
      'call',
      'result',
      'callId',
      'name',
      'outcome',
      'committed',
      'turnProviderRequestCount',
      'runtimeProviderRequestCount',
      'providerEvidenceId',
      'providerEvidenceDurability',
      'providerEvidencePersistenceError',
      'executionArtifactId',
      'executionArtifactDurability',
      'executionArtifactPersistenceError',
      'diagnostic',
      'diagnosticDurability',
      'diagnosticPersistenceError',
      'executionAdmissionDurability',
      'executionAdmissionPersistenceError',
      'executionJournalDurability',
      'executionJournalPersistenceError',
      'executionObservationDurability',
      'executionObservationPersistenceError',
    ]) || !validPositiveInteger(value.turn) || typeof value.kind !== 'string'
  ) return false;
  switch (value.kind) {
    case 'turn_start':
      return exactObject(value, ['kind', 'turn']);
    case 'user_message':
    case 'steering_message':
      return exactObject(value, ['kind', 'turn', 'message']) &&
        validUserMessage(value.message);
    case 'assistant_message':
      return exactObject(value, ['kind', 'turn', 'message']) &&
        validAssistantMessage(value.message);
    case 'assistant_progress':
      return exactObject(value, ['kind', 'turn', 'text']) &&
        typeof value.text === 'string';
    case 'tool_call':
      return exactObject(value, ['kind', 'turn', 'call']) &&
        validToolCall(value.call);
    case 'tool_progress':
      return exactObject(value, ['kind', 'turn', 'callId', 'name', 'text']) &&
        validText(value.callId) &&
        validText(value.name) && typeof value.text === 'string';
    case 'tool_result':
      return exactObject(value, ['kind', 'turn', 'result']) &&
        validToolResult(value.result);
    case 'turn_end':
      return exactObject(value, ['kind', 'turn', 'outcome', 'committed'], [
        'turnProviderRequestCount',
        'runtimeProviderRequestCount',
        'providerEvidenceId',
        'providerEvidenceDurability',
        'providerEvidencePersistenceError',
        'executionArtifactId',
        'executionArtifactDurability',
        'executionArtifactPersistenceError',
        'diagnostic',
        'diagnosticDurability',
        'diagnosticPersistenceError',
        'executionAdmissionDurability',
        'executionAdmissionPersistenceError',
        'executionJournalDurability',
        'executionJournalPersistenceError',
        'executionObservationDurability',
        'executionObservationPersistenceError',
      ]) &&
        (value.outcome === 'final' || value.outcome === 'tool_terminal' ||
          value.outcome === 'max_steps' ||
          value.outcome === 'contract_failure' ||
          value.outcome === 'cancelled') &&
        typeof value.committed === 'boolean' &&
        (value.turnProviderRequestCount === undefined ||
          validNonNegativeInteger(value.turnProviderRequestCount)) &&
        (value.runtimeProviderRequestCount === undefined ||
          validNonNegativeInteger(value.runtimeProviderRequestCount)) &&
        (value.providerEvidenceId === undefined ||
          UUID_V4.test(String(value.providerEvidenceId))) &&
        (value.providerEvidenceDurability === undefined ||
          value.providerEvidenceDurability === 'yes' ||
          value.providerEvidenceDurability === 'failed' ||
          value.providerEvidenceDurability === 'unknown') &&
        (value.providerEvidencePersistenceError === undefined ||
          validText(value.providerEvidencePersistenceError)) &&
        (value.executionArtifactId === undefined ||
          UUID_V4.test(String(value.executionArtifactId))) &&
        (value.executionArtifactDurability === undefined ||
          value.executionArtifactDurability === 'yes' ||
          value.executionArtifactDurability === 'failed' ||
          value.executionArtifactDurability === 'unknown') &&
        (value.executionArtifactPersistenceError === undefined ||
          validText(value.executionArtifactPersistenceError)) &&
        (value.diagnostic === undefined ||
          validateFailureDiagnostic(value.diagnostic)) &&
        (value.diagnosticDurability === undefined ||
          value.diagnosticDurability === 'yes' ||
          value.diagnosticDurability === 'failed' ||
          value.diagnosticDurability === 'unknown') &&
        (value.diagnosticPersistenceError === undefined ||
          validText(value.diagnosticPersistenceError)) &&
        (value.executionAdmissionDurability === undefined ||
          value.executionAdmissionDurability === 'failed') &&
        (value.executionAdmissionPersistenceError === undefined ||
          value.executionAdmissionPersistenceError === 'history_busy' ||
          value.executionAdmissionPersistenceError === 'history_invalid' ||
          value.executionAdmissionPersistenceError === 'history_io_failure') &&
        (value.executionJournalDurability === undefined ||
          value.executionJournalDurability === 'failed') &&
        (value.executionJournalPersistenceError === undefined ||
          value.executionJournalPersistenceError === 'history_busy' ||
          value.executionJournalPersistenceError === 'history_invalid' ||
          value.executionJournalPersistenceError === 'history_io_failure') &&
        (value.executionObservationDurability === undefined ||
          value.executionObservationDurability === 'failed') &&
        (value.executionObservationPersistenceError === undefined ||
          value.executionObservationPersistenceError === 'history_busy' ||
          value.executionObservationPersistenceError === 'history_invalid' ||
          value.executionObservationPersistenceError === 'history_io_failure');
    default:
      return false;
  }
};
const validWorkerRuntimeEvent = (value: unknown): boolean => {
  if (!validJsonObject(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'agent_event') return validAgentEvent(value.event);
  switch (value.kind) {
    case 'ordered':
      return exactObject(value, ['kind', 'sequence']) &&
        validPositiveInteger(value.sequence);
    case 'echo':
      return exactObject(value, ['kind', 'payload']) &&
        isJsonValue(value.payload);
    case 'large_transfer':
      return exactObject(value, ['kind', 'byteLength', 'payload']) &&
        validPositiveInteger(value.byteLength) &&
        typeof value.payload === 'string' &&
        new TextEncoder().encode(value.payload).byteLength === value.byteLength;
    case 'permission':
      return exactObject(value, ['kind', 'read', 'environment']) &&
        (value.read === 'allowed' || value.read === 'denied') &&
        (value.environment === 'allowed' || value.environment === 'denied');
    case 'module_pre_read':
      return exactObject(value, ['kind', 'sourceBytes', 'entrySha256']) &&
        validPositiveInteger(value.sourceBytes) &&
        validText(value.entrySha256);
    case 'module_closure_verified':
      return exactObject(value, ['kind', 'fileCount']) &&
        validPositiveInteger(value.fileCount);
    case 'module_import_start':
    case 'module_imported':
      return exactObject(value, ['kind', 'specifier']) &&
        validText(value.specifier);
    case 'worker_error_observed':
      return exactObject(value, ['kind', 'message']) &&
        typeof value.message === 'string';
    default:
      return false;
  }
};
const validRuntimePayload = (value: unknown): boolean => {
  if (!validJsonObject(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'runtime_event') {
    return exactObject(value, ['kind', 'correlation', 'sequence', 'event']) &&
      validCorrelation(value.correlation) &&
      validPositiveInteger(value.sequence) &&
      validWorkerRuntimeEvent(value.event);
  }
  if (value.kind === 'provider_observation') {
    return exactObject(value, [
      'kind',
      'correlation',
      'sequence',
      'turn',
      'observation',
    ]) && validCorrelation(value.correlation) &&
      validPositiveInteger(value.sequence) &&
      validPositiveInteger(value.turn) &&
      validateProviderEvidenceObservation(value.observation);
  }
  if (value.kind === 'context_observation') {
    return exactObject(value, [
      'kind',
      'correlation',
      'sequence',
      'observation',
    ]) &&
      validCorrelation(value.correlation) &&
      validPositiveInteger(value.sequence) &&
      exactObject(value.observation, ['kind', 'delta']) &&
      value.observation.kind === 'model_request_delta' &&
      validateContextModelRequestDelta(value.observation.delta);
  }
  if (value.kind === 'commit_proposal') {
    return exactObject(
      value,
      ['kind', 'correlation', 'transcript', 'nextTurn'],
      ['outcome', 'providerEvidence', 'contextManifest', 'diagnostic'],
    ) &&
      validCorrelation(value.correlation) && Array.isArray(value.transcript) &&
      value.transcript.every(validMessage) &&
      validPositiveInteger(value.nextTurn) &&
      (value.outcome === undefined || validLoopOutcome(value.outcome)) &&
      (value.providerEvidence === undefined ||
        validateProviderEvidenceV1(value.providerEvidence)) &&
      (value.contextManifest === undefined ||
        validateExecutionContextManifest(value.contextManifest)) &&
      (value.diagnostic === undefined ||
        validateFailureDiagnostic(value.diagnostic));
  }
  if (value.kind === 'turn_failed') {
    return exactObject(value, ['kind', 'correlation', 'outcome'], [
      'providerEvidence',
      'contextManifest',
      'diagnostic',
    ]) &&
      validCorrelation(value.correlation) && validLoopOutcome(value.outcome) &&
      (value.providerEvidence === undefined ||
        validateProviderEvidenceV1(value.providerEvidence)) &&
      (value.contextManifest === undefined ||
        validateExecutionContextManifest(value.contextManifest)) &&
      (value.diagnostic === undefined ||
        validateFailureDiagnostic(value.diagnostic));
  }
  if (value.kind === 'worker_error') {
    return exactObject(value, ['kind', 'stage', 'message'], ['correlation']) &&
      (value.correlation === undefined ||
        validCorrelation(value.correlation)) &&
      typeof value.stage === 'string' &&
      [
        'module_pre_read',
        'module_import',
        'module_validation',
        'composition',
        'turn',
        'worker_command',
        'uncaught',
      ].includes(value.stage) &&
      typeof value.message === 'string';
  }
  return false;
};
const validEffectPayload = (value: unknown): boolean =>
  validJsonObject(value) &&
  exactObject(value, ['kind', 'correlation', 'sequence', 'effect']) &&
  value.kind === 'effect_observation' && validCorrelation(value.correlation) &&
  validPositiveInteger(value.sequence) && validAgentEvent(value.effect) &&
  (value.effect as Record<string, unknown>).kind !== 'turn_end' &&
  (value.effect as Record<string, unknown>).kind !== 'turn_start';

const schemaSql = `
CREATE TABLE store_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  workspace_root TEXT NOT NULL,
  workspace_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT,
  state_revision INTEGER NOT NULL,
  next_turn INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  active_model_json TEXT NOT NULL
);
CREATE TABLE session_model_changes (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  effective_turn INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  PRIMARY KEY (session_id, ordinal)
);
CREATE TABLE semantic_checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  covered_turn INTEGER NOT NULL,
  retained_turn INTEGER NOT NULL,
  source_profile_id TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  canonical_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  session_correlation TEXT NOT NULL,
  turn INTEGER NOT NULL,
  task_text TEXT NOT NULL,
  admitted_at TEXT NOT NULL
);
CREATE TABLE executions (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  canonical_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  session_correlation TEXT NOT NULL,
  turn INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  lifecycle TEXT NOT NULL,
  outcome TEXT NOT NULL,
  adoption TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  committed_revision INTEGER,
  agent TEXT NOT NULL,
  model_json TEXT NOT NULL,
  build_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  manifest_json TEXT,
  instance_correlation TEXT,
  worker_generation TEXT,
  acknowledgement TEXT NOT NULL DEFAULT 'not_sent',
  generation_availability TEXT NOT NULL DEFAULT 'unknown',
  evidence_capture TEXT NOT NULL DEFAULT 'unknown',
  diagnostic_capture TEXT NOT NULL DEFAULT 'unknown',
  artifact_capture TEXT NOT NULL DEFAULT 'unknown',
  context_capture TEXT NOT NULL DEFAULT 'none'
);
CREATE TABLE execution_outcomes (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id) ON DELETE CASCADE,
  ok INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  stop_reason TEXT NOT NULL,
  final_text TEXT,
  terminal_kind TEXT,
  error TEXT,
  diagnostic_id TEXT,
  diagnostic_durability TEXT,
  diagnostic_persistence_error TEXT,
  provider_evidence_id TEXT,
  provider_evidence_durability TEXT,
  provider_evidence_persistence_error TEXT,
  turn_provider_request_count INTEGER,
  runtime_provider_request_count INTEGER,
  execution_artifact_id TEXT,
  execution_artifact_durability TEXT,
  execution_artifact_persistence_error TEXT,
  execution_admission_durability TEXT,
  execution_admission_persistence_error TEXT,
  execution_journal_durability TEXT,
  execution_journal_persistence_error TEXT,
  execution_observation_durability TEXT,
  execution_observation_persistence_error TEXT,
  steps INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL,
  tool_result_count INTEGER NOT NULL
);
CREATE TABLE canonical_turns (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  committed_revision INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  model_json TEXT NOT NULL,
  build_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  PRIMARY KEY (session_id, turn)
);
CREATE TABLE execution_messages (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  session_ordinal INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_observation_ordinals_json TEXT,
  content_digest TEXT REFERENCES context_blobs(digest),
  PRIMARY KEY (execution_id, ordinal)
);
CREATE TABLE execution_projections (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id) ON DELETE CASCADE,
  projection_kind TEXT NOT NULL,
  source_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  projected_text TEXT NOT NULL,
  link_status TEXT NOT NULL
);
CREATE TABLE provider_evidence (
  evidence_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  capture TEXT NOT NULL,
  normalized_outcome TEXT NOT NULL,
  outcome TEXT,
  settlement TEXT,
  turn_provider_request_count INTEGER,
  runtime_provider_request_count INTEGER,
  diagnostic_id TEXT,
  link_status TEXT NOT NULL
);
CREATE TABLE model_requests (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  request_ordinal INTEGER NOT NULL,
  observation_ordinal INTEGER,
  evidence_id TEXT REFERENCES provider_evidence(evidence_id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  phase TEXT,
  model_step INTEGER NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'user_turn',
  model_selection_json TEXT,
  revision_digest TEXT NOT NULL,
  source_call_id TEXT,
  UNIQUE (execution_id, observation_ordinal),
  PRIMARY KEY (execution_id, request_ordinal)
);
CREATE TABLE context_blobs (
  digest TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  raw_bytes BLOB NOT NULL
);
CREATE TABLE context_occurrences (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  occurrence_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_digest TEXT NOT NULL REFERENCES context_blobs(digest),
  occurrence_digest TEXT NOT NULL,
  PRIMARY KEY (execution_id, occurrence_id),
  UNIQUE (execution_id, occurrence_digest)
);
CREATE TABLE context_occurrence_sources (
  execution_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL,
  stage TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  logical_identity TEXT,
  source_locator TEXT,
  content_digest TEXT REFERENCES context_blobs(digest),
  lane TEXT,
  model_step INTEGER,
  call_id TEXT,
  worker_sequence INTEGER,
  source_event_ordinal INTEGER,
  PRIMARY KEY (execution_id, occurrence_id, source_ordinal),
  FOREIGN KEY (execution_id, occurrence_id)
    REFERENCES context_occurrences(execution_id, occurrence_id) ON DELETE CASCADE
);
CREATE TABLE context_sequence_revisions (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  revision_digest TEXT NOT NULL,
  lane TEXT NOT NULL,
  sequence_kind TEXT NOT NULL,
  base_revision_digest TEXT,
  result_item_count INTEGER NOT NULL,
  PRIMARY KEY (execution_id, revision_digest),
  FOREIGN KEY (execution_id, base_revision_digest)
    REFERENCES context_sequence_revisions(execution_id, revision_digest)
);
CREATE TABLE context_sequence_splices (
  execution_id TEXT NOT NULL,
  revision_digest TEXT NOT NULL,
  splice_ordinal INTEGER NOT NULL,
  start_index INTEGER NOT NULL,
  delete_count INTEGER NOT NULL,
  PRIMARY KEY (execution_id, revision_digest, splice_ordinal),
  FOREIGN KEY (execution_id, revision_digest)
    REFERENCES context_sequence_revisions(execution_id, revision_digest) ON DELETE CASCADE
);
CREATE TABLE context_sequence_insertions (
  execution_id TEXT NOT NULL,
  revision_digest TEXT NOT NULL,
  splice_ordinal INTEGER NOT NULL,
  insertion_ordinal INTEGER NOT NULL,
  occurrence_id TEXT NOT NULL,
  occurrence_digest TEXT NOT NULL,
  PRIMARY KEY (execution_id, revision_digest, splice_ordinal, insertion_ordinal),
  FOREIGN KEY (execution_id, revision_digest, splice_ordinal)
    REFERENCES context_sequence_splices(execution_id, revision_digest, splice_ordinal)
    ON DELETE CASCADE,
  FOREIGN KEY (execution_id, occurrence_id)
    REFERENCES context_occurrences(execution_id, occurrence_id)
);
CREATE TABLE execution_context_relations (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  stage TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  logical_identity TEXT,
  source_locator TEXT,
  content_digest TEXT REFERENCES context_blobs(digest),
  lane TEXT,
  model_step INTEGER,
  call_id TEXT,
  request_ordinal INTEGER,
  source_event_ordinal INTEGER,
  PRIMARY KEY (execution_id, ordinal)
);
CREATE TABLE execution_context_counters (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id) ON DELETE CASCADE,
  next_relation_ordinal INTEGER NOT NULL
);
CREATE TABLE provider_request_contexts (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  provider_request_ordinal INTEGER NOT NULL,
  context_request_ordinal INTEGER NOT NULL,
  PRIMARY KEY (execution_id, provider_request_ordinal)
);
CREATE TABLE context_tool_calls (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  model_step INTEGER,
  request_ordinal INTEGER,
  source_event_ordinal INTEGER NOT NULL,
  PRIMARY KEY (execution_id, lane, call_id)
);
CREATE TABLE failure_diagnostics (
  diagnostic_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  evidence_id TEXT REFERENCES provider_evidence(evidence_id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  diagnostic_json TEXT NOT NULL,
  link_status TEXT NOT NULL
);
CREATE TABLE diagnostic_evidence_links (
  diagnostic_id TEXT PRIMARY KEY REFERENCES failure_diagnostics(diagnostic_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES provider_evidence(evidence_id) ON DELETE CASCADE
);
CREATE TABLE execution_artifacts (
  artifact_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id) ON DELETE CASCADE,
  settled_at TEXT NOT NULL,
  command_session TEXT NOT NULL,
  command_instance_correlation TEXT NOT NULL,
  command_worker_generation TEXT NOT NULL,
  command_base_revision INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  proposed_revision INTEGER,
  committed_revision INTEGER,
  provider_evidence_id TEXT,
  provider_evidence_durability TEXT,
  provider_evidence_error TEXT,
  store_result TEXT NOT NULL,
  store_error TEXT,
  acknowledgement TEXT NOT NULL,
  settlement TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  normalized_outcome TEXT NOT NULL,
  adoption TEXT NOT NULL,
  context_capture TEXT NOT NULL,
  artifact_persistence_error TEXT,
  link_status TEXT NOT NULL
);
CREATE TABLE worker_generations (
  worker_generation TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  instance_correlation TEXT NOT NULL
);
CREATE TABLE worker_protocol_observations (
  observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_generation TEXT NOT NULL REFERENCES worker_generations(worker_generation),
  occurrence_key TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  semantic_subtype TEXT NOT NULL,
  correlation_session TEXT NOT NULL,
  instance_correlation TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  correlation_command TEXT NOT NULL,
  ack_accepted INTEGER,
  UNIQUE (worker_generation, occurrence_key)
);
CREATE TABLE execution_artifact_trace (
  artifact_id TEXT NOT NULL REFERENCES execution_artifacts(artifact_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES worker_protocol_observations(observation_id),
  PRIMARY KEY (artifact_id, ordinal),
  UNIQUE (artifact_id, observation_id)
);
CREATE INDEX executions_session_turn ON executions(session_correlation, turn);
CREATE INDEX evidence_created ON provider_evidence(created_at, evidence_id);
CREATE INDEX diagnostics_occurred ON failure_diagnostics(occurred_at, diagnostic_id);
CREATE INDEX context_relations_identity ON execution_context_relations(
  execution_id, stage, resource_kind, logical_identity
);
CREATE INDEX context_relations_call ON execution_context_relations(
  execution_id, lane, call_id, stage, resource_kind
);
CREATE TABLE execution_observations (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  direction TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  worker_sequence INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (execution_id, ordinal)
);
CREATE TABLE runtime_occurrences (
  execution_id TEXT NOT NULL,
  observation_ordinal INTEGER NOT NULL,
  envelope_kind TEXT NOT NULL,
  request_ordinal INTEGER,
  event_json TEXT NOT NULL,
  PRIMARY KEY (execution_id, observation_ordinal),
  FOREIGN KEY (execution_id, observation_ordinal)
    REFERENCES execution_observations(execution_id, ordinal) ON DELETE CASCADE
);
CREATE TABLE provider_observation_facts (
  execution_id TEXT NOT NULL,
  observation_ordinal INTEGER NOT NULL,
  observation_kind TEXT NOT NULL,
  request_ordinal INTEGER,
  byte_offset INTEGER,
  observation_json TEXT,
  raw_bytes BLOB,
  PRIMARY KEY (execution_id, observation_ordinal),
  FOREIGN KEY (execution_id, observation_ordinal)
    REFERENCES execution_observations(execution_id, ordinal) ON DELETE CASCADE
);
CREATE TABLE execution_progress_deltas (
  execution_id TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  text_fragment TEXT NOT NULL,
  PRIMARY KEY (execution_id, event_ordinal),
  FOREIGN KEY (execution_id, event_ordinal)
    REFERENCES execution_observations(execution_id, ordinal) ON DELETE CASCADE
);
CREATE TABLE execution_effects (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  requested_event_ordinal INTEGER,
  progress_event_ordinal INTEGER,
  completed_event_ordinal INTEGER,
  result_outcome TEXT,
  status TEXT NOT NULL,
  PRIMARY KEY (execution_id, call_id)
);
CREATE UNIQUE INDEX executions_active_session
  ON executions(session_correlation) WHERE lifecycle = 'active';
CREATE INDEX IF NOT EXISTS execution_observations_execution_worker_sequence
  ON execution_observations(execution_id, worker_sequence)
  WHERE worker_sequence IS NOT NULL;
PRAGMA user_version = 5;
`;

export interface SqliteHistoryStoreOptions {
  readonly uuid?: () => string;
}

export class SqliteHistoryStore
  implements WorkerSessionStorePort, HistoryPersistencePort, HumanHistoryReadPort {
  readonly providerEvidence: ProviderEvidenceStore;
  readonly executionArtifacts: WorkerExecutionArtifactStore;
  readonly diagnostics: FailureDiagnosticStore;
  private readonly makeUuid: () => string;
  private readonly pathsPromise: ReturnType<typeof sessionPaths>;
  private databaseFile?: string;
  private readonly executionLocks = new Map<string, Lock>();

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
    options: SqliteHistoryStoreOptions = {},
  ) {
    if (!stateRoot.startsWith('/') || stateRoot.includes('\0')) {
      throw new SessionStoreError('session_io_failure');
    }
    this.makeUuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
    this.pathsPromise = sessionPaths(stateRoot, workspaceRoot);
    this.providerEvidence = new SqliteProviderEvidenceAdapter(this);
    this.executionArtifacts = new SqliteExecutionArtifactAdapter(this);
    this.diagnostics = new SqliteDiagnosticAdapter(this);
  }

  private async prepareContextBasis(
    snapshot: WorkerContextSnapshot | undefined,
  ): Promise<
    readonly {
      readonly relation: ExecutionContextRelation;
      readonly blob: ContextBlobInput;
    }[]
  > {
    if (snapshot === undefined) return [];
    const output: {
      relation: ExecutionContextRelation;
      blob: ContextBlobInput;
    }[] = [];
    let ordinal = 0;
    const add = async (
      stage: ContextRelationStage,
      resourceKind: ExecutionContextRelation['resourceKind'],
      value: import('../core/contracts.ts').JsonValue,
      mediaType: import('./context_attribution.ts').ContextBlobMediaType,
      extras: Partial<ExecutionContextRelation> = {},
    ): Promise<void> => {
      const blob = await jsonBlob(value, mediaType);
      output.push({
        blob,
        relation: {
          ordinal: ++ordinal,
          stage,
          resourceKind,
          contentDigest: blob.digest,
          ...extras,
        },
      });
    };
    const addText = async (
      stage: ContextRelationStage,
      resourceKind: ExecutionContextRelation['resourceKind'],
      value: string,
      extras: Partial<ExecutionContextRelation> = {},
    ): Promise<void> => {
      const blob = await textBlob(value);
      output.push({
        blob,
        relation: {
          ordinal: ++ordinal,
          stage,
          resourceKind,
          contentDigest: blob.digest,
          ...extras,
        },
      });
    };
    if (snapshot.workspaceInstruction !== undefined) {
      await addText(
        'discovered',
        'workspace_instruction',
        snapshot.workspaceInstruction.text,
        {
          logicalIdentity: snapshot.workspaceInstruction.source,
          sourceLocator: snapshot.workspaceInstruction.source,
        },
      );
      await addText(
        'resolved',
        'workspace_instruction',
        snapshot.workspaceInstruction.formatted,
        {
          logicalIdentity: snapshot.workspaceInstruction.source,
          sourceLocator: snapshot.workspaceInstruction.source,
        },
      );
    }
    if (snapshot.skillCatalog.manifest !== undefined) {
      await addText(
        'resolved',
        'skill_catalog',
        snapshot.skillCatalog.manifest,
        {
          logicalIdentity: 'skill-catalog',
        },
      );
    }
    for (const skill of snapshot.skillCatalog.skills) {
      await add(
        'discovered',
        'skill',
        skill as unknown as import('../core/contracts.ts').JsonValue,
        'application/json',
        {
          logicalIdentity: skill.name,
          sourceLocator: skill.sourceDirectory,
        },
      );
    }
    for (const component of snapshot.instructionComponents) {
      await addText('resolved', 'instruction_component', component.text, {
        logicalIdentity: String(component.identity),
        ...(component.sourceLocator === undefined
          ? {}
          : { sourceLocator: component.sourceLocator }),
      });
    }
    if (
      snapshot.instructionComponents.length === 0 &&
      snapshot.systemInstruction !== undefined
    ) {
      await addText(
        'resolved',
        'definition_output',
        snapshot.systemInstruction,
        {
          logicalIdentity: 'definition-output',
        },
      );
    }
    for (const tool of snapshot.toolDefinitions) {
      await add(
        'resolved',
        'tool_contract',
        tool as unknown as import('../core/contracts.ts').JsonValue,
        'application/vnd.henji.tool+json',
        { logicalIdentity: tool.name },
      );
    }
    await addText('resolved', 'runtime_fact', snapshot.runtimeFacts.cwd, {
      logicalIdentity: 'cwd',
    });
    return output;
  }

  private insertContextBlobTx(db: DatabaseSync, blob: ContextBlobInput): void {
    const existing = db.prepare(
      'SELECT byte_length, media_type FROM context_blobs WHERE digest = ?',
    ).get(blob.digest) as SqlRow | undefined;
    if (existing !== undefined) {
      // The digest is content-addressed; a length mismatch means store corruption.
      if (
        Number(existing.byte_length) !== blob.byteLength ||
        String(existing.media_type) !== blob.mediaType
      ) {
        throw new HistoryStoreError('history_invalid');
      }
      return;
    }
    db.prepare(
      'INSERT INTO context_blobs(digest, byte_length, media_type, raw_bytes) VALUES (?, ?, ?, ?)',
    ).run(blob.digest, blob.byteLength, blob.mediaType, blob.bytes);
  }

  private insertContextRelationTx(
    db: DatabaseSync,
    executionId: string,
    relation: ExecutionContextRelation,
  ): void {
    if (relation.contentDigest === undefined) {
      throw new HistoryStoreError('history_invalid');
    }
    db.prepare(`
      INSERT INTO execution_context_relations(
        execution_id, ordinal, stage, resource_kind, logical_identity, source_locator,
        content_digest, lane, model_step, call_id, request_ordinal, source_event_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      executionId,
      relation.ordinal,
      relation.stage,
      relation.resourceKind,
      relation.logicalIdentity ?? null,
      relation.sourceLocator ?? null,
      relation.contentDigest,
      relation.lane ?? null,
      relation.modelStep ?? null,
      relation.callId ?? null,
      relation.requestOrdinal ?? null,
      relation.sourceEventOrdinal ?? null,
    );
  }

  private async layout(): Promise<
    { root: string; locks: string; database: string; digest: string }
  > {
    const paths = await this.pathsPromise;
    const locks = `${paths.root}/locks-v5`;
    const database = `${paths.root}/history-v5.sqlite3`;
    try {
      await ensureDirectory(this.stateRoot, 0o700);
      await ensureDirectory(paths.root, 0o700);
      await ensureDirectory(locks, 0o700);
      this.databaseFile = database;
      return {
        root: paths.root,
        locks,
        database,
        digest: await workspaceDigest(this.workspaceRoot),
      };
    } catch (error) {
      throw sessionError(error);
    }
  }

  private async database(): Promise<DatabaseSync> {
    const layout = await this.layout();
    let db: DatabaseSync | undefined;
    let schemaLock: Lock | undefined;
    try {
      db = new DatabaseSync(layout.database);
      db.exec(
        `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
      );
      let version = Number(
        (db.prepare('PRAGMA user_version').get() as SqlRow).user_version,
      );
      if (version === 0) {
        db.close();
        db = undefined;
        schemaLock = await this.acquireSchemaLock(
          `${layout.locks}/.history-schema.lock`,
        );
        db = new DatabaseSync(layout.database);
        db.exec(
          `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
        );
        version = Number(
          (db.prepare('PRAGMA user_version').get() as SqlRow).user_version,
        );
      }
      if (version === 0) {
        const objects = Number(
          (db.prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
          )
            .get() as SqlRow)
            .count,
        );
        if (objects !== 0) throw new HistoryStoreError('history_invalid');
        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.transaction(db, () => {
          db!.exec(schemaSql);
          db!.prepare(
            'INSERT INTO store_metadata(singleton, schema_version, workspace_root, workspace_digest, created_at) VALUES (1, ?, ?, ?, ?)',
          ).run(
            SCHEMA_VERSION,
            this.workspaceRoot,
            layout.digest,
            new Date().toISOString(),
          );
        });
      }
      const currentVersion = Number(
        (db.prepare('PRAGMA user_version').get() as SqlRow).user_version,
      );
      if (currentVersion !== SCHEMA_VERSION) {
        throw new HistoryStoreError('history_invalid');
      }
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const hasWorkerSequenceIndex = db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'execution_observations_execution_worker_sequence'",
      ).get() as SqlRow | undefined;
      if (hasWorkerSequenceIndex === undefined) {
        this.transaction(db, () => {
          db!.exec(
            'CREATE INDEX IF NOT EXISTS execution_observations_execution_worker_sequence ON execution_observations(execution_id, worker_sequence) WHERE worker_sequence IS NOT NULL',
          );
        });
      }
      const foreignKeys = Number(
        (db.prepare('PRAGMA foreign_keys').get() as SqlRow).foreign_keys,
      );
      const journal = String(
        (db.prepare('PRAGMA journal_mode').get() as SqlRow).journal_mode,
      ).toLowerCase();
      const synchronous = Number(
        (db.prepare('PRAGMA synchronous').get() as SqlRow).synchronous,
      );
      const busyTimeout = Number(
        (db.prepare('PRAGMA busy_timeout').get() as SqlRow).timeout,
      );
      if (
        foreignKeys !== 1 || journal !== 'wal' || synchronous !== 2 ||
        busyTimeout !== BUSY_TIMEOUT_MS
      ) throw new HistoryStoreError('history_invalid');
      const metadata = db.prepare(
        'SELECT schema_version, workspace_root, workspace_digest FROM store_metadata WHERE singleton = 1',
      ).get() as SqlRow | undefined;
      if (
        metadata === undefined ||
        Number(metadata.schema_version) !== SCHEMA_VERSION ||
        metadata.workspace_root !== this.workspaceRoot ||
        metadata.workspace_digest !== layout.digest
      ) throw new HistoryStoreError('history_invalid');
      return db;
    } catch (error) {
      db?.close();
      throw historyError(error);
    } finally {
      schemaLock?.close();
    }
  }

  private async acquireSchemaLock(path: string): Promise<Lock> {
    const deadline = performance.now() + BUSY_TIMEOUT_MS;
    while (true) {
      try {
        return await acquireLock(path);
      } catch (error) {
        if (
          !(error instanceof SessionStoreError) ||
          error.code !== 'session_busy' ||
          performance.now() >= deadline
        ) {
          throw error instanceof SessionStoreError &&
              error.code === 'session_busy'
            ? new HistoryStoreError('history_busy')
            : error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private transaction<T>(db: DatabaseSync, body: () => T): T {
    try {
      db.exec('BEGIN IMMEDIATE');
      const value = body();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the transaction failure.
      }
      throw error instanceof SessionStoreError ||
          error instanceof FailureDiagnosticStoreError ||
          error instanceof ProviderEvidenceStoreError ||
          error instanceof WorkerExecutionArtifactStoreError
        ? error
        : historyError(error);
    }
  }

  private messageFromRow(db: DatabaseSync, row: SqlRow): Message {
    if (row.source_kind === 'task') {
      if (
        typeof row.task_text !== 'string' || row.content_digest !== null ||
        row.source_observation_ordinals_json !== null
      ) {
        throw new HistoryStoreError('history_invalid');
      }
      return { role: 'user', content: { kind: 'text', text: row.task_text } };
    }
    if (row.source_kind === 'runtime') {
      if (
        row.content_digest !== null ||
        typeof row.source_observation_ordinals_json !== 'string'
      ) {
        throw new HistoryStoreError('history_invalid');
      }
      let ordinals: unknown;
      try {
        ordinals = JSON.parse(row.source_observation_ordinals_json);
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
      if (
        !Array.isArray(ordinals) || ordinals.length === 0 ||
        !ordinals.every((ordinal) => Number.isSafeInteger(ordinal) && ordinal >= 1)
      ) throw new HistoryStoreError('history_invalid');
      const messages = ordinals.map((ordinal) => {
        const occurrence = db.prepare(
          `SELECT event_json FROM runtime_occurrences
          WHERE execution_id = ? AND observation_ordinal = ?`,
        ).get(
          String(row.execution_id),
          ordinal,
        ) as SqlRow | undefined;
        if (occurrence === undefined) {
          throw new HistoryStoreError('history_invalid');
        }
        return this.messageFromRuntimeOccurrence(occurrence.event_json);
      });
      if (messages.length === 1 && messages[0]?.role !== 'tool') {
        return messages[0]!;
      }
      if (!messages.every((message) => message.role === 'tool')) {
        throw new HistoryStoreError('history_invalid');
      }
      return {
        role: 'tool',
        content: messages.flatMap((message) => message.role === 'tool' ? message.content : []),
      };
    }
    if (row.source_kind !== 'message' || row.content_digest === null) {
      throw new HistoryStoreError('history_invalid');
    }
    if (row.source_observation_ordinals_json !== null) {
      throw new HistoryStoreError('history_invalid');
    }
    return parseCanonicalMessage(
      decoder.decode(this.readContextBlobTx(db, String(row.content_digest))),
    );
  }

  private messageFromRuntimeOccurrence(value: unknown): Message {
    let event: unknown;
    try {
      event = JSON.parse(String(value));
    } catch {
      throw new HistoryStoreError('history_invalid');
    }
    if (!validJsonObject(event)) throw new HistoryStoreError('history_invalid');
    if (event.kind === 'model_result' && validJsonObject(event.result)) {
      const result = event.result;
      if (result.kind === 'final' && typeof result.text === 'string') {
        return parseCanonicalMessage(JSON.stringify({
          role: 'assistant',
          content: { kind: 'text', text: result.text },
          ...(result.providerState === undefined ? {} : { providerState: result.providerState }),
        }));
      }
      if (result.kind === 'tool_calls' && Array.isArray(result.calls)) {
        return parseCanonicalMessage(JSON.stringify({
          role: 'assistant',
          content: result.calls.map((call) => ({ kind: 'tool_call', ...call })),
          ...(result.text === undefined ? {} : { text: result.text }),
          ...(result.providerState === undefined ? {} : { providerState: result.providerState }),
        }));
      }
    }
    if (event.kind === 'tool_result' && validJsonObject(event.result)) {
      return parseCanonicalMessage(JSON.stringify({
        role: 'tool',
        content: [event.result],
      }));
    }
    if (event.kind === 'agent_event' && validJsonObject(event.event)) {
      const agentEvent = event.event;
      if (
        (agentEvent.kind === 'user_message' ||
          agentEvent.kind === 'steering_message' ||
          agentEvent.kind === 'assistant_message') &&
        validJsonObject(agentEvent.message)
      ) return parseCanonicalMessage(JSON.stringify(agentEvent.message));
      if (
        agentEvent.kind === 'tool_result' && validJsonObject(agentEvent.result)
      ) {
        return parseCanonicalMessage(JSON.stringify({
          role: 'tool',
          content: [agentEvent.result],
        }));
      }
    }
    throw new HistoryStoreError('history_invalid');
  }

  private runtimeSourceOrdinalsTx(
    db: DatabaseSync,
    executionId: string,
    message: Message,
    used: Set<number>,
  ): number[] | undefined {
    const rows = db.prepare(
      `SELECT observation_ordinal, event_json FROM runtime_occurrences
      WHERE execution_id = ? ORDER BY observation_ordinal`,
    ).all(executionId) as SqlRow[];
    const same = (left: Message, right: Message): boolean =>
      canonicalJson(
        left as unknown as import('../core/contracts.ts').JsonValue,
      ) ===
        canonicalJson(
          right as unknown as import('../core/contracts.ts').JsonValue,
        );
    if (message.role !== 'tool') {
      for (const row of rows) {
        const ordinal = Number(row.observation_ordinal);
        if (used.has(ordinal)) continue;
        try {
          if (
            same(this.messageFromRuntimeOccurrence(row.event_json), message)
          ) {
            used.add(ordinal);
            return [ordinal];
          }
        } catch {
          // Non-message runtime occurrences are not candidates.
        }
      }
      return undefined;
    }
    const ordinals: number[] = [];
    const selected = new Set<number>();
    for (const expected of message.content) {
      let matched: number | undefined;
      for (const row of rows) {
        const ordinal = Number(row.observation_ordinal);
        if (used.has(ordinal) || selected.has(ordinal)) continue;
        try {
          const candidate = this.messageFromRuntimeOccurrence(row.event_json);
          if (
            candidate.role === 'tool' && candidate.content.length === 1 &&
            same({ role: 'tool', content: [expected] }, candidate)
          ) {
            matched = ordinal;
            break;
          }
        } catch {
          // Non-message runtime occurrences are not candidates.
        }
      }
      if (matched === undefined) return undefined;
      selected.add(matched);
      ordinals.push(matched);
    }
    for (const ordinal of ordinals) used.add(ordinal);
    return ordinals;
  }

  private readRecord(db: DatabaseSync, id: string): StoredSessionRecord {
    const row = db.prepare(`
      SELECT agent, created_at, updated_at, title, state_revision, next_turn,
        definition_json, active_model_json
      FROM sessions WHERE session_id = ?
    `).get(id) as
      | SqlRow
      | undefined;
    if (row === undefined) throw new SessionStoreError('session_not_found');
    try {
      const definition = JSON.parse(String(row.definition_json));
      const activeModel = JSON.parse(String(row.active_model_json));
      const modelChanges = (db.prepare(`
        SELECT effective_turn, changed_at, selection_json FROM session_model_changes
        WHERE session_id = ? ORDER BY ordinal
      `).all(id) as SqlRow[]).map((change) => ({
        effectiveFromTurn: Number(change.effective_turn),
        changedAt: String(change.changed_at),
        selection: JSON.parse(String(change.selection_json)),
      }));
      const turns = db.prepare(`
        SELECT turn, execution_id, model_json, build_json, definition_json
        FROM canonical_turns WHERE session_id = ? ORDER BY turn
      `).all(id) as SqlRow[];
      const messages = db.prepare(`
        SELECT m.execution_id, m.session_ordinal, m.source_kind,
          m.source_observation_ordinals_json,
          m.content_digest, k.task_text
        FROM canonical_turns t JOIN execution_messages m
          ON m.execution_id = t.execution_id
        JOIN executions e ON e.execution_id = m.execution_id
        JOIN tasks k ON k.task_id = e.task_id
        WHERE t.session_id = ? ORDER BY t.turn, m.ordinal
      `).all(id) as SqlRow[];
      const transcript = messages.map((message, index) => {
        if (Number(message.session_ordinal) !== index) {
          throw new SessionStoreError('session_invalid');
        }
        return this.messageFromRow(db, message);
      });
      const record: StoredSessionRecord = {
        schemaVersion: 6,
        sessionId: id,
        workspaceRoot: this.workspaceRoot,
        agent: row.agent as SessionRecord['agent'],
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        title: row.title === null ? null : String(row.title),
        stateRevision: Number(row.state_revision),
        nextTurn: Number(row.next_turn),
        transcript,
        definition,
        activeModel,
        modelChanges,
        turnModels: turns.map((turn) => ({
          turn: Number(turn.turn),
          selection: JSON.parse(String(turn.model_json)),
        })),
        turnExecutions: turns.map((turn) => ({
          turn: Number(turn.turn),
          build: JSON.parse(String(turn.build_json)),
          definition: JSON.parse(String(turn.definition_json)),
        })),
      };
      if (!validateSessionRecordV6(record)) {
        throw new SessionStoreError('session_invalid');
      }
      return record;
    } catch (error) {
      throw error instanceof SessionStoreError ? error : new SessionStoreError('session_invalid');
    }
  }

  private readCheckpointFromDb(
    db: DatabaseSync,
    id: string,
  ): SemanticContextCheckpointV1 | undefined {
    const row = db.prepare(`
      SELECT created_at, covered_turn, retained_turn, source_profile_id, summary
      FROM semantic_checkpoints WHERE session_id = ?
    `).get(id) as SqlRow | undefined;
    if (row === undefined) return undefined;
    try {
      const checkpoint: SemanticContextCheckpointV1 = {
        contextSchemaVersion: 1,
        sessionId: id,
        createdAt: String(row.created_at),
        sourceProfileId: String(row.source_profile_id),
        coveredThroughTurn: Number(row.covered_turn),
        retainedFromTurn: Number(row.retained_turn),
        summary: String(row.summary),
      };
      if (
        !validateSemanticContextCheckpoint(checkpoint)
      ) throw new Error('checkpoint relation mismatch');
      return checkpoint;
    } catch {
      throw new SessionStoreError('session_invalid');
    }
  }

  private writeRecord(db: DatabaseSync, record: StoredSessionRecord): void {
    if (
      !validateSessionRecordV6(record) ||
      record.workspaceRoot !== this.workspaceRoot
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    db.prepare(`
      INSERT INTO sessions(
        session_id, agent, created_at, updated_at, title, state_revision, next_turn,
        definition_json, active_model_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        agent=excluded.agent, created_at=excluded.created_at, updated_at=excluded.updated_at,
        title=excluded.title, state_revision=excluded.state_revision, next_turn=excluded.next_turn,
        definition_json=excluded.definition_json, active_model_json=excluded.active_model_json
    `).run(
      record.sessionId,
      record.agent,
      record.createdAt,
      record.updatedAt,
      record.title,
      record.stateRevision,
      record.nextTurn,
      JSON.stringify(record.definition),
      JSON.stringify(record.activeModel),
    );
    db.prepare('DELETE FROM session_model_changes WHERE session_id = ?').run(
      record.sessionId,
    );
    const insert = db.prepare(`
      INSERT INTO session_model_changes(
        session_id, ordinal, effective_turn, changed_at, selection_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    record.modelChanges.forEach((change, ordinal) => {
      insert.run(
        record.sessionId,
        ordinal,
        change.effectiveFromTurn,
        change.changedAt,
        JSON.stringify(change.selection),
      );
    });
  }

  private writeProjection(
    db: DatabaseSync,
    executionId: string,
    recalled: NonCanonicalExecutionInput['recalledContext'],
  ): void {
    if (recalled === undefined) return;
    db.prepare(`
      INSERT INTO execution_projections(
        execution_id, projection_kind, source_execution_id, projected_text, link_status
      ) VALUES (?, 'recall', ?, ?, 'linked')
    `).run(
      executionId,
      recalled.sourceExecutionId,
      recalledExecutionProjectionText(recalled),
    );
  }

  private writeContextDeltaTx(
    db: DatabaseSync,
    executionId: string,
    observationOrdinal: number,
    delta: ContextModelRequestDelta,
  ): void {
    if (!validateContextModelRequestDelta(delta)) {
      throw new HistoryStoreError('history_invalid');
    }
    const expectedRequest = Number(
      (db.prepare(`
      SELECT coalesce(max(request_ordinal), 0) + 1 AS ordinal
      FROM model_requests WHERE execution_id = ?
    `).get(executionId) as SqlRow).ordinal,
    );
    if (delta.requestOrdinal !== expectedRequest) {
      throw new HistoryStoreError('history_invalid');
    }
    let currentCount = 0;
    if (delta.baseRevisionDigest !== undefined) {
      const base = db.prepare(`
        SELECT lane, sequence_kind, result_item_count
        FROM context_sequence_revisions
        WHERE execution_id = ? AND revision_digest = ?
      `).get(executionId, delta.baseRevisionDigest) as SqlRow | undefined;
      if (
        base === undefined || base.lane !== delta.lane ||
        base.sequence_kind !== delta.purpose
      ) throw new HistoryStoreError('history_invalid');
      currentCount = Number(base.result_item_count);
    }
    for (const occurrence of delta.occurrences) {
      if (
        contextOccurrenceDigestSync(occurrence) !== occurrence.occurrenceDigest
      ) {
        throw new HistoryStoreError('history_invalid');
      }
      const existingOccurrence = db.prepare(`
        SELECT 1 FROM context_occurrences
        WHERE execution_id = ? AND occurrence_id = ?
      `).get(executionId, occurrence.occurrenceId);
      if (existingOccurrence !== undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      const storedBlob = db.prepare(`
        SELECT byte_length, media_type FROM context_blobs WHERE digest = ?
      `).get(occurrence.content.digest) as SqlRow | undefined;
      let occurrenceBytes: Uint8Array | undefined;
      if (storedBlob === undefined) {
        if (occurrence.bytesBase64 === undefined) {
          throw new HistoryStoreError('history_invalid');
        }
        try {
          occurrenceBytes = Uint8Array.fromBase64(occurrence.bytesBase64);
        } catch {
          throw new HistoryStoreError('history_invalid');
        }
        if (
          occurrenceBytes.byteLength !== occurrence.content.byteLength ||
          contextDigestSync(occurrenceBytes) !== occurrence.content.digest
        ) throw new HistoryStoreError('history_invalid');
        this.insertContextBlobTx(db, {
          ...occurrence.content,
          bytes: occurrenceBytes,
        });
      } else if (
        Number(storedBlob.byte_length) !== occurrence.content.byteLength ||
        String(storedBlob.media_type) !== occurrence.content.mediaType
      ) throw new HistoryStoreError('history_invalid');

      const storedSources: ContextSourceRelation[] = [];
      for (const source of occurrence.sourceRelations) {
        const {
          sourceWorkerSequence,
          ...sourceWithoutWorkerSequence
        } = source;
        let sourceEventOrdinal: number | undefined;
        if (sourceWorkerSequence !== undefined) {
          const sourceEvent = db.prepare(`
            SELECT ordinal FROM execution_observations
            WHERE execution_id = ? AND worker_sequence = ?
          `).get(executionId, sourceWorkerSequence) as SqlRow | undefined;
          if (
            sourceEvent === undefined ||
            Number(sourceEvent.ordinal) >= observationOrdinal
          ) {
            throw new HistoryStoreError('history_invalid');
          }
          sourceEventOrdinal = Number(sourceEvent.ordinal);
        } else if (
          source.logicalIdentity?.startsWith('current-task:') ||
          source.logicalIdentity?.startsWith('steering:') ||
          source.logicalIdentity?.startsWith('current-execution:') ||
          source.logicalIdentity?.startsWith('tool-call:') ||
          source.logicalIdentity?.startsWith('tool-result:')
        ) throw new HistoryStoreError('history_invalid');

        const sourceContentDigest = source.contentDigest ??
          occurrence.content.digest;
        if (sourceContentDigest !== occurrence.content.digest) {
          occurrenceBytes ??= this.readContextBlobTx(
            db,
            occurrence.content.digest,
          );
          let sourceBytes: Uint8Array;
          if (
            source.resourceKind === 'instruction_component' &&
            typeof source.sourceLocator === 'string'
          ) {
            const range = source.sourceLocator.match(/#bytes=(\d+)-(\d+)$/u);
            if (range === null) throw new HistoryStoreError('history_invalid');
            const start = Number(range[1]);
            const end = Number(range[2]);
            if (
              !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
              start < 0 || end <= start || end > occurrenceBytes.byteLength
            ) throw new HistoryStoreError('history_invalid');
            sourceBytes = occurrenceBytes.slice(start, end);
          } else {
            let value: unknown;
            try {
              value = JSON.parse(decoder.decode(occurrenceBytes));
            } catch {
              throw new HistoryStoreError('history_invalid');
            }
            const object = validJsonObject(value) ? value : undefined;
            const results = object?.role === 'tool' && Array.isArray(object.content)
              ? object.content
              : [];
            const result = results.find((candidate) =>
              validJsonObject(candidate) &&
              candidate.callId === source.callId &&
              typeof candidate.text === 'string'
            );
            if (!validJsonObject(result)) {
              throw new HistoryStoreError('history_invalid');
            }
            sourceBytes = encoder.encode(String(result.text));
          }
          if (contextDigestSync(sourceBytes) !== sourceContentDigest) {
            throw new HistoryStoreError('history_invalid');
          }
          this.insertContextBlobTx(db, {
            digest: sourceContentDigest,
            byteLength: sourceBytes.byteLength,
            mediaType: 'text/plain; charset=utf-8',
            bytes: sourceBytes,
          });
        }
        storedSources.push({
          ...sourceWithoutWorkerSequence,
          contentDigest: sourceContentDigest,
          ...(sourceEventOrdinal === undefined ? {} : { sourceEventOrdinal }),
        });
      }
      db.prepare(`
        INSERT INTO context_occurrences(
          execution_id, occurrence_id, kind, content_digest, occurrence_digest
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        executionId,
        occurrence.occurrenceId,
        occurrence.kind,
        occurrence.content.digest,
        occurrence.occurrenceDigest,
      );
      for (const [sourceIndex, source] of storedSources.entries()) {
        db.prepare(`
          INSERT INTO context_occurrence_sources(
            execution_id, occurrence_id, source_ordinal, stage, resource_kind,
            logical_identity, source_locator, content_digest, lane, model_step,
            call_id, worker_sequence, source_event_ordinal
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          executionId,
          occurrence.occurrenceId,
          sourceIndex + 1,
          source.stage,
          source.resourceKind,
          source.logicalIdentity ?? null,
          source.sourceLocator ?? null,
          source.contentDigest ?? null,
          source.lane ?? null,
          source.modelStep ?? null,
          source.callId ?? null,
          occurrence.sourceRelations[sourceIndex].sourceWorkerSequence ?? null,
          source.sourceEventOrdinal ?? null,
        );
      }
    }
    for (const splice of delta.splices) {
      if (
        splice.start > currentCount ||
        splice.start + splice.deleteCount > currentCount
      ) {
        throw new HistoryStoreError('history_invalid');
      }
      for (const insertion of splice.insertions) {
        const occurrence = db.prepare(`
          SELECT occurrence_digest FROM context_occurrences
          WHERE execution_id = ? AND occurrence_id = ?
        `).get(executionId, insertion.occurrenceId) as SqlRow | undefined;
        if (
          occurrence === undefined ||
          occurrence.occurrence_digest !== insertion.occurrenceDigest
        ) throw new HistoryStoreError('history_invalid');
      }
      currentCount = currentCount - splice.deleteCount +
        splice.insertions.length;
    }
    if (
      currentCount !== delta.resultItemCount ||
      contextRevisionDigestSync(delta) !== delta.revisionDigest
    ) throw new HistoryStoreError('history_invalid');
    db.prepare(`
      INSERT INTO context_sequence_revisions(
        execution_id, revision_digest, lane, sequence_kind,
        base_revision_digest, result_item_count
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      executionId,
      delta.revisionDigest,
      delta.lane,
      delta.purpose,
      delta.baseRevisionDigest ?? null,
      delta.resultItemCount,
    );
    for (const [spliceIndex, splice] of delta.splices.entries()) {
      db.prepare(`
        INSERT INTO context_sequence_splices(
          execution_id, revision_digest, splice_ordinal, start_index, delete_count
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        executionId,
        delta.revisionDigest,
        spliceIndex + 1,
        splice.start,
        splice.deleteCount,
      );
      for (const [insertionIndex, insertion] of splice.insertions.entries()) {
        db.prepare(`
          INSERT INTO context_sequence_insertions(
            execution_id, revision_digest, splice_ordinal, insertion_ordinal,
            occurrence_id, occurrence_digest
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          executionId,
          delta.revisionDigest,
          spliceIndex + 1,
          insertionIndex + 1,
          insertion.occurrenceId,
          insertion.occurrenceDigest,
        );
      }
    }
    db.prepare(`
      INSERT INTO model_requests(
        execution_id, request_ordinal, observation_ordinal, evidence_id,
        lane, phase, model_step, purpose, model_selection_json,
        revision_digest, source_call_id
      ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      executionId,
      delta.requestOrdinal,
      observationOrdinal,
      delta.lane,
      delta.modelStep,
      delta.purpose,
      delta.modelSelection === undefined ? null : JSON.stringify(delta.modelSelection),
      delta.revisionDigest,
      delta.sourceCallId ?? null,
    );
  }

  /** Compare the live provider observations with the Worker-completed evidence envelope. */
  private evidenceMatchesJournal(
    db: DatabaseSync,
    executionId: string,
    evidence: ProviderEvidenceV5,
  ): boolean {
    const providerRows = db.prepare(`
      SELECT observation_ordinal, observation_kind, request_ordinal,
        byte_offset, observation_json, raw_bytes
      FROM provider_observation_facts
      WHERE execution_id = ? ORDER BY observation_ordinal
    `).all(executionId) as SqlRow[];
    const runtimeRows = db.prepare(`
      SELECT r.observation_ordinal, r.envelope_kind, r.request_ordinal,
        r.event_json, d.stream_key, d.mode, d.text_fragment
      FROM runtime_occurrences r
      LEFT JOIN execution_progress_deltas d
        ON d.execution_id = r.execution_id AND d.event_ordinal = r.observation_ordinal
      WHERE r.execution_id = ? ORDER BY r.observation_ordinal
    `).all(executionId) as SqlRow[];
    type Observed = {
      request?: Record<string, unknown>;
      response?: { readonly status: unknown; readonly headers: unknown };
      chunks: Uint8Array[];
      chunkBytes: number;
      sseEvents: unknown[];
      parserTransitions: unknown[];
    };
    const observed = new Map<number, Observed>();
    const liveRuntime: Array<
      {
        readonly event: Record<string, unknown>;
        readonly requestOrdinal?: number;
      }
    > = [];
    const liveEffects: Record<string, unknown>[] = [];
    const liveAgentProgress: Record<string, unknown>[] = [];
    const sameHeaders = (left: unknown, right: unknown): boolean => {
      if (
        typeof left !== 'object' || left === null || Array.isArray(left) ||
        typeof right !== 'object' || right === null || Array.isArray(right)
      ) return false;
      const sort = (value: object) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
      return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
    };
    const normalizedJson = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalizedJson);
      if (typeof value !== 'object' || value === null) return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalizedJson(nested)]),
      );
    };
    const sameJson = (left: unknown, right: unknown): boolean =>
      JSON.stringify(normalizedJson(left)) ===
        JSON.stringify(normalizedJson(right));
    try {
      const progressSnapshots = new Map<string, string>();
      for (const row of runtimeRows) {
        let event: Record<string, unknown>;
        try {
          const parsed = JSON.parse(String(row.event_json));
          if (!validJsonObject(parsed)) return false;
          event = parsed;
        } catch {
          return false;
        }
        if (row.stream_key !== null) {
          const key = String(row.stream_key);
          const previous = progressSnapshots.get(key) ?? '';
          const text = row.mode === 'append'
            ? previous + String(row.text_fragment)
            : String(row.text_fragment);
          progressSnapshots.set(key, text);
          if (row.envelope_kind === 'runtime_event') {
            if (!validJsonObject(event.event)) return false;
            (event.event as Record<string, unknown>).text = text;
          } else event.text = text;
        }
        if (row.envelope_kind === 'effect_observation') {
          liveEffects.push(structuredClone(event));
        } else if (row.envelope_kind === 'provider_observation') {
          liveRuntime.push({
            event: structuredClone(event),
            ...(row.request_ordinal === null
              ? {}
              : { requestOrdinal: Number(row.request_ordinal) }),
          });
        } else if (row.envelope_kind === 'runtime_event') {
          if (!validJsonObject(event.event)) return false;
          const agentEvent = event.event as Record<string, unknown>;
          if (
            agentEvent.kind === 'assistant_progress' ||
            agentEvent.kind === 'tool_progress'
          ) liveAgentProgress.push(structuredClone(agentEvent));
        } else return false;
      }
      for (const row of providerRows) {
        let observation: unknown;
        try {
          observation = row.observation_kind === 'response_bytes'
            ? {
              kind: 'response_bytes',
              requestOrdinal: Number(row.request_ordinal),
              offset: Number(row.byte_offset),
              bytesBase64: uint8ToBase64(
                row.raw_bytes instanceof Uint8Array
                  ? row.raw_bytes
                  : new Uint8Array(row.raw_bytes as ArrayBuffer),
              ),
            }
            : JSON.parse(String(row.observation_json));
        } catch {
          return false;
        }
        if (
          !validateProviderEvidenceObservation(observation) ||
          observation.kind === 'runtime_event'
        ) return false;
        const ordinal = observation.kind === 'request_start'
          ? observation.request.ordinal
          : observation.requestOrdinal;
        let current = observed.get(ordinal);
        if (current === undefined) {
          current = {
            chunks: [],
            chunkBytes: 0,
            sseEvents: [],
            parserTransitions: [],
          };
          observed.set(ordinal, current);
        }
        if (observation.kind === 'request_start') {
          if (current.request !== undefined) return false;
          current.request = structuredClone(
            observation.request,
          ) as unknown as Record<string, unknown>;
        } else if (observation.kind === 'response_start') {
          if (current.response !== undefined) return false;
          current.response = {
            status: observation.response.status,
            headers: structuredClone(observation.response.headers),
          };
        } else if (observation.kind === 'response_bytes') {
          const bytes = Uint8Array.fromBase64(observation.bytesBase64);
          if (observation.offset !== current.chunkBytes + bytes.byteLength) {
            return false;
          }
          current.chunks.push(bytes);
          current.chunkBytes += bytes.byteLength;
        } else if (observation.kind === 'sse_event') {
          current.sseEvents.push(structuredClone(observation.event));
        } else if (observation.kind === 'parser_transition') {
          current.parserTransitions.push(
            structuredClone(observation.transition),
          );
        }
      }
      const finalByOrdinal = new Map(
        evidence.requests.map((record) => [record.request.ordinal, record]),
      );
      for (const record of evidence.requests) {
        const live = observed.get(record.request.ordinal);
        if (live === undefined || live.request === undefined) return false;
      }
      for (const [ordinal, live] of observed) {
        const final = finalByOrdinal.get(ordinal);
        if (final === undefined || live.request === undefined) return false;
        if (!sameJson(final.request, live.request)) {
          return false;
        }
        if ((live.response === undefined) !== (final.response === undefined)) {
          return false;
        }
        if (
          live.response !== undefined && final.response !== undefined &&
          (final.response.status !== live.response.status ||
            !sameHeaders(final.response.headers, live.response.headers))
        ) return false;
        if (
          live.chunks.length > 0 || final.response?.rawBodyBytes !== undefined
        ) {
          const bytes = new Uint8Array(live.chunkBytes);
          let offset = 0;
          for (const chunk of live.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const expectedBase64 = bytes.toBase64();
          if (
            final.response === undefined ||
            final.response.rawBodyBytes !== bytes.byteLength ||
            expectedBase64 !== '' &&
              final.response.rawBodyBase64 !== expectedBase64 ||
            expectedBase64 === '' &&
              final.response.rawBodyBase64 !== undefined &&
              final.response.rawBodyBase64 !== ''
          ) return false;
        }
        if (!sameJson(final.sseEvents, live.sseEvents)) return false;
        if (!sameJson(final.parserTransitions, live.parserTransitions)) {
          return false;
        }
      }
      // A complete provider envelope cannot silently omit all physical provider rows when
      // the execution already recorded logical model requests. Provider-free models are the
      // explicit exception: they have no transport rows, but still emit model-result facts.
      const logicalRequests = db.prepare(`
        SELECT request_ordinal, purpose FROM model_requests
        WHERE execution_id = ? ORDER BY request_ordinal
      `).all(executionId) as SqlRow[];
      if (logicalRequests.length > 0) {
        if (evidence.requests.length === 0) {
          const userTurnCount = logicalRequests.filter((row) => row.purpose === 'user_turn').length;
          const modelResultCount = evidence.runtimeEvents.filter((event) =>
            event.kind === 'model_result'
          ).length;
          if (modelResultCount < userTurnCount) return false;
        } else {
          const evidenceLogicalOrdinals = new Set(
            evidence.requests.map((record) => record.request.contextRequestOrdinal),
          );
          if (
            logicalRequests.some((row) => !evidenceLogicalOrdinals.has(Number(row.request_ordinal)))
          ) return false;
        }
      }
      const finalRuntime = evidence.runtimeEvents;
      const runtimeEventJson = (event: unknown): string => JSON.stringify(normalizedJson(event));
      const runtimeRequestOrdinal = (
        event: ProviderEvidenceRuntimeEvent,
      ): number | undefined =>
        'requestOrdinal' in event && event.requestOrdinal !== undefined
          ? event.requestOrdinal
          : undefined;
      const finalRuntimeByJson = new Set(finalRuntime.map(runtimeEventJson));
      const finalRuntimeExact = new Set(
        finalRuntime.map((event) =>
          `${runtimeRequestOrdinal(event) ?? 'none'}:${runtimeEventJson(event)}`
        ),
      );
      const liveRuntimeByJson = new Set(
        liveRuntime.map((live) => runtimeEventJson(live.event)),
      );
      const liveRuntimeExact = new Set(
        liveRuntime.map((live) =>
          `${live.requestOrdinal ?? 'none'}:${runtimeEventJson(live.event)}`
        ),
      );
      const hasFinalRuntime = (live: typeof liveRuntime[number]): boolean => {
        const json = runtimeEventJson(live.event);
        return live.requestOrdinal === undefined
          ? finalRuntimeByJson.has(json)
          : finalRuntimeExact.has(`${live.requestOrdinal}:${json}`);
      };
      const hasLiveRuntime = (event: ProviderEvidenceRuntimeEvent): boolean => {
        const json = runtimeEventJson(event);
        const ordinal = runtimeRequestOrdinal(event);
        return liveRuntimeByJson.has(json) && (
          liveRuntimeExact.has(`none:${json}`) ||
          liveRuntimeExact.has(`${ordinal ?? 'none'}:${json}`)
        );
      };
      const latestProgress = new Map<
        string,
        {
          readonly event: Record<string, unknown>;
          readonly requestOrdinal?: number;
        }
      >();
      for (const live of liveRuntime) {
        if (live.event.kind === 'assistant_progress') {
          latestProgress.set(
            `assistant:${live.requestOrdinal ?? 'unknown'}`,
            live,
          );
        } else if (live.event.kind === 'tool_progress') {
          latestProgress.set(`tool:${live.event.callId}`, live);
        }
      }
      for (const live of liveRuntime) {
        if (
          live.event.kind === 'assistant_progress' ||
          live.event.kind === 'tool_progress'
        ) continue;
        if (!hasFinalRuntime(live)) return false;
      }
      for (const live of latestProgress.values()) {
        if (!hasFinalRuntime(live)) return false;
      }
      // A complete envelope cannot contain facts that were never observed by the Host. This
      // catches a dropped final assistant/tool progress as well as a fabricated terminal fact.
      for (const event of finalRuntime) {
        if (!hasLiveRuntime(event)) return false;
      }
      const latestAgentProgress = new Map<string, Record<string, unknown>>();
      for (const agentEvent of liveAgentProgress) {
        const key = agentEvent.kind === 'assistant_progress'
          ? 'assistant'
          : `tool:${String(agentEvent.callId)}`;
        latestAgentProgress.set(key, agentEvent);
      }
      const finalAssistantProgress = new Set(
        finalRuntime
          .filter((event) => event.kind === 'assistant_progress')
          .map((event) => event.text),
      );
      const finalToolProgress = new Set(
        finalRuntime
          .filter((event) => event.kind === 'tool_progress')
          .map((event) => JSON.stringify([event.callId, event.name, event.text])),
      );
      for (const agentEvent of latestAgentProgress.values()) {
        const found = agentEvent.kind === 'assistant_progress'
          ? finalAssistantProgress.has(String(agentEvent.text))
          : finalToolProgress.has(JSON.stringify([
            agentEvent.callId,
            agentEvent.name,
            agentEvent.text,
          ]));
        if (!found) return false;
      }
      const latestEffects = new Map<string, Record<string, unknown>>();
      for (const effect of liveEffects) {
        const effectCallId = effect.kind === 'tool_call'
          ? (effect.call as Record<string, unknown> | undefined)?.callId
          : effect.kind === 'tool_result'
          ? (effect.result as Record<string, unknown> | undefined)?.callId
          : effect.callId;
        latestEffects.set(
          effect.kind === 'tool_progress'
            ? `progress:${String(effect.callId)}`
            : `${String(effect.kind)}:${String(effectCallId)}`,
          effect,
        );
      }
      const finalToolCalls = new Set(
        finalRuntime
          .filter((event) => event.kind === 'tool_call')
          .map((event) => runtimeEventJson(event.call)),
      );
      const finalToolResults = new Set(
        finalRuntime
          .filter((event) => event.kind === 'tool_result')
          .map((event) => runtimeEventJson(event.result)),
      );
      for (const effect of latestEffects.values()) {
        const found = effect.kind === 'tool_call'
          ? finalToolCalls.has(runtimeEventJson(effect.call))
          : effect.kind === 'tool_progress'
          ? finalToolProgress.has(JSON.stringify([
            effect.callId,
            effect.name,
            effect.text,
          ]))
          : effect.kind === 'tool_result'
          ? finalToolResults.has(runtimeEventJson(effect.result))
          : false;
        if (!found) return false;
      }
      if (evidence.requests.length > 0 && observed.size === 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  private contextManifestV5MatchesRows(
    db: DatabaseSync,
    executionId: string,
    manifest: ExecutionContextManifestV2,
  ): boolean {
    if (!validateExecutionContextManifest(manifest)) return false;
    try {
      const requests = db.prepare(`
        SELECT request_ordinal, revision_digest FROM model_requests
        WHERE execution_id = ? ORDER BY request_ordinal
      `).all(executionId) as SqlRow[];
      if (requests.length !== manifest.requestCount) return false;
      for (const [index, request] of requests.entries()) {
        const expected = manifest.requests[index];
        if (
          expected === undefined ||
          expected.requestOrdinal !== Number(request.request_ordinal) ||
          expected.revisionDigest !== String(request.revision_digest)
        ) return false;
      }

      const reachableRevisions = new Set<string>();
      const reachableOccurrences = new Map<string, string>();
      const pending = manifest.requests.map((request) => request.revisionDigest);
      while (pending.length > 0) {
        const digest = pending.pop()!;
        if (reachableRevisions.has(digest)) continue;
        const revision = db.prepare(`
          SELECT lane, sequence_kind, base_revision_digest, result_item_count
          FROM context_sequence_revisions
          WHERE execution_id = ? AND revision_digest = ?
        `).get(executionId, digest) as SqlRow | undefined;
        if (revision === undefined) return false;
        const splices = (db.prepare(`
          SELECT splice_ordinal, start_index, delete_count
          FROM context_sequence_splices
          WHERE execution_id = ? AND revision_digest = ? ORDER BY splice_ordinal
        `).all(executionId, digest) as SqlRow[]).map((splice) => ({
          start: Number(splice.start_index),
          deleteCount: Number(splice.delete_count),
          insertions: (db.prepare(`
            SELECT occurrence_id, occurrence_digest
            FROM context_sequence_insertions
            WHERE execution_id = ? AND revision_digest = ? AND splice_ordinal = ?
            ORDER BY insertion_ordinal
          `).all(
            executionId,
            digest,
            Number(splice.splice_ordinal),
          ) as SqlRow[]).map(
            (insertion) => ({
              occurrenceId: String(insertion.occurrence_id),
              occurrenceDigest: String(insertion.occurrence_digest),
            }),
          ),
        }));
        const baseRevisionDigest = revision.base_revision_digest === null
          ? undefined
          : String(revision.base_revision_digest);
        if (
          contextRevisionDigestSync({
            lane: revision.lane as 'parent' | 'planner',
            purpose: revision.sequence_kind as 'user_turn' | 'web_search',
            ...(baseRevisionDigest === undefined ? {} : { baseRevisionDigest }),
            resultItemCount: Number(revision.result_item_count),
            splices,
          }) !== digest
        ) return false;
        reachableRevisions.add(digest);
        if (baseRevisionDigest !== undefined) pending.push(baseRevisionDigest);
        for (const splice of splices) {
          for (const insertion of splice.insertions) {
            const previous = reachableOccurrences.get(insertion.occurrenceId);
            if (
              previous !== undefined && previous !== insertion.occurrenceDigest
            ) return false;
            reachableOccurrences.set(
              insertion.occurrenceId,
              insertion.occurrenceDigest,
            );
          }
        }
      }
      const revisionCount = Number(
        (db.prepare(`
        SELECT count(*) AS count FROM context_sequence_revisions
        WHERE execution_id = ?
      `).get(executionId) as SqlRow).count,
      );
      const occurrenceCount = Number(
        (db.prepare(`
        SELECT count(*) AS count FROM context_occurrences
        WHERE execution_id = ?
      `).get(executionId) as SqlRow).count,
      );
      if (
        revisionCount !== reachableRevisions.size ||
        occurrenceCount !== reachableOccurrences.size
      ) return false;
      for (const [occurrenceId, occurrenceDigest] of reachableOccurrences) {
        const occurrence = db.prepare(`
          SELECT o.kind, o.occurrence_digest,
            o.content_digest, b.byte_length, b.media_type, b.raw_bytes
          FROM context_occurrences o JOIN context_blobs b ON b.digest = o.content_digest
          WHERE o.execution_id = ? AND o.occurrence_id = ?
        `).get(executionId, occurrenceId) as SqlRow | undefined;
        if (
          occurrence === undefined ||
          occurrence.occurrence_digest !== occurrenceDigest
        ) {
          return false;
        }
        const bytes = occurrence.raw_bytes instanceof Uint8Array
          ? occurrence.raw_bytes
          : new Uint8Array(occurrence.raw_bytes as ArrayBuffer);
        if (
          bytes.byteLength !== Number(occurrence.byte_length) ||
          contextDigestSync(bytes) !== String(occurrence.content_digest)
        ) return false;
        const sourceRelations = (db.prepare(`
          SELECT stage, resource_kind, logical_identity, source_locator,
            content_digest, lane, model_step, call_id, worker_sequence
          FROM context_occurrence_sources
          WHERE execution_id = ? AND occurrence_id = ? ORDER BY source_ordinal
        `).all(executionId, occurrenceId) as SqlRow[]).map((source) => ({
          stage: source.stage as ContextRelationStage,
          resourceKind: source
            .resource_kind as ContextSourceRelation['resourceKind'],
          ...(source.logical_identity === null
            ? {}
            : { logicalIdentity: String(source.logical_identity) }),
          ...(source.source_locator === null
            ? {}
            : { sourceLocator: String(source.source_locator) }),
          ...(source.content_digest === null
            ? {}
            : { contentDigest: String(source.content_digest) }),
          ...(source.lane === null ? {} : { lane: source.lane as 'parent' | 'planner' }),
          ...(source.model_step === null ? {} : { modelStep: Number(source.model_step) }),
          ...(source.call_id === null ? {} : { callId: String(source.call_id) }),
          ...(source.worker_sequence === null
            ? {}
            : { sourceWorkerSequence: Number(source.worker_sequence) }),
        }));
        if (
          contextOccurrenceDigestSync({
            occurrenceId,
            kind: occurrence.kind as ContextOccurrenceInput['kind'],
            content: {
              digest: String(occurrence.content_digest),
              byteLength: Number(occurrence.byte_length),
              mediaType: String(
                occurrence.media_type,
              ) as ContextOccurrenceInput['content']['mediaType'],
            },
            sourceRelations,
          }) !== occurrenceDigest
        ) return false;
      }
      const externalRows = db.prepare(`
        SELECT stage, resource_kind, logical_identity, source_locator, content_digest,
          lane, model_step, call_id, request_ordinal
        FROM execution_context_relations
        WHERE execution_id = ? AND stage IN ('observed', 'loaded')
      `).all(executionId) as SqlRow[];
      const externalKey = (relation: ContextSourceRelation): string =>
        JSON.stringify([
          relation.stage,
          relation.resourceKind,
          relation.logicalIdentity,
          relation.sourceLocator,
          relation.contentDigest,
          relation.lane,
          relation.modelStep,
          relation.callId,
          relation.requestOrdinal,
        ]);
      const storedExternal = new Set(externalRows.map((row) =>
        externalKey({
          stage: row.stage as ContextRelationStage,
          resourceKind: row
            .resource_kind as ContextSourceRelation['resourceKind'],
          ...(row.logical_identity === null
            ? {}
            : { logicalIdentity: String(row.logical_identity) }),
          ...(row.source_locator === null ? {} : { sourceLocator: String(row.source_locator) }),
          ...(row.content_digest === null ? {} : { contentDigest: String(row.content_digest) }),
          ...(row.lane === null ? {} : { lane: row.lane as 'parent' | 'planner' }),
          ...(row.model_step === null ? {} : { modelStep: Number(row.model_step) }),
          ...(row.call_id === null ? {} : { callId: String(row.call_id) }),
          ...(row.request_ordinal === null ? {} : { requestOrdinal: Number(row.request_ordinal) }),
        })
      ));
      if (
        manifest.externalRelations.length !== storedExternal.size ||
        manifest.externalRelations.some((relation) => !storedExternal.has(externalKey(relation)))
      ) return false;
      const body = {
        schemaVersion: manifest.schemaVersion,
        requestCount: manifest.requestCount,
        requests: manifest.requests,
        externalRelations: manifest.externalRelations,
      } as const;
      return contextManifestDigestSync(body) === manifest.digest;
    } catch {
      return false;
    }
  }

  private writeCaptures(
    db: DatabaseSync,
    executionId: string,
    input: CanonicalTurnCommitInput | NonCanonicalExecutionInput,
    evidence:
      | ProviderEvidenceV3
      | ProviderEvidenceV4
      | ProviderEvidenceV5
      | undefined,
    diagnostic: FailureDiagnosticV1 | undefined,
  ): HistoryCaptureResult {
    if (evidence !== undefined && evidence.schemaVersion !== 5) {
      throw new HistoryStoreError('history_invalid');
    }
    if (
      evidence?.schemaVersion === 5 && evidence.capture === 'complete' &&
      !this.evidenceMatchesJournal(db, executionId, evidence)
    ) throw new HistoryStoreError('history_invalid');
    let contextDurability: HistoryCaptureResult['contextDurability'] = 'none';
    if (input.contextSnapshot !== undefined) {
      if (
        input.contextManifest === undefined ||
        !this.contextManifestV5MatchesRows(
          db,
          executionId,
          input.contextManifest,
        )
      ) throw new HistoryStoreError('history_invalid');
      contextDurability = 'complete';
    } else if (input.contextManifest !== undefined) {
      throw new HistoryStoreError('history_invalid');
    }
    let evidenceDurability: HistoryCaptureResult['evidenceDurability'];
    let evidencePersistenceError: HistoryCaptureResult['evidencePersistenceError'];
    let diagnosticDurability: HistoryCaptureResult['diagnosticDurability'];
    let diagnosticPersistenceError: HistoryCaptureResult['diagnosticPersistenceError'];
    if (evidence !== undefined) {
      if (
        !validateProviderEvidence(evidence) ||
        evidence.schemaVersion !== 5 || evidence.capture !== 'complete' ||
        evidence.sessionId !== input.sessionCorrelation ||
        evidence.turnNumber !== input.turn ||
        JSON.stringify(evidence.build) !== JSON.stringify(input.build) ||
        JSON.stringify(evidence.definition) !== JSON.stringify(input.definition)
      ) {
        evidenceDurability = 'failed';
        evidencePersistenceError = 'provider_evidence_invalid';
      } else {
        // A generation that supplied a context basis must have crossed the logical request
        // observation boundary before its physical provider evidence can be complete.
        if (
          input.contextSnapshot !== undefined &&
          evidence.requests.some((record) => {
            const logicalOrdinal = record.request.contextRequestOrdinal;
            return logicalOrdinal === undefined ||
              db.prepare(`SELECT 1 FROM model_requests
                WHERE execution_id = ? AND request_ordinal = ?`).get(
                  executionId,
                  logicalOrdinal,
                ) === undefined;
          })
        ) throw new HistoryStoreError('history_invalid');
        this.writeEvidenceHeaderTx(db, executionId, evidence);
        for (const record of evidence.requests) {
          const logicalOrdinal = record.request.contextRequestOrdinal ??
            record.request.ordinal;
          const existing = db.prepare(`SELECT 1 FROM model_requests
            WHERE execution_id = ? AND request_ordinal = ?`).get(
            executionId,
            logicalOrdinal,
          );
          if (existing !== undefined) {
            db.prepare(`UPDATE model_requests SET evidence_id = ?
              WHERE execution_id = ? AND request_ordinal = ?`).run(
              evidence.evidenceId,
              executionId,
              logicalOrdinal,
            );
          }
        }
        evidenceDurability = 'yes';
      }
    }
    if (diagnostic !== undefined) {
      if (
        !validateFailureDiagnostic(diagnostic) ||
        diagnostic.turnNumber !== input.turn
      ) {
        diagnosticDurability = 'failed';
        diagnosticPersistenceError = 'diagnostic_invalid';
      } else {
        const payload = encodeFailureDiagnostic(diagnostic);
        const bytes = encoder.encode(`${payload}\n`).byteLength;
        const capacity = db.prepare(
          'SELECT count(*) AS count, coalesce(sum(payload_bytes), 0) AS bytes FROM failure_diagnostics',
        ).get() as SqlRow;
        if (
          Number(capacity.count) >= MAX_FAILURE_DIAGNOSTICS ||
          Number(capacity.bytes) + bytes > MAX_FAILURE_DIAGNOSTIC_BYTES
        ) {
          diagnosticDurability = 'failed';
          diagnosticPersistenceError = 'diagnostic_capacity';
        } else {
          const evidenceId = evidenceDurability === 'yes' &&
              evidence?.diagnosticId === diagnostic.diagnosticId
            ? evidence.evidenceId
            : null;
          db.prepare(`
          INSERT INTO failure_diagnostics(
            diagnostic_id, execution_id, evidence_id, occurred_at, payload_bytes,
            diagnostic_json, link_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            diagnostic.diagnosticId,
            executionId,
            evidenceId,
            diagnostic.occurredAt,
            bytes,
            `${payload}\n`,
            evidenceId === null ? 'unlinked' : 'linked',
          );
          if (evidenceId !== null) {
            db.prepare(
              'INSERT INTO diagnostic_evidence_links(diagnostic_id, evidence_id) VALUES (?, ?)',
            ).run(diagnostic.diagnosticId, evidenceId);
          }
          diagnosticDurability = 'yes';
        }
      }
    }
    return {
      ...(evidenceDurability === undefined ? {} : { evidenceDurability }),
      ...(evidencePersistenceError === undefined ? {} : { evidencePersistenceError }),
      ...(diagnosticDurability === undefined ? {} : { diagnosticDurability }),
      ...(diagnosticPersistenceError === undefined ? {} : { diagnosticPersistenceError }),
      contextDurability,
    };
  }

  private artifactMatchesInput(
    artifact: StoredWorkerExecutionArtifact,
    input: CanonicalTurnCommitInput | NonCanonicalExecutionInput,
  ): boolean {
    return artifact.executionId === input.executionId &&
      artifact.createdAt === input.createdAt &&
      artifact.sessionId === input.sessionCorrelation &&
      artifact.turn === input.turn && artifact.agent === input.agent &&
      artifact.command.task === input.task &&
      artifact.baseStateRevision === input.baseStateRevision &&
      JSON.stringify(artifact.build) === JSON.stringify(input.build) &&
      JSON.stringify(artifact.definition) ===
        JSON.stringify(input.definition) &&
      (input.manifest === undefined ||
        JSON.stringify(artifact.manifest) === JSON.stringify(input.manifest)) &&
      (input.instanceCorrelation === undefined ||
        artifact.instanceCorrelation === input.instanceCorrelation) &&
      (input.workerGeneration === undefined ||
        artifact.workerGeneration === input.workerGeneration);
  }

  private writeEvidenceHeaderTx(
    db: DatabaseSync,
    executionId: string,
    evidence: ProviderEvidenceV5,
  ): void {
    db.prepare(`
      INSERT INTO provider_evidence(
        evidence_id, execution_id, schema_version, created_at, capture,
        normalized_outcome, outcome, settlement, turn_provider_request_count,
        runtime_provider_request_count, diagnostic_id, link_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked')
      ON CONFLICT(evidence_id) DO UPDATE SET
        execution_id=excluded.execution_id, schema_version=excluded.schema_version,
        created_at=excluded.created_at, capture=excluded.capture,
        normalized_outcome=excluded.normalized_outcome, outcome=excluded.outcome,
        settlement=excluded.settlement,
        turn_provider_request_count=excluded.turn_provider_request_count,
        runtime_provider_request_count=excluded.runtime_provider_request_count,
        diagnostic_id=excluded.diagnostic_id, link_status='linked'
    `).run(
      evidence.evidenceId,
      executionId,
      evidence.schemaVersion,
      evidence.createdAt,
      evidence.capture,
      evidence.normalizedOutcome,
      evidence.capture === 'complete' ? evidence.outcome : null,
      evidence.capture === 'partial' ? evidence.settlement : null,
      evidence.turnProviderRequestCount ?? null,
      evidence.runtimeProviderRequestCount ?? null,
      evidence.diagnosticId ?? null,
    );
  }

  private writeArtifactTx(
    db: DatabaseSync,
    artifact: WorkerExecutionArtifactV7,
  ): void {
    db.prepare(`
      INSERT INTO execution_artifacts(
        artifact_id, execution_id, settled_at, command_session,
        command_instance_correlation, command_worker_generation,
        command_base_revision, command_id, proposed_revision, committed_revision,
        provider_evidence_id, provider_evidence_durability, provider_evidence_error,
        store_result, store_error, acknowledgement, settlement, lifecycle,
        normalized_outcome, adoption, context_capture, artifact_persistence_error,
        link_status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked'
      )
      ON CONFLICT(execution_id) DO UPDATE SET
        artifact_id=excluded.artifact_id, settled_at=excluded.settled_at,
        command_session=excluded.command_session,
        command_instance_correlation=excluded.command_instance_correlation,
        command_worker_generation=excluded.command_worker_generation,
        command_base_revision=excluded.command_base_revision,
        command_id=excluded.command_id, proposed_revision=excluded.proposed_revision,
        committed_revision=excluded.committed_revision,
        provider_evidence_id=excluded.provider_evidence_id,
        provider_evidence_durability=excluded.provider_evidence_durability,
        provider_evidence_error=excluded.provider_evidence_error,
        store_result=excluded.store_result, store_error=excluded.store_error,
        acknowledgement=excluded.acknowledgement, settlement=excluded.settlement,
        lifecycle=excluded.lifecycle, normalized_outcome=excluded.normalized_outcome,
        adoption=excluded.adoption, context_capture=excluded.context_capture,
        artifact_persistence_error=excluded.artifact_persistence_error,
        link_status='linked'
    `).run(
      artifact.executionId,
      artifact.executionId,
      artifact.settledAt,
      artifact.command.correlation.session,
      artifact.command.correlation.instanceCorrelation,
      artifact.command.correlation.workerGeneration,
      artifact.command.correlation.baseStateRevision,
      artifact.command.correlation.command,
      artifact.proposedStateRevision ?? null,
      artifact.committedStateRevision ?? null,
      artifact.providerEvidenceId ?? null,
      artifact.providerEvidenceDurability ?? null,
      artifact.providerEvidencePersistenceError ?? null,
      artifact.storeResult,
      artifact.storeError ?? null,
      artifact.acknowledgement,
      artifact.settlement,
      artifact.lifecycle,
      artifact.normalizedOutcome,
      artifact.adoption,
      artifact.contextCapture,
      artifact.artifactPersistenceError ?? null,
    );
    db.prepare('DELETE FROM execution_artifact_trace WHERE artifact_id = ?')
      .run(
        artifact.executionId,
      );
    db.prepare(`
      INSERT INTO worker_generations(
        worker_generation, session_id, instance_correlation
      ) VALUES (?, ?, ?)
      ON CONFLICT(worker_generation) DO NOTHING
    `).run(
      artifact.workerGeneration,
      artifact.sessionId,
      artifact.instanceCorrelation,
    );
    const generation = db.prepare(`
      SELECT session_id, instance_correlation FROM worker_generations
      WHERE worker_generation = ?
    `).get(artifact.workerGeneration) as SqlRow;
    if (
      generation.session_id !== artifact.sessionId ||
      generation.instance_correlation !== artifact.instanceCorrelation
    ) throw new HistoryStoreError('history_invalid');
    const insertFact = db.prepare(`
      INSERT INTO worker_protocol_observations(
        worker_generation, occurrence_key, direction, kind, semantic_subtype,
        correlation_session, instance_correlation, base_revision,
        correlation_command, ack_accepted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRef = db.prepare(`
      INSERT INTO execution_artifact_trace(
        artifact_id, ordinal, observation_id
      ) VALUES (?, ?, ?)
    `);
    artifact.protocolTrace.forEach((entry, index) => {
      const ackAccepted = entry.ackAccepted === undefined ? null : entry.ackAccepted ? 1 : 0;
      const occurrenceKey = `${entry.correlation.command}:${index + 1}`;
      let stored = db.prepare(`
        SELECT * FROM worker_protocol_observations
        WHERE worker_generation = ? AND occurrence_key = ?
      `).get(artifact.workerGeneration, occurrenceKey) as SqlRow | undefined;
      if (
        stored !== undefined && (
          stored.direction !== entry.direction || stored.kind !== entry.kind ||
          stored.semantic_subtype !== entry.semanticSubtype ||
          stored.correlation_session !== entry.correlation.session ||
          stored.instance_correlation !==
            entry.correlation.instanceCorrelation ||
          Number(stored.base_revision) !==
            entry.correlation.baseStateRevision ||
          stored.correlation_command !== entry.correlation.command ||
          (stored.ack_accepted === null ? undefined : Number(stored.ack_accepted) === 1) !==
            entry.ackAccepted
        )
      ) throw new HistoryStoreError('history_invalid');
      if (stored === undefined) {
        const inserted = insertFact.run(
          artifact.workerGeneration,
          occurrenceKey,
          entry.direction,
          entry.kind,
          entry.semanticSubtype,
          entry.correlation.session,
          entry.correlation.instanceCorrelation,
          entry.correlation.baseStateRevision,
          entry.correlation.command,
          ackAccepted,
        );
        stored = { observation_id: inserted.lastInsertRowid };
      }
      insertRef.run(
        artifact.executionId,
        index + 1,
        Number(stored.observation_id),
      );
    });
  }

  async readWorker(id: string): Promise<StoredSessionRecord> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    let db: DatabaseSync | undefined;
    try {
      db = await this.database();
      return this.readRecord(db, id);
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
    }
  }

  async readCheckpoint(
    id: string,
  ): Promise<SemanticContextCheckpointV1 | undefined> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    let db: DatabaseSync | undefined;
    try {
      db = await this.database();
      return this.readCheckpointFromDb(db, id);
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
    }
  }

  async listWorker(): Promise<WorkerSessionListResult> {
    let db: DatabaseSync | undefined;
    try {
      db = await this.database();
      const rows = db.prepare(
        'SELECT session_id FROM sessions ORDER BY updated_at DESC, session_id ASC',
      ).all() as SqlRow[];
      const sessions: WorkerSessionListResult['sessions'][number][] = [];
      let skippedInvalid = 0;
      for (const row of rows) {
        try {
          sessions.push(
            metadataFromStoredRecord(
              this.readRecord(db!, String(row.session_id)),
            ),
          );
        } catch (error) {
          // A single unreadable record (for example one written by an older build whose
          // embedded manifest no longer validates) must not hide every valid session.
          if (
            error instanceof SessionStoreError &&
            error.code === 'session_invalid'
          ) {
            skippedInvalid += 1;
            continue;
          }
          throw error;
        }
      }
      return { sessions, skippedInvalid };
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
    }
  }

  async allocateWorker(
    agent: SessionRecord['agent'],
    definition: DefinitionRevisionRef,
  ): Promise<WorkerSessionHandle> {
    if (
      (agent !== 'default' && agent !== 'planner') ||
      !validRevisionRef(definition)
    ) {
      throw new SessionStoreError('session_invalid');
    }
    const layout = await this.layout();
    const index = await acquireLock(`${layout.locks}/.index.lock`);
    let db: DatabaseSync | undefined;
    try {
      db = await this.database();
      const known = new Set(
        (db.prepare('SELECT session_id FROM sessions').all() as SqlRow[]).map((
          row,
        ) => String(row.session_id)),
      );
      const active = new Set<string>();
      for await (const entry of Deno.readDir(layout.locks)) {
        if (!entry.isFile || !entry.name.endsWith('.lock')) continue;
        const id = entry.name.slice(0, -5);
        if (!isSessionId(id)) continue;
        try {
          const probe = await acquireLock(`${layout.locks}/${entry.name}`);
          probe.close();
        } catch (error) {
          if (
            error instanceof SessionStoreError && error.code === 'session_busy'
          ) {
            active.add(id);
          } else throw error;
        }
      }
      if (
        new Set([...known, ...active]).size >= MAX_VALID_SESSIONS_PER_WORKSPACE
      ) {
        throw new SessionStoreError('session_limit');
      }
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const id = this.makeUuid().toLowerCase();
        if (!isSessionId(id)) continue;
        if (known.has(id) || active.has(id)) continue;
        try {
          const lock = await acquireLock(`${layout.locks}/${id}.lock`);
          return this.handle(id, agent, undefined, undefined, lock);
        } catch (error) {
          if (
            !(error instanceof SessionStoreError) ||
            error.code !== 'session_busy'
          ) throw error;
        }
      }
      throw new SessionStoreError('session_limit');
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
      index.close();
    }
  }

  async openExistingWorker(id: string): Promise<WorkerSessionHandle> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const layout = await this.layout();
    const index = await acquireLock(`${layout.locks}/.index.lock`);
    let lock: Lock | undefined;
    let db: DatabaseSync | undefined;
    try {
      lock = await acquireLock(`${layout.locks}/${id}.lock`);
      db = await this.database();
      const active = this.activeExecutionForSession(db, id);
      if (active !== undefined) {
        db.close();
        db = undefined;
        this.reconcileExecution({
          executionId: String(active.row.execution_id),
          settlement: active.settlement,
        });
        db = await this.database();
      }
      const record = this.readRecord(db, id);
      const checkpoint = this.readCheckpointFromDb(db, id);
      return this.handle(id, record.agent, record, checkpoint, lock);
    } catch (error) {
      lock?.close();
      throw sessionError(error);
    } finally {
      db?.close();
      index.close();
    }
  }

  async delete(id: string): Promise<void> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const layout = await this.layout();
    const index = await acquireLock(`${layout.locks}/.index.lock`);
    let lock: Lock | undefined;
    let db: DatabaseSync | undefined;
    try {
      lock = await acquireLock(`${layout.locks}/${id}.lock`);
      db = await this.database();
      this.transaction(db, () => {
        const result = db!.prepare('DELETE FROM sessions WHERE session_id = ?')
          .run(id);
        if (Number(result.changes) !== 1) {
          throw new SessionStoreError('session_not_found');
        }
      });
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
      lock?.close();
      index.close();
    }
  }

  private handle(
    id: string,
    agent: SessionRecord['agent'],
    initial: StoredSessionRecord | undefined,
    initialCheckpoint: SemanticContextCheckpointV1 | undefined,
    lock: Lock,
  ): WorkerSessionHandle {
    let record = initial;
    let rollbackRecord = initial;
    let checkpoint = initialCheckpoint;
    let rollbackCheckpoint = initialCheckpoint;
    let closed = false;
    return {
      id,
      get record() {
        return record === undefined ? undefined : structuredClone(record);
      },
      get checkpoint() {
        return checkpoint === undefined ? undefined : structuredClone(checkpoint);
      },
      commit: (next) => {
        if (closed) throw new SessionStoreError('session_busy');
        if (
          next.sessionId !== id || next.workspaceRoot !== this.workspaceRoot ||
          next.agent !== agent
        ) throw new SessionStoreError('session_invalid');
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.databasePathSync());
          this.configureExisting(db);
          rollbackRecord = record;
          this.transaction(db, () => this.writeRecord(db!, next));
          record = structuredClone(next);
        } catch (error) {
          throw sessionError(error);
        } finally {
          db?.close();
        }
      },
      acceptCommitted: (next) => {
        if (
          closed || next.sessionId !== id ||
          next.workspaceRoot !== this.workspaceRoot ||
          next.agent !== agent || !validateSessionRecordV6(next)
        ) {
          throw new SessionStoreError(
            closed ? 'session_busy' : 'session_invalid',
          );
        }
        rollbackRecord = record;
        record = structuredClone(next);
      },
      rollback: () => {
        if (closed || record === rollbackRecord) return;
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.databasePathSync());
          this.configureExisting(db);
          this.transaction(db, () => {
            if (rollbackRecord === undefined) {
              db!.prepare('DELETE FROM sessions WHERE session_id = ?').run(id);
            } else this.writeRecord(db!, rollbackRecord);
          });
          record = rollbackRecord;
        } catch (error) {
          throw sessionError(error);
        } finally {
          db?.close();
        }
      },
      installCheckpoint: (next) => {
        if (closed) throw new SessionStoreError('session_busy');
        if (next.sessionId !== id || !validateSemanticContextCheckpoint(next)) {
          throw new SessionStoreError('session_invalid');
        }
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.databasePathSync());
          this.configureExisting(db);
          rollbackCheckpoint = checkpoint;
          this.transaction(db, () => {
            db!.prepare(`
              INSERT INTO semantic_checkpoints(
                session_id, created_at, covered_turn, retained_turn, source_profile_id, summary
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                created_at=excluded.created_at, covered_turn=excluded.covered_turn,
                retained_turn=excluded.retained_turn, source_profile_id=excluded.source_profile_id,
                summary=excluded.summary
            `).run(
              id,
              next.createdAt,
              next.coveredThroughTurn,
              next.retainedFromTurn,
              next.sourceProfileId,
              next.summary,
            );
          });
          checkpoint = structuredClone(next);
        } catch (error) {
          throw sessionError(error);
        } finally {
          db?.close();
        }
      },
      rollbackCheckpoint: () => {
        if (closed || checkpoint === rollbackCheckpoint) return;
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.databasePathSync());
          this.configureExisting(db);
          this.transaction(db, () => {
            if (rollbackCheckpoint === undefined) {
              db!.prepare(
                'DELETE FROM semantic_checkpoints WHERE session_id = ?',
              ).run(id);
            } else {
              const previous = rollbackCheckpoint;
              db!.prepare(`
                INSERT INTO semantic_checkpoints(
                  session_id, created_at, covered_turn, retained_turn, source_profile_id, summary
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                  created_at=excluded.created_at, covered_turn=excluded.covered_turn,
                  retained_turn=excluded.retained_turn, source_profile_id=excluded.source_profile_id,
                  summary=excluded.summary
              `).run(
                id,
                previous.createdAt,
                previous.coveredThroughTurn,
                previous.retainedFromTurn,
                previous.sourceProfileId,
                previous.summary,
              );
            }
          });
          checkpoint = rollbackCheckpoint;
        } catch (error) {
          throw sessionError(error);
        } finally {
          db?.close();
        }
      },
      close: () => {
        if (closed) return Promise.resolve();
        closed = true;
        lock.close();
        return Promise.resolve();
      },
    };
  }

  private databasePathSync(): string {
    // Every handle/history port is initialized before synchronous transaction use.
    if (this.databaseFile !== undefined) return this.databaseFile;
    throw new HistoryStoreError('history_io_failure');
  }

  async initialize(): Promise<void> {
    const db = await this.database();
    db.close();
    await this.reconcileDetachedExecutions();
  }

  private configureExisting(db: DatabaseSync): void {
    db.exec(
      `PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
    );
  }

  private releaseExecutionLock(executionId: string): void {
    const lock = this.executionLocks.get(executionId);
    if (lock === undefined) return;
    this.executionLocks.delete(executionId);
    lock.close();
  }

  private progressFact(payload: JsonValue):
    | {
      readonly streamKey: string;
      readonly text: string;
      readonly stored: JsonValue;
    }
    | undefined {
    if (!validJsonObject(payload)) return undefined;
    const stored = structuredClone(payload) as Record<string, unknown>;
    if (
      stored.kind === 'runtime_event' && validJsonObject(stored.event) &&
      stored.event.kind === 'agent_event' &&
      validJsonObject(stored.event.event) &&
      (stored.event.event.kind === 'assistant_progress' ||
        stored.event.event.kind === 'tool_progress') &&
      typeof stored.event.event.text === 'string'
    ) {
      const event = stored.event.event as Record<string, unknown>;
      const text = String(event.text);
      const streamKey = event.kind === 'assistant_progress'
        ? `surface:assistant:${String(event.turn)}`
        : `surface:tool:${String(event.turn)}:${String(event.callId)}`;
      event.text = '';
      return { streamKey, text, stored: stored as JsonValue };
    }
    if (
      stored.kind === 'provider_observation' &&
      validJsonObject(stored.observation) &&
      stored.observation.kind === 'runtime_event' &&
      validJsonObject(stored.observation.event) &&
      (stored.observation.event.kind === 'assistant_progress' ||
        stored.observation.event.kind === 'tool_progress') &&
      typeof stored.observation.event.text === 'string'
    ) {
      const event = stored.observation.event as Record<string, unknown>;
      const text = String(event.text);
      const streamKey = event.kind === 'assistant_progress'
        ? `provider:assistant:${String(event.lane ?? 'parent')}:` +
          `${String(event.modelStep)}:${String(event.requestOrdinal ?? 'none')}`
        : `provider:tool:${String(event.lane ?? 'parent')}:` +
          `${String(event.modelStep)}:${String(event.requestOrdinal ?? 'none')}:` +
          `${String(event.callId)}`;
      event.text = '';
      return { streamKey, text, stored: stored as JsonValue };
    }
    return undefined;
  }

  private durableEventPayload(
    input: ExecutionEventInput,
    payload: JsonValue,
  ): JsonValue {
    if (!validJsonObject(payload)) return payload;
    if (payload.kind === 'commit_proposal') {
      return {
        kind: 'commit_proposal',
        correlation: structuredClone(payload.correlation) as JsonValue,
        nextTurn: Number(payload.nextTurn),
      };
    }
    if (payload.kind === 'turn_failed') {
      return {
        kind: 'turn_failed',
        correlation: structuredClone(payload.correlation) as JsonValue,
      };
    }
    if (
      input.kind === 'execution_admitted' ||
      input.kind === 'turn_dispatch_requested' ||
      input.kind === 'turn_dispatch_sent'
    ) {
      const { task: _task, ...marker } = payload;
      return marker;
    }
    return payload;
  }

  private normalizedFactMarker(payload: JsonValue): JsonValue | undefined {
    if (!validJsonObject(payload)) return undefined;
    if (
      payload.kind === 'provider_observation' &&
      validJsonObject(payload.observation)
    ) {
      const { observation: _observation, ...marker } = payload;
      return marker;
    }
    if (
      payload.kind === 'effect_observation' && validJsonObject(payload.effect)
    ) {
      const { effect: _effect, ...marker } = payload;
      return marker;
    }
    if (
      payload.kind === 'runtime_event' && validJsonObject(payload.event) &&
      payload.event.kind === 'agent_event'
    ) {
      const { event: _event, ...marker } = payload;
      return marker;
    }
    if (
      payload.kind === 'context_observation' &&
      validJsonObject(payload.observation)
    ) {
      const { observation: _observation, ...marker } = payload;
      return marker;
    }
    return undefined;
  }

  private writeNormalizedObservationFactTx(
    db: DatabaseSync,
    executionId: string,
    ordinal: number,
    payload: JsonValue,
  ): void {
    if (!validJsonObject(payload)) return;
    if (
      payload.kind === 'provider_observation' &&
      validJsonObject(payload.observation)
    ) {
      const observation = payload.observation;
      if (
        observation.kind === 'runtime_event' &&
        validJsonObject(observation.event)
      ) {
        db.prepare(`
          INSERT INTO runtime_occurrences(
            execution_id, observation_ordinal, envelope_kind,
            request_ordinal, event_json
          ) VALUES (?, ?, 'provider_observation', ?, ?)
        `).run(
          executionId,
          ordinal,
          typeof observation.requestOrdinal === 'number' ? observation.requestOrdinal : null,
          JSON.stringify(observation.event),
        );
        return;
      }
      if (observation.kind === 'response_bytes') {
        db.prepare(`
          INSERT INTO provider_observation_facts(
            execution_id, observation_ordinal, observation_kind,
            request_ordinal, byte_offset, observation_json, raw_bytes
          ) VALUES (?, ?, 'response_bytes', ?, ?, NULL, ?)
        `).run(
          executionId,
          ordinal,
          Number(observation.requestOrdinal),
          Number(observation.offset),
          Uint8Array.fromBase64(String(observation.bytesBase64)),
        );
        return;
      }
      db.prepare(`
        INSERT INTO provider_observation_facts(
          execution_id, observation_ordinal, observation_kind,
          request_ordinal, byte_offset, observation_json, raw_bytes
        ) VALUES (?, ?, ?, ?, NULL, ?, NULL)
      `).run(
        executionId,
        ordinal,
        String(observation.kind),
        observation.kind === 'request_start'
          ? Number((observation.request as Record<string, unknown>).ordinal)
          : Number(observation.requestOrdinal),
        JSON.stringify(observation),
      );
      return;
    }
    if (
      payload.kind === 'effect_observation' && validJsonObject(payload.effect)
    ) {
      db.prepare(`
        INSERT INTO runtime_occurrences(
          execution_id, observation_ordinal, envelope_kind,
          request_ordinal, event_json
        ) VALUES (?, ?, 'effect_observation', NULL, ?)
      `).run(executionId, ordinal, JSON.stringify(payload.effect));
      return;
    }
    if (
      payload.kind === 'runtime_event' && validJsonObject(payload.event) &&
      payload.event.kind === 'agent_event'
    ) {
      db.prepare(`
        INSERT INTO runtime_occurrences(
          execution_id, observation_ordinal, envelope_kind,
          request_ordinal, event_json
        ) VALUES (?, ?, 'runtime_event', NULL, ?)
      `).run(executionId, ordinal, JSON.stringify(payload.event));
    }
  }

  private nextContextRelationOrdinalTx(
    db: DatabaseSync,
    executionId: string,
  ): number {
    const row = db.prepare(`
      UPDATE execution_context_counters
      SET next_relation_ordinal = next_relation_ordinal + 1
      WHERE execution_id = ?
      RETURNING next_relation_ordinal - 1 AS ordinal
    `).get(executionId) as SqlRow | undefined;
    if (row === undefined) throw new HistoryStoreError('history_invalid');
    return Number(row.ordinal);
  }

  private materializeToolContextFactTx(
    db: DatabaseSync,
    executionId: string,
    eventOrdinal: number,
    payload: JsonValue,
  ): void {
    if (!validJsonObject(payload)) return;
    let event: Record<string, unknown> | undefined;
    let lane: 'parent' | 'planner' = 'parent';
    let modelStep: number | undefined;
    let requestOrdinal: number | undefined;
    const rawProviderObservation: unknown = payload.kind === 'provider_observation'
      ? payload.observation
      : undefined;
    if (validateProviderEvidenceObservation(rawProviderObservation)) {
      const observation = rawProviderObservation;
      if (observation.kind === 'request_start') {
        if (observation.request.contextRequestOrdinal !== undefined) {
          db.prepare(`
            INSERT INTO provider_request_contexts(
              execution_id, provider_request_ordinal, context_request_ordinal
            ) VALUES (?, ?, ?)
          `).run(
            executionId,
            observation.request.ordinal,
            observation.request.contextRequestOrdinal,
          );
        }
        return;
      }
      if (observation.kind !== 'runtime_event') return;
      event = observation.event as unknown as Record<string, unknown>;
      lane = 'lane' in observation.event && observation.event.lane === 'planner'
        ? 'planner'
        : 'parent';
      modelStep = 'modelStep' in observation.event ? observation.event.modelStep : undefined;
      const physical = 'requestOrdinal' in observation.event
        ? observation.event.requestOrdinal
        : undefined;
      if (physical !== undefined) {
        const context = db.prepare(`
          SELECT context_request_ordinal FROM provider_request_contexts
          WHERE execution_id = ? AND provider_request_ordinal = ?
        `).get(executionId, physical) as SqlRow | undefined;
        requestOrdinal = context === undefined
          ? undefined
          : Number(context.context_request_ordinal);
      }
    } else if (
      payload.kind === 'effect_observation' && validJsonObject(payload.effect)
    ) {
      event = payload.effect;
    } else if (
      payload.kind === 'runtime_event' && validJsonObject(payload.event) &&
      payload.event.kind === 'agent_event' &&
      validJsonObject(payload.event.event)
    ) {
      event = payload.event.event;
    }
    if (event === undefined) return;
    if (requestOrdinal === undefined && modelStep !== undefined) {
      const logicalRequests = db.prepare(`
        SELECT request_ordinal FROM model_requests
        WHERE execution_id = ? AND lane = ? AND model_step = ?
        ORDER BY request_ordinal
      `).all(executionId, lane, modelStep) as SqlRow[];
      if (logicalRequests.length === 1) {
        requestOrdinal = Number(logicalRequests[0].request_ordinal);
      }
    }
    const storeCall = (call: Record<string, unknown>): void => {
      if (
        typeof call.callId !== 'string' || typeof call.name !== 'string' ||
        !isJsonValue(call.arguments)
      ) return;
      db.prepare(`
        INSERT INTO context_tool_calls(
          execution_id, lane, call_id, name, arguments_json,
          model_step, request_ordinal, source_event_ordinal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(execution_id, lane, call_id) DO UPDATE SET
          name=excluded.name, arguments_json=excluded.arguments_json,
          model_step=coalesce(context_tool_calls.model_step, excluded.model_step),
          request_ordinal=coalesce(context_tool_calls.request_ordinal, excluded.request_ordinal),
          source_event_ordinal=min(context_tool_calls.source_event_ordinal,
            excluded.source_event_ordinal)
      `).run(
        executionId,
        lane,
        call.callId,
        call.name,
        JSON.stringify(call.arguments),
        modelStep ?? null,
        requestOrdinal ?? null,
        eventOrdinal,
      );
    };
    if (
      event.kind === 'model_result' && validJsonObject(event.result) &&
      event.result.kind === 'tool_calls' && Array.isArray(event.result.calls)
    ) {
      for (const call of event.result.calls) {
        if (validJsonObject(call)) storeCall(call);
      }
      return;
    }
    if (event.kind === 'tool_call' && validJsonObject(event.call)) {
      storeCall(event.call);
      return;
    }
    if (event.kind !== 'tool_result' || !validJsonObject(event.result)) return;
    const result = event.result;
    if (
      typeof result.callId !== 'string' || typeof result.name !== 'string' ||
      typeof result.text !== 'string'
    ) return;
    const call = db.prepare(`
      SELECT name, arguments_json, model_step, request_ordinal
      FROM context_tool_calls
      WHERE execution_id = ? AND lane = ? AND call_id = ?
    `).get(executionId, lane, result.callId) as SqlRow | undefined;
    const factModelStep =
      (call?.model_step === null || call?.model_step === undefined
        ? undefined
        : Number(call.model_step)) ?? modelStep;
    const factRequestOrdinal =
      (call?.request_ordinal === null || call?.request_ordinal === undefined
        ? undefined
        : Number(call.request_ordinal)) ?? requestOrdinal;
    const execution = db.prepare(`
      SELECT session_correlation, turn FROM executions WHERE execution_id = ?
    `).get(executionId) as SqlRow | undefined;
    if (execution === undefined) throw new HistoryStoreError('history_invalid');
    const bytes = encoder.encode(result.text);
    const digest = contextDigestSync(bytes);
    this.insertContextBlobTx(db, {
      digest,
      byteLength: bytes.byteLength,
      mediaType: 'text/plain; charset=utf-8',
      bytes,
    });
    const existingObserved = db.prepare(`
      SELECT 1 FROM execution_context_relations
      WHERE execution_id = ? AND stage = 'observed' AND resource_kind = 'tool_result'
        AND lane = ? AND call_id = ?
    `).get(executionId, lane, result.callId);
    if (existingObserved === undefined) {
      this.insertContextRelationTx(db, executionId, {
        ordinal: this.nextContextRelationOrdinalTx(db, executionId),
        stage: 'observed',
        resourceKind: 'tool_result',
        logicalIdentity: `tool-result:${String(execution.session_correlation)}:turn:${
          Number(execution.turn)
        }:call:${result.callId}`,
        contentDigest: digest,
        lane,
        ...(factModelStep === undefined ? {} : { modelStep: factModelStep }),
        ...(factRequestOrdinal === undefined ? {} : { requestOrdinal: factRequestOrdinal }),
        callId: result.callId,
        sourceEventOrdinal: eventOrdinal,
      });
    }
    if (call?.name !== 'skill' || result.outcome !== 'success') return;
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(String(call.arguments_json));
    } catch {
      return;
    }
    const skillName = validJsonObject(argumentsValue) &&
        Object.keys(argumentsValue).length === 1 &&
        typeof argumentsValue.name === 'string'
      ? argumentsValue.name
      : undefined;
    if (skillName === undefined) return;
    const candidates = db.prepare(`
      SELECT r.source_locator, b.raw_bytes
      FROM execution_context_relations r JOIN context_blobs b ON b.digest = r.content_digest
      WHERE r.execution_id = ? AND r.stage = 'discovered' AND r.resource_kind = 'skill'
        AND r.logical_identity = ?
    `).all(executionId, skillName) as SqlRow[];
    const matching = candidates.filter((candidate) => {
      try {
        const raw = candidate.raw_bytes instanceof Uint8Array
          ? candidate.raw_bytes
          : new Uint8Array(candidate.raw_bytes as ArrayBuffer);
        const skill = JSON.parse(decoder.decode(raw));
        return validJsonObject(skill) && skill.toolResult === result.text;
      } catch {
        return false;
      }
    });
    if (matching.length !== 1) return;
    const existingLoaded = db.prepare(`
      SELECT 1 FROM execution_context_relations
      WHERE execution_id = ? AND stage = 'loaded' AND resource_kind = 'skill'
        AND lane = ? AND call_id = ?
    `).get(executionId, lane, result.callId);
    if (existingLoaded === undefined) {
      this.insertContextRelationTx(db, executionId, {
        ordinal: this.nextContextRelationOrdinalTx(db, executionId),
        stage: 'loaded',
        resourceKind: 'skill',
        logicalIdentity: `skill:${skillName}`,
        sourceLocator: String(matching[0].source_locator),
        contentDigest: digest,
        lane,
        ...(factModelStep === undefined ? {} : { modelStep: factModelStep }),
        ...(factRequestOrdinal === undefined ? {} : { requestOrdinal: factRequestOrdinal }),
        callId: result.callId,
        sourceEventOrdinal: eventOrdinal,
      });
    }
  }

  private progressSnapshotTx(
    db: DatabaseSync,
    executionId: string,
    streamKey: string,
    throughOrdinal?: number,
  ): string {
    const rows = db.prepare(`
      SELECT mode, text_fragment FROM execution_progress_deltas
      WHERE execution_id = ? AND stream_key = ?
        AND (? IS NULL OR event_ordinal <= ?)
      ORDER BY event_ordinal
    `).all(
      executionId,
      streamKey,
      throughOrdinal ?? null,
      throughOrdinal ?? null,
    ) as SqlRow[];
    let snapshot = '';
    for (const row of rows) {
      if (row.mode === 'replace') snapshot = String(row.text_fragment);
      else if (row.mode === 'append') snapshot += String(row.text_fragment);
      else throw new HistoryStoreError('history_invalid');
    }
    return snapshot;
  }

  private eventPayloadTx(db: DatabaseSync, row: SqlRow): JsonValue {
    let payload: JsonValue;
    try {
      payload = JSON.parse(String(row.payload_json)) as JsonValue;
    } catch {
      throw new HistoryStoreError('history_invalid');
    }
    if (!isJsonValue(payload)) throw new HistoryStoreError('history_invalid');
    const marker = validJsonObject(payload) ? payload as Record<string, unknown> : undefined;
    const runtime = db.prepare(`
      SELECT envelope_kind, request_ordinal, event_json FROM runtime_occurrences
      WHERE execution_id = ? AND observation_ordinal = ?
    `).get(String(row.execution_id), Number(row.ordinal)) as SqlRow | undefined;
    if (runtime !== undefined) {
      if (marker === undefined) throw new HistoryStoreError('history_invalid');
      let event: JsonValue;
      try {
        event = JSON.parse(String(runtime.event_json)) as JsonValue;
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
      if (!isJsonValue(event) || !validJsonObject(event)) {
        throw new HistoryStoreError('history_invalid');
      }
      const delta = db.prepare(`
        SELECT stream_key FROM execution_progress_deltas
        WHERE execution_id = ? AND event_ordinal = ?
      `).get(String(row.execution_id), Number(row.ordinal)) as
        | SqlRow
        | undefined;
      if (delta !== undefined) {
        const text = this.progressSnapshotTx(
          db,
          String(row.execution_id),
          String(delta.stream_key),
          Number(row.ordinal),
        );
        if (
          event.kind === 'agent_event' && validJsonObject(event.event)
        ) (event.event as Record<string, unknown>).text = text;
        else (event as Record<string, unknown>).text = text;
      }
      if (runtime.envelope_kind === 'effect_observation') {
        return { ...marker, effect: event } as JsonValue;
      }
      if (runtime.envelope_kind === 'runtime_event') {
        return { ...marker, event } as JsonValue;
      }
      if (runtime.envelope_kind === 'provider_observation') {
        return {
          ...marker,
          observation: {
            kind: 'runtime_event',
            ...(runtime.request_ordinal === null
              ? {}
              : { requestOrdinal: Number(runtime.request_ordinal) }),
            event,
          },
        } as JsonValue;
      }
      throw new HistoryStoreError('history_invalid');
    }
    const provider = db.prepare(`
      SELECT observation_kind, request_ordinal, byte_offset,
        observation_json, raw_bytes
      FROM provider_observation_facts
      WHERE execution_id = ? AND observation_ordinal = ?
    `).get(String(row.execution_id), Number(row.ordinal)) as SqlRow | undefined;
    if (provider !== undefined) {
      if (marker === undefined) throw new HistoryStoreError('history_invalid');
      let observation: JsonValue;
      if (provider.observation_kind === 'response_bytes') {
        const bytes = provider.raw_bytes instanceof Uint8Array
          ? provider.raw_bytes
          : new Uint8Array(provider.raw_bytes as ArrayBuffer);
        observation = {
          kind: 'response_bytes',
          requestOrdinal: Number(provider.request_ordinal),
          offset: Number(provider.byte_offset),
          bytesBase64: uint8ToBase64(bytes),
        };
      } else {
        try {
          observation = JSON.parse(
            String(provider.observation_json),
          ) as JsonValue;
        } catch {
          throw new HistoryStoreError('history_invalid');
        }
      }
      if (!isJsonValue(observation)) {
        throw new HistoryStoreError('history_invalid');
      }
      return { ...marker, observation } as JsonValue;
    }
    if (
      marker?.kind === 'context_observation' &&
      marker.observation === undefined
    ) {
      const contextRow = db.prepare(`
        SELECT request_ordinal FROM model_requests
        WHERE execution_id = ? AND observation_ordinal = ?
      `).get(String(row.execution_id), Number(row.ordinal)) as
        | SqlRow
        | undefined;
      if (contextRow === undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      const request = this.readExecutionRequestV5Tx(
        db,
        String(row.execution_id),
        Number(contextRow.request_ordinal),
      );
      return {
        ...marker,
        observation: { kind: 'model_request', request },
      } as unknown as JsonValue;
    }
    const delta = db.prepare(`
      SELECT stream_key FROM execution_progress_deltas
      WHERE execution_id = ? AND event_ordinal = ?
    `).get(String(row.execution_id), Number(row.ordinal)) as SqlRow | undefined;
    if (delta === undefined) return payload;
    const text = this.progressSnapshotTx(
      db,
      String(row.execution_id),
      String(delta.stream_key),
      Number(row.ordinal),
    );
    const hydrated = structuredClone(payload) as Record<string, unknown>;
    if (
      hydrated.kind === 'runtime_event' && validJsonObject(hydrated.event) &&
      hydrated.event.kind === 'agent_event' &&
      validJsonObject(hydrated.event.event)
    ) {
      (hydrated.event.event as Record<string, unknown>).text = text;
    } else if (
      hydrated.kind === 'provider_observation' &&
      validJsonObject(hydrated.observation) &&
      hydrated.observation.kind === 'runtime_event' &&
      validJsonObject(hydrated.observation.event)
    ) {
      (hydrated.observation.event as Record<string, unknown>).text = text;
    } else throw new HistoryStoreError('history_invalid');
    return hydrated as JsonValue;
  }

  private validateExecutionInput(input: HistoryExecutionInput): void {
    if (
      !UUID_V4.test(input.taskId) || !UUID_V4.test(input.executionId) ||
      (input.agent !== 'default' && input.agent !== 'planner') ||
      !isModelSelection(input.model) || !isBuildManifest(input.build) ||
      !validRevisionRef(input.definition) || typeof input.task !== 'string' ||
      input.task.length === 0 || typeof input.sessionCorrelation !== 'string' ||
      input.sessionCorrelation.length === 0 ||
      !Number.isSafeInteger(input.turn) || input.turn < 1 ||
      !Number.isSafeInteger(input.baseStateRevision) ||
      input.baseStateRevision < 1 ||
      input.contextSnapshot !== undefined &&
        !validateWorkerContextSnapshot(input.contextSnapshot)
    ) throw new HistoryStoreError('history_invalid');
  }

  private appendExecutionEventTx(
    db: DatabaseSync,
    input: ExecutionEventInput,
  ): StoredExecutionEvent {
    this.validateExecutionEventInput(input);
    const execution = db.prepare(
      'SELECT lifecycle FROM executions WHERE execution_id = ?',
    ).get(input.executionId) as SqlRow | undefined;
    if (
      execution === undefined ||
      execution.lifecycle !== 'active' && execution.lifecycle !== 'settled'
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    const previous = db.prepare(
      'SELECT coalesce(max(ordinal), 0) AS ordinal FROM execution_observations WHERE execution_id = ?',
    ).get(input.executionId) as SqlRow;
    const ordinal = Number(previous.ordinal) + 1;
    if (input.workerSequence !== undefined) {
      const worker = db.prepare(
        'SELECT max(worker_sequence) AS sequence FROM execution_observations WHERE execution_id = ? AND worker_sequence IS NOT NULL',
      ).get(input.executionId) as SqlRow;
      if (
        worker.sequence !== null &&
        input.workerSequence <= Number(worker.sequence)
      ) {
        throw new HistoryStoreError('history_invalid');
      }
    }
    const observedAt = input.observedAt ?? new Date().toISOString();
    if (
      !ISO_TIMESTAMP.test(observedAt) ||
      Number.isNaN(new Date(observedAt).valueOf()) ||
      new Date(observedAt).toISOString() !== observedAt
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    const payload = jsonPayload(input.payload);
    const progress = this.progressFact(payload);
    const factPayload = progress?.stored ?? payload;
    const durablePayload = this.normalizedFactMarker(factPayload) ??
      this.durableEventPayload(input, factPayload);
    const payloadJson = JSON.stringify(durablePayload);
    db.prepare(`
      INSERT INTO execution_observations(
        execution_id, ordinal, observed_at, direction, source, kind, worker_sequence, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.executionId,
      ordinal,
      observedAt,
      input.direction,
      input.source,
      input.kind,
      input.workerSequence ?? null,
      payloadJson,
    );
    this.writeNormalizedObservationFactTx(
      db,
      input.executionId,
      ordinal,
      factPayload,
    );
    this.materializeToolContextFactTx(
      db,
      input.executionId,
      ordinal,
      factPayload,
    );
    if (input.kind === 'context_observation') {
      if (
        !validJsonObject(factPayload) ||
        !validJsonObject(factPayload.observation) ||
        factPayload.observation.kind !== 'model_request_delta' ||
        !validateContextModelRequestDelta(factPayload.observation.delta)
      ) throw new HistoryStoreError('history_invalid');
      this.writeContextDeltaTx(
        db,
        input.executionId,
        ordinal,
        factPayload.observation.delta,
      );
    }
    const payloadRecord = validJsonObject(payload) ? payload as Record<string, unknown> : undefined;
    if (
      payloadRecord?.kind === 'commit_proposal' &&
      Array.isArray(payloadRecord.transcript)
    ) {
      this.writeExecutionMessagesTx(
        db,
        input.executionId,
        payloadRecord.transcript as Message[],
      );
    } else if (
      payloadRecord?.kind === 'turn_failed' &&
      validLoopOutcome(payloadRecord.outcome)
    ) {
      this.writeExecutionMessagesTx(
        db,
        input.executionId,
        (payloadRecord.outcome as LoopOutcome).transcript,
      );
    }
    if (progress !== undefined) {
      const previousSnapshot = this.progressSnapshotTx(
        db,
        input.executionId,
        progress.streamKey,
      );
      const mode = progress.text.startsWith(previousSnapshot) ? 'append' : 'replace';
      const fragment = mode === 'append'
        ? progress.text.slice(previousSnapshot.length)
        : progress.text;
      db.prepare(`
        INSERT INTO execution_progress_deltas(
          execution_id, event_ordinal, stream_key, mode, text_fragment
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.executionId,
        ordinal,
        progress.streamKey,
        mode,
        fragment,
      );
    }
    this.updateEffectProjectionTx(db, {
      ...input,
      observedAt,
    }, ordinal);
    return {
      executionId: input.executionId,
      ordinal,
      observedAt,
      direction: input.direction,
      source: input.source,
      kind: input.kind,
      ...(input.workerSequence === undefined ? {} : { workerSequence: input.workerSequence }),
      payload,
    };
  }

  private validateExecutionEventInput(input: ExecutionEventInput): void {
    if (
      !UUID_V4.test(input.executionId) ||
      (input.direction !== 'host_to_worker' &&
        input.direction !== 'worker_to_host') ||
      (input.source !== 'host' && input.source !== 'worker') ||
      !EXECUTION_EVENT_KINDS.has(input.kind) ||
      (input.source === 'host' && input.direction !== 'host_to_worker') ||
      (input.source === 'worker' && input.direction !== 'worker_to_host') ||
      (input.source === 'host' && input.workerSequence !== undefined) ||
      (input.source === 'host' &&
        !HOST_EXECUTION_EVENT_KINDS.has(input.kind)) ||
      (input.source === 'worker' &&
        HOST_EXECUTION_EVENT_KINDS.has(input.kind)) ||
      (input.workerSequence !== undefined &&
        (!Number.isSafeInteger(input.workerSequence) ||
          input.workerSequence < 1))
    ) throw new HistoryStoreError('history_invalid');
    const payload = jsonPayload(input.payload);
    if (!validJsonObject(payload)) {
      throw new HistoryStoreError('history_invalid');
    }
    if (input.source === 'host') {
      const record = payload;
      const validHostPayload = input.kind === 'execution_admitted'
        ? exactObject(record, [
          'taskId',
          'executionId',
          'sessionCorrelation',
          'turn',
          'task',
        ]) &&
          UUID_V4.test(record.taskId as string) &&
          UUID_V4.test(record.executionId as string) &&
          record.executionId === input.executionId &&
          validText(record.sessionCorrelation) &&
          validPositiveInteger(record.turn) && validText(record.task)
        : input.kind === 'turn_dispatch_requested' ||
            input.kind === 'turn_dispatch_failed'
        ? exactObject(record, ['task']) && validText(record.task)
        : input.kind === 'turn_dispatch_sent'
        ? exactObject(record, ['task'], ['kind']) && validText(record.task) &&
          (record.kind === undefined || record.kind === 'turn')
        : input.kind === 'cancel_requested' || input.kind === 'cancel_sent' ||
            input.kind === 'cancel_failed'
        ? exactObject(record, ['command']) && record.command === 'cancel'
        : input.kind === 'cancel_escalated'
        ? exactObject(record, ['command', 'reason']) &&
          record.command === 'terminate' &&
          record.reason === 'settlement_deadline_exceeded'
        : input.kind === 'worker_stage_snapshot'
        ? exactObject(record, [
          'schemaVersion',
          'trigger',
          'workerGeneration',
          'epoch',
          'stageOrdinal',
          'stage',
          'expectedWorkerSequence',
          'lastWorkerSequenceReceived',
          'lastWorkerSequenceBuffered',
          'lastWorkerSequenceDurable',
        ], ['contextRequestOrdinal']) && record.schemaVersion === 1 &&
          ['auxiliary_gap', 'cancel_requested', 'cancel_escalated', 'terminal']
            .includes(String(record.trigger)) &&
          UUID_V4.test(String(record.workerGeneration)) &&
          validPositiveInteger(record.epoch) &&
          Number.isSafeInteger(record.stageOrdinal) &&
          Number(record.stageOrdinal) >= 0 &&
          typeof record.stage === 'string' &&
          record.stage in WORKER_STAGE_CODES &&
          Number.isSafeInteger(record.expectedWorkerSequence) &&
          Number(record.expectedWorkerSequence) >= 0 &&
          Number.isSafeInteger(record.lastWorkerSequenceReceived) &&
          Number(record.lastWorkerSequenceReceived) >= 0 &&
          Number.isSafeInteger(record.lastWorkerSequenceBuffered) &&
          Number(record.lastWorkerSequenceBuffered) >= 0 &&
          Number.isSafeInteger(record.lastWorkerSequenceDurable) &&
          Number(record.lastWorkerSequenceDurable) >= 0 &&
          (record.contextRequestOrdinal === undefined ||
            validPositiveInteger(record.contextRequestOrdinal))
        : input.kind === 'steer_requested' || input.kind === 'steer_sent' ||
            input.kind === 'steer_failed'
        ? exactObject(record, ['text']) && typeof record.text === 'string'
        : input.kind === 'acknowledgement_requested' ||
            input.kind === 'acknowledgement_sent' ||
            input.kind === 'acknowledgement_failed'
        ? exactObject(record, ['accepted']) &&
          typeof record.accepted === 'boolean'
        : input.kind === 'execution_settled'
        ? exactObject(record, ['outcome', 'adoption']) &&
          (record.outcome === 'completed' || record.outcome === 'cancelled' ||
            record.outcome === 'failed' ||
            record.outcome === 'interrupted' || record.outcome === 'unknown') &&
          (record.adoption === 'canonical' ||
            record.adoption === 'non_canonical')
        : input.kind === 'execution_reconciled'
        ? exactObject(record, ['settlement']) &&
          (record.settlement === 'interrupted' ||
            record.settlement === 'unknown')
        : false;
      if (!validHostPayload) throw new HistoryStoreError('history_invalid');
      return;
    }
    const record = payload;
    const expectedObservationKind = input.kind === 'provider_request_start'
      ? 'request_start'
      : input.kind === 'provider_response_start'
      ? 'response_start'
      : input.kind === 'provider_response_bytes'
      ? 'response_bytes'
      : input.kind === 'provider_sse_event'
      ? 'sse_event'
      : input.kind === 'provider_parser_transition'
      ? 'parser_transition'
      : undefined;
    if (input.kind === 'cancel_received') {
      if (
        !exactObject(record, ['kind', 'correlation', 'sequence', 'result']) ||
        record.kind !== 'cancel_received' ||
        !validPositiveInteger(record.sequence) ||
        !['requested', 'already_requested', 'idle'].includes(
          String(record.result),
        )
      ) throw new HistoryStoreError('history_invalid');
      return;
    }
    if (input.kind === 'effect_observation') {
      if (input.workerSequence === undefined || !validEffectPayload(record)) {
        throw new HistoryStoreError('history_invalid');
      }
      if (record.sequence !== input.workerSequence) {
        throw new HistoryStoreError('history_invalid');
      }
      return;
    }
    if (input.kind === 'context_observation') {
      if (
        input.workerSequence === undefined ||
        !exactObject(record, [
          'kind',
          'correlation',
          'sequence',
          'observation',
        ]) ||
        record.kind !== 'context_observation' ||
        record.sequence !== input.workerSequence ||
        !validCorrelation(record.correlation) ||
        !validPositiveInteger(record.sequence) ||
        !validJsonObject(record.observation) ||
        !exactObject(record.observation, ['kind', 'delta']) ||
        record.observation.kind !== 'model_request_delta' ||
        !validateContextModelRequestDelta(record.observation.delta)
      ) throw new HistoryStoreError('history_invalid');
      return;
    }
    if (expectedObservationKind !== undefined) {
      if (
        input.workerSequence === undefined ||
        !exactObject(record, [
          'kind',
          'correlation',
          'sequence',
          'turn',
          'observation',
        ]) ||
        record.kind !== 'provider_observation' ||
        record.sequence !== input.workerSequence ||
        !validCorrelation(record.correlation) ||
        !validPositiveInteger(record.sequence) ||
        !validPositiveInteger(record.turn) ||
        !validateProviderEvidenceObservation(record.observation) ||
        record.observation.kind !== expectedObservationKind
      ) throw new HistoryStoreError('history_invalid');
      return;
    }
    if (input.kind === 'runtime_event') {
      const sequenced = record.kind === 'runtime_event' ||
        record.kind === 'provider_observation';
      if (sequenced) {
        if (
          input.workerSequence === undefined || !validRuntimePayload(record) ||
          record.sequence !== input.workerSequence
        ) throw new HistoryStoreError('history_invalid');
      } else if (
        input.workerSequence !== undefined || !validRuntimePayload(record)
      ) {
        throw new HistoryStoreError('history_invalid');
      }
      return;
    }
    throw new HistoryStoreError('history_invalid');
  }

  private updateEffectProjectionTx(
    db: DatabaseSync,
    input: ExecutionEventInput,
    ordinal: number,
  ): void {
    const payload = input.payload as Record<string, unknown>;
    let event = payload;
    if (event && typeof event === 'object' && !Array.isArray(event)) {
      const observation = validJsonObject(event.observation)
        ? event.observation as Record<string, unknown>
        : undefined;
      const nested = event.effect ?? event.event ??
        (observation?.kind === 'runtime_event' ? observation.event : undefined);
      if (
        typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ) {
        event = nested as Record<string, unknown>;
      }
    }
    if (
      event && typeof event === 'object' && !Array.isArray(event) &&
      event.kind === 'agent_event' && typeof event.event === 'object' &&
      event.event !== null && !Array.isArray(event.event)
    ) {
      event = event.event as Record<string, unknown>;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    const kind = String(event.kind ?? input.kind);
    let callId: string | undefined;
    let name: string | undefined;
    let resultOutcome: 'success' | 'error' | undefined;
    let status: StoredExecutionEffect['status'] | undefined;
    if (kind === 'tool_call') {
      const call = event.call as Record<string, unknown> | undefined;
      callId = typeof call?.callId === 'string' ? call.callId : undefined;
      name = typeof call?.name === 'string' ? call.name : undefined;
      status = 'observed_requested';
    } else if (kind === 'tool_progress') {
      callId = typeof event.callId === 'string' ? event.callId : undefined;
      name = typeof event.name === 'string' ? event.name : undefined;
      status = 'observed_progress';
    } else if (kind === 'tool_result') {
      const result = event.result as Record<string, unknown> | undefined;
      callId = typeof result?.callId === 'string' ? result.callId : undefined;
      name = typeof result?.name === 'string' ? result.name : undefined;
      resultOutcome = result?.outcome === 'success' || result?.outcome === 'error'
        ? result.outcome
        : undefined;
      status = 'completed';
    }
    if (callId === undefined || name === undefined || status === undefined) {
      return;
    }
    const existing = db.prepare(
      'SELECT requested_event_ordinal, progress_event_ordinal, completed_event_ordinal, result_outcome FROM execution_effects WHERE execution_id = ? AND call_id = ?',
    ).get(input.executionId, callId) as SqlRow | undefined;
    const requested: number | null = status === 'observed_requested'
      ? ordinal
      : existing?.requested_event_ordinal === null ||
          existing?.requested_event_ordinal === undefined
      ? null
      : Number(existing.requested_event_ordinal);
    const progress: number | null = status === 'observed_progress'
      ? ordinal
      : existing?.progress_event_ordinal === null ||
          existing?.progress_event_ordinal === undefined
      ? null
      : Number(existing.progress_event_ordinal);
    const completed: number | null = status === 'completed'
      ? ordinal
      : existing?.completed_event_ordinal === null ||
          existing?.completed_event_ordinal === undefined
      ? null
      : Number(existing.completed_event_ordinal);
    const previousOutcome: string | null = existing?.result_outcome === null ||
        existing?.result_outcome === undefined
      ? null
      : String(existing.result_outcome);
    db.prepare(`
      INSERT INTO execution_effects(
        execution_id, call_id, name, requested_event_ordinal, progress_event_ordinal,
        completed_event_ordinal, result_outcome, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id, call_id) DO UPDATE SET
        name=excluded.name, requested_event_ordinal=excluded.requested_event_ordinal,
        progress_event_ordinal=excluded.progress_event_ordinal,
        completed_event_ordinal=excluded.completed_event_ordinal,
        result_outcome=excluded.result_outcome, status=excluded.status
    `).run(
      input.executionId,
      callId,
      name,
      requested,
      progress,
      completed,
      resultOutcome ?? previousOutcome,
      status === 'completed' ? 'completed' : completed === null ? status : 'completed',
    );
  }

  async beginExecution(input: BeginExecutionInput): Promise<void> {
    this.validateExecutionInput(input);
    let contextBasis: readonly {
      readonly relation: ExecutionContextRelation;
      readonly blob: ContextBlobInput;
    }[];
    try {
      contextBasis = await this.prepareContextBasis(input.contextSnapshot);
    } catch {
      throw new HistoryStoreError('history_invalid');
    }
    if (
      (input.sessionMode !== 'persistent' &&
        input.sessionMode !== 'no_session') ||
      (input.sessionMode === 'persistent') !==
        (input.canonicalSessionId !== undefined) ||
      (input.sessionMode === 'no_session') !==
        (input.canonicalSessionId === undefined) ||
      (input.sessionMode === 'no_session' && input.sessionRecord !== undefined)
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    if (
      input.sessionRecord !== undefined &&
      (!validateSessionRecordV6(input.sessionRecord) ||
        input.sessionRecord.sessionId !== input.canonicalSessionId ||
        input.sessionRecord.workspaceRoot !== this.workspaceRoot ||
        input.sessionRecord.nextTurn !== input.turn ||
        input.sessionRecord.stateRevision !== input.baseStateRevision)
    ) throw new HistoryStoreError('history_invalid');
    const layout = await this.layout();
    let executionLock: Lock | undefined;
    if (input.canonicalSessionId === undefined) {
      try {
        executionLock = await acquireLock(
          `${layout.locks}/.execution-${input.executionId}.lock`,
        );
      } catch (error) {
        if (
          error instanceof SessionStoreError && error.code === 'session_busy'
        ) {
          throw new HistoryStoreError('history_busy');
        }
        throw error;
      }
      this.executionLocks.set(input.executionId, executionLock);
    }
    let db: DatabaseSync | undefined;
    try {
      db = this.openSynchronousDatabase();
      const syncDb = db;
      this.transaction(syncDb, () => {
        if (input.sessionRecord !== undefined) {
          this.writeRecord(syncDb, input.sessionRecord!);
        } else if (input.canonicalSessionId !== undefined) {
          const found = syncDb.prepare(
            'SELECT 1 FROM sessions WHERE session_id = ?',
          ).get(
            input.canonicalSessionId,
          );
          if (found === undefined) {
            throw new HistoryStoreError('history_invalid');
          }
        }
        syncDb.prepare(`
          INSERT INTO tasks(task_id, canonical_session_id, session_correlation, turn, task_text, admitted_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          input.taskId,
          input.canonicalSessionId ?? null,
          input.sessionCorrelation,
          input.turn,
          input.task,
          input.createdAt,
        );
        syncDb.prepare(`
          INSERT INTO executions(
            execution_id, task_id, canonical_session_id, session_correlation, turn, created_at,
            lifecycle, outcome, adoption, base_revision, agent, model_json, build_json, definition_json,
            manifest_json, instance_correlation, worker_generation
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'unknown', 'non_canonical', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.executionId,
          input.taskId,
          input.canonicalSessionId ?? null,
          input.sessionCorrelation,
          input.turn,
          input.createdAt,
          input.baseStateRevision,
          input.agent,
          JSON.stringify(input.model),
          JSON.stringify(input.build),
          JSON.stringify(input.definition),
          input.manifest === undefined ? null : JSON.stringify(input.manifest),
          input.instanceCorrelation ?? null,
          input.workerGeneration ?? null,
        );
        for (const entry of contextBasis) {
          this.insertContextBlobTx(syncDb, entry.blob);
          this.insertContextRelationTx(
            syncDb,
            input.executionId,
            entry.relation,
          );
        }
        syncDb.prepare(`
          INSERT INTO execution_context_counters(execution_id, next_relation_ordinal)
          VALUES (?, ?)
        `).run(input.executionId, contextBasis.length + 1);
        this.appendExecutionEventTx(syncDb, {
          executionId: input.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'execution_admitted',
          payload: {
            taskId: input.taskId,
            executionId: input.executionId,
            sessionCorrelation: input.sessionCorrelation,
            turn: input.turn,
            task: input.task,
          },
        });
        this.appendExecutionEventTx(syncDb, {
          executionId: input.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'turn_dispatch_requested',
          payload: { task: input.task },
        });
      });
    } catch (error) {
      if (executionLock !== undefined) {
        this.executionLocks.delete(input.executionId);
        executionLock.close();
      }
      throw error;
    } finally {
      db?.close();
    }
  }

  appendExecutionEvent(input: ExecutionEventInput): StoredExecutionEvent {
    const [stored] = this.appendExecutionEvents([input]);
    if (stored === undefined) throw new HistoryStoreError('history_invalid');
    return stored;
  }

  validateExecutionEvent(input: ExecutionEventInput): boolean {
    try {
      this.validateExecutionEventInput(input);
      return true;
    } catch {
      return false;
    }
  }

  appendExecutionEvents(
    inputs: readonly ExecutionEventInput[],
  ): readonly StoredExecutionEvent[] {
    if (inputs.length === 0) return [];
    const db = this.openSynchronousDatabase();
    try {
      return this.transaction(
        db,
        () => inputs.map((input) => this.appendExecutionEventTx(db, input)),
      );
    } finally {
      db.close();
    }
  }

  private canonicalTranscriptThroughRevisionTx(
    db: DatabaseSync,
    sessionId: string,
    revision: number,
  ): Message[] {
    const rows = db.prepare(`
      SELECT m.execution_id, m.session_ordinal, m.source_kind,
        m.source_observation_ordinals_json,
        m.content_digest, k.task_text
      FROM canonical_turns t JOIN execution_messages m
        ON m.execution_id = t.execution_id
      JOIN executions e ON e.execution_id = m.execution_id
      JOIN tasks k ON k.task_id = e.task_id
      WHERE t.session_id = ? AND t.committed_revision <= ?
      ORDER BY m.session_ordinal
    `).all(sessionId, revision) as SqlRow[];
    return rows.map((row, index) => {
      if (Number(row.session_ordinal) !== index) {
        throw new HistoryStoreError('history_invalid');
      }
      return this.messageFromRow(db, row);
    });
  }

  private writeExecutionMessagesTx(
    db: DatabaseSync,
    executionId: string,
    transcript: readonly Message[],
  ): void {
    const execution = db.prepare(`
      SELECT e.session_correlation, e.base_revision, t.task_text
      FROM executions e JOIN tasks t ON t.task_id = e.task_id
      WHERE e.execution_id = ?
    `).get(executionId) as SqlRow | undefined;
    if (execution === undefined) throw new HistoryStoreError('history_invalid');
    const prefix = this.canonicalTranscriptThroughRevisionTx(
      db,
      String(execution.session_correlation),
      Number(execution.base_revision),
    );
    if (
      transcript.length < prefix.length ||
      prefix.some((message, index) =>
        canonicalJson(
          message as unknown as import('../core/contracts.ts').JsonValue,
        ) !== canonicalJson(
          transcript[
            index
          ] as unknown as import('../core/contracts.ts').JsonValue,
        )
      )
    ) throw new HistoryStoreError('history_invalid');
    const suffix = transcript.slice(prefix.length);
    const existing = db.prepare(`
      SELECT execution_id, ordinal, session_ordinal, source_kind,
        source_observation_ordinals_json,
        content_digest, ? AS task_text
      FROM execution_messages
      WHERE execution_id = ? ORDER BY ordinal
    `).all(String(execution.task_text), executionId) as SqlRow[];
    if (existing.length > 0) {
      if (
        existing.length !== suffix.length ||
        existing.some((row, index) =>
          Number(row.ordinal) !== index ||
          Number(row.session_ordinal) !== prefix.length + index ||
          canonicalJson(
              this.messageFromRow(
                db,
                row,
              ) as unknown as import('../core/contracts.ts').JsonValue,
            ) !==
            canonicalJson(
              suffix[
                index
              ] as unknown as import('../core/contracts.ts').JsonValue,
            )
        )
      ) throw new HistoryStoreError('history_invalid');
      return;
    }
    const insert = db.prepare(`
      INSERT INTO execution_messages(
        execution_id, ordinal, session_ordinal, source_kind,
        source_observation_ordinals_json, content_digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const usedRuntimeOrdinals = new Set<number>();
    suffix.forEach((message, ordinal) => {
      const taskReference = ordinal === 0 && message.role === 'user' &&
        message.content.kind === 'text' &&
        message.content.text === String(execution.task_text);
      const runtimeOrdinals = taskReference ? undefined : this.runtimeSourceOrdinalsTx(
        db,
        executionId,
        message,
        usedRuntimeOrdinals,
      );
      let contentDigest: string | null = null;
      if (!taskReference && runtimeOrdinals === undefined) {
        const bytes = canonicalJsonBytes(
          message as unknown as import('../core/contracts.ts').JsonValue,
        );
        contentDigest = contextDigestSync(bytes);
        this.insertContextBlobTx(db, {
          digest: contentDigest,
          byteLength: bytes.byteLength,
          mediaType: 'application/vnd.henji.message+json',
          bytes,
        });
      }
      insert.run(
        executionId,
        ordinal,
        prefix.length + ordinal,
        taskReference ? 'task' : runtimeOrdinals === undefined ? 'message' : 'runtime',
        runtimeOrdinals === undefined ? null : JSON.stringify(runtimeOrdinals),
        contentDigest,
      );
    });
  }

  private executionTranscriptTx(db: DatabaseSync, row: SqlRow): Message[] {
    const prefix = this.canonicalTranscriptThroughRevisionTx(
      db,
      String(row.session_correlation),
      Number(row.base_revision),
    );
    const suffix = db.prepare(`
      SELECT m.execution_id, m.ordinal, m.session_ordinal, m.source_kind,
        m.source_observation_ordinals_json, m.content_digest,
        t.task_text
      FROM execution_messages m JOIN executions e
        ON e.execution_id = m.execution_id
      JOIN tasks t ON t.task_id = e.task_id
      WHERE m.execution_id = ? ORDER BY m.ordinal
    `).all(String(row.execution_id)) as SqlRow[];
    return [
      ...prefix,
      ...suffix.map((message, index) => {
        if (
          Number(message.ordinal) !== index ||
          Number(message.session_ordinal) !== prefix.length + index
        ) throw new HistoryStoreError('history_invalid');
        return this.messageFromRow(db, message);
      }),
    ];
  }

  private writeOutcomeTx(
    db: DatabaseSync,
    executionId: string,
    outcome: LoopOutcome,
  ): void {
    if (!validLoopOutcome(outcome)) {
      throw new HistoryStoreError('history_invalid');
    }
    try {
      this.writeExecutionMessagesTx(db, executionId, outcome.transcript);
    } catch (error) {
      const execution = db.prepare(`SELECT session_correlation, base_revision
        FROM executions WHERE execution_id = ?`).get(executionId) as
        | SqlRow
        | undefined;
      const prefix = execution === undefined
        ? undefined
        : this.canonicalTranscriptThroughRevisionTx(
          db,
          String(execution.session_correlation),
          Number(execution.base_revision),
        );
      const observedSuffix = db.prepare(`SELECT 1 FROM execution_messages
        WHERE execution_id = ? LIMIT 1`).get(executionId);
      if (
        !(error instanceof HistoryStoreError) || prefix === undefined ||
        observedSuffix === undefined ||
        JSON.stringify(outcome.transcript) !== JSON.stringify(prefix)
      ) throw error;
      // A proposal fact may already contain a valid current-turn suffix when a later
      // canonical SQL statement fails. Keep that observed suffix as the non-canonical
      // outcome transcript instead of copying or discarding it.
    }
    db.prepare(`
      INSERT INTO execution_outcomes(
        execution_id, ok, outcome, stop_reason, final_text, terminal_kind, error,
        diagnostic_id, diagnostic_durability, diagnostic_persistence_error,
        provider_evidence_id, provider_evidence_durability,
        provider_evidence_persistence_error, turn_provider_request_count,
        runtime_provider_request_count, execution_artifact_id,
        execution_artifact_durability, execution_artifact_persistence_error,
        execution_admission_durability, execution_admission_persistence_error,
        execution_journal_durability, execution_journal_persistence_error,
        execution_observation_durability, execution_observation_persistence_error,
        steps, tool_call_count, tool_result_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      executionId,
      outcome.ok ? 1 : 0,
      outcome.outcome,
      outcome.stopReason,
      outcome.finalText ?? null,
      outcome.terminalKind ?? null,
      outcome.error ?? null,
      outcome.diagnostic?.diagnosticId ?? null,
      outcome.diagnosticDurability ?? null,
      outcome.diagnosticPersistenceError ?? null,
      outcome.providerEvidenceId ?? null,
      outcome.providerEvidenceDurability ?? null,
      outcome.providerEvidencePersistenceError ?? null,
      outcome.turnProviderRequestCount ?? null,
      outcome.runtimeProviderRequestCount ?? null,
      outcome.executionArtifactId ?? null,
      outcome.executionArtifactDurability ?? null,
      outcome.executionArtifactPersistenceError ?? null,
      outcome.executionAdmissionDurability ?? null,
      outcome.executionAdmissionPersistenceError ?? null,
      outcome.executionJournalDurability ?? null,
      outcome.executionJournalPersistenceError ?? null,
      outcome.executionObservationDurability ?? null,
      outcome.executionObservationPersistenceError ?? null,
      outcome.steps,
      outcome.toolCallCount,
      outcome.toolResultCount,
    );
  }

  private readOutcomeTx(
    db: DatabaseSync,
    execution: SqlRow,
  ): LoopOutcome | undefined {
    const row = db.prepare(
      'SELECT * FROM execution_outcomes WHERE execution_id = ?',
    )
      .get(String(execution.execution_id)) as SqlRow | undefined;
    if (row === undefined) return undefined;
    let diagnostic: FailureDiagnosticV1 | undefined;
    if (row.diagnostic_id !== null) {
      const stored = db.prepare(
        'SELECT * FROM failure_diagnostics WHERE diagnostic_id = ?',
      ).get(String(row.diagnostic_id)) as SqlRow | undefined;
      if (stored !== undefined) diagnostic = this.diagnosticFromRow(stored);
    }
    const value: LoopOutcome = {
      ok: Number(row.ok) === 1,
      task: String(execution.task_text),
      outcome: row.outcome as LoopOutcome['outcome'],
      stopReason: row.stop_reason as LoopOutcome['stopReason'],
      ...(row.final_text === null ? {} : { finalText: String(row.final_text) }),
      ...(row.terminal_kind === null ? {} : { terminalKind: row.terminal_kind as 'json_result' }),
      ...(row.error === null ? {} : { error: String(row.error) }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(row.diagnostic_durability === null ? {} : {
        diagnosticDurability: String(
          row.diagnostic_durability,
        ) as LoopOutcome['diagnosticDurability'],
      }),
      ...(row.diagnostic_persistence_error === null ? {} : {
        diagnosticPersistenceError: String(
          row.diagnostic_persistence_error,
        ) as LoopOutcome['diagnosticPersistenceError'],
      }),
      ...(row.provider_evidence_id === null
        ? {}
        : { providerEvidenceId: String(row.provider_evidence_id) }),
      ...(row.provider_evidence_durability === null ? {} : {
        providerEvidenceDurability: String(
          row.provider_evidence_durability,
        ) as LoopOutcome['providerEvidenceDurability'],
      }),
      ...(row.provider_evidence_persistence_error === null ? {} : {
        providerEvidencePersistenceError: String(
          row.provider_evidence_persistence_error,
        ) as LoopOutcome['providerEvidencePersistenceError'],
      }),
      ...(row.turn_provider_request_count === null ? {} : {
        turnProviderRequestCount: Number(row.turn_provider_request_count),
      }),
      ...(row.runtime_provider_request_count === null ? {} : {
        runtimeProviderRequestCount: Number(
          row.runtime_provider_request_count,
        ),
      }),
      ...(row.execution_artifact_id === null
        ? {}
        : { executionArtifactId: String(row.execution_artifact_id) }),
      ...(row.execution_artifact_durability === null ? {} : {
        executionArtifactDurability: String(
          row.execution_artifact_durability,
        ) as LoopOutcome['executionArtifactDurability'],
      }),
      ...(row.execution_artifact_persistence_error === null ? {} : {
        executionArtifactPersistenceError: String(
          row.execution_artifact_persistence_error,
        ) as LoopOutcome['executionArtifactPersistenceError'],
      }),
      ...(row.execution_admission_durability === null
        ? {}
        : { executionAdmissionDurability: 'failed' as const }),
      ...(row.execution_admission_persistence_error === null ? {} : {
        executionAdmissionPersistenceError: String(
          row.execution_admission_persistence_error,
        ) as LoopOutcome['executionAdmissionPersistenceError'],
      }),
      ...(row.execution_journal_durability === null
        ? {}
        : { executionJournalDurability: 'failed' as const }),
      ...(row.execution_journal_persistence_error === null ? {} : {
        executionJournalPersistenceError: String(
          row.execution_journal_persistence_error,
        ) as LoopOutcome['executionJournalPersistenceError'],
      }),
      ...(row.execution_observation_durability === null
        ? {}
        : { executionObservationDurability: 'failed' as const }),
      ...(row.execution_observation_persistence_error === null ? {} : {
        executionObservationPersistenceError: String(
          row.execution_observation_persistence_error,
        ) as LoopOutcome['executionObservationPersistenceError'],
      }),
      steps: Number(row.steps),
      toolCallCount: Number(row.tool_call_count),
      toolResultCount: Number(row.tool_result_count),
      transcript: this.executionTranscriptTx(db, execution),
    };
    if (!validLoopOutcome(value)) {
      throw new HistoryStoreError('history_invalid');
    }
    return value;
  }

  private executionFromRow(db: DatabaseSync, row: SqlRow): StoredExecutionRow {
    const parseOptionalJson = <T>(value: unknown): T | undefined => {
      if (value === null || value === undefined) return undefined;
      try {
        return JSON.parse(String(value)) as T;
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
    };
    const canonicalSessionId = row.canonical_session_id === null ||
        row.canonical_session_id === undefined
      ? undefined
      : String(row.canonical_session_id);
    const manifest = parseOptionalJson<
      NonNullable<WorkerReadyMessage['manifest']>
    >(
      row.manifest_json,
    );
    const outcomeJson = this.readOutcomeTx(db, row);
    return {
      executionId: String(row.execution_id),
      taskId: String(row.task_id),
      task: String(row.task_text),
      ...(canonicalSessionId === undefined ? {} : { canonicalSessionId }),
      sessionCorrelation: String(row.session_correlation),
      turn: Number(row.turn),
      createdAt: String(row.created_at),
      ...(row.settled_at === null || row.settled_at === undefined
        ? {}
        : { settledAt: String(row.settled_at) }),
      lifecycle: row.lifecycle as StoredExecutionRow['lifecycle'],
      outcome: row.outcome as StoredExecutionRow['outcome'],
      ...(outcomeJson === undefined ? {} : { outcomeJson }),
      adoption: row.adoption as StoredExecutionRow['adoption'],
      baseRevision: Number(row.base_revision),
      ...(row.committed_revision === null ||
          row.committed_revision === undefined
        ? {}
        : { committedRevision: Number(row.committed_revision) }),
      agent: row.agent as StoredExecutionRow['agent'],
      model: parseOptionalJson<NonCanonicalExecutionInput['model']>(
        row.model_json,
      )!,
      build: parseOptionalJson<NonCanonicalExecutionInput['build']>(
        row.build_json,
      )!,
      definition: parseOptionalJson<NonCanonicalExecutionInput['definition']>(
        row.definition_json,
      )!,
      ...(manifest === undefined ? {} : { manifest }),
      ...(row.instance_correlation === null
        ? {}
        : { instanceCorrelation: String(row.instance_correlation) }),
      ...(row.worker_generation === null
        ? {}
        : { workerGeneration: String(row.worker_generation) }),
      acknowledgement: String(row.acknowledgement),
      generationAvailability: String(row.generation_availability),
      evidenceCapture: String(row.evidence_capture),
      ...(row.provider_evidence_id === null ||
          row.provider_evidence_id === undefined
        ? {}
        : { providerEvidenceId: String(row.provider_evidence_id) }),
      diagnosticCapture: String(row.diagnostic_capture),
      artifactCapture: String(row.artifact_capture),
      contextCapture: row.context_capture === undefined || row.context_capture === null
        ? 'none'
        : row.context_capture as 'none' | 'partial' | 'complete' | 'failed',
    };
  }

  listExecutions(): readonly StoredExecutionRow[] {
    const db = this.openSynchronousDatabase();
    try {
      return (db.prepare(`
        SELECT e.execution_id, e.task_id, t.task_text, e.canonical_session_id, e.session_correlation, e.turn,
          created_at, settled_at, lifecycle, outcome, adoption, base_revision,
          committed_revision, agent, model_json, build_json, definition_json, manifest_json,
          instance_correlation, worker_generation, acknowledgement,
          (SELECT evidence_id FROM provider_evidence WHERE execution_id = e.execution_id
            ORDER BY created_at, evidence_id LIMIT 1) AS provider_evidence_id,
          generation_availability, evidence_capture, diagnostic_capture, artifact_capture,
          context_capture
        FROM executions e JOIN tasks t ON t.task_id = e.task_id
        ORDER BY e.created_at, e.execution_id
      `).all() as SqlRow[]).map((row) => this.executionFromRow(db, row));
    } finally {
      db.close();
    }
  }

  readExecution(id: string): StoredExecutionRow {
    if (!UUID_V4.test(id)) throw new HistoryStoreError('history_invalid');
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(`
        SELECT e.execution_id, e.task_id, t.task_text, e.canonical_session_id, e.session_correlation, e.turn,
          created_at, settled_at, lifecycle, outcome, adoption, base_revision,
          committed_revision, agent, model_json, build_json, definition_json, manifest_json,
          instance_correlation, worker_generation, acknowledgement,
          (SELECT evidence_id FROM provider_evidence WHERE execution_id = e.execution_id
            ORDER BY created_at, evidence_id LIMIT 1) AS provider_evidence_id,
          generation_availability, evidence_capture, diagnostic_capture, artifact_capture,
          context_capture
        FROM executions e JOIN tasks t ON t.task_id = e.task_id
        WHERE e.execution_id = ?
      `).get(id) as SqlRow | undefined;
      if (row === undefined) throw new HistoryStoreError('history_io_failure');
      return this.executionFromRow(db, row);
    } finally {
      db.close();
    }
  }

  listExecutionEvents(id: string): readonly StoredExecutionEvent[] {
    const db = this.openSynchronousDatabase();
    try {
      const exists = db.prepare(
        'SELECT 1 FROM executions WHERE execution_id = ?',
      ).get(id);
      if (exists === undefined) {
        throw new HistoryStoreError('history_io_failure');
      }
      return (db.prepare(`
        SELECT execution_id, ordinal, observed_at, direction, source, kind, worker_sequence, payload_json
        FROM execution_observations WHERE execution_id = ? ORDER BY ordinal
      `).all(id) as SqlRow[]).map((row) => {
        const payload = this.eventPayloadTx(db, row);
        return {
          executionId: String(row.execution_id),
          ordinal: Number(row.ordinal),
          observedAt: String(row.observed_at),
          direction: row.direction as StoredExecutionEvent['direction'],
          source: row.source as StoredExecutionEvent['source'],
          kind: row.kind as StoredExecutionEvent['kind'],
          ...(row.worker_sequence === null ? {} : { workerSequence: Number(row.worker_sequence) }),
          payload,
        };
      });
    } finally {
      db.close();
    }
  }

  listExecutionEffects(id: string): readonly StoredExecutionEffect[] {
    const db = this.openSynchronousDatabase();
    try {
      return (db.prepare(`
        SELECT execution_id, call_id, name, requested_event_ordinal, progress_event_ordinal,
          completed_event_ordinal, result_outcome, status
        FROM execution_effects WHERE execution_id = ? ORDER BY call_id
      `).all(id) as SqlRow[]).map((row) => ({
        executionId: String(row.execution_id),
        callId: String(row.call_id),
        name: String(row.name),
        ...(row.requested_event_ordinal === null
          ? {}
          : { requestedEventOrdinal: Number(row.requested_event_ordinal) }),
        ...(row.progress_event_ordinal === null
          ? {}
          : { progressEventOrdinal: Number(row.progress_event_ordinal) }),
        ...(row.completed_event_ordinal === null
          ? {}
          : { completedEventOrdinal: Number(row.completed_event_ordinal) }),
        ...(row.result_outcome === null
          ? {}
          : { resultOutcome: row.result_outcome as 'success' | 'error' }),
        status: row.status as StoredExecutionEffect['status'],
      }));
    } finally {
      db.close();
    }
  }

  private readContextBlobTx(db: DatabaseSync, digest: string): Uint8Array {
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new HistoryStoreError('history_invalid');
    }
    const row = db.prepare(
      'SELECT byte_length, raw_bytes FROM context_blobs WHERE digest = ?',
    ).get(digest) as SqlRow | undefined;
    if (row === undefined) throw new HistoryStoreError('history_invalid');
    const bytes = row.raw_bytes instanceof Uint8Array
      ? row.raw_bytes
      : new Uint8Array(row.raw_bytes as ArrayBuffer);
    if (
      Number(row.byte_length) !== bytes.byteLength ||
      contextDigestSync(bytes) !== digest
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    return bytes.slice();
  }

  private contextSnapshotFromFactsTx(
    db: DatabaseSync,
    executionId: string,
  ): WorkerContextSnapshot | undefined {
    const rows = db.prepare(`
      SELECT ordinal, stage, resource_kind, logical_identity, source_locator,
        content_digest FROM execution_context_relations
      WHERE execution_id = ? AND resource_kind IN (
        'workspace_instruction', 'skill_catalog', 'skill',
        'instruction_component', 'definition_output', 'tool_contract',
        'runtime_fact'
      ) ORDER BY ordinal
    `).all(executionId) as SqlRow[];
    if (rows.length === 0) return undefined;
    const text = (row: SqlRow): string => {
      if (row.content_digest === null) {
        throw new HistoryStoreError('history_invalid');
      }
      try {
        return decoder.decode(
          this.readContextBlobTx(db, String(row.content_digest)),
        );
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
    };
    const discoveredInstruction = rows.find((row) =>
      row.resource_kind === 'workspace_instruction' &&
      row.stage === 'discovered'
    );
    const resolvedInstruction = rows.find((row) =>
      row.resource_kind === 'workspace_instruction' && row.stage === 'resolved'
    );
    if (
      (discoveredInstruction === undefined) !==
        (resolvedInstruction === undefined)
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    const skills = rows.filter((row) => row.resource_kind === 'skill' && row.stage === 'discovered')
      .map((row) => {
        try {
          return JSON.parse(text(row));
        } catch {
          throw new HistoryStoreError('history_invalid');
        }
      });
    const components = rows.filter((row) =>
      row.resource_kind === 'instruction_component' && row.stage === 'resolved'
    ).map((row) => ({
      identity: String(row.logical_identity),
      text: text(row),
      ...(row.source_locator === null ? {} : { sourceLocator: String(row.source_locator) }),
    }));
    const tools = rows.filter((row) =>
      row.resource_kind === 'tool_contract' && row.stage === 'resolved'
    ).map((row) => {
      try {
        return JSON.parse(text(row));
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
    });
    const manifest = rows.find((row) =>
      row.resource_kind === 'skill_catalog' && row.stage === 'resolved'
    );
    const definitionOutput = rows.find((row) =>
      row.resource_kind === 'definition_output' && row.stage === 'resolved'
    );
    const cwd = rows.find((row) =>
      row.resource_kind === 'runtime_fact' && row.stage === 'resolved' &&
      row.logical_identity === 'cwd'
    );
    if (cwd === undefined) throw new HistoryStoreError('history_invalid');
    const snapshot = {
      schemaVersion: 1,
      workspaceRoot: this.workspaceRoot,
      ...(discoveredInstruction === undefined ||
          resolvedInstruction === undefined
        ? {}
        : {
          workspaceInstruction: {
            source: String(discoveredInstruction.source_locator),
            text: text(discoveredInstruction),
            formatted: text(resolvedInstruction),
          },
        }),
      skillCatalog: {
        ...(manifest === undefined ? {} : { manifest: text(manifest) }),
        skills,
      },
      instructionComponents: components,
      ...(components.length > 0
        ? {
          systemInstruction: components.map((component) => component.text).join(
            '\n\n',
          ),
        }
        : definitionOutput === undefined
        ? {}
        : { systemInstruction: text(definitionOutput) }),
      toolDefinitions: tools,
      runtimeFacts: { cwd: text(cwd) },
    } as unknown as WorkerContextSnapshot;
    if (!validateWorkerContextSnapshot(snapshot)) {
      throw new HistoryStoreError('history_invalid');
    }
    return snapshot;
  }

  private revisionOccurrenceIdsTx(
    db: DatabaseSync,
    executionId: string,
    revisionDigest: string,
    memo = new Map<string, readonly string[]>(),
  ): readonly string[] {
    const cached = memo.get(revisionDigest);
    if (cached !== undefined) return cached;
    const revision = db.prepare(`
      SELECT base_revision_digest, result_item_count
      FROM context_sequence_revisions
      WHERE execution_id = ? AND revision_digest = ?
    `).get(executionId, revisionDigest) as SqlRow | undefined;
    if (revision === undefined) throw new HistoryStoreError('history_invalid');
    const occurrences = revision.base_revision_digest === null
      ? []
      : [...this.revisionOccurrenceIdsTx(
        db,
        executionId,
        String(revision.base_revision_digest),
        memo,
      )];
    const splices = db.prepare(`
      SELECT splice_ordinal, start_index, delete_count
      FROM context_sequence_splices
      WHERE execution_id = ? AND revision_digest = ? ORDER BY splice_ordinal
    `).all(executionId, revisionDigest) as SqlRow[];
    for (const splice of splices) {
      const insertions = (db.prepare(`
        SELECT occurrence_id FROM context_sequence_insertions
        WHERE execution_id = ? AND revision_digest = ? AND splice_ordinal = ?
        ORDER BY insertion_ordinal
      `).all(
        executionId,
        revisionDigest,
        Number(splice.splice_ordinal),
      ) as SqlRow[])
        .map((row) => String(row.occurrence_id));
      const start = Number(splice.start_index);
      const deleteCount = Number(splice.delete_count);
      if (
        start > occurrences.length || start + deleteCount > occurrences.length
      ) {
        throw new HistoryStoreError('history_invalid');
      }
      occurrences.splice(start, deleteCount, ...insertions);
    }
    if (occurrences.length !== Number(revision.result_item_count)) {
      throw new HistoryStoreError('history_invalid');
    }
    const result = Object.freeze(occurrences.slice());
    memo.set(revisionDigest, result);
    return result;
  }

  private readExecutionRequestV5Tx(
    db: DatabaseSync,
    executionId: string,
    requestOrdinal: number,
    memo = new Map<string, readonly string[]>(),
  ): ContextModelRequestRecord {
    const row = db.prepare(`
      SELECT request_ordinal, lane, purpose, model_step, model_selection_json,
        revision_digest, source_call_id
      FROM model_requests WHERE execution_id = ? AND request_ordinal = ?
    `).get(executionId, requestOrdinal) as SqlRow | undefined;
    if (row === undefined) throw new HistoryStoreError('history_io_failure');
    let modelSelection: ModelSelection | undefined;
    try {
      modelSelection = row.model_selection_json === null
        ? undefined
        : JSON.parse(String(row.model_selection_json)) as ModelSelection;
    } catch {
      throw new HistoryStoreError('history_invalid');
    }
    const occurrenceIds = this.revisionOccurrenceIdsTx(
      db,
      executionId,
      String(row.revision_digest),
      memo,
    );
    const items = occurrenceIds.map((occurrenceId, index) => {
      const occurrence = db.prepare(`
        SELECT o.kind, o.content_digest,
          b.byte_length, b.media_type, b.raw_bytes
        FROM context_occurrences o JOIN context_blobs b ON b.digest = o.content_digest
        WHERE o.execution_id = ? AND o.occurrence_id = ?
      `).get(executionId, occurrenceId) as SqlRow | undefined;
      if (occurrence === undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      const bytes = occurrence.raw_bytes instanceof Uint8Array
        ? occurrence.raw_bytes
        : new Uint8Array(occurrence.raw_bytes as ArrayBuffer);
      if (
        bytes.byteLength !== Number(occurrence.byte_length) ||
        contextDigestSync(bytes) !== String(occurrence.content_digest)
      ) throw new HistoryStoreError('history_invalid');
      const sourceRelations = (db.prepare(`
        SELECT stage, resource_kind, logical_identity, source_locator,
          content_digest, lane, model_step, call_id, source_event_ordinal
        FROM context_occurrence_sources
        WHERE execution_id = ? AND occurrence_id = ? ORDER BY source_ordinal
      `).all(executionId, occurrenceId) as SqlRow[]).map((source) => ({
        stage: source.stage as ContextSourceRelation['stage'],
        resourceKind: source
          .resource_kind as ContextSourceRelation['resourceKind'],
        ...(source.logical_identity === null
          ? {}
          : { logicalIdentity: String(source.logical_identity) }),
        ...(source.source_locator === null ? {} : { sourceLocator: String(source.source_locator) }),
        ...(source.content_digest === null ? {} : { contentDigest: String(source.content_digest) }),
        ...(source.lane === null ? {} : { lane: source.lane as 'parent' | 'planner' }),
        ...(source.model_step === null ? {} : { modelStep: Number(source.model_step) }),
        ...(source.call_id === null ? {} : { callId: String(source.call_id) }),
        ...(source.source_event_ordinal === null
          ? {}
          : { sourceEventOrdinal: Number(source.source_event_ordinal) }),
      }));
      return {
        ordinal: index + 1,
        kind: occurrence
          .kind as ContextModelRequestRecord['items'][number]['kind'],
        content: {
          digest: String(occurrence.content_digest),
          byteLength: bytes.byteLength,
          mediaType: String(
            occurrence.media_type,
          ) as ContextModelRequestRecord['items'][number][
            'content'
          ]['mediaType'],
        },
        relationOrdinals: [],
        ...(sourceRelations.length === 0 ? {} : { sourceRelations }),
        bytesBase64: bytes.toBase64(),
      };
    });
    let request: import('../core/contracts.ts').ModelRequest | undefined;
    let providerBody: string | undefined;
    try {
      if (row.purpose === 'user_turn') {
        const system = items.find((item) => item.kind === 'system');
        request = {
          ...(system === undefined ? {} : {
            systemInstruction: decoder.decode(
              Uint8Array.fromBase64(system.bytesBase64),
            ),
          }),
          transcript: items.filter((item) => item.kind === 'message').map((
            item,
          ) => JSON.parse(decoder.decode(Uint8Array.fromBase64(item.bytesBase64)))),
          tools: items.filter((item) => item.kind === 'tool_contract').map((
            item,
          ) => JSON.parse(decoder.decode(Uint8Array.fromBase64(item.bytesBase64)))),
        };
      } else {
        const wire = items.find((item) => item.kind === 'provider_wire_body');
        if (wire === undefined) throw new HistoryStoreError('history_invalid');
        providerBody = decoder.decode(Uint8Array.fromBase64(wire.bytesBase64));
      }
    } catch (error) {
      if (error instanceof HistoryStoreError) throw error;
      throw new HistoryStoreError('history_invalid');
    }
    const result: ContextModelRequestRecord = {
      requestOrdinal: Number(row.request_ordinal),
      lane: row.lane as 'parent' | 'planner',
      purpose: row.purpose as 'user_turn' | 'web_search',
      modelStep: Number(row.model_step),
      ...(modelSelection === undefined ? {} : { modelSelection }),
      ...(request === undefined ? {} : { request }),
      ...(providerBody === undefined ? {} : { providerBody }),
      ...(row.source_call_id === null ? {} : { sourceCallId: String(row.source_call_id) }),
      items,
    };
    if (!validateContextModelRequestRecord(result)) {
      throw new HistoryStoreError('history_invalid');
    }
    return result;
  }

  private readExecutionContextV5Tx(
    db: DatabaseSync,
    executionId: string,
  ): {
    readonly snapshot?: WorkerContextSnapshot;
    readonly relations: readonly ExecutionContextRelation[];
    readonly requests: readonly ContextModelRequestRecord[];
  } {
    const execution = db.prepare(
      'SELECT 1 FROM executions WHERE execution_id = ?',
    )
      .get(executionId);
    if (execution === undefined) {
      throw new HistoryStoreError('history_io_failure');
    }
    const snapshot = this.contextSnapshotFromFactsTx(db, executionId);
    const relations = (db.prepare(`
      SELECT ordinal, stage, resource_kind, logical_identity, source_locator, content_digest,
        lane, model_step, call_id, request_ordinal, source_event_ordinal
      FROM execution_context_relations WHERE execution_id = ? ORDER BY ordinal
    `).all(executionId) as SqlRow[]).map((relation) => ({
      ordinal: Number(relation.ordinal),
      stage: relation.stage as ContextRelationStage,
      resourceKind: relation
        .resource_kind as ExecutionContextRelation['resourceKind'],
      ...(relation.logical_identity === null
        ? {}
        : { logicalIdentity: String(relation.logical_identity) }),
      ...(relation.source_locator === null
        ? {}
        : { sourceLocator: String(relation.source_locator) }),
      ...(relation.content_digest === null
        ? {}
        : { contentDigest: String(relation.content_digest) }),
      ...(relation.lane === null ? {} : { lane: relation.lane as 'parent' | 'planner' }),
      ...(relation.model_step === null ? {} : { modelStep: Number(relation.model_step) }),
      ...(relation.call_id === null ? {} : { callId: String(relation.call_id) }),
      ...(relation.request_ordinal === null
        ? {}
        : { requestOrdinal: Number(relation.request_ordinal) }),
      ...(relation.source_event_ordinal === null
        ? {}
        : { sourceEventOrdinal: Number(relation.source_event_ordinal) }),
    }));
    const requestRows = db.prepare(`
      SELECT request_ordinal FROM model_requests
      WHERE execution_id = ? ORDER BY request_ordinal
    `).all(executionId) as SqlRow[];
    const memo = new Map<string, readonly string[]>();
    const requests = requestRows.map((request) =>
      this.readExecutionRequestV5Tx(
        db,
        executionId,
        Number(request.request_ordinal),
        memo,
      )
    );
    return {
      ...(snapshot === undefined ? {} : { snapshot }),
      relations,
      requests,
    };
  }

  listExecutionContext(executionId: string): {
    readonly snapshot?: WorkerContextSnapshot;
    readonly relations: readonly ExecutionContextRelation[];
    readonly requests: readonly ContextModelRequestRecord[];
  } {
    if (!UUID_V4.test(executionId)) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.openSynchronousDatabase();
    try {
      const execution = db.prepare(
        'SELECT lifecycle FROM executions WHERE execution_id = ?',
      ).get(executionId) as SqlRow | undefined;
      if (execution === undefined) {
        throw new HistoryStoreError('history_io_failure');
      }
      return this.readExecutionContextV5Tx(db, executionId);
    } finally {
      db.close();
    }
  }

  readExecutionRequest(
    executionId: string,
    requestOrdinal: number,
  ): ContextModelRequestRecord {
    if (!Number.isSafeInteger(requestOrdinal) || requestOrdinal < 1) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.openSynchronousDatabase();
    try {
      return this.readExecutionRequestV5Tx(db, executionId, requestOrdinal);
    } finally {
      db.close();
    }
  }

  readExecutionRequestProviderEvidence(
    executionId: string,
    requestOrdinal: number,
  ): readonly {
    readonly evidenceId: string;
    readonly record: ProviderEvidenceV5['requests'][number];
  }[] {
    if (
      !UUID_V4.test(executionId) || !Number.isSafeInteger(requestOrdinal) ||
      requestOrdinal < 1
    ) throw new HistoryStoreError('history_invalid');
    const db = this.openSynchronousDatabase();
    try {
      const request = db.prepare(`
        SELECT evidence_id FROM model_requests
        WHERE execution_id = ? AND request_ordinal = ?
      `).get(executionId, requestOrdinal) as SqlRow | undefined;
      if (request === undefined) {
        throw new HistoryStoreError('history_io_failure');
      }
      if (request.evidence_id === null) return [];
      const evidenceId = String(request.evidence_id);
      const header = db.prepare(`
        SELECT * FROM provider_evidence WHERE evidence_id = ? AND execution_id = ?
      `).get(evidenceId, executionId) as SqlRow | undefined;
      if (header === undefined) throw new HistoryStoreError('history_invalid');
      const evidence = this.evidenceFromRow(db, header);
      if (evidence.schemaVersion !== 5) {
        throw new HistoryStoreError('history_invalid');
      }
      return evidence.requests.filter((record) =>
        record.request.contextRequestOrdinal === requestOrdinal
      ).map((record) => ({ evidenceId, record }));
    } finally {
      db.close();
    }
  }

  reconcileExecution(input: ReconcileExecutionInput): void {
    if (!UUID_V4.test(input.executionId)) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.openSynchronousDatabase();
    try {
      this.transaction(db, () => {
        const existing = db.prepare(`
          SELECT e.*, t.task_text FROM executions e JOIN tasks t ON t.task_id = e.task_id
          WHERE e.execution_id = ?
        `).get(input.executionId) as SqlRow | undefined;
        if (existing === undefined || existing.lifecycle !== 'active') {
          throw new HistoryStoreError('history_invalid');
        }
        const settledAt = input.settledAt ?? new Date().toISOString();
        const evidence = input.evidence ?? this.partialProviderEvidence(
          db,
          input.executionId,
          existing,
          input.settlement,
        );
        const artifact = input.artifact ?? this.reconciliationArtifact(
          db,
          existing,
          input.settlement,
          settledAt,
          evidence?.evidenceId,
        );
        if (
          evidence !== undefined && (
            !validateProviderEvidence(evidence) ||
            evidence.schemaVersion !== 5 ||
            evidence.capture !== 'partial' ||
            evidence.normalizedOutcome !== input.settlement ||
            evidence.settlement !== input.settlement ||
            evidence.sessionId !== String(existing.session_correlation) ||
            evidence.turnNumber !== Number(existing.turn) ||
            JSON.stringify(evidence.build) !== String(existing.build_json) ||
            JSON.stringify(evidence.definition) !==
              String(existing.definition_json)
          )
        ) throw new HistoryStoreError('history_invalid');
        if (
          artifact !== undefined && (
            !validateWorkerExecutionArtifact(artifact) ||
            artifact.schemaVersion !== 7 ||
            artifact.lifecycle !== 'settled' ||
            artifact.executionId !== String(existing.execution_id) ||
            artifact.createdAt !== String(existing.created_at) ||
            artifact.sessionId !== String(existing.session_correlation) ||
            artifact.turn !== Number(existing.turn) ||
            artifact.agent !== existing.agent ||
            artifact.command.task !== String(existing.task_text) ||
            artifact.baseStateRevision !== Number(existing.base_revision) ||
            JSON.stringify(artifact.build) !== String(existing.build_json) ||
            JSON.stringify(artifact.definition) !==
              String(existing.definition_json) ||
            (existing.manifest_json === null
              ? artifact.manifest !== undefined
              : JSON.stringify(artifact.manifest) !==
                String(existing.manifest_json)) ||
            (existing.instance_correlation !== null &&
              artifact.instanceCorrelation !==
                String(existing.instance_correlation)) ||
            (existing.worker_generation !== null &&
              artifact.workerGeneration !==
                String(existing.worker_generation)) ||
            artifact.command.correlation.session !== artifact.sessionId ||
            artifact.command.correlation.instanceCorrelation !==
              artifact.instanceCorrelation ||
            artifact.command.correlation.workerGeneration !==
              artifact.workerGeneration ||
            artifact.command.correlation.baseStateRevision !==
              artifact.baseStateRevision ||
            (artifact.providerEvidenceId !== undefined &&
              evidence === undefined)
          )
        ) throw new HistoryStoreError('history_invalid');
        db.prepare(`
          UPDATE executions SET lifecycle='settled', settled_at=?, outcome=?, adoption='non_canonical',
            artifact_capture=?, evidence_capture=?, context_capture='partial'
          WHERE execution_id=?
        `).run(
          settledAt,
          input.settlement,
          artifact === undefined ? 'unknown' : 'yes',
          evidence === undefined ? 'unknown' : 'yes',
          input.executionId,
        );
        db.prepare(`
          UPDATE execution_effects SET status='outcome_unknown'
          WHERE execution_id=? AND completed_event_ordinal IS NULL
        `).run(input.executionId);
        if (evidence !== undefined) {
          if (
            artifact !== undefined &&
            artifact.providerEvidenceId !== evidence.evidenceId
          ) {
            throw new HistoryStoreError('history_invalid');
          }
          this.writeEvidenceHeaderTx(db, input.executionId, evidence);
          for (const request of evidence.requests) {
            const logicalOrdinal = request.request.contextRequestOrdinal ??
              request.request.ordinal;
            db.prepare(`UPDATE model_requests SET evidence_id = ?
              WHERE execution_id = ? AND request_ordinal = ?`).run(
              evidence.evidenceId,
              input.executionId,
              logicalOrdinal,
            );
          }
        }
        if (artifact !== undefined) {
          if (
            !validateWorkerExecutionArtifact(artifact) ||
            artifact.schemaVersion !== 7 ||
            artifact.lifecycle !== 'settled' ||
            artifact.normalizedOutcome !== input.settlement ||
            artifact.settlement !== input.settlement ||
            artifact.adoption !== 'non_canonical' ||
            Object.hasOwn(artifact, 'outcome') ||
            artifact.executionId !== input.executionId
          ) {
            throw new HistoryStoreError('history_invalid');
          }
          this.writeArtifactTx(db, artifact);
        }
        this.appendExecutionEventTx(db, {
          executionId: input.executionId,
          observedAt: settledAt,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'execution_reconciled',
          payload: { settlement: input.settlement },
        });
      });
      // A process-owned no-session lock is held through reconciliation just like normal
      // settlement; release it only after the terminal row and journal event commit.
      this.releaseExecutionLock(input.executionId);
    } finally {
      db.close();
    }
  }

  private reconciliationArtifact(
    _db: DatabaseSync,
    row: SqlRow,
    settlement: 'interrupted' | 'unknown',
    settledAt: string,
    providerEvidenceId?: string,
  ): WorkerExecutionArtifactV7 | undefined {
    if (row.manifest_json === null || row.manifest_json === undefined) {
      return undefined;
    }
    try {
      const manifest = JSON.parse(String(row.manifest_json));
      const build = JSON.parse(String(row.build_json));
      const definition = JSON.parse(String(row.definition_json));
      const command = {
        kind: 'turn' as const,
        correlation: {
          session: String(row.session_correlation),
          instanceCorrelation: row.instance_correlation === null
            ? 'reconciled'
            : String(row.instance_correlation),
          workerGeneration: row.worker_generation === null
            ? 'unknown'
            : String(row.worker_generation),
          baseStateRevision: Number(row.base_revision),
          command: `turn-${Number(row.turn)}-reconciled`,
        },
        task: String(row.task_text),
      };
      return {
        schemaVersion: 7,
        contextCapture: 'partial',
        executionId: String(row.execution_id),
        createdAt: String(row.created_at),
        settledAt,
        sessionId: String(row.session_correlation),
        turn: Number(row.turn),
        agent: row.agent as 'default' | 'planner',
        instanceCorrelation: command.correlation.instanceCorrelation,
        workerGeneration: command.correlation.workerGeneration,
        build,
        definition,
        manifest,
        ...(manifest?.subagents === undefined ? {} : { subagents: manifest.subagents }),
        command,
        baseStateRevision: Number(row.base_revision),
        protocolTrace: [],
        ...(providerEvidenceId === undefined ? {} : {
          providerEvidenceId,
          providerEvidenceDurability: 'yes' as const,
        }),
        storeResult: 'not_attempted',
        acknowledgement: 'not_sent',
        settlement,
        lifecycle: 'settled',
        normalizedOutcome: settlement,
        adoption: 'non_canonical',
        effectCommitRelation: 'not_transactional',
        automaticReplay: false,
      };
    } catch {
      return undefined;
    }
  }

  /** Materialize only provider observations that crossed the Worker/Host journal boundary. */
  private partialProviderEvidence(
    db: DatabaseSync,
    executionId: string,
    row: SqlRow,
    settlement: 'interrupted' | 'unknown',
  ): ProviderEvidenceV5 | undefined {
    const providerRows = db.prepare(`
      SELECT observation_ordinal, observation_kind, request_ordinal,
        byte_offset, observation_json, raw_bytes
      FROM provider_observation_facts
      WHERE execution_id = ? ORDER BY observation_ordinal
    `).all(executionId) as SqlRow[];
    const runtimeRows = db.prepare(`
      SELECT r.observation_ordinal, r.request_ordinal, r.event_json,
        d.stream_key, d.mode, d.text_fragment
      FROM runtime_occurrences r
      LEFT JOIN execution_progress_deltas d
        ON d.execution_id = r.execution_id AND d.event_ordinal = r.observation_ordinal
      WHERE r.execution_id = ? AND r.envelope_kind = 'provider_observation'
      ORDER BY r.observation_ordinal
    `).all(executionId) as SqlRow[];
    if (providerRows.length === 0 && runtimeRows.length === 0) return undefined;
    type PartialRecord = {
      request: Record<string, unknown>;
      response?: Record<string, unknown>;
      chunks: Uint8Array[];
      sseEvents: ProviderEvidenceSseEvent[];
      parserTransitions: ProviderEvidenceParserTransition[];
    };
    const records = new Map<number, PartialRecord>();
    const runtimeEvents: ProviderEvidenceRuntimeEvent[] = [];
    const progressIndexes = new Map<string, number>();
    const recordRuntimeEvent = (event: ProviderEvidenceRuntimeEvent): void => {
      const key = event.kind === 'assistant_progress'
        ? `assistant:${event.modelStep}:${event.lane ?? 'parent'}:${event.requestOrdinal ?? 'none'}`
        : event.kind === 'tool_progress'
        ? `tool:${event.callId}:${event.name}:${event.modelStep}:${event.lane ?? 'parent'}:${
          event.requestOrdinal ?? 'none'
        }`
        : undefined;
      if (key === undefined) {
        runtimeEvents.push(structuredClone(event));
        return;
      }
      const index = progressIndexes.get(key);
      if (index === undefined) {
        progressIndexes.set(key, runtimeEvents.length);
        runtimeEvents.push(structuredClone(event));
      } else runtimeEvents[index] = structuredClone(event);
    };
    const progressSnapshots = new Map<string, string>();
    for (const row of runtimeRows) {
      let event: unknown;
      try {
        event = JSON.parse(String(row.event_json));
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
      if (!validJsonObject(event)) {
        throw new HistoryStoreError('history_invalid');
      }
      if (row.stream_key !== null) {
        const key = String(row.stream_key);
        const previous = progressSnapshots.get(key) ?? '';
        const text = row.mode === 'append'
          ? previous + String(row.text_fragment)
          : String(row.text_fragment);
        progressSnapshots.set(key, text);
        event.text = text;
      }
      const observation = {
        kind: 'runtime_event',
        ...(row.request_ordinal === null ? {} : { requestOrdinal: Number(row.request_ordinal) }),
        event,
      };
      if (!validateProviderEvidenceObservation(observation)) {
        throw new HistoryStoreError('history_invalid');
      }
      recordRuntimeEvent(observation.event);
    }
    for (const row of providerRows) {
      let observation: unknown;
      try {
        observation = row.observation_kind === 'response_bytes'
          ? {
            kind: 'response_bytes',
            requestOrdinal: Number(row.request_ordinal),
            offset: Number(row.byte_offset),
            bytesBase64: uint8ToBase64(
              row.raw_bytes instanceof Uint8Array
                ? row.raw_bytes
                : new Uint8Array(row.raw_bytes as ArrayBuffer),
            ),
          }
          : JSON.parse(String(row.observation_json));
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
      if (
        !validateProviderEvidenceObservation(observation) ||
        observation.kind === 'runtime_event'
      ) throw new HistoryStoreError('history_invalid');
      const item = observation as Record<string, unknown>;
      if (item.kind === 'request_start') {
        const request = item.request;
        if (!validJsonObject(request)) {
          throw new HistoryStoreError('history_invalid');
        }
        const ordinal = Number(request.ordinal);
        if (
          !Number.isSafeInteger(ordinal) || ordinal < 1 || records.has(ordinal)
        ) {
          throw new HistoryStoreError('history_invalid');
        }
        records.set(ordinal, {
          request: structuredClone(request) as Record<string, unknown>,
          chunks: [],
          sseEvents: [],
          parserTransitions: [],
        });
        continue;
      }
      if (item.kind === 'response_start') {
        const record = records.get(Number(item.requestOrdinal));
        if (record === undefined || record.response !== undefined) {
          throw new HistoryStoreError('history_invalid');
        }
        record.response = {
          ...structuredClone(item.response) as Record<string, unknown>,
          rawBodyBytes: 0,
        };
        continue;
      }
      const record = records.get(Number(item.requestOrdinal));
      if (record === undefined) throw new HistoryStoreError('history_invalid');
      if (item.kind === 'response_bytes') {
        if (record.response === undefined) {
          throw new HistoryStoreError('history_invalid');
        }
        const bytes = Uint8Array.fromBase64(String(item.bytesBase64));
        const previousOffset = Number(record.response.rawBodyBytes ?? 0);
        const offset = Number(item.offset);
        if (
          !Number.isSafeInteger(offset) || offset < 0 ||
          offset !== previousOffset + bytes.byteLength
        ) throw new HistoryStoreError('history_invalid');
        record.chunks.push(bytes);
        record.response.rawBodyBytes = offset;
      } else if (item.kind === 'sse_event') {
        const value = item.event as Record<string, unknown>;
        if (
          Number(value.ordinal) !== record.sseEvents.length + 1 ||
          !Number.isSafeInteger(Number(value.responseBodyOffset)) ||
          Number(value.responseBodyOffset) >
            Number(record.response?.rawBodyBytes ?? 0)
        ) throw new HistoryStoreError('history_invalid');
        record.sseEvents.push(
          structuredClone(item.event) as ProviderEvidenceSseEvent,
        );
      } else if (item.kind === 'parser_transition') {
        const value = item.transition as Record<string, unknown>;
        if (Number(value.ordinal) !== record.parserTransitions.length + 1) {
          throw new HistoryStoreError('history_invalid');
        }
        record.parserTransitions.push(
          structuredClone(item.transition) as ProviderEvidenceParserTransition,
        );
      }
    }
    if (records.size === 0 && runtimeEvents.length === 0) return undefined;
    const requests: ProviderEvidenceRequestRecord[] = [...records.values()]
      .sort((left, right) => Number(left.request.ordinal) - Number(right.request.ordinal))
      .map((record) => {
        const response = record.response;
        if (response !== undefined && record.chunks.length > 0) {
          const bytes = new Uint8Array(
            record.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
          );
          let offset = 0;
          for (const chunk of record.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          response.rawBodyBase64 = bytes.toBase64();
          // Preserve exact bytes without claiming arbitrary binary is text.
          try {
            response.rawBody = decoder.decode(bytes, { stream: false });
          } catch {
            // rawBodyBase64 remains the exact representation for non-UTF-8 responses.
          }
        }
        return {
          request: {
            ...record
              .request as unknown as ProviderEvidenceRequestRecord['request'],
            contextRequestOrdinal: Number(
              record.request.contextRequestOrdinal ?? record.request.ordinal,
            ),
          },
          ...(response === undefined ? {} : {
            response: response as unknown as ProviderEvidenceRequestRecord['response'],
          }),
          sseEvents: record.sseEvents,
          parserTransitions: record.parserTransitions,
        };
      });
    const evidence = {
      schemaVersion: 5,
      evidenceId: this.makeUuid(),
      sessionId: String(row.session_correlation),
      build: JSON.parse(String(row.build_json)),
      definition: JSON.parse(String(row.definition_json)),
      turnNumber: Number(row.turn),
      createdAt: String(row.created_at),
      requests,
      runtimeEvents,
      capture: 'partial',
      normalizedOutcome: settlement,
      settlement,
    } as ProviderEvidenceV5;
    if (!validateProviderEvidence(evidence)) {
      throw new HistoryStoreError('history_invalid');
    }
    return evidence;
  }

  private activeExecutionForSession(
    db: DatabaseSync,
    sessionId: string,
  ):
    | { readonly row: SqlRow; readonly settlement: 'interrupted' | 'unknown' }
    | undefined {
    const rows = db.prepare(`
      SELECT e.*, t.task_text
      FROM executions e JOIN tasks t ON t.task_id = e.task_id
      WHERE e.session_correlation = ? AND e.canonical_session_id = ? AND e.lifecycle = 'active'
    `).all(sessionId, sessionId) as SqlRow[];
    if (rows.length > 1) throw new HistoryStoreError('history_invalid');
    const row = rows[0];
    if (row === undefined) return undefined;
    const sent = db.prepare(`
      SELECT 1 FROM execution_observations
      WHERE execution_id = ? AND kind = 'turn_dispatch_sent' LIMIT 1
    `).get(String(row.execution_id));
    return { row, settlement: sent === undefined ? 'unknown' : 'interrupted' };
  }

  private async reconcileDetachedExecutions(): Promise<void> {
    const layout = await this.layout();
    const db = this.openSynchronousDatabase();
    let rows: SqlRow[];
    try {
      rows = db.prepare(`
        SELECT e.*, t.task_text FROM executions e JOIN tasks t ON t.task_id=e.task_id
        WHERE e.canonical_session_id IS NULL AND e.lifecycle='active'
      `).all() as SqlRow[];
    } finally {
      db.close();
    }
    for (const row of rows) {
      const id = String(row.execution_id);
      // This process already owns an admitted no-session execution. Its lock is
      // intentionally held until settlement, so initialization must not reconcile it.
      if (this.executionLocks.has(id)) continue;
      let lock: Lock | undefined;
      try {
        lock = await acquireLock(`${layout.locks}/.execution-${id}.lock`);
      } catch (error) {
        if (
          error instanceof SessionStoreError && error.code === 'session_busy'
        ) continue;
        throw error;
      }
      try {
        const check = this.openSynchronousDatabase();
        let current: SqlRow | undefined;
        try {
          current = check.prepare(`
            SELECT e.*, t.task_text FROM executions e JOIN tasks t ON t.task_id=e.task_id
            WHERE e.execution_id=? AND e.lifecycle='active'
          `).get(id) as SqlRow | undefined;
        } finally {
          check.close();
        }
        if (current === undefined) continue;
        const sentDb = this.openSynchronousDatabase();
        let sent: SqlRow | undefined;
        try {
          sent = sentDb.prepare(
            `SELECT 1 FROM execution_observations WHERE execution_id=? AND kind='turn_dispatch_sent' LIMIT 1`,
          ).get(id) as SqlRow | undefined;
        } finally {
          sentDb.close();
        }
        const settlement = sent === undefined ? 'unknown' : 'interrupted' as const;
        this.reconcileExecution({
          executionId: id,
          settlement,
        });
      } finally {
        lock.close();
      }
    }
  }

  commitCanonicalTurn(input: CanonicalTurnCommitInput): HistoryCaptureResult {
    const db = this.openSynchronousDatabase();
    try {
      const capture = this.transaction(db, () => {
        if (
          !UUID_V4.test(input.taskId) || !UUID_V4.test(input.executionId) ||
          (input.agent !== 'default' && input.agent !== 'planner') ||
          !isModelSelection(input.model) || !isBuildManifest(input.build) ||
          !validRevisionRef(input.definition) ||
          input.canonicalSessionId !== input.record.sessionId ||
          input.sessionCorrelation !== input.record.sessionId ||
          input.record.stateRevision !== input.baseStateRevision + 1 ||
          input.record.nextTurn !== input.turn + 1
        ) throw new HistoryStoreError('history_invalid');
        const prior = db.prepare(
          'SELECT state_revision FROM sessions WHERE session_id = ?',
        ).get(input.record.sessionId) as SqlRow | undefined;
        if (
          prior !== undefined &&
            Number(prior.state_revision) !== input.baseStateRevision ||
          prior === undefined && input.baseStateRevision !== 1
        ) throw new HistoryStoreError('history_invalid');
        const active = db.prepare(`
          SELECT task_id, session_correlation, turn, created_at, lifecycle, outcome,
            canonical_session_id, adoption, base_revision, agent, model_json, build_json, definition_json,
            manifest_json, instance_correlation, worker_generation
          FROM executions WHERE execution_id = ?
        `).get(input.executionId) as SqlRow | undefined;
        if (
          active === undefined || active.lifecycle !== 'active' ||
          active.outcome !== 'unknown' ||
          active.adoption !== 'non_canonical' ||
          active.task_id !== input.taskId ||
          active.canonical_session_id !== input.canonicalSessionId ||
          active.session_correlation !== input.sessionCorrelation ||
          Number(active.turn) !== input.turn ||
          active.created_at !== input.createdAt ||
          Number(active.base_revision) !== input.baseStateRevision ||
          active.agent !== input.agent ||
          active.model_json !== JSON.stringify(input.model) ||
          active.build_json !== JSON.stringify(input.build) ||
          active.definition_json !== JSON.stringify(input.definition) ||
          active.manifest_json !==
            (input.manifest === undefined ? null : JSON.stringify(input.manifest)) ||
          active.instance_correlation !== (input.instanceCorrelation ?? null) ||
          active.worker_generation !== (input.workerGeneration ?? null)
        ) throw new HistoryStoreError('history_invalid');
        this.writeOutcomeTx(db, input.executionId, input.outcome);
        this.writeRecord(db, input.record);
        db.prepare(`
          UPDATE executions SET canonical_session_id = ?, settled_at = ?, lifecycle = 'settled',
            outcome = 'completed', adoption = 'canonical', committed_revision = ?
          WHERE execution_id = ?
        `).run(
          input.record.sessionId,
          input.record.updatedAt,
          input.record.stateRevision,
          input.executionId,
        );
        const index = causalTranscriptIndex(input.record.transcript);
        const range = index?.turns.find((turn) => turn.turn === input.turn);
        const turnModel = input.record.turnModels.find((entry) => entry.turn === input.turn);
        const turnExecution = input.record.turnExecutions.find((entry) =>
          entry.turn === input.turn
        );
        if (
          range === undefined || turnModel === undefined ||
          turnExecution === undefined
        ) {
          throw new HistoryStoreError('history_invalid');
        }
        db.prepare(`
          INSERT INTO canonical_turns(
            session_id, turn, execution_id, committed_revision, committed_at,
            model_json, build_json, definition_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.record.sessionId,
          input.turn,
          input.executionId,
          input.record.stateRevision,
          input.record.updatedAt,
          JSON.stringify(turnModel.selection),
          JSON.stringify(turnExecution.build),
          JSON.stringify(turnExecution.definition),
        );
        if (
          JSON.stringify(input.outcome.transcript) !==
            JSON.stringify(input.record.transcript)
        ) throw new HistoryStoreError('history_invalid');
        this.writeProjection(db, input.executionId, input.recalledContext);
        if (
          input.agent !== input.record.agent ||
          JSON.stringify(input.model) !== JSON.stringify(turnModel.selection) ||
          JSON.stringify(input.build) !== JSON.stringify(turnExecution.build) ||
          JSON.stringify(input.definition) !==
            JSON.stringify(turnExecution.definition)
        ) throw new HistoryStoreError('history_invalid');
        const capture = this.writeCaptures(
          db,
          input.executionId,
          input,
          input.evidence,
          input.diagnostic,
        );
        let artifactCapture = 'unknown';
        if (input.artifactForCapture !== undefined) {
          const artifact = input.artifactForCapture(capture);
          if (
            !validateWorkerExecutionArtifact(artifact) ||
            artifact.schemaVersion !== 7 ||
            !this.artifactMatchesInput(artifact, input) ||
            artifact.storeResult !== 'committed' ||
            artifact.committedStateRevision !== input.record.stateRevision ||
            artifact.acknowledgement !== 'not_sent' ||
            artifact.settlement !== 'committed_observation_pending'
          ) throw new HistoryStoreError('history_invalid');
          this.writeArtifactTx(db, artifact);
          artifactCapture = 'pending_observation';
        }
        db.prepare(`
          UPDATE executions SET evidence_capture = ?, diagnostic_capture = ?,
            artifact_capture = ?, context_capture = ?
          WHERE execution_id = ?
        `).run(
          capture.evidenceDurability ?? 'unknown',
          capture.diagnosticPersistenceError ?? capture.diagnosticDurability ??
            'unknown',
          artifactCapture,
          capture.contextDurability ?? 'none',
          input.executionId,
        );
        // Settlement is itself an observation. It is intentionally appended after the
        // canonical transaction's domain rows are present and never drives transcript replay.
        db.prepare(`
          INSERT INTO execution_observations(
            execution_id, ordinal, observed_at, direction, source, kind, worker_sequence, payload_json
          ) SELECT execution_id, coalesce(max(ordinal), 0) + 1, ?, 'host_to_worker', 'host',
            'execution_settled', NULL, ? FROM execution_observations WHERE execution_id = ?
        `).run(
          input.record.updatedAt,
          JSON.stringify({ outcome: 'completed', adoption: 'canonical' }),
          input.executionId,
        );
        return capture;
      });
      // Release only after SQLite has durably committed the settled row and journal event.
      this.releaseExecutionLock(input.executionId);
      return capture;
    } finally {
      db.close();
    }
  }

  settleNonCanonicalExecution(
    input: NonCanonicalExecutionInput,
  ): HistoryCaptureResult {
    const db = this.openSynchronousDatabase();
    try {
      const capture = this.transaction(db, () => {
        if (
          !UUID_V4.test(input.taskId) || !UUID_V4.test(input.executionId) ||
          (input.agent !== 'default' && input.agent !== 'planner') ||
          !isModelSelection(input.model) || !isBuildManifest(input.build) ||
          !validRevisionRef(input.definition)
        ) {
          throw new HistoryStoreError('history_invalid');
        }
        const active = db.prepare(`
          SELECT task_id, canonical_session_id, session_correlation, turn, created_at, lifecycle,
            outcome, adoption, base_revision, agent, model_json, build_json, definition_json,
            manifest_json, instance_correlation, worker_generation
          FROM executions WHERE execution_id = ?
        `).get(input.executionId) as SqlRow | undefined;
        const admitted = active;
        if (
          admitted === undefined || admitted.lifecycle !== 'active' ||
          admitted.outcome !== 'unknown' ||
          admitted.adoption !== 'non_canonical' ||
          admitted.task_id !== input.taskId ||
          admitted.canonical_session_id !==
            (input.canonicalSessionId ?? null) ||
          admitted.session_correlation !== input.sessionCorrelation ||
          Number(admitted.turn) !== input.turn ||
          admitted.created_at !== input.createdAt ||
          Number(admitted.base_revision) !== input.baseStateRevision ||
          admitted.agent !== input.agent ||
          admitted.model_json !== JSON.stringify(input.model) ||
          admitted.build_json !== JSON.stringify(input.build) ||
          admitted.definition_json !== JSON.stringify(input.definition) ||
          admitted.manifest_json !==
            (input.manifest === undefined ? null : JSON.stringify(input.manifest)) ||
          admitted.instance_correlation !==
            (input.instanceCorrelation ?? null) ||
          admitted.worker_generation !== (input.workerGeneration ?? null)
        ) throw new HistoryStoreError('history_invalid');
        const settledAt = new Date().toISOString();
        this.writeOutcomeTx(db, input.executionId, input.outcome);
        db.prepare(`
          UPDATE executions SET settled_at = ?, lifecycle = 'settled', outcome = ?,
            adoption = 'non_canonical' WHERE execution_id = ?
        `).run(
          settledAt,
          normalizedOutcome(input.outcome),
          input.executionId,
        );
        this.writeProjection(db, input.executionId, input.recalledContext);
        const capture = this.writeCaptures(
          db,
          input.executionId,
          input,
          input.evidence,
          input.diagnostic,
        );
        db.prepare(`
          UPDATE executions SET evidence_capture = ?, diagnostic_capture = ?, context_capture = ?
          WHERE execution_id = ?
        `).run(
          capture.evidenceDurability ?? 'unknown',
          capture.diagnosticPersistenceError ?? capture.diagnosticDurability ??
            'unknown',
          capture.contextDurability ?? 'none',
          input.executionId,
        );
        if (input.artifactForCapture !== undefined) {
          const artifact = input.artifactForCapture(capture);
          if (
            !validateWorkerExecutionArtifact(artifact) ||
            artifact.schemaVersion !== 7 ||
            !this.artifactMatchesInput(artifact, input)
          ) throw new HistoryStoreError('history_invalid');
          this.writeArtifactTx(db, artifact);
          db.prepare(`
            UPDATE executions SET settled_at = ?, acknowledgement = ?,
              generation_availability = ?, artifact_capture = 'yes', context_capture = ?
            WHERE execution_id = ?
          `).run(
            artifact.settledAt,
            artifact.acknowledgement,
            artifact.settlement === 'committed'
              ? 'available'
              : artifact.settlement === 'committed_generation_unavailable'
              ? 'unavailable'
              : 'unknown',
            artifact.contextCapture,
            artifact.executionId,
          );
        }
        if (input.artifactForCapture === undefined) {
          db.prepare(`
            UPDATE executions SET settled_at = ? WHERE execution_id = ?
          `).run(settledAt, input.executionId);
        }
        db.prepare(`
          INSERT INTO execution_observations(
            execution_id, ordinal, observed_at, direction, source, kind, worker_sequence, payload_json
          ) SELECT execution_id, coalesce(max(ordinal), 0) + 1, ?, 'host_to_worker', 'host',
            'execution_settled', NULL, ? FROM execution_observations WHERE execution_id = ?
        `).run(
          settledAt,
          JSON.stringify({
            outcome: normalizedOutcome(input.outcome),
            adoption: 'non_canonical',
          }),
          input.executionId,
        );
        return capture;
      });
      // Release only after SQLite has durably committed the settled row and journal event.
      this.releaseExecutionLock(input.executionId);
      return capture;
    } finally {
      db.close();
    }
  }

  private humanExecutionSelect(where: string, order: string): string {
    return `
      SELECT e.execution_id, e.task_id, t.task_text, e.canonical_session_id,
        e.session_correlation, e.turn, e.created_at, e.settled_at, e.lifecycle,
        e.outcome, e.adoption, e.base_revision, e.committed_revision, e.agent,
        e.model_json, e.build_json, e.definition_json, e.manifest_json,
        e.instance_correlation, e.worker_generation,
        e.acknowledgement,
        (SELECT evidence_id FROM provider_evidence WHERE execution_id = e.execution_id
          ORDER BY created_at, evidence_id LIMIT 1) AS provider_evidence_id,
        e.generation_availability, e.evidence_capture, e.diagnostic_capture,
        e.artifact_capture, e.context_capture
      FROM executions e JOIN tasks t ON t.task_id = e.task_id
      WHERE ${where} ORDER BY ${order} LIMIT ?
    `;
  }

  private humanExecutionRowsTx(
    db: DatabaseSync,
    request: HumanHistoryPageRequest,
  ): StoredExecutionRow[] {
    if (!UUID_V4.test(request.sessionId)) {
      throw new HistoryStoreError('history_invalid');
    }
    const session = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?')
      .get(
        request.sessionId,
      );
    if (session === undefined) {
      throw new HistoryStoreError('history_io_failure');
    }
    try {
      this.readRecord(db, request.sessionId);
    } catch {
      throw new HistoryStoreError('history_invalid');
    }
    const limit = request.executionLimit ?? HUMAN_HISTORY_PAGE_EXECUTIONS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) {
      throw new HistoryStoreError('history_invalid');
    }
    const cursor = decodeHumanCursor(request.cursor);
    if (
      (request.direction === 'older' || request.direction === 'newer') &&
      cursor === undefined
    ) throw new HistoryStoreError('history_invalid');
    let rows: SqlRow[];
    if (request.direction === 'latest') {
      rows = db.prepare(this.humanExecutionSelect(
        'e.session_correlation = ?',
        'e.turn DESC, e.created_at DESC, e.execution_id DESC',
      )).all(request.sessionId, limit) as SqlRow[];
      rows.reverse();
    } else if (request.direction === 'oldest') {
      rows = db.prepare(this.humanExecutionSelect(
        'e.session_correlation = ?',
        'e.turn, e.created_at, e.execution_id',
      )).all(request.sessionId, limit) as SqlRow[];
    } else if (request.direction === 'older') {
      rows = db.prepare(this.humanExecutionSelect(
        `e.session_correlation = ? AND
          (e.turn < ? OR (e.turn = ? AND e.created_at < ?) OR
           (e.turn = ? AND e.created_at = ? AND e.execution_id < ?))`,
        'e.turn DESC, e.created_at DESC, e.execution_id DESC',
      )).all(
        request.sessionId,
        cursor!.turn,
        cursor!.turn,
        cursor!.createdAt,
        cursor!.turn,
        cursor!.createdAt,
        cursor!.executionId,
        limit,
      ) as SqlRow[];
      rows.reverse();
    } else {
      rows = db.prepare(this.humanExecutionSelect(
        `e.session_correlation = ? AND
          (e.turn > ? OR (e.turn = ? AND e.created_at > ?) OR
           (e.turn = ? AND e.created_at = ? AND e.execution_id > ?))`,
        'e.turn, e.created_at, e.execution_id',
      )).all(
        request.sessionId,
        cursor!.turn,
        cursor!.turn,
        cursor!.createdAt,
        cursor!.turn,
        cursor!.createdAt,
        cursor!.executionId,
        limit,
      ) as SqlRow[];
    }
    return rows.map((row) => this.executionFromRow(db, row));
  }

  private humanEventsTx(
    db: DatabaseSync,
    executionId: string,
  ): StoredExecutionEvent[] {
    return (db.prepare(`
      SELECT r.execution_id, r.observation_ordinal AS ordinal,
        o.observed_at, o.direction, o.source, o.kind, o.worker_sequence,
        r.event_json
      FROM runtime_occurrences r
      JOIN execution_observations o
        ON o.execution_id = r.execution_id AND o.ordinal = r.observation_ordinal
      WHERE r.execution_id = ? ORDER BY r.observation_ordinal
    `).all(executionId) as SqlRow[]).map((row) => {
      let payload: JsonValue;
      try {
        payload = JSON.parse(String(row.event_json));
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
      if (!isJsonValue(payload)) throw new HistoryStoreError('history_invalid');
      const event = {
        executionId: String(row.execution_id),
        ordinal: Number(row.ordinal),
        observedAt: String(row.observed_at),
        direction: row.direction as StoredExecutionEvent['direction'],
        source: row.source as StoredExecutionEvent['source'],
        kind: row.kind as StoredExecutionEvent['kind'],
        ...(row.worker_sequence === null ? {} : { workerSequence: Number(row.worker_sequence) }),
        payload,
      } as StoredExecutionEvent;
      if (event.executionId !== executionId) {
        throw new HistoryStoreError('history_invalid');
      }
      return event;
    });
  }

  private humanEffectsTx(
    db: DatabaseSync,
    executionId: string,
  ): StoredExecutionEffect[] {
    return (db.prepare(`
      SELECT execution_id, call_id, name, requested_event_ordinal,
        progress_event_ordinal, completed_event_ordinal, result_outcome, status
      FROM execution_effects WHERE execution_id = ? ORDER BY call_id
    `).all(executionId) as SqlRow[]).map((row) => ({
      executionId: String(row.execution_id),
      callId: String(row.call_id),
      name: String(row.name),
      ...(row.requested_event_ordinal === null
        ? {}
        : { requestedEventOrdinal: Number(row.requested_event_ordinal) }),
      ...(row.progress_event_ordinal === null
        ? {}
        : { progressEventOrdinal: Number(row.progress_event_ordinal) }),
      ...(row.completed_event_ordinal === null
        ? {}
        : { completedEventOrdinal: Number(row.completed_event_ordinal) }),
      ...(row.result_outcome === null
        ? {}
        : { resultOutcome: row.result_outcome as 'success' | 'error' }),
      status: row.status as StoredExecutionEffect['status'],
    }));
  }

  private humanProjectionInputTx(
    db: DatabaseSync,
    execution: StoredExecutionRow,
  ): HumanHistoryProjectionInput {
    const attempt = Number(
      (db.prepare(`
      SELECT count(*) AS count FROM executions
      WHERE session_correlation = ? AND turn = ? AND
        (created_at < ? OR (created_at = ? AND execution_id <= ?))
    `).get(
          execution.sessionCorrelation,
          execution.turn,
          execution.createdAt,
          execution.createdAt,
          execution.executionId,
        ) as SqlRow).count,
    );
    const canonicalMessages = (db.prepare(`
      SELECT m.execution_id, m.ordinal, m.source_kind,
        m.source_observation_ordinals_json,
        m.content_digest, t.task_text
      FROM execution_messages m JOIN executions e
        ON e.execution_id = m.execution_id
      JOIN tasks t ON t.task_id = e.task_id
      WHERE m.execution_id = ? AND EXISTS (
        SELECT 1 FROM canonical_turns WHERE execution_id = ?
      ) ORDER BY m.ordinal
    `).all(execution.executionId, execution.executionId) as SqlRow[]).map((
      row,
    ) => ({
      ordinal: Number(row.ordinal),
      message: this.messageFromRow(db, row),
    }));
    const projectionRow = db.prepare(`
      SELECT projection_kind, source_execution_id, projected_text, link_status
      FROM execution_projections WHERE execution_id = ?
    `).get(execution.executionId) as SqlRow | undefined;
    const context = (db.prepare(`
      SELECT ordinal, stage, resource_kind, logical_identity, source_locator,
        content_digest, lane, model_step, call_id, request_ordinal,
        source_event_ordinal
      FROM execution_context_relations
      WHERE execution_id = ? ORDER BY ordinal
    `).all(execution.executionId) as SqlRow[]).map((row) => ({
      ordinal: Number(row.ordinal),
      stage: row.stage as ExecutionContextRelation['stage'],
      resourceKind: row
        .resource_kind as ExecutionContextRelation['resourceKind'],
      ...(row.logical_identity === null ? {} : { logicalIdentity: String(row.logical_identity) }),
      ...(row.source_locator === null ? {} : { sourceLocator: String(row.source_locator) }),
      ...(row.content_digest === null ? {} : { contentDigest: String(row.content_digest) }),
      ...(row.lane === null ? {} : { lane: row.lane as 'parent' | 'planner' }),
      ...(row.model_step === null ? {} : { modelStep: Number(row.model_step) }),
      ...(row.call_id === null ? {} : { callId: String(row.call_id) }),
      ...(row.request_ordinal === null ? {} : { requestOrdinal: Number(row.request_ordinal) }),
      ...(row.source_event_ordinal === null
        ? {}
        : { sourceEventOrdinal: Number(row.source_event_ordinal) }),
    }));
    const requests = (db.prepare(`
      SELECT request_ordinal, lane, purpose, model_step, model_selection_json
      FROM model_requests WHERE execution_id = ? ORDER BY request_ordinal
    `).all(execution.executionId) as SqlRow[]).map((row) => ({
      requestOrdinal: Number(row.request_ordinal),
      lane: row.lane as 'parent' | 'planner',
      purpose: row.purpose as ContextRequestPurpose,
      modelStep: Number(row.model_step),
      ...(row.model_selection_json === null ? {} : {
        modelSelection: JSON.parse(
          String(row.model_selection_json),
        ) as ModelSelection,
      }),
    }));
    const ids = (table: string, column: string): string[] =>
      (db.prepare(
        `SELECT ${column} AS id FROM ${table} WHERE execution_id = ? ORDER BY ${column}`,
      )
        .all(execution.executionId) as SqlRow[]).map((row) => String(row.id));
    return {
      execution,
      attempt,
      canonicalMessages,
      events: this.humanEventsTx(db, execution.executionId),
      effects: this.humanEffectsTx(db, execution.executionId),
      ...(projectionRow === undefined ? {} : {
        projection: {
          kind: String(projectionRow.projection_kind),
          sourceExecutionId: String(projectionRow.source_execution_id),
          text: String(projectionRow.projected_text),
          status: String(projectionRow.link_status),
        },
      }),
      context,
      requests,
      evidenceIds: ids('provider_evidence', 'evidence_id'),
      diagnosticIds: ids('failure_diagnostics', 'diagnostic_id'),
      artifactIds: ids('execution_artifacts', 'artifact_id'),
    };
  }

  private humanPageTx(
    db: DatabaseSync,
    request: HumanHistoryPageRequest,
  ): HumanHistoryPageV1 {
    const executions = this.humanExecutionRowsTx(db, request);
    const entries = executions.flatMap((execution) =>
      projectHumanHistoryExecution(this.humanProjectionInputTx(db, execution))
    );
    const first = executions.at(0);
    const last = executions.at(-1);
    const existsBefore = first === undefined ? false : db.prepare(`
      SELECT 1 FROM executions WHERE session_correlation = ? AND
        (turn < ? OR (turn = ? AND created_at < ?) OR
         (turn = ? AND created_at = ? AND execution_id < ?)) LIMIT 1
    `).get(
      request.sessionId,
      first.turn,
      first.turn,
      first.createdAt,
      first.turn,
      first.createdAt,
      first.executionId,
    ) !== undefined;
    const existsAfter = last === undefined ? false : db.prepare(`
      SELECT 1 FROM executions WHERE session_correlation = ? AND
        (turn > ? OR (turn = ? AND created_at > ?) OR
         (turn = ? AND created_at = ? AND execution_id > ?)) LIMIT 1
    `).get(
      request.sessionId,
      last.turn,
      last.turn,
      last.createdAt,
      last.turn,
      last.createdAt,
      last.executionId,
    ) !== undefined;
    return Object.freeze({
      schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
      sessionId: request.sessionId,
      entries: Object.freeze(entries),
      executionCount: executions.length,
      ...(existsBefore && first !== undefined
        ? { olderCursor: encodeHumanCursor(humanCursorFor(first)) }
        : {}),
      ...(existsAfter && last !== undefined
        ? { newerCursor: encodeHumanCursor(humanCursorFor(last)) }
        : {}),
      atOldest: !existsBefore,
      atNewest: !existsAfter,
    });
  }

  readHumanHistoryPage(request: HumanHistoryPageRequest): HumanHistoryPageV1 {
    const db = this.openSynchronousDatabase();
    try {
      db.exec('BEGIN DEFERRED');
      const page = this.humanPageTx(db, request);
      db.exec('COMMIT');
      return page;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the read failure.
      }
      throw historyError(error);
    } finally {
      db.close();
    }
  }

  private humanDetailTextTx(
    db: DatabaseSync,
    sessionId: string,
    detailId: string,
  ): { readonly title: string; readonly text: string } {
    const parts = detailId.split(':');
    const executionId = parts[1];
    if (
      !UUID_V4.test(sessionId) || executionId === undefined ||
      !UUID_V4.test(executionId)
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    const belongs = db.prepare(
      'SELECT 1 FROM executions WHERE execution_id = ? AND session_correlation = ?',
    ).get(executionId, sessionId);
    if (belongs === undefined) {
      throw new HistoryStoreError('history_io_failure');
    }
    const exactJson = (title: string, row: SqlRow | undefined) => {
      if (row === undefined) throw new HistoryStoreError('history_io_failure');
      const value = Object.fromEntries(
        Object.entries(row).map(([key, item]) => [
          key,
          item instanceof Uint8Array
            ? { byteLength: item.byteLength, bytesBase64: uint8ToBase64(item) }
            : item,
        ]),
      );
      return { title, text: JSON.stringify(value, null, 2) };
    };
    if (parts[0] === 'execution') {
      return exactJson(
        'execution',
        db.prepare(`
        SELECT e.*, t.task_text FROM executions e JOIN tasks t ON t.task_id = e.task_id
        WHERE e.execution_id = ?
      `).get(executionId) as SqlRow | undefined,
      );
    }
    if (parts[0] === 'task') {
      const row = db.prepare(
        'SELECT task_text FROM tasks WHERE task_id = (SELECT task_id FROM executions WHERE execution_id = ?)',
      )
        .get(executionId) as SqlRow | undefined;
      if (row === undefined) throw new HistoryStoreError('history_io_failure');
      return { title: 'task', text: String(row.task_text) };
    }
    if (parts[0] === 'message') {
      const ordinal = Number(parts[2]);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
        throw new HistoryStoreError('history_invalid');
      }
      const row = db.prepare(`
        SELECT m.execution_id, m.ordinal, m.session_ordinal, m.source_kind,
          m.source_observation_ordinals_json, m.content_digest, t.task_text
        FROM execution_messages m JOIN executions e ON e.execution_id = m.execution_id
        JOIN tasks t ON t.task_id = e.task_id
        WHERE m.execution_id = ? AND m.ordinal = ?
      `).get(executionId, ordinal) as SqlRow | undefined;
      if (row === undefined) throw new HistoryStoreError('history_io_failure');
      return exactJson('canonical message', {
        execution_id: row.execution_id,
        ordinal: row.ordinal,
        session_ordinal: row.session_ordinal,
        source_kind: row.source_kind,
        source_observation_ordinals_json: row.source_observation_ordinals_json,
        content_digest: row.content_digest,
        message: this.messageFromRow(db, row) as unknown as JsonValue,
      });
    }
    if (parts[0] === 'event') {
      const ordinal = Number(parts[2]);
      if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
        throw new HistoryStoreError('history_invalid');
      }
      const row = db.prepare(`
        SELECT execution_id, ordinal, observed_at, direction, source, kind,
          worker_sequence, payload_json FROM execution_observations
        WHERE execution_id = ? AND ordinal = ?
      `).get(executionId, ordinal) as SqlRow | undefined;
      if (row === undefined) throw new HistoryStoreError('history_io_failure');
      return exactJson('execution event', {
        execution_id: row.execution_id,
        ordinal: row.ordinal,
        observed_at: row.observed_at,
        direction: row.direction,
        source: row.source,
        kind: row.kind,
        worker_sequence: row.worker_sequence,
        payload: this.eventPayloadTx(db, row),
      });
    }
    if (parts[0] === 'effect') {
      return exactJson(
        'tool effect',
        db.prepare(`
        SELECT * FROM execution_effects WHERE execution_id = ? AND call_id = ?
      `).get(executionId, parts.slice(2).join(':')) as SqlRow | undefined,
      );
    }
    if (parts[0] === 'projection') {
      return exactJson(
        'execution projection',
        db.prepare(`
        SELECT * FROM execution_projections WHERE execution_id = ?
      `).get(executionId) as SqlRow | undefined,
      );
    }
    if (parts[0] === 'context') {
      const ordinal = Number(parts[2]);
      const row = db.prepare(`
        SELECT r.*, b.byte_length, b.raw_bytes FROM execution_context_relations r
        LEFT JOIN context_blobs b ON b.digest = r.content_digest
        WHERE r.execution_id = ? AND r.ordinal = ?
      `).get(executionId, ordinal) as SqlRow | undefined;
      if (row?.content_digest !== null && row?.content_digest !== undefined) {
        this.readContextBlobTx(db, String(row.content_digest));
      }
      return exactJson('context relation', row);
    }
    if (parts[0] === 'request') {
      const ordinal = Number(parts[2]);
      const request = this.readExecutionRequestV5Tx(db, executionId, ordinal);
      return {
        title: `model request ${ordinal}`,
        text: JSON.stringify(request, null, 2),
      };
    }
    const id = parts.slice(2).join(':');
    if (parts[0] === 'evidence') {
      const row = db.prepare(`
        SELECT * FROM provider_evidence WHERE execution_id = ? AND evidence_id = ?
      `).get(executionId, id) as SqlRow | undefined;
      if (row === undefined) throw new HistoryStoreError('history_io_failure');
      try {
        return {
          title: 'provider evidence',
          text: JSON.stringify(this.evidenceFromRow(db, row), null, 2),
        };
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
    }
    if (parts[0] === 'diagnostic') {
      const row = db.prepare(`
        SELECT diagnostic_id, execution_id, occurred_at, payload_bytes, diagnostic_json, link_status
        FROM failure_diagnostics WHERE execution_id = ? AND diagnostic_id = ?
      `).get(executionId, id) as SqlRow | undefined;
      if (row === undefined) throw new HistoryStoreError('history_io_failure');
      try {
        this.diagnosticFromRow(row);
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
      return exactJson('failure diagnostic', row);
    }
    if (parts[0] === 'artifact') {
      const row = db.prepare(`
        SELECT * FROM execution_artifacts WHERE execution_id = ? AND artifact_id = ?
      `).get(executionId, id) as SqlRow | undefined;
      if (row === undefined) throw new HistoryStoreError('history_io_failure');
      try {
        return {
          title: 'execution artifact',
          text: JSON.stringify(this.artifactFromRow(db, row), null, 2),
        };
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
    }
    throw new HistoryStoreError('history_invalid');
  }

  readHumanHistoryDetail(
    sessionId: string,
    detailId: string,
    scalarOffset = 0,
  ): HumanHistoryDetailChunkV1 {
    if (!Number.isSafeInteger(scalarOffset) || scalarOffset < 0) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.openSynchronousDatabase();
    try {
      db.exec('BEGIN DEFERRED');
      const value = this.humanDetailTextTx(db, sessionId, detailId);
      const chunk = chunkHumanHistoryDetail(
        sessionId,
        detailId,
        value.title,
        value.text,
        scalarOffset,
      );
      db.exec('COMMIT');
      return chunk;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the read failure.
      }
      throw historyError(error);
    } finally {
      db.close();
    }
  }

  private humanHistorySearchHit(
    request: HumanHistorySearchRequest,
    page: HumanHistoryPageV1,
    candidate: HumanHistoryEntryV1,
    sourceOffsets: readonly number[],
    sourceScalarOffset: number,
  ): HumanHistorySearchHitV1 | undefined {
    const queryLength = [...request.query].length;
    const preview = [...candidate.text];
    const visibleScalars = candidate.text.endsWith('…') ? preview.length - 1 : preview.length;
    if (sourceScalarOffset + queryLength <= visibleScalars) {
      return Object.freeze({
        schemaVersion: 1,
        sessionId: request.sessionId,
        query: request.query,
        entryId: candidate.id,
        detailId: candidate.detailId,
        sourceScalarOffset,
        wrapped: false,
        page,
      });
    }

    const db = this.openSynchronousDatabase();
    try {
      db.exec('BEGIN DEFERRED');
      const exact = this.humanDetailTextTx(
        db,
        request.sessionId,
        candidate.detailId,
      );
      const exactOffsets = scalarMatchOffsets(exact.text, request.query);
      const occurrence = sourceOffsets.indexOf(sourceScalarOffset);
      const detailMatchScalarOffset = exactOffsets[occurrence] ??
        (request.direction === 'next' ? exactOffsets.at(0) : exactOffsets.at(-1));
      if (detailMatchScalarOffset === undefined) {
        db.exec('COMMIT');
        return undefined;
      }
      const scalarOffset = Math.floor(
        detailMatchScalarOffset / HUMAN_HISTORY_DETAIL_SCALARS,
      ) * HUMAN_HISTORY_DETAIL_SCALARS;
      const detail = chunkHumanHistoryDetail(
        request.sessionId,
        candidate.detailId,
        exact.title,
        exact.text,
        scalarOffset,
      );
      db.exec('COMMIT');
      return Object.freeze({
        schemaVersion: 1,
        sessionId: request.sessionId,
        query: request.query,
        entryId: candidate.id,
        detailId: candidate.detailId,
        sourceScalarOffset,
        detail,
        detailMatchScalarOffset,
        wrapped: false,
        page,
      });
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the read failure.
      }
      throw historyError(error);
    } finally {
      db.close();
    }
  }

  searchHumanHistory(
    request: HumanHistorySearchRequest,
  ): HumanHistorySearchHitV1 | undefined {
    if (
      request.query.length === 0 || request.query.includes('\0') ||
      (request.fromSourceScalarOffset !== undefined &&
        (!Number.isSafeInteger(request.fromSourceScalarOffset) ||
          request.fromSourceScalarOffset < 0)) ||
      (request.fromSourceScalarOffset !== undefined &&
        request.fromEntryId === undefined)
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    const forward = request.direction === 'next';
    let page = this.readHumanHistoryPage({
      sessionId: request.sessionId,
      direction: forward ? 'oldest' : 'latest',
    });
    let passedOrigin = request.fromEntryId === undefined;
    let wrapped: HumanHistorySearchHitV1 | undefined;
    while (true) {
      const ordered = forward ? page.entries : [...page.entries].reverse();
      for (const candidate of ordered) {
        const sourceOffsets = scalarMatchOffsets(
          candidate.searchText,
          request.query,
        );
        const offsets = forward ? sourceOffsets : [...sourceOffsets].reverse();
        for (const offset of offsets) {
          const hit = this.humanHistorySearchHit(
            request,
            page,
            candidate,
            sourceOffsets,
            offset,
          );
          if (hit === undefined) continue;
          wrapped ??= hit;
          if (candidate.id === request.fromEntryId) {
            const origin = request.fromSourceScalarOffset;
            if (
              origin !== undefined &&
              (forward ? offset > origin : offset < origin)
            ) return hit;
          } else if (passedOrigin) return hit;
        }
        if (candidate.id === request.fromEntryId) passedOrigin = true;
      }
      const cursor = forward ? page.newerCursor : page.olderCursor;
      if (cursor === undefined) break;
      page = this.readHumanHistoryPage({
        sessionId: request.sessionId,
        direction: forward ? 'newer' : 'older',
        cursor,
      });
    }
    return wrapped === undefined ? undefined : Object.freeze({ ...wrapped, wrapped: true });
  }

  *streamHumanHistoryExport(
    sessionId: string,
  ): Iterable<HumanHistoryExportRecordV1> {
    if (!UUID_V4.test(sessionId)) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.openSynchronousDatabase();
    const record = (
      kind: string,
      identity: string,
      value: JsonValue,
    ): HumanHistoryExportRecordV1 => Object.freeze({ schemaVersion: 1, kind, identity, value });
    try {
      db.exec('BEGIN DEFERRED');
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?')
        .get(sessionId) as
          | SqlRow
          | undefined;
      if (session === undefined) {
        throw new HistoryStoreError('history_io_failure');
      }
      try {
        this.readRecord(db, sessionId);
      } catch {
        throw new HistoryStoreError('history_invalid');
      }
      const tail = db.prepare(`
        SELECT turn, created_at, execution_id FROM executions
        WHERE session_correlation = ? ORDER BY turn DESC, created_at DESC, execution_id DESC LIMIT 1
      `).get(sessionId) as SqlRow | undefined;
      yield record('header', `session:${sessionId}`, {
        exportSchemaVersion: 1,
        storeSchemaVersion: SCHEMA_VERSION,
        sessionId,
        stateRevision: Number(session.state_revision),
        tail: tail === undefined ? null : {
          turn: Number(tail.turn),
          createdAt: String(tail.created_at),
          executionId: String(tail.execution_id),
        },
      });
      const jsonRow = (row: SqlRow): JsonValue =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof Uint8Array
              ? {
                byteLength: value.byteLength,
                bytesBase64: uint8ToBase64(value),
              }
              : value,
          ]),
        ) as JsonValue;
      yield record('session', `session:${sessionId}`, jsonRow(session));
      const simple = function* (
        kind: string,
        identity: (row: SqlRow) => string,
        rows: Iterable<SqlRow>,
      ): Generator<HumanHistoryExportRecordV1> {
        for (const row of rows) yield record(kind, identity(row), jsonRow(row));
      };
      yield* simple(
        'store_metadata',
        () => 'store-metadata',
        db.prepare('SELECT * FROM store_metadata WHERE singleton = 1')
          .iterate() as Iterable<
            SqlRow
          >,
      );
      yield* simple(
        'session_model_change',
        (row) => `model-change:${sessionId}:${row.ordinal}`,
        db.prepare(`SELECT * FROM session_model_changes
          WHERE session_id = ? ORDER BY ordinal`).iterate(
          sessionId,
        ) as Iterable<SqlRow>,
      );
      yield* simple(
        'semantic_checkpoint',
        () => `checkpoint:${sessionId}`,
        db.prepare('SELECT * FROM semantic_checkpoints WHERE session_id = ?')
          .iterate(sessionId) as Iterable<SqlRow>,
      );
      yield* simple(
        'canonical_turn',
        (row) => `turn:${row.turn}`,
        db.prepare(`
        SELECT * FROM canonical_turns WHERE session_id = ? ORDER BY turn
      `).iterate(sessionId) as Iterable<SqlRow>,
      );
      const executions = db.prepare(`
        SELECT e.* FROM executions e WHERE e.session_correlation = ?
        ORDER BY e.turn, e.created_at, e.execution_id
      `).iterate(sessionId) as Iterable<SqlRow>;
      const digests = new Set<string>();
      const workerGenerations = new Set<string>();
      for (const execution of executions) {
        const executionId = String(execution.execution_id);
        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?')
          .get(String(execution.task_id)) as SqlRow | undefined;
        if (task === undefined) throw new HistoryStoreError('history_invalid');
        yield record('task', `task:${task.task_id}`, jsonRow(task));
        yield record(
          'execution',
          `execution:${executionId}`,
          jsonRow(execution),
        );
        if (execution.worker_generation !== null) {
          workerGenerations.add(String(execution.worker_generation));
        }
        const sources: readonly [
          string,
          string,
          string,
          (row: SqlRow) => string,
        ][] = [
          [
            'execution_outcome',
            'SELECT * FROM execution_outcomes WHERE execution_id = ?',
            'execution_id',
            () => `outcome:${executionId}`,
          ],
          [
            'execution_message',
            'SELECT * FROM execution_messages WHERE execution_id = ? ORDER BY ordinal',
            'ordinal',
            (row) => `message:${executionId}:${row.ordinal}`,
          ],
          [
            'event',
            'SELECT * FROM execution_observations WHERE execution_id = ? ORDER BY ordinal',
            'ordinal',
            (row) => `event:${executionId}:${row.ordinal}`,
          ],
          [
            'runtime_occurrence',
            'SELECT * FROM runtime_occurrences WHERE execution_id = ? ORDER BY observation_ordinal',
            'observation_ordinal',
            (row) => `runtime:${executionId}:${row.observation_ordinal}`,
          ],
          [
            'provider_observation_fact',
            'SELECT * FROM provider_observation_facts WHERE execution_id = ? ORDER BY observation_ordinal',
            'observation_ordinal',
            (row) => `provider:${executionId}:${row.observation_ordinal}`,
          ],
          [
            'progress_delta',
            'SELECT * FROM execution_progress_deltas WHERE execution_id = ? ORDER BY event_ordinal',
            'event_ordinal',
            (row) => `progress:${executionId}:${row.event_ordinal}`,
          ],
          [
            'effect',
            'SELECT * FROM execution_effects WHERE execution_id = ? ORDER BY call_id',
            'call_id',
            (row) => `effect:${executionId}:${row.call_id}`,
          ],
          [
            'projection',
            'SELECT * FROM execution_projections WHERE execution_id = ?',
            'execution_id',
            () => `projection:${executionId}`,
          ],
          [
            'context_relation',
            'SELECT * FROM execution_context_relations WHERE execution_id = ? ORDER BY ordinal',
            'ordinal',
            (row) => `context:${executionId}:${row.ordinal}`,
          ],
          [
            'model_request',
            'SELECT * FROM model_requests WHERE execution_id = ? ORDER BY request_ordinal',
            'request_ordinal',
            (row) => `request:${executionId}:${row.request_ordinal}`,
          ],
          [
            'context_occurrence',
            'SELECT * FROM context_occurrences WHERE execution_id = ? ORDER BY occurrence_id',
            'occurrence_id',
            (row) => `context-occurrence:${executionId}:${row.occurrence_id}`,
          ],
          [
            'context_occurrence_source',
            'SELECT * FROM context_occurrence_sources WHERE execution_id = ? ORDER BY occurrence_id, source_ordinal',
            'source_ordinal',
            (row) =>
              `context-occurrence-source:${executionId}:${row.occurrence_id}:${row.source_ordinal}`,
          ],
          [
            'context_sequence_revision',
            'SELECT * FROM context_sequence_revisions WHERE execution_id = ? ORDER BY revision_digest',
            'revision_digest',
            (row) => `context-revision:${executionId}:${row.revision_digest}`,
          ],
          [
            'context_sequence_splice',
            'SELECT * FROM context_sequence_splices WHERE execution_id = ? ORDER BY revision_digest, splice_ordinal',
            'splice_ordinal',
            (row) => `context-splice:${executionId}:${row.revision_digest}:${row.splice_ordinal}`,
          ],
          [
            'context_sequence_insertion',
            'SELECT * FROM context_sequence_insertions WHERE execution_id = ? ORDER BY revision_digest, splice_ordinal, insertion_ordinal',
            'insertion_ordinal',
            (row) =>
              `context-insertion:${executionId}:${row.revision_digest}:${row.splice_ordinal}:${row.insertion_ordinal}`,
          ],
          [
            'provider_request_context',
            'SELECT * FROM provider_request_contexts WHERE execution_id = ? ORDER BY provider_request_ordinal',
            'provider_request_ordinal',
            (row) => `provider-request-context:${executionId}:${row.provider_request_ordinal}`,
          ],
          [
            'context_tool_call',
            'SELECT * FROM context_tool_calls WHERE execution_id = ? ORDER BY call_id',
            'call_id',
            (row) => `context-tool-call:${executionId}:${row.call_id}`,
          ],
          [
            'provider_evidence',
            'SELECT * FROM provider_evidence WHERE execution_id = ? ORDER BY evidence_id',
            'evidence_id',
            (row) => `evidence:${row.evidence_id}`,
          ],
          [
            'failure_diagnostic',
            'SELECT * FROM failure_diagnostics WHERE execution_id = ? ORDER BY diagnostic_id',
            'diagnostic_id',
            (row) => `diagnostic:${row.diagnostic_id}`,
          ],
          [
            'execution_artifact',
            'SELECT * FROM execution_artifacts WHERE execution_id = ? ORDER BY artifact_id',
            'artifact_id',
            (row) => `artifact:${row.artifact_id}`,
          ],
          [
            'execution_artifact_trace_ref',
            `SELECT r.* FROM execution_artifact_trace r
             JOIN execution_artifacts a ON a.artifact_id = r.artifact_id
             WHERE a.execution_id = ? ORDER BY r.artifact_id, r.ordinal`,
            'ordinal',
            (row) => `artifact-trace:${row.artifact_id}:${row.ordinal}`,
          ],
        ];
        for (const [kind, sql, _key, identity] of sources) {
          for (
            const row of db.prepare(sql).iterate(executionId) as Iterable<
              SqlRow
            >
          ) {
            if (kind === 'context_relation' && row.content_digest !== null) {
              digests.add(String(row.content_digest));
            }
            if (kind === 'execution_message' && row.content_digest !== null) {
              digests.add(String(row.content_digest));
            }
            if (kind === 'context_occurrence') {
              digests.add(String(row.content_digest));
            }
            try {
              if (kind === 'provider_evidence') this.evidenceFromRow(db, row);
              else if (kind === 'failure_diagnostic') {
                this.diagnosticFromRow(row);
              } else if (kind === 'execution_artifact') {
                this.artifactFromRow(db, row);
              }
            } catch {
              throw new HistoryStoreError('history_invalid');
            }
            yield record(kind, identity(row), jsonRow(row));
          }
        }
        yield* simple(
          'diagnostic_evidence_link',
          (row) => `diagnostic-link:${row.diagnostic_id}:${row.evidence_id}`,
          db.prepare(`
            SELECT l.* FROM diagnostic_evidence_links l
            JOIN failure_diagnostics d ON d.diagnostic_id = l.diagnostic_id
            WHERE d.execution_id = ? ORDER BY l.diagnostic_id, l.evidence_id
          `).iterate(executionId) as Iterable<SqlRow>,
        );
      }
      for (const generationId of [...workerGenerations].sort()) {
        yield* simple(
          'worker_generation',
          (row) => `worker-generation:${row.worker_generation}`,
          db.prepare(
            'SELECT * FROM worker_generations WHERE worker_generation = ?',
          )
            .iterate(generationId) as Iterable<SqlRow>,
        );
        yield* simple(
          'worker_protocol_observation',
          (row) => `worker-observation:${generationId}:${row.observation_id}`,
          db.prepare(`SELECT * FROM worker_protocol_observations
            WHERE worker_generation = ? ORDER BY observation_id`).iterate(
            generationId,
          ) as Iterable<SqlRow>,
        );
      }
      for (const digest of [...digests].sort()) {
        const blob = db.prepare(
          'SELECT digest, byte_length, media_type, raw_bytes FROM context_blobs WHERE digest = ?',
        )
          .get(digest) as SqlRow | undefined;
        if (blob === undefined) throw new HistoryStoreError('history_invalid');
        yield record('context_blob', `content:${digest}`, jsonRow(blob));
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the read failure.
      }
      throw historyError(error);
    } finally {
      db.close();
    }
  }

  recordPostCommitObservation(artifact: StoredWorkerExecutionArtifact): void {
    if (
      !validateWorkerExecutionArtifact(artifact) || artifact.schemaVersion !== 7
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.openSynchronousDatabase();
    try {
      this.transaction(db, () => {
        const execution = db.prepare(`
          SELECT execution_id, session_correlation, turn, created_at, lifecycle, outcome, adoption,
            committed_revision, base_revision, agent,
            build_json, definition_json, manifest_json, instance_correlation, worker_generation
          FROM executions WHERE execution_id = ?
        `).get(artifact.executionId) as SqlRow | undefined;
        if (
          execution === undefined ||
          execution.lifecycle !== 'settled' ||
          execution.outcome !== artifact.normalizedOutcome ||
          execution.adoption !== artifact.adoption ||
          (artifact.adoption === 'canonical' &&
            Number(execution.committed_revision) !==
              artifact.committedStateRevision) ||
          execution.session_correlation !== artifact.sessionId ||
          Number(execution.turn) !== artifact.turn ||
          execution.created_at !== artifact.createdAt ||
          Number(execution.base_revision) !== artifact.baseStateRevision ||
          execution.agent !== artifact.agent ||
          execution.build_json !== JSON.stringify(artifact.build) ||
          execution.definition_json !== JSON.stringify(artifact.definition) ||
          execution.manifest_json !== JSON.stringify(artifact.manifest) ||
          execution.instance_correlation !== artifact.instanceCorrelation ||
          execution.worker_generation !== artifact.workerGeneration
        ) throw new HistoryStoreError('history_invalid');
        this.writeArtifactTx(db, artifact);
        db.prepare(`
          UPDATE executions SET settled_at = ?, acknowledgement = ?,
            generation_availability = ?, artifact_capture = 'yes', context_capture = ?
          WHERE execution_id = ?
        `).run(
          artifact.settledAt,
          artifact.acknowledgement,
          artifact.settlement === 'committed'
            ? 'available'
            : artifact.settlement === 'committed_generation_unavailable'
            ? 'unavailable'
            : 'unknown',
          artifact.contextCapture,
          artifact.executionId,
        );
      });
    } finally {
      db.close();
    }
  }

  private openSynchronousDatabase(): DatabaseSync {
    const path = this.databasePathSync();
    try {
      const db = new DatabaseSync(path);
      this.configureExisting(db);
      const version = Number(
        (db.prepare('PRAGMA user_version').get() as SqlRow).user_version,
      );
      if (version !== SCHEMA_VERSION) {
        db.close();
        throw new HistoryStoreError('history_invalid');
      }
      return db;
    } catch (error) {
      throw historyError(error);
    }
  }

  private evidenceFromRow(
    db: DatabaseSync,
    row: SqlRow,
  ): StoredProviderEvidence {
    try {
      const execution = db.prepare(`
        SELECT e.*, t.task_text FROM executions e JOIN tasks t ON t.task_id = e.task_id
        WHERE e.execution_id = ?
      `).get(String(row.execution_id)) as SqlRow | undefined;
      if (execution === undefined) {
        throw new ProviderEvidenceStoreError('provider_evidence_invalid');
      }
      const settlement = row.capture === 'partial' && row.settlement === 'interrupted'
        ? 'interrupted'
        : 'unknown';
      const observed = this.partialProviderEvidence(
        db,
        String(row.execution_id),
        execution,
        settlement,
      );
      if (observed === undefined && row.capture !== 'complete') {
        throw new ProviderEvidenceStoreError('provider_evidence_invalid');
      }
      const common = {
        schemaVersion: 5 as const,
        evidenceId: String(row.evidence_id),
        sessionId: String(execution.session_correlation),
        build: JSON.parse(String(execution.build_json)),
        definition: JSON.parse(String(execution.definition_json)),
        turnNumber: Number(execution.turn),
        createdAt: String(row.created_at),
        requests: observed?.requests ?? [],
        runtimeEvents: observed?.runtimeEvents ?? [],
        ...(row.turn_provider_request_count === null ? {} : {
          turnProviderRequestCount: Number(row.turn_provider_request_count),
        }),
        ...(row.runtime_provider_request_count === null ? {} : {
          runtimeProviderRequestCount: Number(
            row.runtime_provider_request_count,
          ),
        }),
        ...(row.diagnostic_id === null ? {} : {
          diagnosticId: String(row.diagnostic_id),
        }),
      };
      const evidence: ProviderEvidenceV5 = row.capture === 'complete'
        ? {
          ...common,
          capture: 'complete',
          normalizedOutcome: row.normalized_outcome as
            | 'completed'
            | 'cancelled'
            | 'failed',
          outcome: row.outcome as
            | 'final'
            | 'tool_terminal'
            | 'cancelled'
            | 'max_steps'
            | 'contract_failure',
        }
        : {
          ...common,
          capture: 'partial',
          normalizedOutcome: row.normalized_outcome as
            | 'interrupted'
            | 'unknown',
          settlement: row.settlement as 'interrupted' | 'unknown',
        };
      if (
        Number(row.schema_version) !== 5 || row.link_status !== 'linked' ||
        !validateProviderEvidence(evidence)
      ) throw new ProviderEvidenceStoreError('provider_evidence_invalid');
      return evidence;
    } catch {
      throw new ProviderEvidenceStoreError('provider_evidence_invalid');
    }
  }

  private artifactFromRow(
    db: DatabaseSync,
    row: SqlRow,
  ): StoredWorkerExecutionArtifact {
    try {
      const execution = db.prepare(`
        SELECT e.*, t.task_text FROM executions e JOIN tasks t ON t.task_id = e.task_id
        WHERE e.execution_id = ?
      `).get(String(row.execution_id)) as SqlRow | undefined;
      if (execution === undefined || execution.manifest_json === null) {
        throw new Error('artifact execution missing');
      }
      const protocolTrace = (db.prepare(`
        SELECT r.ordinal, o.* FROM execution_artifact_trace r
        JOIN worker_protocol_observations o
          ON o.observation_id = r.observation_id
        WHERE r.artifact_id = ? ORDER BY r.ordinal
      `).all(String(row.artifact_id)) as SqlRow[]).map((trace, index) => {
        if (Number(trace.ordinal) !== index + 1) {
          throw new Error('artifact trace gap');
        }
        return {
          direction: trace.direction as 'host_to_worker' | 'worker_to_host',
          kind: String(
            trace.kind,
          ) as import('../worker/worker_protocol.ts').WorkerHostCommand['kind'],
          semanticSubtype: String(trace.semantic_subtype),
          sequence: index + 1,
          correlation: {
            session: String(trace.correlation_session),
            instanceCorrelation: String(trace.instance_correlation),
            workerGeneration: String(trace.worker_generation),
            baseStateRevision: Number(trace.base_revision),
            command: String(trace.correlation_command),
          },
          ...(trace.ack_accepted === null ? {} : {
            ackAccepted: Number(trace.ack_accepted) === 1,
          }),
        };
      });
      const projection = db.prepare(`
        SELECT source_execution_id, projected_text FROM execution_projections
        WHERE execution_id = ?
      `).get(String(row.execution_id)) as SqlRow | undefined;
      const command = {
        kind: 'turn' as const,
        correlation: {
          session: String(row.command_session),
          instanceCorrelation: String(row.command_instance_correlation),
          workerGeneration: String(row.command_worker_generation),
          baseStateRevision: Number(row.command_base_revision),
          command: String(row.command_id),
        },
        task: String(execution.task_text),
      };
      const artifactManifest = JSON.parse(String(execution.manifest_json));
      const common = {
        schemaVersion: 7 as const,
        contextCapture: row
          .context_capture as WorkerExecutionArtifactV5['contextCapture'],
        executionId: String(row.execution_id),
        createdAt: String(execution.created_at),
        settledAt: String(row.settled_at),
        sessionId: String(execution.session_correlation),
        turn: Number(execution.turn),
        agent: execution.agent as 'default' | 'planner',
        instanceCorrelation: String(execution.instance_correlation),
        workerGeneration: String(execution.worker_generation),
        build: JSON.parse(String(execution.build_json)),
        definition: JSON.parse(String(execution.definition_json)),
        manifest: artifactManifest,
        ...(artifactManifest?.subagents === undefined
          ? {}
          : { subagents: artifactManifest.subagents }),
        ...(artifactManifest?.tools === undefined ? {} : { tools: artifactManifest.tools }),
        command,
        ...(projection === undefined ? {} : {
          recall: {
            schemaVersion: 1 as const,
            sourceExecutionId: String(projection.source_execution_id),
            projectedContext: String(projection.projected_text),
          },
        }),
        baseStateRevision: Number(execution.base_revision),
        ...(row.proposed_revision === null ? {} : {
          proposedStateRevision: Number(row.proposed_revision),
        }),
        ...(row.committed_revision === null ? {} : {
          committedStateRevision: Number(row.committed_revision),
        }),
        protocolTrace,
        ...(row.provider_evidence_id === null ? {} : {
          providerEvidenceId: String(row.provider_evidence_id),
        }),
        ...(row.provider_evidence_durability === null ? {} : {
          providerEvidenceDurability: String(
            row.provider_evidence_durability,
          ) as
            | 'yes'
            | 'failed'
            | 'unknown',
        }),
        ...(row.provider_evidence_error === null ? {} : {
          providerEvidencePersistenceError: String(row.provider_evidence_error),
        }),
        storeResult: row
          .store_result as WorkerExecutionArtifactV5['storeResult'],
        ...(row.store_error === null ? {} : {
          storeError: String(row.store_error) as
            | 'session_io_failure'
            | 'session_invalid'
            | 'history_busy',
        }),
        acknowledgement: row
          .acknowledgement as WorkerExecutionArtifactV5['acknowledgement'],
        settlement: row.settlement as WorkerExecutionArtifactV5['settlement'],
        lifecycle: 'settled' as const,
        normalizedOutcome: row
          .normalized_outcome as WorkerExecutionArtifactV5['normalizedOutcome'],
        adoption: row.adoption as WorkerExecutionArtifactV5['adoption'],
      };
      const executionOutcome = this.readOutcomeTx(db, execution);
      const artifactOutcome = executionOutcome === undefined ? undefined : {
        ok: executionOutcome.ok,
        outcome: executionOutcome.outcome,
        stopReason: executionOutcome.stopReason,
        ...(executionOutcome.finalText === undefined
          ? {}
          : { finalText: executionOutcome.finalText }),
        ...(executionOutcome.terminalKind === undefined
          ? {}
          : { terminalKind: executionOutcome.terminalKind }),
        ...(executionOutcome.error === undefined ? {} : { error: executionOutcome.error }),
        steps: executionOutcome.steps,
        toolCallCount: executionOutcome.toolCallCount,
        toolResultCount: executionOutcome.toolResultCount,
        ...(executionOutcome.turnProviderRequestCount === undefined ? {} : {
          turnProviderRequestCount: executionOutcome.turnProviderRequestCount,
        }),
        ...(executionOutcome.runtimeProviderRequestCount === undefined ? {} : {
          runtimeProviderRequestCount: executionOutcome.runtimeProviderRequestCount,
        }),
      };
      const artifact: WorkerExecutionArtifactV7 = artifactOutcome === undefined
        ? {
          ...common,
          effectCommitRelation: 'not_transactional',
          automaticReplay: false,
          ...(row.artifact_persistence_error === null ? {} : {
            artifactPersistenceError: String(row.artifact_persistence_error) as
              | 'worker_execution_artifact_io_failure'
              | 'worker_execution_artifact_invalid',
          }),
        } as WorkerExecutionArtifactV7
        : {
          ...common,
          outcome: artifactOutcome,
          effectCommitRelation: 'not_transactional',
          automaticReplay: false,
          ...(row.artifact_persistence_error === null ? {} : {
            artifactPersistenceError: String(row.artifact_persistence_error) as
              | 'worker_execution_artifact_io_failure'
              | 'worker_execution_artifact_invalid',
          }),
        } as WorkerExecutionArtifactV7;
      if (
        row.artifact_id !== artifact.executionId ||
        row.link_status !== 'linked' ||
        !validateWorkerExecutionArtifact(artifact)
      ) throw new Error('artifact invalid');
      return artifact;
    } catch {
      throw new WorkerExecutionArtifactStoreError(
        'worker_execution_artifact_invalid',
      );
    }
  }

  private diagnosticFromRow(row: SqlRow): FailureDiagnosticV1 {
    try {
      const diagnostic = decodeFailureDiagnostic(String(row.diagnostic_json));
      if (
        row.diagnostic_id !== diagnostic.diagnosticId ||
        row.occurred_at !== diagnostic.occurredAt ||
        Number(row.payload_bytes) !==
          encoder.encode(String(row.diagnostic_json)).byteLength
      ) throw new FailureDiagnosticStoreError('diagnostic_invalid');
      return diagnostic;
    } catch {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
  }

  _listEvidence(): readonly StoredProviderEvidence[] {
    const db = this.openSynchronousDatabase();
    try {
      return (db.prepare(
        `SELECT * FROM provider_evidence ORDER BY created_at, evidence_id`,
      ).all() as SqlRow[]).map((row) => this.evidenceFromRow(db, row));
    } finally {
      db.close();
    }
  }

  _readEvidence(id: string): StoredProviderEvidence {
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(
        `SELECT * FROM provider_evidence WHERE evidence_id = ?`,
      )
        .get(id) as SqlRow | undefined;
      if (row === undefined) {
        throw new ProviderEvidenceStoreError('provider_evidence_not_found');
      }
      return this.evidenceFromRow(db, row);
    } finally {
      db.close();
    }
  }

  _readDiagnosticLink(id: string): string {
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(
        'SELECT evidence_id FROM diagnostic_evidence_links WHERE diagnostic_id = ?',
      ).get(id) as SqlRow | undefined;
      if (row === undefined) {
        throw new ProviderEvidenceStoreError('provider_evidence_not_found');
      }
      return String(row.evidence_id);
    } finally {
      db.close();
    }
  }

  _listArtifacts(): readonly StoredWorkerExecutionArtifact[] {
    const db = this.openSynchronousDatabase();
    try {
      return (db.prepare(
        `SELECT * FROM execution_artifacts ORDER BY settled_at, artifact_id`,
      ).all() as SqlRow[]).map((row) => this.artifactFromRow(db, row));
    } finally {
      db.close();
    }
  }

  _readArtifact(id: string): StoredWorkerExecutionArtifact {
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(
        'SELECT * FROM execution_artifacts WHERE artifact_id = ?',
      )
        .get(id) as SqlRow | undefined;
      if (row === undefined) {
        throw new WorkerExecutionArtifactStoreError(
          'worker_execution_artifact_not_found',
        );
      }
      return this.artifactFromRow(db, row);
    } finally {
      db.close();
    }
  }

  _listDiagnostics(): readonly FailureDiagnosticV1[] {
    const db = this.openSynchronousDatabase();
    try {
      return (db.prepare(
        `SELECT diagnostic_id, occurred_at, payload_bytes, diagnostic_json
         FROM failure_diagnostics ORDER BY occurred_at, diagnostic_id`,
      ).all() as SqlRow[]).map((row) => this.diagnosticFromRow(row));
    } finally {
      db.close();
    }
  }

  _readDiagnostic(id: string): FailureDiagnosticV1 {
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(
        `SELECT diagnostic_id, occurred_at, payload_bytes, diagnostic_json
         FROM failure_diagnostics WHERE diagnostic_id = ?`,
      ).get(id) as SqlRow | undefined;
      if (row === undefined) {
        throw new FailureDiagnosticStoreError('diagnostic_not_found');
      }
      return this.diagnosticFromRow(row);
    } finally {
      db.close();
    }
  }

  _deleteDiagnostic(id: string): void {
    const db = this.openSynchronousDatabase();
    try {
      this.transaction(db, () => {
        const result = db!.prepare(
          'DELETE FROM failure_diagnostics WHERE diagnostic_id = ?',
        )
          .run(id);
        if (Number(result.changes) !== 1) {
          throw new FailureDiagnosticStoreError('diagnostic_not_found');
        }
      });
    } finally {
      db.close();
    }
  }
}

class SqliteProviderEvidenceAdapter implements ProviderEvidenceStore {
  constructor(private readonly store: SqliteHistoryStore) {}
  list(): Promise<readonly StoredProviderEvidence[]> {
    return Promise.resolve(this.store._listEvidence());
  }
  read(id: string): Promise<StoredProviderEvidence> {
    try {
      return Promise.resolve(this.store._readEvidence(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  write(_evidence: StoredProviderEvidence): Promise<void> {
    return Promise.reject(
      new ProviderEvidenceStoreError('provider_evidence_invalid'),
    );
  }
  linkDiagnostic(_diagnosticId: string, _evidenceId: string): Promise<void> {
    return Promise.reject(
      new ProviderEvidenceStoreError('provider_evidence_invalid'),
    );
  }
  readDiagnosticLink(id: string): Promise<string> {
    try {
      return Promise.resolve(this.store._readDiagnosticLink(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

class SqliteExecutionArtifactAdapter implements WorkerExecutionArtifactStore {
  constructor(private readonly store: SqliteHistoryStore) {}
  list(): Promise<readonly StoredWorkerExecutionArtifact[]> {
    return Promise.resolve(this.store._listArtifacts());
  }
  read(id: string): Promise<StoredWorkerExecutionArtifact> {
    try {
      return Promise.resolve(this.store._readArtifact(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  write(_artifact: StoredWorkerExecutionArtifact): Promise<void> {
    return Promise.reject(
      new WorkerExecutionArtifactStoreError(
        'worker_execution_artifact_invalid',
      ),
    );
  }
}

class SqliteDiagnosticAdapter implements FailureDiagnosticStore {
  constructor(private readonly store: SqliteHistoryStore) {}
  list(): Promise<readonly FailureDiagnosticV1[]> {
    return Promise.resolve(this.store._listDiagnostics());
  }
  read(id: string): Promise<FailureDiagnosticV1> {
    try {
      return Promise.resolve(this.store._readDiagnostic(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  write(_diagnostic: FailureDiagnosticV1): Promise<void> {
    return Promise.reject(
      new FailureDiagnosticStoreError('diagnostic_invalid'),
    );
  }
  delete(id: string): Promise<void> {
    try {
      this.store._deleteDiagnostic(id);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  persist = (diagnostic: FailureDiagnosticV1): Promise<void> => this.write(diagnostic);
}
