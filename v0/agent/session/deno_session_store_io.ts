import { SessionStoreError } from './session_store_contract.ts';

export type Lock = { readonly close: () => void };

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;
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
      if (!locked) throw new SessionStoreError('session_busy');
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
