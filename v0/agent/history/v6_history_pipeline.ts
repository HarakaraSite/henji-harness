import type {
  JsonValue,
  ProviderExactRequestObservation,
  ProviderExactRequestObserver,
} from '../core/contracts.ts';
import type {
  ProviderEvidenceObservation,
  ProviderEvidenceRuntimeEvent,
} from '../provider/provider_evidence.ts';
import {
  canonicalJsonBytes,
  CONTEXT_ATTRIBUTION_SCHEMA_VERSION,
  type ContextModelRequestDelta,
  validateContextModelRequestDelta,
} from './context_attribution.ts';
import {
  addHistoryLogicalCost,
  emptyHistoryLogicalCost,
  type HistoryLogicalCost,
} from './history_authority.ts';
import type { HistoryLogicalRecord, HistoryResourceAttribution } from './history_record_codec.ts';
import type { StoredExecutionEvent } from './history_store_contract.ts';
import { type ExactBytePlan, validatedExactByteObjectRef } from './exact_byte_plan.ts';
import {
  type HistoryV6AppendReceipt,
  type HistoryV6ByteStreamInput,
  type HistoryV6ExactObjectInput,
  type HistoryV6SequenceRevisionInput,
  SqliteHistoryV6Store,
} from './sqlite_history_v6_store.ts';
import { type PersistentSequenceRoot, PersistentSequenceStore } from './persistent_sequence.ts';

interface CapturedRequest {
  readonly recordId: string;
  readonly byteLength: number;
  readonly endpoint: string;
  readonly method: 'POST';
  readonly lane: 'parent' | 'planner';
  readonly phase: 'user_turn' | 'compaction';
  readonly modelStep: number;
}

export interface IsolatedV6HistoryPipelineOptions {
  readonly now?: () => string;
  readonly maxPendingRecords?: number;
}

const json = <T>(value: T): JsonValue => structuredClone(value) as JsonValue;
const providerHistoryEventEnvelope = (
  historyEvent: StoredExecutionEvent | undefined,
): StoredExecutionEvent | undefined => {
  if (historyEvent === undefined) return undefined;
  const payload = historyEvent.payload;
  if (
    typeof payload !== 'object' || payload === null || Array.isArray(payload)
  ) return historyEvent;
  const objectPayload = payload as Record<string, JsonValue>;
  if (
    objectPayload.kind !== 'provider_observation' ||
    !('observation' in objectPayload)
  ) return historyEvent;
  const { observation: _observation, ...envelope } = objectPayload;
  return {
    ...historyEvent,
    payload: json(envelope),
  };
};
const contextDigestSync = (value: JsonValue): string =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
const occurrenceDigestSync = (
  occurrence: ContextModelRequestDelta['occurrences'][number],
): string =>
  contextDigestSync({
    occurrenceId: occurrence.occurrenceId,
    kind: occurrence.kind,
    content: occurrence.content,
    sourceRelations: occurrence.sourceRelations.map((source) => ({
      ...source,
      contentDigest: source.contentDigest ?? occurrence.content.digest,
    })),
  } as unknown as JsonValue);
const revisionDigestSync = (delta: ContextModelRequestDelta): string =>
  contextDigestSync({
    schemaVersion: CONTEXT_ATTRIBUTION_SCHEMA_VERSION,
    lane: delta.lane,
    sequenceKind: delta.purpose,
    baseRevisionDigest: delta.baseRevisionDigest ?? null,
    splices: delta.splices,
    resultItemCount: delta.resultItemCount,
  } as unknown as JsonValue);

/**
 * Slice-D bridge from live provider facts to the isolated v6 authority store.
 * It is deliberately not connected to the production runtime graph yet.
 */
export class IsolatedV6HistoryPipeline {
  readonly observeExactRequest: ProviderExactRequestObserver;
  readonly #now: () => string;
  readonly #maxPendingRecords: number;
  readonly #requestRecords = new Map<number, string>();
  readonly #lastRequestRecord = new Map<number, string>();
  readonly #unmatchedRequests: CapturedRequest[] = [];
  readonly #sequences = new PersistentSequenceStore();
  readonly #sequenceRoots = new Map<
    string,
    {
      readonly root: PersistentSequenceRoot;
      readonly lane: ContextModelRequestDelta['lane'];
      readonly purpose: ContextModelRequestDelta['purpose'];
    }
  >();
  readonly #durableSequenceNodes = new Set<string>();
  readonly #occurrences = new Map<
    string,
    { readonly occurrenceDigest: string; readonly contentDigest: string }
  >();
  #objects: HistoryV6ExactObjectInput[] = [];
  #byteStreams: HistoryV6ByteStreamInput[] = [];
  #sequenceRevisions: HistoryV6SequenceRevisionInput[] = [];
  #records: HistoryLogicalRecord[] = [];
  #latestOrdinal: number;
  #nextContextRequestOrdinal = 1;
  #lastExecutionRecord?: string;
  #terminalRecordId?: string;
  #cost = emptyHistoryLogicalCost();

  constructor(
    readonly store: SqliteHistoryV6Store,
    readonly executionId: string,
    options: IsolatedV6HistoryPipelineOptions = {},
  ) {
    const ledger = store.readLedger(executionId);
    if (
      ledger.lifecycle !== 'active' || ledger.terminalRecordId !== undefined
    ) {
      throw new Error('v6 pipeline requires an active unterminated execution');
    }
    this.#latestOrdinal = ledger.latestOrdinal;
    if (ledger.latestOrdinal > 0) {
      const latest = store.latestRecordMetadata(executionId);
      if (latest === undefined || latest.ordinal !== ledger.latestOrdinal) {
        throw new Error(
          'v6 pipeline cannot resolve the durable execution tail',
        );
      }
      this.#lastExecutionRecord = latest.recordId;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxPendingRecords = options.maxPendingRecords ?? 128;
    if (
      !Number.isSafeInteger(this.#maxPendingRecords) ||
      this.#maxPendingRecords < 1
    ) {
      throw new TypeError('invalid v6 pipeline batch size');
    }
    this.observeExactRequest = (observation) => this.#captureExactRequest(observation);
  }

  get logicalCost(): HistoryLogicalCost {
    return this.#cost;
  }

  observeProviderObservation = (
    observation: ProviderEvidenceObservation,
    historyEvent?: StoredExecutionEvent,
  ): number | undefined => {
    const eventEnvelope = providerHistoryEventEnvelope(historyEvent);
    if (observation.kind === 'request_start') {
      return this.#matchRequestStart(observation.request, eventEnvelope);
    }
    if (observation.kind === 'response_start') {
      return this.#appendObservationRecord(
        observation.requestOrdinal,
        'transport_observation',
        'transport_response_chunk',
        json({
          occurrence: 'response_start',
          requestOrdinal: observation.requestOrdinal,
          status: observation.response.status,
          headers: observation.response.headers,
          ...(eventEnvelope === undefined ? {} : { historyEvent: eventEnvelope }),
        }),
      );
    }
    if (observation.kind === 'response_bytes') {
      const bytes = Uint8Array.fromBase64(observation.bytesBase64);
      const ref = validatedExactByteObjectRef(bytes);
      const endOffset = observation.offset;
      const startOffset = endOffset - bytes.byteLength;
      if (startOffset < 0) {
        throw new Error('provider response byte offset regressed');
      }
      return this.#appendObservationRecord(
        observation.requestOrdinal,
        'transport_observation',
        'transport_response_chunk',
        json({
          occurrence: 'response_bytes',
          requestOrdinal: observation.requestOrdinal,
          startOffset,
          endOffset,
          byteLength: bytes.byteLength,
          digest: ref.digest,
          ...(eventEnvelope === undefined ? {} : { historyEvent: eventEnvelope }),
        }),
        [{ bytes, validatedRef: ref }],
        [ref.digest],
      );
    }
    if (observation.kind === 'sse_event') {
      const rawFrame = new TextEncoder().encode(observation.event.rawFrame);
      const ref = validatedExactByteObjectRef(rawFrame);
      return this.#appendObservationRecord(
        observation.requestOrdinal,
        'contemporaneous_interpretation',
        'sse_event',
        json({
          occurrence: 'sse_event',
          requestOrdinal: observation.requestOrdinal,
          eventOrdinal: observation.event.ordinal,
          data: observation.event.data,
          responseBodyOffset: observation.event.responseBodyOffset,
          rawFrameBytes: observation.event.rawFrameBytes,
          ...(observation.event.parsed === undefined ? {} : { parsed: observation.event.parsed }),
          ...(eventEnvelope === undefined ? {} : { historyEvent: eventEnvelope }),
        }),
        [{ bytes: rawFrame, validatedRef: ref }],
        [ref.digest],
      );
    }
    if (observation.kind === 'parser_transition') {
      return this.#appendObservationRecord(
        observation.requestOrdinal,
        'contemporaneous_interpretation',
        'parser_transition',
        json({
          occurrence: 'parser_transition',
          requestOrdinal: observation.requestOrdinal,
          transition: observation.transition,
          ...(eventEnvelope === undefined ? {} : { historyEvent: eventEnvelope }),
        }),
      );
    }
    return this.#appendRuntimeEvent(
      observation.requestOrdinal,
      observation.event,
      eventEnvelope,
    );
  };

  observeStoredEvent(event: StoredExecutionEvent, terminal = false): number {
    return this.#appendObservationRecord(
      undefined,
      event.source === 'host' ? 'host_decision' : 'contemporaneous_interpretation',
      event.kind === 'effect_observation' ? 'tool_event' : 'runtime_event',
      json({ occurrence: 'execution_event', historyEvent: event }),
      [],
      [],
      terminal,
    );
  }

  /** Applies Increment 89's current delta directly to a path-copied sequence root. */
  observeContextDelta(
    delta: ContextModelRequestDelta,
    historyEvent?: StoredExecutionEvent,
  ): number {
    if (
      !validateContextModelRequestDelta(delta) ||
      delta.requestOrdinal !== this.#nextContextRequestOrdinal ||
      revisionDigestSync(delta) !== delta.revisionDigest
    ) throw new Error('invalid v6 context delta');
    this.flush();
    let parentRoot: PersistentSequenceRoot;
    if (delta.baseRevisionDigest === undefined) {
      parentRoot = null;
    } else {
      const resolved = this.#sequenceRoots.get(delta.baseRevisionDigest);
      if (
        resolved === undefined || resolved.lane !== delta.lane ||
        resolved.purpose !== delta.purpose
      ) throw new Error('v6 context base revision is unknown');
      parentRoot = resolved.root;
    }

    const objects: HistoryV6ExactObjectInput[] = [];
    for (const occurrence of delta.occurrences) {
      if (
        this.#occurrences.has(occurrence.occurrenceId) ||
        occurrenceDigestSync(occurrence) !== occurrence.occurrenceDigest
      ) throw new Error('invalid v6 context occurrence');
      if (occurrence.bytesBase64 !== undefined) {
        const occurrenceBytes = Uint8Array.fromBase64(occurrence.bytesBase64);
        const ref = validatedExactByteObjectRef(occurrenceBytes);
        if (
          ref.digest !== occurrence.content.digest ||
          ref.byteLength !== occurrence.content.byteLength
        ) {
          throw new Error(
            'v6 context occurrence bytes do not match descriptor',
          );
        }
        objects.push({ bytes: occurrenceBytes, validatedRef: ref });
      }
      this.#occurrences.set(occurrence.occurrenceId, {
        occurrenceDigest: occurrence.occurrenceDigest,
        contentDigest: occurrence.content.digest,
      });
    }

    let root = parentRoot;
    for (const splice of delta.splices) {
      for (const insertion of splice.insertions) {
        const occurrence = this.#occurrences.get(insertion.occurrenceId);
        if (
          occurrence === undefined ||
          occurrence.occurrenceDigest !== insertion.occurrenceDigest
        ) throw new Error('v6 context splice occurrence is unresolved');
      }
      root = this.#sequences.splice(
        root,
        splice.start,
        splice.deleteCount,
        splice.insertions.map((insertion) => insertion.occurrenceId),
      ).root;
    }
    if (this.#sequences.count(root) !== delta.resultItemCount) {
      throw new Error('v6 context result item count mismatch');
    }
    const nodes = this.#sequences.exportUnseenNodes(
      root,
      this.#durableSequenceNodes,
    );
    const occurrencePayloads = delta.occurrences.map((occurrence) => {
      const { bytesBase64: _bytesBase64, ...metadata } = occurrence;
      return metadata;
    });
    const ordinal = this.#nextOrdinal();
    const recordId = this.#recordId(ordinal);
    const objectRefs = delta.occurrences.map((occurrence) => occurrence.content.digest);
    const attribution = delta.occurrences.flatMap<HistoryResourceAttribution>((
      occurrence,
    ) =>
      occurrence.sourceRelations.length === 0
        ? [{
          resourceKind: occurrence.kind,
          logicalIdentity: occurrence.occurrenceId,
          contentDigest: occurrence.content.digest,
        }]
        : occurrence.sourceRelations.map((source) => ({
          resourceKind: source.resourceKind,
          logicalIdentity: source.logicalIdentity ?? occurrence.occurrenceId,
          contentDigest: source.contentDigest ?? occurrence.content.digest,
          ...(source.sourceLocator === undefined ? {} : { sourceLocator: source.sourceLocator }),
        }))
    );
    this.#objects.push(...objects);
    this.#sequenceRevisions.push({
      revisionId: delta.revisionDigest,
      root,
      parentRoot,
      itemCount: delta.resultItemCount,
      nodes,
    });
    this.#records.push({
      schemaVersion: 1,
      recordId,
      executionId: this.executionId,
      ordinal,
      authority: 'attribution',
      kind: 'resource_attribution',
      observedAt: this.#now(),
      payload: json({
        occurrence: 'context_delta',
        schemaVersion: delta.schemaVersion,
        requestOrdinal: delta.requestOrdinal,
        lane: delta.lane,
        purpose: delta.purpose,
        modelStep: delta.modelStep,
        ...(delta.modelSelection === undefined ? {} : { modelSelection: delta.modelSelection }),
        ...(delta.sourceCallId === undefined ? {} : { sourceCallId: delta.sourceCallId }),
        ...(delta.baseRevisionDigest === undefined
          ? {}
          : { baseRevisionDigest: delta.baseRevisionDigest }),
        revisionDigest: delta.revisionDigest,
        resultItemCount: delta.resultItemCount,
        splices: delta.splices,
        occurrences: occurrencePayloads,
        ...(historyEvent === undefined ? {} : {
          historyEvent: {
            ...historyEvent,
            payload: {
              ...(historyEvent.payload as Record<string, JsonValue>),
              observation: {
                ...((historyEvent.payload as Record<string, JsonValue>)
                  .observation as Record<string, JsonValue>),
                delta: { ...delta, occurrences: occurrencePayloads },
              },
            },
          },
        }),
      }),
      objectRefs,
      byteRanges: [],
      causes: this.#lastExecutionRecord === undefined
        ? []
        : [{ relation: 'follows', recordId: this.#lastExecutionRecord }],
      attribution,
    });
    this.#lastExecutionRecord = recordId;
    const receipt = this.flush();
    if (receipt === undefined) {
      throw new Error('v6 context delta was not appended');
    }
    for (const node of nodes) this.#durableSequenceNodes.add(node.digest);
    this.#sequenceRoots.set(delta.revisionDigest, {
      root,
      lane: delta.lane,
      purpose: delta.purpose,
    });
    this.#nextContextRequestOrdinal += 1;
    return ordinal;
  }

  recordInterrupted(reason: string): number {
    if (!reason || reason.includes('\0')) {
      throw new TypeError('invalid interruption reason');
    }
    return this.#appendObservationRecord(
      undefined,
      'host_decision',
      'execution_decision',
      json({
        occurrence: 'restart_reconciliation',
        outcome: 'interrupted',
        reason,
      }),
      [],
      [],
      true,
    );
  }

  flush(): HistoryV6AppendReceipt | undefined {
    if (this.#records.length === 0) return undefined;
    const receipt = this.store.append({
      executionId: this.executionId,
      expectedLatestOrdinal: this.#latestOrdinal,
      objects: this.#objects,
      byteStreams: this.#byteStreams,
      sequenceRevisions: this.#sequenceRevisions,
      records: this.#records,
      ...(this.#terminalRecordId === undefined ? {} : { terminalRecordId: this.#terminalRecordId }),
    });
    this.#latestOrdinal = receipt.latestOrdinal;
    this.#cost = addHistoryLogicalCost(this.#cost, receipt.cost);
    this.#objects = [];
    this.#byteStreams = [];
    this.#sequenceRevisions = [];
    this.#records = [];
    this.#terminalRecordId = undefined;
    return receipt;
  }

  #captureExactRequest(observation: ProviderExactRequestObservation): void {
    this.flush();
    const ref = validatedExactByteObjectRef(observation.bytes);
    const ordinal = this.#nextOrdinal();
    const recordId = this.#recordId(ordinal);
    const streamId = `${this.executionId}:request-stream:${ordinal}`;
    const plan: ExactBytePlan = {
      schemaVersion: 1,
      captureBoundary: observation.captureBoundary,
      serializerVersion: observation.serializerVersion,
      contentEncoding: 'identity',
      fragments: [{
        kind: 'validated_ref',
        object: { digest: ref.digest, byteLength: ref.byteLength },
      }],
      byteLength: ref.byteLength,
      digest: ref.digest,
    };
    const record: HistoryLogicalRecord = {
      schemaVersion: 1,
      recordId,
      executionId: this.executionId,
      ordinal,
      authority: 'transport_observation',
      kind: 'transport_request',
      observedAt: this.#now(),
      payload: json({
        endpoint: observation.endpoint,
        method: observation.method,
        lane: observation.lane,
        phase: observation.phase,
        modelStep: observation.modelStep,
        requestMetadata: observation.requestMetadata,
        captureBoundary: observation.captureBoundary,
        serializerVersion: observation.serializerVersion,
        byteLength: ref.byteLength,
        digest: ref.digest,
        monolithicFallback: observation.monolithicFallback,
      }),
      objectRefs: [ref.digest],
      byteRanges: [{ streamId, start: 0, end: ref.byteLength }],
      causes: this.#lastExecutionRecord === undefined
        ? []
        : [{ relation: 'follows', recordId: this.#lastExecutionRecord }],
      attribution: [{
        resourceKind: 'provider_adapter',
        logicalIdentity: observation.captureBoundary,
        contentDigest: ref.digest,
      }],
    };
    this.#objects.push({ bytes: observation.bytes, validatedRef: ref });
    this.#byteStreams.push({ streamId, plan });
    this.#records.push(record);
    this.#lastExecutionRecord = recordId;
    this.#unmatchedRequests.push({
      recordId,
      byteLength: ref.byteLength,
      endpoint: observation.endpoint,
      method: observation.method,
      lane: observation.lane,
      phase: observation.phase,
      modelStep: observation.modelStep,
    });
    this.flush();
  }

  #matchRequestStart(
    request: Extract<
      ProviderEvidenceObservation,
      { kind: 'request_start' }
    >['request'],
    historyEvent?: StoredExecutionEvent,
  ): number {
    const captured = this.#unmatchedRequests.shift();
    if (
      captured === undefined ||
      (request.requestBody !== '' &&
        captured.byteLength !== request.requestBodyBytes) ||
      captured.endpoint !== request.endpoint ||
      captured.method !== request.method ||
      captured.lane !== request.lane ||
      captured.phase !== (request.phase ?? 'user_turn') ||
      captured.modelStep !== request.modelStep
    ) {
      throw new Error(
        'provider request evidence does not match exact byte capture',
      );
    }
    this.#requestRecords.set(request.ordinal, captured.recordId);
    this.#lastRequestRecord.set(request.ordinal, captured.recordId);
    if (historyEvent !== undefined) {
      this.#appendObservationRecord(
        request.ordinal,
        'transport_observation',
        'runtime_event',
        json({ occurrence: 'request_start', request, historyEvent }),
      );
    }
    return Number(
      captured.recordId.slice(captured.recordId.lastIndexOf(':') + 1),
    );
  }

  #appendRuntimeEvent(
    requestOrdinal: number | undefined,
    event: ProviderEvidenceRuntimeEvent,
    historyEvent?: StoredExecutionEvent,
  ): number {
    const authority = event.kind === 'turn_outcome'
      ? 'host_decision' as const
      : 'contemporaneous_interpretation' as const;
    const kind = event.kind === 'tool_call' || event.kind === 'tool_progress' ||
        event.kind === 'tool_result'
      ? 'tool_event' as const
      : event.kind === 'turn_outcome'
      ? 'execution_decision' as const
      : 'runtime_event' as const;
    return this.#appendObservationRecord(
      requestOrdinal,
      authority,
      kind,
      json({
        occurrence: 'runtime_event',
        ...(requestOrdinal === undefined ? {} : { requestOrdinal }),
        event,
        ...(historyEvent === undefined ? {} : { historyEvent }),
      }),
      [],
      [],
      event.kind === 'turn_outcome' && historyEvent === undefined,
    );
  }

  #appendObservationRecord(
    requestOrdinal: number | undefined,
    authority: HistoryLogicalRecord['authority'],
    kind: HistoryLogicalRecord['kind'],
    payload: JsonValue,
    objects: readonly HistoryV6ExactObjectInput[] = [],
    objectRefs: readonly string[] = [],
    terminal = false,
  ): number {
    const requestRecord = requestOrdinal === undefined
      ? undefined
      : this.#requestRecords.get(requestOrdinal);
    if (requestOrdinal !== undefined && requestRecord === undefined) {
      throw new Error(
        `provider observation precedes request capture: ${requestOrdinal}`,
      );
    }
    const ordinal = this.#nextOrdinal();
    const recordId = this.#recordId(ordinal);
    const prior = requestOrdinal === undefined
      ? this.#lastExecutionRecord
      : this.#lastRequestRecord.get(requestOrdinal) ?? requestRecord;
    const record: HistoryLogicalRecord = {
      schemaVersion: 1,
      recordId,
      executionId: this.executionId,
      ordinal,
      authority,
      kind,
      observedAt: this.#now(),
      payload,
      objectRefs: [...objectRefs],
      byteRanges: [],
      causes: prior === undefined ? [] : [{
        relation: prior === requestRecord ? 'responds_to' : 'follows',
        recordId: prior,
      }],
      attribution: requestOrdinal === undefined ? [] : [{
        resourceKind: 'provider_request',
        logicalIdentity: String(requestOrdinal),
      }],
    };
    this.#objects.push(...objects);
    this.#records.push(record);
    this.#lastExecutionRecord = recordId;
    if (requestOrdinal !== undefined) {
      this.#lastRequestRecord.set(requestOrdinal, recordId);
    }
    if (terminal) this.#terminalRecordId = recordId;
    if (terminal || this.#records.length >= this.#maxPendingRecords) {
      this.flush();
    }
    return ordinal;
  }

  #nextOrdinal(): number {
    return this.#latestOrdinal + this.#records.length + 1;
  }

  #recordId(ordinal: number): string {
    return `${this.executionId}:record:${ordinal}`;
  }
}
import { createHash } from 'node:crypto';
