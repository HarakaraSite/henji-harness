import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import { DatabaseSync } from 'node:sqlite';
import { deepStrictEqual } from 'node:assert';
import { type HistorySemanticOccurrenceInput } from '../../v0/agent/history/history_semantic_model.ts';
import { SqliteHistoryCore } from '../../v0/agent/history/sqlite_history_core.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { exactByteDigest } from '../../v0/agent/history/exact_byte_plan.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { selectOpenRouterModel } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  deepStrictEqual(actual, expected);
};

const admitCore = (
  store: SqliteHistoryCore,
  input: { executionId: string; sessionId: string; baseRevision: number },
): void =>
  store.beginExecutionWithAdmission({
    ...input,
    admission: {
      executionId: input.executionId,
      taskId: 'core-test-task',
      task: 'core semantic history',
      sessionCorrelation: input.sessionId,
      turn: 1,
      createdAt: '2026-09-21T00:00:00.000Z',
      agent: 'default',
      model: {},
      build: {},
      maxSteps: 128,
      baseMessageCount: 0,
    },
  });
const configuration = workerConfigurationFixture();
const occurrence = (
  id: string,
  ordinal: number,
  kind: HistorySemanticOccurrenceInput['kind'],
  payload: HistorySemanticOccurrenceInput['payload'],
): HistorySemanticOccurrenceInput => ({
  occurrenceId: id,
  ordinal,
  kind,
  observedAt: '2026-09-21T00:00:00.000Z',
  payload,
});

Deno.test('History immutable content references reuse bytes without rehashing', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-v7-content-ref-' });
  const store = new SqliteHistoryCore(`${root}/history.sqlite3`);
  const content = new TextEncoder().encode('one immutable context value');
  const contentDigest = exactByteDigest(content);
  try {
    admitCore(store, {
      executionId: 'execution-content-1',
      sessionId: 'session-content-1',
      baseRevision: 0,
    });
    const first = store.appendSemantic('execution-content-1', 0, [{
      ...occurrence('context-content-1', 1, 'context_item', { item: 1 }),
      content,
      contentDigest,
    }]);
    assertEquals(first.contentDigestCalls, 1);
    assertEquals(first.contentBytesHashed, content.byteLength);

    admitCore(store, {
      executionId: 'execution-content-2',
      sessionId: 'session-content-2',
      baseRevision: 0,
    });
    const reused = store.appendSemantic('execution-content-2', 0, [{
      ...occurrence('context-content-2', 1, 'context_item', { item: 2 }),
      contentDigest,
    }]);
    assertEquals(reused.contentDigestCalls, 0);
    assertEquals(reused.contentBytesHashed, 0);
    assertEquals(store.readContent(contentDigest), content);
  } finally {
    store.close();
  }
});

Deno.test('History preserves rejected transcript and reason as semantic history', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-v7-rejected-' });
  const store = new SqliteHistoryCore(`${root}/history.sqlite3`);
  try {
    admitCore(store, {
      executionId: 'execution-rejected',
      sessionId: 'session-rejected',
      baseRevision: 0,
    });
    store.appendSemantic('execution-rejected', 0, [
      occurrence('proposal', 1, 'assistant_message', {
        transcript: [{ role: 'assistant', content: 'proposed result' }],
        canonical: false,
      }),
      occurrence('rejection', 2, 'host_decision', {
        outcome: 'failed',
        reason: 'commit proposal invalid: message order',
      }),
    ], 'rejection');
    store.settleExecution('execution-rejected', 'failed');
    assertEquals(store.readOccurrence('proposal').payload, {
      transcript: [{ role: 'assistant', content: 'proposed result' }],
      canonical: false,
    });
    assertEquals(store.readOccurrence('rejection').payload, {
      outcome: 'failed',
      reason: 'commit proposal invalid: message order',
    });
  } finally {
    store.close();
  }
});

Deno.test('History append crash exposes only prior committed prefix', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-v7-crash-' });
  let inject = true;
  const store = new SqliteHistoryCore(`${root}/history.sqlite3`, {
    fault: (phase) => {
      if (inject && phase === 'after_occurrences') {
        throw new Error('injected crash');
      }
    },
  });
  try {
    admitCore(store, {
      executionId: 'execution-crash',
      sessionId: 'session-crash',
      baseRevision: 0,
    });
    let failed = false;
    try {
      store.appendSemantic('execution-crash', 0, [
        occurrence('rolled-back', 1, 'assistant_message', {
          text: 'not durable',
        }),
      ]);
    } catch {
      failed = true;
    }
    assert(failed);
    assertEquals(store.readExecution('execution-crash').latestOrdinal, 0);
    inject = false;
    store.appendSemantic('execution-crash', 0, [
      occurrence('committed', 1, 'assistant_message', { text: 'durable' }),
    ]);
    assertEquals(store.readOccurrence('committed').payload, {
      text: 'durable',
    });
  } finally {
    store.close();
  }
});

Deno.test('History same delta cost is independent of existing Session length', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-v7-cost-' });
  const costs = [];
  for (const [name, prefix] of [['short', 1], ['long', 500]] as const) {
    const store = new SqliteHistoryCore(`${root}/${name}.sqlite3`);
    try {
      admitCore(store, {
        executionId: name,
        sessionId: name,
        baseRevision: 0,
      });
      const initial = Array.from(
        { length: prefix },
        (_, index) =>
          occurrence(
            `${name}-prefix-${index + 1}`,
            index + 1,
            'assistant_message',
            {
              text: `prefix-${index + 1}`,
            },
          ),
      );
      store.appendSemantic(name, 0, initial);
      costs.push(store.appendSemantic(name, prefix, [
        {
          ...occurrence(`${name}-delta`, prefix + 1, 'tool_result', {
            ok: true,
          }),
          content: new TextEncoder().encode('same-content'),
        },
      ]));
    } finally {
      store.close();
    }
  }
  assertEquals(costs[0], costs[1]);
  assertEquals(costs[0].preexistingPayloadRowsRead, 0);
  assertEquals(costs[0].preexistingPayloadBytesRewritten, 0);
});

Deno.test('History mandatory relation and terminal fences reject incomplete history', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-v7-fences-' });
  const store = new SqliteHistoryCore(`${root}/history.sqlite3`);
  try {
    admitCore(store, {
      executionId: 'execution-fences',
      sessionId: 'session-fences',
      baseRevision: 0,
    });
    store.appendSemantic('execution-fences', 0, [{
      ...occurrence('terminal-fences', 1, 'host_decision', {
        outcome: 'failed',
      }),
      relations: [{
        relation: 'caused_by',
        targetOccurrenceId: 'missing-input',
      }],
    }], 'terminal-fences');
    let incomplete = false;
    try {
      store.settleExecution('execution-fences', 'failed');
    } catch {
      incomplete = true;
    }
    assert(incomplete);
    let postTerminal = false;
    try {
      store.appendSemantic('execution-fences', 1, [
        occurrence('missing-input', 2, 'user_message', { text: 'late' }),
      ]);
    } catch {
      postTerminal = true;
    }
    assert(postTerminal);
  } finally {
    store.close();
  }
});

Deno.test('History facade settles non-canonical semantic history without diagnostic cost', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i94-v7-facade-normal-',
  });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(
    `${root}/state`,
    workspaceRoot,
    {},
  );
  const executionId = '94000000-0000-4000-8000-000000000001';
  const input = {
    taskId: '94000000-0000-4000-8000-000000000002',
    executionId,
    createdAt: '2026-09-21T02:00:00.000Z',
    sessionCorrelation: 'detached-v7-normal',
    turn: 1,
    task: 'preserve the failed proposal',
    baseStateRevision: 0,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    configuration,
    configurationId: configuration.configurationId,
    maxSteps: 128,
    command: 'history-test-command',
  };
  try {
    assertEquals(store.capturesProtocolTrace(), false);
    await store.beginExecution({ ...input, sessionMode: 'no_session' });
    store.appendExecutionEvent({
      executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'turn_dispatch_sent',
      payload: { task: input.task },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'effect_observation',
      workerSequence: 1,
      payload: {
        kind: 'effect_observation',
        correlation: {
          session: input.sessionCorrelation,
          instanceCorrelation: 'instance-v7',
          workerGeneration: 'generation-v7',
          baseStateRevision: 0,
          command: 'turn-1',
        },
        sequence: 1,
        effect: {
          kind: 'tool_call',
          turn: 1,
          call: {
            callId: 'read-1',
            name: 'read',
            arguments: { path: 'README.md' },
          },
        },
      },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'effect_observation',
      workerSequence: 2,
      payload: {
        kind: 'effect_observation',
        correlation: {
          session: input.sessionCorrelation,
          instanceCorrelation: 'instance-v7',
          workerGeneration: 'generation-v7',
          baseStateRevision: 0,
          command: 'turn-1',
        },
        sequence: 2,
        effect: {
          kind: 'tool_result',
          turn: 1,
          result: {
            kind: 'tool_result',
            callId: 'read-1',
            name: 'read',
            text: 'tool result retained',
            outcome: 'success',
          },
        },
      },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 3,
      payload: {
        kind: 'commit_proposal',
        correlation: {
          session: input.sessionCorrelation,
          instanceCorrelation: 'instance-v7',
          workerGeneration: 'generation-v7',
          baseStateRevision: 0,
          command: 'turn-1',
        },
        nextTurn: 2,
        transcript: [{
          role: 'assistant',
          content: { kind: 'text', text: 'proposal retained' },
        }],
      },
    });
    const outcome = {
      ok: false as const,
      task: input.task,
      outcome: 'contract_failure' as const,
      stopReason: 'contract_failure' as const,
      error: 'proposal rejected',
      steps: 1,
      toolCallCount: 1,
      toolResultCount: 1,
      transcript: [{
        role: 'assistant' as const,
        content: { kind: 'text' as const, text: 'proposal retained' },
      }],
    };
    let settlementHistoryReads = 0;
    const originalListExecutionEvents = store.listExecutionEvents.bind(store);
    const mutableStore = store as unknown as {
      listExecutionEvents: typeof store.listExecutionEvents;
    };
    mutableStore.listExecutionEvents = (id) => {
      settlementHistoryReads += 1;
      return originalListExecutionEvents(id);
    };
    const { transcript: messageSuffix, ...outcomeMetadata } = outcome;
    store.settleNonCanonicalExecution({
      ...input,
      messageSuffix,
      outcome: outcomeMetadata,
    });
    mutableStore.listExecutionEvents = originalListExecutionEvents;
    assertEquals(settlementHistoryReads, 0);
    const row = store.readExecution(executionId);
    assert(row.lifecycle === 'settled' && row.adoption === 'non_canonical');
    assertEquals(row.outcomeJson?.transcript, outcome.transcript);
    assert(
      store.listExecutionEvents(executionId).some((event) =>
        event.kind === 'runtime_event' &&
        JSON.stringify(event.payload).includes('proposal retained')
      ),
    );
    const effects = store.listExecutionEffects(executionId);
    assert(effects.length === 1 && effects[0].status === 'completed');
    assert(
      !store.listExecutionEvents(executionId).some((event) => event.kind === 'turn_dispatch_sent'),
    );
    const paths = await sessionPaths(`${root}/state`, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history.sqlite3`, {
      readOnly: true,
    });
    try {
      assertEquals(
        db.prepare(
          "SELECT name FROM sqlite_schema WHERE name='diagnostic_attachments'",
        ).get(),
        undefined,
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

Deno.test('History facade stores context bytes once and request item references only', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-v7-context-refs-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const content = new TextEncoder().encode(JSON.stringify({
    role: 'user',
    content: { kind: 'text', text: 'shared context content' },
  }));
  const contentDigest = exactByteDigest(content);
  const appendContext = async (
    executionId: string,
    session: string,
    occurrenceId: string,
  ) => {
    await store.beginExecution({
      taskId: crypto.randomUUID().toLowerCase(),
      executionId,
      createdAt: '2026-09-21T02:40:00.000Z',
      sessionCorrelation: session,
      sessionMode: 'no_session',
      turn: 1,
      task: 'store context by reference',
      baseStateRevision: 0,
      agent: 'default',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: 'context-test-command',
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'context_observation',
      workerSequence: 1,
      payload: {
        kind: 'context_observation',
        correlation: {
          session,
          instanceCorrelation: 'instance-v7-context',
          workerGeneration: 'generation-v7-context',
          baseStateRevision: 0,
          command: 'turn-1',
        },
        sequence: 1,
        observation: {
          kind: 'model_request_delta',
          delta: {
            schemaVersion: 2,
            requestOrdinal: 1,
            lane: 'parent',
            purpose: 'user_turn',
            modelStep: 1,
            revisionDigest: `sha256:${'1'.repeat(64)}`,
            resultItemCount: 1,
            splices: [{
              start: 0,
              deleteCount: 0,
              insertions: [{
                occurrenceId,
                occurrenceDigest: `sha256:${'2'.repeat(64)}`,
              }],
            }],
            occurrences: [{
              occurrenceId,
              kind: 'message',
              content: {
                digest: contentDigest,
                byteLength: content.byteLength,
                mediaType: 'application/vnd.henji.message+json',
              },
              sourceRelations: [],
              occurrenceDigest: `sha256:${'2'.repeat(64)}`,
              bytesBase64: content.toBase64(),
            }],
          },
        },
      },
    });
  };
  try {
    const firstExecution = '94000000-0000-4000-8000-000000000031';
    const secondExecution = '94000000-0000-4000-8000-000000000032';
    await appendContext(
      firstExecution,
      'detached-v7-context-1',
      'context-occurrence-1',
    );
    await appendContext(
      secondExecution,
      'detached-v7-context-2',
      'context-occurrence-2',
    );
    const restored = store.listExecutionEvents(secondExecution).find((event) =>
      event.kind === 'context_observation'
    );
    const restoredOccurrences = (restored!.payload as unknown as {
      observation: { delta: { occurrences: { bytesBase64?: string }[] } };
    }).observation.delta.occurrences;
    assertEquals(restoredOccurrences[0].bytesBase64, content.toBase64());

    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history.sqlite3`, {
      readOnly: true,
    });
    try {
      assertEquals(
        Number(
          (db.prepare('SELECT count(*) AS count FROM contents WHERE content_digest=?')
            .get(contentDigest) as {
              count: number;
            }).count,
        ),
        1,
      );
      assertEquals(
        Number(
          (db.prepare(`
          SELECT count(*) AS count FROM semantic_records WHERE kind='context_item'
        `).get() as { count: number }).count,
        ),
        2,
      );
      assertEquals(
        Number(
          (db.prepare(`
          SELECT count(*) AS count FROM semantic_relations WHERE relation='context_item'
        `).get() as { count: number }).count,
        ),
        2,
      );
      const requests = db.prepare(`
        SELECT payload_json FROM semantic_records WHERE kind='model_request'
      `).all() as { payload_json: string }[];
      assert(requests.length === 2);
      assert(
        requests.every((row) => !row.payload_json.includes('bytesBase64')),
      );
      assert(requests.every((row) => row.payload_json.length < 2_000));
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

Deno.test('History facade reconciles an admitted restart prefix without payload scan', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i94-v7-facade-restart-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const executionId = '94000000-0000-4000-8000-000000000021';
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  await store.beginExecution({
    taskId: '94000000-0000-4000-8000-000000000022',
    executionId,
    createdAt: '2026-09-21T02:45:00.000Z',
    sessionCorrelation: 'detached-v7-restart',
    sessionMode: 'no_session',
    turn: 1,
    task: 'restart before settlement',
    baseStateRevision: 0,
    agent: 'default',
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    configuration,
    configurationId: configuration.configurationId,
    maxSteps: 128,
    command: 'reconcile-test-command',
  });
  store.close();
  const reopened = new SqliteHistoryStore(stateRoot, workspaceRoot);
  await reopened.initialize();
  try {
    const execution = reopened.readExecution(executionId);
    assert(
      execution.lifecycle === 'settled' && execution.outcome === 'interrupted',
    );
    assert(
      reopened.listExecutionEvents(executionId).at(-1)?.kind ===
        'execution_settled',
    );
  } finally {
    reopened.close();
  }
});

Deno.test('History settlement transaction rolls back its terminal before a crash', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i94-v7-settlement-atomic-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const executionId = '94000000-0000-4000-8000-000000000041';
  const input = {
    taskId: '94000000-0000-4000-8000-000000000042',
    executionId,
    createdAt: '2026-09-21T02:50:00.000Z',
    sessionCorrelation: 'detached-v7-settlement-atomic',
    turn: 1,
    task: 'stop at the settlement commit boundary',
    baseStateRevision: 0,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    configuration,
    configurationId: configuration.configurationId,
    maxSteps: 128,
    command: 'history-test-command',
  };
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot, {
    fault: () => {
      throw new Error('simulated stop before settlement commit');
    },
  });
  await store.beginExecution({ ...input, sessionMode: 'no_session' });
  let failed = false;
  try {
    store.settleNonCanonicalExecution({
      ...input,
      messageSuffix: [],
      outcome: {
        ok: false,
        task: input.task,
        outcome: 'cancelled',
        stopReason: 'cancelled',
        steps: 0,
        toolCallCount: 0,
        toolResultCount: 0,
      },
    });
  } catch {
    failed = true;
  }
  assert(failed);
  store.close();

  const reopened = new SqliteHistoryStore(stateRoot, workspaceRoot);
  await reopened.initialize();
  try {
    const execution = reopened.readExecution(executionId);
    assert(
      execution.lifecycle === 'settled' && execution.outcome === 'interrupted',
    );
    const terminals = reopened.listExecutionEvents(executionId).filter((
      event,
    ) => event.kind === 'execution_settled');
    assertEquals(terminals.map((event) => event.kind), [
      'execution_settled',
    ]);
  } finally {
    reopened.close();
  }
});

Deno.test('Increment 94 detail export holds one snapshot across a later Worker commit', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-detail-snapshot-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let reader: SqliteHistoryStore | undefined;
  try {
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    assert((await created.session.submit('first snapshot turn')).ok);
    const sessionId = created.session.currentPosition().sessionId;
    reader = new SqliteHistoryStore(stateRoot, workspaceRoot, {
      readOnly: true,
    });
    await reader.initialize();
    const exportIterator = reader.streamHumanHistoryExport(sessionId)
      [Symbol.iterator]();
    const header = exportIterator.next();
    const session = exportIterator.next();
    assert(!header.done && header.value.kind === 'header');
    assert(!session.done && session.value.kind === 'session');
    assert((await created.session.submit('second snapshot turn')).ok);
    const remaining: typeof header.value[] = [];
    for (
      let next = exportIterator.next();
      !next.done;
      next = exportIterator.next()
    ) {
      remaining.push(next.value);
    }
    const records = [header.value, session.value, ...remaining];
    const metadata = session.value.value as Record<string, unknown>;
    assertEquals(metadata.messageCount, 2);
    assertEquals(metadata.nextTurn, 2);
    assertEquals(
      records.filter((entry) => entry.kind === 'session_message').length,
      2,
    );
    assertEquals(
      records.filter((entry) => entry.kind === 'session_turn').length,
      1,
    );
    assertEquals(
      records.filter((entry) => entry.kind === 'execution').length,
      1,
    );
    assertEquals((await reader.readWorker(sessionId)).nextTurn, 3);

    const early = reader.streamHumanHistoryExport(sessionId)[Symbol.iterator]();
    assert(!early.next().done);
    early.return?.();
  } finally {
    reader?.close();
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 94 model selection preserves committed turn attribution', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-model-rollback-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let store: SqliteHistoryStore | undefined;
  try {
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    assert((await created.session.submit('first committed turn')).ok);
    assert((await created.session.submit('second committed turn')).ok);
    const sessionId = created.session.currentPosition().sessionId;
    await created.close();
    created = undefined;

    store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    await store.initialize();
    const original = await store.readWorker(sessionId);
    const executionIds = store.listExecutionsForSession(sessionId).map((item) => item.executionId);
    assertEquals(executionIds.length, 2);
    const firstTranscript = store.readExecution(executionIds[0]).outcomeJson
      ?.transcript;
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const readAttribution = () => {
      const db = new DatabaseSync(`${paths.root}/history.sqlite3`, {
        readOnly: true,
      });
      try {
        return {
          messageTurns: (db.prepare(`
            SELECT turn_number FROM conversation_messages
            WHERE session_id=? ORDER BY message_ordinal
          `).all(sessionId) as { turn_number: number }[]).map((item) => item.turn_number),
          turnExecutions: (db.prepare(`
            SELECT execution_id FROM session_turns
            WHERE session_id=? ORDER BY turn_ordinal
          `).all(sessionId) as { execution_id: string | null }[]).map((item) => item.execution_id),
        };
      } finally {
        db.close();
      }
    };
    const before = readAttribution();
    assertEquals(before.messageTurns, [1, 1, 2, 2]);
    assertEquals(before.turnExecutions, executionIds);
    const opened = await store.openExistingWorker(sessionId);
    try {
      const selection = selectOpenRouterModel('qwen/qwen3.8-max-0902');
      const changedAt = new Date().toISOString();
      opened.handle.saveMetadata({
        sessionId: original.sessionId,
        workspaceRoot: original.workspaceRoot,
        agentChoice: original.agentChoice,
        createdAt: original.createdAt,
        updatedAt: changedAt,
        title: original.title,
        stateRevision: original.stateRevision + 1,
        nextTurn: original.nextTurn,
        activeModel: selection,
        modelChangesToAppend: [{
          effectiveFromTurn: original.nextTurn,
          changedAt,
          selection,
        }],
      });
    } finally {
      await opened.handle.close();
    }
    assertEquals((await store.readWorker(sessionId)).turnExecutions, original.turnExecutions);
    assertEquals(readAttribution(), before);
    assertEquals(
      store.readExecution(executionIds[0]).outcomeJson?.transcript,
      firstTranscript,
    );
  } finally {
    store?.close();
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 94 isolated product path settles cancellation as non-canonical current history', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-v7-cancel-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  let reportProgress!: () => void;
  const sawProgress = new Promise<void>((resolve) => reportProgress = resolve);
  const created = await createWorkerSession({
    workspaceRoot,
    stateRoot,
    persistence: 'new',
    physicalIoMode: 'provider-free',
    cancelSettlementGraceMs: 500,
    eventSink: (event) => {
      if (event.kind === 'assistant_progress') reportProgress();
    },
  });
  let sessionId: string;
  try {
    const pending = created.session.submit('slow graceful cancellation');
    await sawProgress;
    assertEquals(created.session.cancelActiveTurn(), 'requested');
    const outcome = await pending;
    assertEquals(outcome.stopReason, 'cancelled');
    sessionId = created.session.sessionId;
  } finally {
    await created.close();
  }
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  await store.initialize();
  try {
    const executions = store.listExecutionsForSession(sessionId!);
    assertEquals(executions.length, 1);
    assertEquals(executions[0].outcome, 'cancelled');
    assertEquals(executions[0].adoption, 'non_canonical');
    assertEquals((await store.readWorker(sessionId!)).nextTurn, 1);
  } finally {
    store.close();
  }
});

Deno.test('Increment 94 isolated product path commits resumes projects and exports with schema1 only', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i94-v7-product-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const first = await createWorkerSession({
    workspaceRoot,
    stateRoot,
    persistence: 'new',
    physicalIoMode: 'provider-free',
  });
  let sessionId: string;
  try {
    const outcome = await first.session.submit('v7 first product turn');
    assert(outcome.ok, JSON.stringify(outcome));
    sessionId = first.session.currentPosition().sessionId;
  } finally {
    await first.close();
  }
  const second = await createWorkerSession({
    workspaceRoot,
    stateRoot,
    persistence: 'session',
    sessionId: sessionId!,
    physicalIoMode: 'provider-free',
  });
  try {
    const outcome = await second.session.submit('v7 resumed product turn');
    assert(outcome.ok, JSON.stringify(outcome));
  } finally {
    await second.close();
  }
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  await store.initialize();
  const sourceExecutionId = '94000000-0000-4000-8000-000000000094';
  try {
    const record = await store.readWorker(sessionId!);
    assert(record.nextTurn === 3);
    assert(record.transcript.length === 4);
    const executions = store.listExecutionsForSession(sessionId!);
    assert(executions.length === 2);
    assert(executions.every((item) => item.adoption === 'canonical'));
    assert(
      executions.every((item) => item.outcomeJson?.transcript.length === 0),
    );
    for (const execution of executions) {
      const artifact = await store.executionArtifacts.read(
        execution.executionId,
      );
      assertEquals(artifact.configurationId, execution.configurationId);
      assertEquals(artifact.adoption, 'canonical');
      assert(
        store.listExecutionEvents(execution.executionId).some((event) =>
          event.kind === 'acknowledgement_sent' &&
          (event.payload as { accepted?: unknown }).accepted === true
        ),
        'the execution control history retains the accepted acknowledgement',
      );
      const proposal = store.listExecutionEvents(execution.executionId).find((
        event,
      ) =>
        event.kind === 'runtime_event' &&
        (event.payload as { kind?: unknown }).kind === 'commit_proposal'
      );
      assert(proposal !== undefined);
      const payload = proposal!.payload as {
        transcript: readonly unknown[];
        outcome?: { transcript?: readonly unknown[] };
      };
      assert(payload.transcript.length <= 2);
      assert((payload.outcome?.transcript?.length ?? 0) <= 2);
    }
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history.sqlite3`, {
      readOnly: true,
    });
    try {
      const contextItems = Number(
        (db.prepare(`
        SELECT count(*) AS count FROM semantic_records WHERE kind='context_item'
      `).get() as { count: number }).count,
      );
      const immutableContents = Number(
        (db.prepare(`
        SELECT count(*) AS count FROM contents
      `).get() as { count: number }).count,
      );
      assert(contextItems > 0);
      assert(immutableContents > 0);
      assert(contextItems > immutableContents);
      const storedContextRequests = db.prepare(`
        SELECT length(payload_json) AS bytes, payload_json
        FROM semantic_records
        WHERE kind='model_request' AND payload_json LIKE '%context_observation%'
      `).all() as { bytes: number; payload_json: string }[];
      assert(storedContextRequests.length > 0);
      assert(
        storedContextRequests.every((row) => !row.payload_json.includes('bytesBase64')),
      );
      assert(storedContextRequests.every((row) => Number(row.bytes) < 20_000));
      const rawProposals = db.prepare(`
        SELECT payload_json FROM semantic_records
        WHERE kind='model_result' AND payload_json LIKE '%commit_proposal%'
      `).all() as { payload_json: string }[];
      assert(rawProposals.length === 2);
      for (const row of rawProposals) {
        const payload = JSON.parse(row.payload_json).event.payload;
        assert(payload.transcript.length > 0);
        assertEquals(payload.outcome.transcript, []);
      }
    } finally {
      db.close();
    }
    const exported = [...store.streamHumanHistoryExport(sessionId!)];
    assert(exported[0].kind === 'header');
    assert(exported.filter((item) => item.kind === 'execution').length === 2);
    assert(exported.some((item) => item.kind === 'semantic_occurrence'));
    assert(exported.some((item) => item.kind === 'semantic_relation'));
    assert(exported.some((item) => item.kind === 'execution_context_manifest'));
    const exportedContents = exported.filter((item) => item.kind === 'immutable_content');
    assert(exportedContents.length > 0);
    assert(
      exportedContents.every((item) =>
        typeof (item.value as { contentBase64?: unknown }).contentBase64 ===
          'string'
      ),
    );
    const sourceInput = {
      taskId: '94000000-0000-4000-8000-000000000095',
      executionId: sourceExecutionId,
      createdAt: '2026-09-21T03:00:00.000Z',
      sessionCorrelation: sessionId!,
      canonicalSessionId: sessionId!,
      turn: record.nextTurn,
      task: 'failed source for recall',
      baseStateRevision: record.stateRevision,
      agent: record.agent,
      model: record.activeModel,
      build: record.turnExecutions.at(-1)!.build,
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: 'rejected-task-command',
    };
    await store.beginExecution({
      ...sourceInput,
      sessionMode: 'persistent',
    });
    const correlation = {
      session: sessionId!,
      instanceCorrelation: 'instance-v7-recall-source',
      workerGeneration: 'generation-v7-recall-source',
      baseStateRevision: record.stateRevision,
      command: 'turn-recall-source',
    };
    const user = {
      role: 'user' as const,
      content: { kind: 'text' as const, text: sourceInput.task },
    };
    const assistant = {
      role: 'assistant' as const,
      content: { kind: 'text' as const, text: 'useful failed observation' },
    };
    store.appendExecutionEvents([{
      executionId: sourceExecutionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 1,
      payload: {
        kind: 'runtime_event',
        correlation,
        sequence: 3,
        event: {
          kind: 'agent_event',
          event: { kind: 'user_message', turn: 3, message: user },
        },
      },
    }, {
      executionId: sourceExecutionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 2,
      payload: {
        kind: 'runtime_event',
        correlation,
        sequence: 2,
        event: {
          kind: 'agent_event',
          event: { kind: 'assistant_message', turn: 3, message: assistant },
        },
      },
    }]);
    store.settleNonCanonicalExecution({
      ...sourceInput,
      messageSuffix: [user, assistant],
      outcome: {
        ok: false,
        task: sourceInput.task,
        outcome: 'contract_failure',
        stopReason: 'contract_failure',
        error: 'intentional recall source',
        steps: 1,
        toolCallCount: 1,
        toolResultCount: 1,
      },
    });
  } finally {
    store.close();
  }
  const recalled = await createWorkerSession({
    workspaceRoot,
    stateRoot,
    persistence: 'session',
    sessionId: sessionId!,
    physicalIoMode: 'provider-free',
  });
  try {
    const selected = await recalled.session.prepareRecall(
      sourceExecutionId.slice(0, 8),
    );
    assert(selected.sourceExecutionId === sourceExecutionId);
    const outcome = await recalled.session.submit(
      'use the recalled observation',
    );
    assert(outcome.ok, JSON.stringify(outcome));
  } finally {
    await recalled.close();
  }
  const verified = new SqliteHistoryStore(stateRoot, workspaceRoot);
  await verified.initialize();
  try {
    const source = verified.readExecution(sourceExecutionId);
    assert(source.adoption === 'non_canonical' && source.outcome === 'failed');
    const targets = verified.listExecutionsForSession(sessionId!).filter((
      item,
    ) => item.turn === 3 && item.adoption === 'canonical');
    assert(targets.length === 1);
    const relations = verified.listRecallRelations(targets[0].executionId);
    assert(
      relations.length === 1,
      JSON.stringify({
        target: targets[0],
        relations,
        all: verified.listExecutionsForSession(sessionId!),
      }),
    );
    assert(relations[0].sourceExecutionId === sourceExecutionId);
    const recalledExport = [...verified.streamHumanHistoryExport(sessionId!)];
    assert(recalledExport.some((item) =>
      item.kind === 'recall_relation' &&
      (item.value as { sourceExecutionId?: unknown }).sourceExecutionId ===
        sourceExecutionId
    ));
    await verified.delete(sessionId!);
    assert(
      !(await verified.listWorker()).sessions.some((item) => item.id === sessionId),
    );
  } finally {
    verified.close();
  }
});
