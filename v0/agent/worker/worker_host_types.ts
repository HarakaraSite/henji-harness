import type { Message } from '../core/contracts.ts';
import type {
  SemanticContextCheckpointV1,
  SessionModelChange,
  SessionTurnExecutionAttribution,
  SessionTurnModelAttribution,
} from '../session/session_store.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { RecalledExecutionContext } from './recalled_execution_context.ts';
import type { ChildCleanupObservationV1 } from './worker_host_children.ts';
import type {
  WorkerExecutionAcknowledgement,
  WorkerExecutionSettlement,
  WorkerExecutionStoreResult,
  WorkerExecutionTraceEntry,
  WorkerExecutionTurnCommand,
} from './worker_execution_artifact.ts';

export type HistoryJournalErrorCode =
  | 'history_busy'
  | 'history_invalid'
  | 'history_io_failure';

export type JournalFailureSignal = {
  readonly promise: Promise<HistoryJournalErrorCode>;
  readonly resolve: (code: HistoryJournalErrorCode) => void;
};

export const createJournalFailureSignal = (): JournalFailureSignal => {
  let resolve!: (code: HistoryJournalErrorCode) => void;
  const promise = new Promise<HistoryJournalErrorCode>((accepted) => {
    resolve = accepted;
  });
  return { promise, resolve };
};

export type ActiveWorkerExecution = {
  readonly taskId: string;
  readonly executionId: string;
  readonly createdAt: string;
  readonly turn: number;
  readonly command: WorkerExecutionTurnCommand;
  readonly recalledContext?: RecalledExecutionContext;
  readonly baseStateRevision: number;
  readonly stageProbeEpoch: number;
  readonly protocolTrace: WorkerExecutionTraceEntry[];
  journalFailure?: boolean;
  journalFailureCode?: HistoryJournalErrorCode;
  readonly journalFailureSignal: JournalFailureSignal;
  postCommitObservationFailure?: boolean;
  postCommitObservationError?: HistoryJournalErrorCode;
  storeResult: WorkerExecutionStoreResult;
  storeError?: 'session_io_failure' | 'session_invalid' | 'history_busy';
  proposedStateRevision?: number;
  committedStateRevision?: number;
  acknowledgement: WorkerExecutionAcknowledgement;
  settlement: WorkerExecutionSettlement;
  artifactWritten: boolean;
  contextCapture?: 'complete' | 'failed' | 'none';
  childCleanup?: ChildCleanupObservationV1;
  readonly stageSnapshotKeys: Set<string>;
};

export type ActiveSessionProjection = {
  readonly sessionId: string;
  transcript: Message[];
  nextTurn: number;
  stateRevision: number;
  checkpoint?: SemanticContextCheckpointV1;
  modelSelection: ModelSelection;
  modelChanges: SessionModelChange[];
  turnModels: SessionTurnModelAttribution[];
  turnExecutions: SessionTurnExecutionAttribution[];
  title: string | null;
};
