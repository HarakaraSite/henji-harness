import { DatabaseSync } from 'node:sqlite';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import { sessionPaths } from '../../v0/agent/session/session_store.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const definition = {
  schemaVersion: 1 as const,
  resourceKind: 'agent-definition' as const,
  resourceId: 'builtin/default',
  revision: { algorithm: 'sha256' as const, digest: '5'.repeat(64) },
};

const input = (ordinal: number, sessionCorrelation = `increment-50-${ordinal}`) => ({
  taskId: `50000000-0000-4000-8001-${String(ordinal).padStart(12, '0')}`,
  executionId: `50000000-0000-4000-8002-${String(ordinal).padStart(12, '0')}`,
  createdAt: `2026-09-13T01:00:${String(ordinal).padStart(2, '0')}.000Z`,
  sessionCorrelation,
  sessionMode: 'no_session' as const,
  turn: 1,
  task: `increment 50 task ${ordinal}`,
  baseStateRevision: 1,
  agent: 'default' as const,
  model: ROOT_DEFAULT_MODEL_SELECTION,
  build: buildManifest(),
  definition,
  instanceCorrelation: `increment-50-instance-${ordinal}`,
  workerGeneration: `increment-50-generation-${ordinal}`,
});

const correlation = (ordinal: number) => ({
  session: `increment-50-${ordinal}`,
  instanceCorrelation: `increment-50-instance-${ordinal}`,
  workerGeneration: `increment-50-generation-${ordinal}`,
  baseStateRevision: 1,
  command: `turn-${ordinal}`,
});

Deno.test('Increment 50 opens only the empty v4 authority and leaves v3 sentinels unchanged', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i50-cutover-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  await Deno.mkdir(`${paths.root}/locks`, { recursive: true, mode: 0o700 });
  await Deno.chmod(stateRoot, 0o700);
  await Deno.chmod(paths.root, 0o700);
  await Deno.chmod(`${paths.root}/locks`, 0o700);
  const v3Bytes = new TextEncoder().encode('v3-main-sentinel\n');
  const walBytes = new TextEncoder().encode('v3-wal-sentinel\n');
  await Deno.writeFile(`${paths.root}/history.sqlite3`, v3Bytes);
  await Deno.writeFile(`${paths.root}/history.sqlite3-wal`, walBytes);
  await Deno.writeTextFile(`${paths.root}/locks/v3.lock`, 'held\n');
  try {
    const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    await store.initialize();
    assertEquals(await Deno.readFile(`${paths.root}/history.sqlite3`), v3Bytes);
    assertEquals(await Deno.readFile(`${paths.root}/history.sqlite3-wal`), walBytes);
    assertEquals(await Deno.readTextFile(`${paths.root}/locks/v3.lock`), 'held\n');
    const db = new DatabaseSync(`${paths.root}/history-v4.sqlite3`, { readOnly: true });
    try {
      assertEquals(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        4,
      );
      assertEquals(
        (db.prepare('SELECT schema_version FROM store_metadata').get() as {
          schema_version: number;
        }).schema_version,
        4,
      );
    } finally {
      db.close();
    }
    assert((await Deno.stat(`${paths.root}/locks-v4`)).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 50 schema normalizes facts and partial evidence progress', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i50-schema-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  try {
    await store.initialize();
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history-v4.sqlite3`, { readOnly: true });
    try {
      const columns = (table: string): string[] =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
          .map((row) => row.name);
      assert(!columns('sessions').includes('record_json'));
      assert(!columns('executions').includes('outcome_json'));
      assert(!columns('executions').includes('context_basis_json'));
      assert(!columns('execution_messages').includes('message_json'));
      assert(!columns('provider_evidence').includes('evidence_json'));
      assert(!columns('execution_artifacts').includes('artifact_json'));
      for (
        const table of [
          'execution_observations',
          'runtime_occurrences',
          'provider_observation_facts',
          'execution_progress_deltas',
          'execution_outcomes',
          'worker_generations',
          'worker_protocol_observations',
        ]
      ) {
        assert(
          db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(table) !== undefined,
          `${table} missing`,
        );
      }
    } finally {
      db.close();
    }

    const interrupted = input(3, '50000000-0000-4000-8000-000000000003');
    const interruptedCorrelation = {
      ...correlation(3),
      session: interrupted.sessionCorrelation,
    };
    await store.beginExecution(interrupted);
    store.appendExecutionEvent({
      executionId: interrupted.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_request_start',
      workerSequence: 1,
      payload: {
        kind: 'provider_observation',
        correlation: interruptedCorrelation,
        sequence: 1,
        turn: 1,
        observation: {
          kind: 'request_start',
          request: {
            ordinal: 1,
            lane: 'parent',
            phase: 'user_turn',
            modelStep: 1,
            endpoint: 'https://provider.invalid/v1/chat',
            method: 'POST',
            requestBody: '{}',
            requestBodyBytes: 2,
            requestMetadata: {
              provider: 'openrouter-chat',
              api: 'openrouter-chat-completions',
              modelId: interrupted.model.modelId,
              effort: interrupted.model.effort,
              protocol: 'sse',
            },
          },
        },
      },
    });
    for (const [index, text] of ['first partial', 'latest partial'].entries()) {
      store.appendExecutionEvent({
        executionId: interrupted.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: index + 2,
        payload: {
          kind: 'provider_observation',
          correlation: interruptedCorrelation,
          sequence: index + 2,
          turn: 1,
          observation: {
            kind: 'runtime_event',
            requestOrdinal: 1,
            event: {
              kind: 'assistant_progress',
              text,
              modelStep: 1,
              lane: 'parent',
              requestOrdinal: 1,
            },
          },
        },
      });
    }
    for (const [index, text] of ['first tool partial', 'latest tool partial'].entries()) {
      store.appendExecutionEvent({
        executionId: interrupted.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: index + 4,
        payload: {
          kind: 'provider_observation',
          correlation: interruptedCorrelation,
          sequence: index + 4,
          turn: 1,
          observation: {
            kind: 'runtime_event',
            requestOrdinal: 1,
            event: {
              kind: 'tool_progress',
              callId: 'call-50',
              name: 'read_file',
              text,
              modelStep: 1,
              lane: 'parent',
              requestOrdinal: 1,
            },
          },
        },
      });
    }
    store.reconcileExecution({
      executionId: interrupted.executionId,
      settlement: 'interrupted',
    });
    const partialEvidence = (await store.providerEvidence.list()).find((item) =>
      item.sessionId === interrupted.sessionCorrelation
    );
    assert(partialEvidence !== undefined);
    assertEquals(partialEvidence.runtimeEvents, [
      {
        kind: 'assistant_progress',
        text: 'latest partial',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
      },
      {
        kind: 'tool_progress',
        callId: 'call-50',
        name: 'read_file',
        text: 'latest tool partial',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
      },
    ]);
    const journalSnapshots = store.listExecutionEvents(interrupted.executionId)
      .filter((event) => {
        const payload = event.payload as { observation?: { event?: { kind?: string } } };
        return payload.observation?.event?.kind === 'assistant_progress';
      })
      .map((event) =>
        (event.payload as { observation: { event: { text: string } } }).observation.event.text
      );
    assertEquals(journalSnapshots, ['first partial', 'latest partial']);
    const toolJournalSnapshots = store.listExecutionEvents(interrupted.executionId)
      .filter((event) => {
        const payload = event.payload as { observation?: { event?: { kind?: string } } };
        return payload.observation?.event?.kind === 'tool_progress';
      })
      .map((event) =>
        (event.payload as { observation: { event: { text: string } } }).observation.event.text
      );
    assertEquals(toolJournalSnapshots, ['first tool partial', 'latest tool partial']);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 50 stores proposal suffix once and progress as exact append/replace deltas', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i50-facts-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const admitted = input(1);
  try {
    await store.initialize();
    await store.beginExecution(admitted);
    const snapshots = ['a', 'ab', 'ab界', 'replacement'];
    snapshots.forEach((text, index) => {
      store.appendExecutionEvent({
        executionId: admitted.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: index + 1,
        payload: {
          kind: 'provider_observation',
          correlation: correlation(1),
          sequence: index + 1,
          turn: 1,
          observation: {
            kind: 'runtime_event',
            requestOrdinal: 1,
            event: {
              kind: 'assistant_progress',
              text,
              modelStep: 1,
              lane: 'parent',
              requestOrdinal: 1,
            },
          },
        },
      });
    });
    store.appendExecutionEvent({
      executionId: admitted.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 5,
      payload: {
        kind: 'provider_observation',
        correlation: correlation(1),
        sequence: 5,
        turn: 1,
        observation: {
          kind: 'runtime_event',
          requestOrdinal: 1,
          event: {
            kind: 'model_result',
            result: { kind: 'final', text: 'answer' },
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
          },
        },
      },
    });
    const transcript = [
      { role: 'user' as const, content: { kind: 'text' as const, text: admitted.task } },
      { role: 'assistant' as const, content: { kind: 'text' as const, text: 'answer' } },
    ];
    store.appendExecutionEvent({
      executionId: admitted.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      payload: {
        kind: 'commit_proposal',
        correlation: correlation(1),
        transcript,
        nextTurn: 2,
      },
    } as never);
    const events = store.listExecutionEvents(admitted.executionId);
    assertEquals(
      events.slice(2, 6).map((event) =>
        (event.payload as {
          observation: { event: { text: string } };
        }).observation.event.text
      ),
      snapshots,
    );
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history-v4.sqlite3`, { readOnly: true });
    try {
      assertEquals(
        db.prepare(`SELECT mode, text_fragment FROM execution_progress_deltas
          WHERE execution_id = ? ORDER BY event_ordinal`).all(admitted.executionId),
        [
          { mode: 'append', text_fragment: 'a' },
          { mode: 'append', text_fragment: 'b' },
          { mode: 'append', text_fragment: '界' },
          { mode: 'replace', text_fragment: 'replacement' },
        ],
      );
      const marker = db.prepare(`SELECT payload_json FROM execution_observations
        WHERE execution_id = ? ORDER BY ordinal DESC LIMIT 1`).get(
        admitted.executionId,
      ) as { payload_json: string };
      assert(!marker.payload_json.includes('transcript'));
      assert(!marker.payload_json.includes(admitted.task));
      const messages = db.prepare(`SELECT source_kind, source_observation_ordinals_json,
          content_digest FROM execution_messages
        WHERE execution_id = ? ORDER BY ordinal`).all(admitted.executionId) as {
        source_kind: string;
        source_observation_ordinals_json: string | null;
        content_digest: string | null;
      }[];
      assertEquals(messages.map((message) => message.source_kind), ['task', 'runtime']);
      assertEquals(messages[0]?.content_digest, null);
      assertEquals(messages[1]?.content_digest, null);
      assertEquals(JSON.parse(messages[1]?.source_observation_ordinals_json ?? 'null'), [7]);
      assertEquals(
        (db.prepare('SELECT count(*) AS count FROM context_blobs').get() as { count: number })
          .count,
        0,
      );
      const runtimeTextBytes = (db.prepare(`SELECT sum(length(event_json)) AS bytes
        FROM runtime_occurrences WHERE execution_id = ?`).get(
        admitted.executionId,
      ) as { bytes: number }).bytes;
      assert(runtimeTextBytes < snapshots.reduce((sum, text) => sum + text.length, 0) + 800);
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 50 reopens runtime-referenced canonical messages from their facts', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i50-runtime-message-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  const sessionId = '50000000-0000-4000-8000-000000000004';
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const basis = input(4, sessionId);
  const admitted = {
    ...basis,
    canonicalSessionId: sessionId,
    sessionMode: 'persistent' as const,
    sessionRecord: {
      schemaVersion: 6 as const,
      sessionId,
      workspaceRoot,
      agent: 'default' as const,
      createdAt: basis.createdAt,
      updatedAt: basis.createdAt,
      title: null,
      stateRevision: 1,
      nextTurn: 1,
      transcript: [],
      definition,
      activeModel: ROOT_DEFAULT_MODEL_SELECTION,
      modelChanges: [{
        effectiveFromTurn: 1,
        changedAt: basis.createdAt,
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      }],
      turnModels: [],
      turnExecutions: [],
    } satisfies StoredSessionRecord,
  };
  const runtimeCorrelation = { ...correlation(4), session: sessionId };
  const transcript = [
    { role: 'user' as const, content: { kind: 'text' as const, text: admitted.task } },
    { role: 'assistant' as const, content: { kind: 'text' as const, text: 'runtime answer' } },
  ];
  try {
    await store.initialize();
    await store.beginExecution(admitted);
    store.appendExecutionEvent({
      executionId: admitted.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 1,
      payload: {
        kind: 'provider_observation',
        correlation: runtimeCorrelation,
        sequence: 1,
        turn: 1,
        observation: {
          kind: 'runtime_event',
          requestOrdinal: 1,
          event: {
            kind: 'model_result',
            result: { kind: 'final', text: 'runtime answer' },
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
          },
        },
      },
    });
    const record: StoredSessionRecord = {
      ...admitted.sessionRecord,
      stateRevision: 2,
      nextTurn: 2,
      transcript,
      turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
      turnExecutions: [{ turn: 1, build: admitted.build, definition }],
    };
    store.commitCanonicalTurn({
      ...admitted,
      record,
      outcome: {
        ok: true,
        task: admitted.task,
        outcome: 'final',
        stopReason: 'final',
        finalText: 'runtime answer',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript,
      },
    });
    assertEquals((await store.readWorker(sessionId)).transcript, transcript);
    assert(
      store.readHumanHistoryPage({ sessionId, direction: 'latest' }).entries
        .some((entry) => entry.text === 'runtime answer'),
    );
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history-v4.sqlite3`, { readOnly: true });
    try {
      assertEquals(
        db.prepare(`SELECT source_kind, source_observation_ordinals_json, content_digest
          FROM execution_messages WHERE execution_id = ? ORDER BY ordinal`).all(
          admitted.executionId,
        ),
        [
          {
            source_kind: 'task',
            source_observation_ordinals_json: null,
            content_digest: null,
          },
          {
            source_kind: 'runtime',
            source_observation_ordinals_json: '[3]',
            content_digest: null,
          },
        ],
      );
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 50 cumulative progress storage grows with the final text', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i50-capacity-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const admitted = input(2);
  const snapshotCount = 1_152;
  let snapshot = '';
  let legacySnapshotTextBytes = 0;
  try {
    await store.initialize();
    await store.beginExecution(admitted);
    for (let index = 0; index < snapshotCount; index += 1) {
      snapshot += 'x';
      legacySnapshotTextBytes += snapshot.length;
      store.appendExecutionEvent({
        executionId: admitted.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: index + 1,
        payload: {
          kind: 'provider_observation',
          correlation: correlation(2),
          sequence: index + 1,
          turn: 1,
          observation: {
            kind: 'runtime_event',
            requestOrdinal: 1,
            event: {
              kind: 'assistant_progress',
              text: snapshot,
              modelStep: 1,
              lane: 'parent',
              requestOrdinal: 1,
            },
          },
        },
      });
    }
    store.settleNonCanonicalExecution({
      ...admitted,
      outcome: {
        ok: false,
        task: admitted.task,
        outcome: 'cancelled',
        stopReason: 'cancelled',
        error: 'cancelled',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
    });
    const events = store.listExecutionEvents(admitted.executionId);
    const lastProgress = events.findLast((event) => {
      if (event.kind !== 'runtime_event') return false;
      const payload = event.payload as { observation?: { event?: { kind?: string } } };
      return payload.observation?.event?.kind === 'assistant_progress';
    });
    assert(lastProgress !== undefined);
    assertEquals(
      (lastProgress.payload as { observation: { event: { text: string } } }).observation.event
        .text,
      snapshot,
    );

    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const databasePath = `${paths.root}/history-v4.sqlite3`;
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const scalar = (query: string): number =>
        Number((db.prepare(query).get(admitted.executionId) as { value: number }).value);
      const deltaTextBytes = scalar(`SELECT coalesce(sum(length(text_fragment)), 0) AS value
        FROM execution_progress_deltas WHERE execution_id = ?`);
      const observationMarkerBytes = scalar(`SELECT coalesce(sum(length(payload_json)), 0) AS value
        FROM execution_observations WHERE execution_id = ?`);
      const runtimeFactBytes = scalar(`SELECT coalesce(sum(length(event_json)), 0) AS value
        FROM runtime_occurrences WHERE execution_id = ?`);
      assertEquals(deltaTextBytes, snapshot.length);
      assert(observationMarkerBytes + runtimeFactBytes + deltaTextBytes < legacySnapshotTextBytes);
      console.log(JSON.stringify({
        increment: 50,
        snapshotCount,
        finalTextBytes: snapshot.length,
        legacySnapshotTextBytes,
        deltaTextBytes,
        observationMarkerBytes,
        runtimeFactBytes,
        databaseBytes: (await Deno.stat(databasePath)).size,
      }));
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
