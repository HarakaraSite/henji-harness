import { DatabaseSync } from 'node:sqlite';
import type { JsonValue, LoopOutcome, Message } from '../core/contracts.ts';
import type { AgentEvent } from '../core/events.ts';
import type { ProviderEvidenceRuntimeEvent } from '../provider/provider_evidence.ts';
import { isStoredModelSelection, type ModelSelection } from '../provider/model_selection.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { WorkerConfigurationSnapshot } from '../worker/worker_configuration.ts';
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import { validateFailureDiagnostic } from '../session/failure_diagnostic.ts';
import {
  type FailureDiagnosticStore,
  FailureDiagnosticStoreError,
} from '../session/failure_diagnostic_store.ts';
import {
  isSessionId,
  MAX_VALID_SESSIONS_PER_WORKSPACE,
  type SemanticContextCheckpointV1,
  SessionStoreError,
  type StoredSessionRecord,
  type WorkerSessionHandle,
  type WorkerSessionListResult,
  type WorkerSessionMetadata,
  type WorkerSessionStorePort,
} from '../session/session_store_contract.ts';
import {
  encodeSemanticContextCheckpoint,
  validateSemanticContextCheckpoint,
  validateStoredSessionRecord,
} from '../session/session_record_codec.ts';
import { acquireLock, ensureDirectory, type Lock } from '../session/deno_session_store_io.ts';
import { workspaceDigest } from '../session/session_store_paths.ts';
import { withHistorySchemaOpen } from './history_schema_open.ts';
import { HISTORY_BUSY_TIMEOUT_MS } from './history_schema.ts';
import { adoptCanonicalInTransaction, SqliteHistoryCore } from './sqlite_history_core.ts';
import { exactByteDigest } from './exact_byte_plan.ts';
import {
  type BeginExecutionInput,
  type CanonicalTurnCommitInput,
  type ExecutionControlEventInput,
  type ExecutionEventInput,
  type HistoryAppendResult,
  type HistoryCaptureResult,
  type HistoryCommitDelta,
  type HistoryPersistencePort,
  type HistoryPostSettlementSemanticEventInput,
  HistoryStoreError,
  type NonCanonicalExecutionInput,
  type ReconcileExecutionInput,
  type StoredExecutionEffect,
  type StoredExecutionEvent,
  type StoredExecutionRow,
  type StoredSessionConversationExecution,
  type StoredSessionHistoryExecution,
} from './history_store_contract.ts';
import type {
  ContextModelRequestDelta,
  ContextModelRequestRecord,
  ContextOccurrenceInput,
  ExecutionContextRelation,
  WorkerContextSnapshot,
} from './context_attribution.ts';
import {
  encodeHistoryPayload,
  type HistoryAssistantTextKey,
  type HistoryAssistantTextUpdate,
  type HistorySemanticKind,
  type HistorySemanticOccurrence,
  type HistorySemanticOccurrenceInput,
} from './history_semantic_model.ts';
import {
  type StoredWorkerExecutionArtifact,
  validateWorkerExecutionArtifact,
  type WorkerExecutionArtifactV1,
  workerExecutionOutcome,
} from '../worker/worker_execution_artifact.ts';
import {
  type WorkerExecutionArtifactStore,
  WorkerExecutionArtifactStoreError,
} from '../worker/worker_execution_artifact_store.ts';
import type { WorkerToHostMessage } from '../worker/worker_protocol.ts';
import {
  type RecalledExecutionContext,
  recalledExecutionProjectionText,
} from '../worker/recalled_execution_context.ts';
import {
  HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
  type HumanHistoryExportRecordV1,
} from './history_export_record.ts';

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
type StoreFaultPhase = 'before_settlement_commit';

const now = (): string => new Date().toISOString();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const asJson = (value: unknown): JsonValue => structuredClone(value) as JsonValue;
const parseJson = <T>(value: SqlValue): T => JSON.parse(String(value)) as T;
const eventValue = (event: StoredExecutionEvent): JsonValue => asJson({ event });
const compactOutcome = (outcome: LoopOutcome): LoopOutcome => ({
  ...outcome,
  transcript: [],
});
const asHistoryError = (error: unknown): HistoryStoreError =>
  error instanceof HistoryStoreError ? error : new HistoryStoreError('history_io_failure');
const asSessionError = (error: unknown): SessionStoreError =>
  error instanceof SessionStoreError ? error : new SessionStoreError('session_io_failure');

const semanticKindForEvent = (
  input: ExecutionEventInput,
): HistorySemanticKind | undefined => {
  switch (input.kind) {
    case 'execution_admitted':
      return 'execution_admission';
    case 'steer_requested':
      return 'user_message';
    case 'cancel_requested':
    case 'cancel_failed':
    case 'cancel_escalated':
    case 'steer_sent':
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
        const observation = payload.observation as
          | Record<string, unknown>
          | undefined;
        if (observation?.kind !== 'runtime_event') return undefined;
        const event = observation.event as Record<string, unknown> | undefined;
        switch (event?.kind) {
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
      if (
        agentEvent.kind === 'user_message' ||
        agentEvent.kind === 'steering_message'
      ) return 'user_message';
      if (agentEvent.kind === 'tool_call') return 'tool_call';
      if (
        agentEvent.kind === 'tool_result' || agentEvent.kind === 'tool_progress'
      ) return 'tool_result';
      if (agentEvent.kind === 'hook_context_update') return 'context_update';
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

const providerTextEvent = (
  event: StoredExecutionEvent,
):
  | Extract<
    ProviderEvidenceRuntimeEvent,
    { kind: 'assistant_progress' | 'model_result' }
  >
  | undefined => {
  if (event.kind !== 'runtime_event') return undefined;
  const payload = event.payload as unknown as Extract<
    WorkerToHostMessage,
    { kind: 'provider_observation' }
  >;
  if (
    payload.kind !== 'provider_observation' ||
    payload.observation.kind !== 'runtime_event'
  ) return undefined;
  const value = payload.observation.event;
  return value.kind === 'assistant_progress' || value.kind === 'model_result' ? value : undefined;
};

const severityOutcome = (outcome: LoopOutcome): StoredExecutionRow['outcome'] =>
  outcome.ok
    ? 'completed'
    : outcome.stopReason === 'cancelled'
    ? 'cancelled'
    : outcome.stopReason === 'interrupted'
    ? 'interrupted'
    : 'failed';

const emptySessionCounts = { messages: 0, modelChanges: 0, turns: 0 };

/** Production history facade over the clean schema-v1 database. */
export class SqliteHistoryStore implements WorkerSessionStorePort, HistoryPersistencePort {
  readonly executionArtifacts: WorkerExecutionArtifactStore = {
    list: async () => {
      await this.initialize();
      const db = this.#db();
      try {
        const ids = (db.prepare(
          "SELECT execution_id FROM executions WHERE lifecycle='settled' ORDER BY created_at, execution_id",
        ).all() as Row[])
          .map((row) => String(row.execution_id));
        return ids.map((id) => this.#deriveArtifact(id, db));
      } finally {
        db.close();
      }
    },
    read: async (id) => {
      await this.initialize();
      const db = this.#db();
      try {
        const row = db.prepare(
          'SELECT lifecycle FROM executions WHERE execution_id=?',
        ).get(id) as Row | undefined;
        if (row === undefined || row.lifecycle !== 'settled') {
          throw new WorkerExecutionArtifactStoreError(
            'worker_execution_artifact_not_found',
          );
        }
        try {
          return this.#deriveArtifact(id, db);
        } catch {
          throw new WorkerExecutionArtifactStoreError(
            'worker_execution_artifact_invalid',
          );
        }
      } finally {
        db.close();
      }
    },
    write: async (artifact) => {
      await this.initialize();
      if (
        !validateWorkerExecutionArtifact(artifact) ||
        artifact.schemaVersion !== 1
      ) {
        throw new WorkerExecutionArtifactStoreError(
          'worker_execution_artifact_invalid',
        );
      }
      const db = this.#db();
      try {
        if (
          db.prepare('SELECT 1 FROM executions WHERE execution_id=?').get(
            artifact.executionId,
          ) === undefined
        ) {
          throw new WorkerExecutionArtifactStoreError(
            'worker_execution_artifact_not_found',
          );
        }
      } finally {
        db.close();
      }
      this.#recordArtifactMetadata(artifact);
    },
  };

  readonly diagnostics: FailureDiagnosticStore = {
    list: async () => {
      await this.initialize();
      const db = this.#db();
      try {
        return (db.prepare(
          'SELECT diagnostic_id FROM diagnostics ORDER BY diagnostic_id',
        ).all() as Row[])
          .map((row) => this.#readDiagnostic(String(row.diagnostic_id), db));
      } finally {
        db.close();
      }
    },
    read: async (id) => {
      await this.initialize();
      const db = this.#db();
      try {
        return this.#readDiagnostic(id, db);
      } finally {
        db.close();
      }
    },
    write: async (diagnostic) => {
      await this.initialize();
      if (!validateFailureDiagnostic(diagnostic)) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      const db = this.#db();
      try {
        const owner = db.prepare(
          'SELECT execution_id FROM executions WHERE turn_number=? ORDER BY created_at DESC, execution_id DESC LIMIT 1',
        )
          .get(diagnostic.turnNumber) as Row | undefined;
        if (owner === undefined) {
          throw new FailureDiagnosticStoreError('diagnostic_invalid');
        }
        this.#writeDiagnosticTx(db, String(owner.execution_id), diagnostic);
      } catch (error) {
        if (error instanceof FailureDiagnosticStoreError) throw error;
        throw new FailureDiagnosticStoreError('diagnostic_io_failure');
      } finally {
        db.close();
      }
    },
    delete: async (id) => {
      await this.initialize();
      const db = this.#db();
      try {
        const result = db.prepare(
          'DELETE FROM diagnostics WHERE diagnostic_id=?',
        ).run(id);
        if (result.changes === 0) {
          throw new FailureDiagnosticStoreError('diagnostic_not_found');
        }
      } finally {
        db.close();
      }
    },
    persist: async (diagnostic) => await this.diagnostics.write(diagnostic),
  };

  readonly #makeUuid: () => string;
  readonly #fault?: (phase: StoreFaultPhase) => void;
  readonly #readOnly: boolean;
  readonly #executionLocks = new Map<string, Lock>();
  readonly #eventCounts = new Map<string, number>();
  readonly #baseMessageCountsBySession = new Map<string, number>();
  #databasePath?: string;
  #locksPath?: string;
  #core?: SqliteHistoryCore;
  #initialization?: Promise<void>;

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
    options: Readonly<{
      uuid?: () => string;
      fault?: (phase: StoreFaultPhase) => void;
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
    if (this.#initialization !== undefined) return await this.#initialization;
    this.#initialization = this.#initialize();
    try {
      await this.#initialization;
    } finally {
      this.#initialization = undefined;
    }
  }

  async #initialize(): Promise<void> {
    const digest = await workspaceDigest(this.workspaceRoot);
    const root = `${this.stateRoot}/${digest}`;
    if (!this.#readOnly) {
      await ensureDirectory(root, 0o700);
      await ensureDirectory(`${root}/locks`, 0o700);
    }
    await withHistorySchemaOpen(root, () => {
      if (this.#core !== undefined) return;
      this.#databasePath = `${root}/history.sqlite3`;
      this.#locksPath = `${root}/locks`;
      this.#core = new SqliteHistoryCore(this.#databasePath, {
        readOnly: this.#readOnly,
      });
    });
    if (this.#readOnly) return;
    const db = this.#db();
    let active: Row[];
    try {
      active = db.prepare(
        `SELECT execution_id, canonical_session_id, session_correlation FROM executions WHERE lifecycle='active' ORDER BY created_at, execution_id`,
      ).all() as Row[];
    } finally {
      db.close();
    }
    for (const row of active) {
      const id = String(row.execution_id);
      const sessionId = row.canonical_session_id === null
        ? undefined
        : String(row.canonical_session_id);
      const lockPath = sessionId === undefined
        ? `${this.#locksPath}/.execution-${id}.lock`
        : `${this.#locksPath}/${sessionId}.lock`;
      try {
        const lock = await acquireLock(lockPath);
        this.#executionLocks.set(id, lock);
        try {
          this.reconcileExecution({
            executionId: id,
            settlement: 'interrupted',
          });
        } finally {
          this.#releaseExecutionLock(id);
        }
      } catch (error) {
        if (
          error instanceof SessionStoreError && error.code === 'session_busy'
        ) continue;
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
    this.#databasePath = undefined;
    this.#locksPath = undefined;
  }

  #coreStore(): SqliteHistoryCore {
    if (this.#core === undefined) {
      throw new HistoryStoreError('history_io_failure');
    }
    return this.#core;
  }

  #db(): DatabaseSync {
    if (this.#databasePath === undefined) {
      throw new HistoryStoreError('history_io_failure');
    }
    const db = this.#readOnly
      ? new DatabaseSync(this.#databasePath, { readOnly: true })
      : new DatabaseSync(this.#databasePath);
    db.exec(
      `PRAGMA busy_timeout=${HISTORY_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON;`,
    );
    if (!this.#readOnly) {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    }
    return db;
  }

  #releaseExecutionLock(executionId: string): void {
    const lock = this.#executionLocks.get(executionId);
    if (lock === undefined) return;
    this.#executionLocks.delete(executionId);
    lock.close();
  }

  #sessionCounts(
    db: DatabaseSync,
    sessionId: string,
  ): { messages: number; modelChanges: number; turns: number } {
    const row = db.prepare(
      'SELECT message_count, model_change_count, turn_count FROM sessions WHERE session_id=?',
    ).get(sessionId) as Row | undefined;
    return row === undefined ? emptySessionCounts : {
      messages: Number(row.message_count),
      modelChanges: Number(row.model_change_count),
      turns: Number(row.turn_count),
    };
  }

  #writeSessionTx(db: DatabaseSync, record: StoredSessionRecord): void {
    if (
      !validateStoredSessionRecord(record) ||
      record.workspaceRoot !== this.workspaceRoot
    ) {
      throw new SessionStoreError('session_invalid');
    }
    const existing = db.prepare('SELECT 1 FROM sessions WHERE session_id=?')
      .get(record.sessionId);
    const counts = this.#sessionCounts(db, record.sessionId);
    if (
      counts.messages !== record.transcript.length ||
      counts.turns !== record.turnModels.length ||
      counts.modelChanges > record.modelChanges.length
    ) throw new SessionStoreError('session_invalid');
    db.prepare(`
      INSERT INTO sessions(
        session_id, workspace_root, agent_choice_json, created_at, updated_at, title,
        state_revision, next_turn, active_model_json, message_count, model_change_count,
        turn_count, checkpoint_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)
      ON CONFLICT(session_id) DO NOTHING
    `).run(
      record.sessionId,
      record.workspaceRoot,
      JSON.stringify(record.agentChoice),
      record.createdAt,
      record.updatedAt,
      record.title,
      record.stateRevision,
      record.nextTurn,
      JSON.stringify(record.activeModel),
      record.transcript.length,
      record.turnModels.length,
    );
    for (
      let ordinal = counts.modelChanges;
      ordinal < record.modelChanges.length;
      ordinal += 1
    ) {
      const change = record.modelChanges[ordinal];
      db.prepare(
        `INSERT INTO session_model_changes(session_id, change_ordinal, effective_from_turn, changed_at, selection_json) VALUES(?, ?, ?, ?, ?)`,
      )
        .run(
          record.sessionId,
          ordinal,
          change.effectiveFromTurn,
          change.changedAt,
          JSON.stringify(change.selection),
        );
    }
    db.prepare(`
      UPDATE sessions SET workspace_root=?, agent_choice_json=?, updated_at=?, title=?,
        state_revision=?, next_turn=?, active_model_json=?, message_count=?, model_change_count=?, turn_count=?
      WHERE session_id=?
    `).run(
      record.workspaceRoot,
      JSON.stringify(record.agentChoice),
      record.updatedAt,
      record.title,
      record.stateRevision,
      record.nextTurn,
      JSON.stringify(record.activeModel),
      record.transcript.length,
      record.modelChanges.length,
      record.turnModels.length,
      record.sessionId,
    );
    if (existing === undefined && record.turnModels.length !== 0) {
      throw new SessionStoreError('session_invalid');
    }
  }

  #writeSession(record: StoredSessionRecord): void {
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#writeSessionTx(db, record);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve the primary error */ }
      throw error;
    } finally {
      db.close();
    }
  }

  #readSession(db: DatabaseSync, id: string): StoredSessionRecord {
    const row = db.prepare('SELECT * FROM sessions WHERE session_id=?').get(
      id,
    ) as Row | undefined;
    if (row === undefined) throw new SessionStoreError('session_not_found');
    const agentRow = db.prepare(`
      SELECT e.agent_name FROM session_turns t JOIN executions e USING(execution_id)
      WHERE t.session_id=? ORDER BY t.turn_ordinal DESC LIMIT 1
    `).get(id) as Row | undefined;
    const activeAgent = agentRow?.agent_name === undefined
      ? db.prepare(
        'SELECT agent_name FROM executions WHERE canonical_session_id=? ORDER BY created_at DESC, execution_id DESC LIMIT 1',
      ).get(id) as Row | undefined
      : agentRow;
    const agentChoice = parseJson<StoredSessionRecord['agentChoice']>(
      row.agent_choice_json,
    );
    const agent = activeAgent?.agent_name === undefined
      ? agentChoice.name ?? 'default'
      : String(activeAgent.agent_name);
    const transcript = (db.prepare(`
      SELECT m.content_digest FROM conversation_messages c
      JOIN messages m ON m.execution_id=c.execution_id AND m.message_ordinal=c.execution_message_ordinal
      WHERE c.session_id=? ORDER BY c.message_ordinal
    `).all(id) as Row[]).map((messageRow) => {
      const bytes = this.#coreStore().readContent(
        String(messageRow.content_digest),
        db,
      );
      return JSON.parse(decoder.decode(bytes)) as Message;
    });
    const modelChanges = (db.prepare(
      `SELECT effective_from_turn, changed_at, selection_json FROM session_model_changes WHERE session_id=? ORDER BY change_ordinal`,
    ).all(id) as Row[])
      .map((item) => ({
        effectiveFromTurn: Number(item.effective_from_turn),
        changedAt: String(item.changed_at),
        selection: parseJson<StoredSessionRecord['activeModel']>(
          item.selection_json,
        ),
      }));
    const turns = db.prepare(`
      SELECT t.turn_number, t.execution_id, e.build_json, e.model_json, e.configuration_id
      FROM session_turns t JOIN executions e USING(execution_id)
      WHERE t.session_id=? ORDER BY t.turn_ordinal
    `).all(id) as Row[];
    const record: StoredSessionRecord = {
      schemaVersion: 1,
      sessionId: id,
      workspaceRoot: String(row.workspace_root),
      agent,
      agentChoice,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      title: row.title === null ? null : String(row.title),
      stateRevision: Number(row.state_revision),
      nextTurn: Number(row.next_turn),
      transcript,
      activeModel: parseJson<StoredSessionRecord['activeModel']>(
        row.active_model_json,
      ),
      modelChanges,
      turnModels: turns.map((item) => ({
        turn: Number(item.turn_number),
        selection: parseJson<ModelSelection>(item.model_json),
      })),
      turnExecutions: turns.map((item) => ({
        turn: Number(item.turn_number),
        executionId: String(item.execution_id),
        build: parseJson<BuildManifestV1>(item.build_json),
        configurationId: String(item.configuration_id),
      })),
    };
    if (!validateStoredSessionRecord(record)) {
      throw new SessionStoreError('session_invalid');
    }
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

  async readCheckpoint(
    id: string,
  ): Promise<SemanticContextCheckpointV1 | undefined> {
    await this.initialize();
    const db = this.#db();
    try {
      const row = db.prepare(
        'SELECT checkpoint_json FROM sessions WHERE session_id=?',
      ).get(id) as Row | undefined;
      if (row?.checkpoint_json === null || row?.checkpoint_json === undefined) {
        return undefined;
      }
      const checkpoint = parseJson<SemanticContextCheckpointV1>(
        row.checkpoint_json,
      );
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
      const rows = db.prepare(
        'SELECT session_id, workspace_root, agent_choice_json, created_at, updated_at, title, next_turn, active_model_json, message_count FROM sessions ORDER BY updated_at DESC, session_id',
      ).all() as Row[];
      const sessions: WorkerSessionMetadata[] = [];
      let skippedInvalid = 0;
      for (const row of rows) {
        try {
          const id = String(row.session_id);
          const choice = parseJson<StoredSessionRecord['agentChoice']>(
            row.agent_choice_json,
          );
          const modelSelection = parseJson<ModelSelection>(
            row.active_model_json,
          );
          if (
            !isSessionId(id) || !isStoredModelSelection(modelSelection) ||
            typeof choice !== 'object' || choice === null
          ) throw new Error('invalid session metadata');
          const agentRow = db.prepare(
            'SELECT agent_name FROM session_turns t JOIN executions e USING(execution_id) WHERE t.session_id=? ORDER BY t.turn_ordinal DESC LIMIT 1',
          ).get(id) as Row | undefined;
          sessions.push({
            id,
            agent: agentRow?.agent_name === undefined
              ? choice.name ?? 'default'
              : String(agentRow.agent_name),
            agentChoice: structuredClone(choice),
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
            ...(row.title === null ? {} : { title: String(row.title) }),
            turnCount: Number(row.next_turn) - 1,
            messageCount: Number(row.message_count),
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
    agent: string,
    agentChoice: StoredSessionRecord['agentChoice'],
  ): Promise<WorkerSessionHandle> {
    await this.initialize();
    if (
      typeof agent !== 'string' || agent.trim().length === 0 ||
      typeof agentChoice !== 'object' || agentChoice === null
    ) throw new SessionStoreError('session_invalid');
    if (
      (await this.listWorker()).sessions.length >=
        MAX_VALID_SESSIONS_PER_WORKSPACE
    ) throw new SessionStoreError('session_limit');
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.#makeUuid();
      if (!isSessionId(id)) continue;
      try {
        const lock = await acquireLock(`${this.#locksPath}/${id}.lock`);
        return this.#handle(id, agent, agentChoice, undefined, undefined, lock);
      } catch (error) {
        if (
          !(error instanceof SessionStoreError) || error.code !== 'session_busy'
        ) throw error;
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
      return this.#handle(
        id,
        record.agent,
        record.agentChoice,
        record,
        checkpoint,
        lock,
      );
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
      if (
        db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(id) ===
          undefined
      ) throw new SessionStoreError('session_not_found');
      const executions = (db.prepare(`
        WITH RECURSIVE owned(execution_id, depth) AS (
          SELECT execution_id, 0 FROM executions WHERE canonical_session_id=? OR session_correlation=?
          UNION ALL
          SELECT child.execution_id, parent.depth+1 FROM executions child JOIN owned parent ON child.parent_execution_id=parent.execution_id
        ) SELECT execution_id FROM owned GROUP BY execution_id ORDER BY MAX(depth) DESC
      `).all(id, id) as Row[]).map((row) => String(row.execution_id));
      db.prepare('DELETE FROM conversation_messages WHERE session_id=?').run(
        id,
      );
      db.prepare('DELETE FROM session_turns WHERE session_id=?').run(id);
      for (const executionId of executions) {
        db.prepare(
          'DELETE FROM recall_relations WHERE source_execution_id=? OR target_execution_id=?',
        ).run(executionId, executionId);
      }
      for (const executionId of executions) {
        db.prepare('DELETE FROM executions WHERE execution_id=?').run(
          executionId,
        );
      }
      db.prepare('DELETE FROM sessions WHERE session_id=?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve the primary error */ }
      throw asSessionError(error);
    } finally {
      db.close();
      lock.close();
    }
  }

  #handle(
    id: string,
    _agent: string,
    agentChoice: StoredSessionRecord['agentChoice'],
    initial: StoredSessionRecord | undefined,
    initialCheckpoint: SemanticContextCheckpointV1 | undefined,
    lock: Lock,
  ): WorkerSessionHandle {
    let record = initial;
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
          next.sessionId !== id ||
          JSON.stringify(next.agentChoice) !== JSON.stringify(agentChoice)
        ) throw new SessionStoreError('session_invalid');
        this.#writeSession(next);
        record = structuredClone(next);
      },
      acceptCommitted: (next) => {
        if (
          closed || next.sessionId !== id || !validateStoredSessionRecord(next)
        ) {
          throw new SessionStoreError(
            closed ? 'session_busy' : 'session_invalid',
          );
        }
        record = structuredClone(next);
      },
      installCheckpoint: (next) => {
        if (
          closed || next.sessionId !== id ||
          !validateSemanticContextCheckpoint(next)
        ) {
          throw new SessionStoreError(
            closed ? 'session_busy' : 'session_invalid',
          );
        }
        const db = this.#db();
        try {
          db.prepare('UPDATE sessions SET checkpoint_json=? WHERE session_id=?')
            .run(
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
          db.prepare('UPDATE sessions SET checkpoint_json=? WHERE session_id=?')
            .run(
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

  #writeDiagnosticTx(
    db: DatabaseSync,
    executionId: string,
    diagnostic: FailureDiagnosticV1,
  ): void {
    const bytes = encoder.encode(JSON.stringify(diagnostic));
    const digest = this.#coreStore().writeContent(bytes, db);
    db.prepare(
      `INSERT INTO diagnostics(diagnostic_id, execution_id, content_digest) VALUES(?, ?, ?) ON CONFLICT(diagnostic_id) DO UPDATE SET execution_id=excluded.execution_id, content_digest=excluded.content_digest`,
    )
      .run(diagnostic.diagnosticId, executionId, digest);
  }

  #readDiagnostic(id: string, db: DatabaseSync): FailureDiagnosticV1 {
    const row = db.prepare(
      'SELECT content_digest FROM diagnostics WHERE diagnostic_id=?',
    ).get(id) as Row | undefined;
    if (row === undefined) {
      throw new FailureDiagnosticStoreError('diagnostic_not_found');
    }
    try {
      const value = JSON.parse(
        decoder.decode(
          this.#coreStore().readContent(String(row.content_digest), db),
        ),
      ) as unknown;
      if (!validateFailureDiagnostic(value)) {
        throw new Error('invalid diagnostic');
      }
      return value;
    } catch {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
  }

  recordExecutionFailureDiagnostic(
    executionId: string,
    diagnostic: FailureDiagnosticV1,
  ): void {
    if (!validateFailureDiagnostic(diagnostic)) {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      if (
        db.prepare('SELECT 1 FROM executions WHERE execution_id=?').get(
          executionId,
        ) === undefined
      ) throw new FailureDiagnosticStoreError('diagnostic_not_found');
      this.#writeDiagnosticTx(db, executionId, diagnostic);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      throw error;
    } finally {
      db.close();
    }
  }

  async beginExecution(input: BeginExecutionInput): Promise<void> {
    await this.initialize();
    try {
      if (input.configuration.configurationId !== input.configurationId) {
        throw new HistoryStoreError('history_invalid');
      }
      if (input.canonicalSessionId === undefined) {
        const lock = await acquireLock(
          `${this.#locksPath}/.execution-${input.executionId}.lock`,
        );
        this.#executionLocks.set(input.executionId, lock);
      }
      const authoritySession = input.canonicalSessionId ??
        input.sessionCorrelation;
      const db = this.#db();
      let baseMessageCount = 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        if (input.sessionRecord !== undefined) {
          this.#writeSessionTx(db, input.sessionRecord);
        }
        if (input.canonicalSessionId !== undefined) {
          const session = db.prepare(
            'SELECT message_count, state_revision FROM sessions WHERE session_id=?',
          )
            .get(input.canonicalSessionId) as Row | undefined;
          if (
            session === undefined ||
            Number(session.state_revision) !== input.baseStateRevision
          ) throw new HistoryStoreError('history_invalid');
          baseMessageCount = Number(session.message_count);
        }
        const configBytes = encoder.encode(JSON.stringify(input.configuration));
        const configDigest = this.#coreStore().writeContent(configBytes, db);
        db.prepare(
          `INSERT INTO configurations(configuration_id, created_at, snapshot_content_digest) VALUES(?, ?, ?) ON CONFLICT(configuration_id) DO NOTHING`,
        )
          .run(input.configurationId, input.createdAt, configDigest);
        const storedConfig = db.prepare(
          'SELECT snapshot_content_digest FROM configurations WHERE configuration_id=?',
        )
          .get(input.configurationId) as Row | undefined;
        if (
          storedConfig === undefined ||
          String(storedConfig.snapshot_content_digest) !== configDigest
        ) throw new HistoryStoreError('history_invalid');
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch { /* preserve primary error */ }
        throw error;
      } finally {
        db.close();
      }

      if (
        input.canonicalSessionId === undefined &&
        input.sessionRecord !== undefined
      ) {
        baseMessageCount = input.sessionRecord.transcript.length;
      }
      this.#coreStore().beginExecutionWithAdmission({
        executionId: input.executionId,
        sessionId: authoritySession,
        baseRevision: input.baseStateRevision,
        admission: {
          executionId: input.executionId,
          taskId: input.taskId,
          task: input.task,
          ...(input.canonicalSessionId === undefined
            ? {}
            : { canonicalSessionId: input.canonicalSessionId }),
          sessionCorrelation: input.sessionCorrelation,
          turn: input.turn,
          createdAt: input.createdAt,
          agent: input.agent,
          model: asJson(input.model),
          build: asJson(input.build),
          configurationId: input.configurationId,
          maxSteps: input.maxSteps,
          ...(input.instanceCorrelation === undefined
            ? {}
            : { instanceCorrelation: input.instanceCorrelation }),
          ...(input.workerGeneration === undefined
            ? {}
            : { workerGeneration: input.workerGeneration }),
          ...(input.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: input.parentExecutionId }),
          ...(input.spawnCallId === undefined ? {} : { spawnCallId: input.spawnCallId }),
          baseMessageCount,
        },
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
          command: input.command,
        }),
      };
      const occurrences: HistorySemanticOccurrenceInput[] = [{
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
            projectedContext: recalledExecutionProjectionText(
              input.recalledContext,
            ),
          }),
        });
      }
      this.#coreStore().appendBatch({
        executionId: input.executionId,
        expectedLatestOrdinal: 0,
        occurrences,
        eventCount: 1,
      });
      if (input.recalledContext !== undefined) {
        const relationDb = this.#db();
        try {
          relationDb.prepare(
            'INSERT INTO recall_relations(source_execution_id, target_execution_id, record_id) VALUES(?, ?, ?)',
          )
            .run(
              input.recalledContext.sourceExecutionId,
              input.executionId,
              `${input.executionId}:semantic:2`,
            );
        } finally {
          relationDb.close();
        }
      }
      this.#eventCounts.set(input.executionId, 1);
      this.#baseMessageCountsBySession.set(
        input.sessionCorrelation,
        baseMessageCount,
      );
    } catch (error) {
      this.#baseMessageCountsBySession.delete(input.sessionCorrelation);
      this.#releaseExecutionLock(input.executionId);
      throw asHistoryError(error);
    }
  }

  prepareWorkerObservationForHistory(
    message: WorkerToHostMessage,
  ): WorkerToHostMessage {
    if (message.kind !== 'commit_proposal' && message.kind !== 'turn_failed') {
      return message;
    }
    const baseMessageCount = this.#baseMessageCountsBySession.get(message.correlation.session) ?? 0;
    if (message.kind === 'commit_proposal') {
      return {
        ...message,
        transcript: message.transcript.slice(baseMessageCount),
        ...(message.outcome === undefined
          ? {}
          : { outcome: { ...message.outcome, transcript: [] } }),
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
      const row = db.prepare(
        'SELECT base_message_count FROM executions WHERE execution_id=?',
      ).get(executionId) as Row | undefined;
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
    if (
      payload.kind === 'commit_proposal' && Array.isArray(payload.transcript)
    ) {
      const outcome = payload.outcome as LoopOutcome | undefined;
      const { historyTranscriptBaseApplied: _bounded, ...stored } = payload;
      return asJson({
        ...stored,
        transcript: alreadyBounded
          ? payload.transcript
          : payload.transcript.slice(baseMessageCount),
        ...(outcome === undefined ? {} : { outcome: { ...outcome, transcript: [] } }),
      });
    }
    if (payload.kind === 'turn_failed') {
      const outcome = payload.outcome as LoopOutcome;
      const { historyTranscriptBaseApplied: _bounded, ...stored } = payload;
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
    const observation = payload.observation as {
      kind?: string;
      delta?: ContextModelRequestDelta;
    } | undefined;
    const delta = observation?.delta;
    if (observation?.kind !== 'model_request_delta' || delta === undefined) {
      return { payload: asJson(input.payload), contextItems: [] };
    }
    const contextItems = delta.occurrences.map(
      (occurrence): PreparedContextItem => {
        const descriptor = occurrence.content;
        const stagedKey = `${input.executionId}:${descriptor.digest}`;
        const stored = stagedContent.has(stagedKey) ||
          this.#coreStore().hasContent(
            descriptor.digest,
            descriptor.byteLength,
          );
        let content: Uint8Array | undefined;
        if (!stored) {
          if (
            occurrence.bytesBase64 === undefined
          ) throw new HistoryStoreError('history_invalid');
          try {
            content = Uint8Array.fromBase64(occurrence.bytesBase64);
          } catch {
            throw new HistoryStoreError('history_invalid');
          }
          if (
            content.byteLength !== descriptor.byteLength ||
            exactByteDigest(content) !== descriptor.digest
          ) throw new HistoryStoreError('history_invalid');
          stagedContent.add(stagedKey);
        }
        const { bytesBase64: _bytes, ...metadata } = occurrence;
        return {
          payload: asJson(metadata),
          ...(content === undefined ? {} : { content }),
          contentDigest: descriptor.digest,
        };
      },
    );
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

  appendExecutionEvents(
    inputs: readonly ExecutionEventInput[],
  ): readonly StoredExecutionEvent[] {
    return this.appendExecutionEventsWithSemanticIds(inputs).map(({ event }) => event);
  }

  appendExecutionControlEvents(
    inputs: readonly ExecutionControlEventInput[],
  ): readonly StoredExecutionEvent[] {
    if (inputs.length === 0) return [];
    const allowed = new Set<ExecutionEventInput['kind']>([
      'cancel_requested',
      'cancel_sent',
      'cancel_failed',
      'cancel_received',
      'cancel_escalated',
      'worker_stage_snapshot',
      'acknowledgement_requested',
      'acknowledgement_sent',
      'acknowledgement_failed',
      'turn_settled',
      'post_commit_turn_end',
      'process_cleanup_finished',
    ]);
    const byExecution = new Map<
      string,
      Omit<StoredExecutionEvent, 'ordinal'>[]
    >();
    for (const input of inputs) {
      if (!allowed.has(input.kind) || !this.validateExecutionEvent(input)) {
        throw new HistoryStoreError('history_invalid');
      }
      const event: Omit<StoredExecutionEvent, 'ordinal'> = {
        executionId: input.executionId,
        observedAt: input.observedAt ?? now(),
        direction: input.direction,
        source: input.source,
        kind: input.kind,
        ...(input.workerSequence === undefined ? {} : { workerSequence: input.workerSequence }),
        payload: asJson(input.payload),
      };
      const group = byExecution.get(input.executionId) ?? [];
      group.push(event);
      byExecution.set(input.executionId, group);
    }
    const appended: StoredExecutionEvent[] = [];
    for (const [executionId, events] of byExecution) {
      const stored = this.#coreStore().appendControlEvents(executionId, events);
      appended.push(...stored);
      const last = stored.at(-1);
      if (last !== undefined) this.#eventCounts.set(executionId, last.ordinal);
    }
    return appended;
  }

  appendPostSettlementSemanticEvent(
    input: HistoryPostSettlementSemanticEventInput,
  ): HistoryAppendResult {
    if (
      input.event.executionId.length === 0 ||
      input.event.kind !== 'runtime_event' ||
      input.event.direction !== 'worker_to_host' ||
      input.event.source !== 'worker' ||
      input.event.workerSequence === undefined ||
      !Number.isSafeInteger(input.event.workerSequence) ||
      input.event.workerSequence < 1 ||
      typeof input.event.payload !== 'object' ||
      input.event.payload === null
    ) throw new HistoryStoreError('history_invalid');
    try {
      const result = this.#coreStore().appendPostSettlementSemanticEvent(input);
      this.#eventCounts.set(result.event.executionId, result.event.ordinal);
      return result;
    } catch (error) {
      throw asHistoryError(error);
    }
  }

  appendExecutionEventsWithSemanticIds(
    inputs: readonly ExecutionEventInput[],
  ): readonly HistoryAppendResult[] {
    if (inputs.length === 0) return [];
    try {
      const grouped = new Map<
        string,
        {
          input: ExecutionEventInput;
          event: StoredExecutionEvent;
          contextItems: readonly PreparedContextItem[];
        }[]
      >();
      const semanticIds = new Map<string, string>();
      const stagedContent = new Set<string>();
      for (const input of inputs) {
        if (
          !this.validateExecutionEvent(input) ||
          input.kind === 'execution_settled' ||
          input.kind === 'execution_reconciled'
        ) throw new HistoryStoreError('history_invalid');
        const current = grouped.get(input.executionId)?.at(-1)?.event.ordinal ??
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
        const group = grouped.get(input.executionId) ?? [];
        group.push({ input, event, contextItems: prepared.contextItems });
        grouped.set(input.executionId, group);
      }
      for (const [executionId, records] of grouped) {
        const state = this.#coreStore().readExecution(executionId);
        const textUpdates = new Map<string, HistoryAssistantTextUpdate>();
        const firstEventOrdinals = new Map<string, number | undefined>();
        const semantic = records.flatMap((record) => {
          const { input, contextItems } = record;
          let event = record.event;
          const textEvent = providerTextEvent(event);
          if (textEvent !== undefined) {
            const key: HistoryAssistantTextKey = {
              modelStep: textEvent.modelStep,
              ...(textEvent.lane === undefined ? {} : { lane: textEvent.lane }),
              ...(textEvent.requestOrdinal === undefined
                ? {}
                : { requestOrdinal: textEvent.requestOrdinal }),
            };
            const identity = JSON.stringify([
              key.lane,
              key.modelStep,
              key.requestOrdinal,
            ]);
            const previous = textUpdates.get(identity);
            if (previous === undefined && !firstEventOrdinals.has(identity)) {
              firstEventOrdinals.set(
                identity,
                this.#coreStore().readAssistantTextState(executionId, key)
                  ?.firstEventOrdinal,
              );
            }
            const priorFirst = previous === undefined
              ? firstEventOrdinals.get(identity)
              : previous.kind === 'put'
              ? previous.state.firstEventOrdinal
              : undefined;
            if (textEvent.kind === 'model_result' && priorFirst !== undefined) {
              event = { ...event, firstEventOrdinal: priorFirst };
              record.event = event;
            }
            textUpdates.set(
              identity,
              textEvent.kind === 'model_result' ? { kind: 'remove', key } : {
                kind: 'put',
                state: {
                  key,
                  firstEventOrdinal: priorFirst ?? event.ordinal,
                  event,
                },
              },
            );
            if (textEvent.kind === 'assistant_progress') return [];
          }
          const kind = semanticKindForEvent(input);
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
        const occurrenceId = (index: number): string =>
          `${executionId}:semantic:${state.latestOrdinal + index + 1}`;
        const occurrences: HistorySemanticOccurrenceInput[] = semantic.map(
          (item, index) => {
            const firstContextItem = index - item.contextItemCount;
            return {
              occurrenceId: occurrenceId(index),
              ordinal: state.latestOrdinal + index + 1,
              kind: item.kind,
              observedAt: item.event.observedAt,
              payload: item.payload,
              ...(item.content === undefined ? {} : { content: item.content }),
              ...(item.contentDigest === undefined ? {} : { contentDigest: item.contentDigest }),
              ...(item.contextItemCount === 0 ? {} : {
                relations: Array.from(
                  { length: item.contextItemCount },
                  (_, offset) => ({
                    relation: 'context_item',
                    targetOccurrenceId: occurrenceId(
                      firstContextItem + offset,
                    ),
                  }),
                ),
              }),
            };
          },
        );
        semantic.forEach((item, index) => {
          if (item.isEvent) {
            semanticIds.set(
              `${executionId}:${item.event.ordinal}`,
              occurrenceId(index),
            );
          }
        });
        const count = records.at(-1)!.event.ordinal;
        this.#coreStore().appendBatch({
          executionId,
          expectedLatestOrdinal: state.latestOrdinal,
          occurrences,
          assistantTextUpdates: [...textUpdates.values()],
          eventCount: count,
        });
        this.#eventCounts.set(executionId, count);
      }
      return [...grouped.values()].flat().map(({ event }) => ({
        event,
        ...(semanticIds.get(`${event.executionId}:${event.ordinal}`) ===
            undefined
          ? {}
          : {
            semanticOccurrenceId: semanticIds.get(
              `${event.executionId}:${event.ordinal}`,
            )!,
          }),
      }));
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
        'SELECT event_count FROM executions WHERE execution_id=?',
      ).get(executionId) as Row | undefined;
      if (row === undefined) throw new HistoryStoreError('history_invalid');
      return Number(row.event_count);
    } finally {
      db.close();
    }
  }

  #writeExecutionMessagesTx(
    db: DatabaseSync,
    executionId: string,
    baseMessageCount: number,
    transcript: readonly Message[],
  ): void {
    if (baseMessageCount < 0 || baseMessageCount > transcript.length) {
      throw new HistoryStoreError('history_invalid');
    }
    const insert = db.prepare(
      'INSERT INTO messages(execution_id, message_ordinal, content_digest) VALUES(?, ?, ?) ON CONFLICT(execution_id, message_ordinal) DO NOTHING',
    );
    for (
      let ordinal = baseMessageCount;
      ordinal < transcript.length;
      ordinal += 1
    ) {
      const bytes = encoder.encode(JSON.stringify(transcript[ordinal]));
      const digest = this.#coreStore().writeContent(bytes, db);
      insert.run(executionId, ordinal - baseMessageCount, digest);
      const saved = db.prepare(
        'SELECT content_digest FROM messages WHERE execution_id=? AND message_ordinal=?',
      ).get(executionId, ordinal - baseMessageCount) as Row | undefined;
      if (saved === undefined || String(saved.content_digest) !== digest) {
        throw new HistoryStoreError('history_invalid');
      }
    }
  }

  #appendTerminalTx(
    db: DatabaseSync,
    input: Readonly<{
      executionId: string;
      observedAt: string;
      outcome: StoredExecutionRow['outcome'];
      adoption: StoredExecutionRow['adoption'];
      stopReason?: string;
      diagnostic?: Readonly<{ code: string; stage: string }>;
    }>,
  ): HistoryCommitDelta {
    const row = db.prepare('SELECT * FROM executions WHERE execution_id=?').get(
      input.executionId,
    ) as Row | undefined;
    if (
      row === undefined || row.lifecycle !== 'active' ||
      Number(row.unresolved_mandatory_count) !== 0 ||
      Number(row.latest_ordinal) !== Number(row.occurrence_count) ||
      row.terminal_record_id !== null
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    const eventOrdinal = Number(row.event_count) + 1;
    const latestOrdinal = Number(row.latest_ordinal);
    const textStates = this.#coreStore().listAssistantTextStates(
      input.executionId,
      db,
    );
    const occurrences: HistorySemanticOccurrence[] = [];
    for (const [index, textState] of textStates.entries()) {
      const ordinal = latestOrdinal + index + 1;
      const event = {
        ...textState.event,
        firstEventOrdinal: textState.firstEventOrdinal,
      };
      const occurrenceId = `${input.executionId}:semantic:${ordinal}`;
      const payload = eventValue(event);
      db.prepare(
        `INSERT INTO semantic_records(record_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest) VALUES(?, ?, ?, 'assistant_message', ?, ?, NULL)`,
      )
        .run(
          occurrenceId,
          input.executionId,
          ordinal,
          event.observedAt,
          decoder.decode(encodeHistoryPayload(payload)),
        );
      occurrences.push({
        executionId: input.executionId,
        occurrenceId,
        ordinal,
        kind: 'assistant_message',
        observedAt: event.observedAt,
        payload,
      });
    }
    db.prepare('DELETE FROM assistant_text_states WHERE execution_id=?').run(
      input.executionId,
    );
    const terminalOrdinal = latestOrdinal + textStates.length + 1;
    const terminalRecordId = `${input.executionId}:semantic:${terminalOrdinal}`;
    const terminalEvent: StoredExecutionEvent = {
      executionId: input.executionId,
      ordinal: eventOrdinal,
      observedAt: input.observedAt,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'execution_settled',
      payload: asJson({ outcome: input.outcome, adoption: input.adoption }),
    };
    const terminalPayload = eventValue(terminalEvent);
    db.prepare(
      `INSERT INTO semantic_records(record_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest) VALUES(?, ?, ?, 'host_decision', ?, ?, NULL)`,
    )
      .run(
        terminalRecordId,
        input.executionId,
        terminalOrdinal,
        input.observedAt,
        decoder.decode(encodeHistoryPayload(terminalPayload)),
      );
    occurrences.push({
      executionId: input.executionId,
      occurrenceId: terminalRecordId,
      ordinal: terminalOrdinal,
      kind: 'host_decision',
      observedAt: input.observedAt,
      payload: terminalPayload,
    });
    db.prepare(
      `UPDATE executions SET latest_ordinal=?, occurrence_count=occurrence_count+?, terminal_record_id=?, event_count=? WHERE execution_id=?`,
    )
      .run(
        terminalOrdinal,
        textStates.length + 1,
        terminalRecordId,
        eventOrdinal,
        input.executionId,
      );
    return {
      executionId: input.executionId,
      eventOrdinal,
      settledAt: input.observedAt,
      terminalSemanticOccurrenceId: terminalRecordId,
      outcome: input.outcome,
      ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
      adoption: input.adoption,
      occurrences,
    };
  }

  #captureTx(
    db: DatabaseSync,
    input: CanonicalTurnCommitInput | NonCanonicalExecutionInput,
  ): HistoryCaptureResult {
    const result: HistoryCaptureResult = {};
    if (input.contextManifest !== undefined) {
      db.prepare(
        'INSERT INTO execution_contexts(execution_id, manifest_json) VALUES(?, ?) ON CONFLICT(execution_id) DO UPDATE SET manifest_json=excluded.manifest_json',
      )
        .run(input.executionId, JSON.stringify(input.contextManifest));
      Object.assign(result, { contextDurability: 'complete' as const });
    } else {
      const seen = db.prepare(
        `SELECT 1 FROM semantic_records WHERE execution_id=? AND kind='context_item' LIMIT 1`,
      ).get(input.executionId);
      if (seen !== undefined) {
        Object.assign(result, { contextDurability: 'partial' as const });
      }
    }
    if (
      input.diagnostic !== undefined &&
      validateFailureDiagnostic(input.diagnostic)
    ) {
      try {
        this.#writeDiagnosticTx(db, input.executionId, input.diagnostic);
        Object.assign(result, { diagnosticDurability: 'yes' as const });
      } catch {
        Object.assign(result, { diagnosticDurability: 'failed' as const });
      }
    }
    return result;
  }

  commitCanonicalTurn(input: CanonicalTurnCommitInput): HistoryCaptureResult {
    if (
      input.record.sessionId !== input.canonicalSessionId ||
      input.record.workspaceRoot !== this.workspaceRoot ||
      input.record.stateRevision !== input.baseStateRevision + 1 ||
      input.record.nextTurn !== input.turn + 1 ||
      input.record.agent !== input.agent ||
      input.record.turnExecutions.at(-1)?.executionId !== input.executionId ||
      input.record.turnExecutions.at(-1)?.configurationId !==
        input.configurationId
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    let capture: HistoryCaptureResult = {};
    let commitDelta: HistoryCommitDelta;
    try {
      db.exec('BEGIN IMMEDIATE');
      const execution = db.prepare(
        'SELECT base_message_count, turn_number FROM executions WHERE execution_id=?',
      ).get(input.executionId) as Row | undefined;
      if (
        execution === undefined || Number(execution.turn_number) !== input.turn
      ) throw new HistoryStoreError('history_invalid');
      const baseCount = Number(execution.base_message_count);
      this.#writeExecutionMessagesTx(
        db,
        input.executionId,
        baseCount,
        input.record.transcript,
      );
      capture = this.#captureTx(db, input);
      commitDelta = this.#appendTerminalTx(db, {
        executionId: input.executionId,
        observedAt: input.record.updatedAt,
        outcome: 'completed',
        adoption: 'canonical',
        stopReason: input.outcome.stopReason,
        ...(input.outcome.diagnostic === undefined ? {} : {
          diagnostic: {
            code: input.outcome.diagnostic.code,
            stage: input.outcome.diagnostic.stage,
          },
        }),
      });
      const turnOrdinal = Number(
        (db.prepare(
          'SELECT coalesce(max(turn_ordinal), -1)+1 AS ordinal FROM session_turns WHERE session_id=?',
        ).get(input.canonicalSessionId) as Row).ordinal,
      );
      adoptCanonicalInTransaction(db, {
        executionId: input.executionId,
        sessionId: input.canonicalSessionId,
        baseRevision: input.baseStateRevision,
        turnOrdinal,
        turnNumber: input.turn,
        settledAt: input.record.updatedAt,
        runtimeOutcomeJson: asJson(compactOutcome(input.outcome)),
      });
      this.#writeSessionTx(db, input.record);
      this.#fault?.('before_settlement_commit');
      db.exec('COMMIT');
      const update = {
        ...commitDelta!,
        committedRevision: input.record.stateRevision,
      };
      capture = { ...capture, commitDelta: update };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      throw asHistoryError(error);
    } finally {
      db.close();
      this.#eventCounts.delete(input.executionId);
      this.#baseMessageCountsBySession.delete(input.sessionCorrelation);
      this.#releaseExecutionLock(input.executionId);
    }
    if (input.artifactForCapture !== undefined) {
      try {
        this.#recordArtifactMetadata(input.artifactForCapture(capture));
      } catch { /* derived view cannot gate settlement */ }
    }
    return capture;
  }

  settleNonCanonicalExecution(
    input: NonCanonicalExecutionInput,
  ): HistoryCaptureResult {
    const outcome = severityOutcome(input.outcome);
    const settledAt = now();
    const db = this.#db();
    let capture: HistoryCaptureResult = {};
    let commitDelta: HistoryCommitDelta;
    try {
      db.exec('BEGIN IMMEDIATE');
      const execution = db.prepare(
        'SELECT base_message_count FROM executions WHERE execution_id=?',
      ).get(input.executionId) as Row | undefined;
      if (execution === undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      const baseCount = Number(execution.base_message_count);
      this.#writeExecutionMessagesTx(
        db,
        input.executionId,
        baseCount,
        input.outcome.transcript,
      );
      capture = this.#captureTx(db, input);
      commitDelta = this.#appendTerminalTx(db, {
        executionId: input.executionId,
        observedAt: settledAt,
        outcome,
        adoption: 'non_canonical',
        stopReason: input.outcome.stopReason,
        ...(input.outcome.diagnostic === undefined ? {} : {
          diagnostic: {
            code: input.outcome.diagnostic.code,
            stage: input.outcome.diagnostic.stage,
          },
        }),
      });
      db.prepare(
        "UPDATE executions SET lifecycle='settled', outcome=?, adoption='non_canonical', settled_at=?, runtime_outcome_json=? WHERE execution_id=?",
      )
        .run(
          outcome,
          settledAt,
          JSON.stringify(compactOutcome(input.outcome)),
          input.executionId,
        );
      this.#fault?.('before_settlement_commit');
      db.exec('COMMIT');
      capture = { ...capture, commitDelta: commitDelta! };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      throw asHistoryError(error);
    } finally {
      db.close();
      this.#eventCounts.delete(input.executionId);
      this.#baseMessageCountsBySession.delete(input.sessionCorrelation);
      this.#releaseExecutionLock(input.executionId);
    }
    if (input.artifactForCapture !== undefined) {
      try {
        this.#recordArtifactMetadata(input.artifactForCapture(capture));
      } catch { /* derived view cannot gate settlement */ }
    }
    return capture;
  }

  reconcileExecution(
    input: ReconcileExecutionInput,
  ): HistoryCommitDelta | undefined {
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT * FROM executions WHERE execution_id=?')
        .get(input.executionId) as Row | undefined;
      if (row === undefined) throw new HistoryStoreError('history_invalid');
      if (row.lifecycle === 'settled') {
        db.exec('COMMIT');
        return undefined;
      }
      const settledAt = input.settledAt ?? now();
      const outcome = input.settlement;
      const commitDelta = this.#appendTerminalTx(db, {
        executionId: input.executionId,
        observedAt: settledAt,
        outcome,
        adoption: 'non_canonical',
      });
      db.prepare(
        "UPDATE executions SET lifecycle='settled', outcome=?, adoption='non_canonical', settled_at=?, runtime_outcome_json=NULL WHERE execution_id=?",
      )
        .run(outcome, settledAt, input.executionId);
      db.exec('COMMIT');
      this.#releaseExecutionLock(input.executionId);
      return commitDelta;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      throw asHistoryError(error);
    } finally {
      db.close();
    }
  }

  recordPostCommitObservation(artifact: WorkerExecutionArtifactV1): void {
    if (
      !validateWorkerExecutionArtifact(artifact) || artifact.schemaVersion !== 1
    ) throw new HistoryStoreError('history_invalid');
    this.#recordArtifactMetadata(artifact);
  }

  #recordArtifactMetadata(artifact: WorkerExecutionArtifactV1): void {
    const payload = asJson({
      kind: 'execution_metadata',
      storeResult: artifact.storeResult,
      protocolTrace: artifact.protocolTrace,
      ...(artifact.childCleanup === undefined ? {} : { childCleanup: artifact.childCleanup }),
      ...(artifact.storeError === undefined ? {} : { storeError: artifact.storeError }),
    });
    const core = this.#coreStore();
    const previous = core.listOccurrences(artifact.executionId).findLast((
      record,
    ) =>
      record.kind === 'host_decision' &&
      (record.payload as Record<string, unknown>).kind === 'execution_metadata'
    );
    if (
      previous !== undefined &&
      decoder.decode(encodeHistoryPayload(previous.payload)) ===
        decoder.decode(encodeHistoryPayload(payload))
    ) return;
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare(
        'SELECT latest_ordinal FROM executions WHERE execution_id=?',
      ).get(
        artifact.executionId,
      ) as Row | undefined;
      if (row === undefined) throw new HistoryStoreError('history_invalid');
      const ordinal = Number(row.latest_ordinal) + 1;
      db.prepare(`INSERT INTO semantic_records(
        record_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest
      ) VALUES(?, ?, ?, 'host_decision', ?, ?, NULL)`).run(
        `metadata:${crypto.randomUUID()}`,
        artifact.executionId,
        ordinal,
        now(),
        decoder.decode(encodeHistoryPayload(payload)),
      );
      db.prepare(
        `UPDATE executions SET latest_ordinal=?, occurrence_count=occurrence_count+1
        WHERE execution_id=?`,
      ).run(ordinal, artifact.executionId);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      throw asHistoryError(error);
    } finally {
      db.close();
    }
  }

  #readConfiguration(
    db: DatabaseSync,
    configurationId: string,
  ): WorkerConfigurationSnapshot {
    const row = db.prepare(
      'SELECT snapshot_content_digest FROM configurations WHERE configuration_id=?',
    ).get(configurationId) as Row | undefined;
    if (row === undefined) throw new HistoryStoreError('history_invalid');
    return parseJson<WorkerConfigurationSnapshot>(
      decoder.decode(
        this.#coreStore().readContent(String(row.snapshot_content_digest), db),
      ),
    );
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
        SELECT e.*,
          EXISTS(SELECT 1 FROM semantic_records s WHERE s.execution_id=e.execution_id AND s.kind='model_request') AS has_context_observation,
          (SELECT diagnostic_id FROM diagnostics d WHERE d.execution_id=e.execution_id ORDER BY rowid DESC LIMIT 1) AS diagnostic_id,
          EXISTS(SELECT 1 FROM execution_contexts c WHERE c.execution_id=e.execution_id) AS has_context_manifest
        FROM executions e ${where}
        ORDER BY e.turn_number, e.created_at, e.execution_id
      `).all(...values) as Row[];
      return rows.map((row) => {
        const executionId = String(row.execution_id);
        const outcomeJson = row.runtime_outcome_json === null
          ? undefined
          : parseJson<LoopOutcome>(row.runtime_outcome_json);
        let transcript: Message[] | undefined;
        if (outcomeJson !== undefined && includeTranscript) {
          const messageRows = row.adoption === 'canonical'
            ? db.prepare(
              `SELECT m.content_digest FROM conversation_messages c JOIN messages m ON m.execution_id=c.execution_id AND m.message_ordinal=c.execution_message_ordinal WHERE c.session_id=? AND c.turn_number<=? ORDER BY c.message_ordinal`,
            )
              .all(
                String(row.canonical_session_id),
                Number(row.turn_number),
              ) as Row[]
            : db.prepare(
              'SELECT content_digest FROM messages WHERE execution_id=? ORDER BY message_ordinal',
            ).all(executionId) as Row[];
          transcript = messageRows.map((message) =>
            JSON.parse(
              decoder.decode(
                this.#coreStore().readContent(
                  String(message.content_digest),
                  db,
                ),
              ),
            ) as Message
          );
        }
        const diagnosticId = row.diagnostic_id === null ? undefined : String(row.diagnostic_id);
        const configurationId = row.configuration_id === null
          ? undefined
          : String(row.configuration_id);
        if (configurationId === undefined) {
          throw new HistoryStoreError('history_invalid');
        }
        const runtimeOutcome = outcomeJson === undefined
          ? undefined
          : includeTranscript && transcript !== undefined
          ? { ...outcomeJson, transcript }
          : outcomeJson;
        const contextCapture = row.lifecycle === 'active'
          ? 'none'
          : Number(row.has_context_manifest) === 1
          ? 'complete'
          : Number(row.has_context_observation) === 1
          ? 'partial'
          : 'none';
        const model = parseJson<ModelSelection>(row.model_json);
        const build = parseJson<BuildManifestV1>(row.build_json);
        if (!isStoredModelSelection(model)) {
          throw new HistoryStoreError('history_invalid');
        }
        return {
          executionId,
          taskId: String(row.task_id),
          task: decoder.decode(
            this.#coreStore().readContent(String(row.task_content_digest), db),
          ),
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
          ...(runtimeOutcome === undefined ? {} : { outcomeJson: runtimeOutcome }),
          adoption: String(row.adoption) as StoredExecutionRow['adoption'],
          baseRevision: Number(row.base_revision),
          ...(row.adoption === 'canonical'
            ? { committedRevision: Number(row.base_revision) + 1 }
            : {}),
          agent: String(row.agent_name),
          model,
          build,
          configurationId,
          configuration: this.#readConfiguration(db, configurationId),
          maxSteps: Number(row.max_steps),
          ...(row.instance_correlation === null
            ? {}
            : { instanceCorrelation: String(row.instance_correlation) }),
          ...(row.worker_generation === null
            ? {}
            : { workerGeneration: String(row.worker_generation) }),
          acknowledgement: this.#acknowledgement(executionId),
          generationAvailability: this.#generationAvailability(executionId),
          diagnosticCapture: diagnosticId === undefined ? 'none' : 'yes',
          ...(diagnosticId === undefined ? {} : { diagnosticId }),
          artifactCapture: row.lifecycle === 'settled' ? 'yes' : 'none',
          contextCapture,
        };
      });
    } finally {
      if (snapshotDb === undefined) db.close();
    }
  }

  #acknowledgement(executionId: string): StoredExecutionRow['acknowledgement'] {
    const event = this.#coreStore().listControlEvents(executionId).findLast((
      item,
    ) =>
      item.kind === 'acknowledgement_sent' ||
      item.kind === 'acknowledgement_failed'
    );
    if (event === undefined) return 'not_sent';
    if (event.kind === 'acknowledgement_failed') return 'delivery_failed';
    const accepted = (event.payload as Record<string, unknown>).accepted;
    return accepted === true ? 'accepted_sent' : 'rejected_sent';
  }

  #generationAvailability(executionId: string): string {
    const events = this.#coreStore().listControlEvents(executionId);
    const turnEnd = events.findLast((event) => event.kind === 'post_commit_turn_end');
    if (turnEnd !== undefined) {
      const value = turnEnd.payload as Record<string, unknown>;
      return value.generationUnavailable === true ? 'unavailable' : 'available';
    }
    const cleanup = events.findLast((event) => event.kind === 'process_cleanup_finished');
    return cleanup === undefined
      ? 'unknown'
      : (cleanup.payload as Record<string, unknown>).result === 'complete'
      ? 'available'
      : 'unavailable';
  }

  #hasContextManifest(db: DatabaseSync, executionId: string): boolean {
    return db.prepare('SELECT 1 FROM execution_contexts WHERE execution_id=?')
      .get(executionId) !== undefined;
  }

  listExecutions(): readonly StoredExecutionRow[] {
    return this.#executionRows();
  }

  listExecutionsForSession(sessionId: string): readonly StoredExecutionRow[] {
    return this.#executionRows('WHERE e.session_correlation=?', [sessionId]);
  }

  readSessionConversationFacts(
    sessionId: string,
  ): readonly StoredSessionConversationExecution[] {
    const db = this.#db();
    try {
      db.exec('BEGIN');
      const executions = this.#executionRows(
        'WHERE e.session_correlation=?',
        [sessionId],
        false,
        db,
      );
      const facts = executions.map((execution) => ({
        execution,
        occurrences: this.#coreStore().listOccurrences(
          execution.executionId,
          db,
        ),
        assistantTextStates: this.#coreStore().listAssistantTextStates(
          execution.executionId,
          db,
        ),
      }));
      db.exec('COMMIT');
      return facts;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      throw error;
    } finally {
      db.close();
    }
  }

  readSessionHistory(
    sessionId: string,
  ): readonly StoredSessionHistoryExecution[] {
    const db = this.#db();
    try {
      db.exec('BEGIN');
      const executions = this.#executionRows(
        'WHERE e.session_correlation=?',
        [sessionId],
        false,
        db,
      );
      const timeline = executions.map(
        (execution): StoredSessionHistoryExecution => {
          const rows = db.prepare(
            'SELECT content_digest FROM messages WHERE execution_id=? ORDER BY message_ordinal',
          ).all(execution.executionId) as Row[];
          const messages = rows.map((row) =>
            JSON.parse(
              decoder.decode(
                this.#coreStore().readContent(String(row.content_digest), db),
              ),
            ) as Message
          );
          const thinkingByStep = new Map<
            string,
            Extract<AgentEvent, { kind: 'assistant_thinking' }>
          >();
          for (
            const occurrence of this.#coreStore().listOccurrences(
              execution.executionId,
              db,
            )
          ) {
            if (
              occurrence.kind !== 'assistant_message' ||
              typeof occurrence.payload !== 'object' ||
              occurrence.payload === null || Array.isArray(occurrence.payload)
            ) continue;
            const event = (occurrence.payload as Record<string, JsonValue>).event;
            if (
              typeof event !== 'object' || event === null ||
              Array.isArray(event)
            ) continue;
            const value = event as unknown as StoredExecutionEvent;
            if (value.kind !== 'runtime_event') continue;
            const payload = value.payload as unknown as Record<string, unknown>;
            const runtimeEvent = payload.event as
              | Record<string, unknown>
              | undefined;
            const candidate = runtimeEvent?.kind === 'agent_event' ? runtimeEvent.event : undefined;
            if (
              typeof candidate === 'object' && candidate !== null &&
              (candidate as { kind?: string }).kind === 'assistant_thinking'
            ) {
              const item = candidate as Extract<
                AgentEvent,
                { kind: 'assistant_thinking' }
              >;
              thinkingByStep.set(`${item.turn}:${item.modelStep}`, item);
            }
          }
          return {
            execution,
            messages,
            thinking: [...thinkingByStep.values()],
          };
        },
      );
      db.exec('COMMIT');
      return timeline;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
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

  readExecutionMetadata(id: string): StoredExecutionRow {
    const row = this.#executionRows('WHERE e.execution_id=?', [id], false)[0];
    if (row === undefined) throw new HistoryStoreError('history_invalid');
    return row;
  }

  readExecutionRequestCount(id: string): number {
    return this.listExecutionEvents(id).filter((event) => event.kind === 'provider_request_start')
      .length;
  }

  listExecutionEvents(id: string): readonly StoredExecutionEvent[] {
    this.readExecutionMetadata(id);
    return this.#listExecutionEvents(id, true);
  }

  listSemanticOccurrences(id: string): readonly HistorySemanticOccurrence[] {
    this.readExecutionMetadata(id);
    return this.#coreStore().listOccurrences(id);
  }

  listAssistantTextStates(
    id: string,
  ): readonly import('./history_semantic_model.ts').HistoryAssistantTextState[] {
    this.readExecutionMetadata(id);
    return this.#coreStore().listAssistantTextStates(id);
  }

  #listExecutionEvents(
    id: string,
    hydrateContext: boolean,
  ): readonly StoredExecutionEvent[] {
    const occurrences = this.#coreStore().listOccurrences(id);
    const contextItems = new Map<string, ContextOccurrenceInput>();
    const contentByDigest = new Map<string, string>();
    if (hydrateContext) {
      for (const occurrence of occurrences) {
        if (
          occurrence.kind !== 'context_item' ||
          occurrence.contentDigest === undefined ||
          typeof occurrence.payload !== 'object' ||
          occurrence.payload === null || Array.isArray(occurrence.payload)
        ) continue;
        const metadata = occurrence.payload as unknown as Omit<
          ContextOccurrenceInput,
          'bytesBase64'
        >;
        if (typeof metadata.occurrenceId !== 'string') continue;
        let bytesBase64 = contentByDigest.get(occurrence.contentDigest);
        if (bytesBase64 === undefined) {
          bytesBase64 = this.#coreStore().readContent(occurrence.contentDigest)
            .toBase64();
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
      if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        return [];
      }
      const hydrated = structuredClone(
        event,
      ) as unknown as StoredExecutionEvent;
      if (
        hydrated.kind === 'context_observation' && hydrateContext &&
        contextItems.size > 0
      ) {
        const payload = hydrated.payload as unknown as Record<string, unknown>;
        const observation = payload.observation as {
          kind?: string;
          delta?: { occurrences?: unknown[] };
        } | undefined;
        if (
          observation?.kind === 'model_request_delta' &&
          Array.isArray(observation.delta?.occurrences)
        ) {
          observation.delta.occurrences = observation.delta.occurrences.map(
            (item) => {
              if (
                typeof item !== 'object' || item === null || Array.isArray(item)
              ) return item;
              const occurrenceId = (item as { occurrenceId?: unknown }).occurrenceId;
              return typeof occurrenceId === 'string' &&
                  contextItems.has(occurrenceId)
                ? structuredClone(contextItems.get(occurrenceId)!)
                : item;
            },
          );
        }
      }
      if (
        hydrated.kind === 'runtime_event' &&
        typeof hydrated.payload === 'object' && hydrated.payload !== null &&
        !Array.isArray(hydrated.payload)
      ) {
        const payload = hydrated.payload as unknown as Record<string, unknown>;
        const outcome = payload.outcome;
        if (
          payload.kind === 'commit_proposal' &&
          Array.isArray(payload.transcript) && typeof outcome === 'object' &&
          outcome !== null && !Array.isArray(outcome) &&
          Array.isArray((outcome as Record<string, unknown>).transcript) &&
          ((outcome as Record<string, unknown>).transcript as unknown[])
              .length === 0
        ) {
          (outcome as Record<string, unknown>).transcript = structuredClone(
            payload.transcript,
          );
        }
      }
      return [hydrated];
    });
    const controlEvents = this.#coreStore().listControlEvents(id);
    const partial = this.#coreStore().listAssistantTextStates(id).map((
      state,
    ) => ({
      ...state.event,
      firstEventOrdinal: state.firstEventOrdinal,
    }));
    return [...semantic, ...controlEvents, ...partial].sort((left, right) =>
      (left.firstEventOrdinal ?? left.ordinal) -
        (right.firstEventOrdinal ?? right.ordinal) ||
      left.ordinal - right.ordinal
    );
  }

  listExecutionEffects(id: string): readonly StoredExecutionEffect[] {
    const execution = this.readExecutionMetadata(id);
    const effects = new Map<string, StoredExecutionEffect>();
    for (const event of this.#listExecutionEvents(id, false)) {
      if (
        event.kind !== 'effect_observation' && event.kind !== 'runtime_event'
      ) continue;
      const payload = event.payload as Record<string, unknown>;
      const providerObservation = payload.kind === 'provider_observation' &&
          typeof payload.observation === 'object' &&
          payload.observation !== null
        ? payload.observation as Record<string, unknown>
        : undefined;
      const providerEvent = providerObservation?.kind === 'runtime_event' &&
          typeof providerObservation.event === 'object' &&
          providerObservation.event !== null
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
        ...(completed &&
            (value.outcome === 'success' || value.outcome === 'error')
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
    this.readExecutionMetadata(executionId);
    const relations: ExecutionContextRelation[] = [];
    const db = this.#db();
    try {
      const row = db.prepare(
        'SELECT manifest_json FROM execution_contexts WHERE execution_id=?',
      )
        .get(executionId) as Row | undefined;
      if (row !== undefined) {
        const manifest = parseJson<{
          externalRelations?: readonly Omit<
            ExecutionContextRelation,
            'ordinal'
          >[];
        }>(row.manifest_json);
        for (const relation of manifest.externalRelations ?? []) {
          relations.push({ ordinal: relations.length + 1, ...relation });
        }
      }
    } finally {
      db.close();
    }

    const requests: ContextModelRequestRecord[] = [];
    const occurrences = new Map<string, ContextOccurrenceInput>();
    const sequences = new Map<string, string[]>();
    for (const event of this.listExecutionEvents(executionId)) {
      if (event.kind !== 'context_observation') continue;
      const payload = event.payload as unknown as {
        observation?: { kind?: string; delta?: ContextModelRequestDelta };
      };
      const delta = payload.observation?.delta;
      if (
        payload.observation?.kind !== 'model_request_delta' ||
        delta === undefined
      ) continue;
      for (const occurrence of delta.occurrences) {
        occurrences.set(occurrence.occurrenceId, occurrence);
      }
      const sequenceKey = `${delta.lane}:${delta.purpose}`;
      const sequence = [...(sequences.get(sequenceKey) ?? [])];
      for (const splice of delta.splices) {
        sequence.splice(
          splice.start,
          splice.deleteCount,
          ...splice.insertions.map((item) => item.occurrenceId),
        );
      }
      sequences.set(sequenceKey, sequence);
      const items = sequence.map((occurrenceId, ordinal) => {
        const occurrence = occurrences.get(occurrenceId);
        if (occurrence === undefined) {
          throw new HistoryStoreError('history_invalid');
        }
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
      const decoded = items.map((item) => {
        if (item.bytesBase64 === undefined) return undefined;
        try {
          return decoder.decode(Uint8Array.fromBase64(item.bytesBase64));
        } catch {
          throw new HistoryStoreError('history_invalid');
        }
      });
      const systemIndex = items.findIndex((item) => item.kind === 'system');
      const request = delta.purpose === 'user_turn'
        ? {
          ...(systemIndex < 0 || decoded[systemIndex] === undefined
            ? {}
            : { systemInstruction: decoded[systemIndex] }),
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
    // Request deltas are the durable model-context source. Startup configuration is referenced
    // through configuration_id rather than copied into a second context snapshot.
    return { relations, requests };
  }

  readExecutionRequest(
    executionId: string,
    requestOrdinal: number,
  ): ContextModelRequestRecord {
    const request = this.listExecutionContext(executionId).requests.find((
      item,
    ) => item.requestOrdinal === requestOrdinal);
    if (request === undefined) throw new HistoryStoreError('history_invalid');
    return request;
  }

  readExecutionRequestFacts(
    executionId: string,
    requestOrdinal: number,
  ): readonly StoredExecutionEvent[] {
    const events = this.listExecutionEvents(executionId);
    const providerOrdinals = new Set(events.flatMap((event) => {
      if (event.kind !== 'provider_request_start') return [];
      const payload = event.payload as unknown as {
        observation?: {
          request?: { ordinal?: number; contextRequestOrdinal?: number };
        };
      };
      const request = payload.observation?.request;
      return request?.contextRequestOrdinal === requestOrdinal &&
          request.ordinal !== undefined
        ? [request.ordinal]
        : [];
    }));
    return events.filter((event) => {
      if (!event.kind.startsWith('provider_')) return false;
      const payload = event.payload as unknown as {
        observation?: {
          kind?: string;
          requestOrdinal?: number;
          request?: { ordinal?: number };
        };
      };
      const ordinal = payload.observation?.kind === 'request_start'
        ? payload.observation.request?.ordinal
        : payload.observation?.requestOrdinal;
      return ordinal !== undefined && providerOrdinals.has(ordinal);
    });
  }

  listRecallRelations(targetExecutionId: string): readonly {
    sourceExecutionId: string;
    targetExecutionId: string;
    occurrenceId: string;
  }[] {
    const db = this.#db();
    try {
      return (db.prepare(
        'SELECT * FROM recall_relations WHERE target_execution_id=? ORDER BY rowid',
      )
        .all(targetExecutionId) as Row[]).map((row) => ({
          sourceExecutionId: String(row.source_execution_id),
          targetExecutionId: String(row.target_execution_id),
          occurrenceId: String(row.record_id),
        }));
    } finally {
      db.close();
    }
  }

  #deriveArtifact(
    executionId: string,
    snapshotDb?: DatabaseSync,
  ): StoredWorkerExecutionArtifact {
    const execution = this.#executionRows(
      'WHERE e.execution_id=?',
      [executionId],
      false,
      snapshotDb,
    )[0];
    if (
      execution === undefined || execution.lifecycle !== 'settled' ||
      execution.settledAt === undefined
    ) {
      throw new HistoryStoreError('history_invalid');
    }
    const admission = this.#coreStore().listOccurrences(executionId, snapshotDb)
      .find((occurrence) => occurrence.kind === 'execution_admission');
    const admissionPayload = admission?.payload as
      | Record<string, unknown>
      | undefined;
    const admittedEvent = admissionPayload?.event as
      | Record<string, unknown>
      | undefined;
    const admittedEventPayload = admittedEvent?.payload as
      | Record<string, unknown>
      | undefined;
    const command = admittedEventPayload?.command;
    if (typeof command !== 'string' || command.length === 0) {
      throw new HistoryStoreError('history_invalid');
    }
    const instanceCorrelation = execution.instanceCorrelation;
    const workerGeneration = execution.workerGeneration;
    if (instanceCorrelation === undefined || workerGeneration === undefined) {
      throw new HistoryStoreError('history_invalid');
    }

    const metadata = this.#coreStore().listOccurrences(executionId, snapshotDb)
      .findLast((record) =>
        record.kind === 'host_decision' &&
        (record.payload as Record<string, unknown>).kind ===
          'execution_metadata'
      )?.payload as Record<string, unknown> | undefined;
    const controls = this.#coreStore().listControlEvents(executionId);
    const turnSettled = controls.findLast((event) => event.kind === 'turn_settled') !== undefined;
    const turnEnd = controls.findLast((event) => event.kind === 'post_commit_turn_end');
    const cleanup = controls.findLast((event) => event.kind === 'process_cleanup_finished');
    const acknowledgement = execution
      .acknowledgement as WorkerExecutionArtifactV1['acknowledgement'];
    let settlement:
      | WorkerExecutionArtifactV1['settlement']
      | 'interrupted'
      | 'unknown';
    if (
      execution.outcome === 'interrupted' || execution.outcome === 'unknown'
    ) settlement = execution.outcome;
    else if (execution.adoption !== 'canonical') settlement = 'uncommitted';
    else if (
      (cleanup !== undefined &&
        (cleanup.payload as Record<string, unknown>).result === 'failed') ||
      (turnEnd !== undefined &&
        (turnEnd.payload as Record<string, unknown>).generationUnavailable ===
          true)
    ) {
      settlement = 'committed_generation_unavailable';
    } else if (
      acknowledgement === 'accepted_sent' && turnSettled &&
      cleanup !== undefined &&
      (cleanup.payload as Record<string, unknown>).result === 'complete' &&
      turnEnd !== undefined &&
      (turnEnd.payload as Record<string, unknown>).committed === true
    ) {
      settlement = 'committed';
    } else settlement = 'committed_observation_pending';

    const db = snapshotDb ?? this.#db();
    try {
      const recallRow = db.prepare(
        "SELECT payload_json FROM semantic_records WHERE execution_id=? AND kind='recall_projection' ORDER BY ordinal LIMIT 1",
      )
        .get(executionId) as Row | undefined;
      let recall: WorkerExecutionArtifactV1['recall'];
      if (recallRow !== undefined) {
        const payload = parseJson<
          {
            context?: RecalledExecutionContext;
            sourceExecutionId?: string;
            projectedContext?: string;
          }
        >(recallRow.payload_json);
        const sourceExecutionId = payload.sourceExecutionId ??
          payload.context?.sourceExecutionId;
        if (
          typeof payload.projectedContext === 'string' &&
          sourceExecutionId !== undefined
        ) {
          recall = {
            schemaVersion: 1,
            sourceExecutionId,
            projectedContext: payload.projectedContext,
          };
        }
      }
      const hasManifest = db.prepare('SELECT 1 FROM execution_contexts WHERE execution_id=?').get(
        executionId,
      ) !== undefined;
      const hasContext = db.prepare(
        "SELECT 1 FROM semantic_records WHERE execution_id=? AND kind IN ('context_item','model_request') LIMIT 1",
      )
        .get(executionId) !== undefined;
      const artifact: WorkerExecutionArtifactV1 = {
        schemaVersion: 1,
        executionId,
        createdAt: execution.createdAt,
        settledAt: execution.settledAt,
        sessionId: execution.sessionCorrelation,
        turn: execution.turn,
        agent: execution.agent,
        instanceCorrelation,
        workerGeneration,
        build: execution.build,
        configurationId: execution.configurationId,
        configuration: execution.configuration,
        model: execution.model,
        maxSteps: execution.maxSteps,
        command: {
          kind: 'turn',
          correlation: {
            session: execution.sessionCorrelation,
            instanceCorrelation,
            workerGeneration,
            baseStateRevision: execution.baseRevision,
            command,
          },
          task: execution.task,
        },
        baseStateRevision: execution.baseRevision,
        ...(execution.adoption === 'canonical'
          ? { committedStateRevision: execution.baseRevision + 1 }
          : {}),
        protocolTrace: (metadata?.protocolTrace ?? []) as WorkerExecutionArtifactV1[
          'protocolTrace'
        ],
        ...(metadata?.childCleanup === undefined ? {} : {
          childCleanup: metadata
            .childCleanup as unknown as WorkerExecutionArtifactV1[
              'childCleanup'
            ],
        }),
        ...(metadata?.storeError === undefined ? {} : {
          storeError: metadata
            .storeError as WorkerExecutionArtifactV1['storeError'],
        }),
        storeResult: (metadata?.storeResult ?? 'committed') as WorkerExecutionArtifactV1[
          'storeResult'
        ],
        acknowledgement,
        settlement,
        lifecycle: 'settled',
        normalizedOutcome: execution.outcome,
        adoption: execution.adoption,
        ...(execution.outcomeJson === undefined
          ? {}
          : { outcome: workerExecutionOutcome(execution.outcomeJson) }),
        contextCapture: hasManifest ? 'complete' : hasContext ? 'partial' : 'none',
        ...(recall === undefined ? {} : { recall }),
        effectCommitRelation: 'not_transactional',
        automaticReplay: false,
      };
      if (!validateWorkerExecutionArtifact(artifact)) {
        throw new HistoryStoreError('history_invalid');
      }
      return artifact;
    } finally {
      if (snapshotDb === undefined) db.close();
    }
  }

  *streamHumanHistoryExport(
    sessionId: string,
  ): Iterable<HumanHistoryExportRecordV1> {
    const db = this.#db();
    try {
      db.exec('BEGIN');
      const session = db.prepare('SELECT * FROM sessions WHERE session_id=?')
        .get(sessionId) as Row | undefined;
      if (session === undefined) throw new HistoryStoreError('history_invalid');
      const executions = this.#executionRows(
        'WHERE e.session_correlation=?',
        [sessionId],
        false,
        db,
      );
      const childExecutions = this.#executionRows(
        'WHERE e.parent_execution_id IN (SELECT execution_id FROM executions WHERE session_correlation=?)',
        [sessionId],
        false,
        db,
      );
      const executionIds = [
        ...new Set(
          [...executions, ...childExecutions].map((item) => item.executionId),
        ),
      ];
      const emittedContents = new Set<string>();
      const record = (
        kind: string,
        identity: string,
        value: unknown,
      ): HumanHistoryExportRecordV1 => ({
        schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
        kind,
        identity,
        value: asJson(value),
      });
      const emitContent = (
        digest: string,
      ): HumanHistoryExportRecordV1 | undefined => {
        if (emittedContents.has(digest)) return undefined;
        const bytes = this.#coreStore().readContent(digest, db);
        emittedContents.add(digest);
        return record('immutable_content', digest, {
          contentDigest: digest,
          byteLength: bytes.byteLength,
          contentBase64: bytes.toBase64(),
        });
      };

      yield record('header', sessionId, {
        historySchemaVersion: 1,
        sessionId,
        stateRevision: Number(session.state_revision),
        tail: executions.at(-1) === undefined
          ? null
          : { executionId: executions.at(-1)!.executionId },
      });
      yield record('session', sessionId, {
        sessionId,
        workspaceRoot: String(session.workspace_root),
        agentChoice: parseJson<JsonValue>(session.agent_choice_json),
        createdAt: String(session.created_at),
        updatedAt: String(session.updated_at),
        title: session.title === null ? null : String(session.title),
        stateRevision: Number(session.state_revision),
        nextTurn: Number(session.next_turn),
        activeModel: parseJson<JsonValue>(session.active_model_json),
        messageCount: Number(session.message_count),
        modelChangeCount: Number(session.model_change_count),
        turnCount: Number(session.turn_count),
      });
      for (
        const row of db.prepare(`
        SELECT c.message_ordinal, c.turn_number, c.execution_id, m.content_digest
        FROM conversation_messages c JOIN messages m
          ON m.execution_id=c.execution_id AND m.message_ordinal=c.execution_message_ordinal
        WHERE c.session_id=? ORDER BY c.message_ordinal
      `).iterate(sessionId) as Iterable<Row>
      ) {
        const bytes = this.#coreStore().readContent(
          String(row.content_digest),
          db,
        );
        yield record(
          'session_message',
          `${sessionId}:message:${Number(row.message_ordinal)}`,
          {
            ordinal: Number(row.message_ordinal),
            turn: Number(row.turn_number),
            executionId: String(row.execution_id),
            message: JSON.parse(decoder.decode(bytes)) as JsonValue,
          },
        );
        const content = emitContent(String(row.content_digest));
        if (content !== undefined) yield content;
      }
      for (
        const row of db.prepare(
          'SELECT * FROM session_model_changes WHERE session_id=? ORDER BY change_ordinal',
        ).iterate(sessionId) as Iterable<Row>
      ) {
        yield record(
          'session_model_change',
          `${sessionId}:model:${Number(row.change_ordinal)}`,
          {
            ordinal: Number(row.change_ordinal),
            effectiveFromTurn: Number(row.effective_from_turn),
            changedAt: String(row.changed_at),
            selection: parseJson<JsonValue>(row.selection_json),
          },
        );
      }
      for (
        const row of db.prepare(`
        SELECT t.*, e.model_json, e.build_json, e.configuration_id, e.agent_name
        FROM session_turns t JOIN executions e USING(execution_id)
        WHERE t.session_id=? ORDER BY t.turn_ordinal
      `).iterate(sessionId) as Iterable<Row>
      ) {
        yield record(
          'session_turn',
          `${sessionId}:turn:${Number(row.turn_number)}`,
          {
            ordinal: Number(row.turn_ordinal),
            turn: Number(row.turn_number),
            model: parseJson<JsonValue>(row.model_json),
            build: parseJson<JsonValue>(row.build_json),
            configurationId: String(row.configuration_id),
            agent: String(row.agent_name),
            executionId: String(row.execution_id),
          },
        );
      }
      const exportedConfigurationIds = new Set(
        [...executions, ...childExecutions].map((execution) => execution.configurationId),
      );
      for (const configurationId of exportedConfigurationIds) {
        const row = db.prepare(
          'SELECT snapshot_content_digest FROM configurations WHERE configuration_id=?',
        ).get(configurationId) as Row | undefined;
        if (row === undefined) continue;
        const digest = String(row.snapshot_content_digest);
        yield record('configuration', configurationId, {
          configurationId,
          contentDigest: digest,
        });
        const content = emitContent(digest);
        if (content !== undefined) yield content;
      }
      for (const executionId of executionIds) {
        const execution = this.#executionRows(
          'WHERE e.execution_id=?',
          [executionId],
          false,
          db,
        )[0];
        if (execution === undefined) continue;
        yield record('execution', executionId, execution);
        const taskDigestRow = db.prepare(
          'SELECT task_content_digest FROM executions WHERE execution_id=?',
        ).get(executionId) as Row;
        const taskContent = emitContent(
          String(taskDigestRow.task_content_digest),
        );
        if (taskContent !== undefined) yield taskContent;
        const configDigest = db.prepare(
          'SELECT snapshot_content_digest FROM configurations WHERE configuration_id=?',
        ).get(execution.configurationId) as Row | undefined;
        if (configDigest !== undefined) {
          const content = emitContent(
            String(configDigest.snapshot_content_digest),
          );
          if (content !== undefined) yield content;
        }
        for (
          const row of db.prepare(
            'SELECT content_digest FROM messages WHERE execution_id=? ORDER BY message_ordinal',
          ).iterate(executionId) as Iterable<Row>
        ) {
          const content = emitContent(String(row.content_digest));
          if (content !== undefined) yield content;
        }
        for (
          const occurrence of this.#coreStore().listOccurrences(executionId, db)
        ) {
          if (occurrence.contentDigest !== undefined) {
            const content = emitContent(occurrence.contentDigest);
            if (content !== undefined) yield content;
          }
          yield record(
            'semantic_occurrence',
            occurrence.occurrenceId,
            occurrence,
          );
        }
        for (
          const state of this.#coreStore().listAssistantTextStates(
            executionId,
            db,
          )
        ) {
          yield record(
            'assistant_text_state',
            `${executionId}:assistant-text:${
              JSON.stringify([
                state.key.lane,
                state.key.modelStep,
                state.key.requestOrdinal,
              ])
            }`,
            state,
          );
        }
        for (
          const row of db.prepare(`
          SELECT r.* FROM semantic_relations r JOIN semantic_records s ON s.record_id=r.record_id
          WHERE s.execution_id=? ORDER BY s.ordinal, r.relation_ordinal
        `).iterate(executionId) as Iterable<Row>
        ) {
          yield record(
            'semantic_relation',
            `${String(row.record_id)}:${Number(row.relation_ordinal)}`,
            {
              recordId: String(row.record_id),
              relationOrdinal: Number(row.relation_ordinal),
              relation: String(row.relation),
              targetRecordId: String(row.target_record_id),
              mandatory: Number(row.mandatory) === 1,
              resolved: Number(row.resolved) === 1,
            },
          );
        }
        const context = db.prepare(
          'SELECT manifest_json FROM execution_contexts WHERE execution_id=?',
        ).get(executionId) as Row | undefined;
        if (context !== undefined) {
          yield record(
            'execution_context_manifest',
            executionId,
            parseJson<JsonValue>(context.manifest_json),
          );
        }
        for (
          const row of db.prepare(
            'SELECT * FROM recall_relations WHERE target_execution_id=? ORDER BY rowid',
          ).iterate(executionId) as Iterable<Row>
        ) {
          yield record(
            'recall_relation',
            `${String(row.source_execution_id)}:${String(row.target_execution_id)}`,
            {
              sourceExecutionId: String(row.source_execution_id),
              targetExecutionId: String(row.target_execution_id),
              recordId: String(row.record_id),
            },
          );
        }
        for (
          const row of db.prepare(
            'SELECT diagnostic_id, content_digest FROM diagnostics WHERE execution_id=? ORDER BY rowid',
          ).iterate(executionId) as Iterable<Row>
        ) {
          yield record(
            'diagnostic',
            String(row.diagnostic_id),
            this.#readDiagnostic(String(row.diagnostic_id), db),
          );
          const content = emitContent(String(row.content_digest));
          if (content !== undefined) yield content;
        }
      }
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch { /* close an open read snapshot */ }
      db.close();
    }
  }
}
