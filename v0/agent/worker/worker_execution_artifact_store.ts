import { type StoredWorkerExecutionArtifact } from './worker_execution_artifact.ts';

type WorkerExecutionArtifactStoreErrorCode =
  | 'worker_execution_artifact_not_found'
  | 'worker_execution_artifact_invalid'
  | 'worker_execution_artifact_io_failure';

export class WorkerExecutionArtifactStoreError extends Error {
  constructor(
    readonly code: WorkerExecutionArtifactStoreErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'WorkerExecutionArtifactStoreError';
  }
}

export interface WorkerExecutionArtifactStore {
  list(): Promise<readonly StoredWorkerExecutionArtifact[]>;
  read(id: string): Promise<StoredWorkerExecutionArtifact>;
}
