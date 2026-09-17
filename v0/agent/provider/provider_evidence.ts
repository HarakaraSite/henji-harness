import type {
  JsonValue,
  LoopOutcome,
  ModelResult,
  ToolCall,
  ToolResultContent,
} from '../core/contracts.ts';
import type { ReasoningEffort } from './model_selection.ts';
import {
  type DefinitionRevisionRef,
  isDefinitionRevisionRef,
} from '../definitions/managed_resource_ref.ts';
import { type BuildManifestV1, isBuildManifest } from '../runtime/build_manifest.ts';
import { isJsonValue } from './openrouter_value.ts';

/** One retained exchange is owned by one accepted parent turn. */
export const PROVIDER_EVIDENCE_SCHEMA_VERSION = 5 as const;

export type ProviderEvidenceLane = 'parent' | 'planner';
/** Identifies whether a retained request belongs to compaction or the user turn. */
export type ProviderEvidencePhase = 'user_turn' | 'compaction';
export type ProviderEvidenceDurability = 'yes' | 'failed' | 'unknown';
export type ProviderEvidencePersistenceErrorCode =
  | 'provider_evidence_not_found'
  | 'provider_evidence_invalid'
  | 'provider_evidence_io_failure';

export interface ProviderEvidenceRequest {
  readonly ordinal: number;
  /** Increment 42 logical model-request correlation; absent in legacy evidence. */
  readonly contextRequestOrdinal?: number;
  readonly lane: ProviderEvidenceLane;
  /** Additive metadata; absent on legacy evidence and therefore decodes compatibly. */
  readonly phase?: ProviderEvidencePhase;
  readonly modelStep: number;
  readonly endpoint: string;
  readonly method: 'POST';
  readonly requestBody: string;
  readonly requestBodyBytes: number;
  /** Deliberately excludes all request headers and every credential source. */
  readonly requestMetadata: ProviderEvidenceRequestMetadata;
}

/** Fixed non-header request metadata; credential and Authorization fields have no capture shape. */
export interface ProviderEvidenceRequestMetadata {
  readonly contentType?: string;
  readonly redirect?: string;
  readonly responseMode?: 'json' | 'sse';
  readonly origin?:
    | 'root_model'
    | 'planner_model'
    | 'context_compaction'
    | 'web_search';
  readonly provider?: string;
  readonly api?: 'openrouter-chat-completions' | 'openrouter-responses' | 'openai-responses';
  readonly modelId?: string;
  readonly effort?: ReasoningEffort;
  readonly authProfile?: 'openrouter-api-key' | 'openai-api-key';
  readonly protocol?: 'json' | 'sse';
}

export interface ProviderEvidenceResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody?: string;
  /** Exact response bytes, retained independently of UTF-8 text decoding. */
  readonly rawBodyBase64?: string;
  readonly rawBodyBytes: number;
}

export interface ProviderEvidenceSseEvent {
  readonly ordinal: number;
  readonly data: string;
  /** The exact UTF-8-decoded SSE frame, including fields and line separators. */
  readonly rawFrame: string;
  readonly rawFrameBytes: number;
  /** Cumulative raw response byte position when the SSE frame was dispatched. */
  readonly responseBodyOffset: number;
  readonly parsed?: JsonValue | '[DONE]';
}

export interface ProviderEvidenceParserTransition {
  readonly ordinal: number;
  readonly kind: 'event' | 'terminal' | 'result' | 'failure';
  readonly reason?: string;
  readonly field?: string;
  readonly detail?: JsonValue;
}

export type ProviderEvidenceRuntimeEvent =
  | {
    readonly kind: 'assistant_progress';
    readonly text: string;
    readonly modelStep: number;
    readonly lane?: ProviderEvidenceLane;
    /** Physical request attribution for live journal reconciliation. */
    readonly requestOrdinal?: number;
  }
  | {
    readonly kind: 'model_result';
    readonly result: ModelResult;
    readonly modelStep: number;
    readonly lane?: ProviderEvidenceLane;
    readonly requestOrdinal?: number;
  }
  | {
    readonly kind: 'tool_call';
    readonly call: ToolCall;
    readonly modelStep: number;
    readonly lane?: ProviderEvidenceLane;
    readonly requestOrdinal?: number;
  }
  | {
    readonly kind: 'tool_progress';
    readonly callId: string;
    readonly name: string;
    readonly text: string;
    readonly modelStep: number;
    readonly lane?: ProviderEvidenceLane;
    readonly requestOrdinal?: number;
  }
  | {
    readonly kind: 'tool_result';
    readonly result: ToolResultContent;
    readonly modelStep: number;
    readonly lane?: ProviderEvidenceLane;
    readonly requestOrdinal?: number;
  }
  | {
    readonly kind: 'turn_outcome';
    readonly outcome: LoopOutcome['stopReason'];
  };

export interface ProviderEvidenceRequestRecord {
  readonly request: ProviderEvidenceRequest;
  readonly response?: ProviderEvidenceResponse;
  readonly sseEvents: readonly ProviderEvidenceSseEvent[];
  readonly parserTransitions: readonly ProviderEvidenceParserTransition[];
}

export interface ProviderEvidenceV1 {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly turnNumber: number;
  readonly createdAt: string;
  readonly requests: readonly ProviderEvidenceRequestRecord[];
  readonly runtimeEvents: readonly ProviderEvidenceRuntimeEvent[];
  readonly turnProviderRequestCount?: number;
  readonly runtimeProviderRequestCount?: number;
  readonly outcome?: LoopOutcome['stopReason'];
  readonly diagnosticId?: string;
}

export interface ProviderEvidenceV2 extends Omit<ProviderEvidenceV1, 'schemaVersion'> {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly build: BuildManifestV1;
  readonly definition: DefinitionRevisionRef;
}

export interface ProviderEvidenceV3 extends Omit<ProviderEvidenceV2, 'schemaVersion'> {
  readonly schemaVersion: 3;
}

/** Shared schema-v2 history evidence fields. */
type ProviderEvidenceV4Base =
  & Omit<ProviderEvidenceV3, 'schemaVersion' | 'outcome'>
  & {
    readonly schemaVersion: 4;
  };

/** A completed capture always carries the real Worker stop reason. */
export type ProviderEvidenceV4Complete =
  & ProviderEvidenceV4Base
  & {
    readonly capture: 'complete';
    readonly settlement?: never;
  }
  & (
    | {
      readonly normalizedOutcome: 'completed';
      readonly outcome: 'final' | 'tool_terminal';
    }
    | { readonly normalizedOutcome: 'cancelled'; readonly outcome: 'cancelled' }
    | {
      readonly normalizedOutcome: 'failed';
      readonly outcome: 'max_steps' | 'contract_failure';
    }
  );

/** A partial capture is only a restart reconciliation and never invents an outcome. */
export type ProviderEvidenceV4Partial = ProviderEvidenceV4Base & {
  readonly capture: 'partial';
  readonly normalizedOutcome: 'interrupted' | 'unknown';
  readonly outcome?: never;
  readonly settlement: 'interrupted' | 'unknown';
};

export type ProviderEvidenceV4 =
  | ProviderEvidenceV4Complete
  | ProviderEvidenceV4Partial;

/** Schema-v3 history evidence. Every physical request is linked to a logical context request. */
export type ProviderEvidenceV5 =
  | (Omit<ProviderEvidenceV4Complete, 'schemaVersion' | 'requests'> & {
    readonly schemaVersion: 5;
    readonly requests: readonly (ProviderEvidenceRequestRecord & {
      readonly request: ProviderEvidenceRequest & { readonly contextRequestOrdinal: number };
    })[];
  })
  | (Omit<ProviderEvidenceV4Partial, 'schemaVersion' | 'requests'> & {
    readonly schemaVersion: 5;
    readonly requests: readonly (ProviderEvidenceRequestRecord & {
      readonly request: ProviderEvidenceRequest & { readonly contextRequestOrdinal: number };
    })[];
  });

export type StoredProviderEvidence =
  | ProviderEvidenceV2
  | ProviderEvidenceV3
  | ProviderEvidenceV4
  | ProviderEvidenceV5;

export interface ProviderEvidenceStore {
  list(): Promise<readonly StoredProviderEvidence[]>;
  read(id: string): Promise<StoredProviderEvidence>;
  write(evidence: StoredProviderEvidence): Promise<void>;
  linkDiagnostic(diagnosticId: string, evidenceId: string): Promise<void>;
  readDiagnosticLink(diagnosticId: string): Promise<string>;
}

/** Direct-runtime seam. Production Worker drafts cross the protocol and are attributed by Host. */
export interface ProviderEvidenceDraftStore {
  list(): Promise<readonly ProviderEvidenceV1[]>;
  read(id: string): Promise<ProviderEvidenceV1>;
  write(evidence: ProviderEvidenceV1): Promise<void>;
  linkDiagnostic(diagnosticId: string, evidenceId: string): Promise<void>;
  readDiagnosticLink(diagnosticId: string): Promise<string>;
}

export interface EvidenceRequestStart {
  readonly lane: ProviderEvidenceLane;
  readonly phase?: ProviderEvidencePhase;
  readonly modelStep: number;
  readonly endpoint: string;
  readonly method: 'POST';
  readonly requestBody: string;
  readonly requestMetadata?: ProviderEvidenceRequestMetadata;
  /** Logical context request ordinal when available. */
  readonly contextRequestOrdinal?: number;
}

export interface EvidenceResponseStart {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface EvidenceFinalize {
  readonly outcome: LoopOutcome;
  readonly diagnosticId?: string;
}

export type ProviderEvidenceObservation =
  | {
    readonly kind: 'request_start';
    readonly request: ProviderEvidenceRequest;
  }
  | {
    readonly kind: 'response_start';
    readonly requestOrdinal: number;
    readonly response: EvidenceResponseStart;
  }
  | {
    readonly kind: 'response_bytes';
    readonly requestOrdinal: number;
    readonly offset: number;
    readonly bytesBase64: string;
  }
  | {
    readonly kind: 'sse_event';
    readonly requestOrdinal: number;
    readonly event: ProviderEvidenceSseEvent;
  }
  | {
    readonly kind: 'parser_transition';
    readonly requestOrdinal: number;
    readonly transition: ProviderEvidenceParserTransition;
  }
  | {
    /** Runtime facts are sent live as well as retained in the completed evidence envelope. */
    readonly kind: 'runtime_event';
    readonly requestOrdinal?: number;
    readonly event: ProviderEvidenceRuntimeEvent;
  };

const encoder = new TextEncoder();
const PROVIDER_STOP_REASONS: readonly LoopOutcome['stopReason'][] = [
  'final',
  'tool_terminal',
  'max_steps',
  'contract_failure',
  'cancelled',
];

const normalizedOutcomeForStopReason = (
  stopReason: LoopOutcome['stopReason'],
): ProviderEvidenceV4['normalizedOutcome'] =>
  stopReason === 'final' || stopReason === 'tool_terminal'
    ? 'completed'
    : stopReason === 'cancelled'
    ? 'cancelled'
    : 'failed';

const cloneValue = <T>(value: T): T => structuredClone(value);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === 'string' && allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
};
const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && ISO_TIMESTAMP.test(value) &&
  !Number.isNaN(new Date(value).valueOf()) &&
  new Date(value).toISOString() === value;
const validPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const validNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');
const validBase64 = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    return false;
  }
  try {
    Uint8Array.fromBase64(value);
    return true;
  } catch {
    return false;
  }
};
const validHeaders = (
  value: unknown,
): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.entries(value).every(([key, header]) =>
    !key.includes('\0') && typeof header === 'string' && !header.includes('\0')
  );
const validProviderMetadata = (
  value: unknown,
): value is ProviderEvidenceRequestMetadata => {
  if (
    !hasExactKeys(value, [], [
      'contentType',
      'redirect',
      'responseMode',
      'origin',
      'provider',
      'api',
      'modelId',
      'effort',
      'authProfile',
      'protocol',
    ])
  ) return false;
  const record = value;
  return (record.contentType === undefined || validText(record.contentType)) &&
    (record.redirect === undefined || validText(record.redirect)) &&
    (record.responseMode === undefined || record.responseMode === 'json' ||
      record.responseMode === 'sse') &&
    (record.origin === undefined || record.origin === 'root_model' ||
      record.origin === 'planner_model' ||
      record.origin === 'context_compaction' ||
      record.origin === 'web_search') &&
    (record.provider === undefined || validText(record.provider)) &&
    (record.api === undefined || record.api === 'openrouter-chat-completions' ||
      record.api === 'openrouter-responses' || record.api === 'openai-responses') &&
    (record.modelId === undefined || validText(record.modelId)) &&
    (record.effort === undefined || record.effort === 'auto' ||
      record.effort === 'none' ||
      record.effort === 'minimal' ||
      record.effort === 'low' || record.effort === 'medium' ||
      record.effort === 'high' || record.effort === 'xhigh' ||
      record.effort === 'max') &&
    (record.authProfile === undefined ||
      record.authProfile === 'openrouter-api-key' ||
      record.authProfile === 'openai-api-key') &&
    (record.protocol === undefined || record.protocol === 'json' ||
      record.protocol === 'sse');
};
const validToolCall = (value: unknown): value is ToolCall =>
  hasExactKeys(value, ['callId', 'name', 'arguments']) &&
  validText(value.callId) &&
  validText(value.name) && isJsonValue(value.arguments);
const validToolResult = (value: unknown): value is ToolResultContent => {
  if (
    !hasExactKeys(value, ['kind', 'callId', 'name', 'text', 'outcome'], [
      'terminal',
    ])
  ) return false;
  return value.kind === 'tool_result' && validText(value.callId) &&
    validText(value.name) &&
    typeof value.text === 'string' &&
    (value.outcome === 'success' || value.outcome === 'error') &&
    (value.terminal === undefined || value.terminal === 'json_result') &&
    (value.terminal === undefined || value.outcome === 'success');
};
const validProviderState = (value: unknown): boolean =>
  value === undefined || (
    isRecord(value) && value.provider === 'openrouter' &&
    hasExactKeys(value, ['provider', 'reasoningDetails']) &&
    Array.isArray(value.reasoningDetails) &&
    value.reasoningDetails.every(isJsonValue)
  ) || (
    isRecord(value) && typeof value.provider === 'string' && value.provider.length > 0 &&
    hasExactKeys(value, ['provider', 'replayItems'], ['model']) &&
    Array.isArray(value.replayItems) && value.replayItems.every(isJsonValue) &&
    (value.model === undefined ||
      (typeof value.model === 'string' && value.model.length > 0))
  );
const validModelResult = (value: unknown): value is ModelResult => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'final') {
    return hasExactKeys(value, ['kind', 'text'], ['providerState']) &&
      typeof value.text === 'string' &&
      validProviderState(value.providerState);
  }
  if (value.kind === 'tool_calls') {
    return hasExactKeys(value, ['kind', 'calls'], ['text', 'providerState']) &&
      Array.isArray(value.calls) && value.calls.every(validToolCall) &&
      (value.text === undefined || typeof value.text === 'string') &&
      validProviderState(value.providerState);
  }
  return false;
};
const validRuntimeEvent = (
  value: unknown,
): value is ProviderEvidenceRuntimeEvent => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'assistant_progress') {
    return hasExactKeys(value, ['kind', 'text', 'modelStep'], [
      'lane',
      'requestOrdinal',
    ]) &&
      typeof value.text === 'string' && validPositiveInteger(value.modelStep) &&
      (value.lane === undefined || value.lane === 'parent' ||
        value.lane === 'planner') &&
      (value.requestOrdinal === undefined ||
        validPositiveInteger(value.requestOrdinal));
  }
  if (value.kind === 'model_result') {
    return hasExactKeys(value, ['kind', 'result', 'modelStep'], [
      'lane',
      'requestOrdinal',
    ]) &&
      validModelResult(value.result) && validPositiveInteger(value.modelStep) &&
      (value.lane === undefined || value.lane === 'parent' ||
        value.lane === 'planner') &&
      (value.requestOrdinal === undefined ||
        validPositiveInteger(value.requestOrdinal));
  }
  if (value.kind === 'tool_call') {
    return hasExactKeys(value, ['kind', 'call', 'modelStep'], [
      'lane',
      'requestOrdinal',
    ]) &&
      validToolCall(value.call) && validPositiveInteger(value.modelStep) &&
      (value.lane === undefined || value.lane === 'parent' ||
        value.lane === 'planner') &&
      (value.requestOrdinal === undefined ||
        validPositiveInteger(value.requestOrdinal));
  }
  if (value.kind === 'tool_progress') {
    return hasExactKeys(
      value,
      ['kind', 'callId', 'name', 'text', 'modelStep'],
      ['lane', 'requestOrdinal'],
    ) &&
      validText(value.callId) && validText(value.name) &&
      typeof value.text === 'string' &&
      validPositiveInteger(value.modelStep) &&
      (value.lane === undefined || value.lane === 'parent' ||
        value.lane === 'planner') &&
      (value.requestOrdinal === undefined ||
        validPositiveInteger(value.requestOrdinal));
  }
  if (value.kind === 'tool_result') {
    return hasExactKeys(value, ['kind', 'result', 'modelStep'], [
      'lane',
      'requestOrdinal',
    ]) &&
      validToolResult(value.result) && validPositiveInteger(value.modelStep) &&
      (value.lane === undefined || value.lane === 'parent' ||
        value.lane === 'planner') &&
      (value.requestOrdinal === undefined ||
        validPositiveInteger(value.requestOrdinal));
  }
  return value.kind === 'turn_outcome' &&
    hasExactKeys(value, ['kind', 'outcome']) &&
    typeof value.outcome === 'string' &&
    PROVIDER_STOP_REASONS.includes(value.outcome as LoopOutcome['stopReason']);
};
const validRequest = (value: unknown): value is ProviderEvidenceRequest => {
  if (
    !hasExactKeys(value, [
      'ordinal',
      'lane',
      'modelStep',
      'endpoint',
      'method',
      'requestBody',
      'requestBodyBytes',
      'requestMetadata',
    ], ['phase', 'contextRequestOrdinal'])
  ) return false;
  return validPositiveInteger(value.ordinal) &&
    (value.lane === 'parent' || value.lane === 'planner') &&
    (value.phase === undefined || value.phase === 'user_turn' ||
      value.phase === 'compaction') &&
    (value.contextRequestOrdinal === undefined ||
      validPositiveInteger(value.contextRequestOrdinal)) &&
    validPositiveInteger(value.modelStep) && validText(value.endpoint) &&
    value.method === 'POST' &&
    typeof value.requestBody === 'string' &&
    !value.requestBody.includes('\0') &&
    value.requestBodyBytes === encoder.encode(value.requestBody).byteLength &&
    validProviderMetadata(value.requestMetadata);
};
const validResponse = (value: unknown): value is ProviderEvidenceResponse => {
  if (
    !hasExactKeys(value, ['status', 'headers', 'rawBodyBytes'], [
      'rawBody',
      'rawBodyBase64',
    ])
  ) return false;
  if (
    typeof value.status !== 'number' || !Number.isInteger(value.status) ||
    value.status < 100 || value.status > 599 ||
    !validHeaders(value.headers) || !validNonNegativeInteger(value.rawBodyBytes)
  ) return false;
  if (value.rawBody !== undefined && typeof value.rawBody !== 'string') {
    return false;
  }
  if (
    value.rawBodyBase64 !== undefined &&
    (!validBase64(value.rawBodyBase64) ||
      Uint8Array.fromBase64(value.rawBodyBase64).byteLength !==
        value.rawBodyBytes)
  ) return false;
  if (value.rawBody !== undefined && value.rawBodyBase64 !== undefined) {
    const encoded = Uint8Array.fromBase64(value.rawBodyBase64);
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
      if (decoded !== value.rawBody) return false;
    } catch {
      // Preserve a lossy text projection alongside exact non-UTF-8 bytes.
    }
  }
  if (value.rawBody === undefined && value.rawBodyBase64 === undefined) {
    return value.rawBodyBytes === 0;
  }
  return value.rawBodyBase64 !== undefined || value.rawBody === undefined
    ? true
    : encoder.encode(value.rawBody).byteLength === value.rawBodyBytes;
};
const validSseEvent = (value: unknown): value is ProviderEvidenceSseEvent =>
  hasExactKeys(value, [
    'ordinal',
    'data',
    'rawFrame',
    'rawFrameBytes',
    'responseBodyOffset',
  ], ['parsed']) &&
  validPositiveInteger(value.ordinal) && typeof value.data === 'string' &&
  typeof value.rawFrame === 'string' &&
  value.rawFrameBytes === encoder.encode(value.rawFrame).byteLength &&
  validNonNegativeInteger(value.responseBodyOffset) &&
  (value.parsed === undefined || value.parsed === '[DONE]' ||
    isJsonValue(value.parsed));
const validParserTransition = (
  value: unknown,
): value is ProviderEvidenceParserTransition =>
  hasExactKeys(value, ['ordinal', 'kind'], ['reason', 'field', 'detail']) &&
  validPositiveInteger(value.ordinal) &&
  (value.kind === 'event' || value.kind === 'terminal' ||
    value.kind === 'result' || value.kind === 'failure') &&
  (value.reason === undefined || typeof value.reason === 'string') &&
  (value.field === undefined || typeof value.field === 'string') &&
  (value.detail === undefined || isJsonValue(value.detail));
const validRequestRecord = (
  value: unknown,
): value is ProviderEvidenceRequestRecord => {
  if (
    !hasExactKeys(value, ['request', 'sseEvents', 'parserTransitions'], [
      'response',
    ]) || !validRequest(value.request) ||
    (value.response !== undefined && !validResponse(value.response)) ||
    !Array.isArray(value.sseEvents) ||
    !value.sseEvents.every(validSseEvent) ||
    !Array.isArray(value.parserTransitions) ||
    !value.parserTransitions.every(validParserTransition)
  ) return false;
  if (
    value.sseEvents.some((event, index) => event.ordinal !== index + 1) ||
    value.parserTransitions.some((event, index) => event.ordinal !== index + 1)
  ) return false;
  if (
    value.response === undefined &&
    (value.sseEvents.length > 0 || value.parserTransitions.length > 0)
  ) return false;
  const responseBytes = value.response?.rawBodyBytes ?? 0;
  return value.sseEvents.every((event) => event.responseBodyOffset <= responseBytes);
};

/** Validate one credential-free provider fact before it crosses the Worker/Host boundary. */
export const validateProviderEvidenceObservation = (
  value: unknown,
): value is ProviderEvidenceObservation => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'request_start') {
    return hasExactKeys(value, ['kind', 'request']) &&
      validRequest(value.request);
  }
  if (value.kind === 'response_start') {
    const response = value.response;
    return hasExactKeys(value, ['kind', 'requestOrdinal', 'response']) &&
      validPositiveInteger(value.requestOrdinal) &&
      hasExactKeys(response, ['status', 'headers']) &&
      typeof response.status === 'number' &&
      Number.isInteger(response.status) && response.status >= 100 &&
      response.status <= 599 &&
      validHeaders(response.headers);
  }
  if (value.kind === 'response_bytes') {
    return hasExactKeys(value, [
      'kind',
      'requestOrdinal',
      'offset',
      'bytesBase64',
    ]) &&
      validPositiveInteger(value.requestOrdinal) &&
      validNonNegativeInteger(value.offset) &&
      validBase64(value.bytesBase64);
  }
  if (value.kind === 'sse_event') {
    return hasExactKeys(value, ['kind', 'requestOrdinal', 'event']) &&
      validPositiveInteger(value.requestOrdinal) &&
      validSseEvent(value.event);
  }
  if (value.kind === 'parser_transition') {
    return hasExactKeys(value, ['kind', 'requestOrdinal', 'transition']) &&
      validPositiveInteger(value.requestOrdinal) &&
      validParserTransition(value.transition);
  }
  if (value.kind === 'runtime_event') {
    return hasExactKeys(value, ['kind', 'event'], ['requestOrdinal']) &&
      validRuntimeEvent(value.event) &&
      (value.requestOrdinal === undefined ||
        value.event.kind !== 'turn_outcome' &&
          validPositiveInteger(value.requestOrdinal));
  }
  return false;
};

const cloneRequest = (
  request: ProviderEvidenceRequest,
): ProviderEvidenceRequest => ({
  ...request,
  requestMetadata: cloneValue(request.requestMetadata),
});

interface MutableProviderEvidenceRequestRecord {
  readonly request: ProviderEvidenceRequest;
  response?: ProviderEvidenceResponse;
  readonly rawBytes: Uint8Array[];
  readonly sseEvents: ProviderEvidenceSseEvent[];
  readonly parserTransitions: ProviderEvidenceParserTransition[];
}

const joinBytes = (
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array => {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const materializeRecord = (
  record: MutableProviderEvidenceRequestRecord,
): ProviderEvidenceRequestRecord => {
  const response = record.response;
  const materializedResponse = response === undefined ? undefined : (() => {
    const raw = joinBytes(record.rawBytes, response.rawBodyBytes);
    return {
      ...response,
      headers: { ...response.headers },
      ...(raw.byteLength === 0 ? {} : {
        rawBody: new TextDecoder().decode(raw),
        rawBodyBase64: raw.toBase64(),
      }),
    };
  })();
  return {
    request: cloneRequest(record.request),
    ...(materializedResponse === undefined ? {} : { response: materializedResponse }),
    sseEvents: record.sseEvents.map((event) => ({
      ...event,
      ...(event.parsed === undefined ? {} : { parsed: cloneValue(event.parsed) }),
    })),
    parserTransitions: record.parserTransitions.map((transition) => ({
      ...transition,
      ...(transition.detail === undefined ? {} : { detail: cloneValue(transition.detail) }),
    })),
  };
};

const activeRecord = (
  records: MutableProviderEvidenceRequestRecord[],
): MutableProviderEvidenceRequestRecord | undefined => records.at(-1);

/**
 * In-memory evidence recorder. It intentionally has no credential/header input in its API.
 * Runtime and provider layers share this instance for parent and planner requests.
 */
export class ProviderEvidenceRecorder {
  private readonly records: MutableProviderEvidenceRequestRecord[] = [];
  private readonly runtimeEvents: ProviderEvidenceRuntimeEvent[] = [];
  private finalized?: EvidenceFinalize;
  private persistence?: Promise<void>;
  private persistenceError?: unknown;
  private artifactWritten = false;
  private persisted = false;
  private contextRequestOrdinal?: number;

  constructor(
    readonly evidenceId: string = crypto.randomUUID().toLowerCase(),
    readonly turnNumber = 1,
    readonly createdAt: string = new Date().toISOString(),
    private readonly store?: ProviderEvidenceDraftStore,
    private readonly observationSink?: (
      observation: ProviderEvidenceObservation,
    ) => void,
  ) {}

  setContextRequestOrdinal(ordinal: number | undefined): void {
    this.contextRequestOrdinal = ordinal;
  }

  startRequest(input: EvidenceRequestStart): number {
    const ordinal = this.records.length + 1;
    const request: ProviderEvidenceRequest = {
      ordinal,
      lane: input.lane,
      ...(input.phase === undefined ? {} : { phase: input.phase }),
      modelStep: input.modelStep,
      endpoint: input.endpoint,
      method: input.method,
      requestBody: input.requestBody,
      requestBodyBytes: encoder.encode(input.requestBody).byteLength,
      requestMetadata: { ...(input.requestMetadata ?? {}) },
      ...(input.contextRequestOrdinal === undefined && this.contextRequestOrdinal === undefined
        ? {}
        : {
          contextRequestOrdinal: input.contextRequestOrdinal ?? this.contextRequestOrdinal,
        }),
    };
    this.records.push({
      request,
      rawBytes: [],
      sseEvents: [],
      parserTransitions: [],
    });
    this.observationSink?.({
      kind: 'request_start',
      request: cloneRequest(request),
    });
    return ordinal;
  }

  recordResponse(response: EvidenceResponseStart): void {
    const record = activeRecord(this.records);
    if (record === undefined) return;
    record.response = {
      status: response.status,
      headers: { ...response.headers },
      rawBodyBytes: 0,
    };
    record.rawBytes.length = 0;
    this.observationSink?.({
      kind: 'response_start',
      requestOrdinal: record.request.ordinal,
      response: { ...response, headers: { ...response.headers } },
    });
  }

  appendResponseBytes(bytes: Uint8Array): void {
    const record = activeRecord(this.records);
    if (record === undefined) return;
    const response = record.response;
    if (response === undefined) return;
    record.rawBytes.push(bytes.slice());
    record.response = {
      ...response,
      rawBodyBytes: response.rawBodyBytes + bytes.byteLength,
    };
    this.observationSink?.({
      kind: 'response_bytes',
      requestOrdinal: record.request.ordinal,
      offset: record.response.rawBodyBytes,
      bytesBase64: bytes.toBase64(),
    });
  }

  recordSseEvent(event: {
    readonly data: string;
    readonly rawFrame: string;
    readonly parsed?: JsonValue | '[DONE]';
  }): number {
    const record = activeRecord(this.records);
    if (record === undefined) return 0;
    const ordinal = record.sseEvents.length + 1;
    const responseBodyOffset = record.response?.rawBodyBytes ?? 0;
    record.sseEvents.push({
      ordinal,
      data: event.data,
      rawFrame: event.rawFrame,
      rawFrameBytes: encoder.encode(event.rawFrame).byteLength,
      responseBodyOffset,
      ...(event.parsed === undefined ? {} : { parsed: cloneValue(event.parsed) }),
    });
    this.observationSink?.({
      kind: 'sse_event',
      requestOrdinal: record.request.ordinal,
      event: structuredClone(record.sseEvents.at(-1)!),
    });
    return ordinal;
  }

  recordParserTransition(
    transition: Omit<ProviderEvidenceParserTransition, 'ordinal'>,
  ): void {
    const record = activeRecord(this.records);
    if (record === undefined) return;
    record.parserTransitions.push({
      ordinal: record.parserTransitions.length + 1,
      ...transition,
      ...(transition.detail === undefined ? {} : { detail: cloneValue(transition.detail) }),
    });
    this.observationSink?.({
      kind: 'parser_transition',
      requestOrdinal: record.request.ordinal,
      transition: structuredClone(record.parserTransitions.at(-1)!),
    });
  }

  recordAssistantProgress(
    text: string,
    modelStep: number,
    lane?: ProviderEvidenceLane,
  ): void {
    const event: ProviderEvidenceRuntimeEvent = {
      kind: 'assistant_progress',
      text,
      modelStep,
      ...(lane === undefined ? {} : { lane }),
      ...(activeRecord(this.records) === undefined ? {} : {
        requestOrdinal: activeRecord(this.records)!.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    const index = this.runtimeEvents.findIndex((existing) =>
      existing.kind === 'assistant_progress' &&
      existing.modelStep === modelStep &&
      existing.lane === lane && existing.requestOrdinal === event.requestOrdinal
    );
    if (index < 0) this.runtimeEvents.push(event);
    else this.runtimeEvents[index] = event;
  }

  recordModelResult(
    result: ModelResult,
    modelStep: number,
    lane?: ProviderEvidenceLane,
  ): void {
    const event: ProviderEvidenceRuntimeEvent = {
      kind: 'model_result',
      result: cloneValue(result),
      modelStep,
      ...(lane === undefined ? {} : { lane }),
      ...(activeRecord(this.records) === undefined ? {} : {
        requestOrdinal: activeRecord(this.records)!.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    this.runtimeEvents.push(event);
  }

  recordToolCall(
    call: ToolCall,
    modelStep: number,
    lane?: ProviderEvidenceLane,
  ): void {
    const event: ProviderEvidenceRuntimeEvent = {
      kind: 'tool_call',
      call: cloneValue(call),
      modelStep,
      ...(lane === undefined ? {} : { lane }),
      ...(activeRecord(this.records) === undefined ? {} : {
        requestOrdinal: activeRecord(this.records)!.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    this.runtimeEvents.push(event);
  }

  recordToolProgress(
    call: Pick<ToolCall, 'callId' | 'name'>,
    text: string,
    modelStep: number,
    lane?: ProviderEvidenceLane,
  ): void {
    const event: ProviderEvidenceRuntimeEvent = {
      kind: 'tool_progress',
      callId: call.callId,
      name: call.name,
      text,
      modelStep,
      ...(lane === undefined ? {} : { lane }),
      ...(activeRecord(this.records) === undefined ? {} : {
        requestOrdinal: activeRecord(this.records)!.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    const index = this.runtimeEvents.findIndex((existing) =>
      existing.kind === 'tool_progress' && existing.callId === call.callId &&
      existing.name === call.name && existing.modelStep === modelStep &&
      existing.lane === lane && existing.requestOrdinal === event.requestOrdinal
    );
    if (index < 0) this.runtimeEvents.push(event);
    else this.runtimeEvents[index] = event;
  }

  recordToolResult(
    result: ToolResultContent,
    modelStep: number,
    lane?: ProviderEvidenceLane,
  ): void {
    const event: ProviderEvidenceRuntimeEvent = {
      kind: 'tool_result',
      result: cloneValue(result),
      modelStep,
      ...(lane === undefined ? {} : { lane }),
      ...(activeRecord(this.records) === undefined ? {} : {
        requestOrdinal: activeRecord(this.records)!.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    this.runtimeEvents.push(event);
  }

  recordOutcome(outcome: LoopOutcome['stopReason']): void {
    const event: ProviderEvidenceRuntimeEvent = {
      kind: 'turn_outcome',
      outcome,
    };
    this.emitRuntimeObservation(event);
    this.runtimeEvents.push(event);
  }

  private emitRuntimeObservation(event: ProviderEvidenceRuntimeEvent): void {
    this.observationSink?.({
      kind: 'runtime_event',
      ...('requestOrdinal' in event && event.requestOrdinal === undefined
        ? {}
        : 'requestOrdinal' in event
        ? { requestOrdinal: event.requestOrdinal }
        : {}),
      event: structuredClone(event),
    });
  }

  finalize(input: EvidenceFinalize): void {
    this.finalized = {
      outcome: structuredClone(input.outcome),
      ...(input.diagnosticId === undefined ? {} : { diagnosticId: input.diagnosticId }),
    };
    this.recordOutcome(input.outcome.stopReason);
  }

  snapshot(): ProviderEvidenceV1 {
    const outcome = this.finalized?.outcome;
    return structuredClone({
      schemaVersion: 1,
      evidenceId: this.evidenceId,
      turnNumber: this.turnNumber,
      createdAt: this.createdAt,
      requests: this.records.map(materializeRecord),
      runtimeEvents: this.runtimeEvents,
      ...(outcome?.turnProviderRequestCount === undefined ? {} : {
        turnProviderRequestCount: outcome.turnProviderRequestCount,
      }),
      ...(outcome?.runtimeProviderRequestCount === undefined ? {} : {
        runtimeProviderRequestCount: outcome.runtimeProviderRequestCount,
      }),
      ...(outcome === undefined ? {} : { outcome: outcome.stopReason }),
      ...(this.finalized?.diagnosticId === undefined ? {} : {
        diagnosticId: this.finalized.diagnosticId,
      }),
    }) as ProviderEvidenceV1;
  }

  get durability(): ProviderEvidenceDurability {
    if (this.persisted || this.artifactWritten) return 'yes';
    if (this.persistenceError !== undefined) return 'failed';
    return this.store === undefined ? 'unknown' : 'unknown';
  }

  get persistenceErrorCode(): ProviderEvidencePersistenceErrorCode | undefined {
    if (this.persistenceError === undefined) return undefined;
    const code = typeof this.persistenceError === 'object' &&
        this.persistenceError !== null
      ? (this.persistenceError as { readonly code?: unknown }).code
      : undefined;
    return code === 'provider_evidence_not_found' ||
        code === 'provider_evidence_invalid' ||
        code === 'provider_evidence_io_failure'
      ? code
      : 'provider_evidence_io_failure';
  }

  async persist(): Promise<void> {
    if (this.store === undefined || this.persisted) return;
    if (this.persistenceError !== undefined) throw this.persistenceError;
    if (this.finalized === undefined) {
      throw new Error('provider evidence was not finalized');
    }
    if (this.persistence === undefined) {
      this.persistence = this.store.write(this.snapshot()).then(async () => {
        this.artifactWritten = true;
        if (this.finalized?.diagnosticId !== undefined) {
          await this.store!.linkDiagnostic(
            this.finalized.diagnosticId,
            this.evidenceId,
          );
        }
        this.persisted = true;
      }).catch((error) => {
        this.persistenceError = error;
        throw error;
      });
    }
    await this.persistence;
  }
}

const validV4Evidence = (record: Record<string, unknown>): boolean => {
  const baseKeys = [
    'schemaVersion',
    'evidenceId',
    'sessionId',
    'build',
    'definition',
    'turnNumber',
    'createdAt',
    'requests',
    'runtimeEvents',
    'capture',
    'normalizedOutcome',
  ];
  const optionalKeys = [
    'turnProviderRequestCount',
    'runtimeProviderRequestCount',
    'diagnosticId',
  ];
  if (record.capture !== 'complete' && record.capture !== 'partial') {
    return false;
  }
  const complete = record.capture === 'complete';
  const required = complete ? [...baseKeys, 'outcome'] : [...baseKeys, 'settlement'];
  if (
    !hasExactKeys(record, required, optionalKeys) ||
    !UUID_V4.test(String(record.evidenceId)) ||
    !UUID_V4.test(String(record.sessionId)) ||
    !isBuildManifest(record.build) ||
    !isDefinitionRevisionRef(record.definition) ||
    !validPositiveInteger(record.turnNumber) ||
    !validTimestamp(record.createdAt) ||
    !Array.isArray(record.requests) ||
    !record.requests.every(validRequestRecord) ||
    !Array.isArray(record.runtimeEvents) ||
    !record.runtimeEvents.every(validRuntimeEvent)
  ) return false;
  const requests = record
    .requests as unknown as readonly ProviderEvidenceRequestRecord[];
  const runtimeEvents = record
    .runtimeEvents as unknown as readonly ProviderEvidenceRuntimeEvent[];
  if (
    requests.some((request, index) => request.request.ordinal !== index + 1) ||
    runtimeEvents.some((event) =>
      'requestOrdinal' in event && event.requestOrdinal !== undefined &&
      (!validPositiveInteger(event.requestOrdinal) ||
        event.requestOrdinal > requests.length)
    ) ||
    (record.turnProviderRequestCount !== undefined &&
      !validNonNegativeInteger(record.turnProviderRequestCount)) ||
    (record.runtimeProviderRequestCount !== undefined &&
      !validNonNegativeInteger(record.runtimeProviderRequestCount)) ||
    (record.diagnosticId !== undefined &&
      !UUID_V4.test(String(record.diagnosticId)))
  ) return false;
  if (complete) {
    if (
      record.normalizedOutcome !== 'completed' &&
      record.normalizedOutcome !== 'cancelled' &&
      record.normalizedOutcome !== 'failed'
    ) return false;
    if (
      typeof record.outcome !== 'string' ||
      !PROVIDER_STOP_REASONS.includes(
        record.outcome as LoopOutcome['stopReason'],
      ) ||
      normalizedOutcomeForStopReason(
          record.outcome as LoopOutcome['stopReason'],
        ) !== record.normalizedOutcome
    ) return false;
    return !Object.hasOwn(record, 'settlement');
  }
  return (record.normalizedOutcome === 'interrupted' ||
    record.normalizedOutcome === 'unknown') &&
    (record.settlement === 'interrupted' || record.settlement === 'unknown') &&
    !Object.hasOwn(record, 'outcome');
};

const validV5Evidence = (record: Record<string, unknown>): boolean => {
  if (
    !hasExactKeys(record, [
      'schemaVersion',
      'evidenceId',
      'sessionId',
      'build',
      'definition',
      'turnNumber',
      'createdAt',
      'requests',
      'runtimeEvents',
      'capture',
      'normalizedOutcome',
    ], [
      'turnProviderRequestCount',
      'runtimeProviderRequestCount',
      'diagnosticId',
      'outcome',
      'settlement',
    ])
  ) {
    return false;
  }
  const legacy = { ...record, schemaVersion: 4 } as unknown as Record<string, unknown>;
  if (!validV4Evidence(legacy)) return false;
  if (!Array.isArray(record.requests)) return false;
  for (const item of record.requests) {
    const request = (item as Record<string, unknown>).request;
    if (!isRecord(request) || !validPositiveInteger(request.contextRequestOrdinal)) return false;
  }
  return true;
};

/** Structural validation for legacy codecs plus strict nested validation for schema-v2 V4. */
export const validateProviderEvidence = (
  value: unknown,
): value is StoredProviderEvidence => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.schemaVersion !== 2 && record.schemaVersion !== 3 &&
      record.schemaVersion !== 4 && record.schemaVersion !== 5) ||
    typeof record.evidenceId !== 'string' ||
    typeof record.sessionId !== 'string' || record.sessionId.length === 0 ||
    !isBuildManifest(record.build) ||
    !isDefinitionRevisionRef(record.definition) ||
    typeof record.turnNumber !== 'number' ||
    typeof record.createdAt !== 'string' ||
    !Array.isArray(record.requests) || !Array.isArray(record.runtimeEvents)
  ) return false;
  return record.schemaVersion === 4
    ? validV4Evidence(record)
    : record.schemaVersion === 5
    ? validV5Evidence(record)
    : true;
};

/** Strict validation for the Worker-local V1 envelope before Host journal storage. */
export const validateProviderEvidenceV1 = (
  value: unknown,
): value is ProviderEvidenceV1 => {
  if (!isRecord(value)) return false;
  const required = [
    'schemaVersion',
    'evidenceId',
    'turnNumber',
    'createdAt',
    'requests',
    'runtimeEvents',
  ];
  const optional = [
    'turnProviderRequestCount',
    'runtimeProviderRequestCount',
    'outcome',
    'diagnosticId',
  ];
  if (
    !hasExactKeys(value, required, optional) || value.schemaVersion !== 1 ||
    !UUID_V4.test(String(value.evidenceId)) ||
    !validPositiveInteger(value.turnNumber) || !validTimestamp(value.createdAt) ||
    !Array.isArray(value.requests) || !value.requests.every(validRequestRecord) ||
    !Array.isArray(value.runtimeEvents) || !value.runtimeEvents.every(validRuntimeEvent) ||
    value.requests.some((request, index) => request.request.ordinal !== index + 1) ||
    (value.turnProviderRequestCount !== undefined &&
      !validNonNegativeInteger(value.turnProviderRequestCount)) ||
    (value.runtimeProviderRequestCount !== undefined &&
      !validNonNegativeInteger(value.runtimeProviderRequestCount)) ||
    (value.outcome !== undefined &&
      !PROVIDER_STOP_REASONS.includes(value.outcome as LoopOutcome['stopReason'])) ||
    (value.diagnosticId !== undefined && !UUID_V4.test(String(value.diagnosticId)))
  ) return false;
  return true;
};

export const encodeProviderEvidence = (
  value: StoredProviderEvidence,
): string => {
  if (!validateProviderEvidence(value)) {
    throw new TypeError('invalid provider evidence');
  }
  return JSON.stringify(value);
};

export const decodeProviderEvidence = (
  value: string | Uint8Array,
): StoredProviderEvidence => {
  let text: string;
  try {
    text = typeof value === 'string'
      ? value
      : new TextDecoder('utf-8', { fatal: true }).decode(value);
    const parsed: unknown = JSON.parse(
      text.endsWith('\n') ? text.slice(0, -1) : text,
    );
    if (!validateProviderEvidence(parsed)) {
      throw new Error('invalid provider evidence');
    }
    return structuredClone(parsed);
  } catch {
    throw new TypeError('invalid provider evidence');
  }
};

export class FakeProviderEvidenceStore implements ProviderEvidenceStore {
  private readonly records = new Map<string, StoredProviderEvidence>();
  private readonly links = new Map<string, string>();
  private writeFailure?: Error;
  private linkFailure?: Error;

  failWrites(error = new Error('provider evidence I/O failure')): void {
    this.writeFailure = error;
  }

  failLinks(error = new Error('provider evidence link failure')): void {
    this.linkFailure = error;
  }

  async list(): Promise<readonly StoredProviderEvidence[]> {
    await Promise.resolve();
    return [...this.records.values()].map((value) => structuredClone(value));
  }

  async read(id: string): Promise<StoredProviderEvidence> {
    await Promise.resolve();
    const value = this.records.get(id);
    if (value === undefined) {
      throw Object.assign(new Error('provider evidence not found'), {
        code: 'provider_evidence_not_found',
      });
    }
    return structuredClone(value);
  }

  async write(evidence: StoredProviderEvidence): Promise<void> {
    await Promise.resolve();
    if (this.writeFailure !== undefined) throw this.writeFailure;
    if (!validateProviderEvidence(evidence)) {
      throw Object.assign(new Error('invalid provider evidence'), {
        code: 'provider_evidence_invalid',
      });
    }
    this.records.set(evidence.evidenceId, structuredClone(evidence));
  }

  async linkDiagnostic(
    diagnosticId: string,
    evidenceId: string,
  ): Promise<void> {
    await Promise.resolve();
    if (this.linkFailure !== undefined) throw this.linkFailure;
    if (!this.records.has(evidenceId)) {
      throw Object.assign(new Error('provider evidence not found'), {
        code: 'provider_evidence_not_found',
      });
    }
    this.links.set(diagnosticId, evidenceId);
  }

  async readDiagnosticLink(diagnosticId: string): Promise<string> {
    await Promise.resolve();
    const value = this.links.get(diagnosticId);
    if (value === undefined) {
      throw Object.assign(new Error('provider evidence not found'), {
        code: 'provider_evidence_not_found',
      });
    }
    return value;
  }
}

/** In-memory compatibility seam for direct AgentSession/provider contract tests. */
export class FakeProviderEvidenceDraftStore implements ProviderEvidenceDraftStore {
  private readonly records = new Map<string, ProviderEvidenceV1>();
  private readonly links = new Map<string, string>();
  private writeFailure?: Error;
  private linkFailure?: Error;

  failWrites(error = new Error('provider evidence I/O failure')): void {
    this.writeFailure = error;
  }

  failLinks(error = new Error('provider evidence link failure')): void {
    this.linkFailure = error;
  }

  async list(): Promise<readonly ProviderEvidenceV1[]> {
    await Promise.resolve();
    return [...this.records.values()].map((value) => structuredClone(value));
  }

  async read(id: string): Promise<ProviderEvidenceV1> {
    await Promise.resolve();
    const value = this.records.get(id);
    if (value === undefined) {
      throw Object.assign(new Error('provider evidence not found'), {
        code: 'provider_evidence_not_found',
      });
    }
    return structuredClone(value);
  }

  async write(evidence: ProviderEvidenceV1): Promise<void> {
    await Promise.resolve();
    if (this.writeFailure !== undefined) throw this.writeFailure;
    if (evidence.schemaVersion !== 1) {
      throw Object.assign(new Error('invalid provider evidence draft'), {
        code: 'provider_evidence_invalid',
      });
    }
    this.records.set(evidence.evidenceId, structuredClone(evidence));
  }

  async linkDiagnostic(
    diagnosticId: string,
    evidenceId: string,
  ): Promise<void> {
    await Promise.resolve();
    if (this.linkFailure !== undefined) throw this.linkFailure;
    if (!this.records.has(evidenceId)) {
      throw Object.assign(new Error('provider evidence not found'), {
        code: 'provider_evidence_not_found',
      });
    }
    this.links.set(diagnosticId, evidenceId);
  }

  async readDiagnosticLink(diagnosticId: string): Promise<string> {
    await Promise.resolve();
    const value = this.links.get(diagnosticId);
    if (value === undefined) {
      throw Object.assign(new Error('provider evidence not found'), {
        code: 'provider_evidence_not_found',
      });
    }
    return value;
  }
}
