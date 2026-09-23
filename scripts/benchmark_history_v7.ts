import { SqliteHistoryV7Store } from '../v0/agent/history/sqlite_history_v7_store.ts';
import type {
  HistoryV7CaptureProfile,
  HistoryV7OperationCost,
} from '../v0/agent/history/history_v7_model.ts';

const encoder = new TextEncoder();
const TOKEN_BYTES = 4;
const TARGET_CUMULATIVE_TOKENS = 100_000_000;
const FACT_BYTES_PER_TURN = 10_000;
const FIXED_CONTEXT_BYTES = 65_536;

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

const size = async (path: string): Promise<number> => {
  try {
    return (await Deno.stat(path)).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
};

const totalSize = async (path: string): Promise<{
  db: number;
  wal: number;
  shm: number;
  total: number;
}> => {
  const db = await size(path);
  const wal = await size(`${path}-wal`);
  const shm = await size(`${path}-shm`);
  return { db, wal, shm, total: db + wal + shm };
};

const mergeCost = (
  left: HistoryV7OperationCost,
  right: HistoryV7OperationCost,
): HistoryV7OperationCost => ({
  serializedBytes: left.serializedBytes + right.serializedBytes,
  contentBytesHashed: left.contentBytesHashed + right.contentBytesHashed,
  contentDigestCalls: left.contentDigestCalls + right.contentDigestCalls,
  newOccurrences: left.newOccurrences + right.newOccurrences,
  newRelations: left.newRelations + right.newRelations,
  preexistingPayloadRowsRead: left.preexistingPayloadRowsRead +
    right.preexistingPayloadRowsRead,
  preexistingPayloadBytesRead: left.preexistingPayloadBytesRead +
    right.preexistingPayloadBytesRead,
  preexistingPayloadBytesRewritten: left.preexistingPayloadBytesRewritten +
    right.preexistingPayloadBytesRewritten,
});

const emptyCost = (): HistoryV7OperationCost => ({
  serializedBytes: 0,
  contentBytesHashed: 0,
  contentDigestCalls: 0,
  newOccurrences: 0,
  newRelations: 0,
  preexistingPayloadRowsRead: 0,
  preexistingPayloadBytesRead: 0,
  preexistingPayloadBytesRewritten: 0,
});

const turnsForTarget = (): number => {
  let turn = 0;
  let cumulative = 0;
  while (cumulative < TARGET_CUMULATIVE_TOKENS) {
    turn += 1;
    cumulative += (FIXED_CONTEXT_BYTES + turn * FACT_BYTES_PER_TURN) / TOKEN_BYTES;
  }
  return turn;
};

const semanticScale = async (path: string) => {
  const store = new SqliteHistoryV7Store(path);
  const turns = turnsForTarget();
  const appendMs: number[] = [];
  const settleMs: number[] = [];
  let cost = emptyCost();
  let cumulativeTokens = 0;
  try {
    for (let turn = 1; turn <= turns; turn += 1) {
      const executionId = `scale-${turn}`;
      store.beginExecution({
        executionId,
        sessionId: 'scale-session',
        baseRevision: turn - 1,
        captureProfile: 'normal-v1',
      });
      const text = `${turn}:` + 'x'.repeat(FACT_BYTES_PER_TURN - `${turn}:`.length);
      const appendStart = performance.now();
      cost = mergeCost(
        cost,
        store.appendSemantic(executionId, 0, [{
          occurrenceId: `${executionId}:message`,
          ordinal: 1,
          kind: 'assistant_message',
          observedAt: '2026-09-21T00:00:00.000Z',
          payload: { text },
        }, {
          occurrenceId: `${executionId}:terminal`,
          ordinal: 2,
          kind: 'host_decision',
          observedAt: '2026-09-21T00:00:00.001Z',
          payload: { outcome: 'completed', adoption: 'canonical' },
        }], `${executionId}:terminal`),
      );
      appendMs.push(performance.now() - appendStart);
      const settleStart = performance.now();
      cost = mergeCost(cost, store.settleExecution(executionId, 'completed'));
      store.adoptCanonical(executionId);
      settleMs.push(performance.now() - settleStart);
      cumulativeTokens += (FIXED_CONTEXT_BYTES + turn * FACT_BYTES_PER_TURN) / TOKEN_BYTES;
    }
    const first = appendMs.slice(0, 32);
    const last = appendMs.slice(-32);
    return {
      turns,
      cumulativeTokens: Math.floor(cumulativeTokens),
      uniqueSemanticBytes: turns * FACT_BYTES_PER_TURN,
      cost,
      appendMs: {
        firstP50: percentile(first, 0.5),
        firstP95: percentile(first, 0.95),
        lastP50: percentile(last, 0.5),
        lastP95: percentile(last, 0.95),
        lateToEarlyP50Ratio: percentile(last, 0.5) / Math.max(percentile(first, 0.5), 0.000_001),
      },
      settlementMs: {
        p50: percentile(settleMs, 0.5),
        p95: percentile(settleMs, 0.95),
      },
      files: await totalSize(path),
    };
  } finally {
    store.close();
  }
};

const profileRun = async (
  path: string,
  profile: HistoryV7CaptureProfile,
): Promise<{
  profile: HistoryV7CaptureProfile;
  turns: number;
  semanticAppendMs: number;
  diagnosticAppendMs: number;
  diagnosticBytes: number;
  files: Awaited<ReturnType<typeof totalSize>>;
}> => {
  const turns = 100;
  const store = new SqliteHistoryV7Store(path);
  let semanticAppendMs = 0;
  let diagnosticAppendMs = 0;
  let diagnosticBytes = 0;
  try {
    for (let turn = 1; turn <= turns; turn += 1) {
      const executionId = `${profile}-${turn}`;
      store.beginExecution({
        executionId,
        sessionId: `${profile}-session`,
        baseRevision: turn - 1,
        captureProfile: profile,
      });
      const start = performance.now();
      store.appendSemantic(executionId, 0, [{
        occurrenceId: `${executionId}:message`,
        ordinal: 1,
        kind: 'assistant_message',
        observedAt: '2026-09-21T00:00:00.000Z',
        payload: { text: `${turn}:` + 's'.repeat(996) },
      }, {
        occurrenceId: `${executionId}:terminal`,
        ordinal: 2,
        kind: 'host_decision',
        observedAt: '2026-09-21T00:00:00.001Z',
        payload: { outcome: 'completed' },
      }], `${executionId}:terminal`);
      semanticAppendMs += performance.now() - start;
      if (profile === 'diagnostic-v1') {
        const content = encoder.encode(`${turn}:` + 'd'.repeat(32_765));
        const diagnosticStart = performance.now();
        store.appendDiagnostic({
          attachmentId: `${executionId}:wire`,
          executionId,
          occurrenceId: `${executionId}:message`,
          kind: 'transport',
          coverage: 'captured',
          metadata: { boundary: 'benchmark' },
          content,
        });
        diagnosticAppendMs += performance.now() - diagnosticStart;
        diagnosticBytes += content.byteLength;
      }
      store.settleExecution(executionId, 'completed');
      store.adoptCanonical(executionId);
    }
    return {
      profile,
      turns,
      semanticAppendMs,
      diagnosticAppendMs,
      diagnosticBytes,
      files: await totalSize(path),
    };
  } finally {
    store.close();
  }
};

const eventScale = async (path: string) => {
  const store = new SqliteHistoryV7Store(path);
  const executionId = 'event-scale';
  const eventCount = 10_000;
  const appendMs: number[] = [];
  let cost = emptyCost();
  try {
    store.beginExecution({
      executionId,
      sessionId: 'event-scale-session',
      baseRevision: 0,
      captureProfile: 'normal-v1',
    });
    for (let ordinal = 1; ordinal <= eventCount; ordinal += 1) {
      const start = performance.now();
      cost = mergeCost(
        cost,
        store.appendSemantic(executionId, ordinal - 1, [{
          occurrenceId: `${executionId}:tool:${ordinal}`,
          ordinal,
          kind: 'tool_result',
          observedAt: '2026-09-21T00:00:00.000Z',
          payload: {
            callId: `call-${ordinal}`,
            name: 'read',
            outcome: 'success',
            text: `${ordinal}:` + 'r'.repeat(124),
          },
        }]),
      );
      appendMs.push(performance.now() - start);
    }
    cost = mergeCost(
      cost,
      store.appendSemantic(executionId, eventCount, [{
        occurrenceId: `${executionId}:terminal`,
        ordinal: eventCount + 1,
        kind: 'host_decision',
        observedAt: '2026-09-21T00:00:00.001Z',
        payload: { outcome: 'failed', adoption: 'non_canonical' },
      }], `${executionId}:terminal`),
    );
    const settleStart = performance.now();
    const settlementCost = store.settleExecution(executionId, 'failed');
    const settlementMs = performance.now() - settleStart;
    return {
      eventCount,
      cost,
      settlementCost,
      settlementMs,
      appendMs: {
        firstP50: percentile(appendMs.slice(0, 500), 0.5),
        firstP95: percentile(appendMs.slice(0, 500), 0.95),
        lastP50: percentile(appendMs.slice(-500), 0.5),
        lastP95: percentile(appendMs.slice(-500), 0.95),
        lateToEarlyP50Ratio: percentile(appendMs.slice(-500), 0.5) /
          Math.max(percentile(appendMs.slice(0, 500), 0.5), 0.000_001),
      },
      files: await totalSize(path),
    };
  } finally {
    store.close();
  }
};

const root = Deno.args[0] ?? await Deno.makeTempDir({ prefix: 'henji-i94-v7-benchmark-' });
await Deno.mkdir(root, { recursive: true });
const scale = await semanticScale(`${root}/scale.sqlite3`);
const events = await eventScale(`${root}/events.sqlite3`);
const normal = await profileRun(`${root}/normal.sqlite3`, 'normal-v1');
const diagnostic = await profileRun(`${root}/diagnostic.sqlite3`, 'diagnostic-v1');

console.log(JSON.stringify({ root, scale, events, profiles: { normal, diagnostic } }, null, 2));
