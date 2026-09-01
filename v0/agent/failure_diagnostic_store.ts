import {
  decodeFailureDiagnostic,
  encodeFailureDiagnostic,
  type FailureDiagnosticPersister,
  type FailureDiagnosticV1,
  validateFailureDiagnostic,
} from './failure_diagnostic.ts';
import { workspaceDigest } from './session_store.ts';

export const MAX_FAILURE_DIAGNOSTICS = 16;
export const MAX_FAILURE_DIAGNOSTIC_BYTES = 16 * 1024;
export const FAILURE_DIAGNOSTIC_DIRECTORY_MODE = 0o700;
export const FAILURE_DIAGNOSTIC_FILE_MODE = 0o600;

export type FailureDiagnosticStoreErrorCode =
  | 'diagnostic_not_found'
  | 'diagnostic_busy'
  | 'diagnostic_invalid'
  | 'diagnostic_capacity'
  | 'diagnostic_io_failure';

export class FailureDiagnosticStoreError extends Error {
  constructor(
    readonly code: FailureDiagnosticStoreErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'FailureDiagnosticStoreError';
  }
}

export interface FailureDiagnosticPaths {
  readonly root: string;
  readonly diagnostics: string;
  readonly locks: string;
  readonly lock: string;
}

export interface FailureDiagnosticStoreOptions {
  /** Direct-test UUID seam; production uses the runtime CSPRNG. */
  readonly uuid?: () => string;
  /** Direct-test owner seam; production resolves the current OS UID. */
  readonly ownerId?: () => number;
  /** Direct-test atomic failure seam. */
  readonly atomicWrite?: (
    target: string,
    bytes: Uint8Array,
    temporary: string,
  ) => void;
  /** Filesystem seam for platforms where directory fsync is unavailable. */
  readonly syncDirectory?: (path: string) => void;
}

export interface FailureDiagnosticStore {
  list(): Promise<readonly FailureDiagnosticV1[]>;
  read(id: string): Promise<FailureDiagnosticV1>;
  write(diagnostic: FailureDiagnosticV1): Promise<void>;
  delete(id: string): Promise<void>;
  persist: FailureDiagnosticPersister;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TEMP_NAME = /^\.tmp-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;
const isBusy = (error: unknown): boolean => error instanceof Deno.errors.Busy;

const validAbsolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') &&
  value.trim() === value &&
  !value.includes('\0') && !value.includes('\r') && !value.includes('\n');

const mapIoError = (error: unknown): FailureDiagnosticStoreError => {
  if (error instanceof FailureDiagnosticStoreError) return error;
  if (isBusy(error)) return new FailureDiagnosticStoreError('diagnostic_busy');
  return new FailureDiagnosticStoreError('diagnostic_io_failure');
};

const inspectOwned = async (
  path: string,
  kind: 'directory' | 'file',
  mode: number,
  ownerId: number,
): Promise<Deno.FileInfo> => {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    throw mapIoError(error);
  }
  if (
    info.isSymlink ||
    kind === 'directory' && !info.isDirectory ||
    kind === 'file' && !info.isFile ||
    info.mode !== null && (info.mode & 0o777) !== mode ||
    info.uid !== null && info.uid !== undefined && info.uid !== ownerId
  ) throw new FailureDiagnosticStoreError('diagnostic_invalid');
  return info;
};

const ensureDirectory = async (
  path: string,
  mode: number,
  ownerId: number,
): Promise<void> => {
  try {
    await Deno.mkdir(path, { recursive: true, mode });
  } catch (error) {
    throw mapIoError(error);
  }
  await inspectOwned(path, 'directory', mode, ownerId);
};

const acquireLock = async (
  path: string,
  ownerId: number,
  exclusive = true,
): Promise<{ close(): void }> => {
  let file: Deno.FsFile;
  try {
    if (!exclusive) {
      await inspectOwned(path, 'file', FAILURE_DIAGNOSTIC_FILE_MODE, ownerId);
      file = await Deno.open(path, { read: true });
    } else {
      let exists = true;
      try {
        await Deno.lstat(path);
      } catch (error) {
        if (!isNotFound(error)) throw mapIoError(error);
        exists = false;
      }
      if (exists) {
        await inspectOwned(path, 'file', FAILURE_DIAGNOSTIC_FILE_MODE, ownerId);
      }
      file = await Deno.open(path, {
        read: true,
        write: true,
        create: true,
        mode: FAILURE_DIAGNOSTIC_FILE_MODE,
      });
      await Deno.chmod(path, FAILURE_DIAGNOSTIC_FILE_MODE);
      const info = await Deno.lstat(path);
      if (
        info.isSymlink || !info.isFile ||
        info.mode !== null &&
          (info.mode & 0o777) !== FAILURE_DIAGNOSTIC_FILE_MODE ||
        info.uid !== null && info.uid !== undefined && info.uid !== ownerId
      ) throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
    try {
      const locked = await file.tryLock(exclusive);
      if (!locked) throw new FailureDiagnosticStoreError('diagnostic_busy');
    } catch (error) {
      try {
        file.close();
      } catch {
        // Preserve the lock failure.
      }
      if (isBusy(error)) {
        throw new FailureDiagnosticStoreError('diagnostic_busy');
      }
      throw error;
    }
  } catch (error) {
    throw mapIoError(error);
  }
  return {
    close() {
      try {
        file.unlockSync();
      } catch {
        // The lock may already have been released by kernel cleanup.
      }
      try {
        file.close();
      } catch {
        // Closing is best effort after the lock boundary.
      }
    },
  };
};

const defaultAtomicWrite = (
  target: string,
  bytes: Uint8Array,
  temporary: string,
): void => {
  let file: Deno.FsFile | undefined;
  try {
    file = Deno.openSync(temporary, {
      write: true,
      createNew: true,
      mode: FAILURE_DIAGNOSTIC_FILE_MODE,
    });
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += file.writeSync(bytes.subarray(offset));
    }
    file.syncSync();
    file.close();
    file = undefined;
    Deno.chmodSync(temporary, FAILURE_DIAGNOSTIC_FILE_MODE);
    Deno.renameSync(temporary, target);
  } finally {
    try {
      file?.close();
    } catch {
      // Preserve the primary failure.
    }
    try {
      Deno.removeSync(temporary);
    } catch {
      // The rename already removed it, or cleanup is deferred for recovery.
    }
  }
};

const bestEffortSyncDirectory = (path: string): void => {
  try {
    const directory = Deno.openSync(path, { read: true });
    try {
      directory.syncSync();
    } finally {
      directory.close();
    }
  } catch {
    // Directory fsync is a platform seam; file sync and rename remain authoritative.
  }
};

const diagnosticIdFromName = (name: string): string | undefined => {
  if (!name.endsWith('.json')) return undefined;
  const id = name.slice(0, -5);
  return UUID_V4.test(id) ? id : undefined;
};

const diagnosticPaths = async (
  stateRoot: string,
  workspaceRoot: string,
): Promise<FailureDiagnosticPaths> => {
  if (!validAbsolutePath(stateRoot)) {
    throw new FailureDiagnosticStoreError('diagnostic_io_failure');
  }
  let digest: string;
  try {
    digest = await workspaceDigest(workspaceRoot);
  } catch {
    throw new FailureDiagnosticStoreError('diagnostic_invalid');
  }
  const root = `${stateRoot}/${digest}`;
  return {
    root,
    diagnostics: `${root}/diagnostics`,
    locks: `${root}/locks`,
    lock: `${root}/locks/.diagnostics.lock`,
  };
};

export const failureDiagnosticPaths = diagnosticPaths;

interface ScannedRecord {
  readonly diagnostic: FailureDiagnosticV1;
  readonly bytes: number;
}

export class DenoFailureDiagnosticStore implements FailureDiagnosticStore {
  readonly pathsPromise: Promise<FailureDiagnosticPaths>;
  private readonly ownerId: number;
  private readonly makeUuid: () => string;
  private readonly atomicWrite: typeof defaultAtomicWrite;
  private readonly syncDirectory: (path: string) => void;

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
    options: FailureDiagnosticStoreOptions = {},
  ) {
    if (!validAbsolutePath(stateRoot)) {
      throw new FailureDiagnosticStoreError('diagnostic_io_failure');
    }
    try {
      const ownerId = options.ownerId?.() ?? Deno.uid();
      if (ownerId === null) throw new Error('current owner is unavailable');
      this.ownerId = ownerId;
    } catch {
      throw new FailureDiagnosticStoreError('diagnostic_io_failure');
    }
    this.makeUuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
    this.atomicWrite = options.atomicWrite ?? defaultAtomicWrite;
    this.syncDirectory = options.syncDirectory ?? bestEffortSyncDirectory;
    this.pathsPromise = diagnosticPaths(stateRoot, workspaceRoot);
  }

  private async layout(): Promise<FailureDiagnosticPaths> {
    const paths = await this.pathsPromise;
    await ensureDirectory(
      this.stateRoot,
      FAILURE_DIAGNOSTIC_DIRECTORY_MODE,
      this.ownerId,
    );
    await ensureDirectory(
      paths.root,
      FAILURE_DIAGNOSTIC_DIRECTORY_MODE,
      this.ownerId,
    );
    await ensureDirectory(
      paths.diagnostics,
      FAILURE_DIAGNOSTIC_DIRECTORY_MODE,
      this.ownerId,
    );
    await ensureDirectory(
      paths.locks,
      FAILURE_DIAGNOSTIC_DIRECTORY_MODE,
      this.ownerId,
    );
    return paths;
  }

  /** Validate an existing layout without creating or modifying any path. */
  private async readLayout(): Promise<FailureDiagnosticPaths | undefined> {
    const paths = await this.pathsPromise;
    let diagnosticsExists = true;
    try {
      await Deno.lstat(paths.diagnostics);
    } catch (error) {
      if (!isNotFound(error)) throw mapIoError(error);
      diagnosticsExists = false;
    }
    if (!diagnosticsExists) return undefined;
    await inspectOwned(
      paths.diagnostics,
      'directory',
      FAILURE_DIAGNOSTIC_DIRECTORY_MODE,
      this.ownerId,
    );
    await inspectOwned(
      paths.locks,
      'directory',
      FAILURE_DIAGNOSTIC_DIRECTORY_MODE,
      this.ownerId,
    );
    await inspectOwned(
      paths.lock,
      'file',
      FAILURE_DIAGNOSTIC_FILE_MODE,
      this.ownerId,
    );
    return paths;
  }

  private async scan(
    paths: FailureDiagnosticPaths,
  ): Promise<readonly ScannedRecord[]> {
    const records: ScannedRecord[] = [];
    let temporaryCount = 0;
    let entries: Deno.DirEntry[];
    try {
      entries = [...(await Array.fromAsync(Deno.readDir(paths.diagnostics)))];
    } catch (error) {
      throw mapIoError(error);
    }
    for (const entry of entries) {
      const temporary = TEMP_NAME.test(entry.name);
      const id = diagnosticIdFromName(entry.name);
      if (!temporary && id === undefined) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      const path = `${paths.diagnostics}/${entry.name}`;
      const info = await inspectOwned(
        path,
        'file',
        FAILURE_DIAGNOSTIC_FILE_MODE,
        this.ownerId,
      );
      if (info.size <= 0 || info.size > 1_024) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      if (temporary) {
        temporaryCount += 1;
        if (temporaryCount > 1) {
          throw new FailureDiagnosticStoreError('diagnostic_invalid');
        }
        continue;
      }
      let diagnostic: FailureDiagnosticV1;
      try {
        diagnostic = decodeFailureDiagnostic(await Deno.readFile(path));
      } catch {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      if (
        !validateFailureDiagnostic(diagnostic) || diagnostic.diagnosticId !== id
      ) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      records.push({ diagnostic, bytes: info.size });
    }
    if (records.length > MAX_FAILURE_DIAGNOSTICS) {
      throw new FailureDiagnosticStoreError('diagnostic_capacity');
    }
    const total = records.reduce((sum, record) => sum + record.bytes, 0);
    if (total > MAX_FAILURE_DIAGNOSTIC_BYTES) {
      throw new FailureDiagnosticStoreError('diagnostic_capacity');
    }
    return records;
  }

  async list(): Promise<readonly FailureDiagnosticV1[]> {
    const paths = await this.readLayout();
    if (paths === undefined) return [];
    const lock = await acquireLock(paths.lock, this.ownerId, false);
    try {
      const records = await this.scan(paths);
      return records.map(({ diagnostic }) => diagnostic).sort((left, right) =>
        left.occurredAt === right.occurredAt
          ? left.diagnosticId.localeCompare(right.diagnosticId)
          : left.occurredAt.localeCompare(right.occurredAt)
      );
    } finally {
      lock.close();
    }
  }

  async read(id: string): Promise<FailureDiagnosticV1> {
    if (!UUID_V4.test(id)) {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
    const paths = await this.readLayout();
    if (paths === undefined) {
      throw new FailureDiagnosticStoreError('diagnostic_not_found');
    }
    const lock = await acquireLock(paths.lock, this.ownerId, false);
    try {
      const records = await this.scan(paths);
      const found = records.find(({ diagnostic }) => diagnostic.diagnosticId === id);
      if (found === undefined) {
        throw new FailureDiagnosticStoreError('diagnostic_not_found');
      }
      return found.diagnostic;
    } finally {
      lock.close();
    }
  }

  async write(diagnostic: FailureDiagnosticV1): Promise<void> {
    if (!validateFailureDiagnostic(diagnostic)) {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
    const body = `${encodeFailureDiagnostic(diagnostic)}\n`;
    const bytes = new TextEncoder().encode(body);
    if (bytes.byteLength > 1_024) {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
    const paths = await this.layout();
    const lock = await acquireLock(paths.lock, this.ownerId);
    try {
      const records = await this.scan(paths);
      if (
        records.some(({ diagnostic: current }) => current.diagnosticId === diagnostic.diagnosticId)
      ) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      const total = records.reduce((sum, record) => sum + record.bytes, 0);
      if (
        records.length >= MAX_FAILURE_DIAGNOSTICS ||
        total + bytes.byteLength > MAX_FAILURE_DIAGNOSTIC_BYTES
      ) throw new FailureDiagnosticStoreError('diagnostic_capacity');
      const temporary = `${paths.diagnostics}/.tmp-${this.makeUuid().toLowerCase()}`;
      if (!TEMP_NAME.test(temporary.slice(paths.diagnostics.length + 1))) {
        throw new FailureDiagnosticStoreError('diagnostic_io_failure');
      }
      try {
        this.atomicWrite(
          `${paths.diagnostics}/${diagnostic.diagnosticId}.json`,
          bytes,
          temporary,
        );
        this.syncDirectory(paths.diagnostics);
      } catch (error) {
        throw mapIoError(error);
      }
    } finally {
      lock.close();
    }
  }

  async delete(id: string): Promise<void> {
    if (!UUID_V4.test(id)) {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
    const paths = await this.readLayout();
    if (paths === undefined) {
      throw new FailureDiagnosticStoreError('diagnostic_not_found');
    }
    const lock = await acquireLock(paths.lock, this.ownerId);
    try {
      const records = await this.scan(paths);
      const found = records.find(({ diagnostic }) => diagnostic.diagnosticId === id);
      if (found === undefined) {
        throw new FailureDiagnosticStoreError('diagnostic_not_found');
      }
      try {
        await Deno.remove(`${paths.diagnostics}/${id}.json`);
        this.syncDirectory(paths.diagnostics);
      } catch (error) {
        throw mapIoError(error);
      }
    } finally {
      lock.close();
    }
  }

  persist: FailureDiagnosticPersister = (diagnostic) => this.write(diagnostic);
}

/** Permission-free persistence seam for loop/session lifecycle tests. */
export class FakeFailureDiagnosticStore implements FailureDiagnosticStore {
  private readonly records = new Map<string, FailureDiagnosticV1>();
  private writeFailure: FailureDiagnosticStoreError | undefined;

  constructor(readonly workspaceRoot = '/workspace') {}

  failWrites(
    error = new FailureDiagnosticStoreError('diagnostic_io_failure'),
  ): void {
    this.writeFailure = error;
  }

  async list(): Promise<readonly FailureDiagnosticV1[]> {
    await Promise.resolve();
    return [...this.records.values()].sort((left, right) =>
      left.diagnosticId.localeCompare(right.diagnosticId)
    );
  }

  async read(id: string): Promise<FailureDiagnosticV1> {
    await Promise.resolve();
    const value = this.records.get(id);
    if (value === undefined) {
      throw new FailureDiagnosticStoreError('diagnostic_not_found');
    }
    return value;
  }

  async write(diagnostic: FailureDiagnosticV1): Promise<void> {
    await Promise.resolve();
    if (this.writeFailure !== undefined) throw this.writeFailure;
    if (!validateFailureDiagnostic(diagnostic)) {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
    if (this.records.has(diagnostic.diagnosticId)) {
      throw new FailureDiagnosticStoreError('diagnostic_invalid');
    }
    if (
      this.records.size >= MAX_FAILURE_DIAGNOSTICS ||
      [...this.records.values()].reduce(
              (sum, value) =>
                sum +
                new TextEncoder().encode(`${encodeFailureDiagnostic(value)}\n`)
                  .byteLength,
              0,
            ) +
            new TextEncoder().encode(`${encodeFailureDiagnostic(diagnostic)}\n`)
              .byteLength >
        MAX_FAILURE_DIAGNOSTIC_BYTES
    ) throw new FailureDiagnosticStoreError('diagnostic_capacity');
    this.records.set(diagnostic.diagnosticId, structuredClone(diagnostic));
  }

  async delete(id: string): Promise<void> {
    await Promise.resolve();
    if (!this.records.delete(id)) {
      throw new FailureDiagnosticStoreError('diagnostic_not_found');
    }
  }

  persist: FailureDiagnosticPersister = (diagnostic) => this.write(diagnostic);
}
