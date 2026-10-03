import type { LoopOutcome } from '../core/contracts.ts';
import type { DataExecutionControlInput } from '../data/data_contract.ts';
import type { WorkerCorrelation } from './worker_protocol.ts';
import type { WorkerExecutionTraceEntry } from './worker_execution_artifact.ts';

export type WorkerSmallOutcome = Omit<LoopOutcome, 'transcript'>;

export type WorkerAdmission = Readonly<{
  executionId: string;
  completion: Promise<WorkerSmallOutcome>;
}>;

export type PendingWorkerAdmission = {
  readonly task: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly createdAt: string;
  cancelled: boolean;
  admitted: boolean;
  controlSequence: number;
  controlWrites: Promise<void>;
  pendingControlFacts: DataExecutionControlInput[];
  processCleanupRecorded: boolean;
  correlation?: WorkerCorrelation;
  resolve?: (admission: WorkerAdmission) => void;
  reject?: (error: Error) => void;
  watchdog?: ReturnType<typeof setTimeout>;
  completion?: Promise<WorkerSmallOutcome>;
};

/** Small process-control index for the active execution; durable state stays in Data. */
export type ActiveWorkerExecution = {
  readonly executionId: string;
  readonly turn: number;
  readonly correlation: WorkerCorrelation;
  readonly protocolTrace: WorkerExecutionTraceEntry[];
  readonly reservation: PendingWorkerAdmission;
  requestCount: number;
  latestRequestOrdinal?: number;
  latestModelStep?: number;
  settling: boolean;
  cancelled: boolean;
  forced: boolean;
  dispatched: boolean;
  terminalPromise?: Promise<WorkerSmallOutcome>;
};
