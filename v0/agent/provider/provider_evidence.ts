import type { LoopOutcome, ModelResult, ToolCall, ToolResultContent } from '../core/contracts.ts';
import { isAuthProfileId, type ReasoningEffort } from './model_selection.ts';
import { isJsonValue } from './openrouter_value.ts';

export type ProviderEvidenceLane = 'parent' | 'planner';
/** Identifies whether a retained request belongs to compaction or the user turn. */
export type ProviderEvidencePhase = 'user_turn' | 'compaction';

export interface ProviderEvidenceRequest {
  readonly ordinal: number;
  readonly contextRequestOrdinal?: number;
  readonly lane: ProviderEvidenceLane;
  readonly phase?: ProviderEvidencePhase;
  readonly modelStep: number;
  readonly endpoint: string;
  readonly method: 'POST';
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
  readonly api?:
    | 'openrouter-chat-completions'
    | 'openrouter-responses'
    | 'openai-chat-completions'
    | 'openai-responses';
  readonly modelId?: string;
  readonly effort?: ReasoningEffort;
  readonly authProfile?: string;
  readonly protocol?: 'json' | 'sse';
}

export interface ProviderEvidenceResponse {
  readonly status: number;
}

export interface ProviderEvidenceParserTransition {
  readonly ordinal: number;
  readonly kind: 'failure';
  readonly reason?: string;
  readonly field?: string;
  readonly expectedShape?: string;
  readonly actualShape?: string;
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

export interface EvidenceRequestMetadataStart {
  readonly lane: ProviderEvidenceLane;
  readonly phase?: ProviderEvidencePhase;
  readonly modelStep: number;
  readonly endpoint: string;
  readonly method: 'POST';
  readonly requestMetadata?: ProviderEvidenceRequestMetadata;
  /** Logical context request ordinal when available. */
  readonly contextRequestOrdinal?: number;
}

export interface EvidenceResponseStart {
  readonly status: number;
}

export interface ProviderRequestFailureFact {
  readonly stage: string;
  readonly code: string;
  readonly httpStatus?: number;
  readonly parseReason?: string;
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
    readonly kind: 'parser_transition';
    readonly requestOrdinal: number;
    readonly transition: ProviderEvidenceParserTransition;
  }
  | {
    readonly kind: 'request_failure';
    readonly requestOrdinal: number;
    readonly failure: ProviderRequestFailureFact;
  }
  | {
    /** Runtime facts are sent live as well as retained in the completed evidence envelope. */
    readonly kind: 'runtime_event';
    readonly requestOrdinal?: number;
    readonly event: ProviderEvidenceRuntimeEvent;
  };

const cloneValue = <T>(value: T): T => structuredClone(value);

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
const validPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const validText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');
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
      record.api === 'openrouter-responses' ||
      record.api === 'openai-chat-completions' ||
      record.api === 'openai-responses') &&
    (record.modelId === undefined || validText(record.modelId)) &&
    (record.effort === undefined || record.effort === 'auto' ||
      record.effort === 'none' ||
      record.effort === 'minimal' ||
      record.effort === 'low' || record.effort === 'medium' ||
      record.effort === 'high' || record.effort === 'xhigh' ||
      record.effort === 'max') &&
    (record.authProfile === undefined || isAuthProfileId(record.authProfile)) &&
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
    isRecord(value) && typeof value.provider === 'string' && value.provider.length > 0 &&
    hasExactKeys(value, ['provider'], ['model', 'reasoning', 'reasoningDetails']) &&
    (value.model === undefined || typeof value.model === 'string' && value.model.length > 0) &&
    (value.reasoning === undefined ||
      isRecord(value.reasoning) &&
        hasExactKeys(value.reasoning, ['field', 'text']) &&
        (value.reasoning.field === 'reasoning' ||
          value.reasoning.field === 'reasoning_content') &&
        typeof value.reasoning.text === 'string' && value.reasoning.text.length > 0) &&
    (value.reasoningDetails === undefined ||
      Array.isArray(value.reasoningDetails) && value.reasoningDetails.length > 0 &&
        value.reasoningDetails.every(isJsonValue)) &&
    (value.reasoning !== undefined || value.reasoningDetails !== undefined)
  ) || (
    isRecord(value) && typeof value.provider === 'string' &&
    value.provider.length > 0 &&
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
    ['final', 'tool_terminal', 'max_steps', 'contract_failure', 'cancelled', 'interrupted']
      .includes(value.outcome);
};
const validRequest = (value: unknown): value is ProviderEvidenceRequest => {
  if (
    !hasExactKeys(value, [
      'ordinal',
      'lane',
      'modelStep',
      'endpoint',
      'method',
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
    validProviderMetadata(value.requestMetadata);
};
const validParserTransition = (
  value: unknown,
): value is ProviderEvidenceParserTransition =>
  hasExactKeys(value, ['ordinal', 'kind'], [
    'reason',
    'field',
    'expectedShape',
    'actualShape',
  ]) &&
  validPositiveInteger(value.ordinal) && value.kind === 'failure' &&
  (value.reason === undefined || typeof value.reason === 'string') &&
  (value.field === undefined || typeof value.field === 'string') &&
  (value.expectedShape === undefined || typeof value.expectedShape === 'string') &&
  (value.actualShape === undefined || typeof value.actualShape === 'string');

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
      hasExactKeys(response, ['status']) &&
      typeof response.status === 'number' &&
      Number.isInteger(response.status) && response.status >= 100 &&
      response.status <= 599;
  }
  if (value.kind === 'parser_transition') {
    return hasExactKeys(value, ['kind', 'requestOrdinal', 'transition']) &&
      validPositiveInteger(value.requestOrdinal) &&
      validParserTransition(value.transition);
  }
  if (value.kind === 'request_failure') {
    return hasExactKeys(value, ['kind', 'requestOrdinal', 'failure']) &&
      validPositiveInteger(value.requestOrdinal) &&
      hasExactKeys(value.failure, ['stage', 'code'], [
        'httpStatus',
        'parseReason',
      ]) &&
      typeof value.failure.stage === 'string' &&
      typeof value.failure.code === 'string' &&
      (value.failure.httpStatus === undefined ||
        Number.isInteger(value.failure.httpStatus)) &&
      (value.failure.parseReason === undefined ||
        typeof value.failure.parseReason === 'string');
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
  readonly parserTransitions: ProviderEvidenceParserTransition[];
}

const materializeRecord = (
  record: MutableProviderEvidenceRequestRecord,
): ProviderEvidenceRequestRecord => ({
  request: cloneRequest(record.request),
  ...(record.response === undefined ? {} : { response: { ...record.response } }),
  parserTransitions: record.parserTransitions.map((transition) => ({ ...transition })),
});

/**
 * Short request fact and semantic observation recorder. It has no credential/header input.
 * Runtime and provider layers share this instance for parent and planner requests.
 */
export class ProviderEvidenceRecorder {
  private readonly records: MutableProviderEvidenceRequestRecord[] = [];
  private activeRequest?: MutableProviderEvidenceRequestRecord;
  private requestOrdinal = 0;
  private parserTransitionOrdinal = 0;
  private readonly runtimeEvents: ProviderEvidenceRuntimeEvent[] = [];
  private finalized?: EvidenceFinalize;
  private contextRequestOrdinal?: number;

  constructor(
    readonly evidenceId: string = crypto.randomUUID().toLowerCase(),
    readonly turnNumber = 1,
    readonly createdAt: string = new Date().toISOString(),
    private readonly observationSink?: (
      observation: ProviderEvidenceObservation,
    ) => number | undefined,
    private readonly retainSnapshot = true,
  ) {}

  setContextRequestOrdinal(ordinal: number | undefined): void {
    this.contextRequestOrdinal = ordinal;
  }

  startRequestMetadata(input: EvidenceRequestMetadataStart): number {
    const ordinal = ++this.requestOrdinal;
    const request: ProviderEvidenceRequest = {
      ordinal,
      lane: input.lane,
      ...(input.phase === undefined ? {} : { phase: input.phase }),
      modelStep: input.modelStep,
      endpoint: input.endpoint,
      method: input.method,
      requestMetadata: { ...(input.requestMetadata ?? {}) },
      ...(input.contextRequestOrdinal === undefined &&
          this.contextRequestOrdinal === undefined
        ? {}
        : {
          contextRequestOrdinal: input.contextRequestOrdinal ??
            this.contextRequestOrdinal,
        }),
    };
    const record: MutableProviderEvidenceRequestRecord = {
      request,
      parserTransitions: [],
    };
    this.activeRequest = record;
    this.parserTransitionOrdinal = 0;
    if (this.retainSnapshot) this.records.push(record);
    this.observationSink?.({
      kind: 'request_start',
      request: cloneRequest(request),
    });
    return ordinal;
  }

  recordResponse(response: EvidenceResponseStart): void {
    const record = this.activeRequest;
    if (record === undefined) return;
    if (this.retainSnapshot) record.response = { status: response.status };
    this.observationSink?.({
      kind: 'response_start',
      requestOrdinal: record.request.ordinal,
      response: { status: response.status },
    });
  }

  recordRequestFailure(failure: ProviderRequestFailureFact, modelStep?: number): void {
    const record = this.activeRequest;
    if (record === undefined || modelStep !== undefined && record.request.modelStep !== modelStep) {
      return;
    }
    this.observationSink?.({
      kind: 'request_failure',
      requestOrdinal: record.request.ordinal,
      failure,
    });
  }

  recordParserTransition(
    transition: Omit<ProviderEvidenceParserTransition, 'ordinal'>,
  ): void {
    const record = this.activeRequest;
    if (record === undefined) return;
    const concise: ProviderEvidenceParserTransition = {
      ordinal: ++this.parserTransitionOrdinal,
      kind: 'failure',
      ...(transition.reason === undefined ? {} : { reason: transition.reason }),
      ...(transition.field === undefined ? {} : { field: transition.field }),
      ...(transition.expectedShape === undefined ? {} : {
        expectedShape: transition.expectedShape,
      }),
      ...(transition.actualShape === undefined ? {} : {
        actualShape: transition.actualShape,
      }),
    };
    if (this.retainSnapshot) record.parserTransitions.push(concise);
    this.observationSink?.({
      kind: 'parser_transition',
      requestOrdinal: record.request.ordinal,
      transition: concise,
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
      ...(this.activeRequest === undefined ? {} : {
        requestOrdinal: this.activeRequest.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    if (!this.retainSnapshot) return;
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
      ...(this.activeRequest === undefined ? {} : {
        requestOrdinal: this.activeRequest.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    if (this.retainSnapshot) this.runtimeEvents.push(event);
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
      ...(this.activeRequest === undefined ? {} : {
        requestOrdinal: this.activeRequest.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    if (this.retainSnapshot) this.runtimeEvents.push(event);
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
      ...(this.activeRequest === undefined ? {} : {
        requestOrdinal: this.activeRequest.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    if (!this.retainSnapshot) return;
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
      ...(this.activeRequest === undefined ? {} : {
        requestOrdinal: this.activeRequest.request.ordinal,
      }),
    };
    this.emitRuntimeObservation(event);
    if (this.retainSnapshot) this.runtimeEvents.push(event);
  }

  recordOutcome(outcome: LoopOutcome['stopReason']): void {
    const event: ProviderEvidenceRuntimeEvent = {
      kind: 'turn_outcome',
      outcome,
    };
    this.emitRuntimeObservation(event);
    if (this.retainSnapshot) this.runtimeEvents.push(event);
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
}
