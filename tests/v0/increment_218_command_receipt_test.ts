import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';

Deno.test('Increment 218 evicted command receipts join retries and preserve terminal execution control', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i218-receipt-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const core = await createCoreService({
    workspaceRoot,
    stateRoot,
    configRoot: `${root}/config`,
    dataRoot: `${root}/data`,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
  });
  try {
    const sessionId = core.coreRead().activeSessionId!;
    const command = { commandId: 'original-submit', text: 'remember the original task' };
    const [first, joined] = await Promise.all([
      core.taskSubmit(sessionId, command),
      core.taskSubmit(sessionId, command),
    ]);
    deepStrictEqual(joined, first);
    strictEqual(first.kind, 'accepted');
    if (first.kind !== 'accepted') throw new Error('task was not accepted');
    const deadline = Date.now() + 10_000;
    while (
      (await core.executionRead(first.value.executionId)).execution.processSettlement !== 'complete'
    ) {
      if (Date.now() > deadline) throw new Error('execution did not settle');
      await new Promise((done) => setTimeout(done, 5));
    }
    for (let index = 0; index < 40; index++) {
      const result = await core.taskSubmit('00000000-0000-4000-8000-000000000000', {
        commandId: `later-command-${index}`,
        text: 'wrong Session',
      });
      strictEqual(result.kind, 'rejected');
    }
    deepStrictEqual(await core.commandRead(command.commandId), first);
    const [retry, retryJoined] = await Promise.all([
      core.taskSubmit(sessionId, command),
      core.taskSubmit(sessionId, command),
    ]);
    deepStrictEqual(retry, first);
    deepStrictEqual(retryJoined, first);
    await rejects(
      core.taskSubmit(sessionId, { ...command, text: 'different task' }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'command_id_conflict',
    );
    const execution = (await core.executionRead(first.value.executionId)).execution;
    strictEqual(execution.submittedByCommandId, command.commandId);
    strictEqual(execution.processSettlement, 'complete');
    const history = new SqliteHistoryStore(stateRoot, workspaceRoot);
    await history.initialize();
    strictEqual(history.listExecutionsForSession(sessionId).length, 1);
    history.close();
  } finally {
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 218 a receipt without a save acknowledgement retains its command ID', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i218-unacked-receipt-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const core = await createCoreService({
    workspaceRoot,
    stateRoot,
    configRoot: `${root}/config`,
    dataRoot: `${root}/data`,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
  });
  const { DatabaseSync } = await import('node:sqlite');
  const { workspaceDigest } = await import('../../v0/agent/session/session_store_paths.ts');
  const database = new DatabaseSync(
    `${stateRoot}/${await workspaceDigest(workspaceRoot)}/history.sqlite3`,
  );
  try {
    database.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON command_receipts
      WHEN NEW.command_id='unacknowledged-command'
      BEGIN SELECT RAISE(FAIL, 'fixture save failure'); END;`);
    const sessionId = core.coreRead().activeSessionId!;
    const command = { commandId: 'unacknowledged-command', text: 'admit exactly once' };
    await rejects(core.taskSubmit(sessionId, command));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const execution = database.prepare('SELECT execution_id FROM executions LIMIT 1').get();
      if (
        execution !== undefined &&
        (await core.executionRead(String(execution.execution_id))).execution.processSettlement ===
          'complete'
      ) break;
      if (Date.now() > deadline) throw new Error('execution did not settle');
      await new Promise((done) => setTimeout(done, 5));
    }
    database.exec('DROP TRIGGER reject_receipt');
    await rejects(core.taskSubmit(sessionId, command));
    strictEqual(database.prepare('SELECT COUNT(*) AS count FROM executions').get()?.count, 1);
    strictEqual((await core.commandRead(command.commandId)).kind, 'processing');
  } finally {
    await core.close();
    database.close();
    await Deno.remove(root, { recursive: true });
  }
});
