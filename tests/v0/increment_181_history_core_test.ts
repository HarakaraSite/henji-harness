import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue } from '../../v0/agent/core/contracts.ts';
import type { StoredExecutionEvent } from '../../v0/agent/history/history_store_contract.ts';
import { HISTORY_SCHEMA_VERSION } from '../../v0/agent/history/history_schema.ts';
import {
  type HistoryCoreExecutionAdmission,
  SqliteHistoryCore,
} from '../../v0/agent/history/sqlite_history_core.ts';

const makeAdmission = (
  executionId: string,
  sessionCorrelation: string,
  overrides: Partial<HistoryCoreExecutionAdmission> = {},
): HistoryCoreExecutionAdmission => ({
  executionId,
  taskId: `task-${executionId}`,
  task: `Do work for ${executionId}`,
  sessionCorrelation,
  turn: 1,
  createdAt: '2026-10-04T00:00:00.000Z',
  agent: 'generic',
  model: { provider: 'test', model: 'model-a' },
  build: { version: 'test-build' },
  maxSteps: 8,
  baseMessageCount: 0,
  ...overrides,
});

const seedSession = (db: DatabaseSync, sessionId: string, revision: number): void => {
  db.prepare(`
    INSERT INTO sessions(
      session_id, workspace_root, agent_choice_json, created_at, updated_at, title,
      state_revision, next_turn, active_model_json, message_count,
      model_change_count, turn_count, checkpoint_json
    ) VALUES(?, '/workspace', '{}', '2026-10-04T00:00:00.000Z',
      '2026-10-04T00:00:00.000Z', NULL, ?, 1, '{}', 0, 0, 0, NULL)
  `).run(sessionId, revision);
};

Deno.test('Increment 181 core stores full admission and clean schema v1', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'increment-181-history-' });
  const databasePath = `${directory}/history.sqlite3`;
  const core = new SqliteHistoryCore(databasePath);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA foreign_keys=ON');
    seedSession(db, 'session-main', 7);
    const configurationBytes = new TextEncoder().encode(
      JSON.stringify({ agent: 'generic', tools: ['read', 'bash'] }),
    );
    const snapshotDigest = core.writeContent(configurationBytes);
    db.prepare(`
      INSERT INTO configurations(configuration_id, created_at, snapshot_content_digest)
      VALUES(?, ?, ?)
    `).run('configuration-main', '2026-10-04T00:00:00.000Z', snapshotDigest);
    db.close();
    db = undefined;

    core.beginExecutionWithAdmission({
      executionId: 'execution-main',
      sessionId: 'session-correlation-main',
      baseRevision: 7,
      admission: makeAdmission('execution-main', 'session-correlation-main', {
        canonicalSessionId: 'session-main',
        turn: 1,
        agent: 'reviewer',
        model: { provider: 'provider-a', model: 'model-b', effort: 'high' },
        build: { version: '2026.10.04', revision: 'abc' },
        configurationId: 'configuration-main',
        maxSteps: 12,
        instanceCorrelation: 'instance-main',
        workerGeneration: 'generation-main',
        parentExecutionId: undefined,
        spawnCallId: undefined,
        baseMessageCount: 3,
      }),
    });

    const controlEvent: Omit<StoredExecutionEvent, 'ordinal'> = {
      executionId: 'execution-main',
      observedAt: '2026-10-04T00:00:01.000Z',
      direction: 'host_to_worker',
      source: 'host',
      kind: 'execution_admitted',
      payload: { configurationId: 'configuration-main' },
    };
    const appendedControl = core.appendControlEvents('execution-main', [controlEvent]);
    assert.equal(appendedControl[0].ordinal, 1);
    assert.deepEqual(core.listControlEvents('execution-main'), appendedControl);

    const detachedAdmission = makeAdmission(
      'execution-detached',
      'session-correlation-detached',
      {
        task: 'Run detached child work',
        turn: 4,
        agent: 'generic',
        maxSteps: 5,
        baseMessageCount: 9,
      },
    );
    core.beginExecutionWithAdmission({
      executionId: detachedAdmission.executionId,
      sessionId: detachedAdmission.sessionCorrelation,
      baseRevision: 23,
      admission: detachedAdmission,
    });
    core.appendSemantic(
      'execution-detached',
      0,
      [{
        occurrenceId: 'detached-terminal',
        ordinal: 1,
        kind: 'host_decision',
        observedAt: '2026-10-04T00:00:02.000Z',
        payload: { outcome: 'cancelled' },
      }],
      'detached-terminal',
    );
    core.settleExecution('execution-detached', 'cancelled', {
      settledAt: '2026-10-04T00:00:03.000Z',
    });

    const inspectDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        Number(
          (inspectDb.prepare('PRAGMA user_version').get() as { user_version: number })
            .user_version,
        ),
        HISTORY_SCHEMA_VERSION,
      );
      const row = inspectDb.prepare(`
        SELECT canonical_session_id, session_correlation, task_id, task_content_digest,
          parent_execution_id, spawn_call_id, turn_number, base_revision,
          base_message_count, created_at, agent_name, configuration_id,
          build_json, model_json, max_steps, instance_correlation, worker_generation,
          lifecycle, outcome, adoption
        FROM executions WHERE execution_id=?
      `).get('execution-main') as Record<string, string | number | null>;
      assert.equal(row.canonical_session_id, 'session-main');
      assert.equal(row.session_correlation, 'session-correlation-main');
      assert.equal(row.task_id, 'task-execution-main');
      assert.equal(row.turn_number, 1);
      assert.equal(row.base_revision, 7);
      assert.equal(row.base_message_count, 3);
      assert.equal(row.agent_name, 'reviewer');
      assert.equal(row.configuration_id, 'configuration-main');
      assert.equal(row.max_steps, 12);
      assert.equal(row.instance_correlation, 'instance-main');
      assert.equal(row.worker_generation, 'generation-main');
      assert.deepEqual(JSON.parse(String(row.build_json)), {
        version: '2026.10.04',
        revision: 'abc',
      });
      assert.deepEqual(JSON.parse(String(row.model_json)), {
        provider: 'provider-a',
        model: 'model-b',
        effort: 'high',
      });
      assert.equal(row.lifecycle, 'active');
      assert.equal(row.outcome, 'unknown');
      assert.equal(row.adoption, 'non_canonical');
      assert.equal(row.parent_execution_id, null);
      assert.equal(row.spawn_call_id, null);
      const taskContent = inspectDb.prepare(
        'SELECT content_digest FROM contents WHERE content_digest=?',
      ).get(row.task_content_digest) as { content_digest: string };
      assert.equal(
        new TextDecoder().decode(core.readContent(taskContent.content_digest)),
        'Do work for execution-main',
      );
      const detached = inspectDb.prepare(`
        SELECT canonical_session_id, session_correlation, base_revision, base_message_count
        FROM executions WHERE execution_id=?
      `).get('execution-detached') as Record<string, string | number | null>;
      assert.equal(detached.canonical_session_id, null);
      assert.equal(detached.session_correlation, 'session-correlation-detached');
      assert.equal(detached.base_revision, 23);
      assert.equal(detached.base_message_count, 9);
      assert.equal(
        inspectDb.prepare(
          'SELECT lifecycle FROM executions WHERE execution_id=?',
        ).get('execution-detached')?.lifecycle,
        'settled',
      );
      assert.equal(
        inspectDb.prepare(
          'SELECT outcome FROM executions WHERE execution_id=?',
        ).get('execution-detached')?.outcome,
        'cancelled',
      );
      assert.equal(
        Number(inspectDb.prepare('SELECT count(*) AS count FROM sessions').get()?.count),
        1,
      );
    } finally {
      inspectDb.close();
    }

    assert.deepEqual(core.tableNames(), [
      'assistant_text_states',
      'configurations',
      'contents',
      'conversation_messages',
      'diagnostics',
      'execution_contexts',
      'executions',
      'messages',
      'recall_relations',
      'semantic_records',
      'semantic_relations',
      'session_model_changes',
      'session_turns',
      'sessions',
      'store_metadata',
    ]);
    assert.equal(core.tableNames().includes('session_heads'), false);
    assert.equal(core.tableNames().includes('execution_admissions'), false);
    assert.equal(core.tableNames().includes('derived_documents'), false);
  } finally {
    db?.close();
    core.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test('Increment 181 core reads semantic content, resolves relations, and retains active assistant text', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'increment-181-semantic-' });
  const databasePath = `${directory}/history.sqlite3`;
  const core = new SqliteHistoryCore(databasePath);
  let inspectDb: DatabaseSync | undefined;
  try {
    inspectDb = new DatabaseSync(databasePath);
    seedSession(inspectDb, 'session-semantic', 0);
    inspectDb.close();
    inspectDb = undefined;
    core.beginExecutionWithAdmission({
      executionId: 'execution-semantic',
      sessionId: 'session-correlation-semantic',
      baseRevision: 0,
      admission: makeAdmission('execution-semantic', 'session-correlation-semantic', {
        canonicalSessionId: 'session-semantic',
      }),
    });

    core.appendBatch({
      executionId: 'execution-semantic',
      expectedLatestOrdinal: 0,
      occurrences: [{
        occurrenceId: 'tool-call-1',
        ordinal: 1,
        kind: 'tool_call',
        observedAt: '2026-10-04T00:00:01.000Z',
        payload: { name: 'read', arguments: { path: 'README.md' } },
        relations: [{ relation: 'result', targetOccurrenceId: 'tool-result-1' }],
      }],
    });
    assert.equal(core.readExecution('execution-semantic').unresolvedMandatoryCount, 1);

    const partialEvent: StoredExecutionEvent = {
      executionId: 'execution-semantic',
      ordinal: 2,
      firstEventOrdinal: 2,
      observedAt: '2026-10-04T00:00:02.000Z',
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'worker_stage_snapshot',
      workerSequence: 2,
      payload: { stage: 'streaming', text: 'Found the project entry point.' },
    };
    const resultBytes = new TextEncoder().encode('README contents');
    core.appendBatch({
      executionId: 'execution-semantic',
      expectedLatestOrdinal: 1,
      occurrences: [{
        occurrenceId: 'tool-result-1',
        ordinal: 2,
        kind: 'tool_result',
        observedAt: '2026-10-04T00:00:02.000Z',
        payload: { ok: true, byteLength: resultBytes.byteLength },
        content: resultBytes,
      }],
      assistantTextUpdates: [{
        kind: 'put',
        state: {
          key: { modelStep: 1, requestOrdinal: 0 },
          firstEventOrdinal: 2,
          event: partialEvent,
        },
      }],
      terminalOccurrenceId: 'tool-result-1',
    });

    const occurrences = core.listOccurrences('execution-semantic');
    assert.deepEqual(occurrences.map((item) => item.occurrenceId), [
      'tool-call-1',
      'tool-result-1',
    ]);
    assert.deepEqual(occurrences[0].payload, {
      name: 'read',
      arguments: { path: 'README.md' },
    });
    assert.equal(core.readExecution('execution-semantic').unresolvedMandatoryCount, 0);
    assert.equal(
      core.readExecution('execution-semantic').terminalOccurrenceId,
      'tool-result-1',
    );
    assert.deepEqual(
      core.readContent(occurrences[1].contentDigest!),
      resultBytes,
    );
    assert.deepEqual(
      core.readAssistantTextState(
        'execution-semantic',
        { modelStep: 1, requestOrdinal: 0 },
      ),
      {
        key: { modelStep: 1, requestOrdinal: 0 },
        firstEventOrdinal: 2,
        event: partialEvent,
      },
    );
    assert.deepEqual(core.listAssistantTextStates('execution-semantic'), [{
      key: { modelStep: 1, requestOrdinal: 0 },
      firstEventOrdinal: 2,
      event: partialEvent,
    }]);

    const messageBytes = new TextEncoder().encode('The project entry point is mod.ts.');
    const messageDb = new DatabaseSync(databasePath);
    try {
      messageDb.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      const messageDigest = core.writeContent(messageBytes, messageDb);
      messageDb.prepare(`
        INSERT INTO messages(execution_id, message_ordinal, content_digest)
        VALUES(?, ?, ?)
      `).run('execution-semantic', 0, messageDigest);
      messageDb.exec('COMMIT');
    } catch (error) {
      try {
        messageDb.exec('ROLLBACK');
      } catch {
        // Keep the write error.
      }
      throw error;
    } finally {
      messageDb.close();
    }

    core.settleExecution('execution-semantic', 'completed', {
      settledAt: '2026-10-04T00:00:03.000Z',
      runtimeOutcomeJson: { result: 'done' } as JsonValue,
    });
    core.adoptCanonical('execution-semantic');
    const state = core.readExecution('execution-semantic');
    assert.equal(state.lifecycle, 'settled');
    assert.equal(state.adoption, 'canonical');
    assert.equal(state.baseRevision, 0);

    const readOnly = new SqliteHistoryCore(databasePath, { readOnly: true });
    try {
      assert.equal(readOnly.listOccurrences('execution-semantic').length, 2);
      assert.equal(readOnly.readExecution('execution-semantic').adoption, 'canonical');
    } finally {
      readOnly.close();
    }
    inspectDb = new DatabaseSync(databasePath, { readOnly: true });
    const revision = inspectDb.prepare(
      'SELECT state_revision, message_count, turn_count FROM sessions WHERE session_id=?',
    ).get('session-semantic') as {
      state_revision: number;
      message_count: number;
      turn_count: number;
    };
    assert.equal(revision.state_revision, 1);
    assert.equal(revision.message_count, 1);
    assert.equal(revision.turn_count, 1);
    const projection = inspectDb.prepare(`
      SELECT message_ordinal, turn_number, execution_id, execution_message_ordinal
      FROM conversation_messages WHERE session_id=?
    `).get('session-semantic') as Record<string, string | number>;
    assert.deepEqual({ ...projection }, {
      message_ordinal: 0,
      turn_number: 1,
      execution_id: 'execution-semantic',
      execution_message_ordinal: 0,
    });
  } finally {
    inspectDb?.close();
    core.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
