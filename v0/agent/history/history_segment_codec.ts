import { gunzipSync, gzipSync } from 'node:zlib';
import { exactByteDigest } from './exact_byte_plan.ts';

export const HISTORY_SEGMENT_SCHEMA_VERSION = 1 as const;
const MAGIC = new TextEncoder().encode('HSEG1\n');

export type HistorySegmentCodec = 'identity' | 'gzip-1' | 'gzip-6' | 'gzip-9';

export interface EncodedHistorySegment {
  readonly schemaVersion: 1;
  readonly codec: HistorySegmentCodec;
  readonly recordCount: number;
  readonly uncompressedBytes: number;
  readonly encodedBytes: number;
  readonly logicalDigest: string;
  readonly representationDigest: string;
  readonly bytes: Uint8Array;
}

const concatenate = (parts: readonly Uint8Array[], total: number): Uint8Array => {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const frame = (records: readonly Uint8Array[]): Uint8Array => {
  const parts: Uint8Array[] = [MAGIC];
  let total = MAGIC.byteLength;
  for (const record of records) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, record.byteLength, false);
    parts.push(length, record);
    total += 4 + record.byteLength;
  }
  return concatenate(parts, total);
};

export const encodeHistorySegment = (
  records: readonly Uint8Array[],
  codec: HistorySegmentCodec,
): EncodedHistorySegment => {
  if (records.length === 0) throw new TypeError('history segment must contain a record');
  const logical = frame(records);
  const level = codec === 'gzip-1'
    ? 1
    : codec === 'gzip-6'
    ? 6
    : codec === 'gzip-9'
    ? 9
    : undefined;
  const encoded = level === undefined
    ? logical.slice()
    : new Uint8Array(gzipSync(logical, { level }));
  return {
    schemaVersion: HISTORY_SEGMENT_SCHEMA_VERSION,
    codec,
    recordCount: records.length,
    uncompressedBytes: logical.byteLength,
    encodedBytes: encoded.byteLength,
    logicalDigest: exactByteDigest(logical),
    representationDigest: exactByteDigest(encoded),
    bytes: encoded,
  };
};

export const decodeHistorySegment = (segment: EncodedHistorySegment): readonly Uint8Array[] => {
  if (
    segment.schemaVersion !== HISTORY_SEGMENT_SCHEMA_VERSION ||
    !['identity', 'gzip-1', 'gzip-6', 'gzip-9'].includes(segment.codec) ||
    !Number.isSafeInteger(segment.recordCount) || segment.recordCount <= 0 ||
    !Number.isSafeInteger(segment.uncompressedBytes) ||
    segment.uncompressedBytes < MAGIC.byteLength ||
    !Number.isSafeInteger(segment.encodedBytes) ||
    segment.encodedBytes !== segment.bytes.byteLength ||
    exactByteDigest(segment.bytes) !== segment.representationDigest
  ) throw new Error('history segment representation digest mismatch');
  const logical = segment.codec === 'identity'
    ? segment.bytes.slice()
    : new Uint8Array(gunzipSync(segment.bytes));
  if (
    logical.byteLength !== segment.uncompressedBytes ||
    exactByteDigest(logical) !== segment.logicalDigest
  ) throw new Error('history segment logical digest mismatch');
  if (
    logical.byteLength < MAGIC.byteLength ||
    !MAGIC.every((byte, index) => logical[index] === byte)
  ) throw new Error('invalid history segment magic');
  const records: Uint8Array[] = [];
  let offset = MAGIC.byteLength;
  while (offset < logical.byteLength) {
    if (offset + 4 > logical.byteLength) throw new Error('truncated history segment length');
    const length = new DataView(logical.buffer, logical.byteOffset + offset, 4).getUint32(0, false);
    offset += 4;
    if (offset + length > logical.byteLength) throw new Error('truncated history segment record');
    records.push(logical.slice(offset, offset + length));
    offset += length;
  }
  if (records.length !== segment.recordCount) {
    throw new Error('history segment record count mismatch');
  }
  return records;
};

export interface HistorySegmentPolicy {
  readonly maxUncompressedBytes: number;
  readonly maxRecords: number;
  readonly maxFlushLatencyMs: number;
}

export interface HistorySegmentSweepResult {
  readonly policy: HistorySegmentPolicy;
  readonly codec: HistorySegmentCodec;
  readonly segmentCount: number;
  readonly encodedBytes: number;
  readonly maxBuilderBytes: number;
  readonly maxDetailDecodeBytes: number;
  readonly maxFlushLatencyMs: number;
}

export const segmentHistoryRecords = (
  records: readonly Uint8Array[],
  policy: HistorySegmentPolicy,
  codec: HistorySegmentCodec,
): readonly EncodedHistorySegment[] => {
  if (
    !Number.isSafeInteger(policy.maxUncompressedBytes) ||
    policy.maxUncompressedBytes <= MAGIC.byteLength ||
    !Number.isSafeInteger(policy.maxRecords) || policy.maxRecords <= 0 ||
    !Number.isFinite(policy.maxFlushLatencyMs) || policy.maxFlushLatencyMs < 0
  ) throw new TypeError('invalid history segment policy');
  const segments: EncodedHistorySegment[] = [];
  let pending: Uint8Array[] = [];
  let bytes = MAGIC.byteLength;
  const flush = (): void => {
    if (pending.length === 0) return;
    segments.push(encodeHistorySegment(pending, codec));
    pending = [];
    bytes = MAGIC.byteLength;
  };
  for (const record of records) {
    const addition = 4 + record.byteLength;
    if (
      pending.length > 0 &&
      (pending.length >= policy.maxRecords || bytes + addition > policy.maxUncompressedBytes)
    ) {
      flush();
    }
    pending.push(record);
    bytes += addition;
    if (pending.length >= policy.maxRecords || bytes >= policy.maxUncompressedBytes) flush();
  }
  flush();
  return segments;
};

export const sweepHistorySegmentPolicies = (
  records: readonly Uint8Array[],
  policies: readonly HistorySegmentPolicy[],
  codecs: readonly HistorySegmentCodec[],
): readonly HistorySegmentSweepResult[] =>
  policies.flatMap((policy) =>
    codecs.map((codec) => {
      const segments = segmentHistoryRecords(records, policy, codec);
      return {
        policy,
        codec,
        segmentCount: segments.length,
        encodedBytes: segments.reduce((sum, segment) => sum + segment.encodedBytes, 0),
        maxBuilderBytes: Math.max(0, ...segments.map((segment) => segment.uncompressedBytes)),
        maxDetailDecodeBytes: Math.max(0, ...segments.map((segment) => segment.uncompressedBytes)),
        maxFlushLatencyMs: policy.maxFlushLatencyMs,
      };
    })
  );
