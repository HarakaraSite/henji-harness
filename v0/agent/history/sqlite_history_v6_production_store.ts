import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import type {
  JsonValue,
  LoopOutcome,
  Message,
  ProviderExactRequestObservation,
} from '../core/contracts.ts';
import type {
  ProviderEvidenceObservation,
  ProviderEvidenceParserTransition,
  ProviderEvidenceRequest,
  ProviderEvidenceRequestRecord,
  ProviderEvidenceRuntimeEvent,
  ProviderEvidenceSseEvent,
  ProviderEvidenceStore,
  ProviderEvidenceV5,
  StoredProviderEvidence,
} from '../provider/provider_evidence.ts';
import {
  validateProviderEvidence,
  validateProviderEvidenceObservation,
} from '../provider/provider_evidence.ts';
import { ProviderEvidenceStoreError } from '../provider/provider_evidence_store.ts';
import { isStoredModelSelection } from '../provider/model_selection.ts';
import {
  encodeFailureDiagnostic,
  type FailureDiagnosticV1,
  validateFailureDiagnostic,
} from '../session/failure_diagnostic.ts';
import {
  type FailureDiagnosticStore,
  FailureDiagnosticStoreError,
} from '../session/failure_diagnostic_store.ts';
import {
  decodeSemanticContextCheckpoint,
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
import type { DefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';
import {
  type StoredWorkerExecutionArtifact,
  validateWorkerExecutionArtifact,
  type WorkerExecutionArtifactV7,
} from '../worker/worker_execution_artifact.ts';
import {
  type WorkerExecutionArtifactStore,
  WorkerExecutionArtifactStoreError,
} from '../worker/worker_execution_artifact_store.ts';
import type {
  WorkerProviderObservationMessage,
  WorkerToHostMessage,
} from '../worker/worker_protocol.ts';
import {
  type BeginExecutionInput,
  type CanonicalTurnCommitInput,
  type ExecutionEventInput,
  type HistoryCaptureResult,
  type HistoryPersistencePort,
  HistoryStoreError,
  type NonCanonicalExecutionInput,
  type ReconcileExecutionInput,
  type StoredExecutionEffect,
  type StoredExecutionEvent,
  type StoredExecutionRow,
} from './history_store_contract.ts';
import {
  chunkHumanHistoryDetail,
  HUMAN_HISTORY_DETAIL_SCALARS,
  HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
  HUMAN_HISTORY_PAGE_EXECUTIONS,
  type HumanHistoryCursorV1,
  type HumanHistoryDetailChunkV1,
  type HumanHistoryEntryV1,
  type HumanHistoryExportRecordV1,
  type HumanHistoryPageRequest,
  type HumanHistoryPageV1,
  type HumanHistoryReadPort,
  type HumanHistorySearchHitV1,
  type HumanHistorySearchRequest,
  projectHumanHistoryExecution,
} from './human_history.ts';
import { IsolatedV6HistoryPipeline } from './v6_history_pipeline.ts';
import { exactByteDigest } from './exact_byte_plan.ts';
import {
  type HistoryV6ExecutionMessageInput,
  type HistoryV6SessionStateInput,
  SqliteHistoryV6Store,
} from './sqlite_history_v6_store.ts';

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const jsonBytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const parseJson = <T>(bytes: Uint8Array): T => JSON.parse(decoder.decode(bytes)) as T;
const now = (): string => new Date().toISOString();
const compactOutcome = (outcome: LoopOutcome): LoopOutcome => ({
  ...outcome,
  transcript: [],
});
const HUMAN_CURSOR_PREFIX = 'h1:';
const encodeHumanCursor = (cursor: HumanHistoryCursorV1): string =>
  `${HUMAN_CURSOR_PREFIX}${btoa(JSON.stringify(cursor))}`;
const decodeHumanCursor = (
  value: string | undefined,
): HumanHistoryCursorV1 | undefined => {
  if (value === undefined || !value.startsWith(HUMAN_CURSOR_PREFIX)) {
    return undefined;
  }
  try {
    const cursor = JSON.parse(
      atob(value.slice(HUMAN_CURSOR_PREFIX.length)),
    ) as HumanHistoryCursorV1;
    return cursor.schemaVersion === 1 && Number.isSafeInteger(cursor.turn) &&
        cursor.turn >= 1 &&
        typeof cursor.createdAt === 'string' && isSessionId(cursor.executionId)
      ? cursor
      : undefined;
  } catch {
    return undefined;
  }
};
const humanCursorFor = (row: StoredExecutionRow): HumanHistoryCursorV1 => ({
  schemaVersion: 1,
  turn: row.turn,
  createdAt: row.createdAt,
  executionId: row.executionId,
});
const scalarMatchOffsets = (text: string, query: string): readonly number[] => {
  const source = [...text];
  const needle = [...query];
  const offsets: number[] = [];
  if (needle.length === 0 || needle.length > source.length) return offsets;
  for (let offset = 0; offset <= source.length - needle.length; offset += 1) {
    if (needle.every((scalar, index) => source[offset + index] === scalar)) {
      offsets.push(offset);
    }
  }
  return offsets;
};

const asHistoryError = (error: unknown): HistoryStoreError =>
  error instanceof HistoryStoreError ? error : new HistoryStoreError('history_io_failure');

const asSessionError = (error: unknown): SessionStoreError =>
  error instanceof SessionStoreError ? error : new SessionStoreError('session_io_failure');

const executionMetadata = (input: BeginExecutionInput): string =>
  JSON.stringify({
    taskId: input.taskId,
    task: input.task,
    canonicalSessionId: input.canonicalSessionId,
    sessionCorrelation: input.sessionCorrelation,
    turn: input.turn,
    createdAt: input.createdAt,
    baseStateRevision: input.baseStateRevision,
    agent: input.agent,
    model: input.model,
    build: input.build,
    definition: input.definition,
    manifest: input.manifest,
    instanceCorrelation: input.instanceCorrelation,
    workerGeneration: input.workerGeneration,
    contextSnapshot: input.contextSnapshot,
  });

type ExecutionMetadata = Omit<
  BeginExecutionInput,
  'sessionMode' | 'sessionRecord'
>;

/**
 * Production facade for the v6 authority. Compatibility ports are projections over v6 records;
 * no v5 database, schema, migration, or fallback is opened from this class.
 */
export class SqliteHistoryV6ProductionStore
  implements WorkerSessionStorePort, HistoryPersistencePort, HumanHistoryReadPort {
  readonly providerEvidence: ProviderEvidenceStore;
  readonly executionArtifacts: WorkerExecutionArtifactStore;
  readonly diagnostics: FailureDiagnosticStore;
  readonly #makeUuid: () => string;
  readonly #pipelines = new Map<string, IsolatedV6HistoryPipeline>();
  readonly #eventCounts = new Map<string, number>();
  readonly #executionLocks = new Map<string, Lock>();
  #databasePath?: string;
  #locksPath?: string;
  #core?: SqliteHistoryV6Store;

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
    options: Readonly<{ uuid?: () => string }> = {},
  ) {
    if (!stateRoot.startsWith('/') || stateRoot.includes('\0')) {
      throw new SessionStoreError('session_io_failure');
    }
    this.#makeUuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
    this.providerEvidence = new V6ProviderEvidenceAdapter(this);
    this.executionArtifacts = new V6ExecutionArtifactAdapter(this);
    this.diagnostics = new V6DiagnosticAdapter(this);
  }

  async initialize(): Promise<void> {
    if (this.#core !== undefined) return;
    const digest = await workspaceDigest(this.workspaceRoot);
    const root = `${this.stateRoot}/${digest}`;
    await ensureDirectory(root, 0o700);
    await ensureDirectory(`${root}/locks-v6`, 0o700);
    this.#databasePath = `${root}/history-v6.sqlite3`;
    this.#locksPath = `${root}/locks-v6`;
    this.#core = new SqliteHistoryV6Store(this.#databasePath);
    const activeDb = this.#db();
    const active = activeDb.prepare(`
      SELECT execution_id, session_id, metadata_json FROM executions
      WHERE lifecycle = 'active' ORDER BY created_at
    `).all() as Row[];
    activeDb.close();
    for (const row of active) {
      const metadata = JSON.parse(
        String(row.metadata_json),
      ) as ExecutionMetadata;
      const lockPath = metadata.canonicalSessionId === undefined
        ? `${this.#locksPath}/.execution-${String(row.execution_id)}.lock`
        : `${this.#locksPath}/${String(row.session_id)}.lock`;
      let lock: Lock | undefined;
      try {
        lock = await acquireLock(lockPath);
      } catch (error) {
        if (
          error instanceof SessionStoreError && error.code === 'session_busy'
        ) continue;
        throw error;
      }
      try {
        this.reconcileExecution({
          executionId: String(row.execution_id),
          settlement: 'interrupted',
        });
      } finally {
        lock.close();
      }
    }
  }

  #coreStore(): SqliteHistoryV6Store {
    if (this.#core === undefined) {
      throw new HistoryStoreError('history_io_failure');
    }
    return this.#core;
  }

  #db(): DatabaseSync {
    if (this.#databasePath === undefined) {
      throw new HistoryStoreError('history_io_failure');
    }
    const db = new DatabaseSync(this.#databasePath);
    db.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 250;',
    );
    return db;
  }

  #pipeline(executionId: string): IsolatedV6HistoryPipeline {
    let pipeline = this.#pipelines.get(executionId);
    if (pipeline === undefined) {
      pipeline = new IsolatedV6HistoryPipeline(this.#coreStore(), executionId);
      this.#pipelines.set(executionId, pipeline);
      this.#eventCounts.set(
        executionId,
        this.#historyEvents(executionId).length,
      );
    }
    return pipeline;
  }

  #sessionState(
    record: StoredSessionRecord,
    executionId?: string,
  ): HistoryV6SessionStateInput {
    if (
      record.sessionId === '' || record.workspaceRoot !== this.workspaceRoot ||
      (record.agent !== 'default' && record.agent !== 'planner')
    ) {
      throw new SessionStoreError('session_invalid');
    }
    const db = this.#db();
    let messageCount = 0;
    let modelChangeCount = 0;
    let turnCount = 0;
    try {
      const row = db.prepare(`
        SELECT message_count, model_change_count, turn_count
        FROM sessions WHERE session_id=?
      `).get(record.sessionId) as Row | undefined;
      if (row === undefined) {
        messageCount = 0;
        modelChangeCount = 0;
        turnCount = 0;
      } else {
        messageCount = Number(row.message_count);
        modelChangeCount = Number(row.model_change_count);
        turnCount = Number(row.turn_count);
      }
    } finally {
      db.close();
    }
    if (
      messageCount > record.transcript.length ||
      modelChangeCount > record.modelChanges.length ||
      turnCount > record.turnModels.length ||
      turnCount > record.turnExecutions.length
    ) throw new SessionStoreError('session_invalid');
    const messageTurn = record.nextTurn - 1;
    if (messageCount < record.transcript.length && messageTurn < 1) {
      throw new SessionStoreError('session_invalid');
    }
    return {
      sessionId: record.sessionId,
      workspaceRoot: record.workspaceRoot,
      stateRevision: record.stateRevision,
      agent: record.agent,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      title: record.title,
      nextTurn: record.nextTurn,
      definitionJson: JSON.stringify(record.definition),
      activeModelJson: JSON.stringify(record.activeModel),
      expectedMessageCount: messageCount,
      messages: record.transcript.slice(messageCount).map((
        message,
        offset,
      ) => ({
        ordinal: messageCount + offset,
        turn: messageTurn,
        json: JSON.stringify(message),
      })),
      expectedModelChangeCount: modelChangeCount,
      modelChanges: record.modelChanges.slice(modelChangeCount).map((
        change,
        offset,
      ) => ({
        ordinal: modelChangeCount + offset,
        effectiveFromTurn: change.effectiveFromTurn,
        changedAt: change.changedAt,
        selectionJson: JSON.stringify(change.selection),
      })),
      expectedTurnCount: turnCount,
      turns: record.turnModels.slice(turnCount).map((turnModel, offset) => {
        const turnExecution = record.turnExecutions[turnCount + offset];
        if (
          turnExecution === undefined || turnExecution.turn !== turnModel.turn
        ) {
          throw new SessionStoreError('session_invalid');
        }
        return {
          ordinal: turnCount + offset,
          turn: turnModel.turn,
          modelJson: JSON.stringify(turnModel.selection),
          buildJson: JSON.stringify(turnExecution.build),
          definitionJson: JSON.stringify(turnExecution.definition),
          ...(executionId === undefined ||
              turnModel.turn !== record.nextTurn - 1
            ? {}
            : { executionId }),
        };
      }),
    };
  }

  #writeSession(record: StoredSessionRecord): void {
    this.#coreStore().writeSessionState(this.#sessionState(record));
  }

  #decodeMessageRow(row: Row): Message {
    const encoded = row.encoded_bytes as Uint8Array;
    if (exactByteDigest(encoded) !== row.representation_digest) {
      throw new SessionStoreError('session_invalid');
    }
    const raw = new Uint8Array(brotliDecompressSync(encoded));
    if (exactByteDigest(raw) !== row.logical_digest) {
      throw new SessionStoreError('session_invalid');
    }
    return JSON.parse(decoder.decode(raw)) as Message;
  }

  #replaceSession(record: StoredSessionRecord): void {
    this.#coreStore().replaceSessionState({
      ...this.#sessionStateForCounts(record, {
        messages: record.transcript.length,
        modelChanges: record.modelChanges.length,
        turns: record.turnModels.length,
      }),
      messages: [],
      modelChanges: [],
      turns: [],
    });
  }

  #sessionStateForCounts(
    record: StoredSessionRecord,
    counts: Readonly<{ messages: number; modelChanges: number; turns: number }>,
  ): HistoryV6SessionStateInput {
    return {
      sessionId: record.sessionId,
      workspaceRoot: record.workspaceRoot,
      stateRevision: record.stateRevision,
      agent: record.agent,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      title: record.title,
      nextTurn: record.nextTurn,
      definitionJson: JSON.stringify(record.definition),
      activeModelJson: JSON.stringify(record.activeModel),
      expectedMessageCount: counts.messages,
      messages: [],
      expectedModelChangeCount: counts.modelChanges,
      modelChanges: [],
      expectedTurnCount: counts.turns,
      turns: [],
    };
  }

  #readSession(db: DatabaseSync, id: string): StoredSessionRecord {
    const row = db.prepare(`
      SELECT * FROM sessions WHERE session_id=? AND workspace_root IS NOT NULL
    `).get(id) as Row | undefined;
    if (row === undefined) throw new SessionStoreError('session_not_found');
    const transcript = (db.prepare(`
      SELECT logical_digest, representation_digest, encoded_bytes
      FROM session_messages WHERE session_id=? ORDER BY message_ordinal
    `).all(id) as Row[]).map((messageRow) => this.#decodeMessageRow(messageRow));
    const modelChanges = (db.prepare(`
      SELECT effective_from_turn, changed_at, selection_json
      FROM session_model_changes WHERE session_id=? ORDER BY change_ordinal
    `).all(id) as Row[]).map((change) => ({
      effectiveFromTurn: Number(change.effective_from_turn),
      changedAt: String(change.changed_at),
      selection: JSON.parse(String(change.selection_json)),
    }));
    const turns = db.prepare(`
      SELECT turn, model_json, build_json, definition_json
      FROM session_turns WHERE session_id=? ORDER BY turn_ordinal
    `).all(id) as Row[];
    const record: StoredSessionRecord = {
      schemaVersion: 6,
      sessionId: id,
      workspaceRoot: String(row.workspace_root),
      agent: String(row.agent) as SessionRecord['agent'],
      createdAt: String(row.created_at_session),
      updatedAt: String(row.updated_at),
      title: row.title === null ? null : String(row.title),
      stateRevision: Number(row.state_revision),
      nextTurn: Number(row.next_turn),
      transcript,
      definition: JSON.parse(String(row.definition_json)),
      activeModel: JSON.parse(String(row.active_model_json)),
      modelChanges,
      turnModels: turns.map((turn) => ({
        turn: Number(turn.turn),
        selection: JSON.parse(String(turn.model_json)),
      })),
      turnExecutions: turns.map((turn) => ({
        turn: Number(turn.turn),
        build: JSON.parse(String(turn.build_json)),
        definition: JSON.parse(String(turn.definition_json)),
      })),
    };
    if (!validateSessionRecordV6(record)) {
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
        'SELECT checkpoint_bytes FROM sessions WHERE session_id=?',
      ).get(id) as
        | Row
        | undefined;
      return row?.checkpoint_bytes instanceof Uint8Array
        ? decodeSemanticContextCheckpoint(row.checkpoint_bytes)
        : undefined;
    } finally {
      db.close();
    }
  }

  async listWorker(): Promise<WorkerSessionListResult> {
    await this.initialize();
    const db = this.#db();
    try {
      const rows = db.prepare(`
        SELECT session_id, agent, created_at_session, updated_at, title, next_turn,
          definition_json, active_model_json, message_count
        FROM sessions WHERE workspace_root IS NOT NULL
        ORDER BY updated_at DESC, session_id
      `).all() as Row[];
      const sessions: WorkerSessionMetadata[] = [];
      let skippedInvalid = 0;
      for (const row of rows) {
        try {
          const id = String(row.session_id);
          const agent = String(row.agent);
          const nextTurn = Number(row.next_turn);
          const messageCount = Number(row.message_count);
          const definition = JSON.parse(String(row.definition_json));
          const modelSelection = JSON.parse(String(row.active_model_json));
          if (
            !isSessionId(id) || (agent !== 'default' && agent !== 'planner') ||
            !Number.isSafeInteger(nextTurn) || nextTurn < 1 ||
            !Number.isSafeInteger(messageCount) || messageCount < 0 ||
            !validRevisionRef(definition) ||
            !isStoredModelSelection(modelSelection)
          ) throw new Error('invalid session metadata');
          sessions.push({
            id,
            agent,
            createdAt: String(row.created_at_session),
            updatedAt: String(row.updated_at),
            ...(row.title === null ? {} : { title: String(row.title) }),
            turnCount: nextTurn - 1,
            messageCount,
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
    ) {
      throw new SessionStoreError('session_invalid');
    }
    const listed = await this.listWorker();
    if (listed.sessions.length >= MAX_VALID_SESSIONS_PER_WORKSPACE) {
      throw new SessionStoreError('session_limit');
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.#makeUuid();
      if (!isSessionId(id)) continue;
      try {
        const lock = await acquireLock(`${this.#locksPath!}/${id}.lock`);
        return this.#handle(id, agent, undefined, undefined, lock);
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
    const lock = await acquireLock(`${this.#locksPath!}/${id}.lock`);
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
    const lock = await acquireLock(`${this.#locksPath!}/${id}.lock`);
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const found = db.prepare(
        'SELECT 1 FROM sessions WHERE session_id=? AND workspace_root IS NOT NULL',
      ).get(id);
      if (found === undefined) throw new SessionStoreError('session_not_found');
      db.prepare('DELETE FROM executions WHERE session_id=?').run(id);
      db.prepare('DELETE FROM sessions WHERE session_id=?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The failing statement may have rolled the transaction back already.
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
        if (
          next.sessionId !== id || next.workspaceRoot !== this.workspaceRoot ||
          next.agent !== agent
        ) {
          throw new SessionStoreError('session_invalid');
        }
        rollbackRecord = record;
        this.#writeSession(next);
        record = structuredClone(next);
      },
      acceptCommitted: (next) => {
        if (closed || next.sessionId !== id || !validateSessionRecordV6(next)) {
          throw new SessionStoreError(
            closed ? 'session_busy' : 'session_invalid',
          );
        }
        rollbackRecord = record;
        record = structuredClone(next);
      },
      rollback: () => {
        if (closed || record === rollbackRecord) return;
        if (rollbackRecord !== undefined) this.#replaceSession(rollbackRecord);
        else {
          const db = this.#db();
          try {
            db.prepare('DELETE FROM sessions WHERE session_id=?').run(id);
          } finally {
            db.close();
          }
        }
        record = rollbackRecord;
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
          db.prepare(
            'UPDATE sessions SET checkpoint_bytes=? WHERE session_id=?',
          ).run(
            encodeSemanticContextCheckpoint(next),
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
          db.prepare(
            'UPDATE sessions SET checkpoint_bytes=? WHERE session_id=?',
          ).run(
            rollbackCheckpoint === undefined
              ? null
              : encodeSemanticContextCheckpoint(rollbackCheckpoint),
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

  async beginExecution(input: BeginExecutionInput): Promise<void> {
    await this.initialize();
    try {
      if (input.canonicalSessionId === undefined) {
        const lock = await acquireLock(
          `${this.#locksPath}/.execution-${input.executionId}.lock`,
        );
        this.#executionLocks.set(input.executionId, lock);
      }
      if (input.sessionRecord !== undefined) {
        this.#writeSession(input.sessionRecord);
      }
      const authoritySession = input.canonicalSessionId ??
        `detached:${input.sessionCorrelation}`;
      this.#coreStore().beginExecution(
        input.executionId,
        authoritySession,
        input.baseStateRevision,
        input.workerGeneration ?? input.instanceCorrelation ??
          input.executionId,
        { json: executionMetadata(input), createdAt: input.createdAt },
        input.sessionRecord?.transcript.length ?? 0,
        input.sessionCorrelation,
        input.turn,
      );
      this.#pipelines.set(
        input.executionId,
        new IsolatedV6HistoryPipeline(this.#coreStore(), input.executionId),
      );
      this.#eventCounts.set(input.executionId, 0);
      this.appendExecutionEvents([
        {
          executionId: input.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'execution_admitted',
          payload: {
            taskId: input.taskId,
            executionId: input.executionId,
            sessionCorrelation: input.sessionCorrelation,
            turn: input.turn,
            task: input.task,
          },
        },
        {
          executionId: input.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'turn_dispatch_requested',
          payload: { task: input.task },
        },
      ]);
    } catch (error) {
      this.#releaseExecutionLock(input.executionId);
      throw asHistoryError(error);
    }
  }

  #releaseExecutionLock(executionId: string): void {
    const lock = this.#executionLocks.get(executionId);
    if (lock === undefined) return;
    this.#executionLocks.delete(executionId);
    lock.close();
  }

  prepareWorkerObservationForHistory(
    message: WorkerToHostMessage,
  ): WorkerToHostMessage {
    if (message.kind === 'commit_proposal') {
      const { providerEvidence: _providerEvidence, ...bounded } = message;
      return {
        ...bounded,
        transcript: [],
        ...(message.outcome === undefined ? {} : { outcome: compactOutcome(message.outcome) }),
      };
    }
    if (message.kind === 'turn_failed') {
      const { providerEvidence: _providerEvidence, ...bounded } = message;
      return { ...bounded, outcome: compactOutcome(message.outcome) };
    }
    return message;
  }

  #boundedEventPayload(input: ExecutionEventInput): JsonValue {
    const payload = input.payload as unknown as Record<string, unknown>;
    if (input.kind === 'runtime_event' && payload.kind === 'commit_proposal') {
      const { providerEvidence: _providerEvidence, ...bounded } = payload;
      const outcome = payload.outcome as LoopOutcome | undefined;
      return structuredClone({
        ...bounded,
        transcript: [],
        ...(outcome === undefined ? {} : { outcome: compactOutcome(outcome) }),
      }) as unknown as JsonValue;
    }
    if (input.kind === 'runtime_event' && payload.kind === 'turn_failed') {
      const { providerEvidence: _providerEvidence, ...bounded } = payload;
      const outcome = payload.outcome as LoopOutcome | undefined;
      return structuredClone({
        ...bounded,
        ...(outcome === undefined ? {} : { outcome: compactOutcome(outcome) }),
      }) as unknown as JsonValue;
    }
    return structuredClone(input.payload) as JsonValue;
  }

  validateExecutionEvent(input: ExecutionEventInput): boolean {
    try {
      return !!input.executionId && !!input.kind &&
        JSON.stringify(this.#boundedEventPayload(input)) !== undefined;
    } catch {
      return false;
    }
  }

  appendExactRequestObservation(
    input: Readonly<{
      executionId: string;
      workerSequence: number;
      observation: ProviderExactRequestObservation;
    }>,
  ): void {
    try {
      this.#pipeline(input.executionId).observeExactRequest(input.observation);
    } catch (error) {
      throw asHistoryError(error);
    }
  }

  appendExecutionEvent(input: ExecutionEventInput): StoredExecutionEvent {
    const result = this.appendExecutionEvents([input])[0];
    if (result === undefined) throw new HistoryStoreError('history_invalid');
    return result;
  }

  appendExecutionEvents(
    inputs: readonly ExecutionEventInput[],
  ): readonly StoredExecutionEvent[] {
    if (inputs.length === 0) return [];
    const output: StoredExecutionEvent[] = [];
    const nextEventCounts = new Map<string, number>();
    const touchedPipelines = new Set<IsolatedV6HistoryPipeline>();
    try {
      for (const input of inputs) {
        if (!this.validateExecutionEvent(input)) {
          throw new HistoryStoreError('history_invalid');
        }
        const ordinal = (nextEventCounts.get(input.executionId) ??
          this.#eventCounts.get(input.executionId) ?? 0) + 1;
        const payload = this.#boundedEventPayload(input);
        const event: StoredExecutionEvent = {
          executionId: input.executionId,
          ordinal,
          observedAt: input.observedAt ?? now(),
          direction: input.direction,
          source: input.source,
          kind: input.kind,
          ...(input.workerSequence === undefined ? {} : { workerSequence: input.workerSequence }),
          payload,
        };
        const pipeline = this.#pipeline(input.executionId);
        touchedPipelines.add(pipeline);
        const providerMessage = input.payload as unknown as Partial<
          WorkerProviderObservationMessage
        >;
        if (
          providerMessage.kind === 'provider_observation' &&
          providerMessage.observation !== undefined
        ) {
          pipeline.observeProviderObservation(
            providerMessage.observation as ProviderEvidenceObservation,
            event,
          );
        } else if (input.kind === 'context_observation') {
          const payload = input.payload as unknown as {
            readonly observation?: {
              readonly kind?: string;
              readonly delta?: import('./context_attribution.ts').ContextModelRequestDelta;
            };
          };
          if (
            payload.observation?.kind !== 'model_request_delta' ||
            payload.observation.delta === undefined
          ) throw new HistoryStoreError('history_invalid');
          pipeline.observeContextDelta(payload.observation.delta, event);
        } else {
          pipeline.observeStoredEvent(
            event,
            input.kind === 'execution_settled' ||
              input.kind === 'execution_reconciled',
          );
        }
        nextEventCounts.set(input.executionId, ordinal);
        output.push(event);
      }
      for (const pipeline of touchedPipelines) pipeline.flush();
      for (const [executionId, count] of nextEventCounts) {
        this.#eventCounts.set(executionId, count);
      }
      return output;
    } catch (error) {
      throw asHistoryError(error);
    }
  }

  #historyEvents(executionId: string): readonly StoredExecutionEvent[] {
    const events: StoredExecutionEvent[] = [];
    for (const metadata of this.#coreStore().listRecordMetadata(executionId)) {
      const record = this.#coreStore().readRecord(metadata.recordId);
      const payload = record.payload;
      if (
        typeof payload !== 'object' || payload === null ||
        Array.isArray(payload)
      ) continue;
      const value = (payload as Record<string, JsonValue>).historyEvent;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue;
      }
      let event = structuredClone(value) as unknown as StoredExecutionEvent;
      const eventPayload = event.payload as unknown as Record<string, unknown>;
      if (
        eventPayload.kind === 'provider_observation' &&
        eventPayload.observation === undefined
      ) {
        const occurrence = payload as Record<string, JsonValue>;
        let observation: ProviderEvidenceObservation | undefined;
        if (occurrence.occurrence === 'request_start') {
          observation = {
            kind: 'request_start',
            request: occurrence.request as unknown as Extract<
              ProviderEvidenceObservation,
              { kind: 'request_start' }
            >['request'],
          };
        } else if (occurrence.occurrence === 'response_start') {
          observation = {
            kind: 'response_start',
            requestOrdinal: Number(occurrence.requestOrdinal),
            response: {
              status: Number(occurrence.status),
              headers: occurrence.headers as Readonly<Record<string, string>>,
            },
          };
        } else if (occurrence.occurrence === 'response_bytes') {
          const bytes = this.#coreStore().readExactObject(record.objectRefs[0]);
          observation = {
            kind: 'response_bytes',
            requestOrdinal: Number(occurrence.requestOrdinal),
            offset: Number(occurrence.endOffset),
            bytesBase64: bytes.toBase64(),
          };
        } else if (occurrence.occurrence === 'sse_event') {
          const bytes = this.#coreStore().readExactObject(record.objectRefs[0]);
          observation = {
            kind: 'sse_event',
            requestOrdinal: Number(occurrence.requestOrdinal),
            event: {
              ordinal: Number(occurrence.eventOrdinal),
              data: String(occurrence.data),
              rawFrame: decoder.decode(bytes),
              rawFrameBytes: Number(occurrence.rawFrameBytes),
              responseBodyOffset: Number(occurrence.responseBodyOffset),
              ...(occurrence.parsed === undefined ? {} : { parsed: occurrence.parsed }),
            },
          };
        } else if (occurrence.occurrence === 'parser_transition') {
          observation = {
            kind: 'parser_transition',
            requestOrdinal: Number(occurrence.requestOrdinal),
            transition: occurrence.transition as unknown as Extract<
              ProviderEvidenceObservation,
              { kind: 'parser_transition' }
            >['transition'],
          };
        } else if (occurrence.occurrence === 'runtime_event') {
          observation = {
            kind: 'runtime_event',
            ...(occurrence.requestOrdinal === undefined
              ? {}
              : { requestOrdinal: Number(occurrence.requestOrdinal) }),
            event: occurrence.event as unknown as ProviderEvidenceRuntimeEvent,
          };
        }
        if (observation !== undefined) {
          event = {
            ...event,
            payload: {
              ...eventPayload,
              observation,
            } as unknown as StoredExecutionEvent['payload'],
          };
        }
      }
      events.push(event);
    }
    return events.sort((left, right) => left.ordinal - right.ordinal);
  }

  listExecutionEvents(id: string): readonly StoredExecutionEvent[] {
    try {
      return this.#historyEvents(id);
    } catch (error) {
      throw asHistoryError(error);
    }
  }

  #executionRows(
    where = '',
    bindings: readonly (string | number)[] = [],
  ): StoredExecutionRow[] {
    const db = this.#db();
    try {
      const rows = db.prepare(
        `SELECT * FROM executions ${where} ORDER BY turn_number, created_at, execution_id`,
      )
        .all(...bindings) as Row[];
      return rows.map((row) => {
        const metadata = JSON.parse(
          String(row.metadata_json),
        ) as ExecutionMetadata;
        return {
          executionId: String(row.execution_id),
          taskId: metadata.taskId,
          task: metadata.task,
          ...(metadata.canonicalSessionId === undefined
            ? {}
            : { canonicalSessionId: metadata.canonicalSessionId }),
          sessionCorrelation: metadata.sessionCorrelation,
          turn: metadata.turn,
          createdAt: metadata.createdAt,
          ...(row.settled_at === null ? {} : { settledAt: String(row.settled_at) }),
          lifecycle: String(row.lifecycle) as StoredExecutionRow['lifecycle'],
          outcome: String(row.outcome) as StoredExecutionRow['outcome'],
          ...(row.outcome_json === null
            ? {}
            : { outcomeJson: JSON.parse(String(row.outcome_json)) }),
          adoption: String(row.adoption) as StoredExecutionRow['adoption'],
          baseRevision: metadata.baseStateRevision,
          ...(String(row.adoption) === 'canonical'
            ? { committedRevision: metadata.baseStateRevision + 1 }
            : {}),
          agent: metadata.agent,
          model: metadata.model,
          build: metadata.build,
          definition: metadata.definition,
          ...(metadata.manifest === undefined ? {} : { manifest: metadata.manifest }),
          ...(metadata.instanceCorrelation === undefined
            ? {}
            : { instanceCorrelation: metadata.instanceCorrelation }),
          ...(metadata.workerGeneration === undefined
            ? {}
            : { workerGeneration: metadata.workerGeneration }),
          acknowledgement: 'not_sent',
          generationAvailability: 'unknown',
          evidenceCapture: row.evidence_id === null ? 'none' : 'yes',
          ...(row.evidence_id === null ? {} : { providerEvidenceId: String(row.evidence_id) }),
          diagnosticCapture: row.diagnostic_id === null ? 'none' : 'yes',
          artifactCapture: row.artifact_id === null ? 'none' : 'yes',
          contextCapture: String(row.lifecycle) === 'active'
            ? 'none'
            : String(row.outcome) === 'interrupted' || String(row.outcome) === 'unknown'
            ? 'partial'
            : 'complete',
        };
      });
    } finally {
      db.close();
    }
  }

  listExecutions(): readonly StoredExecutionRow[] {
    return this.#executionRows();
  }

  listExecutionsForSession(sessionId: string): readonly StoredExecutionRow[] {
    return this.#executionRows('WHERE session_id = ?', [sessionId]);
  }

  readExecution(id: string): StoredExecutionRow {
    const row = this.#executionRows('WHERE execution_id = ?', [id])[0];
    if (row === undefined) throw new HistoryStoreError('history_invalid');
    if (row.outcomeJson === undefined) return row;
    const db = this.#db();
    try {
      const canonical = db.prepare(`
        SELECT logical_digest, representation_digest, encoded_bytes
        FROM session_messages
        WHERE session_id = ? AND turn ${row.adoption === 'canonical' ? '<=' : '<'} ?
        ORDER BY message_ordinal
      `).all(row.sessionCorrelation, row.turn) as Row[];
      const execution = row.adoption === 'canonical' ? [] : db.prepare(`
          SELECT logical_digest, representation_digest, encoded_bytes
          FROM execution_messages WHERE execution_id = ? ORDER BY message_ordinal
        `).all(row.executionId) as Row[];
      return {
        ...row,
        outcomeJson: {
          ...row.outcomeJson,
          transcript: [...canonical, ...execution].map((message) =>
            this.#decodeMessageRow(message)
          ),
        },
      };
    } catch (error) {
      throw asHistoryError(error);
    } finally {
      db.close();
    }
  }

  #executionMetadata(executionId: string): ExecutionMetadata {
    const db = this.#db();
    try {
      const row = db.prepare(
        'SELECT metadata_json FROM executions WHERE execution_id=?',
      ).get(
        executionId,
      ) as Row | undefined;
      if (row?.metadata_json === null || row?.metadata_json === undefined) {
        throw new HistoryStoreError('history_invalid');
      }
      return JSON.parse(String(row.metadata_json)) as ExecutionMetadata;
    } finally {
      db.close();
    }
  }

  #executionEffects(
    id: string,
    settlement: StoredExecutionRow['outcome'],
  ): readonly StoredExecutionEffect[] {
    const effects = new Map<string, StoredExecutionEffect>();
    for (const event of this.listExecutionEvents(id)) {
      const payload = event.payload as Record<string, unknown>;
      const effect = payload.kind === 'effect_observation' &&
          typeof payload.effect === 'object' && payload.effect !== null
        ? payload.effect as Record<string, unknown>
        : undefined;
      if (effect === undefined) continue;
      const phase = String(effect.kind ?? '');
      const nested = phase === 'tool_call'
        ? effect.call
        : phase === 'tool_result'
        ? effect.result
        : effect;
      if (typeof nested !== 'object' || nested === null) continue;
      const item = nested as Record<string, unknown>;
      if (typeof item.callId !== 'string') continue;
      const prior = effects.get(item.callId);
      const completed = phase === 'tool_result';
      const progress = phase === 'tool_progress';
      effects.set(item.callId, {
        executionId: id,
        callId: item.callId,
        name: String(item.name ?? prior?.name ?? ''),
        ...(phase === 'tool_call'
          ? { requestedEventOrdinal: event.ordinal }
          : prior?.requestedEventOrdinal === undefined
          ? {}
          : {
            requestedEventOrdinal: prior.requestedEventOrdinal,
          }),
        ...(progress
          ? { progressEventOrdinal: event.ordinal }
          : prior?.progressEventOrdinal === undefined
          ? {}
          : {
            progressEventOrdinal: prior.progressEventOrdinal,
          }),
        ...(completed
          ? { completedEventOrdinal: event.ordinal }
          : prior?.completedEventOrdinal === undefined
          ? {}
          : {
            completedEventOrdinal: prior.completedEventOrdinal,
          }),
        ...(completed && (item.outcome === 'success' || item.outcome === 'error')
          ? { resultOutcome: item.outcome }
          : prior?.resultOutcome === undefined
          ? {}
          : { resultOutcome: prior.resultOutcome }),
        status: completed ? 'completed' : progress ? 'observed_progress' : 'observed_requested',
      });
    }
    return [...effects.values()].map((effect) =>
      effect.completedEventOrdinal === undefined &&
        (settlement === 'interrupted' || settlement === 'unknown')
        ? { ...effect, status: 'outcome_unknown' as const }
        : effect
    );
  }

  listExecutionEffects(id: string): readonly StoredExecutionEffect[] {
    const execution = this.#executionRows('WHERE execution_id = ?', [id])[0];
    if (execution === undefined) throw new HistoryStoreError('history_invalid');
    return this.#executionEffects(id, execution.outcome);
  }

  #writeDocument(
    kind: string,
    id: string,
    executionId: string | null,
    bytes: Uint8Array,
  ): void {
    const encoded = new Uint8Array(brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    }));
    const db = this.#db();
    try {
      db.prepare(`
        INSERT INTO captured_documents(document_kind, document_id, execution_id, document_bytes)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(document_kind, document_id) DO UPDATE SET
          execution_id=excluded.execution_id, document_bytes=excluded.document_bytes
      `).run(kind, id, executionId, encoded);
    } finally {
      db.close();
    }
  }

  #capture(input: CanonicalTurnCommitInput | NonCanonicalExecutionInput): {
    result: HistoryCaptureResult;
    evidenceId?: string;
    diagnosticId?: string;
    artifactId?: string;
  } {
    const result: HistoryCaptureResult = {};
    let evidenceId: string | undefined;
    let diagnosticId: string | undefined;
    if (input.contextManifest !== undefined) {
      this.#writeDocument(
        'context_manifest',
        input.executionId,
        input.executionId,
        jsonBytes(input.contextManifest),
      );
      Object.assign(result, { contextDurability: 'complete' });
    }
    if (
      input.evidence !== undefined && validateProviderEvidence(input.evidence)
    ) {
      evidenceId = input.evidence.evidenceId;
      this.#writeDocument(
        'provider_evidence',
        evidenceId,
        input.executionId,
        jsonBytes(input.evidence),
      );
      Object.assign(result, { evidenceDurability: 'yes' });
    }
    if (
      input.diagnostic !== undefined &&
      validateFailureDiagnostic(input.diagnostic)
    ) {
      diagnosticId = input.diagnostic.diagnosticId;
      this.#writeDocument(
        'diagnostic',
        diagnosticId,
        input.executionId,
        encoder.encode(encodeFailureDiagnostic(input.diagnostic)),
      );
      Object.assign(result, { diagnosticDurability: 'yes' });
    }
    if (evidenceId !== undefined && diagnosticId !== undefined) {
      this.#writeDocument(
        'diagnostic_evidence_link',
        diagnosticId,
        input.executionId,
        jsonBytes(evidenceId),
      );
    }
    let artifactId: string | undefined;
    if (input.artifactForCapture !== undefined) {
      const artifact = input.artifactForCapture(result);
      if (!validateWorkerExecutionArtifact(artifact)) {
        throw new HistoryStoreError('history_invalid');
      }
      artifactId = artifact.executionId;
      this.#writeDocument(
        'artifact',
        artifactId,
        input.executionId,
        jsonBytes(artifact),
      );
    }
    return { result, evidenceId, diagnosticId, artifactId };
  }

  #executionMessageDelta(
    input: NonCanonicalExecutionInput,
  ): readonly HistoryV6ExecutionMessageInput[] {
    const db = this.#db();
    let baseMessageCount = 0;
    try {
      const row = db.prepare(`
        SELECT base_message_count FROM executions WHERE execution_id = ?
      `).get(input.executionId) as Row | undefined;
      if (row === undefined) throw new HistoryStoreError('history_invalid');
      baseMessageCount = Number(row.base_message_count);
    } finally {
      db.close();
    }
    if (baseMessageCount > input.outcome.transcript.length) {
      throw new HistoryStoreError('history_invalid');
    }
    return input.outcome.transcript.slice(baseMessageCount).map((
      message,
      ordinal,
    ) => ({
      ordinal,
      turn: input.turn,
      json: JSON.stringify(message),
    }));
  }

  commitCanonicalTurn(input: CanonicalTurnCommitInput): HistoryCaptureResult {
    if (
      input.record.sessionId !== input.canonicalSessionId ||
      input.record.workspaceRoot !== this.workspaceRoot ||
      input.record.stateRevision !== input.baseStateRevision + 1 ||
      input.record.nextTurn !== input.turn + 1
    ) throw new HistoryStoreError('history_invalid');
    const captured = this.#capture(input);
    const event = this.appendExecutionEvent({
      executionId: input.executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'execution_settled',
      observedAt: input.record.updatedAt,
      payload: { outcome: 'completed', adoption: 'canonical' },
    });
    const ledger = this.#coreStore().readLedger(input.executionId);
    this.#coreStore().settleExecution(
      input.executionId,
      {
        latestOrdinal: ledger.latestOrdinal,
        recordCount: ledger.recordCount,
        orderedRoot: ledger.orderedRoot,
        terminalRecordId: `${input.executionId}:record:${ledger.latestOrdinal}`,
      },
      'completed',
    );
    this.#coreStore().adoptExecutionWithState(input.executionId, input.turn, {
      session: this.#sessionState(input.record, input.executionId),
      updatedAt: input.record.updatedAt,
      outcomeJson: JSON.stringify(compactOutcome(input.outcome)),
      ...(captured.evidenceId === undefined ? {} : { evidenceId: captured.evidenceId }),
      ...(captured.diagnosticId === undefined ? {} : { diagnosticId: captured.diagnosticId }),
      ...(captured.artifactId === undefined ? {} : { artifactId: captured.artifactId }),
    });
    this.#indexExecutionHistory(input.executionId);
    void event;
    this.#pipelines.delete(input.executionId);
    this.#eventCounts.delete(input.executionId);
    this.#releaseExecutionLock(input.executionId);
    return captured.result;
  }

  settleNonCanonicalExecution(
    input: NonCanonicalExecutionInput,
  ): HistoryCaptureResult {
    const captured = this.#capture(input);
    const outcome = input.outcome.ok
      ? 'completed'
      : input.outcome.stopReason === 'cancelled'
      ? 'cancelled'
      : 'failed';
    this.appendExecutionEvent({
      executionId: input.executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'execution_settled',
      observedAt: now(),
      payload: { outcome, adoption: 'non_canonical' },
    });
    const ledger = this.#coreStore().readLedger(input.executionId);
    this.#coreStore().settleExecution(
      input.executionId,
      {
        latestOrdinal: ledger.latestOrdinal,
        recordCount: ledger.recordCount,
        orderedRoot: ledger.orderedRoot,
        terminalRecordId: `${input.executionId}:record:${ledger.latestOrdinal}`,
      },
      outcome,
      {
        settledAt: now(),
        outcomeJson: JSON.stringify(compactOutcome(input.outcome)),
        outcomeMessages: this.#executionMessageDelta(input),
        ...(captured.evidenceId === undefined ? {} : { evidenceId: captured.evidenceId }),
        ...(captured.diagnosticId === undefined ? {} : { diagnosticId: captured.diagnosticId }),
        ...(captured.artifactId === undefined ? {} : { artifactId: captured.artifactId }),
      },
    );
    this.#indexExecutionHistory(input.executionId);
    this.#pipelines.delete(input.executionId);
    this.#eventCounts.delete(input.executionId);
    this.#releaseExecutionLock(input.executionId);
    return captured.result;
  }

  /** Materialize only provider facts that crossed the Worker/Host journal boundary. */
  #partialProviderEvidence(
    execution: StoredExecutionRow,
    settlement: 'interrupted' | 'unknown',
  ): ProviderEvidenceV5 | undefined {
    type PartialRequest = {
      request: ProviderEvidenceRequest;
      response?: {
        status: number;
        headers: Readonly<Record<string, string>>;
        rawBodyBytes: number;
        rawBody?: string;
        rawBodyBase64?: string;
      };
      chunks: Uint8Array[];
      sseEvents: ProviderEvidenceSseEvent[];
      parserTransitions: ProviderEvidenceParserTransition[];
    };
    const requests = new Map<number, PartialRequest>();
    const runtimeEvents: ProviderEvidenceRuntimeEvent[] = [];
    for (const event of this.listExecutionEvents(execution.executionId)) {
      const payload = event.payload as Record<string, unknown>;
      if (
        payload.kind !== 'provider_observation' ||
        !validateProviderEvidenceObservation(payload.observation)
      ) continue;
      const observation = payload.observation;
      if (observation.kind === 'request_start') {
        if (requests.has(observation.request.ordinal)) {
          throw new HistoryStoreError('history_invalid');
        }
        requests.set(observation.request.ordinal, {
          request: structuredClone(observation.request),
          chunks: [],
          sseEvents: [],
          parserTransitions: [],
        });
        continue;
      }
      if (observation.kind === 'runtime_event') {
        runtimeEvents.push(structuredClone(observation.event));
        continue;
      }
      const request = requests.get(observation.requestOrdinal);
      if (request === undefined) throw new HistoryStoreError('history_invalid');
      if (observation.kind === 'response_start') {
        if (request.response !== undefined) throw new HistoryStoreError('history_invalid');
        request.response = {
          status: observation.response.status,
          headers: structuredClone(observation.response.headers),
          rawBodyBytes: 0,
        };
      } else if (observation.kind === 'response_bytes') {
        if (request.response === undefined) throw new HistoryStoreError('history_invalid');
        const bytes = Uint8Array.fromBase64(observation.bytesBase64);
        if (observation.offset !== request.response.rawBodyBytes + bytes.byteLength) {
          throw new HistoryStoreError('history_invalid');
        }
        request.chunks.push(bytes);
        request.response.rawBodyBytes = observation.offset;
      } else if (observation.kind === 'sse_event') {
        request.sseEvents.push(structuredClone(observation.event));
      } else if (observation.kind === 'parser_transition') {
        request.parserTransitions.push(structuredClone(observation.transition));
      }
    }
    if (requests.size === 0 && runtimeEvents.length === 0) return undefined;
    const records: ProviderEvidenceRequestRecord[] = [...requests.values()]
      .sort((left, right) => left.request.ordinal - right.request.ordinal)
      .map((request) => {
        if (request.response !== undefined && request.chunks.length > 0) {
          const bytes = new Uint8Array(
            request.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
          );
          let offset = 0;
          for (const chunk of request.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          request.response.rawBodyBase64 = bytes.toBase64();
          try {
            request.response.rawBody = decoder.decode(bytes);
          } catch {
            // rawBodyBase64 is the exact representation for non-UTF-8 response bytes.
          }
        }
        return {
          request: {
            ...request.request,
            contextRequestOrdinal: request.request.contextRequestOrdinal ??
              request.request.ordinal,
          },
          ...(request.response === undefined ? {} : { response: request.response }),
          sseEvents: request.sseEvents,
          parserTransitions: request.parserTransitions,
        };
      });
    const evidence: ProviderEvidenceV5 = {
      schemaVersion: 5,
      evidenceId: this.#makeUuid(),
      sessionId: execution.sessionCorrelation,
      build: structuredClone(execution.build),
      definition: structuredClone(execution.definition),
      turnNumber: execution.turn,
      createdAt: execution.createdAt,
      requests: records as ProviderEvidenceV5['requests'],
      runtimeEvents,
      capture: 'partial',
      normalizedOutcome: settlement,
      settlement,
    };
    if (!validateProviderEvidence(evidence)) {
      throw new HistoryStoreError('history_invalid');
    }
    return evidence;
  }

  #reconciliationArtifact(
    execution: StoredExecutionRow,
    settlement: 'interrupted' | 'unknown',
    settledAt: string,
    providerEvidenceId?: string,
  ): WorkerExecutionArtifactV7 | undefined {
    if (execution.manifest === undefined) return undefined;
    const instanceCorrelation = execution.instanceCorrelation ?? 'reconciled';
    const workerGeneration = execution.workerGeneration ?? 'unknown';
    const artifact: WorkerExecutionArtifactV7 = {
      schemaVersion: 7,
      contextCapture: 'partial',
      executionId: execution.executionId,
      createdAt: execution.createdAt,
      settledAt,
      sessionId: execution.sessionCorrelation,
      turn: execution.turn,
      agent: execution.agent,
      instanceCorrelation,
      workerGeneration,
      build: structuredClone(execution.build),
      definition: structuredClone(execution.definition),
      manifest: structuredClone(execution.manifest),
      ...(execution.manifest.subagents === undefined
        ? {}
        : { subagents: structuredClone(execution.manifest.subagents) }),
      ...(execution.manifest.tools === undefined
        ? {}
        : { tools: structuredClone(execution.manifest.tools) }),
      command: {
        kind: 'turn',
        correlation: {
          session: execution.sessionCorrelation,
          instanceCorrelation,
          workerGeneration,
          baseStateRevision: execution.baseRevision,
          command: `turn-${execution.turn}-reconciled`,
        },
        task: execution.task,
      },
      baseStateRevision: execution.baseRevision,
      protocolTrace: [],
      ...(providerEvidenceId === undefined
        ? {}
        : { providerEvidenceId, providerEvidenceDurability: 'yes' as const }),
      storeResult: 'not_attempted',
      acknowledgement: 'not_sent',
      settlement,
      lifecycle: 'settled',
      normalizedOutcome: settlement,
      adoption: 'non_canonical',
      effectCommitRelation: 'not_transactional',
      automaticReplay: false,
    };
    if (!validateWorkerExecutionArtifact(artifact)) {
      throw new HistoryStoreError('history_invalid');
    }
    return artifact;
  }

  reconcileExecution(input: ReconcileExecutionInput): void {
    const ledger = this.#coreStore().readLedger(input.executionId);
    if (ledger.lifecycle !== 'active') return;
    const execution = this.readExecution(input.executionId);
    const settledAt = input.settledAt ?? now();
    let evidenceId: string | undefined;
    let artifactId: string | undefined;
    const evidence = input.evidence ??
      this.#partialProviderEvidence(execution, input.settlement);
    if (evidence !== undefined && validateProviderEvidence(evidence)) {
      evidenceId = evidence.evidenceId;
      this.#writeDocument(
        'provider_evidence',
        evidenceId,
        input.executionId,
        jsonBytes(evidence),
      );
    }
    const artifact = input.artifact ?? this.#reconciliationArtifact(
      execution,
      input.settlement,
      settledAt,
      evidenceId,
    );
    if (artifact !== undefined && validateWorkerExecutionArtifact(artifact)) {
      artifactId = artifact.executionId;
      this.#writeDocument(
        'artifact',
        artifactId,
        input.executionId,
        jsonBytes(artifact),
      );
    }
    this.appendExecutionEvent({
      executionId: input.executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'execution_reconciled',
      observedAt: settledAt,
      payload: { settlement: input.settlement },
    });
    const current = this.#coreStore().readLedger(input.executionId);
    this.#coreStore().settleExecution(
      input.executionId,
      {
        latestOrdinal: current.latestOrdinal,
        recordCount: current.recordCount,
        orderedRoot: current.orderedRoot,
        terminalRecordId: `${input.executionId}:record:${current.latestOrdinal}`,
      },
      input.settlement,
      {
        settledAt,
        ...(evidenceId === undefined ? {} : { evidenceId }),
        ...(artifactId === undefined ? {} : { artifactId }),
      },
    );
    this.#indexExecutionHistory(input.executionId);
    this.#pipelines.delete(input.executionId);
    this.#eventCounts.delete(input.executionId);
    this.#releaseExecutionLock(input.executionId);
  }

  recordPostCommitObservation(artifact: StoredWorkerExecutionArtifact): void {
    if (!validateWorkerExecutionArtifact(artifact)) {
      throw new HistoryStoreError('history_invalid');
    }
    this.#writeDocument(
      'artifact',
      artifact.executionId,
      artifact.executionId,
      jsonBytes(artifact),
    );
  }

  listExecutionContext(executionId: string) {
    this.readExecution(executionId);
    const metadata = this.#executionMetadata(executionId);
    const relations: import('./context_attribution.ts').ExecutionContextRelation[] = [];
    const requests: import('./context_attribution.ts').ContextModelRequestRecord[] = [];
    const occurrences = new Map<
      string,
      import('./context_attribution.ts').ContextOccurrenceInput
    >();
    const sequences = new Map<string, string[]>();
    try {
      const manifest = this.#document<
        import('./context_attribution.ts').ExecutionContextManifestV2
      >('context_manifest', executionId);
      for (const relation of manifest.externalRelations) {
        relations.push({ ordinal: relations.length + 1, ...relation });
      }
    } catch {
      // Active executions do not have their final context manifest yet.
    }
    for (const event of this.listExecutionEvents(executionId)) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.kind !== 'context_observation') continue;
      const observation = payload.observation as
        | Record<string, unknown>
        | undefined;
      const delta = observation
        ?.delta as import('./context_attribution.ts').ContextModelRequestDelta;
      if (delta === undefined) continue;
      for (const occurrence of delta.occurrences) {
        occurrences.set(
          occurrence.occurrenceId,
          occurrence.bytesBase64 === undefined
            ? {
              ...occurrence,
              bytesBase64: this.#coreStore().readExactObject(
                occurrence.content.digest,
              ).toBase64(),
            }
            : occurrence,
        );
      }
      const sequenceKey = `${delta.lane}:${delta.purpose}`;
      const sequence = [...(sequences.get(sequenceKey) ?? [])];
      for (const splice of delta.splices) {
        sequence.splice(
          splice.start,
          splice.deleteCount,
          ...splice.insertions.map((insertion) => insertion.occurrenceId),
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
        return {
          ordinal,
          kind: occurrence.kind,
          content: occurrence.content,
          relationOrdinals,
          sourceRelations: occurrence.sourceRelations,
          ...(occurrence.bytesBase64 === undefined ? {} : { bytesBase64: occurrence.bytesBase64 }),
        };
      });
      const decoded = items.map((item) => {
        if (item.bytesBase64 === undefined) return undefined;
        return decoder.decode(Uint8Array.fromBase64(item.bytesBase64));
      });
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
    return {
      ...(metadata.contextSnapshot === undefined ? {} : { snapshot: metadata.contextSnapshot }),
      relations,
      requests,
    };
  }

  readExecutionRequest(executionId: string, requestOrdinal: number) {
    const request = this.listExecutionContext(executionId).requests.find((
      item,
    ) => item.requestOrdinal === requestOrdinal);
    if (request === undefined) throw new HistoryStoreError('history_invalid');
    return request;
  }

  readExecutionRequestProviderEvidence(
    executionId: string,
    requestOrdinal: number,
  ): readonly {
    readonly evidenceId: string;
    readonly record: import('../provider/provider_evidence.ts').ProviderEvidenceV5['requests'][
      number
    ];
  }[] {
    const execution = this.readExecution(executionId);
    if (execution.providerEvidenceId === undefined) return [];
    const evidence = this.#document<StoredProviderEvidence>(
      'provider_evidence',
      execution.providerEvidenceId,
    );
    if (evidence.schemaVersion !== 5) return [];
    return evidence.requests.filter((record) =>
      record.request.contextRequestOrdinal === requestOrdinal
    ).map((record) => ({ evidenceId: evidence.evidenceId, record }));
  }

  #document<T>(kind: string, id: string): T {
    const db = this.#db();
    try {
      const row = db.prepare(`
        SELECT document_bytes FROM captured_documents WHERE document_kind=? AND document_id=?
      `).get(kind, id) as Row | undefined;
      if (!(row?.document_bytes instanceof Uint8Array)) {
        throw new Error('not found');
      }
      return parseJson<T>(
        new Uint8Array(brotliDecompressSync(row.document_bytes)),
      );
    } finally {
      db.close();
    }
  }

  #documents<T>(kind: string): readonly T[] {
    const db = this.#db();
    try {
      return (db.prepare(`
        SELECT document_bytes FROM captured_documents WHERE document_kind=? ORDER BY rowid
      `).all(kind) as Row[]).map((row) =>
        parseJson<T>(
          new Uint8Array(
            brotliDecompressSync(row.document_bytes as Uint8Array),
          ),
        )
      );
    } finally {
      db.close();
    }
  }

  #turnMessages(
    sessionId: string,
    turn: number,
  ): readonly { readonly ordinal: number; readonly message: Message }[] {
    const db = this.#db();
    try {
      return (db.prepare(`
        SELECT message_ordinal, logical_digest, representation_digest, encoded_bytes
        FROM session_messages WHERE session_id=? AND turn=? ORDER BY message_ordinal
      `).all(sessionId, turn) as Row[]).map((row) => ({
        ordinal: Number(row.message_ordinal),
        message: this.#decodeMessageRow(row),
      }));
    } finally {
      db.close();
    }
  }

  #contextSummary(executionId: string): {
    readonly relations: import('./context_attribution.ts').ExecutionContextRelation[];
    readonly requests: import('./context_attribution.ts').ContextModelRequestRecord[];
  } {
    const relations: import('./context_attribution.ts').ExecutionContextRelation[] = [];
    const requests: import('./context_attribution.ts').ContextModelRequestRecord[] = [];
    try {
      const manifest = this.#document<
        import('./context_attribution.ts').ExecutionContextManifestV2
      >('context_manifest', executionId);
      for (const relation of manifest.externalRelations) {
        relations.push({ ordinal: relations.length + 1, ...relation });
      }
    } catch {
      // Active or reconciled executions may not have a final manifest.
    }
    for (const event of this.listExecutionEvents(executionId)) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.kind !== 'context_observation') continue;
      const observation = payload.observation as
        | Record<string, unknown>
        | undefined;
      const delta = observation
        ?.delta as
          | import('./context_attribution.ts').ContextModelRequestDelta
          | undefined;
      if (delta === undefined) continue;
      for (const occurrence of delta.occurrences) {
        for (const source of occurrence.sourceRelations) {
          relations.push({
            ordinal: relations.length + 1,
            ...source,
            contentDigest: source.contentDigest ?? occurrence.content.digest,
            requestOrdinal: delta.requestOrdinal,
          });
        }
      }
      requests.push({
        requestOrdinal: delta.requestOrdinal,
        lane: delta.lane,
        purpose: delta.purpose,
        modelStep: delta.modelStep,
        ...(delta.modelSelection === undefined ? {} : { modelSelection: delta.modelSelection }),
        items: [],
      });
    }
    return { relations, requests };
  }

  #entries(
    sessionId: string,
    rows: readonly StoredExecutionRow[] = this.listExecutionsForSession(
      sessionId,
    ),
  ): HumanHistoryEntryV1[] {
    return rows.flatMap((execution) => {
      const db = this.#db();
      let attempt: number;
      try {
        const row = db.prepare(`
          SELECT count(*) AS count FROM executions
          WHERE history_session_id=? AND turn_number=? AND
            (created_at < ? OR (created_at = ? AND execution_id <= ?))
        `).get(
          sessionId,
          execution.turn,
          execution.createdAt,
          execution.createdAt,
          execution.executionId,
        ) as Row;
        attempt = Number(row.count);
      } finally {
        db.close();
      }
      const context = this.#contextSummary(execution.executionId);
      return projectHumanHistoryExecution({
        execution,
        attempt,
        canonicalMessages: execution.adoption === 'canonical'
          ? this.#turnMessages(sessionId, execution.turn)
          : [],
        events: this.listExecutionEvents(execution.executionId),
        effects: this.#executionEffects(
          execution.executionId,
          execution.outcome,
        ),
        context: context.relations,
        requests: context.requests,
        evidenceIds: execution.providerEvidenceId === undefined
          ? []
          : [execution.providerEvidenceId],
        diagnosticIds: [],
        artifactIds: [],
      });
    });
  }

  #indexExecutionHistory(executionId: string): void {
    const execution = this.#executionRows('WHERE execution_id = ?', [executionId])[0];
    if (execution === undefined) throw new HistoryStoreError('history_invalid');
    const entries = this.#entries(execution.sessionCorrelation, [execution]);
    const db = this.#db();
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('DELETE FROM human_history_search WHERE execution_id=?').run(
        executionId,
      );
      const insert = db.prepare(`
        INSERT INTO human_history_search(entry_id, execution_id, session_id, search_text)
        VALUES (?, ?, ?, ?)
      `);
      for (const entry of entries) {
        insert.run(
          entry.id,
          executionId,
          execution.sessionCorrelation,
          entry.searchText,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the projection failure.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  readHumanHistoryPage(request: HumanHistoryPageRequest): HumanHistoryPageV1 {
    const limit = request.executionLimit ?? HUMAN_HISTORY_PAGE_EXECUTIONS;
    if (
      !isSessionId(request.sessionId) || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 24
    ) throw new HistoryStoreError('history_invalid');
    const cursor = decodeHumanCursor(request.cursor);
    if (
      (request.direction === 'older' || request.direction === 'newer') &&
      cursor === undefined
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    let ids: string[];
    try {
      if (
        db.prepare('SELECT 1 FROM sessions WHERE session_id=?')
          .get(request.sessionId) === undefined
      ) throw new HistoryStoreError('history_invalid');
      const select = (
        where: string,
        order: string,
        bindings: readonly SqlValue[],
      ): string[] =>
        (db.prepare(`
          SELECT execution_id FROM executions WHERE ${where} ORDER BY ${order} LIMIT ?
        `).all(...bindings, limit) as Row[]).map((row) => String(row.execution_id));
      if (request.direction === 'latest') {
        ids = select(
          'history_session_id=?',
          'turn_number DESC, created_at DESC, execution_id DESC',
          [request.sessionId],
        ).reverse();
      } else if (request.direction === 'oldest') {
        ids = select(
          'history_session_id=?',
          'turn_number, created_at, execution_id',
          [request.sessionId],
        );
      } else {
        const comparison = request.direction === 'older' ? '<' : '>';
        const order = request.direction === 'older'
          ? 'turn_number DESC, created_at DESC, execution_id DESC'
          : 'turn_number, created_at, execution_id';
        ids = select(
          `history_session_id=? AND
            (turn_number ${comparison} ? OR
             (turn_number = ? AND created_at ${comparison} ?) OR
             (turn_number = ? AND created_at = ? AND execution_id ${comparison} ?))`,
          order,
          [
            request.sessionId,
            cursor!.turn,
            cursor!.turn,
            cursor!.createdAt,
            cursor!.turn,
            cursor!.createdAt,
            cursor!.executionId,
          ],
        );
        if (request.direction === 'older') ids.reverse();
      }
    } finally {
      db.close();
    }
    const selected = ids.flatMap((id) => {
      const execution = this.#executionRows('WHERE execution_id=?', [id])[0];
      return execution === undefined ? [] : [execution];
    });
    return this.#historyPageFromRows(request.sessionId, selected);
  }

  #historyPageFromRows(
    sessionId: string,
    selected: readonly StoredExecutionRow[],
  ): HumanHistoryPageV1 {
    const first = selected[0];
    const last = selected.at(-1);
    const db = this.#db();
    let existsBefore = false;
    let existsAfter = false;
    try {
      if (first !== undefined) {
        existsBefore = db.prepare(`
          SELECT 1 FROM executions WHERE history_session_id=? AND
            (turn_number < ? OR (turn_number = ? AND created_at < ?) OR
             (turn_number = ? AND created_at = ? AND execution_id < ?)) LIMIT 1
        `).get(
          sessionId,
          first.turn,
          first.turn,
          first.createdAt,
          first.turn,
          first.createdAt,
          first.executionId,
        ) !== undefined;
      }
      if (last !== undefined) {
        existsAfter = db.prepare(`
          SELECT 1 FROM executions WHERE history_session_id=? AND
            (turn_number > ? OR (turn_number = ? AND created_at > ?) OR
             (turn_number = ? AND created_at = ? AND execution_id > ?)) LIMIT 1
        `).get(
          sessionId,
          last.turn,
          last.turn,
          last.createdAt,
          last.turn,
          last.createdAt,
          last.executionId,
        ) !== undefined;
      }
    } finally {
      db.close();
    }
    return {
      schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
      sessionId,
      entries: this.#entries(sessionId, selected),
      executionCount: selected.length,
      ...(existsBefore && first !== undefined
        ? { olderCursor: encodeHumanCursor(humanCursorFor(first)) }
        : {}),
      ...(existsAfter && last !== undefined
        ? { newerCursor: encodeHumanCursor(humanCursorFor(last)) }
        : {}),
      atOldest: !existsBefore,
      atNewest: !existsAfter,
    };
  }

  readHumanHistoryDetail(
    sessionId: string,
    detailId: string,
    scalarOffset = 0,
  ): HumanHistoryDetailChunkV1 {
    const executionId = detailId.split(':')[1];
    if (executionId === undefined || !isSessionId(executionId)) {
      throw new HistoryStoreError('history_invalid');
    }
    const execution = this.#executionRows(
      'WHERE execution_id=? AND history_session_id=?',
      [executionId, sessionId],
    )[0];
    if (execution === undefined) throw new HistoryStoreError('history_invalid');
    const entry = this.#entries(sessionId, [execution]).find((candidate) =>
      candidate.detailId === detailId
    );
    if (entry === undefined) throw new HistoryStoreError('history_invalid');
    return chunkHumanHistoryDetail(
      sessionId,
      detailId,
      entry.label,
      entry.searchText,
      scalarOffset,
    );
  }

  searchHumanHistory(
    request: HumanHistorySearchRequest,
  ): HumanHistorySearchHitV1 | undefined {
    if (
      !isSessionId(request.sessionId) || request.query.length === 0 ||
      request.query.includes('\0') ||
      (request.fromSourceScalarOffset !== undefined &&
        (!Number.isSafeInteger(request.fromSourceScalarOffset) ||
          request.fromSourceScalarOffset < 0 ||
          request.fromEntryId === undefined))
    ) throw new HistoryStoreError('history_invalid');
    const db = this.#db();
    let ids: string[];
    try {
      if ([...request.query].length < 3) {
        ids = (db.prepare(`
          SELECT DISTINCT execution_id FROM human_history_search
          WHERE session_id=? AND instr(search_text, ?) > 0
        `).all(request.sessionId, request.query) as Row[]).map((row) => String(row.execution_id));
      } else {
        const expression = `"${request.query.replaceAll('"', '""')}"`;
        ids = (db.prepare(`
          SELECT DISTINCT execution_id FROM human_history_search
          WHERE human_history_search MATCH ? AND session_id=?
        `).all(expression, request.sessionId) as Row[]).map((row) => String(row.execution_id));
      }
    } finally {
      db.close();
    }
    const rows = ids.flatMap((id) => {
      const row = this.#executionRows('WHERE execution_id=?', [id])[0];
      return row === undefined ? [] : [row];
    }).sort((left, right) =>
      left.turn - right.turn || left.createdAt.localeCompare(right.createdAt) ||
      left.executionId.localeCompare(right.executionId)
    );
    const rowById = new Map(rows.map((row) => [row.executionId, row]));
    const matches = rows.flatMap((row) => {
      const entries = this.#entries(request.sessionId, [row]);
      return entries.flatMap((entry, entryIndex) =>
        scalarMatchOffsets(entry.searchText, request.query).map((offset) => ({
          row,
          entry,
          entryIndex,
          offset,
        }))
      );
    });
    if (matches.length === 0) return undefined;
    let selected = request.direction === 'next' ? matches[0] : matches.at(-1)!;
    let wrapped = false;
    if (request.fromEntryId !== undefined) {
      const originExecutionId = request.fromEntryId.split(':')[1];
      const originRow = originExecutionId === undefined
        ? undefined
        : rowById.get(originExecutionId) ?? this.#executionRows(
          'WHERE execution_id=? AND history_session_id=?',
          [originExecutionId, request.sessionId],
        )[0];
      const originEntries = originRow === undefined
        ? []
        : this.#entries(request.sessionId, [originRow]);
      const originEntryIndex = originEntries.findIndex((entry) => entry.id === request.fromEntryId);
      const compareToOrigin = (match: typeof matches[number]): number => {
        if (originRow === undefined) return 0;
        const executionOrder = match.row.turn - originRow.turn ||
          match.row.createdAt.localeCompare(originRow.createdAt) ||
          match.row.executionId.localeCompare(originRow.executionId);
        if (executionOrder !== 0) return executionOrder;
        if (match.entryIndex !== originEntryIndex) {
          return match.entryIndex - originEntryIndex;
        }
        const originOffset = request.fromSourceScalarOffset ??
          (request.direction === 'next' ? Number.POSITIVE_INFINITY : -1);
        return match.offset - originOffset;
      };
      const candidate = request.direction === 'next'
        ? matches.find((match) => compareToOrigin(match) > 0)
        : [...matches].reverse().find((match) => compareToOrigin(match) < 0);
      if (candidate === undefined) wrapped = true;
      else selected = candidate;
    }
    const previewScalars = [...selected.entry.text];
    const visibleScalars = selected.entry.text.endsWith('…')
      ? previewScalars.length - 1
      : previewScalars.length;
    const queryScalars = [...request.query].length;
    const needsDetail = selected.offset + queryScalars > visibleScalars;
    const detailOffset = Math.floor(selected.offset / HUMAN_HISTORY_DETAIL_SCALARS) *
      HUMAN_HISTORY_DETAIL_SCALARS;
    return {
      schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
      sessionId: request.sessionId,
      query: request.query,
      entryId: selected.entry.id,
      detailId: selected.entry.detailId,
      sourceScalarOffset: selected.offset,
      ...(needsDetail
        ? {
          detail: this.readHumanHistoryDetail(
            request.sessionId,
            selected.entry.detailId,
            detailOffset,
          ),
          detailMatchScalarOffset: selected.offset,
        }
        : {}),
      wrapped,
      page: this.#historyPageFromRows(request.sessionId, [selected.row]),
    };
  }

  *streamHumanHistoryExport(
    sessionId: string,
  ): Iterable<HumanHistoryExportRecordV1> {
    for (const execution of this.listExecutionsForSession(sessionId)) {
      yield {
        schemaVersion: 1,
        kind: 'execution',
        identity: execution.executionId,
        value: structuredClone(execution) as unknown as JsonValue,
      };
      for (const event of this.listExecutionEvents(execution.executionId)) {
        yield {
          schemaVersion: 1,
          kind: 'event',
          identity: `${execution.executionId}:${event.ordinal}`,
          value: structuredClone(event) as unknown as JsonValue,
        };
      }
    }
  }

  _listDocuments<T>(kind: string): readonly T[] {
    return this.#documents<T>(kind);
  }

  _readDocument<T>(kind: string, id: string): T {
    return this.#document<T>(kind, id);
  }

  _writeDocument(
    kind: string,
    id: string,
    executionId: string | null,
    value: unknown,
  ): void {
    this.#writeDocument(kind, id, executionId, jsonBytes(value));
  }

  _deleteDocument(kind: string, id: string): boolean {
    const db = this.#db();
    try {
      return Number(
        db.prepare(`
        DELETE FROM captured_documents WHERE document_kind=? AND document_id=?
      `).run(kind, id).changes,
      ) === 1;
    } finally {
      db.close();
    }
  }
}

class V6ProviderEvidenceAdapter implements ProviderEvidenceStore {
  constructor(private readonly store: SqliteHistoryV6ProductionStore) {}
  list(): Promise<readonly StoredProviderEvidence[]> {
    return Promise.resolve(
      this.store._listDocuments<StoredProviderEvidence>('provider_evidence'),
    );
  }
  read(id: string): Promise<StoredProviderEvidence> {
    try {
      return Promise.resolve(
        this.store._readDocument<StoredProviderEvidence>(
          'provider_evidence',
          id,
        ),
      );
    } catch {
      return Promise.reject(
        new ProviderEvidenceStoreError('provider_evidence_not_found'),
      );
    }
  }
  write(evidence: StoredProviderEvidence): Promise<void> {
    if (!validateProviderEvidence(evidence)) {
      return Promise.reject(
        new ProviderEvidenceStoreError('provider_evidence_invalid'),
      );
    }
    this.store._writeDocument(
      'provider_evidence',
      evidence.evidenceId,
      null,
      evidence,
    );
    return Promise.resolve();
  }
  linkDiagnostic(diagnosticId: string, evidenceId: string): Promise<void> {
    this.store._writeDocument(
      'diagnostic_evidence_link',
      diagnosticId,
      null,
      evidenceId,
    );
    return Promise.resolve();
  }
  readDiagnosticLink(diagnosticId: string): Promise<string> {
    try {
      return Promise.resolve(
        this.store._readDocument<string>(
          'diagnostic_evidence_link',
          diagnosticId,
        ),
      );
    } catch {
      return Promise.reject(
        new ProviderEvidenceStoreError('provider_evidence_not_found'),
      );
    }
  }
}

class V6ExecutionArtifactAdapter implements WorkerExecutionArtifactStore {
  constructor(private readonly store: SqliteHistoryV6ProductionStore) {}
  list(): Promise<readonly StoredWorkerExecutionArtifact[]> {
    return Promise.resolve(
      this.store._listDocuments<StoredWorkerExecutionArtifact>('artifact'),
    );
  }
  read(id: string): Promise<StoredWorkerExecutionArtifact> {
    try {
      return Promise.resolve(
        this.store._readDocument<StoredWorkerExecutionArtifact>('artifact', id),
      );
    } catch {
      return Promise.reject(
        new WorkerExecutionArtifactStoreError(
          'worker_execution_artifact_not_found',
        ),
      );
    }
  }
  write(artifact: StoredWorkerExecutionArtifact): Promise<void> {
    if (!validateWorkerExecutionArtifact(artifact)) {
      return Promise.reject(
        new WorkerExecutionArtifactStoreError(
          'worker_execution_artifact_invalid',
        ),
      );
    }
    this.store._writeDocument(
      'artifact',
      artifact.executionId,
      artifact.executionId,
      artifact,
    );
    return Promise.resolve();
  }
}

class V6DiagnosticAdapter implements FailureDiagnosticStore {
  readonly persist = async (diagnostic: FailureDiagnosticV1): Promise<void> => {
    await this.write(diagnostic);
  };
  constructor(private readonly store: SqliteHistoryV6ProductionStore) {}
  list(): Promise<readonly FailureDiagnosticV1[]> {
    return Promise.resolve(
      this.store._listDocuments<FailureDiagnosticV1>('diagnostic'),
    );
  }
  read(id: string): Promise<FailureDiagnosticV1> {
    try {
      return Promise.resolve(
        this.store._readDocument<FailureDiagnosticV1>('diagnostic', id),
      );
    } catch {
      return Promise.reject(
        new FailureDiagnosticStoreError('diagnostic_not_found'),
      );
    }
  }
  write(diagnostic: FailureDiagnosticV1): Promise<void> {
    if (!validateFailureDiagnostic(diagnostic)) {
      return Promise.reject(
        new FailureDiagnosticStoreError('diagnostic_invalid'),
      );
    }
    this.store._writeDocument(
      'diagnostic',
      diagnostic.diagnosticId,
      null,
      diagnostic,
    );
    return Promise.resolve();
  }
  delete(id: string): Promise<void> {
    if (!this.store._deleteDocument('diagnostic', id)) {
      return Promise.reject(
        new FailureDiagnosticStoreError('diagnostic_not_found'),
      );
    }
    this.store._deleteDocument('diagnostic_evidence_link', id);
    return Promise.resolve();
  }
}
