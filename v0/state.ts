import {
  type ActionKind,
  type Attempt,
  emptyState,
  type Failure,
  failure,
  type InstalledExtension,
  parseState,
  type State,
} from './domain.ts';
import { installedPath, manifestBytes, prepareExtension } from './extensions.ts';

const encoder = new TextEncoder();

export const statePaths = (stateDir: string) => ({
  state: `${stateDir}/state.json`,
  lock: `${stateDir}/state.lock`,
  runLock: `${stateDir}/run.lock`,
  extensions: `${stateDir}/extensions`,
  runs: `${stateDir}/runs`,
});

// Keep the state-layer default fail-closed even when callers do not go through
// the CLI composition root. The CLI passes the same bound explicitly.
export const MIN_PROFILE_BUDGET_USD = 0.062208;

const randomId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

/**
 * A package directory can survive a crash between its final rename and the
 * state.json commit. Adopt it only after checking its complete byte content;
 * an existing directory is never overwritten or trusted by name alone.
 */
const verifyInstalledPackage = async (
  path: string,
  extension: InstalledExtension,
  source: Uint8Array,
): Promise<boolean | Failure> => {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(path)];
  } catch (caught) {
    if (caught instanceof Deno.errors.NotFound) return false;
    return failure('digest_mismatch', 'existing package directory cannot be inspected');
  }
  if (
    entries.some((entry) => entry.isSymlink) ||
    entries.map((entry) => entry.name).sort().join(',') !== 'main.ts,manifest.json'
  ) return failure('digest_mismatch', 'existing package directory has unexpected files');
  try {
    const manifest = await Deno.readFile(`${path}/manifest.json`);
    const main = await Deno.readFile(`${path}/main.ts`);
    if (!bytesEqual(manifest, manifestBytes(extension)) || !bytesEqual(main, source)) {
      return failure('digest_mismatch', 'existing package bytes do not match expected digest');
    }
  } catch {
    return failure('digest_mismatch', 'existing package bytes cannot be read');
  }
  return true;
};

const ensureDir = async (path: string): Promise<void> => {
  await Deno.mkdir(path, { recursive: true });
};

export const readState = async (stateDir: string): Promise<State | Failure> => {
  const path = statePaths(stateDir).state;
  try {
    const text = await Deno.readTextFile(path);
    return parseState(JSON.parse(text));
  } catch (caught) {
    if (caught instanceof Deno.errors.NotFound) return emptyState();
    return failure('state_invalid', 'state.json is unreadable or malformed');
  }
};

export const writeStateAtomic = async (
  stateDir: string,
  state: State,
  operationId = randomId('state'),
): Promise<void> => {
  await ensureDir(stateDir);
  const path = statePaths(stateDir).state;
  const temp = `${path}.tmp.${operationId}`;
  const file = await Deno.open(temp, { createNew: true, write: true });
  try {
    await file.write(encoder.encode(`${JSON.stringify(state)}\n`));
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(temp, path);
};

export const withExclusiveLock = async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
  await ensureDir(path.slice(0, path.lastIndexOf('/')));
  const lockFile = await Deno.open(path, { create: true, read: true, write: true });
  await lockFile.lock(true);
  try {
    return await fn();
  } finally {
    try {
      await lockFile.unlock();
    } catch { /* process exit also releases advisory lock */ }
    lockFile.close();
  }
};

const findInstalled = (state: State, id: string, digest: string): InstalledExtension | undefined =>
  state.installed.find((item) => item.id === id && item.digest === digest);

const transition = (
  stateDir: string,
  kind: ActionKind,
  id: string,
  digest: string,
  expected: 'none' | 'same' | 'different',
): Promise<State | Failure> =>
  withExclusiveLock(statePaths(stateDir).lock, async () => {
    const current = await readState(stateDir);
    if ('code' in current) return current;
    const target = findInstalled(current, id, digest);
    if (!target) return failure('not_found', 'exact installed extension digest was not found');
    const active = current.active;
    if (expected === 'none' && active) {
      return failure('state_conflict', 'an active extension already exists');
    }
    if (expected !== 'none' && !active) {
      return failure('no_active', 'no extension is active');
    }
    if (
      expected === 'same' && active && active.id === id && active.digest === digest
    ) return failure('already_active', 'target extension is already active');
    if (
      expected === 'different' && active && active.id === id && active.digest === digest
    ) return failure('already_active', 'target extension is already active');
    const nextActive = {
      id: target.id,
      version: target.version,
      revision: target.revision,
      digest: target.digest,
    };
    const nextSequence = current.sequence + 1;
    const next: State = {
      ...current,
      sequence: nextSequence,
      active: nextActive,
      actions: [...current.actions, {
        sequence: nextSequence,
        kind,
        id,
        digest,
        at: new Date().toISOString(),
        explicit: true,
      }],
    };
    if (next.actions.length > 256) return failure('limit_exceeded', 'action history limit reached');
    await writeStateAtomic(stateDir, next);
    return next;
  });

export const installExtension = async (
  stateDir: string,
  sourceDir: string,
): Promise<{ state: State; installed: InstalledExtension } | Failure> => {
  const prepared = await prepareExtension(sourceDir);
  if ('code' in prepared) return prepared;
  return withExclusiveLock(statePaths(stateDir).lock, async () => {
    const current = await readState(stateDir);
    if ('code' in current) return current;
    if (
      current.installed.some((item) =>
        item.id === prepared.manifest.id && item.digest === prepared.digest
      )
    ) return failure('state_conflict', 'exact digest is already installed');
    if (current.actions.length >= 256) {
      return failure('limit_exceeded', 'action history limit reached');
    }
    const extension: InstalledExtension = {
      ...prepared.manifest,
      digest: prepared.digest,
      sourceOrigin: prepared.sourceOrigin,
      installedAt: new Date().toISOString(),
    };
    const finalDir = installedPath(stateDir, extension);
    const tempDir = `${stateDir}/extensions/${extension.id}/.tmp-${randomId('install')}`;
    await ensureDir(`${stateDir}/extensions/${extension.id}`);
    const existing = await verifyInstalledPackage(finalDir, extension, prepared.main);
    if (typeof existing !== 'boolean') return existing;
    if (!existing) {
      await ensureDir(tempDir);
      try {
        await Deno.writeFile(`${tempDir}/manifest.json`, manifestBytes(extension));
        await Deno.writeFile(`${tempDir}/main.ts`, prepared.main);
        await Deno.rename(tempDir, finalDir);
      } catch (caught) {
        try {
          await Deno.remove(tempDir, { recursive: true });
        } catch { /* orphan cleanup is best effort */ }
        return failure('state_invalid', `install package commit failed: ${String(caught)}`);
      }
    }
    const sequence = current.sequence + 1;
    const next: State = {
      ...current,
      sequence,
      installed: [...current.installed, extension],
      actions: [...current.actions, {
        sequence,
        kind: 'install',
        id: extension.id,
        digest: extension.digest,
        at: new Date().toISOString(),
        explicit: true,
      }],
    };
    try {
      await writeStateAtomic(stateDir, next);
    } catch (caught) {
      return failure(
        'state_invalid',
        `state commit failed after package commit: ${String(caught)}`,
      );
    }
    return { state: next, installed: extension };
  });
};

export const activateExtension = (stateDir: string, id: string, digest: string) =>
  transition(stateDir, 'activate', id, digest, 'none');
export const switchExtension = (stateDir: string, id: string, digest: string) =>
  transition(stateDir, 'switch', id, digest, 'different');
export const rollbackExtension = (stateDir: string, id: string, digest: string) =>
  transition(stateDir, 'rollback', id, digest, 'different');

export const packageEntrypoint = (stateDir: string, extension: InstalledExtension): string =>
  `${installedPath(stateDir, extension)}/${extension.entrypoint}`;

export const activeExtension = (state: State): InstalledExtension | Failure => {
  if (!state.active) return failure('no_active', 'no extension is active');
  const active = findInstalled(state, state.active.id, state.active.digest);
  return active ?? failure('state_invalid', 'active extension is not installed');
};

export const updateAttempt = (
  stateDir: string,
  attemptId: string,
  status: Attempt['status'],
  errorCode?: string,
): Promise<State | Failure> =>
  withExclusiveLock(statePaths(stateDir).lock, async () => {
    const current = await readState(stateDir);
    if ('code' in current) return current;
    const index = current.attempts.findIndex((attempt) => attempt.id === attemptId);
    if (index < 0) return failure('not_found', 'attempt was not found');
    const old = current.attempts[index];
    const allowed: Record<Attempt['status'], readonly Attempt['status'][]> = {
      authorized: [],
      started: ['authorized'],
      succeeded: ['started'],
      failed: ['started'],
      indeterminate: ['started'],
    };
    if (!allowed[status].includes(old.status)) {
      return failure('state_conflict', 'invalid attempt transition');
    }
    const updated: Attempt = {
      ...old,
      status,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : {}),
    };
    const attempts = [...current.attempts];
    attempts[index] = updated;
    const next: State = { ...current, attempts };
    await writeStateAtomic(stateDir, next);
    return next;
  });

export const authorizeAttempt = (
  stateDir: string,
  attemptId: string,
  maxUsd: number,
): Promise<Attempt | Failure> =>
  withExclusiveLock(statePaths(stateDir).lock, async () => {
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(attemptId) || !Number.isFinite(maxUsd) || maxUsd <= 0 ||
      maxUsd > 0.064
    ) return failure('invalid_input', 'attempt id or budget is invalid');
    const current = await readState(stateDir);
    if ('code' in current) return current;
    if (current.attempts.some((attempt) => attempt.id === attemptId)) {
      return failure('state_conflict', 'attempt id already exists');
    }
    const now = new Date().toISOString();
    const attempt: Attempt = {
      id: attemptId,
      status: 'authorized',
      maxRequests: 1,
      maxUsd,
      requestCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const next: State = { ...current, attempts: [...current.attempts, attempt] };
    await writeStateAtomic(stateDir, next);
    return attempt;
  });

export const startAttempt = (
  stateDir: string,
  attemptId: string,
  requiredMaxUsd = MIN_PROFILE_BUDGET_USD,
): Promise<Attempt | Failure> =>
  withExclusiveLock(statePaths(stateDir).lock, async () => {
    const current = await readState(stateDir);
    if ('code' in current) return current;
    const attempt = current.attempts.find((item) => item.id === attemptId);
    if (!attempt || attempt.status !== 'authorized' || attempt.requestCount !== 0) {
      return failure('external_attempt_used', 'attempt is not unused and authorized');
    }
    if (!Number.isFinite(requiredMaxUsd) || attempt.maxUsd < requiredMaxUsd) {
      return failure('limit_exceeded', 'authorized budget is below the required profile bound');
    }
    const updated: Attempt = {
      ...attempt,
      status: 'started',
      requestCount: 1,
      updatedAt: new Date().toISOString(),
    };
    const next: State = {
      ...current,
      attempts: current.attempts.map((item) => item.id === attemptId ? updated : item),
    };
    await writeStateAtomic(stateDir, next);
    return updated;
  });
