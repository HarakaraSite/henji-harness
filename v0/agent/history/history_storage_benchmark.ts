import type { JsonValue } from '../core/contracts.ts';
import { gzipSync } from 'node:zlib';
import { addHistoryLogicalCost, emptyHistoryLogicalCost } from './history_authority.ts';
import { encodeHistoryLogicalRecord, type HistoryLogicalRecord } from './history_record_codec.ts';
import {
  type HistorySegmentCodec,
  type HistorySegmentPolicy,
  sweepHistorySegmentPolicies,
} from './history_segment_codec.ts';

export interface RepeatedContextWorkloadOptions {
  readonly turns: number;
  readonly repeatedPrefixBytes: number;
  readonly newFactBytesPerTurn: number;
}

const text = (size: number, seed: string): string => {
  let result = '';
  while (new TextEncoder().encode(result).byteLength < size) result += seed;
  return result.slice(0, size);
};

/** Synthetic app-development trace. It contains no captured user or provider content. */
export const repeatedContextWorkload = (
  options: RepeatedContextWorkloadOptions,
): readonly HistoryLogicalRecord[] => {
  if (
    !Number.isSafeInteger(options.turns) || options.turns <= 0 ||
    !Number.isSafeInteger(options.repeatedPrefixBytes) || options.repeatedPrefixBytes < 0 ||
    !Number.isSafeInteger(options.newFactBytesPerTurn) || options.newFactBytesPerTurn < 0
  ) throw new TypeError('invalid repeated context workload');
  const prefixDigest = `synthetic-prefix:${options.repeatedPrefixBytes}`;
  return Array.from({ length: options.turns }, (_, turn): HistoryLogicalRecord => ({
    schemaVersion: 1,
    recordId: `synthetic-record-${turn}`,
    executionId: 'synthetic-execution',
    ordinal: turn,
    authority: 'contemporaneous_interpretation',
    kind: 'runtime_event',
    observedAt: '2000-01-01T00:00:00.000Z',
    payload: {
      prefixRef: prefixDigest,
      newFact: text(options.newFactBytesPerTurn, `turn-${turn}:`),
    } as JsonValue,
    objectRefs: [],
    byteRanges: [],
    causes: turn === 0 ? [] : [{ relation: 'previous', recordId: `synthetic-record-${turn - 1}` }],
    attribution: [{
      resourceKind: 'synthetic_context',
      logicalIdentity: prefixDigest,
    }],
  }));
};

export const benchmarkHistorySegments = (
  options: RepeatedContextWorkloadOptions,
  policies: readonly HistorySegmentPolicy[],
  codecs: readonly HistorySegmentCodec[],
) => {
  const records = repeatedContextWorkload(options).map(encodeHistoryLogicalRecord);
  const encodedAuthorityBytes = records.reduce((sum, record) => sum + record.byteLength, 0);
  const sharedObject = new TextEncoder().encode(
    text(options.repeatedPrefixBytes, 'stable-prefix:'),
  );
  const sharedObjectEncodedBytes = gzipSync(sharedObject, { level: 6 }).byteLength;
  const logicalCost = addHistoryLogicalCost(emptyHistoryLogicalCost(), {
    unreferencedInputBytes: options.repeatedPrefixBytes +
      options.turns * options.newFactBytesPerTurn,
    logicalRecords: options.turns,
    validatedFragmentRefs: options.turns,
    edgeAndRootEdits: options.turns * 2,
    wireBytes: options.turns *
      (options.repeatedPrefixBytes + options.newFactBytesPerTurn),
  });
  const results = sweepHistorySegmentPolicies(records, policies, codecs).map((result) => ({
    ...result,
    totalEncodedBytes: sharedObjectEncodedBytes + result.encodedBytes,
  }));
  return {
    input: options,
    encodedAuthorityBytes,
    sharedObjectBytes: sharedObject.byteLength,
    sharedObjectEncodedBytes,
    logicalCost,
    results,
  } as const;
};
