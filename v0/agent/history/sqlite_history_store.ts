import { DatabaseSync } from 'node:sqlite';
import type { FollowUpRecord, HistoryReadInput } from '../../api/contract.ts';
import type {
  ConversationContentChunk,
  ConversationContentLocator,
  ConversationPageMetadata,
} from '../../conversation/model.ts';
import type { JsonValue, LoopOutcome, LoopOutcomeMetadata, Message } from '../core/contracts.ts';
import { replaySessionConversation } from '../../conversation/history_adapter.ts';
import { renderConversationTimeline } from './history_view.ts';
import { renderHistoryMarkdownTurns } from '../session/history_export.ts';
import type { AgentEvent } from '../core/events.ts';
import type { ProviderEvidenceRuntimeEvent } from '../provider/provider_evidence.ts';
import {
  isStoredModelSelection,
  type ModelSelection,
  sameModelSelection,
} from '../provider/model_selection.ts';
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
  isSessionTitle,
  MAX_VALID_SESSIONS_PER_WORKSPACE,
  type OpenedWorkerSession,
  type SemanticContextCheckpointV1,
  SessionStoreError,
  type StoredSessionRecord,
  type WorkerSessionHandle,
  type WorkerSessionListResult,
  type WorkerSessionMetadata,
  type WorkerSessionMetadataSnapshot,
  type WorkerSessionMetadataWrite,
  type WorkerSessionOwnerState,
  type WorkerSessionStorePort,
} from '../session/session_store_contract.ts';
import {
  causalTranscriptIndex,
  encodeSemanticContextCheckpoint,
  validateSemanticContextCheckpoint,
  validateStoredSessionRecord,
} from '../session/session_record_codec.ts';
import { acquireLock, ensureDirectory, type Lock } from '../session/deno_session_store_io.ts';
import { canonicalAbsolutePath, workspaceDigest } from '../session/session_store_paths.ts';
import { withHistorySchemaOpen } from './history_schema_open.ts';
import { HISTORY_BUSY_TIMEOUT_MS } from './history_schema.ts';
import { adoptCanonicalInTransaction, SqliteHistoryCore } from './sqlite_history_core.ts';
import { exactByteDigest } from './exact_byte_plan.ts';
import {
  type BeginExecutionInput,
  type CanonicalTurnCommitInput,
  type DataCommandReceipt,
  type DataExecutionCompletionControl,
  type DataFollowUpCursor,
  type DataFollowUpPage,
  type DataFollowUpReceipt,
  type DataSessionReadCursor,
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
  type StoredContextTurn,
  type StoredExecutionDescriptorSummary,
  type StoredExecutionEffect,
  type StoredExecutionEvent,
  type StoredExecutionRecallFacts,
  type StoredExecutionRow,
  type StoredSessionConversationExecution,
  type StoredSessionConversationPage,
  type StoredSessionHistoryExecution,
  type StoredSessionLatestRequest,
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
import { executionEffectsFromEvents } from './execution_effect_projection.ts';
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

export interface SqliteHistoryTextCursor {
  readonly sessionId: string | null;
  readonly view: HistoryReadInput['view'];
  read(maxBytes?: number): Readonly<{
    bytes: Uint8Array<ArrayBuffer>;
    done: boolean;
  }>;
  close(): void;
}

export class HistoryReadTargetError extends Error {
  constructor(
    readonly code:
      | 'invalid_history_target'
      | 'invalid_history_view'
      | 'session_not_found'
      | 'ambiguous_session',
  ) {
    super(code);
    this.name = 'HistoryReadTargetError';
  }
}

const now = (): string => new Date().toISOString();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const asJson = (value: unknown): JsonValue => structuredClone(value) as JsonValue;
const parseJson = <T>(value: SqlValue): T => JSON.parse(String(value)) as T;
const eventValue = (event: StoredExecutionEvent): JsonValue => asJson({ event });
const compactOutcome = (outcome: LoopOutcomeMetadata): LoopOutcomeMetadata => outcome;
const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};
const asHistoryError = (error: unknown): HistoryStoreError =>
  error instanceof HistoryStoreError ? error : new HistoryStoreError('history_io_failure');
const asSessionError = (error: unknown): SessionStoreError =>
  error instanceof SessionStoreError ? error : new SessionStoreError('session_io_failure');
// Session schema-v1 validation treats registrationId as descriptive metadata rather than
// part of persisted model-selection identity. Keep metadata reads/writes on that contract.
const sameStoredSessionSelection = (
  left: ModelSelection,
  right: ModelSelection,
): boolean =>
  left.provider === right.provider && left.modelId === right.modelId &&
  left.effort === right.effort && left.api === right.api &&
  left.authProfile === right.authProfile;

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
    case 'provider_request_usage':
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

const severityOutcome = (
  outcome: LoopOutcomeMetadata,
): StoredExecutionRow['outcome'] =>
  outcome.ok
    ? 'completed'
    : outcome.stopReason === 'cancelled'
    ? 'cancelled'
    : outcome.stopReason === 'interrupted'
    ? 'interrupted'
    : 'failed';

const validAgentChoice = (
  value: unknown,
): value is StoredSessionRecord['agentChoice'] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const choice = value as Record<string, unknown>;
  return Object.keys(choice).every((key) => key === 'name' || key === 'file') &&
    (!Object.hasOwn(choice, 'name') ||
      typeof choice.name === 'string' && choice.name.trim() === choice.name &&
        choice.name.length > 0 && !choice.name.includes('\0')) &&
    (!Object.hasOwn(choice, 'file') ||
      typeof choice.file === 'string' && choice.file.trim() === choice.file &&
        choice.file.length > 0 && !choice.file.includes('\0'));
};

const sameAgentChoice = (
  left: StoredSessionRecord['agentChoice'],
  right: StoredSessionRecord['agentChoice'],
): boolean => left.name === right.name && left.file === right.file;

/** Production history facade over the clean schema-v3 database. */
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
  readonly #baseMessageCountsByExecution = new Map<string, number>();
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

  #saveSessionMetadataTx(
    db: DatabaseSync,
    update: WorkerSessionMetadataWrite,
  ): void {
    if (
      !isSessionId(update.sessionId) ||
      update.workspaceRoot !== this.workspaceRoot ||
      canonicalAbsolutePath(update.workspaceRoot) === undefined ||
      !validAgentChoice(update.agentChoice) ||
      !canonicalTimestamp(update.createdAt) ||
      !canonicalTimestamp(update.updatedAt) ||
      Date.parse(update.updatedAt) < Date.parse(update.createdAt) ||
      (update.title !== null && !isSessionTitle(update.title)) ||
      !Number.isSafeInteger(update.stateRevision) || update.stateRevision < 1 ||
      !Number.isSafeInteger(update.nextTurn) || update.nextTurn < 1 ||
      !isStoredModelSelection(update.activeModel) ||
      !Array.isArray(update.modelChangesToAppend)
    ) throw new SessionStoreError('session_invalid');

    const existing = db.prepare('SELECT * FROM sessions WHERE session_id=?')
      .get(update.sessionId) as Row | undefined;
    const changeCount = existing === undefined ? 0 : Number(existing.model_change_count);
    const previousChange = changeCount === 0 ? undefined : db.prepare(`
        SELECT change_ordinal, effective_from_turn, changed_at, selection_json FROM session_model_changes
        WHERE session_id=? ORDER BY change_ordinal DESC LIMIT 1
      `).get(update.sessionId) as Row | undefined;
    if (
      (existing === undefined && update.modelChangesToAppend.length === 0) ||
      (existing !== undefined && (
        !Number.isSafeInteger(changeCount) || changeCount < 1 ||
        previousChange === undefined ||
        Number(previousChange.change_ordinal) !== changeCount - 1
      )) ||
      (existing !== undefined && (
        String(existing.workspace_root) !== update.workspaceRoot ||
        String(existing.created_at) !== update.createdAt ||
        !sameAgentChoice(
          parseJson<StoredSessionRecord['agentChoice']>(
            existing.agent_choice_json,
          ),
          update.agentChoice,
        ) ||
        Number(existing.state_revision) + 1 !== update.stateRevision ||
        Number(existing.next_turn) !== update.nextTurn
      ))
    ) throw new SessionStoreError('session_invalid');

    let previousEffectiveTurn = previousChange === undefined
      ? 0
      : Number(previousChange.effective_from_turn);
    let previousSelection = previousChange === undefined
      ? undefined
      : parseJson<ModelSelection>(previousChange.selection_json);
    let privateStateFromTurn = existing === undefined
      ? 1
      : Number(existing.private_state_from_turn);
    for (const change of update.modelChangesToAppend) {
      if (
        !Number.isSafeInteger(change.effectiveFromTurn) ||
        change.effectiveFromTurn < previousEffectiveTurn ||
        change.effectiveFromTurn < 1 ||
        change.effectiveFromTurn > update.nextTurn ||
        !canonicalTimestamp(change.changedAt) ||
        !isStoredModelSelection(change.selection)
      ) throw new SessionStoreError('session_invalid');
      if (
        previousSelection !== undefined &&
        (previousSelection.provider !== change.selection.provider ||
          previousSelection.modelId !== change.selection.modelId)
      ) privateStateFromTurn = change.effectiveFromTurn;
      previousEffectiveTurn = change.effectiveFromTurn;
      previousSelection = change.selection;
    }
    if (
      previousSelection === undefined ||
      !sameStoredSessionSelection(previousSelection, update.activeModel) ||
      !Number.isSafeInteger(privateStateFromTurn) || privateStateFromTurn < 1 ||
      privateStateFromTurn > update.nextTurn
    ) throw new SessionStoreError('session_invalid');

    if (existing === undefined) {
      db.prepare(`
        INSERT INTO sessions(
          session_id, workspace_root, agent_choice_json, created_at, updated_at, title,
          state_revision, next_turn, active_model_json, message_count, model_change_count,
          turn_count, private_state_from_turn, checkpoint_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, NULL)
      `).run(
        update.sessionId,
        update.workspaceRoot,
        JSON.stringify(update.agentChoice),
        update.createdAt,
        update.updatedAt,
        update.title,
        update.stateRevision,
        update.nextTurn,
        JSON.stringify(update.activeModel),
      );
    }
    const insertChange = db.prepare(`
      INSERT INTO session_model_changes(
        session_id, change_ordinal, effective_from_turn, changed_at, selection_json
      ) VALUES(?, ?, ?, ?, ?)
    `);
    for (const [index, change] of update.modelChangesToAppend.entries()) {
      insertChange.run(
        update.sessionId,
        changeCount + index,
        change.effectiveFromTurn,
        change.changedAt,
        JSON.stringify(change.selection),
      );
    }
    db.prepare(`
      UPDATE sessions SET updated_at=?, title=?, state_revision=?, next_turn=?,
        active_model_json=?, model_change_count=?, private_state_from_turn=?
      WHERE session_id=?
    `).run(
      update.updatedAt,
      update.title,
      update.stateRevision,
      update.nextTurn,
      JSON.stringify(update.activeModel),
      changeCount + update.modelChangesToAppend.length,
      privateStateFromTurn,
      update.sessionId,
    );
  }

  #saveSessionMetadata(update: WorkerSessionMetadataWrite): void {
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#saveSessionMetadataTx(db, update);
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

  #readSessionMetadataSnapshot(
    db: DatabaseSync,
    id: string,
  ): WorkerSessionMetadataSnapshot {
    const row = db.prepare('SELECT * FROM sessions WHERE session_id=?').get(
      id,
    ) as Row | undefined;
    if (row === undefined) throw new SessionStoreError('session_not_found');
    const agentChoice = parseJson<StoredSessionRecord['agentChoice']>(
      row.agent_choice_json,
    );
    const activeModel = parseJson<ModelSelection>(row.active_model_json);
    const nextTurn = Number(row.next_turn);
    const stateRevision = Number(row.state_revision);
    const messageCount = Number(row.message_count);
    const modelChangeCount = Number(row.model_change_count);
    const turnCount = Number(row.turn_count);
    const privateStateFromTurn = Number(row.private_state_from_turn);
    const latestChangeRow = db.prepare(`
      SELECT change_ordinal, effective_from_turn, changed_at, selection_json
      FROM session_model_changes WHERE session_id=?
      ORDER BY change_ordinal DESC LIMIT 1
    `).get(id) as Row | undefined;
    const latest = latestChangeRow === undefined ? undefined : {
      changeOrdinal: Number(latestChangeRow.change_ordinal),
      effectiveFromTurn: Number(latestChangeRow.effective_from_turn),
      changedAt: String(latestChangeRow.changed_at),
      selection: parseJson<ModelSelection>(latestChangeRow.selection_json),
    };
    const latestTurn = nextTurn === 1 ? undefined : db.prepare(`
      SELECT turn_number FROM session_turns
      WHERE session_id=? ORDER BY turn_number DESC LIMIT 1
    `).get(id) as Row | undefined;
    const checkpoint = row.checkpoint_json === null
      ? undefined
      : parseJson<SemanticContextCheckpointV1>(row.checkpoint_json);
    const agentRow = db.prepare(`
      SELECT e.agent_name FROM session_turns t JOIN executions e USING(execution_id)
      WHERE t.session_id=? ORDER BY t.turn_number DESC LIMIT 1
    `).get(id) as Row | undefined;
    const activeAgent = agentRow?.agent_name === undefined
      ? db.prepare(
        'SELECT agent_name FROM executions WHERE session_correlation=? ORDER BY turn_number DESC, created_at DESC, execution_id DESC LIMIT 1',
      ).get(id) as Row | undefined
      : agentRow;
    const agent = activeAgent?.agent_name === undefined
      ? agentChoice.name ?? 'default'
      : String(activeAgent.agent_name);
    if (
      !isSessionId(id) || String(row.workspace_root) !== this.workspaceRoot ||
      canonicalAbsolutePath(String(row.workspace_root)) === undefined ||
      !validAgentChoice(agentChoice) || !isStoredModelSelection(activeModel) ||
      !canonicalTimestamp(row.created_at) ||
      !canonicalTimestamp(row.updated_at) ||
      Date.parse(String(row.updated_at)) < Date.parse(String(row.created_at)) ||
      (row.title !== null && !isSessionTitle(row.title)) ||
      !Number.isSafeInteger(stateRevision) || stateRevision < 1 ||
      !Number.isSafeInteger(nextTurn) || nextTurn < 1 ||
      !Number.isSafeInteger(messageCount) || messageCount < 0 ||
      !Number.isSafeInteger(modelChangeCount) || modelChangeCount < 1 ||
      !Number.isSafeInteger(turnCount) || turnCount !== nextTurn - 1 ||
      !Number.isSafeInteger(privateStateFromTurn) || privateStateFromTurn < 1 ||
      privateStateFromTurn > nextTurn || latest === undefined ||
      latest.changeOrdinal !== modelChangeCount - 1 ||
      !Number.isSafeInteger(latest.effectiveFromTurn) ||
      latest.effectiveFromTurn < 1 || latest.effectiveFromTurn > nextTurn ||
      !canonicalTimestamp(latest.changedAt) ||
      !isStoredModelSelection(latest.selection) ||
      !sameStoredSessionSelection(latest.selection, activeModel) ||
      (nextTurn === 1 ? messageCount !== 0 : latestTurn === undefined ||
        Number(latestTurn.turn_number) !== nextTurn - 1 ||
        messageCount === 0) ||
      (checkpoint !== undefined &&
        !validateSemanticContextCheckpoint(checkpoint))
    ) throw new SessionStoreError('session_invalid');
    return {
      sessionId: id,
      workspaceRoot: String(row.workspace_root),
      agent,
      agentChoice,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      title: row.title === null ? null : String(row.title),
      stateRevision,
      nextTurn,
      messageCount,
      activeModel,
      privateStateFromTurn,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    };
  }

  #readSessionOwnerState(
    db: DatabaseSync,
    id: string,
  ): WorkerSessionOwnerState {
    const metadata = this.#readSessionMetadataSnapshot(db, id);
    return { ...metadata, transcript: [] };
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

  *#historyTextChunks(
    sessionId: string,
    view: HistoryReadInput['view'],
    workspaceRoot: string,
    db: DatabaseSync,
  ): Generator<string> {
    if (view === 'detail') {
      for (
        const record of this.#streamHumanHistoryExportRecords(sessionId, db)
      ) {
        yield `${JSON.stringify(record)}\n`;
      }
      return;
    }
    if (view === 'session') {
      let blockCount = 0;
      for (
        const facts of this.#historyConversationFactsInTransaction(
          sessionId,
          db,
        )
      ) {
        const { state } = replaySessionConversation(
          sessionId,
          [facts],
          0,
          { includeFullText: true },
        );
        const rendered = renderConversationTimeline(state);
        if (rendered.length === 0) continue;
        if (blockCount > 0) yield '\n\n';
        yield rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
        blockCount += 1;
      }
      if (blockCount > 0) yield '\n';
      return;
    }
    yield* this.#canonicalHistoryChunks(sessionId, workspaceRoot, db);
  }

  *#canonicalHistoryChunks(
    sessionId: string,
    workspaceRoot: string,
    db: DatabaseSync,
  ): Generator<string> {
    const session = db.prepare('SELECT * FROM sessions WHERE session_id=?')
      .get(sessionId) as Row | undefined;
    if (session === undefined) throw new SessionStoreError('session_not_found');
    const latestTurnAgent = db.prepare(`
      SELECT e.agent_name FROM session_turns t JOIN executions e USING(execution_id)
      WHERE t.session_id=? ORDER BY t.turn_ordinal DESC LIMIT 1
    `).get(sessionId) as Row | undefined;
    const latestSessionAgent = latestTurnAgent === undefined
      ? db.prepare(`
        SELECT agent_name FROM executions WHERE canonical_session_id=?
        ORDER BY created_at DESC, execution_id DESC LIMIT 1
      `).get(sessionId) as Row | undefined
      : latestTurnAgent;
    const agentChoice = parseJson<StoredSessionRecord['agentChoice']>(
      session.agent_choice_json,
    );
    const agent = latestSessionAgent?.agent_name === undefined
      ? agentChoice.name ?? 'default'
      : String(latestSessionAgent.agent_name);
    const committedTurn = Number(session.next_turn) - 1;
    yield* renderHistoryMarkdownTurns({
      agent,
      sessionId,
      createdAt: String(session.created_at),
      title: session.title === null ? undefined : String(session.title),
      committedTurn,
      turns: this.#canonicalHistoryTurns(sessionId, db),
    }, workspaceRoot);
  }

  *#canonicalHistoryTurns(
    sessionId: string,
    db: DatabaseSync,
  ): Generator<Readonly<{ turn: number; messages: readonly Message[] }>> {
    for (
      const turnRow of db.prepare(`
        SELECT turn_number FROM session_turns
        WHERE session_id=? ORDER BY turn_ordinal
      `).iterate(sessionId) as Iterable<Row>
    ) {
      const turn = Number(turnRow.turn_number);
      const messages = (db.prepare(`
        SELECT m.content_digest
        FROM conversation_messages c JOIN messages m
          ON m.execution_id=c.execution_id
          AND m.message_ordinal=c.execution_message_ordinal
        WHERE c.session_id=? AND c.turn_number=?
        ORDER BY c.message_ordinal
      `).all(sessionId, turn) as Row[]).map((row) =>
        JSON.parse(
          decoder.decode(
            this.#coreStore().readContent(String(row.content_digest), db),
          ),
        ) as Message
      );
      const index = causalTranscriptIndex(messages);
      if (index === undefined || index.turns.length !== 1) {
        throw new SessionStoreError('session_invalid');
      }
      yield { turn, messages };
    }
  }

  *#historyConversationFactsInTransaction(
    sessionId: string,
    db: DatabaseSync,
  ): Generator<StoredSessionConversationExecution> {
    const missingPosition = db.prepare(`
      SELECT 1 FROM executions e
      WHERE e.session_correlation=? AND NOT EXISTS (
        SELECT 1 FROM execution_display_positions p
        WHERE p.execution_id=e.execution_id
      ) LIMIT 1
    `).get(sessionId);
    if (missingPosition !== undefined) {
      throw new HistoryStoreError('history_invalid');
    }
    let cursor = -1;
    for (;;) {
      const row = db.prepare(`
        SELECT e.execution_id, p.execution_ordinal
        FROM execution_display_positions p JOIN executions e
          ON e.execution_id=p.execution_id
        WHERE p.session_correlation=? AND e.session_correlation=?
          AND p.execution_ordinal>?
        ORDER BY p.execution_ordinal LIMIT 1
      `).get(sessionId, sessionId, cursor) as Row | undefined;
      if (row === undefined) return;
      const executionId = String(row.execution_id);
      const executionOrder = Number(row.execution_ordinal);
      cursor = executionOrder;
      const execution = this.#executionRows(
        'WHERE e.execution_id=?',
        [executionId],
        false,
        db,
      )[0];
      if (execution === undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      yield {
        execution,
        executionOrder,
        events: this.#coreStore().readConversationEvents(executionId, db),
      };
    }
  }

  /** Open a stable text export over one dedicated read-only SQLite snapshot. */
  openHistoryText(
    request: HistoryReadInput,
    workspaceRoot: string,
  ): SqliteHistoryTextCursor {
    if (
      request.latest === true && request.sessionRef !== undefined ||
      request.sessionRef !== undefined && request.sessionRef.length === 0
    ) throw new HistoryReadTargetError('invalid_history_target');
    if (
      request.view !== 'session' && request.view !== 'canonical' &&
      request.view !== 'detail'
    ) throw new HistoryReadTargetError('invalid_history_view');

    const db = this.#db();
    let open = true;
    let source: Generator<string> | undefined;
    let pending: Uint8Array<ArrayBuffer> | undefined;
    let pendingOffset = 0;
    let sourceDone = false;
    try {
      if (request.view === 'detail') {
        // Export de-duplication uses connection-local TEMP indexes. Keep their
        // pages file-backed with a bounded cache rather than growing with the
        // number of exported records.
        db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048;');
      }
      db.exec('BEGIN');
      const targetRef = request.sessionRef?.toLowerCase();
      const query = targetRef === undefined
        ? db.prepare(`
          SELECT session_id, agent_choice_json, active_model_json
          FROM sessions ORDER BY updated_at DESC, session_id
        `)
        : db.prepare(`
          SELECT session_id, agent_choice_json, active_model_json
          FROM sessions
          WHERE lower(substr(session_id, 1, length(?)))=?
          ORDER BY updated_at DESC, session_id
        `);
      const rows = targetRef === undefined
        ? query.iterate() as Iterable<Row>
        : query.iterate(targetRef, targetRef) as Iterable<Row>;
      const matches: string[] = [];
      for (const row of rows) {
        const sessionId = String(row.session_id);
        let choice: unknown;
        let model: ModelSelection;
        try {
          choice = parseJson<unknown>(row.agent_choice_json);
          model = parseJson<ModelSelection>(row.active_model_json);
        } catch {
          continue;
        }
        if (
          !isSessionId(sessionId) || !isStoredModelSelection(model) ||
          typeof choice !== 'object' || choice === null
        ) continue;
        matches.push(sessionId);
        if (matches.length === 2 || targetRef === undefined) break;
      }
      if (matches.length === 0 && targetRef !== undefined) {
        throw new HistoryReadTargetError('session_not_found');
      }
      if (matches.length > 1) {
        throw new HistoryReadTargetError('ambiguous_session');
      }
      const sessionId = matches[0] ?? null;
      if (sessionId !== null) {
        source = this.#historyTextChunks(
          sessionId,
          request.view,
          workspaceRoot,
          db,
        );
      } else {
        source = (function* (): Generator<string> {})();
      }
      const iterator = source;
      const close = (): void => {
        if (!open) return;
        open = false;
        try {
          iterator.return(undefined);
        } catch { /* closing releases the read snapshot below */ }
        try {
          db.exec('ROLLBACK');
        } catch { /* the snapshot may already have ended */ }
        db.close();
        pending = undefined;
      };
      return {
        sessionId,
        view: request.view,
        read: (maxBytes = 256 * 1024) => {
          if (!open) {
            return { bytes: new Uint8Array(0), done: true };
          }
          if (
            !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
            maxBytes > 256 * 1024
          ) throw new HistoryStoreError('history_invalid');
          const output = new Uint8Array(maxBytes);
          let length = 0;
          try {
            while (length < maxBytes) {
              if (pending !== undefined && pendingOffset < pending.byteLength) {
                const count = Math.min(
                  maxBytes - length,
                  pending.byteLength - pendingOffset,
                );
                output.set(
                  pending.subarray(pendingOffset, pendingOffset + count),
                  length,
                );
                length += count;
                pendingOffset += count;
                if (pendingOffset === pending.byteLength) {
                  pending = undefined;
                  pendingOffset = 0;
                }
                continue;
              }
              pending = undefined;
              pendingOffset = 0;
              const next = iterator.next();
              if (next.done) {
                sourceDone = true;
                break;
              }
              pending = encoder.encode(next.value);
            }
            const done = sourceDone && pending === undefined;
            if (done) close();
            return { bytes: output.slice(0, length), done };
          } catch (error) {
            close();
            throw error;
          }
        },
        close,
      };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve the primary error */ }
      db.close();
      throw error;
    }
  }

  async readSessionMetadataSnapshot(
    id: string,
  ): Promise<WorkerSessionMetadataSnapshot> {
    await this.initialize();
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const db = this.#db();
    try {
      db.exec('BEGIN');
      const snapshot = this.#readSessionMetadataSnapshot(db, id);
      db.exec('COMMIT');
      return snapshot;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve the primary error */ }
      throw asSessionError(error);
    } finally {
      db.close();
    }
  }

  /** Read one complete turn immediately before the exclusive global turn cursor. */
  async readContextTurn(
    sessionId: string,
    beforeTurn: number,
    source: 'canonical' | 'runtime',
  ): Promise<StoredContextTurn | null> {
    await this.initialize();
    if (
      (source === 'canonical' ? !isSessionId(sessionId) : sessionId.length === 0) ||
      !Number.isSafeInteger(beforeTurn) ||
      beforeTurn < 1
    ) throw new SessionStoreError('session_invalid');
    const db = this.#db();
    try {
      db.exec('BEGIN');
      let turnRow: Row | undefined;
      if (source === 'canonical') {
        if (
          db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(
            sessionId,
          ) === undefined
        ) throw new SessionStoreError('session_not_found');
        turnRow = db.prepare(`
          SELECT t.turn_number, t.execution_id, e.base_message_count
          FROM session_turns t JOIN executions e USING(execution_id)
          WHERE t.session_id=? AND t.turn_number < ?
          ORDER BY t.turn_number DESC LIMIT 1
        `).get(sessionId, beforeTurn) as Row | undefined;
      } else {
        turnRow = db.prepare(`
          SELECT turn_number, execution_id, base_message_count FROM executions
          WHERE session_correlation=? AND turn_number < ?
            AND lifecycle='settled' AND outcome='completed'
            AND adoption='non_canonical'
          ORDER BY turn_number DESC, created_at DESC, execution_id DESC LIMIT 1
        `).get(sessionId, beforeTurn) as Row | undefined;
      }
      if (turnRow === undefined) {
        db.exec('COMMIT');
        return null;
      }
      const turn = Number(turnRow.turn_number);
      const executionId = String(turnRow.execution_id);
      const messageStart = Number(turnRow.base_message_count);
      const rows = db.prepare(`
        SELECT content_digest FROM messages
        WHERE execution_id=? ORDER BY message_ordinal
      `).all(executionId) as Row[];
      let byteLength = 0;
      const messages = rows.map((row) => {
        const bytes = this.#coreStore().readContent(
          String(row.content_digest),
          db,
        );
        byteLength += bytes.byteLength;
        return JSON.parse(decoder.decode(bytes)) as Message;
      });
      const index = causalTranscriptIndex(messages);
      if (
        !Number.isSafeInteger(turn) || turn < 1 || executionId.length === 0 ||
        !Number.isSafeInteger(messageStart) || messageStart < 0 ||
        messages.length === 0 || index === undefined || index.turns.length !== 1
      ) throw new SessionStoreError('session_invalid');
      db.exec('COMMIT');
      return { turn, executionId, messages, messageStart, source, byteLength };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve the primary error */ }
      throw asSessionError(error);
    } finally {
      db.close();
    }
  }

  writeDataSessionReadCursor(cursor: DataSessionReadCursor): void {
    if (
      cursor.dataInstanceId.length === 0 ||
      cursor.sessionCorrelation.length === 0 ||
      !Number.isSafeInteger(cursor.cut) || cursor.cut < 0 ||
      !Number.isSafeInteger(cursor.storeRevision) || cursor.storeRevision < 0 ||
      !Number.isSafeInteger(cursor.descriptorSequence) ||
      cursor.descriptorSequence < 0 ||
      (cursor.latestExecutionId !== undefined &&
        cursor.latestExecutionId.length === 0)
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`
        INSERT INTO data_session_read_cursors(
          data_instance_id, session_correlation, cut, store_revision,
          descriptor_sequence, anchor_json, latest_execution_id
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(data_instance_id, session_correlation) DO UPDATE SET
          cut=excluded.cut,
          store_revision=excluded.store_revision,
          descriptor_sequence=excluded.descriptor_sequence,
          anchor_json=excluded.anchor_json,
          latest_execution_id=excluded.latest_execution_id
      `).run(
        cursor.dataInstanceId,
        cursor.sessionCorrelation,
        cursor.cut,
        cursor.storeRevision,
        cursor.descriptorSequence,
        JSON.stringify(cursor.anchor),
        cursor.latestExecutionId ?? null,
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve the primary error */ }
      throw asHistoryError(error);
    } finally {
      db.close();
    }
  }

  readDataSessionReadCursor(
    dataInstanceId: string,
    sessionCorrelation: string,
  ): DataSessionReadCursor | undefined {
    if (dataInstanceId.length === 0 || sessionCorrelation.length === 0) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT cut, store_revision, descriptor_sequence, anchor_json,
          latest_execution_id
        FROM data_session_read_cursors
        WHERE data_instance_id=? AND session_correlation=?
      `).get(dataInstanceId, sessionCorrelation) as Row | undefined;
      if (row === undefined) return undefined;
      return {
        dataInstanceId,
        sessionCorrelation,
        cut: Number(row.cut),
        storeRevision: Number(row.store_revision),
        descriptorSequence: Number(row.descriptor_sequence),
        anchor: parseJson<JsonValue>(row.anchor_json),
        ...(row.latest_execution_id === null ? {} : {
          latestExecutionId: String(row.latest_execution_id),
        }),
      };
    } finally {
      db.close();
    }
  }

  readCoreSessionCursor(coreEpoch: string, sessionId: string): number | null {
    if (coreEpoch.length === 0 || sessionId.length === 0) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT public_revision FROM core_session_cursors
        WHERE core_epoch=? AND session_id=?
      `).get(coreEpoch, sessionId) as Row | undefined;
      if (row === undefined) return null;
      const revision = Number(row.public_revision);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new HistoryStoreError('history_invalid');
      }
      return revision;
    } finally {
      db.close();
    }
  }

  writeCoreSessionCursor(
    coreEpoch: string,
    sessionId: string,
    revision: number,
  ): void {
    if (
      coreEpoch.length === 0 || sessionId.length === 0 ||
      !Number.isSafeInteger(revision) || revision < 0
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    try {
      db.prepare(`
        INSERT INTO core_session_cursors(core_epoch, session_id, public_revision)
        VALUES(?, ?, ?)
        ON CONFLICT(core_epoch, session_id) DO UPDATE SET
          public_revision=excluded.public_revision
      `).run(coreEpoch, sessionId, revision);
    } finally {
      db.close();
    }
  }

  readCommandReceipt(
    coreEpoch: string,
    commandId: string,
  ): DataCommandReceipt | null {
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT operation, signature_digest, result_json, target_json,
          execution_id, completed_at
        FROM command_receipts WHERE core_epoch=? AND command_id=?
      `).get(coreEpoch, commandId) as Row | undefined;
      if (row === undefined) return null;
      const result = parseJson<DataCommandReceipt['result']>(row.result_json);
      const target = parseJson<DataCommandReceipt['result']['target']>(
        row.target_json,
      );
      const executionId = row.execution_id === null ? undefined : String(row.execution_id);
      const resultExecutionId = result.kind === 'accepted' &&
          'executionId' in result.value
        ? result.value.executionId
        : undefined;
      if (
        result.commandId !== commandId ||
        JSON.stringify(result.target) !== JSON.stringify(target) ||
        resultExecutionId !== executionId ||
        !canonicalTimestamp(row.completed_at)
      ) throw new HistoryStoreError('history_invalid');
      return {
        coreEpoch,
        commandId,
        operation: String(row.operation) as DataCommandReceipt['operation'],
        signatureDigest: String(row.signature_digest),
        result,
        completedAt: String(row.completed_at),
      };
    } finally {
      db.close();
    }
  }

  writeCommandReceipt(receipt: DataCommandReceipt): void {
    if (
      receipt.coreEpoch.length === 0 || receipt.commandId.length === 0 ||
      receipt.signatureDigest.length === 0 ||
      receipt.result.commandId !== receipt.commandId ||
      !canonicalTimestamp(receipt.completedAt)
    ) throw new HistoryStoreError('history_invalid');
    const targetJson = JSON.stringify(receipt.result.target);
    const resultJson = JSON.stringify(receipt.result);
    const executionId = receipt.result.kind === 'accepted' &&
        'executionId' in receipt.result.value
      ? receipt.result.value.executionId
      : null;
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const existing = db.prepare(`
        SELECT operation, signature_digest FROM command_receipts
        WHERE core_epoch=? AND command_id=?
      `).get(receipt.coreEpoch, receipt.commandId) as Row | undefined;
      if (existing !== undefined) {
        if (
          String(existing.operation) !== receipt.operation ||
          String(existing.signature_digest) !== receipt.signatureDigest
        ) throw new HistoryStoreError('history_invalid');
        db.exec('COMMIT');
        return;
      }
      db.prepare(`
        INSERT INTO command_receipts(
          core_epoch, command_id, operation, signature_digest, result_json,
          target_json, execution_id, completed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.coreEpoch,
        receipt.commandId,
        receipt.operation,
        receipt.signatureDigest,
        resultJson,
        targetJson,
        executionId,
        receipt.completedAt,
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve the primary error */ }
      throw asHistoryError(error);
    } finally {
      db.close();
    }
  }

  readExecutionCompletionControl(
    executionId: string,
  ): DataExecutionCompletionControl | null {
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT control_json FROM execution_control_facts WHERE execution_id=?
      `).get(executionId) as Row | undefined;
      if (row === undefined) return null;
      const control = parseJson<DataExecutionCompletionControl>(
        row.control_json,
      );
      if (
        control.executionId !== executionId || control.sessionId.length === 0 ||
        control.submittedByCommandId.length === 0 ||
        control.processSettlement !== 'complete'
      ) throw new HistoryStoreError('history_invalid');
      return control;
    } finally {
      db.close();
    }
  }

  writeExecutionCompletionControl(
    control: DataExecutionCompletionControl,
  ): void {
    if (
      control.executionId.length === 0 || control.sessionId.length === 0 ||
      control.submittedByCommandId.length === 0 ||
      control.processSettlement !== 'complete'
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const execution = db.prepare(`
        SELECT session_correlation FROM executions WHERE execution_id=?
      `).get(control.executionId) as Row | undefined;
      if (
        execution === undefined ||
        String(execution.session_correlation) !== control.sessionId
      ) throw new HistoryStoreError('history_invalid');
      db.prepare(`
        INSERT INTO execution_control_facts(execution_id, control_json, updated_at)
        VALUES(?, ?, ?)
        ON CONFLICT(execution_id) DO UPDATE SET
          control_json=excluded.control_json,
          updated_at=excluded.updated_at
      `).run(control.executionId, JSON.stringify(control), now());
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve the primary error */ }
      throw asHistoryError(error);
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
        return this.#handle(id, agentChoice, undefined, lock);
      } catch (error) {
        if (
          !(error instanceof SessionStoreError) || error.code !== 'session_busy'
        ) throw error;
      }
    }
    throw new SessionStoreError('session_limit');
  }

  async openExistingWorker(id: string): Promise<OpenedWorkerSession> {
    await this.initialize();
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const lock = await acquireLock(`${this.#locksPath}/${id}.lock`);
    const db = this.#db();
    try {
      db.exec('BEGIN');
      const state = this.#readSessionOwnerState(db, id);
      db.exec('COMMIT');
      return {
        handle: this.#handle(id, state.agentChoice, state.checkpoint, lock),
        state,
      };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      lock.close();
      throw asSessionError(error);
    } finally {
      db.close();
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
      // Remove saved cursors and receipts tied to this Session's execution subtree before
      // deleting executions. These rows otherwise retain deleted Session state or block the
      // existing transactional Session delete through their execution references.
      db.prepare('DELETE FROM core_session_cursors WHERE session_id=?').run(id);
      db.prepare(`
        WITH RECURSIVE owned(execution_id) AS (
          SELECT execution_id FROM executions
          WHERE canonical_session_id=? OR session_correlation=?
          UNION
          SELECT child.execution_id FROM executions child
          JOIN owned parent ON child.parent_execution_id=parent.execution_id
        )
        DELETE FROM data_session_read_cursors
        WHERE session_correlation=?
          OR latest_execution_id IN (SELECT execution_id FROM owned)
      `).run(id, id, id);
      db.prepare(`
        WITH RECURSIVE owned(execution_id) AS (
          SELECT execution_id FROM executions
          WHERE canonical_session_id=? OR session_correlation=?
          UNION
          SELECT child.execution_id FROM executions child
          JOIN owned parent ON child.parent_execution_id=parent.execution_id
        )
        DELETE FROM command_receipts
        WHERE execution_id IN (SELECT execution_id FROM owned)
      `).run(id, id);
      db.prepare(`
        WITH RECURSIVE owned(execution_id) AS (
          SELECT execution_id FROM executions
          WHERE canonical_session_id=? OR session_correlation=?
          UNION
          SELECT child.execution_id FROM executions child
          JOIN owned parent ON child.parent_execution_id=parent.execution_id
        )
        DELETE FROM follow_up_receipts
        WHERE session_correlation=?
          OR parent_execution_id IN (SELECT execution_id FROM owned)
          OR started_execution_id IN (SELECT execution_id FROM owned)
      `).run(id, id, id);
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
    agentChoice: StoredSessionRecord['agentChoice'],
    initialCheckpoint: SemanticContextCheckpointV1 | undefined,
    lock: Lock,
  ): WorkerSessionHandle {
    let checkpoint = initialCheckpoint;
    let rollbackCheckpoint = initialCheckpoint;
    let closed = false;
    return {
      id,
      get checkpoint() {
        return checkpoint === undefined ? undefined : structuredClone(checkpoint);
      },
      saveMetadata: (update) => {
        if (closed) throw new SessionStoreError('session_busy');
        if (
          update.sessionId !== id ||
          !sameAgentChoice(update.agentChoice, agentChoice)
        ) throw new SessionStoreError('session_invalid');
        this.#saveSessionMetadata(update);
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
      let baseMessageCount = input.canonicalSessionId === undefined
        ? input.runtimeMessageStart ?? 0
        : 0;
      if (
        input.canonicalSessionId === undefined &&
        (!Number.isSafeInteger(baseMessageCount) || baseMessageCount < 0)
      ) throw new HistoryStoreError('history_invalid');
      const db = this.#db();
      try {
        db.exec('BEGIN IMMEDIATE');
        if (input.initialSession !== undefined) {
          if (
            input.canonicalSessionId !== input.initialSession.sessionId ||
            input.baseStateRevision !== input.initialSession.stateRevision
          ) throw new HistoryStoreError('history_invalid');
          this.#saveSessionMetadataTx(db, input.initialSession);
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
      this.#baseMessageCountsByExecution.set(
        input.executionId,
        baseMessageCount,
      );
    } catch (error) {
      this.#baseMessageCountsByExecution.delete(input.executionId);
      this.#releaseExecutionLock(input.executionId);
      throw asHistoryError(error);
    }
  }

  prepareWorkerObservationForHistory(
    _executionId: string,
    message: WorkerToHostMessage,
  ): WorkerToHostMessage {
    if (message.kind !== 'commit_proposal' && message.kind !== 'turn_failed') {
      return message;
    }
    if (message.kind === 'commit_proposal') {
      return {
        ...message,
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
      },
      historyTranscriptBaseApplied: true,
    } as WorkerToHostMessage;
  }

  validateExecutionEvent(input: ExecutionEventInput): boolean {
    return input.executionId.length > 0 && input.kind.length > 0 &&
      typeof input.payload === 'object' && input.payload !== null;
  }

  #boundedEventPayload(input: ExecutionEventInput): JsonValue {
    if (input.kind !== 'runtime_event') return input.payload as JsonValue;
    const payload = input.payload as unknown as Record<string, unknown>;
    const alreadyBounded = payload.historyTranscriptBaseApplied === true;
    if (
      payload.kind === 'commit_proposal' && Array.isArray(payload.transcript)
    ) {
      const outcome = payload.outcome as LoopOutcome | undefined;
      const { historyTranscriptBaseApplied: _bounded, ...stored } = payload;
      const baseMessageCount = alreadyBounded
        ? 0
        : this.#baseMessageCountsByExecution.get(input.executionId) ?? 0;
      return {
        ...stored,
        transcript: alreadyBounded
          ? payload.transcript
          : payload.transcript.slice(baseMessageCount),
        ...(outcome === undefined ? {} : { outcome: { ...outcome, transcript: [] } }),
      } as unknown as JsonValue;
    }
    if (payload.kind === 'turn_failed') {
      const outcome = payload.outcome as LoopOutcome;
      const { historyTranscriptBaseApplied: _bounded, ...stored } = payload;
      const baseMessageCount = alreadyBounded
        ? 0
        : this.#baseMessageCountsByExecution.get(input.executionId) ?? 0;
      return {
        ...stored,
        outcome: {
          ...outcome,
          transcript: alreadyBounded
            ? outcome.transcript
            : outcome.transcript.slice(baseMessageCount),
        },
      } as unknown as JsonValue;
    }
    return input.payload as unknown as JsonValue;
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
          payload: metadata as unknown as JsonValue,
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
      payload: {
        ...payload,
        observation: { ...observation, delta: storedDelta },
      } as unknown as JsonValue,
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
                this.#coreStore().readAssistantTextFirstEventOrdinal(
                  executionId,
                  key,
                ),
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

  #writeExecutionMessageSuffixTx(
    db: DatabaseSync,
    executionId: string,
    messageSuffix: readonly Message[],
  ): void {
    const insert = db.prepare(
      'INSERT INTO messages(execution_id, message_ordinal, content_digest) VALUES(?, ?, ?) ON CONFLICT(execution_id, message_ordinal) DO NOTHING',
    );
    for (const [ordinal, message] of messageSuffix.entries()) {
      const bytes = encoder.encode(JSON.stringify(message));
      const digest = this.#coreStore().writeContent(bytes, db);
      insert.run(executionId, ordinal, digest);
      const saved = db.prepare(
        'SELECT content_digest FROM messages WHERE execution_id=? AND message_ordinal=?',
      ).get(executionId, ordinal) as Row | undefined;
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
      input.canonicalSessionId === undefined ||
      !canonicalTimestamp(input.updatedAt) ||
      input.sessionCorrelation !== input.canonicalSessionId ||
      !Array.isArray(input.messageSuffix)
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    let capture: HistoryCaptureResult = {};
    let commitDelta: HistoryCommitDelta;
    try {
      db.exec('BEGIN IMMEDIATE');
      const execution = db.prepare(
        'SELECT canonical_session_id, base_revision, base_message_count, turn_number, agent_name, configuration_id, model_json FROM executions WHERE execution_id=?',
      ).get(input.executionId) as Row | undefined;
      const session = db.prepare(
        'SELECT message_count, state_revision, next_turn FROM sessions WHERE session_id=?',
      ).get(input.canonicalSessionId) as Row | undefined;
      if (
        execution === undefined || session === undefined ||
        String(execution.canonical_session_id) !== input.canonicalSessionId ||
        Number(execution.base_revision) !== input.baseStateRevision ||
        Number(execution.base_message_count) !==
          Number(session.message_count) ||
        Number(session.state_revision) !== input.baseStateRevision ||
        Number(session.next_turn) !== input.turn ||
        Number(execution.turn_number) !== input.turn ||
        String(execution.agent_name) !== input.agent ||
        String(execution.configuration_id) !== input.configurationId ||
        !sameModelSelection(
          parseJson<ModelSelection>(execution.model_json),
          input.model,
        )
      ) throw new HistoryStoreError('history_invalid');
      this.#writeExecutionMessageSuffixTx(
        db,
        input.executionId,
        input.messageSuffix,
      );
      capture = this.#captureTx(db, input);
      commitDelta = this.#appendTerminalTx(db, {
        executionId: input.executionId,
        observedAt: input.updatedAt,
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
        settledAt: input.updatedAt,
        runtimeOutcomeJson: asJson(compactOutcome(input.outcome)),
      });
      this.#fault?.('before_settlement_commit');
      db.exec('COMMIT');
      const update = {
        ...commitDelta!,
        committedRevision: input.baseStateRevision + 1,
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
      this.#baseMessageCountsByExecution.delete(input.executionId);
      this.#releaseExecutionLock(input.executionId);
    }
    if (input.executionMetadata !== undefined) {
      try {
        this.recordExecutionMetadata(
          input.executionId,
          input.executionMetadata,
        );
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
        'SELECT 1 FROM executions WHERE execution_id=?',
      )
        .get(input.executionId) as Row | undefined;
      if (execution === undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      this.#writeExecutionMessageSuffixTx(
        db,
        input.executionId,
        input.messageSuffix,
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
      this.#baseMessageCountsByExecution.delete(input.executionId);
      this.#releaseExecutionLock(input.executionId);
    }
    if (input.executionMetadata !== undefined) {
      try {
        this.recordExecutionMetadata(
          input.executionId,
          input.executionMetadata,
        );
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

  recordExecutionMetadata(
    executionId: string,
    metadata: import('../worker/worker_execution_artifact.ts').WorkerExecutionArtifactMetadata,
  ): void {
    if (
      typeof executionId !== 'string' || executionId.length === 0 ||
      typeof metadata !== 'object' || metadata === null ||
      (metadata.storeResult !== 'not_attempted' &&
        metadata.storeResult !== 'failed' &&
        metadata.storeResult !== 'committed') ||
      !Array.isArray(metadata.protocolTrace) ||
      (metadata.storeError !== undefined &&
        metadata.storeError !== 'session_io_failure' &&
        metadata.storeError !== 'session_invalid' &&
        metadata.storeError !== 'history_busy')
    ) throw new HistoryStoreError('history_invalid');
    this.#recordExecutionMetadata(executionId, metadata);
  }

  #recordExecutionMetadata(
    executionId: string,
    metadata: import('../worker/worker_execution_artifact.ts').WorkerExecutionArtifactMetadata,
  ): void {
    const payload = asJson({
      kind: 'execution_metadata',
      storeResult: metadata.storeResult,
      protocolTrace: metadata.protocolTrace,
      ...(metadata.childCleanup === undefined ? {} : { childCleanup: metadata.childCleanup }),
      ...(metadata.storeError === undefined ? {} : { storeError: metadata.storeError }),
    });
    const previous = this.#readLatestExecutionMetadata(executionId);
    if (
      previous !== undefined &&
      decoder.decode(encodeHistoryPayload(previous)) ===
        decoder.decode(encodeHistoryPayload(payload))
    ) return;
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare(
        'SELECT latest_ordinal FROM executions WHERE execution_id=?',
      ).get(
        executionId,
      ) as Row | undefined;
      if (row === undefined) throw new HistoryStoreError('history_invalid');
      const ordinal = Number(row.latest_ordinal) + 1;
      db.prepare(`INSERT INTO semantic_records(
        record_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest
      ) VALUES(?, ?, ?, 'host_decision', ?, ?, NULL)`).run(
        `metadata:${crypto.randomUUID()}`,
        executionId,
        ordinal,
        now(),
        decoder.decode(encodeHistoryPayload(payload)),
      );
      db.prepare(
        `UPDATE executions SET latest_ordinal=?, occurrence_count=occurrence_count+1
        WHERE execution_id=?`,
      ).run(ordinal, executionId);
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

  #readLatestExecutionMetadata(
    executionId: string,
    snapshotDb?: DatabaseSync,
  ): JsonValue | undefined {
    const db = snapshotDb ?? this.#db();
    try {
      const row = db.prepare(`
        SELECT record_id FROM semantic_records
        WHERE execution_id=? AND kind='host_decision'
          AND json_extract(payload_json, '$.kind')='execution_metadata'
        ORDER BY ordinal DESC LIMIT 1
      `).get(executionId) as Row | undefined;
      return row === undefined
        ? undefined
        : this.#coreStore().readOccurrence(String(row.record_id), db)
          .payload;
    } finally {
      if (snapshotDb === undefined) db.close();
    }
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
        const outcomeMetadata = row.runtime_outcome_json === null
          ? undefined
          : parseJson<LoopOutcomeMetadata>(row.runtime_outcome_json);
        let transcript: Message[] | undefined;
        if (outcomeMetadata !== undefined && includeTranscript) {
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
        const runtimeOutcome = outcomeMetadata === undefined ? undefined : {
          ...outcomeMetadata,
          transcript: includeTranscript && transcript !== undefined ? transcript : [],
        };
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
          acknowledgement: this.#acknowledgement(executionId, db),
          generationAvailability: this.#generationAvailability(executionId, db),
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

  #acknowledgement(executionId: string, db: DatabaseSync): StoredExecutionRow['acknowledgement'] {
    const event = this.#coreStore().listControlEvents(executionId, db).findLast((
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

  #generationAvailability(executionId: string, db: DatabaseSync): string {
    const events = this.#coreStore().listControlEvents(executionId, db);
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

  *#readSessionConversationFactsInTransaction(
    sessionId: string,
    db: DatabaseSync,
  ): Generator<StoredSessionConversationExecution> {
    let cursor: readonly [number, string, string] | undefined;
    for (;;) {
      const row = cursor === undefined
        ? db.prepare(`
            SELECT e.execution_id, e.turn_number, e.created_at,
              p.execution_ordinal
            FROM executions e LEFT JOIN execution_display_positions p
              ON p.execution_id=e.execution_id
            WHERE e.session_correlation=?
            ORDER BY e.turn_number, e.created_at, e.execution_id LIMIT 1
          `).get(sessionId) as Row | undefined
        : db.prepare(`
            SELECT e.execution_id, e.turn_number, e.created_at,
              p.execution_ordinal
            FROM executions e LEFT JOIN execution_display_positions p
              ON p.execution_id=e.execution_id
            WHERE e.session_correlation=? AND (
              e.turn_number>? OR
              (e.turn_number=? AND e.created_at>?) OR
              (e.turn_number=? AND e.created_at=? AND e.execution_id>?)
            )
            ORDER BY e.turn_number, e.created_at, e.execution_id LIMIT 1
          `).get(
          sessionId,
          cursor[0],
          cursor[0],
          cursor[1],
          cursor[0],
          cursor[1],
          cursor[2],
        ) as Row | undefined;
      if (row === undefined) return;
      const executionId = String(row.execution_id);
      cursor = [Number(row.turn_number), String(row.created_at), executionId];
      if (row.execution_ordinal === null) {
        throw new HistoryStoreError('history_invalid');
      }
      const execution = this.#executionRows(
        'WHERE e.execution_id=?',
        [executionId],
        false,
        db,
      )[0];
      if (execution === undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      yield {
        execution,
        executionOrder: Number(row.execution_ordinal),
        events: this.#coreStore().readConversationEvents(executionId, db),
      };
    }
  }

  *readSessionConversationFacts(
    sessionId: string,
  ): IterableIterator<StoredSessionConversationExecution> {
    const db = this.#db();
    try {
      db.exec('BEGIN');
      yield* this.#readSessionConversationFactsInTransaction(sessionId, db);
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

  /** Read one stable execution page without materializing unrelated Session rows. */
  readSessionConversationPageFacts(
    sessionId: string,
    cursor?: number,
    direction: ConversationPageMetadata['direction'] = 'latest',
  ): StoredSessionConversationPage {
    if (
      sessionId.length === 0 ||
      (direction !== 'latest' &&
        (!Number.isSafeInteger(cursor) || cursor === undefined ||
          cursor < 0)) ||
      (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    try {
      db.exec('BEGIN');
      const estimatedRows = (
        where: string,
        values: readonly SqlValue[],
        order: string,
      ) =>
        db.prepare(`
          SELECT p.execution_ordinal, p.execution_id, e.lifecycle,
            length(CAST(task.content_bytes AS BLOB)) +
            coalesce((SELECT sum(length(CAST(content.content_bytes AS BLOB)))
              FROM messages m JOIN contents content USING(content_digest)
              WHERE m.execution_id=e.execution_id), 0) +
            coalesce((SELECT sum(length(CAST(CAST(s.payload_json AS BLOB) AS BLOB)))
              FROM semantic_records s WHERE s.execution_id=e.execution_id), 0) +
            coalesce((SELECT sum(length(CAST(state.event_json AS BLOB)))
              FROM assistant_text_states state WHERE state.execution_id=e.execution_id), 0)
              AS body_bytes
          FROM execution_display_positions p
          JOIN executions e ON e.execution_id=p.execution_id
          JOIN contents task ON task.content_digest=e.task_content_digest
          ${where}
          ORDER BY ${order}
          LIMIT 50
        `).all(...values) as Row[];

      const selected: {
        executionOrder: number;
        executionId: string;
        bodyBytes: number;
      }[] = [];
      let usedBytes = 0;
      const addRow = (row: Row, force = false, maxRows = 50): boolean => {
        const executionOrder = Number(row.execution_ordinal);
        const executionId = String(row.execution_id);
        const bodyBytes = Number(row.body_bytes);
        if (
          !Number.isSafeInteger(executionOrder) || executionOrder < 0 ||
          executionId.length === 0 || !Number.isSafeInteger(bodyBytes) ||
          bodyBytes < 0
        ) throw new HistoryStoreError('history_invalid');
        if (
          !force && selected.length > 0 &&
          (selected.length >= maxRows ||
            usedBytes + bodyBytes > 2 * 1024 * 1024)
        ) return false;
        selected.push({ executionOrder, executionId, bodyBytes });
        usedBytes += bodyBytes;
        return true;
      };

      if (direction === 'latest') {
        const activeRows = estimatedRows(
          "WHERE p.session_correlation=? AND e.lifecycle='active'",
          [sessionId],
          'p.execution_ordinal DESC',
        );
        for (const row of activeRows.slice(0, 1)) addRow(row, true);
        const completedRows = estimatedRows(
          "WHERE p.session_correlation=? AND e.lifecycle='settled'",
          [sessionId],
          'p.execution_ordinal DESC',
        );
        let settledAdded = 0;
        for (const row of completedRows) {
          if (settledAdded >= 50) break;
          if (!addRow(row, false, 51)) break;
          settledAdded += 1;
        }
      } else {
        const cursorValue = cursor!;
        const predicate = direction === 'older' ? '<' : '>';
        const ordering = direction === 'older'
          ? 'p.execution_ordinal DESC'
          : 'p.execution_ordinal ASC';
        const rows = estimatedRows(
          `WHERE p.session_correlation=? AND p.execution_ordinal ${predicate} ?`,
          [sessionId, cursorValue],
          ordering,
        );
        for (const row of rows) {
          if (!addRow(row)) break;
        }
      }
      selected.sort((left, right) => left.executionOrder - right.executionOrder);
      const lowerExecutionOrder = selected[0]?.executionOrder;
      const upperExecutionOrder = selected.at(-1)?.executionOrder;
      const existsAt = (condition: string, bound: number): boolean =>
        db.prepare(`
          SELECT 1 FROM execution_display_positions
          WHERE session_correlation=? AND execution_ordinal ${condition} ? LIMIT 1
        `).get(sessionId, bound) !== undefined;
      const hasOlder = lowerExecutionOrder === undefined
        ? direction === 'older' && existsAt('<', cursor!)
        : existsAt('<', lowerExecutionOrder);
      const hasNewer = upperExecutionOrder === undefined
        ? direction === 'newer' && existsAt('>', cursor!)
        : existsAt('>', upperExecutionOrder);
      const page: ConversationPageMetadata = {
        direction,
        ...(cursor === undefined ? {} : { cursor }),
        ...(lowerExecutionOrder === undefined ? {} : { lowerExecutionOrder }),
        ...(upperExecutionOrder === undefined ? {} : { upperExecutionOrder }),
        hasOlder,
        hasNewer,
      };
      const executions: StoredSessionConversationExecution[] = selected.map(
        (item) => {
          const row = this.#executionRows(
            'WHERE e.execution_id=?',
            [item.executionId],
            false,
            db,
          )[0];
          if (row === undefined) throw new HistoryStoreError('history_invalid');
          return {
            execution: row,
            executionOrder: item.executionOrder,
            events: [
              ...this.#coreStore().readConversationEvents(item.executionId, db),
            ],
          };
        },
      );
      db.exec('COMMIT');
      return { page, executions };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      throw asHistoryError(error);
    } finally {
      db.close();
    }
  }

  /** Read an immutable source field in bounded UTF-8 chunks. The locator's cut records
   * when the UI learned of this source; the digest pins the actual bytes across cuts. */
  readConversationContent(
    locator: ConversationContentLocator,
    offset: number,
    length: number,
  ): ConversationContentChunk {
    if (
      locator.sessionId.length === 0 || locator.executionId.length === 0 ||
      locator.entityId.length === 0 || locator.digest.length === 0 ||
      !Number.isSafeInteger(locator.version) || locator.version < 0 ||
      !Number.isSafeInteger(locator.cut) || locator.cut < 0 ||
      !Number.isSafeInteger(locator.totalBytes) || locator.totalBytes < 0 ||
      !Number.isSafeInteger(offset) || offset < 0 ||
      offset > locator.totalBytes ||
      !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024 ||
      (locator.sourceEventOrdinal !== undefined &&
        (!Number.isSafeInteger(locator.sourceEventOrdinal) ||
          locator.sourceEventOrdinal < 1)) ||
      (locator.sourceIndex !== undefined &&
        (!Number.isSafeInteger(locator.sourceIndex) || locator.sourceIndex < 0))
    ) throw new HistoryStoreError('history_invalid');

    const db = this.#db();
    try {
      db.exec('BEGIN');
      const execution = db.prepare(`
        SELECT session_correlation, task_content_digest FROM executions
        WHERE execution_id=?
      `).get(locator.executionId) as Row | undefined;
      if (
        execution === undefined ||
        String(execution.session_correlation) !== locator.sessionId
      ) throw new HistoryStoreError('history_invalid');

      let source: string;
      if (locator.field === 'task') {
        if (locator.version !== 0 || locator.sourceEventOrdinal !== undefined) {
          throw new HistoryStoreError('history_invalid');
        }
        const taskBytes = this.#coreStore().readContent(
          String(execution.task_content_digest),
          db,
        );
        source = decoder.decode(taskBytes);
      } else {
        const ordinal = locator.sourceEventOrdinal;
        if (ordinal === undefined || locator.version !== ordinal) {
          throw new HistoryStoreError('history_invalid');
        }
        const row = db.prepare(`
          SELECT payload_json FROM semantic_records
          WHERE execution_id=? AND json_extract(payload_json, '$.event.ordinal')=?
          ORDER BY ordinal DESC LIMIT 1
        `).get(locator.executionId, ordinal) as Row | undefined ??
          db.prepare(`
            SELECT event_json AS payload_json FROM assistant_text_states
            WHERE execution_id=? AND json_extract(event_json, '$.ordinal')=?
            ORDER BY model_step DESC, request_ordinal DESC LIMIT 1
          `).get(locator.executionId, ordinal) as Row | undefined;
        if (row === undefined) throw new HistoryStoreError('history_invalid');
        const stored = JSON.parse(String(row.payload_json)) as Record<
          string,
          unknown
        >;
        const storedEvent = 'event' in stored && typeof stored.event === 'object' &&
            stored.event !== null
          ? stored.event as Record<string, unknown>
          : stored;
        source = this.#conversationFieldText(
          locator.field,
          storedEvent,
          locator.sourceIndex,
        );
      }

      const bytes = encoder.encode(source);
      if (
        bytes.byteLength !== locator.totalBytes ||
        exactByteDigest(bytes) !== locator.digest
      ) throw new HistoryStoreError('history_invalid');

      let start = offset;
      while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) {
        start += 1;
      }
      let end = Math.min(bytes.byteLength, start + length);
      while (
        end > start && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80
      ) end -= 1;
      const text = decoder.decode(bytes.subarray(start, end));
      db.exec('COMMIT');
      return {
        locator,
        offset: start,
        totalBytes: bytes.byteLength,
        nextOffset: end,
        done: end >= bytes.byteLength,
        text,
      };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch { /* preserve primary error */ }
      throw asHistoryError(error);
    } finally {
      db.close();
    }
  }

  #conversationFieldText(
    field: ConversationContentLocator['field'],
    event: Record<string, unknown>,
    sourceIndex?: number,
  ): string {
    const payload = typeof event.payload === 'object' && event.payload !== null
      ? event.payload as Record<string, unknown>
      : {};
    const providerObservation = payload.kind === 'provider_observation' &&
        typeof payload.observation === 'object' && payload.observation !== null
      ? payload.observation as Record<string, unknown>
      : undefined;
    const providerEvent = providerObservation?.kind === 'runtime_event' &&
        typeof providerObservation.event === 'object' &&
        providerObservation.event !== null
      ? providerObservation.event as Record<string, unknown>
      : undefined;
    const workerEvent = typeof payload.event === 'object' && payload.event !== null
      ? payload.event as Record<string, unknown>
      : undefined;
    const agentEvent = workerEvent?.kind === 'agent_event' &&
        typeof workerEvent.event === 'object' && workerEvent.event !== null
      ? workerEvent.event as Record<string, unknown>
      : undefined;

    let value: unknown;
    switch (field) {
      case 'message':
        value = providerEvent?.kind === 'assistant_progress'
          ? providerEvent.text
          : providerEvent?.kind === 'model_result'
          ? (providerEvent.result as Record<string, unknown> | undefined)?.text
          : agentEvent?.kind === 'steering_message'
          ? ((agentEvent.message as Record<string, unknown> | undefined)
            ?.content as Record<string, unknown> | undefined)?.text
          : undefined;
        break;
      case 'thinking':
        value = agentEvent?.kind === 'assistant_thinking' ? agentEvent.text : undefined;
        break;
      case 'tool_arguments': {
        if (providerEvent?.kind === 'tool_call') {
          value = (providerEvent.call as Record<string, unknown> | undefined)
            ?.arguments;
        } else if (providerEvent?.kind === 'model_result') {
          const result = providerEvent.result as
            | Record<string, unknown>
            | undefined;
          const calls = result?.calls;
          const call = Array.isArray(calls) ? calls[sourceIndex ?? 0] : undefined;
          value = call !== null && typeof call === 'object'
            ? (call as Record<string, unknown>).arguments
            : undefined;
        } else if (agentEvent?.kind === 'tool_call') {
          value = (agentEvent.call as Record<string, unknown> | undefined)
            ?.arguments;
        }
        const text = JSON.stringify(value);
        if (value === undefined || text === undefined) {
          throw new HistoryStoreError('history_invalid');
        }
        return text;
      }
      case 'tool_progress':
        value = providerEvent?.kind === 'tool_progress'
          ? providerEvent.text
          : agentEvent?.kind === 'tool_progress'
          ? agentEvent.text
          : undefined;
        break;
      case 'tool_result': {
        if (providerEvent?.kind === 'tool_result') {
          value = (providerEvent.result as Record<string, unknown> | undefined)
            ?.text;
        } else if (agentEvent?.kind === 'tool_result') {
          const result = agentEvent.result as
            | Record<string, unknown>
            | undefined;
          value = result?.text ??
            ((result?.content as Record<string, unknown> | undefined)?.text);
        }
        break;
      }
      case 'steering':
        value = event.kind === 'steer_requested' || event.kind === 'steer_sent' ||
            event.kind === 'steer_failed'
          ? payload.text
          : undefined;
        break;
    }
    if (typeof value !== 'string') {
      throw new HistoryStoreError('history_invalid');
    }
    return value;
  }

  writeFollowUpReceipt(receipt: DataFollowUpReceipt): void {
    const { coreEpoch, sessionId, followUp } = receipt;
    if (
      coreEpoch.length === 0 || sessionId.length === 0 ||
      followUp.queueId.length === 0 || followUp.commandId.length === 0 ||
      followUp.sessionId !== sessionId ||
      followUp.afterExecutionId.length === 0 ||
      typeof followUp.text !== 'string' ||
      !['queued', 'started', 'discarded', 'startRejected'].includes(
        followUp.status,
      ) ||
      (followUp.executionId !== undefined && followUp.executionId.length === 0)
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const textDigest = this.#coreStore().writeContent(
        encoder.encode(followUp.text),
        db,
      );
      const existing = db.prepare(`
        SELECT session_correlation, command_id, parent_execution_id, text_content_digest,
          created_at FROM follow_up_receipts WHERE core_epoch=? AND queue_id=?
      `).get(coreEpoch, followUp.queueId) as Row | undefined;
      if (existing === undefined) {
        db.prepare(`
          INSERT INTO follow_up_receipts(
            core_epoch, queue_id, session_correlation, command_id, parent_execution_id,
            text_content_digest, status, reason, started_execution_id, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          coreEpoch,
          followUp.queueId,
          sessionId,
          followUp.commandId,
          followUp.afterExecutionId,
          textDigest,
          followUp.status,
          followUp.reason ?? null,
          followUp.executionId ?? null,
          now(),
          now(),
        );
      } else {
        if (
          String(existing.session_correlation) !== sessionId ||
          String(existing.command_id) !== followUp.commandId ||
          String(existing.parent_execution_id) !== followUp.afterExecutionId ||
          String(existing.text_content_digest) !== textDigest
        ) throw new HistoryStoreError('history_invalid');
        db.prepare(`
          UPDATE follow_up_receipts SET status=?, reason=?, started_execution_id=?, updated_at=?
          WHERE core_epoch=? AND queue_id=?
        `).run(
          followUp.status,
          followUp.reason ?? null,
          followUp.executionId ?? null,
          now(),
          coreEpoch,
          followUp.queueId,
        );
      }
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

  readFollowUpReceipt(
    queueId: string,
  ): DataFollowUpReceipt | null {
    if (queueId.length === 0) {
      throw new HistoryStoreError('history_invalid');
    }
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT core_epoch, session_correlation, command_id, parent_execution_id, text_content_digest,
          status, reason, started_execution_id FROM follow_up_receipts
        WHERE queue_id=? ORDER BY updated_at DESC, core_epoch DESC LIMIT 1
      `).get(queueId) as Row | undefined;
      if (row === undefined) return null;
      const text = decoder.decode(
        this.#coreStore().readContent(String(row.text_content_digest), db),
      );
      const status = String(row.status);
      if (
        !['queued', 'started', 'discarded', 'startRejected'].includes(status) ||
        row.parent_execution_id === null
      ) throw new HistoryStoreError('history_invalid');
      return {
        coreEpoch: String(row.core_epoch),
        sessionId: String(row.session_correlation),
        followUp: {
          queueId,
          commandId: String(row.command_id),
          sessionId: String(row.session_correlation),
          afterExecutionId: String(row.parent_execution_id),
          text,
          status: status as FollowUpRecord['status'],
          ...(row.started_execution_id === null ? {} : {
            executionId: String(row.started_execution_id),
          }),
          ...(row.reason === null ? {} : { reason: String(row.reason) }),
        },
      };
    } catch (error) {
      throw asHistoryError(error);
    } finally {
      db.close();
    }
  }

  readFollowUpPage(
    sessionId: string,
    cursor?: DataFollowUpCursor,
  ): DataFollowUpPage {
    if (
      sessionId.length === 0 ||
      (cursor !== undefined &&
        (!canonicalTimestamp(cursor.createdAt) || cursor.queueId.length === 0))
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    try {
      const rows = db.prepare(`
        SELECT core_epoch, queue_id, command_id, parent_execution_id, text_content_digest,
          status, reason, started_execution_id, created_at
        FROM follow_up_receipts
        WHERE session_correlation=?
          AND (? IS NULL OR created_at < ? OR (created_at = ? AND queue_id < ?))
        ORDER BY created_at DESC, queue_id DESC LIMIT 33
      `).all(
        sessionId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.queueId ?? null,
      ) as Row[];
      const hasMore = rows.length > 32;
      const pageRows = rows.slice(0, 32);
      const followUps = pageRows.map((row): DataFollowUpReceipt => {
        const status = String(row.status);
        if (
          !['queued', 'started', 'discarded', 'startRejected'].includes(
            status,
          ) ||
          row.parent_execution_id === null
        ) throw new HistoryStoreError('history_invalid');
        return {
          coreEpoch: String(row.core_epoch),
          sessionId,
          followUp: {
            queueId: String(row.queue_id),
            commandId: String(row.command_id),
            sessionId,
            afterExecutionId: String(row.parent_execution_id),
            text: decoder.decode(
              this.#coreStore().readContent(
                String(row.text_content_digest),
                db,
              ),
            ),
            status: status as FollowUpRecord['status'],
            ...(row.started_execution_id === null ? {} : {
              executionId: String(row.started_execution_id),
            }),
            ...(row.reason === null ? {} : { reason: String(row.reason) }),
          },
        };
      });
      const last = pageRows.at(-1);
      return {
        followUps,
        hasMore,
        ...(hasMore && last !== undefined
          ? {
            nextCursor: {
              createdAt: String(last.created_at),
              queueId: String(last.queue_id),
            },
          }
          : {}),
      };
    } catch (error) {
      throw asHistoryError(error);
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

  readLatestExecutionForSession(
    sessionId: string,
  ): StoredExecutionDescriptorSummary | undefined {
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT e.execution_id, e.session_correlation, e.task_content_digest,
          e.turn_number, e.created_at, e.lifecycle, e.outcome, e.adoption,
          e.base_revision,
          json_extract(e.runtime_outcome_json, '$.stopReason') AS stop_reason,
          json_extract(e.runtime_outcome_json, '$.diagnostic.code') AS diagnostic_code,
          json_extract(e.runtime_outcome_json, '$.diagnostic.stage') AS diagnostic_stage,
          (SELECT diagnostic_id FROM diagnostics d WHERE d.execution_id=e.execution_id ORDER BY rowid DESC LIMIT 1) AS diagnostic_id,
          EXISTS(SELECT 1 FROM execution_contexts c WHERE c.execution_id=e.execution_id) AS has_context_manifest,
          EXISTS(SELECT 1 FROM semantic_records s WHERE s.execution_id=e.execution_id AND s.kind='model_request') AS has_context_observation,
          (SELECT count(*) FROM semantic_records s WHERE s.execution_id=e.execution_id
            AND s.kind='model_request'
            AND json_extract(s.payload_json, '$.event.kind')='provider_request_start') AS request_count
        FROM executions e WHERE e.session_correlation=?
        ORDER BY e.created_at DESC, e.execution_id DESC LIMIT 1
      `).get(sessionId) as Row | undefined;
      if (row === undefined) return undefined;
      const diagnosticId = row.diagnostic_id === null ? undefined : String(row.diagnostic_id);
      const contextCapture = row.lifecycle === 'active'
        ? 'none'
        : Number(row.has_context_manifest) === 1
        ? 'complete'
        : Number(row.has_context_observation) === 1
        ? 'partial'
        : 'none';
      const diagnostic = typeof row.diagnostic_code === 'string' &&
          typeof row.diagnostic_stage === 'string'
        ? { code: row.diagnostic_code, stage: row.diagnostic_stage }
        : undefined;
      return {
        executionId: String(row.execution_id),
        sessionCorrelation: String(row.session_correlation),
        task: decoder.decode(
          this.#coreStore().readContent(String(row.task_content_digest), db),
        ),
        turn: Number(row.turn_number),
        createdAt: String(row.created_at),
        lifecycle: String(
          row.lifecycle,
        ) as StoredExecutionDescriptorSummary['lifecycle'],
        outcome: String(
          row.outcome,
        ) as StoredExecutionDescriptorSummary['outcome'],
        ...(typeof row.stop_reason === 'string' ? { stopReason: row.stop_reason } : {}),
        ...(diagnostic === undefined ? {} : { diagnostic }),
        adoption: String(
          row.adoption,
        ) as StoredExecutionDescriptorSummary['adoption'],
        ...(row.adoption === 'canonical'
          ? { committedRevision: Number(row.base_revision) + 1 }
          : {}),
        acknowledgement: this.#acknowledgement(String(row.execution_id), db),
        generationAvailability: this.#generationAvailability(
          String(row.execution_id),
          db,
        ),
        diagnosticCapture: diagnosticId === undefined ? 'none' : 'yes',
        ...(diagnosticId === undefined ? {} : { diagnosticId }),
        artifactCapture: row.lifecycle === 'settled' ? 'yes' : 'none',
        contextCapture,
        requestCount: Number(row.request_count),
      };
    } finally {
      db.close();
    }
  }

  readLatestRequestForSession(
    sessionId: string,
  ): StoredSessionLatestRequest | undefined {
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT e.execution_id,
          json_extract(s.payload_json, '$.event.payload.observation.delta.requestOrdinal') AS request_ordinal,
          json_extract(s.payload_json, '$.event.payload.observation.delta.lane') AS lane,
          json_extract(s.payload_json, '$.event.payload.observation.delta.purpose') AS purpose,
          json_extract(s.payload_json, '$.event.payload.observation.delta.modelStep') AS model_step,
          json_extract(s.payload_json, '$.event.payload.observation.delta.resultItemCount') AS item_count
        FROM executions e JOIN semantic_records s USING(execution_id)
        WHERE e.session_correlation=? AND s.kind='model_request'
          AND json_extract(s.payload_json, '$.event.kind')='context_observation'
          AND json_extract(s.payload_json, '$.event.payload.observation.kind')='model_request_delta'
          AND json_type(s.payload_json, '$.event.payload.observation.delta.requestOrdinal')='integer'
          AND json_type(s.payload_json, '$.event.payload.observation.delta.modelStep')='integer'
          AND json_type(s.payload_json, '$.event.payload.observation.delta.resultItemCount')='integer'
          AND json_type(s.payload_json, '$.event.payload.observation.delta.lane')='text'
          AND json_extract(s.payload_json, '$.event.payload.observation.delta.lane') IN ('parent', 'planner')
          AND json_type(s.payload_json, '$.event.payload.observation.delta.purpose')='text'
        ORDER BY e.created_at DESC, e.execution_id DESC,
          CAST(json_extract(s.payload_json, '$.event.payload.observation.delta.requestOrdinal') AS INTEGER) DESC,
          s.ordinal ASC LIMIT 1
      `).get(sessionId) as Row | undefined;
      if (row === undefined) return undefined;
      const requestOrdinal = Number(row.request_ordinal);
      const modelStep = Number(row.model_step);
      const itemCount = Number(row.item_count);
      if (
        !Number.isSafeInteger(requestOrdinal) ||
        !Number.isSafeInteger(modelStep) || !Number.isSafeInteger(itemCount) ||
        (row.lane !== 'parent' && row.lane !== 'planner') ||
        typeof row.purpose !== 'string'
      ) return undefined;
      return {
        executionId: String(row.execution_id),
        requestOrdinal,
        lane: row.lane,
        purpose: row.purpose,
        modelStep,
        itemCount,
      };
    } finally {
      db.close();
    }
  }

  readExecutionMetadata(id: string): StoredExecutionRow {
    const row = this.#executionRows('WHERE e.execution_id=?', [id], false)[0];
    if (row === undefined) throw new HistoryStoreError('history_invalid');
    return row;
  }

  readExecutionRequestCount(id: string): number {
    this.readExecutionMetadata(id);
    const db = this.#db();
    try {
      return Number(
        db.prepare(`
        SELECT COUNT(*) AS count FROM semantic_records
        WHERE execution_id=? AND kind='model_request'
          AND json_extract(payload_json, '$.event.kind')='provider_request_start'
      `).get(id)!.count,
      );
    } finally {
      db.close();
    }
  }

  /** Request metadata without decoding unrelated thinking, messages, or tool history. */
  listModelRequestOccurrences(
    id: string,
  ): readonly HistorySemanticOccurrence[] {
    this.readExecutionMetadata(id);
    const db = this.#db();
    try {
      return (db.prepare(`
        SELECT record_id FROM semantic_records
        WHERE execution_id=? AND kind='model_request' ORDER BY ordinal
      `).all(id) as Row[]).map((row) =>
        this.#coreStore().readOccurrence(String(row.record_id), db)
      );
    } finally {
      db.close();
    }
  }

  listExecutionEvents(id: string): readonly StoredExecutionEvent[] {
    this.readExecutionMetadata(id);
    return this.#listExecutionEvents(id, true);
  }

  readExecutionRecallFacts(id: string): StoredExecutionRecallFacts {
    this.readExecutionMetadata(id);
    const db = this.#db();
    try {
      const semanticEvents = this.#readRecallSemanticEvents(id, db);
      const partial = this.#coreStore().listAssistantTextStates(id, db).map((
        state,
      ) => ({
        ...state.event,
        firstEventOrdinal: state.firstEventOrdinal,
      }));
      const eventCount = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM semantic_records
            WHERE execution_id=? AND json_type(payload_json, '$.event')='object') +
          (SELECT COUNT(*) FROM semantic_records
            WHERE execution_id=? AND kind='control_decision'
              AND json_type(payload_json, '$.controlEvent')='object') +
          (SELECT COUNT(*) FROM assistant_text_states WHERE execution_id=?) AS count
      `).get(id, id, id) as Row;
      return {
        events: [...semanticEvents, ...partial].sort((left, right) =>
          (left.firstEventOrdinal ?? left.ordinal) -
            (right.firstEventOrdinal ?? right.ordinal) ||
          left.ordinal - right.ordinal
        ),
        eventCount: Number(eventCount.count),
      };
    } finally {
      db.close();
    }
  }

  #readSemanticEventsByStoredKinds(
    id: string,
    kinds: readonly string[],
    db: DatabaseSync,
  ): readonly StoredExecutionEvent[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT record_id FROM semantic_records
      WHERE execution_id=? AND kind IN (${placeholders})
      ORDER BY ordinal
    `).all(id, ...kinds) as Row[];
    return rows.flatMap((row) => {
      const occurrence = this.#coreStore().readOccurrence(
        String(row.record_id),
        db,
      );
      if (
        typeof occurrence.payload !== 'object' || occurrence.payload === null ||
        Array.isArray(occurrence.payload)
      ) return [];
      const event = (occurrence.payload as Record<string, JsonValue>).event;
      return typeof event === 'object' && event !== null &&
          !Array.isArray(event)
        ? [structuredClone(event) as unknown as StoredExecutionEvent]
        : [];
    });
  }

  #readRecallSemanticEvents(
    id: string,
    db: DatabaseSync,
  ): readonly StoredExecutionEvent[] {
    const rows = db.prepare(`
      SELECT record_id FROM semantic_records
      WHERE execution_id=? AND (
        (
          kind IN (
            'user_message', 'assistant_message', 'tool_call', 'tool_result',
            'model_result'
          ) AND json_extract(payload_json, '$.event.kind')='runtime_event'
        ) OR (
          kind='effect_observation' AND
          json_extract(payload_json, '$.event.kind')='effect_observation'
        ) OR (
          kind='model_request' AND json_extract(payload_json, '$.event.kind') IN (
            'provider_request_start', 'provider_response_start',
            'provider_request_usage', 'provider_parser_transition',
            'provider_request_failure'
          )
        )
      )
      ORDER BY ordinal
    `).all(id) as Row[];
    return rows.flatMap((row) => {
      const occurrence = this.#coreStore().readOccurrence(
        String(row.record_id),
        db,
      );
      if (
        typeof occurrence.payload !== 'object' || occurrence.payload === null ||
        Array.isArray(occurrence.payload)
      ) return [];
      const event = (occurrence.payload as Record<string, JsonValue>).event;
      return typeof event === 'object' && event !== null &&
          !Array.isArray(event)
        ? [structuredClone(event) as unknown as StoredExecutionEvent]
        : [];
    });
  }

  #readContextItems(
    executionId: string,
    occurrenceIds: readonly string[],
    db: DatabaseSync,
    throughOrdinal?: number,
  ): readonly HistorySemanticOccurrence[] {
    if (occurrenceIds.length === 0) return [];
    const ordinalFilter = throughOrdinal === undefined ? '' : 'AND ordinal<=?';
    const rows = db.prepare(`
      SELECT record_id FROM semantic_records
      WHERE execution_id=? AND kind='context_item'
        AND json_extract(payload_json, '$.occurrenceId') IN (
          SELECT value FROM json_each(?)
        )
        ${ordinalFilter}
      ORDER BY ordinal
    `).all(
      executionId,
      JSON.stringify([...new Set(occurrenceIds)]),
      ...(throughOrdinal === undefined ? [] : [throughOrdinal]),
    ) as Row[];
    return rows.map((row) => this.#coreStore().readOccurrence(String(row.record_id), db));
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
    const db = this.#db();
    try {
      const events = this.#readSemanticEventsByStoredKinds(id, [
        'effect_observation',
        'tool_call',
        'tool_result',
      ], db);
      return executionEffectsFromEvents(id, execution.outcome, events);
    } finally {
      db.close();
    }
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
      const deltaRows = db.prepare(`
        SELECT record_id FROM semantic_records
        WHERE execution_id=? AND kind='model_request'
          AND json_extract(payload_json, '$.event.kind')='context_observation'
          AND json_extract(payload_json, '$.event.payload.observation.kind')='model_request_delta'
        ORDER BY ordinal
      `).all(executionId) as Row[];
      const deltas = deltaRows.map((deltaRow) => {
        const occurrence = this.#coreStore().readOccurrence(
          String(deltaRow.record_id),
          db,
        );
        const event = (occurrence.payload as Record<string, JsonValue>)
          .event as Record<string, JsonValue>;
        const payload = event.payload as Record<string, JsonValue>;
        const observation = payload.observation as Record<string, JsonValue>;
        return observation.delta as unknown as ContextModelRequestDelta;
      });

      const sequences = new Map<string, string[]>();
      const occurrenceIds = new Set<string>();
      for (const delta of deltas) {
        const sequenceKey = `${delta.lane}:${delta.purpose}`;
        const sequence = sequences.get(sequenceKey) ?? [];
        for (const splice of delta.splices) {
          sequence.splice(
            splice.start,
            splice.deleteCount,
            ...splice.insertions.map((item) => item.occurrenceId),
          );
        }
        sequences.set(sequenceKey, sequence);
        for (const occurrenceId of sequence) occurrenceIds.add(occurrenceId);
      }

      const contentByDigest = new Map<string, string>();
      const occurrences = new Map<string, ContextOccurrenceInput>();
      for (
        const occurrence of this.#readContextItems(
          executionId,
          [...occurrenceIds],
          db,
        )
      ) {
        if (
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
          bytesBase64 = this.#coreStore().readContent(
            occurrence.contentDigest,
            db,
          ).toBase64();
          contentByDigest.set(occurrence.contentDigest, bytesBase64);
        }
        occurrences.set(metadata.occurrenceId, { ...metadata, bytesBase64 });
      }

      sequences.clear();
      const requests: ContextModelRequestRecord[] = [];
      for (const delta of deltas) {
        const sequenceKey = `${delta.lane}:${delta.purpose}`;
        const sequence = sequences.get(sequenceKey) ?? [];
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
          ...(delta.budget === undefined ? {} : { budget: delta.budget }),
          ...(delta.sourceCallId === undefined ? {} : { sourceCallId: delta.sourceCallId }),
          ...(request === undefined ? {} : { request }),
          items,
        });
      }
      // Request deltas are the durable model-context source. Startup configuration is referenced
      // through configuration_id rather than copied into a second context snapshot.
      return { relations, requests };
    } finally {
      db.close();
    }
  }

  readExecutionRequest(
    executionId: string,
    requestOrdinal: number,
  ): ContextModelRequestRecord {
    this.readExecutionMetadata(executionId);
    const db = this.#db();
    try {
      const selected = db.prepare(`
        SELECT record_id, ordinal FROM semantic_records
        WHERE execution_id=? AND kind='model_request'
          AND json_extract(payload_json, '$.event.kind')='context_observation'
          AND json_extract(payload_json, '$.event.payload.observation.kind')='model_request_delta'
          AND json_extract(payload_json, '$.event.payload.observation.delta.requestOrdinal')=?
        ORDER BY ordinal LIMIT 1
      `).get(executionId, requestOrdinal) as Row | undefined;
      if (selected === undefined) {
        throw new HistoryStoreError('history_invalid');
      }

      const rows = db.prepare(`
        SELECT record_id FROM semantic_records
        WHERE execution_id=? AND kind='model_request' AND ordinal<=?
          AND json_extract(payload_json, '$.event.kind')='context_observation'
          AND json_extract(payload_json, '$.event.payload.observation.kind')='model_request_delta'
        ORDER BY ordinal
      `).all(executionId, Number(selected.ordinal)) as Row[];
      const deltas = rows.map((row) => {
        const occurrence = this.#coreStore().readOccurrence(
          String(row.record_id),
          db,
        );
        const event = (occurrence.payload as Record<string, JsonValue>)
          .event as Record<string, JsonValue>;
        const payload = event.payload as Record<string, JsonValue>;
        const observation = payload.observation as Record<string, JsonValue>;
        const delta = observation.delta as unknown as ContextModelRequestDelta;
        return {
          requestOrdinal: delta.requestOrdinal,
          lane: delta.lane,
          purpose: delta.purpose,
          modelStep: delta.modelStep,
          ...(delta.modelSelection === undefined ? {} : { modelSelection: delta.modelSelection }),
          ...(delta.budget === undefined ? {} : { budget: delta.budget }),
          ...(delta.sourceCallId === undefined ? {} : { sourceCallId: delta.sourceCallId }),
          splices: delta.splices.map((splice) => ({
            start: splice.start,
            deleteCount: splice.deleteCount,
            insertions: splice.insertions.map((item) => ({
              occurrenceId: item.occurrenceId,
            })),
          })),
        };
      });
      const sequences = new Map<string, string[]>();
      const occurrenceIds = new Set<string>();
      for (const delta of deltas) {
        const sequenceKey = `${delta.lane}:${delta.purpose}`;
        const sequence = sequences.get(sequenceKey) ?? [];
        for (const splice of delta.splices) {
          sequence.splice(
            splice.start,
            splice.deleteCount,
            ...splice.insertions.map((item) => item.occurrenceId),
          );
        }
        sequences.set(sequenceKey, sequence);
        for (const occurrenceId of sequence) occurrenceIds.add(occurrenceId);
      }
      const selectedDelta = deltas.at(-1);
      if (selectedDelta === undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      const occurrenceById = new Map<string, {
        readonly metadata: Omit<ContextOccurrenceInput, 'bytesBase64'>;
        readonly contentDigest: string;
      }>();
      for (
        const occurrence of this.#readContextItems(
          executionId,
          [...occurrenceIds],
          db,
          Number(selected.ordinal),
        )
      ) {
        if (
          occurrence.contentDigest === undefined ||
          typeof occurrence.payload !== 'object' ||
          occurrence.payload === null || Array.isArray(occurrence.payload)
        ) continue;
        const metadata = occurrence.payload as unknown as Omit<
          ContextOccurrenceInput,
          'bytesBase64'
        >;
        if (typeof metadata.occurrenceId !== 'string') continue;
        occurrenceById.set(metadata.occurrenceId, {
          metadata,
          contentDigest: occurrence.contentDigest,
        });
      }

      const manifestRow = db.prepare(
        'SELECT manifest_json FROM execution_contexts WHERE execution_id=?',
      ).get(executionId) as Row | undefined;
      const manifest = manifestRow === undefined
        ? undefined
        : parseJson<{ externalRelations?: readonly unknown[] }>(
          manifestRow.manifest_json,
        );
      let relationOrdinal = manifest?.externalRelations?.length ?? 0;
      let selectedItems: ContextModelRequestRecord['items'] = [];
      const contentByDigest = new Map<string, string>();
      sequences.clear();
      for (const delta of deltas) {
        const sequenceKey = `${delta.lane}:${delta.purpose}`;
        const sequence = sequences.get(sequenceKey) ?? [];
        for (const splice of delta.splices) {
          sequence.splice(
            splice.start,
            splice.deleteCount,
            ...splice.insertions.map((item) => item.occurrenceId),
          );
        }
        sequences.set(sequenceKey, sequence);
        if (delta !== selectedDelta) {
          for (const occurrenceId of sequence) {
            const occurrence = occurrenceById.get(occurrenceId);
            if (occurrence === undefined) {
              throw new HistoryStoreError('history_invalid');
            }
            relationOrdinal += occurrence.metadata.sourceRelations.length;
          }
          continue;
        }
        selectedItems = sequence.map((occurrenceId, ordinal) => {
          const occurrence = occurrenceById.get(occurrenceId);
          if (occurrence === undefined) {
            throw new HistoryStoreError('history_invalid');
          }
          const relationOrdinals = occurrence.metadata.sourceRelations.map(() => ++relationOrdinal);
          let bytesBase64 = contentByDigest.get(occurrence.contentDigest);
          if (bytesBase64 === undefined) {
            bytesBase64 = this.#coreStore().readContent(
              occurrence.contentDigest,
              db,
            ).toBase64();
            contentByDigest.set(occurrence.contentDigest, bytesBase64);
          }
          return {
            ordinal,
            ...occurrence.metadata,
            bytesBase64,
            relationOrdinals,
          };
        });
      }

      const decoded = selectedItems.map((item) => {
        if (item.bytesBase64 === undefined) return undefined;
        try {
          return decoder.decode(Uint8Array.fromBase64(item.bytesBase64));
        } catch {
          throw new HistoryStoreError('history_invalid');
        }
      });
      const systemIndex = selectedItems.findIndex((item) => item.kind === 'system');
      const request = selectedDelta.purpose === 'user_turn'
        ? {
          ...(systemIndex < 0 || decoded[systemIndex] === undefined
            ? {}
            : { systemInstruction: decoded[systemIndex] }),
          transcript: selectedItems.flatMap((item, index) =>
            item.kind === 'message' && decoded[index] !== undefined
              ? [JSON.parse(decoded[index]!) as Message]
              : []
          ),
          tools: selectedItems.flatMap((item, index) =>
            item.kind === 'tool_contract' && decoded[index] !== undefined
              ? [JSON.parse(decoded[index]!)]
              : []
          ),
        }
        : undefined;
      return {
        requestOrdinal: selectedDelta.requestOrdinal,
        lane: selectedDelta.lane,
        purpose: selectedDelta.purpose,
        modelStep: selectedDelta.modelStep,
        ...('modelSelection' in selectedDelta === false
          ? {}
          : { modelSelection: selectedDelta.modelSelection }),
        ...('budget' in selectedDelta === false ||
            selectedDelta.budget === undefined
          ? {}
          : { budget: selectedDelta.budget }),
        ...('sourceCallId' in selectedDelta === false
          ? {}
          : { sourceCallId: selectedDelta.sourceCallId }),
        ...(request === undefined ? {} : { request }),
        items: selectedItems,
      };
    } finally {
      db.close();
    }
  }

  readExecutionRequestFacts(
    executionId: string,
    requestOrdinal: number,
  ): readonly StoredExecutionEvent[] {
    this.readExecutionMetadata(executionId);
    const db = this.#db();
    try {
      const startRows = db.prepare(`
        SELECT record_id FROM semantic_records
        WHERE execution_id=? AND kind='model_request'
          AND json_extract(payload_json, '$.event.kind')='provider_request_start'
          AND json_extract(payload_json, '$.event.payload.observation.request.contextRequestOrdinal')=?
        ORDER BY ordinal
      `).all(executionId, requestOrdinal) as Row[];
      const providerOrdinals = new Set<number>();
      for (const row of startRows) {
        const occurrence = this.#coreStore().readOccurrence(
          String(row.record_id),
          db,
        );
        const event = (occurrence.payload as Record<string, JsonValue>)
          .event as Record<string, JsonValue>;
        const payload = event.payload as Record<string, JsonValue>;
        const observation = payload.observation as Record<string, JsonValue>;
        const request = observation.request as Record<string, JsonValue>;
        if (typeof request.ordinal === 'number') {
          providerOrdinals.add(request.ordinal);
        }
      }
      if (providerOrdinals.size === 0) return [];
      const rows = db.prepare(`
        SELECT record_id FROM semantic_records
        WHERE execution_id=? AND kind='model_request'
          AND json_extract(payload_json, '$.event.kind') IN (
            'provider_request_start', 'provider_response_start',
            'provider_request_usage', 'provider_parser_transition',
            'provider_request_failure'
          )
          AND CASE
            WHEN json_extract(payload_json, '$.event.kind')='provider_request_start'
            THEN json_extract(payload_json, '$.event.payload.observation.request.ordinal')
            ELSE json_extract(payload_json, '$.event.payload.observation.requestOrdinal')
          END IN (SELECT value FROM json_each(?))
        ORDER BY ordinal
      `).all(executionId, JSON.stringify([...providerOrdinals])) as Row[];
      return rows.flatMap((row) => {
        const occurrence = this.#coreStore().readOccurrence(
          String(row.record_id),
          db,
        );
        const event = (occurrence.payload as Record<string, JsonValue>).event;
        return typeof event === 'object' && event !== null &&
            !Array.isArray(event)
          ? [structuredClone(event) as unknown as StoredExecutionEvent]
          : [];
      });
    } finally {
      db.close();
    }
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
    const admissionDb = snapshotDb ?? this.#db();
    let admission: HistorySemanticOccurrence | undefined;
    try {
      const row = admissionDb.prepare(`
        SELECT record_id FROM semantic_records
        WHERE execution_id=? AND kind='execution_admission'
        ORDER BY ordinal LIMIT 1
      `).get(executionId) as Row | undefined;
      admission = row === undefined
        ? undefined
        : this.#coreStore().readOccurrence(String(row.record_id), admissionDb);
    } finally {
      if (snapshotDb === undefined) admissionDb.close();
    }
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

    const metadata = this.#readLatestExecutionMetadata(
      executionId,
      snapshotDb,
    ) as Record<string, unknown> | undefined;
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
      db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048;');
      db.exec('BEGIN');
      yield* this.#streamHumanHistoryExportRecords(sessionId, db);
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

  #historyExportExecutionIds(
    sessionId: string,
    db: DatabaseSync,
  ): Generator<string> {
    return (function* (): Generator<string> {
      for (
        const row of db.prepare(`
          SELECT execution_id FROM executions
          WHERE session_correlation=?
          ORDER BY turn_number, created_at, execution_id
        `).iterate(sessionId) as Iterable<Row>
      ) yield String(row.execution_id);
      for (
        const row of db.prepare(`
          SELECT e.execution_id FROM executions e
          WHERE e.parent_execution_id IN (
            SELECT execution_id FROM executions WHERE session_correlation=?
          ) AND NOT EXISTS (
            SELECT 1 FROM executions d
            WHERE d.execution_id=e.execution_id AND d.session_correlation=?
          )
          ORDER BY e.turn_number, e.created_at, e.execution_id
        `).iterate(sessionId, sessionId) as Iterable<Row>
      ) yield String(row.execution_id);
    })();
  }

  *#streamHumanHistoryExportRecords(
    sessionId: string,
    db: DatabaseSync,
  ): Generator<HumanHistoryExportRecordV1> {
    const session = db.prepare('SELECT * FROM sessions WHERE session_id=?')
      .get(sessionId) as Row | undefined;
    if (session === undefined) throw new HistoryStoreError('history_invalid');
    const tail = db.prepare(`
        SELECT execution_id FROM executions WHERE session_correlation=?
        ORDER BY turn_number DESC, created_at DESC, execution_id DESC LIMIT 1
      `).get(sessionId) as Row | undefined;
    db.exec(`
      CREATE TEMP TABLE history_export_emitted_contents (
        content_digest TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      CREATE TEMP TABLE history_exported_configurations (
        configuration_id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
    `);
    const markContentEmitted = db.prepare(`
      INSERT OR IGNORE INTO temp.history_export_emitted_contents(content_digest)
      VALUES (?)
    `);
    const markConfigurationExported = db.prepare(`
      INSERT OR IGNORE INTO temp.history_exported_configurations(configuration_id)
      VALUES (?)
    `);
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
      if (markContentEmitted.run(digest).changes === 0) return undefined;
      const bytes = this.#coreStore().readContent(digest, db);
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
      tail: tail === undefined ? null : { executionId: String(tail.execution_id) },
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
    for (const executionId of this.#historyExportExecutionIds(sessionId, db)) {
      const executionRow = db.prepare(
        'SELECT configuration_id FROM executions WHERE execution_id=?',
      ).get(executionId) as Row | undefined;
      if (
        executionRow?.configuration_id === null ||
        executionRow?.configuration_id === undefined
      ) continue;
      const configurationId = String(executionRow.configuration_id);
      if (markConfigurationExported.run(configurationId).changes === 0) {
        continue;
      }
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
    for (const executionId of this.#historyExportExecutionIds(sessionId, db)) {
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
  }
}
