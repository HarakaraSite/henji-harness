import { strictEqual } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';

for (const mode of ['begin', 'append']) {
  Deno.test(`Increment 150 ${mode} waits for another process's short writer transaction`, async () => {
    const root = await Deno.makeTempDir({ prefix: 'henji-i150-write-wait-' });
    const workspace = `${root}/workspace`;
    const state = `${root}/state`;
    await Deno.mkdir(workspace);
    const store = new SqliteHistoryStore(state, workspace);
    await store.initialize();
    store.close();
    const paths = await sessionPaths(state, workspace);
    const database = new DatabaseSync(`${paths.root}/history.sqlite3`);
    const executionId = crypto.randomUUID();
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--no-prompt',
        '--cached-only',
        '--no-check',
        '--allow-read=.,/tmp',
        '--allow-write=/tmp',
        '--config',
        'deno.v0.json',
        'tests/v0/fixtures/increment_150_write_wait.ts',
        mode,
        state,
        workspace,
        executionId,
      ],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const reader = child.stdout.getReader();
    let pending = '';
    const line = async (): Promise<string> => {
      while (!pending.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`writer exited before barrier: ${pending}`);
        pending += new TextDecoder().decode(chunk.value);
      }
      const index = pending.indexOf('\n');
      const value = pending.slice(0, index);
      pending = pending.slice(index + 1);
      return value;
    };
    const stderr = new Response(child.stderr).text();
    const writer = child.stdin.getWriter();
    let transaction = false;
    try {
      strictEqual(await line(), 'ready');
      database.exec('BEGIN IMMEDIATE;');
      transaction = true;
      await writer.write(new Uint8Array([10]));
      await writer.close();
      strictEqual(await line(), 'write-attempt');
      // The actual transaction is held beyond the previous 250ms helper wait.
      await new Promise((resolve) => setTimeout(resolve, 400));
      database.exec('COMMIT;');
      transaction = false;
      strictEqual(await line(), 'done');
      strictEqual((await child.status).code, 0, await stderr);
      strictEqual(
        database.prepare('SELECT lifecycle FROM executions WHERE execution_id=?')
          .get(executionId)!.lifecycle,
        'settled',
      );
      if (mode === 'append') {
        strictEqual(
          String(
            database.prepare(`
          SELECT payload_json FROM semantic_records
          WHERE execution_id=? AND kind='assistant_message'
        `).get(executionId)!.payload_json,
          ).includes('saved after wait'),
          true,
        );
      }
    } finally {
      if (transaction) database.exec('ROLLBACK;');
      database.close();
      try {
        child.kill('SIGKILL');
      } catch { /* Already exited. */ }
      await child.status;
      await stderr;
      reader.releaseLock();
      await Deno.remove(root, { recursive: true });
    }
  });
}
