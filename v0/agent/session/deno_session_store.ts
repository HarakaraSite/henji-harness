import {
  type DefinitionRevisionRef,
  isSessionId,
  MAX_CONTEXT_CHECKPOINT_FILE_BYTES,
  MAX_SESSION_FILE_BYTES,
  MAX_VALID_SESSIONS_PER_WORKSPACE,
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  type SemanticContextCheckpointV1,
  type SessionHandle,
  type SessionListResult,
  type SessionMetadata,
  type SessionRecord,
  SessionStoreError,
  type SessionStoreOptions,
  type SessionStorePort,
  type StoredSessionRecord,
  type WorkerSessionHandle,
  type WorkerSessionListResult,
  type WorkerSessionMetadata,
  type WorkerSessionStorePort,
} from './session_store_contract.ts';
import {
  compareSessionMetadata,
  decodeSemanticContextCheckpoint,
  decodeSessionRecord,
  decodeStoredSessionRecord,
  encodeSemanticContextCheckpoint,
  encodeSessionRecord,
  encodeSessionRecordV2,
  encodeSessionRecordV3,
  encodeSessionRecordV4,
  metadataFromRecord,
  metadataFromStoredRecord,
  validRevisionRef,
} from './session_record_codec.ts';
import { sessionPaths } from './session_store_paths.ts';
import {
  acquireLock,
  ensureDirectory,
  isAlreadyExists,
  isNotFound,
  type Lock,
  scanNamespaces,
  validateSessionDirectory,
  writeAtomic,
} from './deno_session_store_io.ts';

export class DenoSessionStore implements SessionStorePort, WorkerSessionStorePort {
  readonly pathsPromise: Promise<
    {
      readonly root: string;
      readonly sessions: string;
      readonly locks: string;
      readonly contexts: string;
    }
  >;
  private paths?: {
    readonly root: string;
    readonly sessions: string;
    readonly locks: string;
    readonly contexts: string;
  };

  private readonly makeUuid: () => string;
  private readonly removeSync: (path: string) => void;
  private readonly beforeOpenExistingLock?: (id: string) => Promise<void>;
  private readonly sourceProfileId?: string;

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
    options: SessionStoreOptions = {},
  ) {
    if (
      !stateRoot.startsWith('/') || stateRoot.trim() === '' ||
      stateRoot.includes('\0')
    ) {
      throw new SessionStoreError('session_io_failure');
    }
    this.makeUuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
    this.removeSync = options.removeSync ?? Deno.removeSync;
    this.beforeOpenExistingLock = options.beforeOpenExistingLock;
    this.sourceProfileId = options.sourceProfileId;
    this.pathsPromise = sessionPaths(stateRoot, workspaceRoot).then((paths) => {
      this.paths = paths;
      return paths;
    });
  }

  private async layout() {
    const paths = await this.pathsPromise;
    await ensureDirectory(this.stateRoot, 0o700);
    await ensureDirectory(paths.root, 0o700);
    await ensureDirectory(paths.sessions, 0o700);
    await ensureDirectory(paths.locks, 0o700);
    await ensureDirectory(paths.contexts, 0o700);
    return paths;
  }

  async read(id: string): Promise<SessionRecord> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const paths = await this.layout();
    const path = `${paths.sessions}/${id}/session.json`;
    try {
      const directory = await Deno.lstat(`${paths.sessions}/${id}`);
      if (
        directory.isSymlink || !directory.isDirectory ||
        (directory.mode !== null && (directory.mode & 0o777) !== 0o700)
      ) {
        throw new SessionStoreError('session_invalid');
      }
      await validateSessionDirectory(`${paths.sessions}/${id}`);
      const info = await Deno.lstat(path);
      if (
        info.isSymlink || !info.isFile ||
        (info.mode !== null && (info.mode & 0o777) !== 0o600)
      ) {
        throw new SessionStoreError('session_invalid');
      }
      if (info.size <= 0 || info.size > MAX_SESSION_FILE_BYTES) {
        throw new SessionStoreError('session_invalid');
      }
      const record = decodeSessionRecord(await Deno.readFile(path));
      if (
        record.sessionId !== id || record.workspaceRoot !== this.workspaceRoot
      ) {
        throw new SessionStoreError('session_invalid');
      }
      return record;
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      if (isNotFound(error)) throw new SessionStoreError('session_not_found');
      throw new SessionStoreError('session_io_failure');
    }
  }

  async readWorker(id: string): Promise<StoredSessionRecord> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const paths = await this.layout();
    const path = `${paths.sessions}/${id}/session.json`;
    try {
      const directory = await Deno.lstat(`${paths.sessions}/${id}`);
      if (
        directory.isSymlink || !directory.isDirectory ||
        (directory.mode !== null && (directory.mode & 0o777) !== 0o700)
      ) throw new SessionStoreError('session_invalid');
      await validateSessionDirectory(`${paths.sessions}/${id}`);
      const info = await Deno.lstat(path);
      if (
        info.isSymlink || !info.isFile ||
        (info.mode !== null && (info.mode & 0o777) !== 0o600) ||
        info.size <= 0 || info.size > MAX_SESSION_FILE_BYTES
      ) throw new SessionStoreError('session_invalid');
      const record = decodeStoredSessionRecord(await Deno.readFile(path));
      if (
        record.sessionId !== id || record.workspaceRoot !== this.workspaceRoot
      ) {
        throw new SessionStoreError('session_invalid');
      }
      return record;
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      if (isNotFound(error)) throw new SessionStoreError('session_not_found');
      throw new SessionStoreError('session_io_failure');
    }
  }

  async listWorker(): Promise<WorkerSessionListResult> {
    const paths = await this.layout();
    const index = await acquireLock(`${paths.locks}/.index.lock`);
    try {
      const entries = (await scanNamespaces(paths)).sessions;
      const result: WorkerSessionMetadata[] = [];
      let skippedInvalid = 0;
      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymlink || !isSessionId(entry.name)) {
          skippedInvalid += 1;
          continue;
        }
        try {
          const record = await this.readWorker(entry.name);
          const checkpoint = await this.readCheckpoint(entry.name);
          if (
            checkpoint !== undefined &&
            (checkpoint.sourceProfileId.length === 0 ||
              checkpoint.coveredThroughTurn >= record.nextTurn - 1 ||
              checkpoint.retainedFromTurn !== checkpoint.coveredThroughTurn + 1)
          ) throw new SessionStoreError('session_invalid');
          result.push(metadataFromStoredRecord(record));
        } catch (error) {
          if (
            error instanceof SessionStoreError &&
            error.code === 'session_invalid'
          ) {
            skippedInvalid += 1;
          } else if (
            !(error instanceof SessionStoreError) ||
            error.code !== 'session_not_found'
          ) {
            throw error;
          }
        }
      }
      result.sort(compareSessionMetadata);
      return skippedInvalid === 0
        ? { sessions: result, skippedInvalid: 0 }
        : { sessions: result, skippedInvalid };
    } finally {
      index.close();
    }
  }

  async allocateWorker(
    agent: SessionRecord['agent'],
    definition: DefinitionRevisionRef,
  ): Promise<WorkerSessionHandle> {
    if (!validRevisionRef(definition)) {
      throw new SessionStoreError('session_invalid');
    }
    const base = await this.allocate(agent);
    return this.workerHandle(
      base.id,
      undefined,
      undefined,
      agent,
      undefined,
      base.close,
    );
  }

  async openExistingWorker(id: string): Promise<WorkerSessionHandle> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const paths = await this.layout();
    const index = await acquireLock(`${paths.locks}/.index.lock`);
    let record: StoredSessionRecord;
    let checkpoint: SemanticContextCheckpointV1 | undefined;
    let lock: Lock | undefined;
    let previous: Uint8Array;
    try {
      await scanNamespaces(paths);
      await this.beforeOpenExistingLock?.(id);
      lock = await acquireLock(`${paths.locks}/${id}.lock`);
      record = await this.readWorker(id);
      checkpoint = await this.readCheckpoint(id);
      if (
        checkpoint !== undefined &&
        (checkpoint.sourceProfileId.length === 0 ||
          checkpoint.coveredThroughTurn >= record.nextTurn - 1 ||
          checkpoint.retainedFromTurn !== checkpoint.coveredThroughTurn + 1)
      ) throw new SessionStoreError('session_invalid');
      previous = await Deno.readFile(`${paths.sessions}/${id}/session.json`);
    } catch (error) {
      lock?.close();
      index.close();
      if (isNotFound(error)) throw new SessionStoreError('session_not_found');
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError('session_io_failure');
    }
    index.close();
    return this.workerHandle(
      id,
      record,
      previous,
      record.agent,
      checkpoint,
      () => lock!.close(),
    );
  }

  async readCheckpoint(
    id: string,
  ): Promise<SemanticContextCheckpointV1 | undefined> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const paths = await this.layout();
    const path = `${paths.contexts}/${id}.json`;
    try {
      const info = await Deno.lstat(path);
      if (
        info.isSymlink || !info.isFile ||
        (info.mode !== null && (info.mode & 0o777) !== 0o600)
      ) {
        throw new SessionStoreError('session_invalid');
      }
      if (info.size <= 0 || info.size > MAX_CONTEXT_CHECKPOINT_FILE_BYTES) {
        throw new SessionStoreError('session_invalid');
      }
      const checkpoint = decodeSemanticContextCheckpoint(
        await Deno.readFile(path),
      );
      if (
        checkpoint.sessionId !== id ||
        this.sourceProfileId !== undefined &&
          checkpoint.sourceProfileId !== this.sourceProfileId
      ) throw new SessionStoreError('session_invalid');
      return checkpoint;
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      if (isNotFound(error)) return undefined;
      throw new SessionStoreError('session_io_failure');
    }
  }

  async list(): Promise<SessionListResult> {
    const paths = await this.layout();
    const index = await acquireLock(`${paths.locks}/.index.lock`);
    try {
      const namespaces = await scanNamespaces(paths);
      const entries = namespaces.sessions;
      const result: SessionMetadata[] = [];
      let skippedInvalid = 0;
      const sessionNames = new Set(entries.map((entry) => entry.name));
      for (const entry of namespaces.contexts) {
        const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
        if (
          entry.isFile && !entry.isSymlink && isSessionId(id) &&
          !sessionNames.has(id)
        ) {
          try {
            await Deno.remove(`${paths.contexts}/${entry.name}`);
          } catch (error) {
            if (!isNotFound(error)) {
              throw new SessionStoreError('session_io_failure');
            }
          }
          continue;
        }
        if (!entry.isFile || entry.isSymlink || !isSessionId(id)) {
          skippedInvalid += 1;
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymlink || !isSessionId(entry.name)) {
          skippedInvalid += 1;
          continue;
        }
        try {
          const record = await this.read(entry.name);
          const checkpoint = await this.readCheckpoint(entry.name);
          if (
            checkpoint !== undefined &&
            (checkpoint.sourceProfileId.length === 0 ||
              checkpoint.coveredThroughTurn >= record.nextTurn - 1 ||
              checkpoint.retainedFromTurn !== checkpoint.coveredThroughTurn + 1)
          ) throw new SessionStoreError('session_invalid');
          result.push(metadataFromRecord(record));
        } catch (error) {
          if (
            error instanceof SessionStoreError &&
            error.code === 'session_invalid'
          ) {
            skippedInvalid += 1;
          } else if (
            !(error instanceof SessionStoreError) ||
            error.code !== 'session_not_found'
          ) throw error;
        }
      }
      result.sort(compareSessionMetadata);
      return skippedInvalid === 0
        ? { sessions: result, skippedInvalid: 0 }
        : { sessions: result, skippedInvalid };
    } finally {
      index.close();
    }
  }

  async openExisting(id: string): Promise<SessionHandle> {
    const paths = await this.layout();
    const index = await acquireLock(`${paths.locks}/.index.lock`);
    let record: SessionRecord;
    let checkpoint: SemanticContextCheckpointV1 | undefined;
    let lock: Lock | undefined;
    let previous: Uint8Array | undefined;
    try {
      await scanNamespaces(paths);
      // Acquire the per-session lock before hydrating any state. The record, derived checkpoint,
      // and rollback baseline must all come from one owner-stable snapshot; reading first and
      // locking later can hydrate a stale transcript just as another owner commits a turn.
      await this.beforeOpenExistingLock?.(id);
      lock = await acquireLock(`${paths.locks}/${id}.lock`);
      record = await this.read(id);
      checkpoint = await this.readCheckpoint(id);
      if (
        checkpoint !== undefined &&
        (checkpoint.sourceProfileId.length === 0 ||
          checkpoint.coveredThroughTurn >= record.nextTurn - 1 ||
          checkpoint.retainedFromTurn !== checkpoint.coveredThroughTurn + 1)
      ) throw new SessionStoreError('session_invalid');
      previous = await Deno.readFile(`${paths.sessions}/${id}/session.json`);
    } catch (error) {
      lock?.close();
      index.close();
      if (isNotFound(error)) throw new SessionStoreError('session_not_found');
      if (!(error instanceof SessionStoreError)) {
        throw new SessionStoreError('session_io_failure');
      }
      throw error;
    }
    index.close();
    return this.handle(id, record, lock!, previous, record.agent, checkpoint);
  }

  async allocate(agent: SessionRecord['agent']): Promise<SessionHandle> {
    if (agent !== 'default' && agent !== 'planner') {
      throw new SessionStoreError('session_invalid');
    }
    const paths = await this.layout();
    const index = await acquireLock(`${paths.locks}/.index.lock`);
    try {
      const namespaces = await scanNamespaces(paths);
      const listing = namespaces.sessions.map((entry) => entry.name);
      const locks = namespaces.locks.map((entry) => entry.name);
      // Context companions are deliberately data-only siblings. Remove only companions with no
      // canonical session; malformed companions remain visible to list/open as invalid data.
      for (const entry of namespaces.contexts) {
        if (!entry.isFile || entry.isSymlink || !entry.name.endsWith('.json')) {
          continue;
        }
        const id = entry.name.slice(0, -5);
        if (!isSessionId(id) || !listing.includes(id)) {
          try {
            await Deno.remove(`${paths.contexts}/${entry.name}`);
          } catch (error) {
            if (!isNotFound(error)) {
              throw new SessionStoreError('session_io_failure');
            }
          }
        }
      }
      const valid = new Set<string>();
      const empty = new Set<string>();
      for (const id of listing) {
        if (!isSessionId(id)) continue;
        try {
          await this.read(id);
          valid.add(id);
        } catch (error) {
          if (
            !(error instanceof SessionStoreError) ||
            (error.code !== 'session_invalid' &&
              error.code !== 'session_not_found')
          ) {
            throw error;
          }
          if (
            error instanceof SessionStoreError &&
            error.code === 'session_not_found'
          ) {
            empty.add(id);
          }
        }
      }
      const active = new Set<string>();
      for (const name of locks) {
        if (name === '.index.lock' || !name.endsWith('.lock')) continue;
        const id = name.slice(0, -5);
        if (!isSessionId(id)) continue;
        try {
          const probe = await acquireLock(`${paths.locks}/${name}`);
          probe.close();
          if (!valid.has(id)) {
            try {
              await Deno.remove(`${paths.locks}/${name}`);
            } catch {
              // Orphan cleanup is best effort under the index lock.
            }
          }
        } catch (error) {
          if (
            error instanceof SessionStoreError && error.code === 'session_busy'
          ) active.add(id);
          else throw error;
        }
      }
      for (const id of empty) {
        if (active.has(id)) continue;
        try {
          const entries = [];
          for await (const entry of Deno.readDir(`${paths.sessions}/${id}`)) {
            entries.push(entry);
          }
          if (entries.length === 0) {
            await Deno.remove(`${paths.sessions}/${id}`);
          }
        } catch (error) {
          if (!isNotFound(error)) {
            throw new SessionStoreError('session_io_failure');
          }
        }
      }
      // A new allocation adds one direct entry to each namespace. Re-scan after orphan and
      // empty-reservation cleanup so exactly 512 existing entries cannot become entry 513.
      const remaining = await scanNamespaces(paths);
      if (
        remaining.sessions.length >= MAX_WORKSPACE_DIRECTORY_ENTRIES ||
        remaining.locks.length >= MAX_WORKSPACE_DIRECTORY_ENTRIES
      ) throw new SessionStoreError('session_limit');
      if (
        new Set([...valid, ...active]).size >= MAX_VALID_SESSIONS_PER_WORKSPACE
      ) {
        throw new SessionStoreError('session_limit');
      }
      let id = '';
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = this.makeUuid().toLowerCase();
        if (
          !isSessionId(candidate) || valid.has(candidate) ||
          active.has(candidate)
        ) continue;
        try {
          await Deno.mkdir(`${paths.sessions}/${candidate}`, { mode: 0o700 });
          id = candidate;
          break;
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
      }
      if (id === '') throw new SessionStoreError('session_limit');
      try {
        const lock = await acquireLock(`${paths.locks}/${id}.lock`);
        return this.handle(id, undefined, lock, undefined, agent, undefined);
      } catch (error) {
        try {
          await Deno.remove(`${paths.sessions}/${id}`);
        } catch {
          // Preserve the primary error.
        }
        throw error;
      }
    } finally {
      index.close();
    }
  }

  async delete(id: string): Promise<void> {
    if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
    const paths = await this.layout();
    const index = await acquireLock(`${paths.locks}/.index.lock`);
    try {
      await scanNamespaces(paths);
      try {
        const directory = await Deno.lstat(`${paths.sessions}/${id}`);
        if (
          directory.isSymlink || !directory.isDirectory ||
          (directory.mode !== null && (directory.mode & 0o777) !== 0o700)
        ) throw new SessionStoreError('session_invalid');
      } catch (error) {
        if (error instanceof SessionStoreError) throw error;
        if (isNotFound(error)) throw new SessionStoreError('session_not_found');
        throw new SessionStoreError('session_io_failure');
      }
      const lock = await acquireLock(`${paths.locks}/${id}.lock`);
      try {
        const record = await this.readWorker(id);
        void record;
        await Deno.remove(`${paths.sessions}/${id}`, { recursive: true });
        try {
          await Deno.remove(`${paths.locks}/${id}.lock`);
        } catch {
          // The lock file is reusable and may be removed by another cleanup path.
        }
        try {
          await Deno.remove(`${paths.contexts}/${id}.json`);
        } catch (error) {
          if (!isNotFound(error)) {
            throw new SessionStoreError('session_io_failure');
          }
        }
      } finally {
        lock.close();
      }
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      if (isNotFound(error)) throw new SessionStoreError('session_not_found');
      throw new SessionStoreError('session_io_failure');
    } finally {
      index.close();
    }
  }

  private workerHandle(
    id: string,
    initial: StoredSessionRecord | undefined,
    previous: Uint8Array | undefined,
    expectedAgent: SessionRecord['agent'],
    initialCheckpoint: SemanticContextCheckpointV1 | undefined,
    release: () => void | Promise<void>,
  ): WorkerSessionHandle {
    let current = previous;
    let rollbackBytes = previous;
    let record = initial;
    let rollbackRecord = initial;
    let checkpoint = initialCheckpoint;
    let checkpointBytes: Uint8Array | undefined;
    let rollbackCheckpointBytes: Uint8Array | undefined;
    if (initialCheckpoint !== undefined) {
      checkpointBytes = encodeSemanticContextCheckpoint(initialCheckpoint);
      rollbackCheckpointBytes = checkpointBytes;
    }
    let closed = false;
    return {
      id,
      get record() {
        return record === undefined ? undefined : structuredClone(record);
      },
      get checkpoint() {
        return checkpoint === undefined ? undefined : structuredClone(checkpoint);
      },
      commit: (next) => {
        if (closed) throw new SessionStoreError('session_busy');
        if (
          next.sessionId !== id || next.workspaceRoot !== this.workspaceRoot ||
          next.agent !== expectedAgent
        ) throw new SessionStoreError('session_invalid');
        const bytes = next.schemaVersion === 1
          ? encodeSessionRecord(next)
          : next.schemaVersion === 2
          ? encodeSessionRecordV2(next)
          : next.schemaVersion === 3
          ? encodeSessionRecordV3(next)
          : encodeSessionRecordV4(next);
        const paths = this.paths!;
        const temporary = `${paths.sessions}/${id}/.tmp-${this.makeUuid().toLowerCase()}`;
        try {
          rollbackBytes = current;
          rollbackRecord = record;
          writeAtomic(`${paths.sessions}/${id}/session.json`, bytes, temporary);
          current = bytes;
          record = structuredClone(next);
        } catch (error) {
          if (error instanceof SessionStoreError) throw error;
          throw new SessionStoreError('session_io_failure');
        }
      },
      rollback: () => {
        if (closed) return;
        const paths = this.paths!;
        try {
          if (current !== rollbackBytes) {
            if (rollbackBytes === undefined) {
              try {
                this.removeSync(`${paths.sessions}/${id}/session.json`);
              } catch (error) {
                if (!isNotFound(error)) throw error;
              }
            } else {
              writeAtomic(
                `${paths.sessions}/${id}/session.json`,
                rollbackBytes,
                `${paths.sessions}/${id}/.tmp-${this.makeUuid().toLowerCase()}`,
              );
            }
            current = rollbackBytes;
          }
          record = rollbackRecord;
        } catch {
          throw new SessionStoreError('session_io_failure');
        }
      },
      installCheckpoint: (next) => {
        if (closed) throw new SessionStoreError('session_busy');
        if (next.sessionId !== id) {
          throw new SessionStoreError('session_invalid');
        }
        const bytes = encodeSemanticContextCheckpoint(next);
        const paths = this.paths!;
        try {
          rollbackCheckpointBytes = checkpointBytes;
          writeAtomic(
            `${paths.contexts}/${id}.json`,
            bytes,
            `${paths.contexts}/.tmp-${this.makeUuid().toLowerCase()}`,
          );
          checkpointBytes = bytes;
          checkpoint = structuredClone(next);
        } catch (error) {
          if (error instanceof SessionStoreError) throw error;
          throw new SessionStoreError('session_io_failure');
        }
      },
      rollbackCheckpoint: () => {
        if (closed) return;
        const paths = this.paths!;
        try {
          if (checkpointBytes === rollbackCheckpointBytes) return;
          if (rollbackCheckpointBytes === undefined) {
            try {
              Deno.removeSync(`${paths.contexts}/${id}.json`);
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          } else {
            writeAtomic(
              `${paths.contexts}/${id}.json`,
              rollbackCheckpointBytes,
              `${paths.contexts}/.tmp-${this.makeUuid().toLowerCase()}`,
            );
          }
          checkpointBytes = rollbackCheckpointBytes;
          checkpoint = checkpointBytes === undefined
            ? undefined
            : decodeSemanticContextCheckpoint(checkpointBytes);
        } catch {
          throw new SessionStoreError('session_io_failure');
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await release();
        if (current === undefined) await this.cleanupEmpty(id);
      },
    };
  }

  private handle(
    id: string,
    record: SessionRecord | undefined,
    lock: Lock,
    previous: Uint8Array | undefined,
    expectedAgent: SessionRecord['agent'],
    initialCheckpoint: SemanticContextCheckpointV1 | undefined,
  ): SessionHandle {
    let current = previous;
    let rollbackBytes = previous;
    let checkpointBytes: Uint8Array | undefined;
    let rollbackCheckpointBytes: Uint8Array | undefined;
    let checkpoint = initialCheckpoint;
    if (initialCheckpoint !== undefined) {
      checkpointBytes = encodeSemanticContextCheckpoint(initialCheckpoint);
      rollbackCheckpointBytes = checkpointBytes;
    }
    let closed = false;
    return {
      id,
      record,
      get checkpoint() {
        return checkpoint === undefined ? undefined : structuredClone(checkpoint);
      },
      commit: (next) => {
        if (closed) throw new SessionStoreError('session_busy');
        const bytes = encodeSessionRecord(next);
        if (
          next.sessionId !== id || next.workspaceRoot !== this.workspaceRoot ||
          next.agent !== expectedAgent
        ) {
          throw new SessionStoreError('session_invalid');
        }
        const paths = this.paths!;
        const temporary = `${paths.sessions}/${id}/.tmp-${this.makeUuid().toLowerCase()}`;
        try {
          rollbackBytes = current;
          writeAtomic(`${paths.sessions}/${id}/session.json`, bytes, temporary);
          current = bytes;
        } catch {
          throw new SessionStoreError('session_io_failure');
        }
      },
      rollback: () => {
        if (closed) return;
        const paths = this.paths!;
        try {
          if (current === rollbackBytes) return;
          if (rollbackBytes === undefined) {
            try {
              this.removeSync(`${paths.sessions}/${id}/session.json`);
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          } else {
            writeAtomic(
              `${paths.sessions}/${id}/session.json`,
              rollbackBytes,
              `${paths.sessions}/${id}/.tmp-${this.makeUuid().toLowerCase()}`,
            );
          }
          current = rollbackBytes;
        } catch {
          throw new SessionStoreError('session_io_failure');
        }
      },
      installCheckpoint: (next) => {
        if (closed) throw new SessionStoreError('session_busy');
        if (next.sessionId !== id) {
          throw new SessionStoreError('session_invalid');
        }
        const bytes = encodeSemanticContextCheckpoint(next);
        const paths = this.paths!;
        try {
          rollbackCheckpointBytes = checkpointBytes;
          writeAtomic(
            `${paths.contexts}/${id}.json`,
            bytes,
            `${paths.contexts}/.tmp-${this.makeUuid().toLowerCase()}`,
          );
          checkpointBytes = bytes;
          checkpoint = structuredClone(next);
        } catch (error) {
          if (error instanceof SessionStoreError) throw error;
          throw new SessionStoreError('session_io_failure');
        }
      },
      rollbackCheckpoint: () => {
        if (closed) return;
        const paths = this.paths!;
        try {
          if (checkpointBytes === rollbackCheckpointBytes) return;
          if (rollbackCheckpointBytes === undefined) {
            try {
              Deno.removeSync(`${paths.contexts}/${id}.json`);
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          } else {
            writeAtomic(
              `${paths.contexts}/${id}.json`,
              rollbackCheckpointBytes,
              `${paths.contexts}/.tmp-${this.makeUuid().toLowerCase()}`,
            );
          }
          checkpointBytes = rollbackCheckpointBytes;
          checkpoint = checkpointBytes === undefined
            ? undefined
            : decodeSemanticContextCheckpoint(checkpointBytes);
        } catch {
          throw new SessionStoreError('session_io_failure');
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        lock.close();
        if (current === undefined) {
          await this.cleanupEmpty(id);
        }
      },
    };
  }

  private async cleanupEmpty(id: string): Promise<void> {
    const paths = await this.pathsPromise;
    const index = await acquireLock(`${paths.locks}/.index.lock`);
    try {
      const entries: string[] = [];
      try {
        for await (const entry of Deno.readDir(`${paths.sessions}/${id}`)) {
          entries.push(entry.name);
        }
      } catch (error) {
        if (isNotFound(error)) return;
        throw new SessionStoreError('session_io_failure');
      }
      if (entries.length === 0) {
        await Deno.remove(`${paths.sessions}/${id}`);
        try {
          await Deno.remove(`${paths.locks}/${id}.lock`);
        } catch (error) {
          if (!isNotFound(error)) {
            throw new SessionStoreError('session_io_failure');
          }
        }
      }
    } finally {
      index.close();
    }
  }
}
