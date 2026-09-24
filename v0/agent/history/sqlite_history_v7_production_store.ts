import { DatabaseSync } from 'node:sqlite';
import type { JsonValue, LoopOutcome, Message } from '../core/contracts.ts';
import type { DefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';
import { isStoredModelSelection } from '../provider/model_selection.ts';
import {
  encodeSemanticContextCheckpoint,
  validateSemanticContextCheckpoint,
  validateSessionRecordV6,
  validRevisionRef,
} from '../session/session_record_codec.ts';
import {
  isSessionId,
  MAX_VALID_SESSIONS_PER_WORKSPACE,
  type SemanticContextCheckpointV1,
  type SessionRecord,
  SessionStoreError,
  type StoredSessionRecord,
  type WorkerSessionHandle,
  type WorkerSessionListResult,
  type WorkerSessionMetadata,
  type WorkerSessionStorePort,
} from '../session/session_store_contract.ts';
import { acquireLock, ensureDirectory, type Lock } from '../session/deno_session_store_io.ts';
import { workspaceDigest } from '../session/session_store_paths.ts';
import { validateFailureDiagnostic } from '../session/failure_diagnostic.ts';
import {
  type FailureDiagnosticStore,
  FailureDiagnosticStoreError,
} from '../session/failure_diagnostic_store.ts';
import {
  type StoredWorkerExecutionArtifact,
  validateWorkerExecutionArtifact,
} from '../worker/worker_execution_artifact.ts';
import {
  type WorkerExecutionArtifactStore,
  WorkerExecutionArtifactStoreError,
} from '../worker/worker_execution_artifact_store.ts';
import type { WorkerToHostMessage } from '../worker/worker_protocol.ts';
import type {
  BeginExecutionInput,
  CanonicalTurnCommitInput,
  ExecutionEventInput,
  HistoryCaptureResult,
  HistoryPersistencePort,
  NonCanonicalExecutionInput,
  ReconcileExecutionInput,
  StoredExecutionEffect,
  StoredExecutionEvent,
  StoredExecutionRow,
  StoredSessionHistoryExecution,
} from './history_store_contract.ts';
import type {
  ContextModelRequestDelta,
  ContextModelRequestRecord,
  ContextOccurrenceInput,
  ExecutionContextRelation,
  WorkerContextSnapshot,
} from './context_attribution.ts';
import { HistoryStoreError } from './history_store_contract.ts';
import {
  HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
  type HumanHistoryExportRecordV1,
} from './history_export_record.ts';
import type {
  HistoryV7SemanticKind,
  HistoryV7SemanticOccurrenceInput,
} from './history_v7_model.ts';
import { encodeHistoryV7Payload } from './history_v7_model.ts';
import { SqliteHistoryV7Store } from './sqlite_history_v7_store.ts';

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;
type PreparedContextItem = Readonly<{
  payload: JsonValue;
  content?: Uint8Array;
  contentDigest: string;
}>;
type PreparedEventPayload = Readonly<{
  payload: JsonValue;
  contextItems: readonly PreparedContextItem[];
}>;
type HistoryV7ProductionFaultPhase = 'before_settlement_commit';
const now = (): string => new Date().toISOString();

const asJson = (value: unknown): JsonValue => structuredClone(value) as JsonValue;
const parseJson = <T>(value: SqlValue): T => JSON.parse(String(value)) as T;
const compactOutcome = (outcome: LoopOutcome): LoopOutcome => ({ ...outcome, transcript: [] });

const asHistoryError = (error: unknown): HistoryStoreError =>
  error instanceof HistoryStoreError ? error : new HistoryStoreError('history_io_failure');
const asSessionError = (error: unknown): SessionStoreError =>
  error instanceof SessionStoreError ? error : new SessionStoreError('session_io_failure');

const eventSemanticKind = (input: ExecutionEventInput): HistoryV7SemanticKind | undefined => {
  switch (input.kind) {
    case 'execution_admitted':
      return 'execution_admission';
    case 'steer_requested':
      return 'user_message';
    case 'cancel_requested':
    case 'cancel_failed':
    case 'cancel_escalated':
    case 'worker_stage_snapshot':
    case 'steer_failed':
    case 'turn_dispatch_failed':
    case 'acknowledgement_failed':
      return 'control_decision';
    case 'effect_observation':
      return 'effect_observation';
    case 'provider_request_start':
    case 'provider_response_start':
    case 'provider_parser_transition':
    case 'provider_request_failure':
    case 'context_observation':
      return 'model_request';
    case 'runtime_event': {
      const payload = input.payload as unknown as Record<string, unknown>;
      if (payload.kind === 'provider_observation') {
        const observation = payload.observation as Record<string, unknown> | undefined;
        if (observation?.kind !== 'runtime_event') return undefined;
        const providerEvent = observation.event as Record<string, unknown> | undefined;
        switch (providerEvent?.kind) {
          case 'tool_call':
            return 'tool_call';
          case 'tool_result':
          case 'tool_progress':
            return 'tool_result';
          case 'assistant_progress':
            return 'assistant_message';
          case 'model_result':
            return 'model_result';
          default:
            return undefined;
        }
      }
      const value = typeof payload.event === 'object' && payload.event !== null
        ? payload.event as Record<string, unknown>
        : payload;
      const agentEvent = value.kind === 'agent_event' &&
          typeof value.event === 'object' && value.event !== null
        ? value.event as Record<string, unknown>
        : value;
      if (agentEvent.kind === 'user_message' || agentEvent.kind === 'steering_message') {
        return 'user_message';
      }
      if (agentEvent.kind === 'tool_call') return 'tool_call';
      if (agentEvent.kind === 'tool_result' || agentEvent.kind === 'tool_progress') {
        return 'tool_result';
      }
      if (
        agentEvent.kind === 'assistant_message' ||
        agentEvent.kind === 'assistant_progress' ||
        agentEvent.kind === 'assistant_thinking'
      ) return 'assistant_message';
      return 'model_result';
    }
    case 'execution_settled':
    case 'execution_reconciled':
      return 'host_decision';
    default:
      return undefined;
  }
};

const eventValue = (event: StoredExecutionEvent): JsonValue => asJson({ event });

/**
 * Production v7 facade. Semantic rows are the authority; transport/protocol observations are
 * optional attachments and document-shaped APIs are derived read projections.
 */
export class SqliteHistoryV7ProductionStore
  implements WorkerSessionStorePort, HistoryPersistencePort {
  readonly executionArtifacts: WorkerExecutionArtifactStore = {
    list: async () => {
      await this.initialize();
      return this.#listDerivedDocuments('artifact', validateWorkerExecutionArtifact);
    },
    read: async (id) => {
      await this.initialize();
      const artifact = this.#readDerivedDocument<StoredWorkerExecutionArtifact>('artifact', id);
      if (artifact === undefined) {
        throw new WorkerExecutionArtifactStoreError(
          'worker_execution_artifact_not_found',
        );
      }
      if (!validateWorkerExecutionArtifact(artifact)) {
        throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
      }
      return artifact;
    },
    write: async (artifact) => {
      await this.initialize();
      if (!validateWorkerExecutionArtifact(artifact)) {
        throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
      }
      try {
        this.#writeDerivedDocument(
          'artifact',
          artifact.executionId,
          artifact.executionId,
          artifact,
        );
      } catch {
        throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_io_failure');
      }
    },
  };
  readonly diagnostics: FailureDiagnosticStore = {
    list: async () => {
      await this.initialize();
      return this.#listDerivedDocuments('failure_diagnostic', validateFailureDiagnostic);
    },
    read: async (id) => {
      await this.initialize();
      const diagnostic = this.#readDerivedDocument<unknown>('failure_diagnostic', id);
      if (diagnostic === undefined) {
        throw new FailureDiagnosticStoreError('diagnostic_not_found');
      }
      if (!validateFailureDiagnostic(diagnostic)) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      return diagnostic;
    },
    write: async (diagnostic) => {
      await this.initialize();
      if (!validateFailureDiagnostic(diagnostic)) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      this.#writeDerivedDocument(
        'failure_diagnostic',
        diagnostic.diagnosticId,
        null,
        diagnostic,
      );
    },
    delete: async (id) => {
      await this.initialize();
      const db = this.#db();
      try {
        const result = db.prepare(`
          DELETE FROM derived_documents
          WHERE document_kind='failure_diagnostic' AND document_id=?
        `).run(id);
        if (result.changes === 0) {
          throw new FailureDiagnosticStoreError('diagnostic_not_found');
        }
      } finally {
        db.close();
      }
    },
    persist: async (diagnostic) => {
      await this.diagnostics.write(diagnostic);
    },
  };
  readonly #makeUuid: () => string;
  readonly #fault?: (phase: HistoryV7ProductionFaultPhase) => void;
  readonly #readOnly: boolean;
  readonly #executionLocks = new Map<string, Lock>();
  readonly #eventCounts = new Map<string, number>();
  readonly #baseMessageCountsBySession = new Map<string, number>();
  #databasePath?: string;
  #locksPath?: string;
  #core?: SqliteHistoryV7Store;

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
    options: Readonly<{
      uuid?: () => string;
      fault?: (phase: HistoryV7ProductionFaultPhase) => void;
      /** Open for read-only viewing: no directory/schema creation and no reconciliation. */
      readOnly?: boolean;
    }> = {},
  ) {
    if (!stateRoot.startsWith('/') || stateRoot.includes('\0')) {
      throw new SessionStoreError('session_io_failure');
    }
    this.#makeUuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
    this.#fault = options.fault;
    this.#readOnly = options.readOnly === true;
  }

  async initialize(): Promise<void> {
    if (this.#core !== undefined) return;
    const digest = await workspaceDigest(this.workspaceRoot);
    const root = `${this.stateRoot}/${digest}`;
    if (this.#readOnly) {
      this.#databasePath = `${root}/history-v7.sqlite3`;
      this.#locksPath = `${root}/locks-v7`;
      this.#core = new SqliteHistoryV7Store(this.#databasePath, { readOnly: true });
      return;
    }
    await ensureDirectory(root, 0o700);
    await ensureDirectory(`${root}/locks-v7`, 0o700);
    this.#databasePath = `${root}/history-v7.sqlite3`;
    this.#locksPath = `${root}/locks-v7`;
    this.#core = new SqliteHistoryV7Store(this.#databasePath);
    const db = this.#db();
    let active: Row[];
    try {
      active = db.prepare(`
        SELECT e.execution_id, a.canonical_session_id, a.session_correlation
        FROM executions e JOIN execution_admissions a USING(execution_id)
        WHERE e.lifecycle='active' ORDER BY a.created_at, e.execution_id
      `).all() as Row[];
    } finally {
      db.close();
    }
    for (const row of active) {
      const executionId = String(row.execution_id);
      const lockPath = row.canonical_session_id === null
        ? `${this.#locksPath}/.execution-${executionId}.lock`
        : `${this.#locksPath}/${String(row.session_correlation)}.lock`;
      try {
        const lock = await acquireLock(lockPath);
        this.#executionLocks.set(executionId, lock);
        this.reconcileExecution({ executionId, settlement: 'interrupted' });
      } catch (error) {
        if (error instanceof SessionStoreError && error.code === 'session_busy') continue;
        throw error;
      }
    }
  }

  capturesProtocolTrace(): boolean {
    return false;
  }

  close(): void {
    for (const lock of this.#executionLocks.values()) lock.close();
    this.#executionLocks.clear();
    this.#core?.close();
    this.#core = undefined;
  }

  #coreStore(): SqliteHistoryV7Store {
    if (this.#core === undefined) throw new HistoryStoreError('history_io_failure');
    return this.#core;
  }

  #db(): DatabaseSync {
    if (this.#databasePath === undefined) throw new HistoryStoreError('history_io_failure');
    if (this.#readOnly) {
      const db = new DatabaseSync(this.#databasePath, { readOnly: true });
      db.exec('PRAGMA foreign_keys=ON;');
      return db;
    }
    const db = new DatabaseSync(this.#databasePath);
    db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;',
    );
    return db;
  }

  #listDerivedDocuments<T>(
    kind: string,
    validate: (value: unknown) => value is T,
  ): readonly T[] {
    const db = this.#db();
    try {
      return (db.prepare(`
        SELECT value_json FROM derived_documents
        WHERE document_kind=? ORDER BY rowid
      `).all(kind) as Row[]).map((row) => {
        const value = parseJson<unknown>(row.value_json);
        if (!validate(value)) throw new HistoryStoreError('history_invalid');
        return value;
      });
    } finally {
      db.close();
    }
  }

  #readDerivedDocument<T>(kind: string, id: string): T | undefined {
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT value_json FROM derived_documents
        WHERE document_kind=? AND document_id=?
      `).get(kind, id) as Row | undefined;
      return row === undefined ? undefined : parseJson<T>(row.value_json);
    } finally {
      db.close();
    }
  }

  #releaseExecutionLock(executionId: string): void {
    const lock = this.#executionLocks.get(executionId);
    if (lock === undefined) return;
    this.#executionLocks.delete(executionId);
    lock.close();
  }

  #sessionCounts(db: DatabaseSync, sessionId: string): {
    messages: number;
    modelChanges: number;
    turns: number;
  } {
    const row = db.prepare(`
      SELECT message_count, model_change_count, turn_count
      FROM sessions WHERE session_id=?
    `).get(sessionId) as Row | undefined;
    return row === undefined ? { messages: 0, modelChanges: 0, turns: 0 } : {
      messages: Number(row.message_count),
      modelChanges: Number(row.model_change_count),
      turns: Number(row.turn_count),
    };
  }

  #writeSessionTx(
    db: DatabaseSync,
    record: StoredSessionRecord,
    executionId?: string,
  ): void {
    if (
      !validateSessionRecordV6(record) ||
      record.workspaceRoot !== this.workspaceRoot
    ) throw new SessionStoreError('session_invalid');
    const counts = this.#sessionCounts(db, record.sessionId);
    if (
      counts.messages > record.transcript.length ||
      counts.modelChanges > record.modelChanges.length ||
      counts.turns > record.turnModels.length ||
      counts.turns > record.turnExecutions.length
    ) throw new SessionStoreError('session_invalid');
    db.prepare(`
      INSERT INTO sessions(
        session_id, workspace_root, agent, created_at, updated_at, title,
        state_revision, next_turn, definition_json, active_model_json,
        message_count, model_change_count, turn_count, checkpoint_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL)
      ON CONFLICT(session_id) DO NOTHING
    `).run(
      record.sessionId,
      record.workspaceRoot,
      record.agent,
      record.createdAt,
      record.updatedAt,
      record.title,
      record.stateRevision,
      record.nextTurn,
      JSON.stringify(record.definition),
      JSON.stringify(record.activeModel),
    );
    const messageTurn = Math.max(1, record.nextTurn - 1);
    for (let ordinal = counts.messages; ordinal < record.transcript.length; ordinal += 1) {
      db.prepare(`
        INSERT INTO session_messages(session_id, message_ordinal, turn_number, message_json)
        VALUES(?, ?, ?, ?)
      `).run(record.sessionId, ordinal, messageTurn, JSON.stringify(record.transcript[ordinal]));
    }
    for (let ordinal = counts.modelChanges; ordinal < record.modelChanges.length; ordinal += 1) {
      const change = record.modelChanges[ordinal];
      db.prepare(`
        INSERT INTO session_model_changes(
          session_id, change_ordinal, effective_from_turn, changed_at, selection_json
        ) VALUES(?, ?, ?, ?, ?)
      `).run(
        record.sessionId,
        ordinal,
        change.effectiveFromTurn,
        change.changedAt,
        JSON.stringify(change.selection),
      );
    }
    for (let ordinal = counts.turns; ordinal < record.turnModels.length; ordinal += 1) {
      const model = record.turnModels[ordinal];
      const execution = record.turnExecutions[ordinal];
      if (execution === undefined || execution.turn !== model.turn) {
        throw new SessionStoreError('session_invalid');
      }
      db.prepare(`
        INSERT INTO session_turns(
          session_id, turn_ordinal, turn_number, model_json, build_json,
          definition_json, execution_id
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.sessionId,
        ordinal,
        model.turn,
        JSON.stringify(model.selection),
        JSON.stringify(execution.build),
        JSON.stringify(execution.definition),
        executionId !== undefined && model.turn === record.nextTurn - 1 ? executionId : null,
      );
    }
    db.prepare(`
      UPDATE sessions SET agent=?, updated_at=?, title=?, state_revision=?, next_turn=?,
        definition_json=?, active_model_json=?, message_count=?, model_change_count=?,
        turn_count=? WHERE session_id=?
    `).run(
      record.agent,
      record.updatedAt,
      record.title,
      record.stateRevision,
      record.nextTurn,
      JSON.stringify(record.definition),
      JSON.stringify(record.activeModel),
      record.transcript.length,
      record.modelChanges.length,
      record.turnModels.length,
      record.sessionId,
    );
    db.prepare(`
      INSERT INTO session_heads(session_id, revision)
      VALUES(?, ?)
      ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision
    `).run(record.sessionId, record.stateRevision);
  }

  #writeSession(record: StoredSessionRecord, executionId?: string): void {
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#writeSessionTx(db, record, executionId);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the primary error.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  #readSession(db: DatabaseSync, id: string): StoredSessionRecord {
    const row = db.prepare('SELECT * FROM sessions WHERE session_id=?').get(id) as
      | Row
      | undefined;
    if (row === undefined) throw new SessionStoreError('session_not_found');
    const transcript = (db.prepare(`
      SELECT message_json FROM session_messages WHERE session_id=? ORDER BY message_ordinal
    `).all(id) as Row[]).map((item) => parseJson<Message>(item.message_json));
    const modelChanges = (db.prepare(`
      SELECT effective_from_turn, changed_at, selection_json FROM session_model_changes
      WHERE session_id=? ORDER BY change_ordinal
    `).all(id) as Row[]).map((item) => ({
      effectiveFromTurn: Number(item.effective_from_turn),
      changedAt: String(item.changed_at),
      selection: parseJson<StoredSessionRecord['activeModel']>(item.selection_json),
    }));
    const turns = db.prepare(`
      SELECT turn_number, model_json, build_json, definition_json FROM session_turns
      WHERE session_id=? ORDER BY turn_ordinal
    `).all(id) as Row[];
    const record: StoredSessionRecord = {
      schemaVersion: 6,
      sessionId: id,
      workspaceRoot: String(row.workspace_root),
      agent: String(row.agent) as SessionRecord['agent'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      title: row.title === null ? null : String(row.title),
      stateRevision: Number(row.state_revision),
      nextTurn: Number(row.next_turn),
      transcript,
      definition: parseJson<StoredSessionRecord['definition']>(row.definition_json),
      activeModel: parseJson<StoredSessionRecord['activeModel']>(row.active_model_json),
      modelChanges,
      turnModels: turns.map((item) => ({
        turn: Number(item.turn_number),
        selection: parseJson<StoredSessionRecord['activeModel']>(item.model_json),
      })),
      turnExecutions: turns.map((item) => ({
        turn: Number(item.turn_number),
        build: parseJson<StoredSessionRecord['turnExecutions'][number]['build']>(item.build_json),
        definition: parseJson<DefinitionRevisionRef>(item.definition_json),
      })),
    };
    if (!validateSessionRecordV6(record)) throw new SessionStoreError('session_invalid');
    return record;
  }

  async readWorker(id: string): Promise<StoredSessionRecord> {
    await this.initialize();
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const db = this.#db();
    try {
      return this.#readSession(db, id);
    } catch (error) {
      throw asSessionError(error);
    } finally {
      db.close();
    }
  }

  async readCheckpoint(id: string): Promise<SemanticContextCheckpointV1 | undefined> {
    await this.initialize();
    const db = this.#db();
    try {
      const row = db.prepare('SELECT checkpoint_json FROM sessions WHERE session_id=?').get(id) as
        | Row
        | undefined;
      if (row?.checkpoint_json === null || row?.checkpoint_json === undefined) return undefined;
      const checkpoint = parseJson<SemanticContextCheckpointV1>(row.checkpoint_json);
      if (!validateSemanticContextCheckpoint(checkpoint)) {
        throw new SessionStoreError('session_invalid');
      }
      return checkpoint;
    } finally {
      db.close();
    }
  }

  async listWorker(): Promise<WorkerSessionListResult> {
    await this.initialize();
    const db = this.#db();
    try {
      const rows = db.prepare(`
        SELECT session_id, agent, created_at, updated_at, title, next_turn,
          definition_json, active_model_json, message_count
        FROM sessions ORDER BY updated_at DESC, session_id
      `).all() as Row[];
      const sessions: WorkerSessionMetadata[] = [];
      let skippedInvalid = 0;
      for (const row of rows) {
        try {
          const definition = parseJson<DefinitionRevisionRef>(row.definition_json);
          const modelSelection = parseJson<StoredSessionRecord['activeModel']>(
            row.active_model_json,
          );
          if (
            !isSessionId(String(row.session_id)) ||
            !validRevisionRef(definition) ||
            !isStoredModelSelection(modelSelection)
          ) throw new Error('invalid session metadata');
          sessions.push({
            id: String(row.session_id),
            agent: String(row.agent) as SessionRecord['agent'],
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
            ...(row.title === null ? {} : { title: String(row.title) }),
            turnCount: Number(row.next_turn) - 1,
            messageCount: Number(row.message_count),
            definition,
            modelSelection,
          });
        } catch {
          skippedInvalid += 1;
        }
      }
      return { sessions, skippedInvalid };
    } finally {
      db.close();
    }
  }

  async allocateWorker(
    agent: SessionRecord['agent'],
    definition: DefinitionRevisionRef,
  ): Promise<WorkerSessionHandle> {
    await this.initialize();
    if (
      (agent !== 'default' && agent !== 'planner') ||
      !validRevisionRef(definition)
    ) throw new SessionStoreError('session_invalid');
    if ((await this.listWorker()).sessions.length >= MAX_VALID_SESSIONS_PER_WORKSPACE) {
      throw new SessionStoreError('session_limit');
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.#makeUuid();
      if (!isSessionId(id)) continue;
      try {
        const lock = await acquireLock(`${this.#locksPath}/${id}.lock`);
        return this.#handle(id, agent, undefined, undefined, lock);
      } catch (error) {
        if (!(error instanceof SessionStoreError) || error.code !== 'session_busy') throw error;
      }
    }
    throw new SessionStoreError('session_limit');
  }

  async openExistingWorker(id: string): Promise<WorkerSessionHandle> {
    await this.initialize();
    const lock = await acquireLock(`${this.#locksPath}/${id}.lock`);
    try {
      const record = await this.readWorker(id);
      const checkpoint = await this.readCheckpoint(id);
      return this.#handle(id, record.agent, record, checkpoint, lock);
    } catch (error) {
      lock.close();
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await this.initialize();
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const lock = await acquireLock(`${this.#locksPath}/${id}.lock`);
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const found = db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(id);
      if (found === undefined) throw new SessionStoreError('session_not_found');
      const executionIds = (db.prepare(`
        SELECT execution_id FROM execution_admissions WHERE session_correlation=?
      `).all(id) as Row[]).map((row) => String(row.execution_id));
      for (const executionId of executionIds) {
        db.prepare(`
          DELETE FROM recall_relations
          WHERE source_execution_id=? OR target_execution_id=?
        `).run(executionId, executionId);
      }
      db.prepare('DELETE FROM sessions WHERE session_id=?').run(id);
      for (const executionId of executionIds) {
        db.prepare('DELETE FROM executions WHERE execution_id=?').run(executionId);
      }
      db.prepare('DELETE FROM session_heads WHERE session_id=?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the primary error.
      }
      throw asSessionError(error);
    } finally {
      db.close();
      lock.close();
    }
  }

  #handle(
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
        if (next.sessionId !== id || next.agent !== agent) {
          throw new SessionStoreError('session_invalid');
        }
        rollbackRecord = record;
        this.#writeSession(next);
        record = structuredClone(next);
      },
      acceptCommitted: (next) => {
        if (closed || next.sessionId !== id || !validateSessionRecordV6(next)) {
          throw new SessionStoreError(closed ? 'session_busy' : 'session_invalid');
        }
        rollbackRecord = record;
        record = structuredClone(next);
      },
      rollback: () => {
        if (closed || record === rollbackRecord) return;
        if (rollbackRecord === undefined) {
          const db = this.#db();
          try {
            db.prepare('DELETE FROM sessions WHERE session_id=?').run(id);
          } finally {
            db.close();
          }
        } else {
          this.#restoreSessionMetadata(rollbackRecord);
        }
        record = rollbackRecord;
      },
      installCheckpoint: (next) => {
        if (
          closed || next.sessionId !== id ||
          !validateSemanticContextCheckpoint(next)
        ) throw new SessionStoreError(closed ? 'session_busy' : 'session_invalid');
        const db = this.#db();
        try {
          db.prepare('UPDATE sessions SET checkpoint_json=? WHERE session_id=?').run(
            new TextDecoder().decode(encodeSemanticContextCheckpoint(next)),
            id,
          );
        } finally {
          db.close();
        }
        rollbackCheckpoint = checkpoint;
        checkpoint = structuredClone(next);
      },
      rollbackCheckpoint: () => {
        if (closed || checkpoint === rollbackCheckpoint) return;
        const db = this.#db();
        try {
          db.prepare('UPDATE sessions SET checkpoint_json=? WHERE session_id=?').run(
            rollbackCheckpoint === undefined ? null : JSON.stringify(rollbackCheckpoint),
            id,
          );
        } finally {
          db.close();
        }
        checkpoint = rollbackCheckpoint;
      },
      close: () => {
        if (!closed) lock.close();
        closed = true;
        return Promise.resolve();
      },
    };
  }

  #restoreSessionMetadata(record: StoredSessionRecord): void {
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      const counts = this.#sessionCounts(db, record.sessionId);
      if (
        counts.messages !== record.transcript.length ||
        counts.turns !== record.turnModels.length ||
        counts.modelChanges < record.modelChanges.length
      ) throw new SessionStoreError('session_invalid');
      db.prepare(`
        DELETE FROM session_model_changes
        WHERE session_id=? AND change_ordinal>=?
      `).run(record.sessionId, record.modelChanges.length);
      db.prepare(`
        UPDATE sessions SET model_change_count=?
        WHERE session_id=?
      `).run(record.modelChanges.length, record.sessionId);
      this.#writeSessionTx(db, record);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the primary error.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  async beginExecution(input: BeginExecutionInput): Promise<void> {
    await this.initialize();
    try {
      if (input.canonicalSessionId === undefined) {
        const lock = await acquireLock(
          `${this.#locksPath}/.execution-${input.executionId}.lock`,
        );
        this.#executionLocks.set(input.executionId, lock);
      }
      if (input.sessionRecord !== undefined) this.#writeSession(input.sessionRecord);
      const authoritySession = input.canonicalSessionId ??
        `detached:${input.sessionCorrelation}`;
      let baseMessageCount = input.sessionRecord?.transcript.length ?? 0;
      if (input.sessionRecord === undefined && input.canonicalSessionId !== undefined) {
        const db = this.#db();
        try {
          baseMessageCount = this.#sessionCounts(db, input.canonicalSessionId).messages;
        } finally {
          db.close();
        }
      }
      const admission = {
        executionId: input.executionId,
        taskId: input.taskId,
        task: input.task,
        ...(input.canonicalSessionId === undefined
          ? {}
          : { canonicalSessionId: input.canonicalSessionId }),
        sessionCorrelation: input.sessionCorrelation,
        ...(input.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: input.parentExecutionId }),
        ...(input.spawnCallId === undefined ? {} : { spawnCallId: input.spawnCallId }),
        turn: input.turn,
        createdAt: input.createdAt,
        agent: input.agent,
        model: asJson(input.model),
        build: asJson(input.build),
        definition: asJson(input.definition),
        ...(input.manifest === undefined ? {} : { manifest: asJson(input.manifest) }),
        ...(input.instanceCorrelation === undefined
          ? {}
          : { instanceCorrelation: input.instanceCorrelation }),
        ...(input.workerGeneration === undefined
          ? {}
          : { workerGeneration: input.workerGeneration }),
        ...(input.contextSnapshot === undefined
          ? {}
          : { contextSnapshot: asJson(input.contextSnapshot) }),
        ...(input.recalledContext === undefined
          ? {}
          : { recalledContext: asJson(input.recalledContext) }),
        baseMessageCount,
      };
      this.#coreStore().beginExecutionWithAdmission({
        executionId: input.executionId,
        sessionId: authoritySession,
        baseRevision: input.baseStateRevision,
        admission,
      });
      const admissionEvent: StoredExecutionEvent = {
        executionId: input.executionId,
        ordinal: 1,
        observedAt: input.createdAt,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'execution_admitted',
        payload: asJson({
          taskId: input.taskId,
          executionId: input.executionId,
          sessionCorrelation: input.sessionCorrelation,
          turn: input.turn,
          task: input.task,
        }),
      };
      const occurrences: HistoryV7SemanticOccurrenceInput[] = [{
        occurrenceId: `${input.executionId}:semantic:1`,
        ordinal: 1,
        kind: 'execution_admission',
        observedAt: input.createdAt,
        payload: eventValue(admissionEvent),
      }];
      if (input.recalledContext !== undefined) {
        occurrences.push({
          occurrenceId: `${input.executionId}:semantic:2`,
          ordinal: 2,
          kind: 'recall_projection',
          observedAt: input.createdAt,
          payload: asJson({
            sourceExecutionId: input.recalledContext.sourceExecutionId,
            targetExecutionId: input.executionId,
            context: input.recalledContext,
          }),
        });
      }
      this.#coreStore().appendSemantic(input.executionId, 0, occurrences);
      const db = this.#db();
      try {
        db.prepare('UPDATE execution_admissions SET event_count=1 WHERE execution_id=?').run(
          input.executionId,
        );
        if (input.recalledContext !== undefined) {
          db.prepare(`
            INSERT INTO recall_relations(
              source_execution_id, target_execution_id, occurrence_id
            ) VALUES(?, ?, ?)
          `).run(
            input.recalledContext.sourceExecutionId,
            input.executionId,
            `${input.executionId}:semantic:2`,
          );
        }
      } finally {
        db.close();
      }
      this.#eventCounts.set(input.executionId, 1);
      this.#baseMessageCountsBySession.set(input.sessionCorrelation, baseMessageCount);
    } catch (error) {
      this.#baseMessageCountsBySession.delete(input.sessionCorrelation);
      this.#releaseExecutionLock(input.executionId);
      throw asHistoryError(error);
    }
  }

  prepareWorkerObservationForHistory(message: WorkerToHostMessage): WorkerToHostMessage {
    if (message.kind !== 'commit_proposal' && message.kind !== 'turn_failed') return message;
    const baseMessageCount = this.#baseMessageCountsBySession.get(message.correlation.session) ?? 0;
    if (message.kind === 'commit_proposal') {
      return {
        ...message,
        transcript: message.transcript.slice(baseMessageCount),
        ...(message.outcome === undefined ? {} : {
          outcome: {
            ...message.outcome,
            transcript: [],
          },
        }),
        historyTranscriptBaseApplied: true,
      } as WorkerToHostMessage;
    }
    return {
      ...message,
      outcome: {
        ...message.outcome,
        transcript: message.outcome.transcript.slice(baseMessageCount),
      },
      historyTranscriptBaseApplied: true,
    } as WorkerToHostMessage;
  }

  validateExecutionEvent(input: ExecutionEventInput): boolean {
    return input.executionId.length > 0 && input.kind.length > 0 &&
      typeof input.payload === 'object' && input.payload !== null;
  }

  #baseMessageCount(executionId: string): number {
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT base_message_count FROM execution_admissions WHERE execution_id=?
      `).get(executionId) as Row | undefined;
      if (row === undefined) throw new HistoryStoreError('history_invalid');
      return Number(row.base_message_count);
    } finally {
      db.close();
    }
  }

  #boundedEventPayload(input: ExecutionEventInput): JsonValue {
    if (input.kind !== 'runtime_event') return asJson(input.payload);
    const payload = input.payload as unknown as Record<string, unknown>;
    const alreadyBounded = payload.historyTranscriptBaseApplied === true;
    const baseMessageCount = this.#baseMessageCount(input.executionId);
    if (payload.kind === 'commit_proposal' && Array.isArray(payload.transcript)) {
      const outcome = payload.outcome as LoopOutcome | undefined;
      const {
        historyTranscriptBaseApplied: _bounded,
        ...stored
      } = payload;
      return asJson({
        ...stored,
        transcript: alreadyBounded
          ? payload.transcript
          : payload.transcript.slice(baseMessageCount),
        ...(outcome === undefined ? {} : {
          outcome: {
            ...outcome,
            transcript: [],
          },
        }),
      });
    }
    if (payload.kind === 'turn_failed') {
      const outcome = payload.outcome as LoopOutcome;
      const {
        historyTranscriptBaseApplied: _bounded,
        ...stored
      } = payload;
      return asJson({
        ...stored,
        outcome: {
          ...outcome,
          transcript: alreadyBounded
            ? outcome.transcript
            : outcome.transcript.slice(baseMessageCount),
        },
      });
    }
    return asJson(payload);
  }

  #prepareEventPayload(
    input: ExecutionEventInput,
    stagedContent: Set<string>,
  ): PreparedEventPayload {
    if (input.kind !== 'context_observation') {
      return { payload: this.#boundedEventPayload(input), contextItems: [] };
    }
    const payload = input.payload as unknown as Record<string, unknown>;
    const observation = payload.observation as
      | { kind?: string; delta?: ContextModelRequestDelta }
      | undefined;
    const delta = observation?.delta;
    if (observation?.kind !== 'model_request_delta' || delta === undefined) {
      return { payload: asJson(input.payload), contextItems: [] };
    }
    const contextItems = delta.occurrences.map((occurrence): PreparedContextItem => {
      const descriptor = occurrence.content;
      const stagedKey = `${input.executionId}:${descriptor.digest}`;
      const stored = stagedContent.has(stagedKey) ||
        this.#coreStore().hasContent(descriptor.digest, descriptor.byteLength);
      let content: Uint8Array | undefined;
      if (!stored) {
        if (occurrence.bytesBase64 === undefined) {
          throw new HistoryStoreError('history_invalid');
        }
        try {
          content = Uint8Array.fromBase64(occurrence.bytesBase64);
        } catch {
          throw new HistoryStoreError('history_invalid');
        }
        if (content.byteLength !== descriptor.byteLength) {
          throw new HistoryStoreError('history_invalid');
        }
        stagedContent.add(stagedKey);
      }
      const { bytesBase64: _bytes, ...metadata } = occurrence;
      return {
        payload: asJson(metadata),
        ...(content === undefined ? {} : { content }),
        contentDigest: descriptor.digest,
      };
    });
    const storedDelta = {
      ...delta,
      occurrences: delta.occurrences.map((occurrence) => ({
        occurrenceId: occurrence.occurrenceId,
      })),
    };
    return {
      payload: asJson({
        ...payload,
        observation: { ...observation, delta: storedDelta },
      }),
      contextItems,
    };
  }

  appendExecutionEvent(input: ExecutionEventInput): StoredExecutionEvent {
    const result = this.appendExecutionEvents([input])[0];
    if (result === undefined) throw new HistoryStoreError('history_invalid');
    return result;
  }

  appendExecutionEvents(inputs: readonly ExecutionEventInput[]): readonly StoredExecutionEvent[] {
    if (inputs.length === 0) return [];
    try {
      const byExecution = new Map<
        string,
        {
          input: ExecutionEventInput;
          event: StoredExecutionEvent;
          contextItems: readonly PreparedContextItem[];
        }[]
      >();
      const stagedContent = new Set<string>();
      for (const input of inputs) {
        if (!this.validateExecutionEvent(input)) throw new HistoryStoreError('history_invalid');
        if (input.kind === 'execution_settled' || input.kind === 'execution_reconciled') {
          throw new HistoryStoreError('history_invalid');
        }
        const current = byExecution.get(input.executionId)?.at(-1)?.event.ordinal ??
          this.#eventCount(input.executionId);
        const prepared = this.#prepareEventPayload(input, stagedContent);
        const event: StoredExecutionEvent = {
          executionId: input.executionId,
          ordinal: current + 1,
          observedAt: input.observedAt ?? now(),
          direction: input.direction,
          source: input.source,
          kind: input.kind,
          ...(input.workerSequence === undefined ? {} : { workerSequence: input.workerSequence }),
          payload: prepared.payload,
        };
        const group = byExecution.get(input.executionId) ?? [];
        group.push({ input, event, contextItems: prepared.contextItems });
        byExecution.set(input.executionId, group);
      }
      for (const [executionId, records] of byExecution) {
        const events = records.map((record) => record.event);
        const state = this.#coreStore().readExecution(executionId);
        const semantic = records.flatMap(({ input, event, contextItems }) => {
          const kind = eventSemanticKind(input);
          return [
            ...contextItems.map((item) => ({
              input,
              event,
              kind: 'context_item' as const,
              payload: item.payload,
              content: item.content,
              contentDigest: item.contentDigest,
              isEvent: false,
              contextItemCount: 0,
            })),
            ...(kind === undefined ? [] : [{
              input,
              event,
              kind,
              payload: eventValue(event),
              content: undefined,
              contentDigest: undefined,
              isEvent: true,
              contextItemCount: contextItems.length,
            }]),
          ];
        });
        const semanticOccurrenceId = (index: number): string =>
          `${executionId}:semantic:${state.latestOrdinal + index + 1}`;
        const occurrences = semantic.map((item, index) => {
          const firstContextItem = index - item.contextItemCount;
          return {
            occurrenceId: semanticOccurrenceId(index),
            ordinal: state.latestOrdinal + index + 1,
            kind: item.kind,
            observedAt: item.event.observedAt,
            payload: item.payload,
            ...(item.content === undefined ? {} : { content: item.content }),
            ...(item.contentDigest === undefined ? {} : { contentDigest: item.contentDigest }),
            ...(item.contextItemCount === 0 ? {} : {
              relations: Array.from({ length: item.contextItemCount }, (_, offset) => ({
                relation: 'context_item',
                targetOccurrenceId: semanticOccurrenceId(firstContextItem + offset),
              })),
            }),
          };
        });
        const terminalIndex = semantic.findLastIndex(({ event, isEvent }) =>
          isEvent && (event.kind === 'execution_settled' || event.kind === 'execution_reconciled')
        );
        if (occurrences.length > 0) {
          this.#coreStore().appendSemantic(
            executionId,
            state.latestOrdinal,
            occurrences,
            terminalIndex < 0 ? undefined : occurrences[terminalIndex].occurrenceId,
          );
        }
        const count = events.at(-1)!.ordinal;
        const db = this.#db();
        try {
          db.prepare('UPDATE execution_admissions SET event_count=? WHERE execution_id=?').run(
            count,
            executionId,
          );
        } finally {
          db.close();
        }
        this.#eventCounts.set(executionId, count);
      }
      return [...byExecution.values()].flat().map((record) => record.event);
    } catch (error) {
      throw asHistoryError(error);
    }
  }

  #eventCount(executionId: string): number {
    const cached = this.#eventCounts.get(executionId);
    if (cached !== undefined) return cached;
    const db = this.#db();
    try {
      const row = db.prepare(
        'SELECT event_count FROM execution_admissions WHERE execution_id=?',
      ).get(executionId) as Row | undefined;
      if (row === undefined) throw new HistoryStoreError('history_invalid');
      return Number(row.event_count);
    } finally {
      db.close();
    }
  }

  #capture(
    input: CanonicalTurnCommitInput | NonCanonicalExecutionInput,
  ): HistoryCaptureResult {
    const result: HistoryCaptureResult = {};
    const db = this.#db();
    try {
      if (input.contextManifest !== undefined) {
        db.prepare(`
          INSERT INTO execution_context_manifests(execution_id, manifest_json)
          VALUES(?, ?) ON CONFLICT(execution_id) DO UPDATE SET manifest_json=excluded.manifest_json
        `).run(input.executionId, JSON.stringify(input.contextManifest));
        Object.assign(result, { contextDurability: 'complete' as const });
      }
    } finally {
      db.close();
    }
    if (input.diagnostic !== undefined && validateFailureDiagnostic(input.diagnostic)) {
      try {
        this.#writeDerivedDocument(
          'failure_diagnostic',
          input.diagnostic.diagnosticId,
          null,
          input.diagnostic,
        );
        Object.assign(result, { diagnosticDurability: 'yes' as const });
      } catch {
        Object.assign(result, { diagnosticDurability: 'failed' as const });
      }
    }
    if (input.artifactForCapture !== undefined) {
      try {
        const artifact = input.artifactForCapture(result);
        if (validateWorkerExecutionArtifact(artifact)) {
          this.#writeDerivedDocument(
            'artifact',
            artifact.executionId,
            input.executionId,
            artifact,
          );
        }
      } catch {
        // Artifact is a derived projection and cannot gate semantic settlement.
      }
    }
    return result;
  }

  #writeDerivedDocument(
    kind: string,
    id: string,
    executionId: string | null,
    value: unknown,
  ): void {
    const db = this.#db();
    try {
      db.prepare(`
        INSERT INTO derived_documents(document_kind, document_id, execution_id, value_json)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(document_kind, document_id) DO UPDATE SET
          execution_id=excluded.execution_id, value_json=excluded.value_json
      `).run(kind, id, executionId, JSON.stringify(value));
    } finally {
      db.close();
    }
  }

  #ensureRecallProjection(
    input: CanonicalTurnCommitInput | NonCanonicalExecutionInput,
  ): void {
    if (input.recalledContext === undefined) return;
    const occurrenceId = `${input.executionId}:recall:${input.recalledContext.sourceExecutionId}`;
    let occurrenceExists = false;
    const db = this.#db();
    try {
      const existing = db.prepare(`
        SELECT occurrence_id FROM recall_relations
        WHERE source_execution_id=? AND target_execution_id=?
      `).get(input.recalledContext.sourceExecutionId, input.executionId) as
        | Row
        | undefined;
      if (existing !== undefined) return;
      occurrenceExists = db.prepare(`
        SELECT 1 FROM semantic_occurrences WHERE occurrence_id=?
      `).get(occurrenceId) !== undefined;
    } finally {
      db.close();
    }
    if (!occurrenceExists) {
      const state = this.#coreStore().readExecution(input.executionId);
      this.#coreStore().appendSemantic(input.executionId, state.latestOrdinal, [{
        occurrenceId,
        ordinal: state.latestOrdinal + 1,
        kind: 'recall_projection',
        observedAt: now(),
        payload: asJson({
          sourceExecutionId: input.recalledContext.sourceExecutionId,
          targetExecutionId: input.executionId,
          context: input.recalledContext,
        }),
      }]);
    }
    const relationDb = this.#db();
    try {
      relationDb.prepare(`
        INSERT INTO recall_relations(
          source_execution_id, target_execution_id, occurrence_id
        ) VALUES(?, ?, ?)
      `).run(input.recalledContext.sourceExecutionId, input.executionId, occurrenceId);
    } finally {
      relationDb.close();
    }
  }

  #appendTerminalAndSettleTx(
    db: DatabaseSync,
    input: Readonly<{
      executionId: string;
      observedAt: string;
      eventKind: 'execution_settled' | 'execution_reconciled';
      payload: JsonValue;
      outcome: 'unknown' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
      adoption: 'non_canonical' | 'canonical';
      allowExistingTerminal?: boolean;
    }>,
  ): void {
    const row = db.prepare(`
      SELECT e.*, a.event_count FROM executions e
      JOIN execution_admissions a USING(execution_id)
      WHERE e.execution_id=?
    `).get(input.executionId) as Row | undefined;
    if (
      row === undefined || row.lifecycle !== 'active' ||
      Number(row.unresolved_mandatory_count) !== 0 ||
      Number(row.latest_ordinal) !== Number(row.occurrence_count) ||
      (row.terminal_occurrence_id !== null && input.allowExistingTerminal !== true)
    ) throw new HistoryStoreError('history_invalid');
    const eventOrdinal = Number(row.event_count) + 1;
    const semanticOrdinal = Number(row.latest_ordinal) + 1;
    const occurrenceId = `${input.executionId}:semantic:${semanticOrdinal}`;
    const event: StoredExecutionEvent = {
      executionId: input.executionId,
      ordinal: eventOrdinal,
      observedAt: input.observedAt,
      direction: 'host_to_worker',
      source: 'host',
      kind: input.eventKind,
      payload: input.payload,
    };
    const payloadJson = new TextDecoder().decode(encodeHistoryV7Payload(eventValue(event)));
    db.prepare(`
      INSERT INTO semantic_occurrences(
        occurrence_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest
      ) VALUES(?, ?, ?, 'host_decision', ?, ?, NULL)
    `).run(
      occurrenceId,
      input.executionId,
      semanticOrdinal,
      input.observedAt,
      payloadJson,
    );
    db.prepare(`
      UPDATE executions SET lifecycle='settled', outcome=?, adoption=?,
        latest_ordinal=?, occurrence_count=occurrence_count+1, terminal_occurrence_id=?
      WHERE execution_id=?
    `).run(
      input.outcome,
      input.adoption,
      semanticOrdinal,
      occurrenceId,
      input.executionId,
    );
    db.prepare(`
      UPDATE execution_admissions SET event_count=?, settled_at=? WHERE execution_id=?
    `).run(eventOrdinal, input.observedAt, input.executionId);
  }

  commitCanonicalTurn(input: CanonicalTurnCommitInput): HistoryCaptureResult {
    if (
      input.record.sessionId !== input.canonicalSessionId ||
      input.record.workspaceRoot !== this.workspaceRoot ||
      input.record.stateRevision !== input.baseStateRevision + 1 ||
      input.record.nextTurn !== input.turn + 1
    ) throw new HistoryStoreError('history_invalid');
    this.#ensureRecallProjection(input);
    const captured = this.#capture(input);
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      const head = db.prepare('SELECT revision FROM session_heads WHERE session_id=?').get(
        input.canonicalSessionId,
      ) as Row | undefined;
      if (Number(head?.revision) !== input.baseStateRevision) {
        throw new HistoryStoreError('history_invalid');
      }
      this.#writeSessionTx(db, input.record, input.executionId);
      this.#appendTerminalAndSettleTx(db, {
        executionId: input.executionId,
        observedAt: input.record.updatedAt,
        eventKind: 'execution_settled',
        payload: { outcome: 'completed', adoption: 'canonical' },
        outcome: 'completed',
        adoption: 'canonical',
      });
      db.prepare(`
        UPDATE session_heads SET revision=? WHERE session_id=?
      `).run(input.record.stateRevision, input.canonicalSessionId);
      db.prepare(`
        UPDATE execution_admissions SET settled_at=?, outcome_json=?,
          diagnostic_id=?, artifact_id=? WHERE execution_id=?
      `).run(
        input.record.updatedAt,
        JSON.stringify(compactOutcome(input.outcome)),
        captured.diagnosticDurability === 'yes' ? input.diagnostic?.diagnosticId ?? null : null,
        input.artifactForCapture === undefined ? null : input.executionId,
        input.executionId,
      );
      this.#fault?.('before_settlement_commit');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the primary error.
      }
      throw asHistoryError(error);
    } finally {
      db.close();
      this.#eventCounts.delete(input.executionId);
      this.#baseMessageCountsBySession.delete(input.sessionCorrelation);
      this.#releaseExecutionLock(input.executionId);
    }
    return captured;
  }

  settleNonCanonicalExecution(input: NonCanonicalExecutionInput): HistoryCaptureResult {
    this.#ensureRecallProjection(input);
    const captured = this.#capture(input);
    const outcome = input.outcome.ok
      ? 'completed'
      : input.outcome.stopReason === 'cancelled'
      ? 'cancelled'
      : input.outcome.stopReason === 'interrupted'
      ? 'interrupted'
      : 'failed';
    const settledAt = now();
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      const admission = db.prepare(`
        SELECT base_message_count FROM execution_admissions WHERE execution_id=?
      `).get(input.executionId) as Row | undefined;
      if (admission === undefined) throw new HistoryStoreError('history_invalid');
      const baseMessageCount = Number(admission.base_message_count);
      if (baseMessageCount > input.outcome.transcript.length) {
        throw new HistoryStoreError('history_invalid');
      }
      for (
        let ordinal = baseMessageCount;
        ordinal < input.outcome.transcript.length;
        ordinal += 1
      ) {
        db.prepare(`
          INSERT INTO execution_messages(execution_id, message_ordinal, message_json)
          VALUES(?, ?, ?)
        `).run(
          input.executionId,
          ordinal - baseMessageCount,
          JSON.stringify(input.outcome.transcript[ordinal]),
        );
      }
      this.#appendTerminalAndSettleTx(db, {
        executionId: input.executionId,
        observedAt: settledAt,
        eventKind: 'execution_settled',
        payload: { outcome, adoption: 'non_canonical' },
        outcome,
        adoption: 'non_canonical',
      });
      db.prepare(`
        UPDATE execution_admissions SET settled_at=?, outcome_json=?,
          diagnostic_id=?, artifact_id=? WHERE execution_id=?
      `).run(
        settledAt,
        JSON.stringify(compactOutcome(input.outcome)),
        captured.diagnosticDurability === 'yes' ? input.diagnostic?.diagnosticId ?? null : null,
        input.artifactForCapture === undefined ? null : input.executionId,
        input.executionId,
      );
      this.#fault?.('before_settlement_commit');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the primary error.
      }
      throw asHistoryError(error);
    } finally {
      db.close();
      this.#eventCounts.delete(input.executionId);
      this.#baseMessageCountsBySession.delete(input.sessionCorrelation);
      this.#releaseExecutionLock(input.executionId);
    }
    return captured;
  }

  reconcileExecution(input: ReconcileExecutionInput): void {
    const current = this.#coreStore().readExecution(input.executionId);
    if (current.lifecycle !== 'active') return;
    const settledAt = input.settledAt ?? now();
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#appendTerminalAndSettleTx(db, {
        executionId: input.executionId,
        observedAt: settledAt,
        eventKind: 'execution_reconciled',
        payload: { settlement: input.settlement },
        outcome: input.settlement,
        adoption: 'non_canonical',
        allowExistingTerminal: current.terminalOccurrenceId !== undefined,
      });
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the primary error.
      }
      throw asHistoryError(error);
    } finally {
      db.close();
      this.#eventCounts.delete(input.executionId);
      const execution = this.#executionRows('WHERE e.execution_id=?', [input.executionId])[0];
      if (execution !== undefined) {
        this.#baseMessageCountsBySession.delete(execution.sessionCorrelation);
      }
      this.#releaseExecutionLock(input.executionId);
    }
  }

  recordPostCommitObservation(
    artifact: import('../worker/worker_execution_artifact.ts').StoredWorkerExecutionArtifact,
  ): void {
    if (!validateWorkerExecutionArtifact(artifact)) {
      throw new HistoryStoreError('history_invalid');
    }
    this.#writeDerivedDocument('artifact', artifact.executionId, artifact.executionId, artifact);
  }

  #executionRows(
    where = '',
    values: readonly SqlValue[] = [],
    includeTranscript = false,
    snapshotDb?: DatabaseSync,
  ): StoredExecutionRow[] {
    const db = snapshotDb ?? this.#db();
    try {
      const rows = db.prepare(`
        SELECT e.*, a.*,
          EXISTS(
            SELECT 1 FROM semantic_occurrences o
            WHERE o.execution_id=e.execution_id AND o.kind='model_request'
          ) AS has_context_observation
        FROM executions e
        JOIN execution_admissions a ON a.execution_id=e.execution_id
        ${where} ORDER BY a.turn_number, a.created_at, e.execution_id
      `).all(...values) as Row[];
      return rows.map((row) => {
        const outcomeJson = row.outcome_json === null
          ? undefined
          : parseJson<LoopOutcome>(row.outcome_json);
        let transcript: Message[] | undefined;
        if (outcomeJson !== undefined && includeTranscript) {
          const canonical = db.prepare(`
            SELECT message_json FROM session_messages
            WHERE session_id=? AND turn_number ${row.adoption === 'canonical' ? '<=' : '<'} ?
            ORDER BY message_ordinal
          `).all(row.session_correlation, row.turn_number) as Row[];
          const execution = row.adoption === 'canonical' ? [] : db.prepare(`
            SELECT message_json FROM execution_messages
            WHERE execution_id=? ORDER BY message_ordinal
          `).all(row.execution_id) as Row[];
          transcript = [...canonical, ...execution].map((item) =>
            parseJson<Message>(item.message_json)
          );
        }
        return {
          executionId: String(row.execution_id),
          taskId: String(row.task_id),
          task: String(row.task),
          ...(row.canonical_session_id === null
            ? {}
            : { canonicalSessionId: String(row.canonical_session_id) }),
          sessionCorrelation: String(row.session_correlation),
          ...(row.parent_execution_id === null
            ? {}
            : { parentExecutionId: String(row.parent_execution_id) }),
          ...(row.spawn_call_id === null ? {} : { spawnCallId: String(row.spawn_call_id) }),
          turn: Number(row.turn_number),
          createdAt: String(row.created_at),
          ...(row.settled_at === null ? {} : { settledAt: String(row.settled_at) }),
          lifecycle: String(row.lifecycle) as StoredExecutionRow['lifecycle'],
          outcome: String(row.outcome) as StoredExecutionRow['outcome'],
          ...(outcomeJson === undefined ? {} : {
            outcomeJson: includeTranscript
              ? { ...outcomeJson, transcript: transcript! }
              : outcomeJson,
          }),
          adoption: String(row.adoption) as StoredExecutionRow['adoption'],
          baseRevision: Number(row.base_revision),
          ...(row.adoption === 'canonical'
            ? { committedRevision: Number(row.base_revision) + 1 }
            : {}),
          agent: String(row.agent) as SessionRecord['agent'],
          model: parseJson<StoredExecutionRow['model']>(row.model_json),
          build: parseJson<StoredExecutionRow['build']>(row.build_json),
          definition: parseJson<StoredExecutionRow['definition']>(row.definition_json),
          ...(row.manifest_json === null ? {} : {
            manifest: parseJson<NonNullable<StoredExecutionRow['manifest']>>(row.manifest_json),
          }),
          ...(row.instance_correlation === null
            ? {}
            : { instanceCorrelation: String(row.instance_correlation) }),
          ...(row.worker_generation === null
            ? {}
            : { workerGeneration: String(row.worker_generation) }),
          acknowledgement: 'not_sent',
          generationAvailability: 'unknown',
          diagnosticCapture: row.diagnostic_id === null ? 'none' : 'yes',
          ...(row.diagnostic_id === null ? {} : { diagnosticId: String(row.diagnostic_id) }),
          artifactCapture: row.artifact_id === null ? 'none' : 'yes',
          contextCapture: row.lifecycle === 'active'
            ? 'none'
            : this.#hasContextManifest(db, String(row.execution_id))
            ? 'complete'
            : Number(row.has_context_observation) === 1
            ? 'partial'
            : 'none',
        };
      });
    } finally {
      if (snapshotDb === undefined) db.close();
    }
  }

  #hasContextManifest(db: DatabaseSync, executionId: string): boolean {
    return db.prepare(
      'SELECT 1 FROM execution_context_manifests WHERE execution_id=?',
    ).get(executionId) !== undefined;
  }

  listExecutions(): readonly StoredExecutionRow[] {
    return this.#executionRows();
  }

  listExecutionsForSession(sessionId: string): readonly StoredExecutionRow[] {
    return this.#executionRows('WHERE a.session_correlation=?', [sessionId]);
  }

  /** Read the human session timeline without opening or decoding diagnostic attachments. */
  readSessionHistory(sessionId: string): readonly StoredSessionHistoryExecution[] {
    const db = this.#db();
    try {
      db.exec('BEGIN');
      const exists = db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(sessionId);
      if (exists === undefined) throw new HistoryStoreError('history_invalid');
      const executions = this.#executionRows(
        'WHERE a.session_correlation=?',
        [sessionId],
        false,
        db,
      );
      const canonicalMessages = db.prepare(`
        SELECT message_json FROM session_messages
        WHERE session_id=? AND turn_number=? ORDER BY message_ordinal
      `);
      const otherMessages = db.prepare(`
        SELECT message_json FROM execution_messages
        WHERE execution_id=? ORDER BY message_ordinal
      `);
      const thinkingRows = db.prepare(`
        SELECT payload_json FROM semantic_occurrences
        WHERE execution_id=? AND kind='assistant_message' ORDER BY ordinal
      `);
      const timeline = executions.map((execution): StoredSessionHistoryExecution => {
        const rows = execution.adoption === 'canonical'
          ? canonicalMessages.all(sessionId, execution.turn) as Row[]
          : otherMessages.all(execution.executionId) as Row[];
        const messages = rows.map((row) => parseJson<Message>(row.message_json));
        const thinking: StoredSessionHistoryExecution['thinking'][number][] = [];
        for (const row of thinkingRows.all(execution.executionId) as Row[]) {
          const stored = parseJson<{ event?: StoredExecutionEvent }>(row.payload_json).event;
          if (stored?.kind !== 'runtime_event') continue;
          const payload = stored.payload as unknown as {
            kind?: string;
            event?: { kind?: string; event?: unknown };
          };
          const candidate = payload.kind === 'runtime_event' &&
              payload.event?.kind === 'agent_event'
            ? payload.event.event
            : undefined;
          if (
            typeof candidate !== 'object' || candidate === null ||
            (candidate as { kind?: unknown }).kind !== 'assistant_thinking'
          ) continue;
          thinking.push(candidate as StoredSessionHistoryExecution['thinking'][number]);
        }
        return { execution, messages, thinking };
      });
      db.exec('COMMIT');
      return timeline;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve original read error */ }
      throw error;
    } finally {
      db.close();
    }
  }

  readExecution(id: string): StoredExecutionRow {
    const row = this.#executionRows('WHERE e.execution_id=?', [id], true)[0];
    if (row === undefined) throw new HistoryStoreError('history_invalid');
    return row;
  }

  #readExecutionMetadata(id: string): StoredExecutionRow {
    const row = this.#executionRows('WHERE e.execution_id=?', [id], false)[0];
    if (row === undefined) throw new HistoryStoreError('history_invalid');
    return row;
  }

  listExecutionEvents(id: string): readonly StoredExecutionEvent[] {
    this.#readExecutionMetadata(id);
    return this.#listExecutionEvents(id, true);
  }

  #listExecutionEvents(id: string, hydrateContext: boolean): readonly StoredExecutionEvent[] {
    const occurrences = this.#coreStore().listOccurrences(id);
    const contextItems = new Map<string, ContextOccurrenceInput>();
    const contentByDigest = new Map<string, string>();
    if (hydrateContext) {
      for (const occurrence of occurrences) {
        if (
          occurrence.kind !== 'context_item' || occurrence.contentDigest === undefined ||
          typeof occurrence.payload !== 'object' || occurrence.payload === null ||
          Array.isArray(occurrence.payload)
        ) continue;
        const metadata = occurrence.payload as unknown as Omit<
          ContextOccurrenceInput,
          'bytesBase64'
        >;
        if (typeof metadata.occurrenceId !== 'string') continue;
        let bytesBase64 = contentByDigest.get(occurrence.contentDigest);
        if (bytesBase64 === undefined) {
          bytesBase64 = this.#coreStore().readContent(occurrence.contentDigest).toBase64();
          contentByDigest.set(occurrence.contentDigest, bytesBase64);
        }
        contextItems.set(metadata.occurrenceId, { ...metadata, bytesBase64 });
      }
    }
    const semantic = occurrences.flatMap((occurrence) => {
      if (
        typeof occurrence.payload !== 'object' || occurrence.payload === null ||
        Array.isArray(occurrence.payload)
      ) return [];
      const event = (occurrence.payload as Record<string, JsonValue>).event;
      if (typeof event !== 'object' || event === null || Array.isArray(event)) return [];
      const hydrated = structuredClone(event) as unknown as StoredExecutionEvent;
      if (
        hydrated.kind === 'context_observation' && hydrateContext && contextItems.size > 0 &&
        typeof hydrated.payload === 'object' && hydrated.payload !== null &&
        !Array.isArray(hydrated.payload)
      ) {
        const payload = hydrated.payload as unknown as Record<string, unknown>;
        const observation = payload.observation as
          | { kind?: string; delta?: { occurrences?: unknown[] } }
          | undefined;
        if (
          observation?.kind === 'model_request_delta' &&
          Array.isArray(observation.delta?.occurrences)
        ) {
          observation.delta!.occurrences = observation.delta!.occurrences.map((item) => {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
            const occurrenceId = (item as { occurrenceId?: unknown }).occurrenceId;
            return typeof occurrenceId === 'string' && contextItems.has(occurrenceId)
              ? structuredClone(contextItems.get(occurrenceId)!)
              : item;
          });
        }
      }
      if (
        hydrated.kind === 'runtime_event' && typeof hydrated.payload === 'object' &&
        hydrated.payload !== null && !Array.isArray(hydrated.payload)
      ) {
        const payload = hydrated.payload as unknown as Record<string, unknown>;
        const outcome = payload.outcome;
        if (
          payload.kind === 'commit_proposal' && Array.isArray(payload.transcript) &&
          typeof outcome === 'object' && outcome !== null && !Array.isArray(outcome) &&
          Array.isArray((outcome as Record<string, unknown>).transcript) &&
          ((outcome as Record<string, unknown>).transcript as unknown[]).length === 0
        ) {
          (outcome as Record<string, unknown>).transcript = structuredClone(payload.transcript);
        }
      }
      return [hydrated];
    });
    return semantic;
  }

  listExecutionEffects(id: string): readonly StoredExecutionEffect[] {
    const execution = this.#readExecutionMetadata(id);
    const effects = new Map<string, StoredExecutionEffect>();
    for (const event of this.#listExecutionEvents(id, false)) {
      if (event.kind !== 'effect_observation' && event.kind !== 'runtime_event') continue;
      const payload = event.payload as Record<string, unknown>;
      const providerObservation = payload.kind === 'provider_observation' &&
          typeof payload.observation === 'object' && payload.observation !== null
        ? payload.observation as Record<string, unknown>
        : undefined;
      const providerEvent = providerObservation?.kind === 'runtime_event' &&
          typeof providerObservation.event === 'object' && providerObservation.event !== null
        ? providerObservation.event as Record<string, unknown>
        : undefined;
      const effect = providerEvent ??
        (typeof payload.effect === 'object' && payload.effect !== null
          ? payload.effect as Record<string, unknown>
          : payload);
      const phase = String(effect.kind ?? '');
      const nested = phase === 'tool_call'
        ? effect.call
        : phase === 'tool_result'
        ? effect.result
        : effect;
      if (typeof nested !== 'object' || nested === null) continue;
      const value = nested as Record<string, unknown>;
      if (typeof value.callId !== 'string') continue;
      const prior = effects.get(value.callId);
      const completed = phase === 'tool_result';
      const progress = phase === 'tool_progress';
      effects.set(value.callId, {
        executionId: id,
        callId: value.callId,
        name: String(value.name ?? prior?.name ?? ''),
        ...(phase === 'tool_call'
          ? { requestedEventOrdinal: event.ordinal }
          : prior?.requestedEventOrdinal === undefined
          ? {}
          : { requestedEventOrdinal: prior.requestedEventOrdinal }),
        ...(progress
          ? { progressEventOrdinal: event.ordinal }
          : prior?.progressEventOrdinal === undefined
          ? {}
          : { progressEventOrdinal: prior.progressEventOrdinal }),
        ...(completed
          ? { completedEventOrdinal: event.ordinal }
          : prior?.completedEventOrdinal === undefined
          ? {}
          : { completedEventOrdinal: prior.completedEventOrdinal }),
        ...(completed && (value.outcome === 'success' || value.outcome === 'error')
          ? { resultOutcome: value.outcome }
          : prior?.resultOutcome === undefined
          ? {}
          : { resultOutcome: prior.resultOutcome }),
        status: completed ? 'completed' : progress ? 'observed_progress' : 'observed_requested',
      });
    }
    return [...effects.values()].map((effect) =>
      effect.completedEventOrdinal === undefined &&
        (execution.outcome === 'interrupted' || execution.outcome === 'unknown')
        ? { ...effect, status: 'outcome_unknown' as const }
        : effect
    );
  }

  listExecutionContext(executionId: string): {
    readonly snapshot?: WorkerContextSnapshot;
    readonly relations: readonly ExecutionContextRelation[];
    readonly requests: readonly ContextModelRequestRecord[];
  } {
    this.#readExecutionMetadata(executionId);
    const db = this.#db();
    const relations: ExecutionContextRelation[] = [];
    try {
      const manifest = db.prepare(`
        SELECT manifest_json FROM execution_context_manifests WHERE execution_id=?
      `).get(executionId) as Row | undefined;
      if (manifest !== undefined) {
        const decoded = parseJson<
          { externalRelations: readonly Omit<ExecutionContextRelation, 'ordinal'>[] }
        >(
          manifest.manifest_json,
        );
        for (const relation of decoded.externalRelations) {
          relations.push({ ordinal: relations.length + 1, ...relation });
        }
      }
    } finally {
      db.close();
    }
    const requests: ContextModelRequestRecord[] = [];
    const occurrences = new Map<
      string,
      import('./context_attribution.ts').ContextOccurrenceInput
    >();
    const bytesByDigest = new Map<string, string>();
    const sequences = new Map<string, string[]>();
    for (const event of this.listExecutionEvents(executionId)) {
      if (event.kind !== 'context_observation') continue;
      const payload = event.payload as unknown as {
        observation?: {
          kind?: string;
          delta?: import('./context_attribution.ts').ContextModelRequestDelta;
        };
      };
      const delta = payload.observation?.delta;
      if (payload.observation?.kind !== 'model_request_delta' || delta === undefined) continue;
      for (const occurrence of delta.occurrences) {
        occurrences.set(occurrence.occurrenceId, occurrence);
        if (occurrence.bytesBase64 !== undefined) {
          bytesByDigest.set(occurrence.content.digest, occurrence.bytesBase64);
        }
      }
      const key = `${delta.lane}:${delta.purpose}`;
      const sequence = [...(sequences.get(key) ?? [])];
      for (const splice of delta.splices) {
        sequence.splice(
          splice.start,
          splice.deleteCount,
          ...splice.insertions.map((item) => item.occurrenceId),
        );
      }
      sequences.set(key, sequence);
      const items = sequence.map((occurrenceId, ordinal) => {
        const occurrence = occurrences.get(occurrenceId);
        if (occurrence === undefined) throw new HistoryStoreError('history_invalid');
        const relationOrdinals = occurrence.sourceRelations.map((source) => {
          const relationOrdinal = relations.length + 1;
          relations.push({
            ordinal: relationOrdinal,
            ...source,
            contentDigest: source.contentDigest ?? occurrence.content.digest,
            requestOrdinal: delta.requestOrdinal,
          });
          return relationOrdinal;
        });
        return { ordinal, ...occurrence, relationOrdinals };
      });
      const decoded = items.map((item) =>
        (item.bytesBase64 ?? bytesByDigest.get(item.content.digest)) === undefined
          ? undefined
          : new TextDecoder().decode(
            Uint8Array.fromBase64(
              item.bytesBase64 ?? bytesByDigest.get(item.content.digest)!,
            ),
          )
      );
      const request = delta.purpose === 'user_turn'
        ? {
          ...(items.findIndex((item) => item.kind === 'system') < 0 ? {} : {
            systemInstruction: decoded[
              items.findIndex((item) => item.kind === 'system')
            ],
          }),
          transcript: items.flatMap((item, index) =>
            item.kind === 'message' && decoded[index] !== undefined
              ? [JSON.parse(decoded[index]!) as Message]
              : []
          ),
          tools: items.flatMap((item, index) =>
            item.kind === 'tool_contract' && decoded[index] !== undefined
              ? [JSON.parse(decoded[index]!)]
              : []
          ),
        }
        : undefined;
      requests.push({
        requestOrdinal: delta.requestOrdinal,
        lane: delta.lane,
        purpose: delta.purpose,
        modelStep: delta.modelStep,
        ...(delta.modelSelection === undefined ? {} : { modelSelection: delta.modelSelection }),
        ...(delta.sourceCallId === undefined ? {} : { sourceCallId: delta.sourceCallId }),
        ...(request === undefined ? {} : { request }),
        items,
      });
    }
    const db2 = this.#db();
    let snapshot: WorkerContextSnapshot | undefined;
    try {
      const row = db2.prepare(`
        SELECT context_snapshot_json FROM execution_admissions WHERE execution_id=?
      `).get(executionId) as Row;
      snapshot = row.context_snapshot_json === null
        ? undefined
        : parseJson<WorkerContextSnapshot>(row.context_snapshot_json);
    } finally {
      db2.close();
    }
    return { ...(snapshot === undefined ? {} : { snapshot }), relations, requests };
  }

  readExecutionRequest(executionId: string, requestOrdinal: number): ContextModelRequestRecord {
    const request = this.listExecutionContext(executionId).requests.find((item) =>
      item.requestOrdinal === requestOrdinal
    );
    if (request === undefined) throw new HistoryStoreError('history_invalid');
    return request;
  }

  readExecutionRequestFacts(
    executionId: string,
    requestOrdinal: number,
  ): readonly StoredExecutionEvent[] {
    const events = this.listExecutionEvents(executionId);
    const ordinals = new Set(events.flatMap((event) => {
      if (event.kind !== 'provider_request_start') return [];
      const payload = event.payload as unknown as {
        observation?: { request?: { ordinal?: number; contextRequestOrdinal?: number } };
      };
      const request = payload.observation?.request;
      return request?.contextRequestOrdinal === requestOrdinal && request.ordinal !== undefined
        ? [request.ordinal]
        : [];
    }));
    return events.filter((event) => {
      if (!event.kind.startsWith('provider_')) return false;
      const payload = event.payload as unknown as {
        observation?: { kind?: string; requestOrdinal?: number; request?: { ordinal?: number } };
      };
      const ordinal = payload.observation?.kind === 'request_start'
        ? payload.observation.request?.ordinal
        : payload.observation?.requestOrdinal;
      return ordinal !== undefined && ordinals.has(ordinal);
    });
  }

  listRecallRelations(targetExecutionId: string): readonly {
    sourceExecutionId: string;
    targetExecutionId: string;
    occurrenceId: string;
  }[] {
    const db = this.#db();
    try {
      return (db.prepare(`
        SELECT * FROM recall_relations WHERE target_execution_id=? ORDER BY rowid
      `).all(targetExecutionId) as Row[]).map((row) => ({
        sourceExecutionId: String(row.source_execution_id),
        targetExecutionId: String(row.target_execution_id),
        occurrenceId: String(row.occurrence_id),
      }));
    } finally {
      db.close();
    }
  }

  *streamHumanHistoryExport(sessionId: string): Iterable<HumanHistoryExportRecordV1> {
    const db = this.#db();
    let transactionOpen = false;
    try {
      db.exec('BEGIN');
      transactionOpen = true;
      const executions = this.#executionRows(
        'WHERE a.session_correlation=?',
        [sessionId],
        false,
        db,
      );
      const session = db.prepare('SELECT * FROM sessions WHERE session_id=?').get(sessionId) as
        | Row
        | undefined;
      if (session === undefined) throw new HistoryStoreError('history_invalid');
      yield {
        schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
        kind: 'header',
        identity: sessionId,
        value: asJson({
          historySchemaVersion: 7,
          sessionId,
          stateRevision: Number(session.state_revision),
          tail: executions.at(-1) === undefined
            ? null
            : { executionId: executions.at(-1)!.executionId },
        }),
      };
      yield {
        schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
        kind: 'session',
        identity: sessionId,
        value: asJson({
          sessionId,
          workspaceRoot: String(session.workspace_root),
          agent: String(session.agent),
          createdAt: String(session.created_at),
          updatedAt: String(session.updated_at),
          title: session.title === null ? null : String(session.title),
          stateRevision: Number(session.state_revision),
          nextTurn: Number(session.next_turn),
          definition: parseJson<JsonValue>(session.definition_json),
          activeModel: parseJson<JsonValue>(session.active_model_json),
          messageCount: Number(session.message_count),
          modelChangeCount: Number(session.model_change_count),
          turnCount: Number(session.turn_count),
        }),
      };
      for (
        const row of db.prepare(`
          SELECT message_ordinal, turn_number, message_json FROM session_messages
          WHERE session_id=? ORDER BY message_ordinal
        `).iterate(sessionId) as Iterable<Row>
      ) {
        yield {
          schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
          kind: 'session_message',
          identity: `${sessionId}:message:${Number(row.message_ordinal)}`,
          value: asJson({
            ordinal: Number(row.message_ordinal),
            turn: Number(row.turn_number),
            message: parseJson<JsonValue>(row.message_json),
          }),
        };
      }
      for (
        const row of db.prepare(`
          SELECT * FROM session_model_changes WHERE session_id=? ORDER BY change_ordinal
        `).iterate(sessionId) as Iterable<Row>
      ) {
        yield {
          schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
          kind: 'session_model_change',
          identity: `${sessionId}:model:${Number(row.change_ordinal)}`,
          value: asJson({
            ordinal: Number(row.change_ordinal),
            effectiveFromTurn: Number(row.effective_from_turn),
            changedAt: String(row.changed_at),
            selection: parseJson<JsonValue>(row.selection_json),
          }),
        };
      }
      for (
        const row of db.prepare(`
          SELECT * FROM session_turns WHERE session_id=? ORDER BY turn_ordinal
        `).iterate(sessionId) as Iterable<Row>
      ) {
        yield {
          schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
          kind: 'session_turn',
          identity: `${sessionId}:turn:${Number(row.turn_number)}`,
          value: asJson({
            ordinal: Number(row.turn_ordinal),
            turn: Number(row.turn_number),
            model: parseJson<JsonValue>(row.model_json),
            build: parseJson<JsonValue>(row.build_json),
            definition: parseJson<JsonValue>(row.definition_json),
            ...(row.execution_id === null ? {} : { executionId: String(row.execution_id) }),
          }),
        };
      }
      const exportedContentDigests = new Set<string>();
      for (const execution of executions) {
        yield {
          schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
          kind: 'execution',
          identity: execution.executionId,
          value: asJson(execution),
        };
        for (const occurrence of this.#coreStore().listOccurrences(execution.executionId, db)) {
          if (
            occurrence.contentDigest !== undefined &&
            !exportedContentDigests.has(occurrence.contentDigest)
          ) {
            const content = this.#coreStore().readContent(occurrence.contentDigest, db);
            exportedContentDigests.add(occurrence.contentDigest);
            yield {
              schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
              kind: 'immutable_content',
              identity: occurrence.contentDigest,
              value: asJson({
                contentDigest: occurrence.contentDigest,
                byteLength: content.byteLength,
                contentBase64: content.toBase64(),
              }),
            };
          }
          yield {
            schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
            kind: 'semantic_occurrence',
            identity: occurrence.occurrenceId,
            value: asJson(occurrence),
          };
        }
        for (
          const row of db.prepare(`
            SELECT r.* FROM semantic_relations r
            JOIN semantic_occurrences o ON o.occurrence_id=r.occurrence_id
            WHERE o.execution_id=? ORDER BY o.ordinal, r.relation_ordinal
          `).iterate(execution.executionId) as Iterable<Row>
        ) {
          yield {
            schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
            kind: 'semantic_relation',
            identity: `${String(row.occurrence_id)}:${Number(row.relation_ordinal)}`,
            value: asJson({
              occurrenceId: String(row.occurrence_id),
              relationOrdinal: Number(row.relation_ordinal),
              relation: String(row.relation),
              targetOccurrenceId: String(row.target_occurrence_id),
              mandatory: Number(row.mandatory) === 1,
              resolved: Number(row.resolved) === 1,
            }),
          };
        }
        const manifest = db.prepare(`
          SELECT manifest_json FROM execution_context_manifests WHERE execution_id=?
        `).get(execution.executionId) as Row | undefined;
        if (manifest !== undefined) {
          yield {
            schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
            kind: 'execution_context_manifest',
            identity: execution.executionId,
            value: parseJson<JsonValue>(manifest.manifest_json),
          };
        }
        for (
          const row of db.prepare(`
            SELECT * FROM recall_relations WHERE target_execution_id=? ORDER BY rowid
          `).iterate(execution.executionId) as Iterable<Row>
        ) {
          yield {
            schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
            kind: 'recall_relation',
            identity: `${String(row.source_execution_id)}:${String(row.target_execution_id)}`,
            value: asJson({
              sourceExecutionId: String(row.source_execution_id),
              targetExecutionId: String(row.target_execution_id),
              occurrenceId: String(row.occurrence_id),
            }),
          };
        }
      }
    } finally {
      try {
        if (transactionOpen) db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    }
  }
}
