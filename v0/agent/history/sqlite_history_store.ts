import { DatabaseSync } from 'node:sqlite';
import type { LoopOutcome } from '../core/contracts.ts';
import {
  decodeProviderEvidence,
  encodeProviderEvidence,
  type ProviderEvidenceStore,
  type ProviderEvidenceV3,
  type StoredProviderEvidence,
  validateProviderEvidence,
} from '../provider/provider_evidence.ts';
import { isModelSelection } from '../provider/model_catalog.ts';
import { ProviderEvidenceStoreError } from '../provider/provider_evidence_store.ts';
import {
  decodeFailureDiagnostic,
  encodeFailureDiagnostic,
  type FailureDiagnosticV1,
  validateFailureDiagnostic,
} from '../session/failure_diagnostic.ts';
import {
  type FailureDiagnosticStore,
  FailureDiagnosticStoreError,
  MAX_FAILURE_DIAGNOSTIC_BYTES,
  MAX_FAILURE_DIAGNOSTICS,
} from '../session/failure_diagnostic_store.ts';
import {
  type DefinitionRevisionRef,
  isSessionId,
  MAX_VALID_SESSIONS_PER_WORKSPACE,
  type SemanticContextCheckpointV1,
  type SessionRecord,
  SessionStoreError,
  type StoredSessionRecord,
  type WorkerSessionHandle,
  type WorkerSessionListResult,
  type WorkerSessionStorePort,
} from '../session/session_store_contract.ts';
import {
  causalTranscriptIndex,
  decodeSemanticContextCheckpoint,
  decodeStoredSessionRecord,
  encodeSemanticContextCheckpoint,
  encodeSessionRecordV6,
  metadataFromStoredRecord,
  validateSemanticContextCheckpoint,
  validateSessionRecordV6,
  validRevisionRef,
} from '../session/session_record_codec.ts';
import { acquireLock, ensureDirectory, type Lock } from '../session/deno_session_store_io.ts';
import { sessionPaths, workspaceDigest } from '../session/session_store_paths.ts';
import { isBuildManifest } from '../runtime/build_manifest.ts';
import {
  decodeWorkerExecutionArtifact,
  encodeWorkerExecutionArtifact,
  type StoredWorkerExecutionArtifact,
  validateWorkerExecutionArtifact,
} from '../worker/worker_execution_artifact.ts';
import { recalledExecutionProjectionText } from '../worker/recalled_execution_context.ts';
import {
  type WorkerExecutionArtifactStore,
  WorkerExecutionArtifactStoreError,
} from '../worker/worker_execution_artifact_store.ts';
import type {
  CanonicalTurnCommitInput,
  HistoryCaptureResult,
  HistoryPersistencePort,
  HistoryStoreErrorCode,
  NonCanonicalExecutionInput,
} from './history_store_contract.ts';
import { HistoryStoreError } from './history_store_contract.ts';

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 250;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type SqlRow = Record<string, unknown>;

const historyCode = (error: unknown): HistoryStoreErrorCode => {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked/u.test(message)
    ? 'history_busy'
    : 'history_io_failure';
};

const sessionError = (error: unknown): SessionStoreError => {
  if (error instanceof SessionStoreError) return error;
  if (error instanceof HistoryStoreError) {
    return new SessionStoreError(
      error.code === 'history_busy'
        ? 'session_busy'
        : error.code === 'history_invalid'
        ? 'session_invalid'
        : 'session_io_failure',
    );
  }
  return new SessionStoreError(
    historyCode(error) === 'history_busy' ? 'session_busy' : 'session_io_failure',
  );
};

const historyError = (error: unknown): HistoryStoreError =>
  error instanceof HistoryStoreError ? error : new HistoryStoreError(historyCode(error));

const recordText = (record: StoredSessionRecord): string =>
  decoder.decode(encodeSessionRecordV6(record));

const checkpointText = (checkpoint: SemanticContextCheckpointV1): string =>
  decoder.decode(encodeSemanticContextCheckpoint(checkpoint));

const executionOutcome = (outcome: LoopOutcome): string => outcome.outcome;

const schemaSql = `
CREATE TABLE store_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  workspace_root TEXT NOT NULL,
  workspace_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT,
  state_revision INTEGER NOT NULL,
  next_turn INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  active_model_json TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE TABLE session_model_changes (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  effective_turn INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  PRIMARY KEY (session_id, ordinal)
);
CREATE TABLE semantic_checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  covered_turn INTEGER NOT NULL,
  retained_turn INTEGER NOT NULL,
  source_profile_id TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  canonical_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  session_correlation TEXT NOT NULL,
  turn INTEGER NOT NULL,
  task_text TEXT NOT NULL,
  admitted_at TEXT NOT NULL
);
CREATE TABLE executions (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  canonical_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  session_correlation TEXT NOT NULL,
  turn INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  lifecycle TEXT NOT NULL,
  outcome TEXT NOT NULL,
  adoption TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  committed_revision INTEGER,
  agent TEXT NOT NULL,
  model_json TEXT NOT NULL,
  build_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  manifest_json TEXT,
  instance_correlation TEXT,
  worker_generation TEXT,
  outcome_json TEXT NOT NULL,
  acknowledgement TEXT NOT NULL DEFAULT 'not_sent',
  generation_availability TEXT NOT NULL DEFAULT 'unknown',
  evidence_capture TEXT NOT NULL DEFAULT 'unknown',
  diagnostic_capture TEXT NOT NULL DEFAULT 'unknown',
  artifact_capture TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE canonical_turns (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  committed_revision INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  model_json TEXT NOT NULL,
  build_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  PRIMARY KEY (session_id, turn)
);
CREATE TABLE canonical_messages (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  session_ordinal INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (session_id, turn, ordinal),
  UNIQUE (session_id, session_ordinal),
  FOREIGN KEY (session_id, turn) REFERENCES canonical_turns(session_id, turn) ON DELETE CASCADE
);
CREATE TABLE execution_projections (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id) ON DELETE CASCADE,
  projection_kind TEXT NOT NULL,
  source_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  projected_text TEXT NOT NULL,
  link_status TEXT NOT NULL
);
CREATE TABLE provider_evidence (
  evidence_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  link_status TEXT NOT NULL
);
CREATE TABLE model_requests (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  request_ordinal INTEGER NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES provider_evidence(evidence_id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  phase TEXT,
  model_step INTEGER NOT NULL,
  PRIMARY KEY (execution_id, request_ordinal)
);
CREATE TABLE failure_diagnostics (
  diagnostic_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  evidence_id TEXT REFERENCES provider_evidence(evidence_id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  diagnostic_json TEXT NOT NULL,
  link_status TEXT NOT NULL
);
CREATE TABLE diagnostic_evidence_links (
  diagnostic_id TEXT PRIMARY KEY REFERENCES failure_diagnostics(diagnostic_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES provider_evidence(evidence_id) ON DELETE CASCADE
);
CREATE TABLE execution_artifacts (
  artifact_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id) ON DELETE CASCADE,
  settled_at TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  link_status TEXT NOT NULL
);
CREATE INDEX executions_session_turn ON executions(session_correlation, turn);
CREATE INDEX evidence_created ON provider_evidence(created_at, evidence_id);
CREATE INDEX diagnostics_occurred ON failure_diagnostics(occurred_at, diagnostic_id);
PRAGMA user_version = 1;
`;

export interface SqliteHistoryStoreOptions {
  readonly uuid?: () => string;
}

export class SqliteHistoryStore implements WorkerSessionStorePort, HistoryPersistencePort {
  readonly providerEvidence: ProviderEvidenceStore;
  readonly executionArtifacts: WorkerExecutionArtifactStore;
  readonly diagnostics: FailureDiagnosticStore;
  private readonly makeUuid: () => string;
  private readonly pathsPromise: ReturnType<typeof sessionPaths>;
  private databaseFile?: string;

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
    options: SqliteHistoryStoreOptions = {},
  ) {
    if (!stateRoot.startsWith('/') || stateRoot.includes('\0')) {
      throw new SessionStoreError('session_io_failure');
    }
    this.makeUuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
    this.pathsPromise = sessionPaths(stateRoot, workspaceRoot);
    this.providerEvidence = new SqliteProviderEvidenceAdapter(this);
    this.executionArtifacts = new SqliteExecutionArtifactAdapter(this);
    this.diagnostics = new SqliteDiagnosticAdapter(this);
  }

  private async layout(): Promise<
    { root: string; locks: string; database: string; digest: string }
  > {
    const paths = await this.pathsPromise;
    try {
      await ensureDirectory(this.stateRoot, 0o700);
      await ensureDirectory(paths.root, 0o700);
      await ensureDirectory(paths.locks, 0o700);
      this.databaseFile = `${paths.root}/history.sqlite3`;
      return {
        root: paths.root,
        locks: paths.locks,
        database: `${paths.root}/history.sqlite3`,
        digest: await workspaceDigest(this.workspaceRoot),
      };
    } catch (error) {
      throw sessionError(error);
    }
  }

  private async database(): Promise<DatabaseSync> {
    const layout = await this.layout();
    let db: DatabaseSync | undefined;
    let schemaLock: Lock | undefined;
    try {
      db = new DatabaseSync(layout.database);
      db.exec(
        `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
      );
      let version = Number(
        (db.prepare('PRAGMA user_version').get() as SqlRow).user_version,
      );
      if (version === 0) {
        db.close();
        db = undefined;
        schemaLock = await this.acquireSchemaLock(
          `${layout.locks}/.history-schema.lock`,
        );
        db = new DatabaseSync(layout.database);
        db.exec(
          `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
        );
        version = Number(
          (db.prepare('PRAGMA user_version').get() as SqlRow).user_version,
        );
      }
      if (version === 0) {
        const objects = Number(
          (db.prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
          )
            .get() as SqlRow)
            .count,
        );
        if (objects !== 0) throw new HistoryStoreError('history_invalid');
        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.transaction(db, () => {
          db!.exec(schemaSql);
          db!.prepare(
            'INSERT INTO store_metadata(singleton, schema_version, workspace_root, workspace_digest, created_at) VALUES (1, ?, ?, ?, ?)',
          ).run(
            SCHEMA_VERSION,
            this.workspaceRoot,
            layout.digest,
            new Date().toISOString(),
          );
        });
      }
      const currentVersion = Number(
        (db.prepare('PRAGMA user_version').get() as SqlRow).user_version,
      );
      if (currentVersion !== SCHEMA_VERSION) {
        throw new HistoryStoreError('history_invalid');
      }
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const foreignKeys = Number(
        (db.prepare('PRAGMA foreign_keys').get() as SqlRow).foreign_keys,
      );
      const journal = String(
        (db.prepare('PRAGMA journal_mode').get() as SqlRow).journal_mode,
      ).toLowerCase();
      const synchronous = Number(
        (db.prepare('PRAGMA synchronous').get() as SqlRow).synchronous,
      );
      const busyTimeout = Number(
        (db.prepare('PRAGMA busy_timeout').get() as SqlRow).timeout,
      );
      if (
        foreignKeys !== 1 || journal !== 'wal' || synchronous !== 2 ||
        busyTimeout !== BUSY_TIMEOUT_MS
      ) throw new HistoryStoreError('history_invalid');
      const metadata = db.prepare(
        'SELECT schema_version, workspace_root, workspace_digest FROM store_metadata WHERE singleton = 1',
      ).get() as SqlRow | undefined;
      if (
        metadata === undefined ||
        Number(metadata.schema_version) !== SCHEMA_VERSION ||
        metadata.workspace_root !== this.workspaceRoot ||
        metadata.workspace_digest !== layout.digest
      ) throw new HistoryStoreError('history_invalid');
      return db;
    } catch (error) {
      db?.close();
      throw historyError(error);
    } finally {
      schemaLock?.close();
    }
  }

  private async acquireSchemaLock(path: string): Promise<Lock> {
    const deadline = performance.now() + BUSY_TIMEOUT_MS;
    while (true) {
      try {
        return await acquireLock(path);
      } catch (error) {
        if (
          !(error instanceof SessionStoreError) ||
          error.code !== 'session_busy' ||
          performance.now() >= deadline
        ) {
          throw error instanceof SessionStoreError &&
              error.code === 'session_busy'
            ? new HistoryStoreError('history_busy')
            : error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private transaction<T>(db: DatabaseSync, body: () => T): T {
    try {
      db.exec('BEGIN IMMEDIATE');
      const value = body();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the transaction failure.
      }
      throw error instanceof SessionStoreError ||
          error instanceof FailureDiagnosticStoreError ||
          error instanceof ProviderEvidenceStoreError ||
          error instanceof WorkerExecutionArtifactStoreError
        ? error
        : historyError(error);
    }
  }

  private readRecord(db: DatabaseSync, id: string): StoredSessionRecord {
    const row = db.prepare(`
      SELECT agent, created_at, updated_at, title, state_revision, next_turn,
        definition_json, active_model_json, record_json
      FROM sessions WHERE session_id = ?
    `).get(id) as
      | SqlRow
      | undefined;
    if (row === undefined) throw new SessionStoreError('session_not_found');
    try {
      const record = decodeStoredSessionRecord(
        encoder.encode(String(row.record_json)),
      );
      if (
        record.sessionId !== id ||
        record.workspaceRoot !== this.workspaceRoot ||
        row.agent !== record.agent || row.created_at !== record.createdAt ||
        row.updated_at !== record.updatedAt ||
        (row.title ?? null) !== record.title ||
        Number(row.state_revision) !== record.stateRevision ||
        Number(row.next_turn) !== record.nextTurn ||
        row.definition_json !== JSON.stringify(record.definition) ||
        row.active_model_json !== JSON.stringify(record.activeModel) ||
        row.record_json !== recordText(record)
      ) {
        throw new SessionStoreError('session_invalid');
      }
      return record;
    } catch (error) {
      throw error instanceof SessionStoreError ? error : new SessionStoreError('session_invalid');
    }
  }

  private readCheckpointFromDb(
    db: DatabaseSync,
    id: string,
  ): SemanticContextCheckpointV1 | undefined {
    const row = db.prepare(`
      SELECT created_at, covered_turn, retained_turn, source_profile_id, checkpoint_json
      FROM semantic_checkpoints WHERE session_id = ?
    `).get(id) as SqlRow | undefined;
    if (row === undefined) return undefined;
    try {
      const checkpoint = decodeSemanticContextCheckpoint(
        encoder.encode(String(row.checkpoint_json)),
      );
      if (
        checkpoint.sessionId !== id ||
        row.created_at !== checkpoint.createdAt ||
        Number(row.covered_turn) !== checkpoint.coveredThroughTurn ||
        Number(row.retained_turn) !== checkpoint.retainedFromTurn ||
        row.source_profile_id !== checkpoint.sourceProfileId ||
        row.checkpoint_json !== checkpointText(checkpoint)
      ) throw new Error('checkpoint relation mismatch');
      return checkpoint;
    } catch {
      throw new SessionStoreError('session_invalid');
    }
  }

  private writeRecord(db: DatabaseSync, record: StoredSessionRecord): void {
    if (
      !validateSessionRecordV6(record) ||
      record.workspaceRoot !== this.workspaceRoot
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    db.prepare(`
      INSERT INTO sessions(
        session_id, agent, created_at, updated_at, title, state_revision, next_turn,
        definition_json, active_model_json, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        agent=excluded.agent, created_at=excluded.created_at, updated_at=excluded.updated_at,
        title=excluded.title, state_revision=excluded.state_revision, next_turn=excluded.next_turn,
        definition_json=excluded.definition_json, active_model_json=excluded.active_model_json,
        record_json=excluded.record_json
    `).run(
      record.sessionId,
      record.agent,
      record.createdAt,
      record.updatedAt,
      record.title,
      record.stateRevision,
      record.nextTurn,
      JSON.stringify(record.definition),
      JSON.stringify(record.activeModel),
      recordText(record),
    );
    db.prepare('DELETE FROM session_model_changes WHERE session_id = ?').run(
      record.sessionId,
    );
    const insert = db.prepare(`
      INSERT INTO session_model_changes(
        session_id, ordinal, effective_turn, changed_at, selection_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    record.modelChanges.forEach((change, ordinal) => {
      insert.run(
        record.sessionId,
        ordinal,
        change.effectiveFromTurn,
        change.changedAt,
        JSON.stringify(change.selection),
      );
    });
  }

  private writeProjection(
    db: DatabaseSync,
    executionId: string,
    recalled: NonCanonicalExecutionInput['recalledContext'],
  ): void {
    if (recalled === undefined) return;
    db.prepare(`
      INSERT INTO execution_projections(
        execution_id, projection_kind, source_execution_id, projected_text, link_status
      ) VALUES (?, 'recall', ?, ?, 'linked')
    `).run(
      executionId,
      recalled.sourceExecutionId,
      recalledExecutionProjectionText(recalled),
    );
  }

  private writeCaptures(
    db: DatabaseSync,
    executionId: string,
    input: CanonicalTurnCommitInput | NonCanonicalExecutionInput,
    evidence: ProviderEvidenceV3 | undefined,
    diagnostic: FailureDiagnosticV1 | undefined,
  ): HistoryCaptureResult {
    let evidenceDurability: HistoryCaptureResult['evidenceDurability'];
    let evidencePersistenceError: HistoryCaptureResult['evidencePersistenceError'];
    let diagnosticDurability: HistoryCaptureResult['diagnosticDurability'];
    let diagnosticPersistenceError: HistoryCaptureResult['diagnosticPersistenceError'];
    if (evidence !== undefined) {
      if (
        !validateProviderEvidence(evidence) ||
        evidence.sessionId !== input.sessionCorrelation ||
        evidence.turnNumber !== input.turn ||
        JSON.stringify(evidence.build) !== JSON.stringify(input.build) ||
        JSON.stringify(evidence.definition) !== JSON.stringify(input.definition)
      ) {
        evidenceDurability = 'failed';
        evidencePersistenceError = 'provider_evidence_invalid';
      } else {
        db.prepare(`
        INSERT INTO provider_evidence(
          evidence_id, execution_id, schema_version, created_at, evidence_json, link_status
        ) VALUES (?, ?, ?, ?, ?, 'linked')
        `).run(
          evidence.evidenceId,
          executionId,
          evidence.schemaVersion,
          evidence.createdAt,
          encodeProviderEvidence(evidence),
        );
        const requestInsert = db.prepare(`
        INSERT INTO model_requests(
          execution_id, request_ordinal, evidence_id, lane, phase, model_step
        ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const record of evidence.requests) {
          requestInsert.run(
            executionId,
            record.request.ordinal,
            evidence.evidenceId,
            record.request.lane,
            record.request.phase ?? null,
            record.request.modelStep,
          );
        }
        evidenceDurability = 'yes';
      }
    }
    if (diagnostic !== undefined) {
      if (
        !validateFailureDiagnostic(diagnostic) ||
        diagnostic.turnNumber !== input.turn
      ) {
        diagnosticDurability = 'failed';
        diagnosticPersistenceError = 'diagnostic_invalid';
      } else {
        const payload = encodeFailureDiagnostic(diagnostic);
        const bytes = encoder.encode(`${payload}\n`).byteLength;
        const capacity = db.prepare(
          'SELECT count(*) AS count, coalesce(sum(payload_bytes), 0) AS bytes FROM failure_diagnostics',
        ).get() as SqlRow;
        if (
          Number(capacity.count) >= MAX_FAILURE_DIAGNOSTICS ||
          Number(capacity.bytes) + bytes > MAX_FAILURE_DIAGNOSTIC_BYTES
        ) {
          diagnosticDurability = 'failed';
          diagnosticPersistenceError = 'diagnostic_capacity';
        } else {
          const evidenceId = evidenceDurability === 'yes' &&
              evidence?.diagnosticId === diagnostic.diagnosticId
            ? evidence.evidenceId
            : null;
          db.prepare(`
          INSERT INTO failure_diagnostics(
            diagnostic_id, execution_id, evidence_id, occurred_at, payload_bytes,
            diagnostic_json, link_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            diagnostic.diagnosticId,
            executionId,
            evidenceId,
            diagnostic.occurredAt,
            bytes,
            `${payload}\n`,
            evidenceId === null ? 'unlinked' : 'linked',
          );
          if (evidenceId !== null) {
            db.prepare(
              'INSERT INTO diagnostic_evidence_links(diagnostic_id, evidence_id) VALUES (?, ?)',
            ).run(diagnostic.diagnosticId, evidenceId);
          }
          diagnosticDurability = 'yes';
        }
      }
    }
    return {
      ...(evidenceDurability === undefined ? {} : { evidenceDurability }),
      ...(evidencePersistenceError === undefined ? {} : { evidencePersistenceError }),
      ...(diagnosticDurability === undefined ? {} : { diagnosticDurability }),
      ...(diagnosticPersistenceError === undefined ? {} : { diagnosticPersistenceError }),
    };
  }

  private artifactMatchesInput(
    artifact: StoredWorkerExecutionArtifact,
    input: CanonicalTurnCommitInput | NonCanonicalExecutionInput,
  ): boolean {
    return artifact.executionId === input.executionId &&
      artifact.createdAt === input.createdAt &&
      artifact.sessionId === input.sessionCorrelation &&
      artifact.turn === input.turn && artifact.agent === input.agent &&
      artifact.command.task === input.task &&
      artifact.baseStateRevision === input.baseStateRevision &&
      JSON.stringify(artifact.build) === JSON.stringify(input.build) &&
      JSON.stringify(artifact.definition) ===
        JSON.stringify(input.definition) &&
      (input.manifest === undefined ||
        JSON.stringify(artifact.manifest) === JSON.stringify(input.manifest)) &&
      (input.instanceCorrelation === undefined ||
        artifact.instanceCorrelation === input.instanceCorrelation) &&
      (input.workerGeneration === undefined ||
        artifact.workerGeneration === input.workerGeneration);
  }

  async readWorker(id: string): Promise<StoredSessionRecord> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    let db: DatabaseSync | undefined;
    try {
      db = await this.database();
      return this.readRecord(db, id);
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
    }
  }

  async readCheckpoint(
    id: string,
  ): Promise<SemanticContextCheckpointV1 | undefined> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    let db: DatabaseSync | undefined;
    try {
      db = await this.database();
      return this.readCheckpointFromDb(db, id);
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
    }
  }

  async listWorker(): Promise<WorkerSessionListResult> {
    let db: DatabaseSync | undefined;
    try {
      db = await this.database();
      const rows = db.prepare(
        'SELECT session_id FROM sessions ORDER BY updated_at DESC, session_id ASC',
      ).all() as SqlRow[];
      return {
        sessions: rows.map((row) =>
          metadataFromStoredRecord(this.readRecord(db!, String(row.session_id)))
        ),
        skippedInvalid: 0,
      };
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
    }
  }

  async allocateWorker(
    agent: SessionRecord['agent'],
    definition: DefinitionRevisionRef,
  ): Promise<WorkerSessionHandle> {
    if (
      (agent !== 'default' && agent !== 'planner') ||
      !validRevisionRef(definition)
    ) {
      throw new SessionStoreError('session_invalid');
    }
    const layout = await this.layout();
    const index = await acquireLock(`${layout.locks}/.index.lock`);
    let db: DatabaseSync | undefined;
    try {
      db = await this.database();
      const known = new Set(
        (db.prepare('SELECT session_id FROM sessions').all() as SqlRow[]).map((
          row,
        ) => String(row.session_id)),
      );
      const active = new Set<string>();
      for await (const entry of Deno.readDir(layout.locks)) {
        if (!entry.isFile || !entry.name.endsWith('.lock')) continue;
        const id = entry.name.slice(0, -5);
        if (!isSessionId(id)) continue;
        try {
          const probe = await acquireLock(`${layout.locks}/${entry.name}`);
          probe.close();
        } catch (error) {
          if (
            error instanceof SessionStoreError && error.code === 'session_busy'
          ) {
            active.add(id);
          } else throw error;
        }
      }
      if (
        new Set([...known, ...active]).size >= MAX_VALID_SESSIONS_PER_WORKSPACE
      ) {
        throw new SessionStoreError('session_limit');
      }
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const id = this.makeUuid().toLowerCase();
        if (!isSessionId(id)) continue;
        if (known.has(id) || active.has(id)) continue;
        try {
          const lock = await acquireLock(`${layout.locks}/${id}.lock`);
          return this.handle(id, agent, undefined, undefined, lock);
        } catch (error) {
          if (
            !(error instanceof SessionStoreError) ||
            error.code !== 'session_busy'
          ) throw error;
        }
      }
      throw new SessionStoreError('session_limit');
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
      index.close();
    }
  }

  async openExistingWorker(id: string): Promise<WorkerSessionHandle> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const layout = await this.layout();
    const index = await acquireLock(`${layout.locks}/.index.lock`);
    let lock: Lock | undefined;
    let db: DatabaseSync | undefined;
    try {
      lock = await acquireLock(`${layout.locks}/${id}.lock`);
      db = await this.database();
      const record = this.readRecord(db, id);
      const checkpoint = this.readCheckpointFromDb(db, id);
      return this.handle(id, record.agent, record, checkpoint, lock);
    } catch (error) {
      lock?.close();
      throw sessionError(error);
    } finally {
      db?.close();
      index.close();
    }
  }

  async delete(id: string): Promise<void> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const layout = await this.layout();
    const index = await acquireLock(`${layout.locks}/.index.lock`);
    let lock: Lock | undefined;
    let db: DatabaseSync | undefined;
    try {
      lock = await acquireLock(`${layout.locks}/${id}.lock`);
      db = await this.database();
      this.transaction(db, () => {
        const result = db!.prepare('DELETE FROM sessions WHERE session_id = ?')
          .run(id);
        if (Number(result.changes) !== 1) {
          throw new SessionStoreError('session_not_found');
        }
      });
    } catch (error) {
      throw sessionError(error);
    } finally {
      db?.close();
      lock?.close();
      index.close();
    }
  }

  private handle(
    id: string,
    agent: SessionRecord['agent'],
    initial: StoredSessionRecord | undefined,
    initialCheckpoint: SemanticContextCheckpointV1 | undefined,
    lock: Lock,
  ): WorkerSessionHandle {
    let record = initial;
    let rollbackRecord = initial;
    let checkpoint = initialCheckpoint;
    let rollbackCheckpoint = initialCheckpoint;
    let closed = false;
    return {
      id,
      get record() {
        return record === undefined ? undefined : structuredClone(record);
      },
      get checkpoint() {
        return checkpoint === undefined ? undefined : structuredClone(checkpoint);
      },
      commit: (next) => {
        if (closed) throw new SessionStoreError('session_busy');
        if (
          next.sessionId !== id || next.workspaceRoot !== this.workspaceRoot ||
          next.agent !== agent
        ) throw new SessionStoreError('session_invalid');
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.databasePathSync());
          this.configureExisting(db);
          rollbackRecord = record;
          this.transaction(db, () => this.writeRecord(db!, next));
          record = structuredClone(next);
        } catch (error) {
          throw sessionError(error);
        } finally {
          db?.close();
        }
      },
      acceptCommitted: (next) => {
        if (
          closed || next.sessionId !== id ||
          next.workspaceRoot !== this.workspaceRoot ||
          next.agent !== agent || !validateSessionRecordV6(next)
        ) {
          throw new SessionStoreError(
            closed ? 'session_busy' : 'session_invalid',
          );
        }
        rollbackRecord = record;
        record = structuredClone(next);
      },
      rollback: () => {
        if (closed || record === rollbackRecord) return;
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.databasePathSync());
          this.configureExisting(db);
          this.transaction(db, () => {
            if (rollbackRecord === undefined) {
              db!.prepare('DELETE FROM sessions WHERE session_id = ?').run(id);
            } else this.writeRecord(db!, rollbackRecord);
          });
          record = rollbackRecord;
        } catch (error) {
          throw sessionError(error);
        } finally {
          db?.close();
        }
      },
      installCheckpoint: (next) => {
        if (closed) throw new SessionStoreError('session_busy');
        if (next.sessionId !== id || !validateSemanticContextCheckpoint(next)) {
          throw new SessionStoreError('session_invalid');
        }
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.databasePathSync());
          this.configureExisting(db);
          rollbackCheckpoint = checkpoint;
          this.transaction(db, () => {
            db!.prepare(`
              INSERT INTO semantic_checkpoints(
                session_id, created_at, covered_turn, retained_turn, source_profile_id, checkpoint_json
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                created_at=excluded.created_at, covered_turn=excluded.covered_turn,
                retained_turn=excluded.retained_turn, source_profile_id=excluded.source_profile_id,
                checkpoint_json=excluded.checkpoint_json
            `).run(
              id,
              next.createdAt,
              next.coveredThroughTurn,
              next.retainedFromTurn,
              next.sourceProfileId,
              checkpointText(next),
            );
          });
          checkpoint = structuredClone(next);
        } catch (error) {
          throw sessionError(error);
        } finally {
          db?.close();
        }
      },
      rollbackCheckpoint: () => {
        if (closed || checkpoint === rollbackCheckpoint) return;
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.databasePathSync());
          this.configureExisting(db);
          this.transaction(db, () => {
            if (rollbackCheckpoint === undefined) {
              db!.prepare(
                'DELETE FROM semantic_checkpoints WHERE session_id = ?',
              ).run(id);
            } else {
              const previous = rollbackCheckpoint;
              db!.prepare(`
                INSERT INTO semantic_checkpoints(
                  session_id, created_at, covered_turn, retained_turn, source_profile_id, checkpoint_json
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                  created_at=excluded.created_at, covered_turn=excluded.covered_turn,
                  retained_turn=excluded.retained_turn, source_profile_id=excluded.source_profile_id,
                  checkpoint_json=excluded.checkpoint_json
              `).run(
                id,
                previous.createdAt,
                previous.coveredThroughTurn,
                previous.retainedFromTurn,
                previous.sourceProfileId,
                checkpointText(previous),
              );
            }
          });
          checkpoint = rollbackCheckpoint;
        } catch (error) {
          throw sessionError(error);
        } finally {
          db?.close();
        }
      },
      close: () => {
        if (closed) return Promise.resolve();
        closed = true;
        lock.close();
        return Promise.resolve();
      },
    };
  }

  private databasePathSync(): string {
    // Every handle/history port is initialized before synchronous transaction use.
    if (this.databaseFile !== undefined) return this.databaseFile;
    throw new HistoryStoreError('history_io_failure');
  }

  async initialize(): Promise<void> {
    const db = await this.database();
    db.close();
  }

  private configureExisting(db: DatabaseSync): void {
    db.exec(
      `PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
    );
  }

  commitCanonicalTurn(input: CanonicalTurnCommitInput): HistoryCaptureResult {
    const db = this.openSynchronousDatabase();
    try {
      return this.transaction(db, () => {
        if (
          !UUID_V4.test(input.taskId) || !UUID_V4.test(input.executionId) ||
          (input.agent !== 'default' && input.agent !== 'planner') ||
          !isModelSelection(input.model) || !isBuildManifest(input.build) ||
          !validRevisionRef(input.definition) ||
          input.canonicalSessionId !== input.record.sessionId ||
          input.sessionCorrelation !== input.record.sessionId ||
          input.record.stateRevision !== input.baseStateRevision + 1 ||
          input.record.nextTurn !== input.turn + 1
        ) throw new HistoryStoreError('history_invalid');
        const prior = db.prepare(
          'SELECT state_revision FROM sessions WHERE session_id = ?',
        ).get(input.record.sessionId) as SqlRow | undefined;
        if (
          prior !== undefined &&
            Number(prior.state_revision) !== input.baseStateRevision ||
          prior === undefined && input.baseStateRevision !== 1
        ) throw new HistoryStoreError('history_invalid');
        this.writeRecord(db, input.record);
        db.prepare(`
          INSERT INTO tasks(
            task_id, canonical_session_id, session_correlation, turn, task_text, admitted_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          input.taskId,
          input.record.sessionId,
          input.sessionCorrelation,
          input.turn,
          input.task,
          input.createdAt,
        );
        db.prepare(`
          INSERT INTO executions(
            execution_id, task_id, canonical_session_id, session_correlation, turn,
            created_at, settled_at, lifecycle, outcome, adoption, base_revision,
            committed_revision, agent, model_json, build_json, definition_json,
            manifest_json, instance_correlation, worker_generation, outcome_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'settled', 'completed', 'canonical', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.executionId,
          input.taskId,
          input.record.sessionId,
          input.sessionCorrelation,
          input.turn,
          input.createdAt,
          input.record.updatedAt,
          input.baseStateRevision,
          input.record.stateRevision,
          input.agent,
          JSON.stringify(input.model),
          JSON.stringify(input.build),
          JSON.stringify(input.definition),
          input.manifest === undefined ? null : JSON.stringify(input.manifest),
          input.instanceCorrelation ?? null,
          input.workerGeneration ?? null,
          JSON.stringify(input.outcome),
        );
        const index = causalTranscriptIndex(input.record.transcript);
        const range = index?.turns.find((turn) => turn.turn === input.turn);
        const turnModel = input.record.turnModels.find((entry) => entry.turn === input.turn);
        const turnExecution = input.record.turnExecutions.find((entry) =>
          entry.turn === input.turn
        );
        if (
          range === undefined || turnModel === undefined ||
          turnExecution === undefined
        ) {
          throw new HistoryStoreError('history_invalid');
        }
        db.prepare(`
          INSERT INTO canonical_turns(
            session_id, turn, execution_id, committed_revision, committed_at,
            model_json, build_json, definition_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.record.sessionId,
          input.turn,
          input.executionId,
          input.record.stateRevision,
          input.record.updatedAt,
          JSON.stringify(turnModel.selection),
          JSON.stringify(turnExecution.build),
          JSON.stringify(turnExecution.definition),
        );
        const insertMessage = db.prepare(`
          INSERT INTO canonical_messages(
            session_id, turn, ordinal, execution_id, session_ordinal, message_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        input.record.transcript.slice(range.start, range.end).forEach(
          (message, ordinal) => {
            insertMessage.run(
              input.record.sessionId,
              input.turn,
              ordinal,
              input.executionId,
              range.start + ordinal,
              JSON.stringify(message),
            );
          },
        );
        this.writeProjection(db, input.executionId, input.recalledContext);
        if (
          input.agent !== input.record.agent ||
          JSON.stringify(input.model) !== JSON.stringify(turnModel.selection) ||
          JSON.stringify(input.build) !== JSON.stringify(turnExecution.build) ||
          JSON.stringify(input.definition) !==
            JSON.stringify(turnExecution.definition)
        ) throw new HistoryStoreError('history_invalid');
        const capture = this.writeCaptures(
          db,
          input.executionId,
          input,
          input.evidence,
          input.diagnostic,
        );
        let artifactCapture = 'unknown';
        if (input.artifactForCapture !== undefined) {
          const artifact = input.artifactForCapture(capture);
          if (
            !validateWorkerExecutionArtifact(artifact) ||
            !this.artifactMatchesInput(artifact, input) ||
            artifact.storeResult !== 'committed' ||
            artifact.committedStateRevision !== input.record.stateRevision ||
            artifact.acknowledgement !== 'not_sent' ||
            artifact.settlement !== 'committed_observation_pending'
          ) throw new HistoryStoreError('history_invalid');
          db.prepare(`
            INSERT INTO execution_artifacts(
              artifact_id, execution_id, settled_at, artifact_json, link_status
            ) VALUES (?, ?, ?, ?, 'linked')
          `).run(
            artifact.executionId,
            artifact.executionId,
            artifact.settledAt,
            `${encodeWorkerExecutionArtifact(artifact)}\n`,
          );
          artifactCapture = 'pending_observation';
        }
        db.prepare(`
          UPDATE executions SET evidence_capture = ?, diagnostic_capture = ?,
            artifact_capture = ?
          WHERE execution_id = ?
        `).run(
          capture.evidenceDurability ?? 'unknown',
          capture.diagnosticPersistenceError ?? capture.diagnosticDurability ??
            'unknown',
          artifactCapture,
          input.executionId,
        );
        return capture;
      });
    } finally {
      db.close();
    }
  }

  settleNonCanonicalExecution(
    input: NonCanonicalExecutionInput,
  ): HistoryCaptureResult {
    const db = this.openSynchronousDatabase();
    try {
      return this.transaction(db, () => {
        if (
          !UUID_V4.test(input.taskId) || !UUID_V4.test(input.executionId) ||
          (input.agent !== 'default' && input.agent !== 'planner') ||
          !isModelSelection(input.model) || !isBuildManifest(input.build) ||
          !validRevisionRef(input.definition)
        ) {
          throw new HistoryStoreError('history_invalid');
        }
        if (input.canonicalSessionId !== undefined) {
          const found = db.prepare(
            'SELECT 1 AS found FROM sessions WHERE session_id = ?',
          ).get(
            input.canonicalSessionId,
          );
          if (!found) throw new HistoryStoreError('history_invalid');
        }
        db.prepare(`
          INSERT INTO tasks(
            task_id, canonical_session_id, session_correlation, turn, task_text, admitted_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          input.taskId,
          input.canonicalSessionId ?? null,
          input.sessionCorrelation,
          input.turn,
          input.task,
          input.createdAt,
        );
        db.prepare(`
          INSERT INTO executions(
            execution_id, task_id, canonical_session_id, session_correlation, turn,
            created_at, settled_at, lifecycle, outcome, adoption, base_revision,
            agent, model_json, build_json, definition_json, manifest_json,
            instance_correlation, worker_generation, outcome_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'settled', ?, 'non_canonical', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.executionId,
          input.taskId,
          input.canonicalSessionId ?? null,
          input.sessionCorrelation,
          input.turn,
          input.createdAt,
          new Date().toISOString(),
          executionOutcome(input.outcome),
          input.baseStateRevision,
          input.agent,
          JSON.stringify(input.model),
          JSON.stringify(input.build),
          JSON.stringify(input.definition),
          input.manifest === undefined ? null : JSON.stringify(input.manifest),
          input.instanceCorrelation ?? null,
          input.workerGeneration ?? null,
          JSON.stringify(input.outcome),
        );
        this.writeProjection(db, input.executionId, input.recalledContext);
        const capture = this.writeCaptures(
          db,
          input.executionId,
          input,
          input.evidence,
          input.diagnostic,
        );
        db.prepare(`
          UPDATE executions SET evidence_capture = ?, diagnostic_capture = ?
          WHERE execution_id = ?
        `).run(
          capture.evidenceDurability ?? 'unknown',
          capture.diagnosticPersistenceError ?? capture.diagnosticDurability ??
            'unknown',
          input.executionId,
        );
        if (input.artifactForCapture !== undefined) {
          const artifact = input.artifactForCapture(capture);
          if (
            !validateWorkerExecutionArtifact(artifact) ||
            !this.artifactMatchesInput(artifact, input)
          ) throw new HistoryStoreError('history_invalid');
          db.prepare(`
            INSERT INTO execution_artifacts(
              artifact_id, execution_id, settled_at, artifact_json, link_status
            ) VALUES (?, ?, ?, ?, 'linked')
          `).run(
            artifact.executionId,
            artifact.executionId,
            artifact.settledAt,
            `${encodeWorkerExecutionArtifact(artifact)}\n`,
          );
          db.prepare(`
            UPDATE executions SET settled_at = ?, acknowledgement = ?,
              generation_availability = ?, artifact_capture = 'yes'
            WHERE execution_id = ?
          `).run(
            artifact.settledAt,
            artifact.acknowledgement,
            artifact.settlement === 'committed'
              ? 'available'
              : artifact.settlement === 'committed_generation_unavailable'
              ? 'unavailable'
              : 'unknown',
            artifact.executionId,
          );
        }
        return capture;
      });
    } finally {
      db.close();
    }
  }

  recordPostCommitObservation(artifact: StoredWorkerExecutionArtifact): void {
    if (!validateWorkerExecutionArtifact(artifact)) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.openSynchronousDatabase();
    try {
      this.transaction(db, () => {
        const execution = db.prepare(`
          SELECT execution_id, session_correlation, turn, created_at, base_revision, agent,
            build_json, definition_json, manifest_json, instance_correlation, worker_generation
          FROM executions WHERE execution_id = ?
        `).get(artifact.executionId) as SqlRow | undefined;
        if (
          execution === undefined ||
          execution.session_correlation !== artifact.sessionId ||
          Number(execution.turn) !== artifact.turn ||
          execution.created_at !== artifact.createdAt ||
          Number(execution.base_revision) !== artifact.baseStateRevision ||
          execution.agent !== artifact.agent ||
          execution.build_json !== JSON.stringify(artifact.build) ||
          execution.definition_json !== JSON.stringify(artifact.definition) ||
          execution.manifest_json !== JSON.stringify(artifact.manifest) ||
          execution.instance_correlation !== artifact.instanceCorrelation ||
          execution.worker_generation !== artifact.workerGeneration
        ) throw new HistoryStoreError('history_invalid');
        const encoded = `${encodeWorkerExecutionArtifact(artifact)}\n`;
        const updated = db.prepare(`
          UPDATE execution_artifacts
          SET settled_at = ?, artifact_json = ?, link_status = 'linked'
          WHERE execution_id = ?
        `).run(
          artifact.settledAt,
          encoded,
          artifact.executionId,
        );
        if (Number(updated.changes) === 0) {
          db.prepare(`
          INSERT INTO execution_artifacts(
            artifact_id, execution_id, settled_at, artifact_json, link_status
          ) VALUES (?, ?, ?, ?, 'linked')
        `).run(
              artifact.executionId,
              artifact.executionId,
              artifact.settledAt,
              encoded,
            );
        }
        db.prepare(`
          UPDATE executions SET settled_at = ?, acknowledgement = ?,
            generation_availability = ?, artifact_capture = 'yes'
          WHERE execution_id = ?
        `).run(
          artifact.settledAt,
          artifact.acknowledgement,
          artifact.settlement === 'committed'
            ? 'available'
            : artifact.settlement === 'committed_generation_unavailable'
            ? 'unavailable'
            : 'unknown',
          artifact.executionId,
        );
      });
    } finally {
      db.close();
    }
  }

  private openSynchronousDatabase(): DatabaseSync {
    const path = this.databasePathSync();
    try {
      const db = new DatabaseSync(path);
      this.configureExisting(db);
      const version = Number(
        (db.prepare('PRAGMA user_version').get() as SqlRow).user_version,
      );
      if (version !== SCHEMA_VERSION) {
        db.close();
        throw new HistoryStoreError('history_invalid');
      }
      return db;
    } catch (error) {
      throw historyError(error);
    }
  }

  private evidenceFromRow(row: SqlRow): StoredProviderEvidence {
    try {
      const evidence = decodeProviderEvidence(String(row.evidence_json));
      if (
        row.evidence_id !== evidence.evidenceId ||
        Number(row.schema_version) !== evidence.schemaVersion ||
        row.created_at !== evidence.createdAt
      ) throw new ProviderEvidenceStoreError('provider_evidence_invalid');
      return evidence;
    } catch {
      throw new ProviderEvidenceStoreError('provider_evidence_invalid');
    }
  }

  private artifactFromRow(row: SqlRow): StoredWorkerExecutionArtifact {
    try {
      const artifact = decodeWorkerExecutionArtifact(String(row.artifact_json));
      if (
        row.artifact_id !== artifact.executionId ||
        row.execution_id !== artifact.executionId ||
        row.settled_at !== artifact.settledAt
      ) {
        throw new WorkerExecutionArtifactStoreError(
          'worker_execution_artifact_invalid',
        );
      }
      return artifact;
    } catch {
      throw new WorkerExecutionArtifactStoreError(
        'worker_execution_artifact_invalid',
      );
    }
  }

  private diagnosticFromRow(row: SqlRow): FailureDiagnosticV1 {
    try {
      const diagnostic = decodeFailureDiagnostic(String(row.diagnostic_json));
      if (
        row.diagnostic_id !== diagnostic.diagnosticId ||
        row.occurred_at !== diagnostic.occurredAt ||
        Number(row.payload_bytes) !==
          encoder.encode(String(row.diagnostic_json)).byteLength
      ) throw new FailureDiagnosticStoreError('diagnostic_invalid');
      return diagnostic;
    } catch {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
  }

  _listEvidence(): readonly StoredProviderEvidence[] {
    const db = this.openSynchronousDatabase();
    try {
      return (db.prepare(
        `SELECT evidence_id, schema_version, created_at, evidence_json
         FROM provider_evidence ORDER BY created_at, evidence_id`,
      ).all() as SqlRow[]).map((row) => this.evidenceFromRow(row));
    } finally {
      db.close();
    }
  }

  _readEvidence(id: string): StoredProviderEvidence {
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(`
        SELECT evidence_id, schema_version, created_at, evidence_json
        FROM provider_evidence WHERE evidence_id = ?
      `).get(id) as SqlRow | undefined;
      if (row === undefined) {
        throw new ProviderEvidenceStoreError('provider_evidence_not_found');
      }
      return this.evidenceFromRow(row);
    } finally {
      db.close();
    }
  }

  _readDiagnosticLink(id: string): string {
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(
        'SELECT evidence_id FROM diagnostic_evidence_links WHERE diagnostic_id = ?',
      ).get(id) as SqlRow | undefined;
      if (row === undefined) {
        throw new ProviderEvidenceStoreError('provider_evidence_not_found');
      }
      return String(row.evidence_id);
    } finally {
      db.close();
    }
  }

  _listArtifacts(): readonly StoredWorkerExecutionArtifact[] {
    const db = this.openSynchronousDatabase();
    try {
      return (db.prepare(
        `SELECT artifact_id, execution_id, settled_at, artifact_json
         FROM execution_artifacts ORDER BY settled_at, artifact_id`,
      ).all() as SqlRow[]).map((row) => this.artifactFromRow(row));
    } finally {
      db.close();
    }
  }

  _readArtifact(id: string): StoredWorkerExecutionArtifact {
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(
        `SELECT artifact_id, execution_id, settled_at, artifact_json
         FROM execution_artifacts WHERE artifact_id = ?`,
      ).get(id) as SqlRow | undefined;
      if (row === undefined) {
        throw new WorkerExecutionArtifactStoreError(
          'worker_execution_artifact_not_found',
        );
      }
      return this.artifactFromRow(row);
    } finally {
      db.close();
    }
  }

  _listDiagnostics(): readonly FailureDiagnosticV1[] {
    const db = this.openSynchronousDatabase();
    try {
      return (db.prepare(
        `SELECT diagnostic_id, occurred_at, payload_bytes, diagnostic_json
         FROM failure_diagnostics ORDER BY occurred_at, diagnostic_id`,
      ).all() as SqlRow[]).map((row) => this.diagnosticFromRow(row));
    } finally {
      db.close();
    }
  }

  _readDiagnostic(id: string): FailureDiagnosticV1 {
    const db = this.openSynchronousDatabase();
    try {
      const row = db.prepare(
        `SELECT diagnostic_id, occurred_at, payload_bytes, diagnostic_json
         FROM failure_diagnostics WHERE diagnostic_id = ?`,
      ).get(id) as SqlRow | undefined;
      if (row === undefined) {
        throw new FailureDiagnosticStoreError('diagnostic_not_found');
      }
      return this.diagnosticFromRow(row);
    } finally {
      db.close();
    }
  }

  _deleteDiagnostic(id: string): void {
    const db = this.openSynchronousDatabase();
    try {
      this.transaction(db, () => {
        const result = db!.prepare(
          'DELETE FROM failure_diagnostics WHERE diagnostic_id = ?',
        )
          .run(id);
        if (Number(result.changes) !== 1) {
          throw new FailureDiagnosticStoreError('diagnostic_not_found');
        }
      });
    } finally {
      db.close();
    }
  }
}

class SqliteProviderEvidenceAdapter implements ProviderEvidenceStore {
  constructor(private readonly store: SqliteHistoryStore) {}
  list(): Promise<readonly StoredProviderEvidence[]> {
    return Promise.resolve(this.store._listEvidence());
  }
  read(id: string): Promise<StoredProviderEvidence> {
    try {
      return Promise.resolve(this.store._readEvidence(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  write(_evidence: StoredProviderEvidence): Promise<void> {
    return Promise.reject(
      new ProviderEvidenceStoreError('provider_evidence_invalid'),
    );
  }
  linkDiagnostic(_diagnosticId: string, _evidenceId: string): Promise<void> {
    return Promise.reject(
      new ProviderEvidenceStoreError('provider_evidence_invalid'),
    );
  }
  readDiagnosticLink(id: string): Promise<string> {
    try {
      return Promise.resolve(this.store._readDiagnosticLink(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

class SqliteExecutionArtifactAdapter implements WorkerExecutionArtifactStore {
  constructor(private readonly store: SqliteHistoryStore) {}
  list(): Promise<readonly StoredWorkerExecutionArtifact[]> {
    return Promise.resolve(this.store._listArtifacts());
  }
  read(id: string): Promise<StoredWorkerExecutionArtifact> {
    try {
      return Promise.resolve(this.store._readArtifact(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  write(_artifact: StoredWorkerExecutionArtifact): Promise<void> {
    return Promise.reject(
      new WorkerExecutionArtifactStoreError(
        'worker_execution_artifact_invalid',
      ),
    );
  }
}

class SqliteDiagnosticAdapter implements FailureDiagnosticStore {
  constructor(private readonly store: SqliteHistoryStore) {}
  list(): Promise<readonly FailureDiagnosticV1[]> {
    return Promise.resolve(this.store._listDiagnostics());
  }
  read(id: string): Promise<FailureDiagnosticV1> {
    try {
      return Promise.resolve(this.store._readDiagnostic(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  write(_diagnostic: FailureDiagnosticV1): Promise<void> {
    return Promise.reject(
      new FailureDiagnosticStoreError('diagnostic_invalid'),
    );
  }
  delete(id: string): Promise<void> {
    try {
      this.store._deleteDiagnostic(id);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  persist = (diagnostic: FailureDiagnosticV1): Promise<void> => this.write(diagnostic);
}
