import { DatabaseSync } from 'node:sqlite';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const DEFINITION = JSON.stringify({
  schemaVersion: 1,
  resourceKind: 'agent-definition',
  resourceId: 'builtin/default',
  revision: { algorithm: 'sha256', digest: '0'.repeat(64) },
});
const MODEL = JSON.stringify(ROOT_DEFAULT_MODEL_SELECTION);
const CREATED = '2026-09-22T00:00:00.000Z';

Deno.test('Increment 105 v7 listWorker skips an unreadable session record', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i105-v7-list-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const validId = '00000000-0000-4000-8000-000000000105';
  const invalidId = '00000000-0000-4000-8000-000000000106';
  try {
    const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
    await store.initialize();
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history-v7.sqlite3`);
    const insertSession = db.prepare(`
      INSERT INTO sessions (session_id, workspace_root, agent, created_at, updated_at, title,
        state_revision, next_turn, definition_json, active_model_json, message_count,
        model_change_count, turn_count, checkpoint_json)
      VALUES (?, ?, 'default', ?, ?, NULL, 1, 1, ?, ?, 0, 0, 1, NULL)
    `);
    insertSession.run(validId, workspaceRoot, CREATED, CREATED, DEFINITION, MODEL);
    // A record whose stored model selection no longer parses stands in for a session written by
    // an older build; it must not make the whole listing unavailable.
    insertSession.run(invalidId, workspaceRoot, CREATED, CREATED, DEFINITION, '{"broken":true}');
    db.close();

    const listed = await store.listWorker();
    assertEquals(listed.skippedInvalid, 1);
    assertEquals(listed.sessions.map((session) => session.id), [validId]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
