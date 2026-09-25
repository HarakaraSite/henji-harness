import type { Message } from '../core/contracts.ts';
import type { ModelSelection } from '../provider/openrouter_model_catalog.ts';
import type { DefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';

export type { DefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';

export const SESSION_SCHEMA_VERSION = 1 as const;
export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_VALID_SESSIONS_PER_WORKSPACE = 256;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const normalizeSessionTitle = (value: string): string =>
  value.replaceAll('\r\n', ' ').replaceAll('\r', ' ').replaceAll('\n', ' ').trim();

export const isSessionTitle = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value &&
  !value.includes('\0') && !/[\r\n]/.test(value) &&
  ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner' | 'generic';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
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

/** Worker-backed record with an optional human-authored Session title. */
export interface SessionRecordV5 {
  readonly schemaVersion: 5;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner' | 'generic';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string | null;
  readonly stateRevision: number;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
  readonly definition: DefinitionRevisionRef;
  readonly activeModel: ModelSelection;
  readonly modelChanges: readonly SessionModelChange[];
  readonly turnModels: readonly SessionTurnModelAttribution[];
}

export interface SessionTurnExecutionAttribution {
  readonly turn: number;
  readonly build: BuildManifestV1;
  readonly definition: DefinitionRevisionRef;
}

/** Standalone-era record with machine-independent Definition and build attribution. */
export interface SessionRecordV6 {
  readonly schemaVersion: 6;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner' | 'generic';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string | null;
  readonly stateRevision: number;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
  readonly definition: DefinitionRevisionRef;
  readonly activeModel: ModelSelection;
  readonly modelChanges: readonly SessionModelChange[];
  readonly turnModels: readonly SessionTurnModelAttribution[];
  readonly turnExecutions: readonly SessionTurnExecutionAttribution[];
}

export type StoredSessionRecord = SessionRecordV6;

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
  readonly title?: string;
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

export interface WorkerSessionHandle {
  readonly id: string;
  readonly record?: StoredSessionRecord;
  readonly checkpoint?: SemanticContextCheckpointV1;
  commit(record: StoredSessionRecord): void;
  /** SQLite history seam: update the owner-stable in-memory snapshot after an external atomic commit. */
  acceptCommitted?(record: StoredSessionRecord): void;
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
