import { ok, strictEqual } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { workspaceDigest } from '../../v0/agent/session/session_store_paths.ts';

Deno.test('Increment 218 inactive control eviction restores public revision before re-subscription', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i218-control-cache-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const stateRoot = `${root}/state`;
  const core = await createCoreService({
    workspaceRoot,
    stateRoot,
    configRoot: `${root}/config`,
    dataRoot: `${root}/data`,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
  });
  try {
    const firstId = core.coreRead().activeSessionId!;
    await core.sessionRename(firstId, { commandId: 'rename-first', title: 'retained title' });
    const before = JSON.parse(new TextDecoder().decode((await core.sessionRead(firstId)).bytes));
    ok(before.cursor.revision > 0);
    for (let index = 0; index < 40; index++) {
      const opened = await core.sessionOpen({
        commandId: `new-${index}`,
        selection: { kind: 'new' },
      });
      strictEqual(opened.kind, 'accepted');
    }
    const database = new DatabaseSync(
      `${stateRoot}/${await workspaceDigest(workspaceRoot)}/history.sqlite3`,
      { readOnly: true },
    );
    const saved = database.prepare(
      'SELECT public_revision FROM core_session_cursors WHERE core_epoch=? AND session_id=?',
    ).get(before.cursor.coreEpoch, firstId);
    database.close();
    ok(saved);
    ok(Number(saved.public_revision) >= before.cursor.revision);
    const frames: Record<string, unknown>[] = [];
    const subscription = await core.subscribeSession(firstId, (bytes) => {
      if (bytes) frames.push(JSON.parse(new TextDecoder().decode(bytes)));
    });
    const snapshot = frames[0].snapshot as typeof before;
    ok(snapshot.cursor.revision >= Number(saved.public_revision));
    strictEqual(snapshot.session.position.title, 'retained title');
    strictEqual(core.coreRead().activeSessionId === firstId, false);
    subscription.unsubscribe();
  } finally {
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
