import { DatabaseSync } from 'node:sqlite';
import type { HistoryLogicalCost } from './history_authority.ts';

export interface V5FileMetric {
  readonly kind: 'database' | 'wal' | 'shm';
  readonly bytes: number;
}

export interface V5ObjectMetric {
  readonly name: string;
  readonly kind: 'table' | 'index';
  readonly physicalBytes: number;
  readonly rowCount?: number;
  readonly logicalValueBytes?: number;
}

export interface V5HistoryMetrics {
  readonly databasePath: string;
  readonly files: readonly V5FileMetric[];
  readonly totalFileBytes: number;
  readonly objects: readonly V5ObjectMetric[];
  readonly requestCount: number;
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
  readonly observationKinds: Readonly<Record<string, number>>;
  readonly storedDeltaProxy: {
    readonly unreferencedPayloadBytes: number;
    readonly logicalRecords: number;
    readonly fragmentRefs: number;
    readonly sequenceEdits: number;
    readonly microsegments: 0;
    readonly wireBytes: number;
  };
}

export interface V5OperationMetrics {
  readonly before: V5HistoryMetrics;
  readonly after: V5HistoryMetrics;
  readonly peakFiles: readonly V5FileMetric[];
  readonly peakTotalFileBytes: number;
  readonly steadyFileByteDelta: number;
  readonly logicalCost: HistoryLogicalCost;
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;

const fileBytes = async (path: string): Promise<number> => {
  try {
    return (await Deno.stat(path)).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Read-only aggregate measurement. It never returns payload text or bytes. */
export const measureV5History = async (databasePath: string): Promise<V5HistoryMetrics> => {
  const database = await fileBytes(databasePath);
  if (database === 0) throw new Error(`history database not found: ${databasePath}`);
  const files: V5FileMetric[] = [
    { kind: 'database', bytes: database },
    { kind: 'wal', bytes: await fileBytes(`${databasePath}-wal`) },
    { kind: 'shm', bytes: await fileBytes(`${databasePath}-shm`) },
  ];
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const objectsByName = new Map<string, V5ObjectMetric>();
    const physical = db.prepare(`
      SELECT name, SUM(pgsize) AS physical_bytes
      FROM dbstat GROUP BY name ORDER BY name
    `).all() as Row[];
    const catalog = db.prepare(`
      SELECT name, type FROM sqlite_master
      WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Row[];
    for (const row of catalog) {
      const name = String(row.name);
      const kind = String(row.type) as 'table' | 'index';
      const measured = physical.find((entry) => String(entry.name) === name);
      const metric: V5ObjectMetric = {
        name,
        kind,
        physicalBytes: Number(measured?.physical_bytes ?? 0),
      };
      if (kind === 'table') {
        const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Row[];
        const payloadColumns = columns.filter((column) =>
          ['TEXT', 'BLOB'].includes(String(column.type).toUpperCase())
        ).map((column) => quoteIdentifier(String(column.name)));
        const expression = payloadColumns.length === 0
          ? '0'
          : payloadColumns.map((column) => `COALESCE(length(${column}), 0)`).join(' + ');
        const values = db.prepare(`
          SELECT COUNT(*) AS row_count, COALESCE(SUM(${expression}), 0) AS logical_bytes
          FROM ${quoteIdentifier(name)}
        `).get() as Row;
        objectsByName.set(name, {
          ...metric,
          rowCount: Number(values.row_count),
          logicalValueBytes: Number(values.logical_bytes),
        });
      } else objectsByName.set(name, metric);
    }

    let requestCount = 0;
    let requestBodyBytes = 0;
    const requestRows = db.prepare(`
      SELECT observation_json FROM provider_observation_facts
      WHERE observation_kind = 'request_start' AND observation_json IS NOT NULL
    `).all() as Row[];
    for (const row of requestRows) {
      try {
        const observation = JSON.parse(String(row.observation_json)) as {
          readonly request?: { readonly requestBodyBytes?: unknown };
        };
        const bytes = observation.request?.requestBodyBytes;
        if (typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0) {
          requestCount += 1;
          requestBodyBytes += bytes;
        }
      } catch {
        // Invalid rows remain visible in table totals; this aggregate does not repair them.
      }
    }
    const response = db.prepare(`
      SELECT COALESCE(SUM(length(raw_bytes)), 0) AS bytes
      FROM provider_observation_facts WHERE observation_kind = 'response_bytes'
    `).get() as Row;
    const responseBodyBytes = Number(response.bytes);
    const kindRows = db.prepare(`
      SELECT kind, COUNT(*) AS count FROM execution_observations GROUP BY kind ORDER BY kind
    `).all() as Row[];
    const observationKinds = Object.fromEntries(
      kindRows.map((row) => [String(row.kind), Number(row.count)]),
    );
    const logicalRecords = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM execution_observations').get() as Row).count,
    );
    const fragmentRefs = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM context_occurrences').get() as Row).count,
    );
    const sequenceEdits = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM context_sequence_splices').get() as Row).count,
    );
    const contextBytes = Number(
      (db.prepare('SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM context_blobs').get() as Row)
        .bytes,
    );
    return {
      databasePath,
      files,
      totalFileBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      objects: [...objectsByName.values()],
      requestCount,
      requestBodyBytes,
      responseBodyBytes,
      observationKinds,
      storedDeltaProxy: {
        unreferencedPayloadBytes: contextBytes + requestBodyBytes + responseBodyBytes,
        logicalRecords,
        fragmentRefs,
        sequenceEdits,
        microsegments: 0,
        wireBytes: requestBodyBytes + responseBodyBytes,
      },
    };
  } finally {
    db.close();
  }
};

/** Samples DB/WAL/SHM while a caller drives a real v5 workload. */
export const measureV5HistoryOperation = async (
  databasePath: string,
  operation: () => Promise<HistoryLogicalCost>,
  sampleIntervalMs = 2,
): Promise<V5OperationMetrics> => {
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 0) {
    throw new TypeError('invalid history metric sample interval');
  }
  const before = await measureV5History(databasePath);
  const peak = new Map(before.files.map((file) => [file.kind, file.bytes]));
  let settled = false;
  const pending = operation().finally(() => {
    settled = true;
  });
  while (!settled) {
    for (const kind of ['database', 'wal', 'shm'] as const) {
      const suffix = kind === 'database' ? '' : `-${kind}`;
      peak.set(kind, Math.max(peak.get(kind) ?? 0, await fileBytes(`${databasePath}${suffix}`)));
    }
    if (!settled) await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
  }
  const logicalCost = await pending;
  const after = await measureV5History(databasePath);
  for (const file of after.files) {
    peak.set(file.kind, Math.max(peak.get(file.kind) ?? 0, file.bytes));
  }
  const peakFiles = (['database', 'wal', 'shm'] as const).map((kind) => ({
    kind,
    bytes: peak.get(kind) ?? 0,
  }));
  return {
    before,
    after,
    peakFiles,
    peakTotalFileBytes: peakFiles.reduce((sum, file) => sum + file.bytes, 0),
    steadyFileByteDelta: after.totalFileBytes - before.totalFileBytes,
    logicalCost,
  };
};
