import { DatabaseSync } from 'node:sqlite';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const INDEX = 'execution_observations_execution_worker_sequence';

const indexColumns = (databasePath: string): string[] => {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (db.prepare(`PRAGMA index_info('${INDEX}')`).all() as {
      name: string;
    }[])
      .map((row) => row.name);
  } finally {
    db.close();
  }
};

const setup = async (prefix: string) => {
  const root = await Deno.makeTempDir({ prefix });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const stateRoot = `${root}/state`;
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  await store.initialize();
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  return {
    store,
    stateRoot,
    workspaceRoot,
    databasePath: `${paths.root}/history-v5.sqlite3`,
  };
};

Deno.test('Increment 87 covers worker_sequence with an execution-scoped index', async () => {
  const { databasePath } = await setup('henji-i87-index-');
  assert(
    JSON.stringify(indexColumns(databasePath)) ===
      JSON.stringify(['execution_id', 'worker_sequence']),
    `unexpected index columns: ${JSON.stringify(indexColumns(databasePath))}`,
  );
});

Deno.test('Increment 87 restores the index on an existing database', async () => {
  const { stateRoot, workspaceRoot, databasePath } = await setup(
    'henji-i87-migrate-',
  );
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`DROP INDEX IF EXISTS ${INDEX}`);
  } finally {
    db.close();
  }
  assert(indexColumns(databasePath).length === 0, 'index dropped for the test');
  const reopened = new SqliteHistoryStore(stateRoot, workspaceRoot);
  await reopened.initialize();
  assert(
    JSON.stringify(indexColumns(databasePath)) ===
      JSON.stringify(['execution_id', 'worker_sequence']),
    'index restored on initialize',
  );
});
