import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import { DatabaseSync } from 'node:sqlite';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';

Deno.test('history listWorker skips an unreadable current Session record', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i105-list-' });
  const store = new SqliteHistoryStore(`${root}/state`, root);
  try {
    await store.initialize();
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const handle = await store.allocateWorker('default', {});
      ids.push(handle.id);
      const createdAt = new Date().toISOString();
      handle.saveMetadata({
        sessionId: handle.id,
        workspaceRoot: root,
        agentChoice: {},
        createdAt,
        updatedAt: createdAt,
        title: null,
        stateRevision: 1,
        nextTurn: 1,
        activeModel: ROOT_DEFAULT_MODEL_SELECTION,
        modelChangesToAppend: [{
          effectiveFromTurn: 1,
          changedAt: createdAt,
          selection: ROOT_DEFAULT_MODEL_SELECTION,
        }],
      });
      await handle.close();
    }
    const db = new DatabaseSync(
      `${(await sessionPaths(`${root}/state`, root)).root}/history.sqlite3`,
    );
    try {
      db.prepare('UPDATE sessions SET active_model_json=? WHERE session_id=?').run(
        '{"broken":true}',
        ids[1],
      );
    } finally {
      db.close();
    }
    const listed = await store.listWorker();
    strictEqual(listed.skippedInvalid, 1);
    deepStrictEqual(listed.sessions.map((session) => session.id), [ids[0]]);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
