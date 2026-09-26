import { deepStrictEqual, throws } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import {
  type HistoryV7AssistantTextState,
  type HistoryV7SemanticOccurrenceInput,
} from '../../v0/agent/history/history_v7_model.ts';
import { SqliteHistoryV7Store } from '../../v0/agent/history/sqlite_history_v7_store.ts';

const executionId = 'execution-text';
const observedAt = '2026-09-26T14:30:00.000Z';
const textState = (
  text: string,
  ordinal: number,
  requestOrdinal = 1,
): HistoryV7AssistantTextState => ({
  key: { lane: 'parent', modelStep: requestOrdinal, requestOrdinal },
  firstEventOrdinal: ordinal,
  event: {
    executionId,
    ordinal,
    observedAt,
    direction: 'worker_to_host',
    source: 'worker',
    kind: 'runtime_event',
    workerSequence: ordinal,
    payload: {
      kind: 'provider_observation',
      observation: {
        kind: 'runtime_event',
        event: {
          kind: 'assistant_progress',
          text,
          modelStep: requestOrdinal,
          requestOrdinal,
          lane: 'parent',
        },
      },
    },
  },
});
const completed: HistoryV7SemanticOccurrenceInput = {
  occurrenceId: 'result-text',
  ordinal: 1,
  kind: 'model_result',
  observedAt,
  payload: { text: 'Hello world' },
};
const admit = (store: SqliteHistoryV7Store): void => {
  store.beginExecutionWithAdmission({
    executionId,
    sessionId: 'session-text',
    baseRevision: 0,
    admission: {
      executionId,
      taskId: 'task-text',
      task: 'write a response',
      canonicalSessionId: 'session-text',
      sessionCorrelation: 'session-text',
      turn: 1,
      createdAt: observedAt,
      agent: 'default',
      model: {},
      build: {},
      definition: {},
      baseMessageCount: 0,
    },
  });
};
const eventCount = (db: DatabaseSync): number =>
  Number(
    db.prepare('SELECT event_count FROM execution_admissions WHERE execution_id=?')
      .get(executionId)!.event_count,
  );

Deno.test('Increment 134 state-only batches retain latest text and position across reopen', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i134-text-' });
  const path = `${root}/history.sqlite3`;
  const store = new SqliteHistoryV7Store(path);
  try {
    admit(store);
    for (let ordinal = 1; ordinal <= 20; ordinal++) {
      store.appendBatch({
        executionId,
        expectedLatestOrdinal: 0,
        occurrences: [],
        assistantTextUpdates: [{ kind: 'put', state: textState('x'.repeat(ordinal), ordinal) }],
        eventCount: ordinal,
      });
    }
    store.appendBatch({
      executionId,
      expectedLatestOrdinal: 0,
      occurrences: [],
      assistantTextUpdates: [
        { kind: 'put', state: textState('next', 21, 2) },
        { kind: 'put', state: textState('next request', 22, 2) },
      ],
      eventCount: 22,
    });
    deepStrictEqual(store.listOccurrences(executionId), []);
    deepStrictEqual(store.readExecution(executionId).latestOrdinal, 0);
  } finally {
    store.close();
  }
  const reader = new SqliteHistoryV7Store(path, { readOnly: true });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    deepStrictEqual(reader.listAssistantTextStates(executionId), [
      { ...textState('x'.repeat(20), 20), firstEventOrdinal: 1 },
      { ...textState('next request', 22, 2), firstEventOrdinal: 21 },
    ]);
    deepStrictEqual(eventCount(db), 22);
    deepStrictEqual(db.prepare('PRAGMA user_version').get()!.user_version, 11);
    deepStrictEqual(
      db.prepare('SELECT schema_version FROM store_metadata').get()!.schema_version,
      11,
    );
  } finally {
    db.close();
    reader.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 134 completion and latest text read from one snapshot', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i134-snapshot-' });
  const path = `${root}/history.sqlite3`;
  const store = new SqliteHistoryV7Store(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    admit(store);
    const live = textState('Hello', 1);
    store.appendBatch({
      executionId,
      expectedLatestOrdinal: 0,
      occurrences: [],
      assistantTextUpdates: [{ kind: 'put', state: live }],
      eventCount: 1,
    });
    db.exec('BEGIN');
    deepStrictEqual(store.listAssistantTextStates(executionId, db), [live]);
    store.appendBatch({
      executionId,
      expectedLatestOrdinal: 0,
      occurrences: [completed],
      assistantTextUpdates: [{ kind: 'remove', key: live.key }],
      eventCount: 2,
    });
    deepStrictEqual(store.listAssistantTextStates(executionId, db), [live]);
    deepStrictEqual(store.listOccurrences(executionId, db), []);
    deepStrictEqual(eventCount(db), 1);
    db.exec('COMMIT');
    deepStrictEqual(store.listAssistantTextStates(executionId, db), []);
    deepStrictEqual(store.listOccurrences(executionId, db).map((item) => item.payload), [
      completed.payload,
    ]);
    deepStrictEqual(eventCount(db), 2);
  } finally {
    db.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 134 interrupted completion rolls back text, result and event progress together', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i134-atomic-' });
  const path = `${root}/history.sqlite3`;
  let interrupt = false;
  const store = new SqliteHistoryV7Store(path, {
    fault: (phase) => {
      if (interrupt && phase === 'before_commit') throw new Error('completion interrupted');
    },
  });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    admit(store);
    const live = textState('Hello', 1);
    store.appendBatch({
      executionId,
      expectedLatestOrdinal: 0,
      occurrences: [],
      assistantTextUpdates: [{ kind: 'put', state: live }],
      eventCount: 1,
    });
    interrupt = true;
    throws(() =>
      store.appendBatch({
        executionId,
        expectedLatestOrdinal: 0,
        occurrences: [completed],
        assistantTextUpdates: [{ kind: 'remove', key: live.key }],
        eventCount: 2,
      }), /completion interrupted/);
    deepStrictEqual(store.listAssistantTextStates(executionId), [live]);
    deepStrictEqual(store.listOccurrences(executionId), []);
    deepStrictEqual(eventCount(db), 1);
  } finally {
    db.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
