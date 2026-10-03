import { match, ok, strictEqual } from 'node:assert';
import { createDataService } from '../../v0/agent/data/data_service.ts';
import { HistoryStoreError } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';

Deno.test('Increment 170 real Worker Host reports Data commit failure without adopting the proposed turn', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-commit-failure-' });
  const stateRoot = `${root}/state`;
  const data = await createDataService({ stateRoot, workspaceRoot: root });
  const reader = new SqliteHistoryStore(stateRoot, root, { readOnly: true });
  const commit = SqliteHistoryStore.prototype.commitCanonicalTurn;
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let commitAttempts = 0;
  try {
    created = await createWorkerSession({
      workspaceRoot: root,
      stateRoot,
      configRoot: `${root}/config`,
      dataRoot: `${root}/resources`,
      data,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    // Data settlement rollback itself is covered with the production SQLite fault in foundation.
    // This fault verifies the actual Host response to that Data commit error.
    SqliteHistoryStore.prototype.commitCanonicalTurn = function () {
      commitAttempts += 1;
      throw new HistoryStoreError('history_io_failure');
    };
    const outcome = await created.session.submit('answer briefly before the commit failure');
    strictEqual(outcome.ok, false);
    match(outcome.error ?? '', /history_io_failure/u);
    strictEqual(commitAttempts, 1);
    strictEqual(created.session.currentPosition().committedTurn, 0);
    await reader.initialize();
    const record = await reader.readWorker(created.session.sessionId);
    strictEqual(record.nextTurn, 1);
    strictEqual(record.stateRevision, 1);
    strictEqual(record.transcript.length, 0);
    const rows = reader.listExecutionsForSession(created.session.sessionId);
    strictEqual(rows.length, 1);
    ok(rows[0].adoption !== 'canonical');
    ok(rows[0].outcome !== 'completed');
    ok(rows[0].diagnosticId);
    const diagnostic = await reader.diagnostics.read(rows[0].diagnosticId);
    strictEqual(diagnostic.code, 'commit_error');
    strictEqual(diagnostic.details?.operation, 'data_authorize_commit');
    strictEqual(diagnostic.details?.exceptionType, 'HistoryStoreError');
    strictEqual(diagnostic.details?.errorCode, 'history_io_failure');
  } finally {
    SqliteHistoryStore.prototype.commitCanonicalTurn = commit;
    await created?.close();
    await data.close();
    reader.close();
    await Deno.remove(root, { recursive: true });
  }
});
