import {
  isSessionId,
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  SessionStoreError,
} from './session_store_contract.ts';

export type Lock = { readonly close: () => void };

export const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;
export const isAlreadyExists = (error: unknown): boolean =>
  error instanceof Deno.errors.AlreadyExists;
const isBusy = (error: unknown): boolean => error instanceof Deno.errors.Busy;

export const ensureDirectory = async (
  path: string,
  mode: number,
): Promise<void> => {
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink || !info.isDirectory) {
      throw new Error('invalid session directory');
    }
    if (info.mode !== null && (info.mode & 0o777) !== mode) {
      throw new Error('invalid session directory mode');
    }
    await Deno.chmod(path, mode);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await Deno.mkdir(path, { recursive: true, mode });
    const info = await Deno.lstat(path);
    if (info.isSymlink || !info.isDirectory) {
      throw new Error('invalid session directory');
    }
    if (info.mode !== null && (info.mode & 0o777) !== mode) {
      throw new Error('invalid session directory mode');
    }
    await Deno.chmod(path, mode);
  }
};

export const validateSessionDirectory = async (path: string): Promise<void> => {
  let tempCount = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      const isTemp = entry.name.startsWith('.tmp-') &&
        isSessionId(entry.name.slice(5));
      if (entry.name !== 'session.json' && !isTemp) {
        throw new SessionStoreError('session_invalid');
      }
      if (isTemp) tempCount += 1;
      const info = await Deno.lstat(`${path}/${entry.name}`);
      if (
        info.isSymlink || !info.isFile ||
        (info.mode !== null && (info.mode & 0o777) !== 0o600)
      ) {
        throw new SessionStoreError('session_invalid');
      }
    }
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    throw new SessionStoreError('session_io_failure');
  }
  if (tempCount > 1) throw new SessionStoreError('session_invalid');
};

export const acquireLock = async (path: string): Promise<Lock> => {
  let file: Deno.FsFile;
  try {
    try {
      const existing = await Deno.lstat(path);
      if (existing.isSymlink || !existing.isFile) {
        throw new SessionStoreError('session_io_failure');
      }
      if (existing.mode !== null && (existing.mode & 0o777) !== 0o600) {
        throw new SessionStoreError('session_io_failure');
      }
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      if (!isNotFound(error)) throw error;
    }
    file = await Deno.open(path, {
      read: true,
      write: true,
      create: true,
      mode: 0o600,
    });
    await Deno.chmod(path, 0o600);
    try {
      const locked = await file.tryLock(true);
      if (!locked) {
        throw new SessionStoreError('session_busy');
      }
    } catch (error) {
      file.close();
      if (isBusy(error)) throw new SessionStoreError('session_busy');
      if (error instanceof SessionStoreError) throw error;
      throw error;
    }
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    throw new SessionStoreError('session_io_failure');
  }
  return {
    close: () => {
      try {
        file.unlockSync();
      } catch {
        // The lock may already have been released by a kernel cleanup.
      }
      try {
        file.close();
      } catch {
        // Closing is best effort after the lock boundary.
      }
    },
  };
};

export const writeAtomic = (
  target: string,
  bytes: Uint8Array,
  temporary: string,
): void => {
  let file: Deno.FsFile | undefined;
  try {
    file = Deno.openSync(temporary, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += file.writeSync(bytes.subarray(offset));
    }
    file.syncSync();
    file.close();
    file = undefined;
    Deno.chmodSync(temporary, 0o600);
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

export type NamespaceEntries = {
  readonly sessions: readonly Deno.DirEntry[];
  readonly locks: readonly Deno.DirEntry[];
  readonly contexts: readonly Deno.DirEntry[];
};

/** Scan all top-level namespaces while holding the index lock, stopping at entry 513. */
const scanBoundedNamespace = async (
  path: string,
): Promise<readonly Deno.DirEntry[]> => {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entries.length >= MAX_WORKSPACE_DIRECTORY_ENTRIES) {
        throw new SessionStoreError('session_limit');
      }
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    throw new SessionStoreError('session_io_failure');
  }
  return entries;
};

export const scanNamespaces = async (paths: {
  readonly sessions: string;
  readonly locks: string;
  readonly contexts: string;
}): Promise<NamespaceEntries> => ({
  sessions: await scanBoundedNamespace(paths.sessions),
  locks: await scanBoundedNamespace(paths.locks),
  contexts: await scanBoundedNamespace(paths.contexts),
});
