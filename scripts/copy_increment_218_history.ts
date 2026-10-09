/** Explicit schema1 -> schema3 copy. Never called by normal database opening. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { HISTORY_SCHEMA_SQL, HISTORY_SCHEMA_VERSION } from '../v0/agent/history/history_schema.ts';

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const fingerprint = (
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
  keys: readonly string[],
): string => {
  const hash = createHash('sha256');
  const rows = db.prepare(
    `SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${
      keys.map(quote).join(',')
    }`,
  );
  for (const row of rows.iterate()) {
    for (const column of columns) {
      const value = row[column];
      if (value instanceof Uint8Array) {
        hash.update(`bytes:${value.length}:`);
        hash.update(value);
      } else hash.update(JSON.stringify(value) + '\n');
    }
    hash.update('\nrow\n');
  }
  return hash.digest('hex');
};

export const copySchema1History = (
  source: string,
  destination: string,
): { readonly schemaVersion: number; readonly tablesVerified: number } => {
  const reader = new DatabaseSync(source, { readOnly: true });
  let target: DatabaseSync | undefined;
  try {
    if (
      reader.prepare('SELECT schema_version FROM store_metadata WHERE singleton=1').get()
        ?.schema_version !== 1
    ) {
      throw new Error('Source must have history schema1');
    }
    // SQLite takes a consistent snapshot, including committed WAL data. Existing destinations are rejected before copying. Python sqlite3 backup is used because Deno node:sqlite disallows ATTACH/VACUUM INTO.
    const copied = new Deno.Command('python3', {
      args: [
        '-c',
        `import sqlite3, pathlib, os, sys
source, destination = sys.argv[1:]
fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.close(fd)
reader = sqlite3.connect(pathlib.Path(source).resolve().as_uri() + '?mode=ro', uri=True)
writer = sqlite3.connect(destination)
try:
 reader.backup(writer)
finally:
 writer.close()
 reader.close()`,
        source,
        destination,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).outputSync();
    if (!copied.success) throw new Error(new TextDecoder().decode(copied.stderr));
    target = new DatabaseSync(destination);
    const originalTables = reader.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => String(row.name));
    const originalDefinitions = originalTables.map((table) => {
      const fields = reader.prepare(`PRAGMA table_info(${quote(table)})`).all();
      const columns = fields.map((field) => String(field.name)).filter((name) =>
        table !== 'store_metadata' || name !== 'schema_version'
      );
      const keys = fields.filter((field) => Number(field.pk) > 0).sort((a, b) =>
        Number(a.pk) - Number(b.pk)
      ).map((field) => String(field.name));
      return { table, columns, keys, hash: fingerprint(target!, table, columns, keys) };
    });
    target.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    try {
      target.exec(
        'ALTER TABLE sessions ADD COLUMN private_state_from_turn INTEGER NOT NULL DEFAULT 1;',
      );
      for (const statement of HISTORY_SCHEMA_SQL.split(';')) {
        const match = /^\s*CREATE (?:TABLE|INDEX) (\w+)/u.exec(statement);
        if (
          match !== null &&
          target.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(match[1]) === undefined
        ) target.exec(statement);
      }
      target.exec(
        `INSERT INTO execution_display_positions(session_correlation, execution_ordinal, execution_id)
        SELECT session_correlation, ROW_NUMBER() OVER (PARTITION BY session_correlation ORDER BY created_at, execution_id)-1, execution_id FROM executions;
`,
      );
      const changes = target.prepare(
        'SELECT session_id,effective_from_turn,selection_json FROM session_model_changes ORDER BY session_id,change_ordinal',
      );
      let sessionId: string | undefined;
      let previous: { provider: string; modelId: string } | undefined;
      for (const row of changes.iterate()) {
        const current = JSON.parse(String(row.selection_json)) as {
          provider: string;
          modelId: string;
        };
        if (sessionId !== row.session_id) {
          sessionId = String(row.session_id);
          previous = undefined;
        }
        if (
          previous !== undefined &&
          (previous.provider !== current.provider || previous.modelId !== current.modelId)
        ) {
          target.prepare('UPDATE sessions SET private_state_from_turn=? WHERE session_id=?').run(
            row.effective_from_turn,
            sessionId,
          );
        }
        previous = current;
      }
      for (const entry of originalDefinitions) {
        if (fingerprint(target, entry.table, entry.columns, entry.keys) !== entry.hash) {
          throw new Error(`Original data changed in ${entry.table}`);
        }
      }
      target.exec(
        `UPDATE store_metadata SET schema_version=${HISTORY_SCHEMA_VERSION}; PRAGMA user_version=${HISTORY_SCHEMA_VERSION}; COMMIT`,
      );
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
    return { schemaVersion: HISTORY_SCHEMA_VERSION, tablesVerified: originalDefinitions.length };
  } finally {
    target?.close();
    reader.close();
  }
};

if (import.meta.main) {
  if (Deno.args.length !== 2) {
    throw new Error(
      'Usage: copy_increment_218_history.ts <source-schema1.sqlite3> <new-schema3.sqlite3>',
    );
  }
  const [source, destination] = Deno.args;
  console.log(JSON.stringify(copySchema1History(source, destination)));
}
