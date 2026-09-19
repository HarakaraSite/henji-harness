import { DatabaseSync } from 'node:sqlite';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { sessionPaths } from '../../v0/agent/session/session_store.ts';
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
const CREATED = '2026-09-18T00:00:00.000Z';

Deno.test('Increment 75 listWorker skips an unreadable session record', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i75-list-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const validId = '00000000-0000-4000-8000-000000000075';
  const invalidId = '00000000-0000-4000-8000-000000000076';
  try {
    const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    await store.initialize();
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history-v5.sqlite3`);
    const insertSession = db.prepare(`
      INSERT INTO sessions (session_id, agent, created_at, updated_at, title,
        state_revision, next_turn, definition_json, active_model_json)
      VALUES (?, 'default', ?, ?, NULL, 1, 1, ?, ?)
    `);
    const insertChange = db.prepare(`
      INSERT INTO session_model_changes (session_id, ordinal, effective_turn,
        changed_at, selection_json) VALUES (?, 0, 1, ?, ?)
    `);
    insertSession.run(validId, CREATED, CREATED, DEFINITION, MODEL);
    insertChange.run(validId, CREATED, MODEL);
    // A record whose stored model selection no longer parses stands in for a session written by
    // an older build; it must not make the whole listing unavailable.
    insertSession.run(
      invalidId,
      CREATED,
      CREATED,
      DEFINITION,
      '{"broken":true}',
    );
    insertChange.run(invalidId, CREATED, '{"broken":true}');
    db.close();

    const listed = await store.listWorker();
    assertEquals(listed.skippedInvalid, 1);
    assertEquals(listed.sessions.map((session) => session.id), [validId]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
