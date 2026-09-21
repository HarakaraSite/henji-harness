import { DatabaseSync } from 'node:sqlite';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { SqliteHistoryV6ProductionStore } from '../../v0/agent/history/sqlite_history_v6_production_store.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

Deno.test('Increment 94 production creates settles reopens and reads only v7 history', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i90-production-v6-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const created = await createWorkerSession({
    workspaceRoot,
    stateRoot,
    persistence: 'new',
    agent: 'default',
    physicalIoMode: 'provider-free',
  });
  try {
    const outcome = await created.session.submit(
      'verify v7 production authority',
    );
    assert(
      outcome.ok,
      `provider-free production turn did not commit: ${JSON.stringify(outcome)}`,
    );
    assert(outcome.executionObservationDurability === undefined);
    assert(outcome.executionObservationPersistenceError === undefined);
  } finally {
    await created.close();
  }

  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const v7Path = `${paths.root}/history-v7.sqlite3`;
  const v6Path = `${paths.root}/history-v6.sqlite3`;
  const v5Path = `${paths.root}/history-v5.sqlite3`;
  assert((await Deno.stat(v7Path)).isFile);
  let v6Exists = true;
  try {
    await Deno.stat(v6Path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) v6Exists = false;
    else throw error;
  }
  assert(!v6Exists, 'production wrote a v6 database');
  let v5Exists = true;
  try {
    await Deno.stat(v5Path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) v5Exists = false;
    else throw error;
  }
  assert(!v5Exists, 'production wrote a v5 database');

  const db = new DatabaseSync(v7Path, { readOnly: true });
  try {
    assert(
      Number(
        (db.prepare('PRAGMA user_version').get() as { user_version: number })
          .user_version,
      ) ===
        7,
    );
    const settled = db.prepare(`
      SELECT count(*) AS count FROM executions
      WHERE lifecycle='settled' AND outcome='completed' AND adoption='canonical'
    `).get() as { count: number };
    assert(Number(settled.count) === 1);
    const exact = db.prepare('SELECT count(*) AS count FROM semantic_occurrences')
      .get() as {
        count: number;
      };
    assert(Number(exact.count) > 0);
  } finally {
    db.close();
  }

  const reopened = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  await reopened.initialize();
  const listed = await reopened.listWorker();
  assert(listed.sessions.length === 1);
  const record = await reopened.readWorker(listed.sessions[0].id);
  assert(record.nextTurn === 2);
  const executions = reopened.listExecutionsForSession(record.sessionId);
  assert(executions.length === 1 && executions[0].adoption === 'canonical');
  assert(executions[0].contextCapture === 'complete');
  const events = reopened.listExecutionEvents(executions[0].executionId);
  assert(events.length > 0);
  assert(events.at(-1)?.kind === 'execution_settled');
  assert(!events.some((event) => event.kind.startsWith('acknowledgement_')));
  const artifact = (await reopened.executionArtifacts.list())[0];
  assert(artifact?.schemaVersion === 7);
  assert(artifact.contextCapture === 'complete');
  assert(artifact.acknowledgement === 'accepted_sent');
  assert(artifact.protocolTrace.length === 0);
  assert(
    reopened.readHumanHistoryPage({
      sessionId: record.sessionId,
      direction: 'latest',
    }).entries
      .length > 0,
  );
});

Deno.test('Increment 90 production correlates exact outbound bytes with provider observations', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i90-production-exact-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV6ProductionStore(stateRoot, workspaceRoot);
  await store.initialize();
  const executionId = '90000000-0000-4000-8000-000000000001';
  const taskId = '90000000-0000-4000-8000-000000000002';
  const definition = {
    schemaVersion: 1 as const,
    resourceKind: 'agent-definition' as const,
    resourceId: 'builtin/default',
    revision: { algorithm: 'sha256' as const, digest: '0'.repeat(64) },
  };
  const admitted = {
    taskId,
    executionId,
    createdAt: '2026-09-20T01:00:00.000Z',
    sessionCorrelation: 'detached-exact-test',
    turn: 1,
    task: 'capture exact request',
    baseStateRevision: 1,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    definition,
  };
  await store.beginExecution({ ...admitted, sessionMode: 'no_session' });
  const body = new TextEncoder().encode('{"model":"test","messages":[]}');
  store.appendExactRequestObservation({
    executionId,
    workerSequence: 1,
    observation: {
      bytes: body,
      captureBoundary: 'openrouter-chat:http-body-v1',
      serializerVersion: 'json-stringify-v1',
      endpoint: 'https://example.invalid/chat',
      method: 'POST',
      lane: 'parent',
      phase: 'user_turn',
      modelStep: 1,
      requestMetadata: { provider: 'openrouter-chat', modelId: 'test' },
      monolithicFallback: true,
    },
  });
  store.appendExecutionEvent({
    executionId,
    direction: 'worker_to_host',
    source: 'worker',
    kind: 'provider_request_start',
    workerSequence: 2,
    payload: {
      kind: 'provider_observation',
      correlation: {
        session: 'detached-exact-test',
        instanceCorrelation: 'instance-exact-test',
        workerGeneration: 'generation-exact-test',
        baseStateRevision: 1,
        command: 'turn-1',
      },
      sequence: 2,
      turn: 1,
      observation: {
        kind: 'request_start',
        request: {
          ordinal: 1,
          endpoint: 'https://example.invalid/chat',
          method: 'POST',
          requestBody: '',
          requestBodyBytes: body.byteLength,
          lane: 'parent',
          phase: 'user_turn',
          modelStep: 1,
          requestMetadata: { provider: 'openrouter-chat', modelId: 'test' },
        },
      },
    },
  });
  const correlation = {
    session: 'detached-exact-test',
    instanceCorrelation: 'instance-exact-test',
    workerGeneration: 'generation-exact-test',
    baseStateRevision: 1,
    command: 'turn-1',
  } as const;
  const responseBytes = new TextEncoder().encode('data: {"delta":"ok"}\n\n');
  const responseBase64 = responseBytes.toBase64();
  store.appendExecutionEvents([
    {
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_response_start',
      workerSequence: 3,
      payload: {
        kind: 'provider_observation',
        correlation,
        sequence: 3,
        turn: 1,
        observation: {
          kind: 'response_start',
          requestOrdinal: 1,
          response: { status: 200, headers: { 'content-type': 'text/event-stream' } },
        },
      },
    },
    {
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_response_bytes',
      workerSequence: 4,
      payload: {
        kind: 'provider_observation',
        correlation,
        sequence: 4,
        turn: 1,
        observation: {
          kind: 'response_bytes',
          requestOrdinal: 1,
          offset: responseBytes.byteLength,
          bytesBase64: responseBase64,
        },
      },
    },
    {
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_sse_event',
      workerSequence: 5,
      payload: {
        kind: 'provider_observation',
        correlation,
        sequence: 5,
        turn: 1,
        observation: {
          kind: 'sse_event',
          requestOrdinal: 1,
          event: {
            ordinal: 1,
            data: '{"delta":"ok"}',
            rawFrame: 'data: {"delta":"ok"}\n\n',
            rawFrameBytes: responseBytes.byteLength,
            responseBodyOffset: responseBytes.byteLength,
            parsed: { delta: 'ok' },
          },
        },
      },
    },
    {
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_parser_transition',
      workerSequence: 6,
      payload: {
        kind: 'provider_observation',
        correlation,
        sequence: 6,
        turn: 1,
        observation: {
          kind: 'parser_transition',
          requestOrdinal: 1,
          transition: { ordinal: 1, kind: 'event' },
        },
      },
    },
    {
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 7,
      payload: {
        kind: 'provider_observation',
        correlation,
        sequence: 7,
        turn: 1,
        observation: {
          kind: 'runtime_event',
          requestOrdinal: 1,
          event: {
            kind: 'assistant_progress',
            text: 'ok',
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
          },
        },
      },
    },
  ]);
  const outcome = {
    ok: false as const,
    task: admitted.task,
    outcome: 'cancelled' as const,
    stopReason: 'cancelled' as const,
    error: 'cancelled',
    steps: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    transcript: [],
  };
  store.settleNonCanonicalExecution({ ...admitted, outcome });

  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const db = new DatabaseSync(`${paths.root}/history-v6.sqlite3`, {
    readOnly: true,
  });
  try {
    assert(
      Number(
        (db.prepare('SELECT count(*) AS n FROM exact_objects').get() as {
          n: number;
        }).n,
      ) ===
        2,
    );
    assert(
      Number(
        (db.prepare('SELECT count(*) AS n FROM byte_streams').get() as {
          n: number;
        }).n,
      ) === 1,
    );
    assert(
      Number(
        (db.prepare('SELECT count(*) AS n FROM history_segments WHERE record_count = 5')
          .get() as { n: number }).n,
      ) === 1,
      'one natural observation batch should produce one multi-record segment',
    );
  } finally {
    db.close();
  }
  const events = store.listExecutionEvents(executionId);
  assert(events.some((event) => event.kind === 'provider_request_start'));
  const responseEvent = events.find((event) => event.kind === 'provider_response_bytes');
  const responseObservation = (responseEvent?.payload as {
    observation?: { bytesBase64?: string };
  } | undefined)?.observation;
  assert(responseObservation?.bytesBase64 === responseBase64);
  const sseEvent = events.find((event) => event.kind === 'provider_sse_event');
  const sseObservation = (sseEvent?.payload as {
    observation?: { event?: { rawFrame?: string } };
  } | undefined)?.observation;
  assert(sseObservation?.event?.rawFrame === 'data: {"delta":"ok"}\n\n');
  const runtimeEvent = events.find((event) => event.kind === 'runtime_event');
  const runtimeObservation = (runtimeEvent?.payload as {
    observation?: { event?: { text?: string } };
  } | undefined)?.observation;
  assert(runtimeObservation?.event?.text === 'ok');
});

Deno.test('Increment 92 non-canonical settlement does not decode an execution through readExecution', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i92-settlement-index-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV6ProductionStore(stateRoot, workspaceRoot);
  try {
    await store.initialize();
    const executionId = '92000000-0000-4000-8000-000000000090';
    const taskId = '92000000-0000-4000-8000-000000000091';
    const definition = {
      schemaVersion: 1 as const,
      resourceKind: 'agent-definition' as const,
      resourceId: 'builtin/default',
      revision: { algorithm: 'sha256' as const, digest: '2'.repeat(64) },
    };
    const input = {
      taskId,
      executionId,
      createdAt: '2026-09-21T00:00:00.000Z',
      sessionCorrelation: 'increment-92-index-session',
      turn: 1,
      task: 'settle without prior transcript decode',
      baseStateRevision: 1,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      definition,
    };
    await store.beginExecution({ ...input, sessionMode: 'no_session' });
    store.appendExecutionEvent({
      executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'turn_dispatch_sent',
      payload: { task: input.task },
    });

    let readExecutionCalls = 0;
    const originalReadExecution = store.readExecution.bind(store);
    const mutableStore = store as unknown as {
      readExecution: typeof store.readExecution;
    };
    mutableStore.readExecution = (id) => {
      readExecutionCalls += 1;
      return originalReadExecution(id);
    };
    store.settleNonCanonicalExecution({
      ...input,
      outcome: {
        ok: false,
        task: input.task,
        outcome: 'contract_failure',
        stopReason: 'contract_failure',
        error: 'focused non-canonical settlement',
        steps: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
    });
    assert(
      readExecutionCalls === 0,
      `settlement decoded an execution ${readExecutionCalls} time(s)`,
    );
    const row = store.readExecution(executionId);
    assert(row.lifecycle === 'settled' && row.adoption === 'non_canonical');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 90 production stores only turn deltas on the normal path', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i90-production-delta-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const created = await createWorkerSession({
    workspaceRoot,
    stateRoot,
    persistence: 'new',
    agent: 'default',
    physicalIoMode: 'provider-free',
  });
  try {
    for (let turn = 1; turn <= 4; turn += 1) {
      const outcome = await created.session.submit(`fixed-size turn ${turn}`);
      assert(outcome.ok);
    }
  } finally {
    await created.close();
  }

  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  await store.initialize();
  const listed = await store.listWorker();
  assert(listed.sessions.length === 1);
  const record = await store.readWorker(listed.sessions[0].id);
  const executions = store.listExecutionsForSession(record.sessionId);
  assert(executions.length === 4);
  assert(
    executions.every((execution) => execution.outcomeJson?.transcript.length === 0),
  );
  for (const execution of executions) {
    const terminal = store.listExecutionEvents(execution.executionId).find(
      (event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload.kind === 'commit_proposal';
      },
    );
    assert(terminal !== undefined);
    const payload = terminal.payload as Record<string, unknown>;
    assert(payload.providerEvidence === undefined);
    assert(
      Array.isArray(payload.transcript) && payload.transcript.length === 2,
    );
    const outcome = payload.outcome as { transcript?: unknown[] } | undefined;
    assert(outcome === undefined || outcome.transcript?.length === 2);
    assert(
      store.readExecution(execution.executionId).outcomeJson?.transcript
        .length === execution.turn * 2,
    );
  }

  const oldest = store.readHumanHistoryPage({
    sessionId: record.sessionId,
    direction: 'oldest',
    executionLimit: 1,
  });
  assert(oldest.executionCount === 1 && oldest.atOldest && !oldest.atNewest);
  assert(oldest.newerCursor !== undefined);
  const newer = store.readHumanHistoryPage({
    sessionId: record.sessionId,
    direction: 'newer',
    cursor: oldest.newerCursor,
    executionLimit: 1,
  });
  assert(
    newer.entries.some((entry) => entry.searchText.includes('fixed-size turn 2')),
  );
  const hit = store.searchHumanHistory({
    sessionId: record.sessionId,
    query: 'fixed-size turn 1',
    direction: 'next',
  });
  assert(
    hit !== undefined &&
      hit.page.entries.some((entry) => entry.id === hit.entryId),
  );
  assert(
    store.searchHumanHistory({
      sessionId: record.sessionId,
      query: 'FIXED-SIZE TURN 1',
      direction: 'next',
    }) === undefined,
  );
  assert(
    store.searchHumanHistory({
      sessionId: record.sessionId,
      query: 'f',
      direction: 'next',
    }) !== undefined,
  );
  assert(
    store.searchHumanHistory({
      sessionId: record.sessionId,
      query: 'F',
      direction: 'next',
    }) === undefined,
  );

  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const db = new DatabaseSync(`${paths.root}/history-v7.sqlite3`, {
    readOnly: true,
  });
  try {
    const session = db.prepare(`
      SELECT (SELECT count(*) FROM session_messages
        WHERE session_id=sessions.session_id) AS messages
      FROM sessions WHERE session_id=?
    `).get(record.sessionId) as {
      messages: number;
    };
    assert(Number(session.messages) === record.transcript.length);
    const outcomes = db.prepare(`
      SELECT json_array_length(outcome_json, '$.transcript') AS transcript_length
      FROM execution_admissions ORDER BY created_at
    `).all() as { transcript_length: number }[];
    assert(outcomes.every((row) => Number(row.transcript_length) === 0));
    assert(
      Number(
        (db.prepare('SELECT count(*) AS count FROM execution_messages')
          .get() as { count: number })
          .count,
      ) === 0,
    );
  } finally {
    db.close();
  }
});
