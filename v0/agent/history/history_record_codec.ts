import type { JsonValue } from '../core/contracts.ts';
import { canonicalJsonBytes } from './context_attribution.ts';
import type { HistoryAuthority, HistoryLogicalRecordKind } from './history_authority.ts';

export const HISTORY_RECORD_SCHEMA_VERSION = 1 as const;

export interface HistoryByteRange {
  readonly streamId: string;
  readonly start: number;
  readonly end: number;
}

export interface HistoryCausalRef {
  readonly relation: string;
  readonly recordId: string;
}

export interface HistoryResourceAttribution {
  readonly resourceKind: string;
  readonly logicalIdentity: string;
  readonly contentDigest?: string;
  readonly sourceLocator?: string;
}

export interface HistoryLogicalRecord {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly executionId: string;
  readonly ordinal: number;
  readonly authority: Exclude<HistoryAuthority, 'derived_projection'>;
  readonly kind: HistoryLogicalRecordKind;
  readonly observedAt: string;
  readonly payload: JsonValue;
  /** Exact immutable byte objects directly referenced by this occurrence. */
  readonly objectRefs: readonly string[];
  readonly byteRanges: readonly HistoryByteRange[];
  readonly causes: readonly HistoryCausalRef[];
  readonly attribution: readonly HistoryResourceAttribution[];
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const AUTHORITIES = new Set<string>([
  'transport_observation',
  'contemporaneous_interpretation',
  'host_decision',
  'attribution',
]);
const KINDS = new Set<string>([
  'transport_request',
  'transport_response_chunk',
  'sse_event',
  'parser_transition',
  'runtime_event',
  'tool_event',
  'effect_event',
  'execution_decision',
  'canonical_adoption',
  'resource_attribution',
  'reinterpretation',
]);

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');
const nonnegative = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export const isHistoryLogicalRecord = (value: unknown): value is HistoryLogicalRecord => {
  if (!object(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    'attribution',
    'authority',
    'byteRanges',
    'causes',
    'executionId',
    'kind',
    'objectRefs',
    'observedAt',
    'ordinal',
    'payload',
    'recordId',
    'schemaVersion',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) return false;
  if (
    value.schemaVersion !== HISTORY_RECORD_SCHEMA_VERSION || !text(value.recordId) ||
    !text(value.executionId) || !nonnegative(value.ordinal) ||
    !AUTHORITIES.has(String(value.authority)) || !KINDS.has(String(value.kind)) ||
    !text(value.observedAt) || !Array.isArray(value.objectRefs) ||
    value.objectRefs.some((ref) => !/^sha256:[0-9a-f]{64}$/u.test(String(ref))) ||
    !Array.isArray(value.byteRanges) ||
    !Array.isArray(value.causes) || !Array.isArray(value.attribution)
  ) return false;
  try {
    canonicalJsonBytes(value.payload as JsonValue);
  } catch {
    return false;
  }
  return value.byteRanges.every((range) =>
    object(range) && text(range.streamId) && nonnegative(range.start) &&
    nonnegative(range.end) && Number(range.end) >= Number(range.start) &&
    Object.keys(range).length === 3
  ) &&
    value.causes.every((cause) =>
      object(cause) && text(cause.relation) && text(cause.recordId) &&
      Object.keys(cause).length === 2
    ) &&
    value.attribution.every((entry) =>
      object(entry) && text(entry.resourceKind) && text(entry.logicalIdentity) &&
      (entry.contentDigest === undefined || text(entry.contentDigest)) &&
      (entry.sourceLocator === undefined || text(entry.sourceLocator)) &&
      Object.keys(entry).every((key) =>
        ['resourceKind', 'logicalIdentity', 'contentDigest', 'sourceLocator'].includes(key)
      )
    );
};

export const encodeHistoryLogicalRecord = (record: HistoryLogicalRecord): Uint8Array => {
  if (!isHistoryLogicalRecord(record)) throw new TypeError('invalid history logical record');
  return canonicalJsonBytes(record as unknown as JsonValue);
};

export const decodeHistoryLogicalRecord = (bytes: Uint8Array): HistoryLogicalRecord => {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new TypeError('invalid history record encoding');
  }
  if (!isHistoryLogicalRecord(value)) throw new TypeError('invalid history logical record');
  return value;
};
