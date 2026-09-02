import type {
  JsonValue,
  LoopOutcome,
  ModelResult,
  ToolCall,
  ToolResultContent,
} from './contracts.ts';

/** One retained exchange is owned by one accepted parent turn. */
export const PROVIDER_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type ProviderEvidenceLane = 'parent' | 'planner';
export type ProviderEvidenceDurability = 'yes' | 'failed' | 'unknown';
export type ProviderEvidencePersistenceErrorCode =
  | 'provider_evidence_not_found'
  | 'provider_evidence_invalid'
  | 'provider_evidence_io_failure';

export interface ProviderEvidenceRequest {
  readonly ordinal: number;
  readonly lane: ProviderEvidenceLane;
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
  | { readonly kind: 'model_result'; readonly result: ModelResult; readonly modelStep: number }
  | { readonly kind: 'tool_call'; readonly call: ToolCall; readonly modelStep: number }
  | { readonly kind: 'tool_result'; readonly result: ToolResultContent; readonly modelStep: number }
  | { readonly kind: 'turn_outcome'; readonly outcome: LoopOutcome['stopReason'] };

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

export interface ProviderEvidenceStore {
  list(): Promise<readonly ProviderEvidenceV1[]>;
  read(id: string): Promise<ProviderEvidenceV1>;
  write(evidence: ProviderEvidenceV1): Promise<void>;
  linkDiagnostic(diagnosticId: string, evidenceId: string): Promise<void>;
  readDiagnosticLink(diagnosticId: string): Promise<string>;
}

export interface EvidenceRequestStart {
  readonly lane: ProviderEvidenceLane;
  readonly modelStep: number;
  readonly endpoint: string;
  readonly method: 'POST';
  readonly requestBody: string;
  readonly requestMetadata?: ProviderEvidenceRequestMetadata;
}

export interface EvidenceResponseStart {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface EvidenceFinalize {
  readonly outcome: LoopOutcome;
  readonly diagnosticId?: string;
}

const encoder = new TextEncoder();

const cloneValue = <T>(value: T): T => structuredClone(value);

const base64 = (value: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < value.length; index += 1) {
    binary += String.fromCharCode(value[index]);
  }
  return btoa(binary);
};

const cloneRequest = (request: ProviderEvidenceRequest): ProviderEvidenceRequest => ({
  ...request,
  requestMetadata: cloneValue(request.requestMetadata),
});

const cloneRecord = (record: ProviderEvidenceRequestRecord): ProviderEvidenceRequestRecord => ({
  request: cloneRequest(record.request),
  ...(record.response === undefined ? {} : {
    response: {
      ...record.response,
      headers: { ...record.response.headers },
    },
  }),
  sseEvents: record.sseEvents.map((event) => ({
    ...event,
    ...(event.parsed === undefined ? {} : { parsed: cloneValue(event.parsed) }),
  })),
  parserTransitions: record.parserTransitions.map((transition) => ({
    ...transition,
    ...(transition.detail === undefined ? {} : { detail: cloneValue(transition.detail) }),
  })),
});

interface MutableProviderEvidenceRequestRecord {
  readonly request: ProviderEvidenceRequest;
  response?: ProviderEvidenceResponse;
  readonly rawBytes: Uint8Array[];
  readonly sseEvents: ProviderEvidenceSseEvent[];
  readonly parserTransitions: ProviderEvidenceParserTransition[];
}

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
  private persisted = false;

  constructor(
    readonly evidenceId = crypto.randomUUID().toLowerCase(),
    readonly turnNumber = 1,
    readonly createdAt = new Date().toISOString(),
    private readonly store?: ProviderEvidenceStore,
  ) {}

  startRequest(input: EvidenceRequestStart): number {
    const ordinal = this.records.length + 1;
    const request: ProviderEvidenceRequest = {
      ordinal,
      lane: input.lane,
      modelStep: input.modelStep,
      endpoint: input.endpoint,
      method: input.method,
      requestBody: input.requestBody,
      requestBodyBytes: encoder.encode(input.requestBody).byteLength,
      requestMetadata: { ...(input.requestMetadata ?? {}) },
    };
    this.records.push({ request, rawBytes: [], sseEvents: [], parserTransitions: [] });
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
  }

  appendResponseBytes(bytes: Uint8Array): void {
    const record = activeRecord(this.records);
    if (record === undefined) return;
    const response = record.response;
    if (response === undefined) return;
    record.rawBytes.push(bytes.slice());
    const all = new Uint8Array(record.rawBytes.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of record.rawBytes) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    record.response = {
      ...response,
      rawBody: new TextDecoder().decode(all),
      rawBodyBase64: base64(all),
      rawBodyBytes: all.byteLength,
    };
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
    return ordinal;
  }

  recordParserTransition(transition: Omit<ProviderEvidenceParserTransition, 'ordinal'>): void {
    const record = activeRecord(this.records);
    if (record === undefined) return;
    record.parserTransitions.push({
      ordinal: record.parserTransitions.length + 1,
      ...transition,
      ...(transition.detail === undefined ? {} : { detail: cloneValue(transition.detail) }),
    });
  }

  recordModelResult(result: ModelResult, modelStep: number): void {
    this.runtimeEvents.push({ kind: 'model_result', result: cloneValue(result), modelStep });
  }

  recordToolCall(call: ToolCall, modelStep: number): void {
    this.runtimeEvents.push({ kind: 'tool_call', call: cloneValue(call), modelStep });
  }

  recordToolResult(result: ToolResultContent, modelStep: number): void {
    this.runtimeEvents.push({ kind: 'tool_result', result: cloneValue(result), modelStep });
  }

  recordOutcome(outcome: LoopOutcome['stopReason']): void {
    this.runtimeEvents.push({ kind: 'turn_outcome', outcome });
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
      requests: this.records.map(cloneRecord),
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
    if (this.persisted) return 'yes';
    if (this.persistenceError !== undefined) return 'failed';
    return this.store === undefined ? 'unknown' : 'unknown';
  }

  get persistenceErrorCode(): ProviderEvidencePersistenceErrorCode | undefined {
    if (this.persistenceError === undefined) return undefined;
    const code = typeof this.persistenceError === 'object' && this.persistenceError !== null
      ? (this.persistenceError as { readonly code?: unknown }).code
      : undefined;
    return code === 'provider_evidence_not_found' || code === 'provider_evidence_invalid' ||
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
        if (this.finalized?.diagnosticId !== undefined) {
          await this.store!.linkDiagnostic(this.finalized.diagnosticId, this.evidenceId);
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

/** Structural validation is intentionally about the evidence envelope, not provider variants. */
export const validateProviderEvidence = (value: unknown): value is ProviderEvidenceV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 || typeof record.evidenceId !== 'string' ||
    typeof record.turnNumber !== 'number' || typeof record.createdAt !== 'string' ||
    !Array.isArray(record.requests) || !Array.isArray(record.runtimeEvents)
  ) return false;
  return true;
};

export const encodeProviderEvidence = (value: ProviderEvidenceV1): string => {
  if (!validateProviderEvidence(value)) throw new TypeError('invalid provider evidence');
  return JSON.stringify(value);
};

export const decodeProviderEvidence = (value: string | Uint8Array): ProviderEvidenceV1 => {
  let text: string;
  try {
    text = typeof value === 'string'
      ? value
      : new TextDecoder('utf-8', { fatal: true }).decode(value);
    const parsed: unknown = JSON.parse(text.endsWith('\n') ? text.slice(0, -1) : text);
    if (!validateProviderEvidence(parsed)) throw new Error('invalid provider evidence');
    return structuredClone(parsed);
  } catch {
    throw new TypeError('invalid provider evidence');
  }
};

export class FakeProviderEvidenceStore implements ProviderEvidenceStore {
  private readonly records = new Map<string, ProviderEvidenceV1>();
  private readonly links = new Map<string, string>();
  private writeFailure?: Error;

  failWrites(error = new Error('provider evidence I/O failure')): void {
    this.writeFailure = error;
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
    if (!validateProviderEvidence(evidence)) {
      throw Object.assign(new Error('invalid provider evidence'), {
        code: 'provider_evidence_invalid',
      });
    }
    this.records.set(evidence.evidenceId, structuredClone(evidence));
  }

  async linkDiagnostic(diagnosticId: string, evidenceId: string): Promise<void> {
    await Promise.resolve();
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
