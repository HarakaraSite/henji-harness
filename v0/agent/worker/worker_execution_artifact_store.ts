import {
  type StoredWorkerExecutionArtifact,
  validateWorkerExecutionArtifact,
  type WorkerExecutionArtifactPersistenceErrorCode,
} from './worker_execution_artifact.ts';

export type WorkerExecutionArtifactStoreErrorCode =
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
  write(artifact: StoredWorkerExecutionArtifact): Promise<void>;
}

/** Permission-free in-memory seam for focused Host lifecycle tests. */
export class FakeWorkerExecutionArtifactStore implements WorkerExecutionArtifactStore {
  private readonly artifacts = new Map<string, StoredWorkerExecutionArtifact>();
  private writes = 0;
  private writeError?: WorkerExecutionArtifactStoreError;

  get writeCount(): number {
    return this.writes;
  }

  failWrites(
    code: WorkerExecutionArtifactPersistenceErrorCode = 'worker_execution_artifact_io_failure',
  ): void {
    this.writeError = new WorkerExecutionArtifactStoreError(code);
  }

  async list(): Promise<readonly StoredWorkerExecutionArtifact[]> {
    await Promise.resolve();
    return [...this.artifacts.values()].map((artifact) => structuredClone(artifact));
  }

  async read(id: string): Promise<StoredWorkerExecutionArtifact> {
    await Promise.resolve();
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) {
      throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_not_found');
    }
    return structuredClone(artifact);
  }

  async write(artifact: StoredWorkerExecutionArtifact): Promise<void> {
    await Promise.resolve();
    this.writes += 1;
    if (this.writeError !== undefined) throw this.writeError;
    if (!validateWorkerExecutionArtifact(artifact) || this.artifacts.has(artifact.executionId)) {
      throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
    }
    this.artifacts.set(artifact.executionId, structuredClone(artifact));
  }
}
