import { DatabaseSync } from 'node:sqlite';
import type { ProviderExactRequestObservation } from '../core/contracts.ts';
import { emptyHistoryLogicalCost, type HistoryLogicalCost } from './history_authority.ts';
import { IsolatedV6HistoryPipeline } from './v6_history_pipeline.ts';
import { SqliteHistoryV6Store } from './sqlite_history_v6_store.ts';

export interface HistoryV6PhysicalSize {
  readonly databaseBytes: number;
  readonly walBytes: number;
  readonly shmBytes: number;
  readonly totalBytes: number;
}

export interface HistoryV6RepeatedContextBenchmarkConfig {
  readonly databasePath: string;
  readonly targetCumulativeTokens: number;
  readonly tokenBytes: number;
  readonly fixedPrefixBytes: number;
  readonly newFactBytesPerTurn: number;
}

export interface HistoryV6RepeatedContextBenchmarkResult {
  readonly turns: number;
  readonly cumulativeWireBytes: number;
  readonly cumulativeTokens: number;
  readonly newFactBytes: number;
  readonly emptyStore: HistoryV6PhysicalSize;
  readonly noMaintenance: HistoryV6PhysicalSize;
  readonly postMaintenance: HistoryV6PhysicalSize;
  readonly peak: HistoryV6PhysicalSize;
  readonly maintenanceBacklogBytes: number;
  readonly authorityEncodedBytes: number;
  readonly steadyPhysicalIncrementBytes: number;
  readonly bytesPerCumulativeToken: number;
  readonly physicalToEncodedAuthorityRatio: number;
  readonly appendLatencyMs: {
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
  };
  readonly logicalCost: HistoryLogicalCost;
}

export interface HistoryV6SessionLengthSample {
  readonly existingRecords: number;
  readonly appendLatencyMs: {
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
  };
  readonly logicalCost: HistoryLogicalCost;
}

export interface HistoryV6UniquePayloadSample {
  readonly inputBytes: number;
  readonly steadyPhysicalIncrementBytes: number;
  readonly authorityEncodedBytes: number;
  readonly physicalPerInputByte: number;
  readonly appendLatencyMs: number;
}

const encoder = new TextEncoder();

const fileBytes = async (path: string): Promise<number> => {
  try {
    return (await Deno.stat(path)).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
};

export const measureHistoryV6PhysicalSize = async (
  databasePath: string,
): Promise<HistoryV6PhysicalSize> => {
  const [databaseBytes, walBytes, shmBytes] = await Promise.all([
    fileBytes(databasePath),
    fileBytes(`${databasePath}-wal`),
    fileBytes(`${databasePath}-shm`),
  ]);
  return {
    databaseBytes,
    walBytes,
    shmBytes,
    totalBytes: databaseBytes + walBytes + shmBytes,
  };
};

const repeatToLength = (seed: string, length: number): string => {
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('invalid text length');
  if (length === 0) return '';
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
};

const factFor = (turn: number, byteLength: number): string => {
  const lines: string[] = [];
  let line = 0;
  while (lines.join('').length < byteLength) {
    const key = ((turn + 1) * 2_654_435_761 + line * 2_246_822_519) >>> 0;
    lines.push(
      `export const symbol_${String(turn).padStart(4, '0')}_${String(line).padStart(4, '0')} = ` +
        `compose(dependency_${(turn + line) % 97}, "${key.toString(16).padStart(8, '0')}");\n`,
    );
    line += 1;
  }
  return lines.join('').slice(0, byteLength);
};

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};

const requestObservation = (bytes: Uint8Array): ProviderExactRequestObservation => ({
  bytes,
  captureBoundary: 'increment-90-capacity:http-body-v1',
  serializerVersion: 'increment-90-capacity-json-v1',
  endpoint: 'https://provider.invalid/capacity',
  method: 'POST',
  lane: 'parent',
  phase: 'user_turn',
  modelStep: 1,
  requestMetadata: {
    contentType: 'application/json',
    responseMode: 'sse',
    origin: 'root_model',
    provider: 'increment-90-capacity',
    api: 'openai-responses',
    modelId: 'capacity-model',
    effort: 'medium',
    authProfile: 'openai-api-key',
    protocol: 'sse',
  },
  monolithicFallback: true,
});

const encodedAuthorityBytes = (databasePath: string): number => {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const value = db.prepare(`
      SELECT
        coalesce((SELECT sum(encoded_length) FROM exact_objects), 0) +
        coalesce((SELECT sum(encoded_length) FROM history_segments), 0) +
        coalesce((SELECT sum(length(manifest_bytes)) FROM byte_streams), 0)
        AS bytes
    `).get() as { bytes: number };
    return Number(value.bytes);
  } finally {
    db.close();
  }
};

export const benchmarkV6RepeatedContext = async (
  config: HistoryV6RepeatedContextBenchmarkConfig,
): Promise<HistoryV6RepeatedContextBenchmarkResult> => {
  if (
    !config.databasePath.startsWith('/') ||
    !Number.isSafeInteger(config.targetCumulativeTokens) ||
    config.targetCumulativeTokens < 1 ||
    !Number.isSafeInteger(config.tokenBytes) || config.tokenBytes < 1 ||
    !Number.isSafeInteger(config.fixedPrefixBytes) || config.fixedPrefixBytes < 0 ||
    !Number.isSafeInteger(config.newFactBytesPerTurn) || config.newFactBytesPerTurn < 1
  ) throw new TypeError('invalid v6 repeated-context benchmark config');

  const store = new SqliteHistoryV6Store(config.databasePath);
  store.checkpoint('truncate');
  const emptyStore = await measureHistoryV6PhysicalSize(config.databasePath);
  const executionId = 'increment-90-capacity-execution';
  store.beginExecution(executionId, 'increment-90-capacity-session', 0, 'capacity-generation');
  const pipeline = new IsolatedV6HistoryPipeline(store, executionId, {
    now: () => '2026-09-20T16:00:00.000Z',
  });
  const fixed = repeatToLength(
    'system instruction tool schema workspace context stable prefix\n',
    config.fixedPrefixBytes,
  );
  let context = '';
  let cumulativeWireBytes = 0;
  let turns = 0;
  let peak = await measureHistoryV6PhysicalSize(config.databasePath);
  const latencies: number[] = [];
  while (
    Math.floor(cumulativeWireBytes / config.tokenBytes) < config.targetCumulativeTokens
  ) {
    context += factFor(turns, config.newFactBytesPerTurn);
    const body = JSON.stringify({
      model: 'capacity-model',
      instructions: fixed,
      input: [{ role: 'user', content: context }],
      stream: true,
    });
    const bytes = encoder.encode(body);
    const started = performance.now();
    pipeline.observeExactRequest(requestObservation(bytes));
    latencies.push(performance.now() - started);
    cumulativeWireBytes += bytes.byteLength;
    turns += 1;
    const current = await measureHistoryV6PhysicalSize(config.databasePath);
    if (current.totalBytes > peak.totalBytes) peak = current;
  }
  const noMaintenance = await measureHistoryV6PhysicalSize(config.databasePath);
  const checkpoint = store.checkpoint('truncate');
  if (checkpoint.busy !== 0) throw new Error('v6 capacity checkpoint remained busy');
  const postMaintenance = await measureHistoryV6PhysicalSize(config.databasePath);
  store.close();
  const authorityBytes = encodedAuthorityBytes(config.databasePath);
  const steadyPhysicalIncrementBytes = Math.max(
    0,
    postMaintenance.totalBytes - emptyStore.totalBytes,
  );
  const cumulativeTokens = Math.floor(cumulativeWireBytes / config.tokenBytes);
  return {
    turns,
    cumulativeWireBytes,
    cumulativeTokens,
    newFactBytes: turns * config.newFactBytesPerTurn,
    emptyStore,
    noMaintenance,
    postMaintenance,
    peak,
    maintenanceBacklogBytes: Math.max(
      0,
      noMaintenance.totalBytes - postMaintenance.totalBytes,
    ),
    authorityEncodedBytes: authorityBytes,
    steadyPhysicalIncrementBytes,
    bytesPerCumulativeToken: steadyPhysicalIncrementBytes / cumulativeTokens,
    physicalToEncodedAuthorityRatio: steadyPhysicalIncrementBytes / authorityBytes,
    appendLatencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(...latencies),
    },
    logicalCost: pipeline.logicalCost,
  };
};

const benchmarkRecord = (
  executionId: string,
  ordinal: number,
): import('./history_record_codec.ts').HistoryLogicalRecord => ({
  schemaVersion: 1,
  recordId: `${executionId}:record:${String(ordinal).padStart(8, '0')}`,
  executionId,
  ordinal,
  authority: 'contemporaneous_interpretation',
  kind: 'runtime_event',
  observedAt: '2026-09-20T16:00:00.000Z',
  payload: {
    occurrence: 'session_length_probe',
    padding: 'x'.repeat(8 - String(ordinal).length),
  },
  objectRefs: [],
  byteRanges: [],
  causes: [],
  attribution: [],
});

export const benchmarkV6SessionLengthDelta = (
  rootDirectory: string,
  existingRecordCounts: readonly number[],
): readonly HistoryV6SessionLengthSample[] => {
  const samples: HistoryV6SessionLengthSample[] = [];
  for (const count of existingRecordCounts) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new TypeError('invalid v6 session-length record count');
    }
    const databasePath = `${rootDirectory}/history-v6-${count}.sqlite3`;
    const store = new SqliteHistoryV6Store(databasePath);
    const executionId = `execution-${String(count).padStart(8, '0')}`;
    store.beginExecution(executionId, `session-${String(count).padStart(8, '0')}`, 0, 'probe');
    store.append({
      executionId,
      expectedLatestOrdinal: 0,
      records: Array.from({ length: count }, (_, index) => benchmarkRecord(executionId, index + 1)),
    });
    store.checkpoint('truncate');
    const latencies: number[] = [];
    let logicalCost = emptyHistoryLogicalCost();
    for (let probe = 1; probe <= 25; probe += 1) {
      const started = performance.now();
      const receipt = store.append({
        executionId,
        expectedLatestOrdinal: count + probe - 1,
        records: [benchmarkRecord(executionId, count + probe)],
      });
      latencies.push(performance.now() - started);
      if (probe > 1 && JSON.stringify(receipt.cost) !== JSON.stringify(logicalCost)) {
        throw new Error('v6 session-length probe changed its logical delta');
      }
      logicalCost = receipt.cost;
    }
    samples.push({
      existingRecords: count,
      appendLatencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: Math.max(...latencies),
      },
      logicalCost,
    });
    store.close();
  }
  return samples;
};

const deterministicBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = 0x90c0ffee;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
};

export const benchmarkV6UniquePayloadScaling = async (
  rootDirectory: string,
  sizes: readonly number[],
): Promise<readonly HistoryV6UniquePayloadSample[]> => {
  const samples: HistoryV6UniquePayloadSample[] = [];
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new TypeError('invalid v6 unique payload size');
    }
    const databasePath = `${rootDirectory}/history-v6-unique-${size}.sqlite3`;
    const store = new SqliteHistoryV6Store(databasePath);
    store.checkpoint('truncate');
    const baseline = await measureHistoryV6PhysicalSize(databasePath);
    const executionId = `unique-${String(size).padStart(8, '0')}`;
    store.beginExecution(executionId, `session-${String(size).padStart(8, '0')}`, 0, 'probe');
    const pipeline = new IsolatedV6HistoryPipeline(store, executionId, {
      now: () => '2026-09-20T16:00:00.000Z',
    });
    const bytes = deterministicBytes(size);
    const started = performance.now();
    pipeline.observeExactRequest(requestObservation(bytes));
    const appendLatencyMs = performance.now() - started;
    store.checkpoint('truncate');
    const steady = await measureHistoryV6PhysicalSize(databasePath);
    store.close();
    const physical = Math.max(0, steady.totalBytes - baseline.totalBytes);
    const authority = encodedAuthorityBytes(databasePath);
    samples.push({
      inputBytes: size,
      steadyPhysicalIncrementBytes: physical,
      authorityEncodedBytes: authority,
      physicalPerInputByte: physical / size,
      appendLatencyMs,
    });
  }
  return samples;
};

export const emptyV6BenchmarkCost = (): HistoryLogicalCost => emptyHistoryLogicalCost();
