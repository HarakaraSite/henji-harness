import {
  decodeWorkerExecutionArtifact,
  encodeWorkerExecutionArtifact,
  validateWorkerExecutionArtifact,
  type WorkerExecutionArtifactPersistenceErrorCode,
  type WorkerExecutionArtifactV1,
  type WorkerExecutionStoreResult,
} from './worker_execution_artifact.ts';
import { workspaceDigest } from '../session/session_store.ts';

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

export interface WorkerExecutionArtifactPaths {
  readonly root: string;
  readonly executions: string;
}

export interface WorkerExecutionArtifactStore {
  list(): Promise<readonly WorkerExecutionArtifactV1[]>;
  read(id: string): Promise<WorkerExecutionArtifactV1>;
  write(artifact: WorkerExecutionArtifactV1): Promise<void>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && value.trim() === value &&
  !value.includes('\0') && !value.includes('\r') && !value.includes('\n');

export const workerExecutionArtifactPaths = async (
  stateRoot: string,
  workspaceRoot: string,
): Promise<WorkerExecutionArtifactPaths> => {
  if (!absolutePath(stateRoot)) {
    throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_io_failure');
  }
  let digest: string;
  try {
    digest = await workspaceDigest(workspaceRoot);
  } catch {
    throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
  }
  const root = `${stateRoot}/${digest}`;
  return { root, executions: `${root}/worker-executions` };
};

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;

const artifactIdFromPath = (id: string): string => {
  if (!UUID_V4.test(id)) {
    throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
  }
  return `${id}.json`;
};

const ioError = (error: unknown): WorkerExecutionArtifactStoreError =>
  error instanceof WorkerExecutionArtifactStoreError
    ? error
    : new WorkerExecutionArtifactStoreError('worker_execution_artifact_io_failure');

/** Durable, workspace-partitioned store. Each execution ID is written at most once. */
export class DenoWorkerExecutionArtifactStore implements WorkerExecutionArtifactStore {
  readonly pathsPromise: Promise<WorkerExecutionArtifactPaths>;

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
  ) {
    this.pathsPromise = workerExecutionArtifactPaths(stateRoot, workspaceRoot);
  }

  private async layout(): Promise<WorkerExecutionArtifactPaths> {
    const paths = await this.pathsPromise;
    try {
      await Deno.mkdir(paths.executions, { recursive: true });
    } catch (error) {
      throw ioError(error);
    }
    return paths;
  }

  async list(): Promise<readonly WorkerExecutionArtifactV1[]> {
    const paths = await this.pathsPromise;
    const result: WorkerExecutionArtifactV1[] = [];
    try {
      for await (const entry of Deno.readDir(paths.executions)) {
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (!UUID_V4.test(id)) {
          throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
        }
        const artifact = decodeWorkerExecutionArtifact(
          await Deno.readFile(`${paths.executions}/${entry.name}`),
        );
        if (artifact.executionId !== id) {
          throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
        }
        result.push(artifact);
      }
    } catch (error) {
      if (isNotFound(error)) return [];
      throw ioError(error);
    }
    return result.sort((left, right) =>
      left.settledAt === right.settledAt
        ? left.executionId.localeCompare(right.executionId)
        : left.settledAt.localeCompare(right.settledAt)
    );
  }

  async read(id: string): Promise<WorkerExecutionArtifactV1> {
    const paths = await this.pathsPromise;
    const name = artifactIdFromPath(id);
    try {
      const artifact = decodeWorkerExecutionArtifact(
        await Deno.readFile(`${paths.executions}/${name}`),
      );
      if (artifact.executionId !== id) {
        throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
      }
      return artifact;
    } catch (error) {
      if (error instanceof WorkerExecutionArtifactStoreError) throw error;
      if (isNotFound(error)) {
        throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_not_found');
      }
      throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_io_failure');
    }
  }

  async write(artifact: WorkerExecutionArtifactV1): Promise<void> {
    if (!validateWorkerExecutionArtifact(artifact)) {
      throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
    }
    const paths = await this.layout();
    const target = `${paths.executions}/${artifactIdFromPath(artifact.executionId)}`;
    const temporary = `${paths.executions}/.${artifact.executionId}.tmp`;
    try {
      try {
        await Deno.lstat(target);
        throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await Deno.writeTextFile(temporary, `${encodeWorkerExecutionArtifact(artifact)}\n`, {
        createNew: true,
      });
      await Deno.rename(temporary, target);
    } catch (error) {
      throw ioError(error);
    } finally {
      try {
        await Deno.remove(temporary);
      } catch {
        // The rename already removed it, or a failed write has no temporary file.
      }
    }
  }
}

/** Provider-free store seam for the focused Host lifecycle proof. */
export class FakeWorkerExecutionArtifactStore implements WorkerExecutionArtifactStore {
  private readonly artifacts = new Map<string, WorkerExecutionArtifactV1>();
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

  async list(): Promise<readonly WorkerExecutionArtifactV1[]> {
    await Promise.resolve();
    return [...this.artifacts.values()].map((artifact) => structuredClone(artifact));
  }

  async read(id: string): Promise<WorkerExecutionArtifactV1> {
    await Promise.resolve();
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) {
      throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_not_found');
    }
    return structuredClone(artifact);
  }

  async write(artifact: WorkerExecutionArtifactV1): Promise<void> {
    await Promise.resolve();
    this.writes += 1;
    if (this.writeError !== undefined) throw this.writeError;
    if (!validateWorkerExecutionArtifact(artifact)) {
      throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
    }
    if (this.artifacts.has(artifact.executionId)) {
      throw new WorkerExecutionArtifactStoreError('worker_execution_artifact_invalid');
    }
    this.artifacts.set(artifact.executionId, structuredClone(artifact));
  }
}

export const isWorkerExecutionArtifactStoreError = (
  error: unknown,
): error is WorkerExecutionArtifactStoreError => error instanceof WorkerExecutionArtifactStoreError;

export type WorkerExecutionArtifactStoreResult = WorkerExecutionStoreResult;
