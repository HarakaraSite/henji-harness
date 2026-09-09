import type { Message } from '../core/contracts.ts';
import type { ModelSelection } from '../provider/openrouter_model_catalog.ts';
import type { LegacyOpenRouterModelSelection } from '../provider/model_selection.ts';

export const SESSION_SCHEMA_VERSION = 1 as const;
export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_VALID_SESSIONS_PER_WORKSPACE = 256;
export const MAX_WORKSPACE_DIRECTORY_ENTRIES = 512;
export const MAX_RESTORED_DISPLAY_MESSAGES = 100;
export const MAX_RESTORED_DISPLAY_BYTES = 2 * 1024 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
}

/** Exact executable Definition binding persisted by the Worker-backed Host schema. */
export type DefinitionRevisionRef =
  | {
    readonly kind: 'builtin';
    readonly id: 'default' | 'planner';
    readonly canonicalSpecifier: string;
    readonly entrySha256: string;
    readonly sourceBytes: number;
  }
  | {
    readonly kind: 'external';
    readonly canonicalSpecifier: string;
    readonly entrySha256: string;
    readonly sourceBytes: number;
  };

/** Minimal Worker-backed record. Schema-v1 remains readable through the legacy codec. */
export interface SessionRecordV2 {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateRevision: number;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
  readonly definition: DefinitionRevisionRef;
}

export interface SessionModelChangeV3 {
  readonly effectiveFromTurn: number;
  readonly changedAt: string;
  readonly selection: LegacyOpenRouterModelSelection;
}

export interface SessionTurnModelAttributionV3 {
  readonly turn: number;
  readonly selection: LegacyOpenRouterModelSelection;
}

export interface SessionModelChange {
  readonly effectiveFromTurn: number;
  readonly changedAt: string;
  readonly selection: ModelSelection;
}

export interface SessionTurnModelAttribution {
  readonly turn: number;
  readonly selection: ModelSelection;
}

/** Worker-backed record with one durable root-model selection and committed-turn attribution. */
export interface SessionRecordV3 {
  readonly schemaVersion: 3;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateRevision: number;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
  readonly definition: DefinitionRevisionRef;
  readonly activeModel: LegacyOpenRouterModelSelection;
  readonly modelChanges: readonly SessionModelChangeV3[];
  readonly turnModels: readonly SessionTurnModelAttributionV3[];
}

/** Worker-backed record with provider-neutral route identity and attribution. */
export interface SessionRecordV4 {
  readonly schemaVersion: 4;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateRevision: number;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
  readonly definition: DefinitionRevisionRef;
  readonly activeModel: ModelSelection;
  readonly modelChanges: readonly SessionModelChange[];
  readonly turnModels: readonly SessionTurnModelAttribution[];
}

export type StoredSessionRecord =
  | SessionRecord
  | SessionRecordV2
  | SessionRecordV3
  | SessionRecordV4;

/** Strict, single-entry derived provider context kept beside (never inside) session.json. */
export interface SemanticContextCheckpointV1 {
  readonly contextSchemaVersion: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly sourceProfileId: string;
  readonly coveredThroughTurn: number;
  readonly retainedFromTurn: number;
  readonly summary: string;
}

export const CONTEXT_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const MAX_CONTEXT_CHECKPOINT_FILE_BYTES = 16 * 1024;
export const MAX_CONTEXT_SUMMARY_BYTES = 12_288;

export interface SessionMetadata {
  readonly id: string;
  readonly agent: SessionRecord['agent'];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly modelSelection?: ModelSelection;
}

export type SessionErrorCode =
  | 'session_not_found'
  | 'session_busy'
  | 'session_invalid'
  | 'session_limit'
  | 'session_io_failure';

export class SessionStoreError extends Error {
  constructor(readonly code: SessionErrorCode, message = code) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

export const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V4.test(value);

export interface SessionHandle {
  readonly id: string;
  readonly record?: SessionRecord;
  readonly checkpoint?: SemanticContextCheckpointV1;
  commit(record: SessionRecord): void;
  rollback(): void;
  installCheckpoint(checkpoint: SemanticContextCheckpointV1): void;
  rollbackCheckpoint(): void;
  close(): Promise<void>;
}

export interface WorkerSessionHandle {
  readonly id: string;
  readonly record?: StoredSessionRecord;
  readonly checkpoint?: SemanticContextCheckpointV1;
  commit(record: StoredSessionRecord): void;
  rollback(): void;
  installCheckpoint(checkpoint: SemanticContextCheckpointV1): void;
  rollbackCheckpoint(): void;
  close(): Promise<void>;
}

export interface WorkerSessionMetadata extends SessionMetadata {
  readonly definition?: DefinitionRevisionRef;
}

export interface WorkerSessionListResult {
  readonly sessions: readonly WorkerSessionMetadata[];
  readonly skippedInvalid: number;
}

export interface WorkerSessionStorePort {
  readWorker(id: string): Promise<StoredSessionRecord>;
  readCheckpoint(id: string): Promise<SemanticContextCheckpointV1 | undefined>;
  listWorker(): Promise<WorkerSessionListResult>;
  allocateWorker(
    agent: SessionRecord['agent'],
    definition: DefinitionRevisionRef,
  ): Promise<WorkerSessionHandle>;
  openExistingWorker(id: string): Promise<WorkerSessionHandle>;
}

export interface SessionListResult {
  readonly sessions: readonly SessionMetadata[];
  readonly skippedInvalid: number;
}

export interface SessionStorePort {
  read(id: string): Promise<SessionRecord>;
  readCheckpoint(id: string): Promise<SemanticContextCheckpointV1 | undefined>;
  list(): Promise<SessionListResult>;
  allocate(agent: SessionRecord['agent']): Promise<SessionHandle>;
  openExisting(id: string): Promise<SessionHandle>;
  delete(id: string): Promise<void>;
}

export interface SessionStoreOptions {
  /** Direct-test seam for deterministic UUIDs and collision handling. */
  readonly uuid?: () => string;
  /** Direct-test-only fault seam for first-turn rollback removal. */
  readonly removeSync?: (path: string) => void;
  /** Direct-test-only barrier immediately before an existing-session lock attempt. */
  readonly beforeOpenExistingLock?: (id: string) => Promise<void>;
  /** Selected built-in profile used to reject checkpoints from another composition early. */
  readonly sourceProfileId?: string;
}
