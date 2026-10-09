import { deepStrictEqual, strictEqual } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { copySchema1History } from '../../scripts/copy_increment_218_history.ts';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { workspaceDigest } from '../../v0/agent/session/session_store_paths.ts';

Deno.test('Increment 218 explicit schema1 copy preserves source and saved Session continues with schema3', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i218-copy-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const stateRoot = `${root}/state`;
  const options = {
    workspaceRoot,
    stateRoot,
    configRoot: `${root}/config`,
    dataRoot: `${root}/data`,
    physicalIoMode: 'provider-free' as const,
  };
  const core = await createCoreService({ ...options, initialSession: { kind: 'new' } });
  const sessionId = core.coreRead().activeSessionId!;
  for (let i = 0; i < 3; i++) {
    const result = await core.taskSubmit(sessionId, {
      commandId: `copy-${i}`,
      text: `full source 日本語 ${i}`,
    });
    if (result.kind !== 'accepted') throw new Error('task rejected');
    while (
      (await core.executionRead(result.value.executionId)).execution.processSettlement !==
        'complete'
    ) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await core.close();
  const folder = `${await workspaceDigest(workspaceRoot)}`;
  const dbPath = `${stateRoot}/${folder}/history.sqlite3`;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const sourcePath = `${root}/source-schema1.sqlite3`;
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec(
      await Deno.readTextFile(new URL('./fixtures/increment_218_schema1.sql', import.meta.url)),
    );
    const tables = source.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name <> 'store_metadata'",
    ).all();
    source.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const table of tables) {
      const name = String(table.name);
      const columns = source.prepare(`PRAGMA table_info(${name})`).all().map((field) =>
        String(field.name)
      );
      const insert = source.prepare(
        `INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      );
      for (const row of db.prepare(`SELECT ${columns.join(',')} FROM ${name}`).iterate()) {
        insert.run(...columns.map((column) => row[column]));
      }
    }
    source.exec('COMMIT');
  } finally {
    source.close();
    db.close();
  }
  const originalBytes = await Deno.readFile(sourcePath);
  const convertedState = `${root}/converted-state`;
  await Deno.mkdir(`${convertedState}/${folder}`, { recursive: true, mode: 0o700 });
  const destination = `${convertedState}/${folder}/history.sqlite3`;
  strictEqual(copySchema1History(sourcePath, destination).schemaVersion, 3);
  deepStrictEqual(await Deno.readFile(sourcePath), originalBytes);
  const check = new DatabaseSync(destination, { readOnly: true });
  strictEqual(check.prepare('SELECT COUNT(*) AS n FROM execution_display_positions').get()?.n, 3);
  strictEqual(
    check.prepare('SELECT base_message_count FROM executions ORDER BY turn_number DESC LIMIT 1')
      .get()?.base_message_count,
    4,
  );
  check.close();
  const resumed = await createCoreService({
    ...options,
    stateRoot: convertedState,
    initialSession: { kind: 'exact', sessionId },
  });
  try {
    const snapshot = JSON.parse(
      new TextDecoder().decode((await resumed.sessionRead(sessionId)).bytes),
    );
    strictEqual(snapshot.session.position.committedTurn, 3);
    const page = JSON.parse(
      new TextDecoder().decode((await resumed.conversationPageRead(sessionId)).bytes),
    );
    strictEqual(page.page.upperExecutionOrder, 2);
    const result = await resumed.taskSubmit(sessionId, {
      commandId: 'continued-copy',
      text: 'continue after conversion',
    });
    strictEqual(result.kind, 'accepted');
    if (result.kind === 'accepted') {
      while (
        (await resumed.executionRead(result.value.executionId)).execution.processSettlement !==
          'complete'
      ) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const after = JSON.parse(
      new TextDecoder().decode((await resumed.sessionRead(sessionId)).bytes),
    );
    strictEqual(after.session.position.committedTurn, 4);
  } finally {
    await resumed.close();
    await Deno.remove(root, { recursive: true });
  }
});
