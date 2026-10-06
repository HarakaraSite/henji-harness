import { ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';

Deno.test('Increment 170 started Session close releases its shared Data writer lock and retains the public conversation cut', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-session-close-' });
  const stateRoot = `${root}/state`;
  const data = await createDataClient({ stateRoot, workspaceRoot: root });
  const second = new SqliteHistoryStore(stateRoot, root);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      data,
      stateRoot,
      workspaceRoot: root,
      configRoot: `${root}/config`,
      dataRoot: `${root}/resources`,
      persistence: 'new',

      physicalIoMode: 'provider-free',
    });
    ok((await created.session.submit('answer briefly')).ok);
    const sessionId = created.session.sessionId;
    const before = await data.conversationSnapshot(sessionId);
    await created.close();
    await second.initialize();
    const opened = await second.openExistingWorker(sessionId);
    ok(opened.state.sessionId === sessionId);
    await opened.handle.close();
    const saved = await data.conversationSnapshot(sessionId);
    strictEqual(saved.cut, before.cut);
    strictEqual(new TextDecoder().decode(saved.bytes), new TextDecoder().decode(before.bytes));
    const reopened = await data.openSession({
      persistence: 'session',
      sessionId,
      agent: 'default',
      agentChoice: created.session.agentChoice,
    });
    strictEqual(reopened.currentPosition.committedTurn, 1);
    strictEqual((await data.conversationSnapshot(sessionId)).cut, before.cut);
  } finally {
    await created?.close();
    second.close();
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});
