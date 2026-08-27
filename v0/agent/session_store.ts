import { type JsonValue, type Message } from './contracts.ts';

export const SESSION_SCHEMA_VERSION = 1 as const;
export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_VALID_SESSIONS_PER_WORKSPACE = 256;
export const MAX_WORKSPACE_DIRECTORY_ENTRIES = 512;
export const MAX_RESTORED_DISPLAY_MESSAGES = 100;
export const MAX_RESTORED_DISPLAY_BYTES = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const canonicalAbsolutePath = (value: string): string | undefined => {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('//')) return undefined;
  if (value === '/') return value;
  const parts: string[] = [];
  for (const part of value.split('/').slice(1)) {
    if (part === '' || part === '.') return undefined;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const result = `/${parts.join('/')}`;
  return result === value ? result : undefined;
};

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
}

export interface SessionMetadata {
  readonly id: string;
  readonly agent: SessionRecord['agent'];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly messageCount: number;
}

export type SessionErrorCode =
  | 'session_not_found'
  | 'session_busy'
  | 'session_invalid'
  | 'session_limit'
  | 'session_io_failure';

export class SessionStoreError extends Error {
  constructor(readonly code: SessionErrorCode, message = code) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

export const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V4.test(value);

const ownKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

const isFiniteJson = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item, index) => Object.hasOwn(value, index) && isFiniteJson(item));
  }
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isFiniteJson);
};

const validString = (value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\0') && ![...value].some((c) => {
    const code = c.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });

const validateToolCall = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const call = value as Record<string, unknown>;
  return ownKeys(call, ['kind', 'callId', 'name', 'arguments']) && call.kind === 'tool_call' &&
    validString(call.callId) && call.callId.length > 0 && validString(call.name) &&
    call.name.length > 0 && isFiniteJson(call.arguments);
};

const validateToolResult = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  const common = ownKeys(result, ['kind', 'callId', 'name', 'text', 'outcome']) ||
    ownKeys(result, ['kind', 'callId', 'name', 'text', 'outcome', 'terminal']);
  if (
    !common || result.kind !== 'tool_result' || !validString(result.callId) ||
    result.callId.length === 0 || !validString(result.name) || result.name.length === 0 ||
    !validString(result.text)
  ) return false;
  if (result.outcome !== 'success' && result.outcome !== 'error') return false;
  if (Object.hasOwn(result, 'terminal')) {
    return result.outcome === 'success' && result.terminal === 'json_result';
  }
  return result.outcome === 'success' || result.outcome === 'error';
};

const validateMessage = (value: unknown): value is Message => {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.role === 'user') {
    const content = message.content;
    return ownKeys(message, ['role', 'content']) && typeof content === 'object' &&
      content !== null &&
      ownKeys(content, ['kind', 'text']) && (content as Record<string, unknown>).kind === 'text' &&
      validString((content as Record<string, unknown>).text);
  }
  if (message.role === 'assistant') {
    const content = message.content;
    if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
      return ownKeys(message, ['role', 'content']) && ownKeys(content, ['kind', 'text']) &&
        (content as Record<string, unknown>).kind === 'text' &&
        validString((content as Record<string, unknown>).text);
    }
    return ownKeys(message, ['role', 'content']) && Array.isArray(content) && content.length > 0 &&
      content.every(validateToolCall);
  }
  if (message.role === 'tool') {
    return ownKeys(message, ['role', 'content']) && Array.isArray(message.content) &&
      message.content.length > 0 && message.content.every(validateToolResult);
  }
  return false;
};

const validateCausalTranscript = (transcript: readonly Message[]): boolean => {
  if (transcript.length === 0 || transcript[0].role !== 'user') return false;
  let index = 0;
  while (index < transcript.length) {
    if (transcript[index].role !== 'user') return false;
    index += 1;
    let completed = false;
    while (index < transcript.length && !completed) {
      const assistant = transcript[index];
      if (assistant.role !== 'assistant') return false;
      index += 1;
      if (!Array.isArray(assistant.content)) {
        completed = true;
        break;
      }
      if (index >= transcript.length || transcript[index].role !== 'tool') return false;
      const tool = transcript[index++];
      if (tool.role !== 'tool' || tool.content.length !== assistant.content.length) return false;
      for (let resultIndex = 0; resultIndex < tool.content.length; resultIndex += 1) {
        const call = assistant.content[resultIndex];
        const result = tool.content[resultIndex];
        if (call.callId !== result.callId || call.name !== result.name) return false;
      }
      if (tool.content.some((result) => 'terminal' in result)) completed = true;
    }
    if (!completed) return false;
  }
  return true;
};

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

export const validateSessionRecord = (value: unknown): value is SessionRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    !ownKeys(record, [
      'schemaVersion',
      'sessionId',
      'workspaceRoot',
      'agent',
      'createdAt',
      'updatedAt',
      'nextTurn',
      'transcript',
    ])
  ) return false;
  if (
    record.schemaVersion !== 1 || !isSessionId(record.sessionId) ||
    typeof record.workspaceRoot !== 'string' ||
    canonicalAbsolutePath(record.workspaceRoot) === undefined ||
    record.workspaceRoot.trim() !== record.workspaceRoot ||
    (record.agent !== 'default' && record.agent !== 'planner') ||
    !canonicalTimestamp(record.createdAt) || !canonicalTimestamp(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    !Number.isSafeInteger(record.nextTurn) || (record.nextTurn as number) < 2 ||
    !Array.isArray(record.transcript) || record.transcript.length === 0 ||
    record.transcript.length > MAX_SESSION_FILE_BYTES ||
    !record.transcript.every(validateMessage) || !validateCausalTranscript(record.transcript)
  ) {
    return false;
  }
  const userCount = record.transcript.filter((message) => message.role === 'user').length;
  return record.nextTurn === userCount + 1;
};

export const encodeSessionRecord = (record: SessionRecord): Uint8Array => {
  if (!validateSessionRecord(record)) throw new SessionStoreError('session_invalid');
  const bytes = encoder.encode(`${JSON.stringify(record)}\n`);
  if (bytes.byteLength > MAX_SESSION_FILE_BYTES) throw new SessionStoreError('session_limit');
  return bytes;
};

export const decodeSessionRecord = (bytes: Uint8Array): SessionRecord => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SESSION_FILE_BYTES) {
    throw new SessionStoreError('session_invalid');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf || bytes.includes(0)) {
    throw new SessionStoreError('session_invalid');
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new SessionStoreError('session_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SessionStoreError('session_invalid');
  }
  if (!validateSessionRecord(parsed)) throw new SessionStoreError('session_invalid');
  const canonical = encoder.encode(`${JSON.stringify(parsed)}\n`);
  if (
    canonical.byteLength !== bytes.byteLength ||
    canonical.some((byte, index) => byte !== bytes[index])
  ) {
    throw new SessionStoreError('session_invalid');
  }
  return structuredClone(parsed);
};

export const metadataFromRecord = (record: SessionRecord): SessionMetadata => ({
  id: record.sessionId,
  agent: record.agent,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  turnCount: record.nextTurn - 1,
  messageCount: record.transcript.length,
});

export const workspaceDigest = async (workspaceRoot: string): Promise<string> => {
  if (
    typeof workspaceRoot !== 'string' || canonicalAbsolutePath(workspaceRoot) === undefined ||
    workspaceRoot.trim() !== workspaceRoot
  ) {
    throw new SessionStoreError('session_invalid');
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(workspaceRoot));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const selectStateRoot = (
  env: Readonly<Record<string, string | undefined>> = Deno.env.toObject(),
): string => {
  const xdg = env.XDG_STATE_HOME;
  if (xdg !== undefined && xdg.trim() !== '') {
    if (!xdg.startsWith('/') || xdg.includes('\0') || xdg.includes('\r') || xdg.includes('\n')) {
      throw new SessionStoreError('session_io_failure');
    }
    return `${xdg}/henji-harness`;
  }
  const home = env.HOME;
  if (home !== undefined && home.trim() !== '') {
    if (
      !home.startsWith('/') || home.includes('\0') || home.includes('\r') || home.includes('\n')
    ) {
      throw new SessionStoreError('session_io_failure');
    }
    return `${home}/.local/state/henji-harness`;
  }
  throw new SessionStoreError('session_io_failure');
};

/** Resolve the launcher-owned root when production startup has already completed preflight. */
export const launcherStateRoot = (): string => {
  let supplied: string | undefined;
  try {
    supplied = Deno.env.get('HENJI_SESSION_STATE_ROOT');
  } catch {
    // Permission-free direct callers use the explicit XDG/HOME seam below.
  }
  if (supplied !== undefined) {
    if (
      supplied.trim() === '' || !supplied.startsWith('/') || supplied.includes('\0') ||
      supplied.includes('\r') || supplied.includes('\n')
    ) throw new SessionStoreError('session_io_failure');
    return supplied;
  }
  return selectStateRoot();
};

export const sessionPaths = async (stateRoot: string, workspaceRoot: string) => {
  if (
    typeof stateRoot !== 'string' || !stateRoot.startsWith('/') || stateRoot.trim() === '' ||
    stateRoot.includes('\0') || stateRoot.includes('\r') || stateRoot.includes('\n')
  ) throw new SessionStoreError('session_io_failure');
  const digest = await workspaceDigest(workspaceRoot);
  const base = `${stateRoot}/${digest}`;
  return {
    root: base,
    sessions: `${base}/sessions`,
    locks: `${base}/locks`,
  } as const;
};

export const restoredMessages = (
  transcript: readonly Message[],
): { readonly messages: readonly Message[]; readonly omitted: number } => {
  const selected: Message[] = [];
  let used = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_RESTORED_DISPLAY_MESSAGES) break;
    const size = encoder.encode(JSON.stringify(transcript[index])).byteLength;
    if (size > MAX_RESTORED_DISPLAY_BYTES) {
      // The newest oversize message leaves no coherent tail; a later oversize message ends the
      // suffix because skipping it would make the displayed transcript non-contiguous.
      break;
    }
    if (used + size > MAX_RESTORED_DISPLAY_BYTES) break;
    selected.push(structuredClone(transcript[index]));
    used += size;
  }
  selected.reverse();
  return { messages: selected, omitted: transcript.length - selected.length };
};

type Lock = { readonly close: () => void };

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;
const isAlreadyExists = (error: unknown): boolean => error instanceof Deno.errors.AlreadyExists;
const isBusy = (error: unknown): boolean => error instanceof Deno.errors.Busy;

const ensureDirectory = async (path: string, mode: number): Promise<void> => {
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink || !info.isDirectory) throw new Error('invalid session directory');
    if (info.mode !== null && (info.mode & 0o777) !== mode) {
      throw new Error('invalid session directory mode');
    }
    await Deno.chmod(path, mode);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await Deno.mkdir(path, { recursive: true, mode });
    const info = await Deno.lstat(path);
    if (info.isSymlink || !info.isDirectory) throw new Error('invalid session directory');
    if (info.mode !== null && (info.mode & 0o777) !== mode) {
      throw new Error('invalid session directory mode');
    }
    await Deno.chmod(path, mode);
  }
};

const validateSessionDirectory = async (path: string): Promise<void> => {
  let tempCount = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      const isTemp = entry.name.startsWith('.tmp-') && isSessionId(entry.name.slice(5));
      if (entry.name !== 'session.json' && !isTemp) {
        throw new SessionStoreError('session_invalid');
      }
      if (isTemp) tempCount += 1;
      const info = await Deno.lstat(`${path}/${entry.name}`);
      if (info.isSymlink || !info.isFile || (info.mode !== null && (info.mode & 0o777) !== 0o600)) {
        throw new SessionStoreError('session_invalid');
      }
    }
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    throw new SessionStoreError('session_io_failure');
  }
  if (tempCount > 1) throw new SessionStoreError('session_invalid');
};

const acquireLock = async (path: string): Promise<Lock> => {
  let file: Deno.FsFile;
  try {
    try {
      const existing = await Deno.lstat(path);
      if (existing.isSymlink || !existing.isFile) throw new SessionStoreError('session_io_failure');
      if (existing.mode !== null && (existing.mode & 0o777) !== 0o600) {
        throw new SessionStoreError('session_io_failure');
      }
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      if (!isNotFound(error)) throw error;
    }
    file = await Deno.open(path, { read: true, write: true, create: true, mode: 0o600 });
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

const writeAtomic = (target: string, bytes: Uint8Array, temporary: string): void => {
  let file: Deno.FsFile | undefined;
  try {
    file = Deno.openSync(temporary, { write: true, createNew: true, mode: 0o600 });
    let offset = 0;
    while (offset < bytes.byteLength) offset += file.writeSync(bytes.subarray(offset));
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

export interface SessionHandle {
  readonly id: string;
  readonly record?: SessionRecord;
  commit(record: SessionRecord): void;
  rollback(): void;
  close(): Promise<void>;
}

/** Adapt a locked handle to AgentSession's provider-neutral durable commit port. */
export const createSessionPersistence = (
  handle: SessionHandle,
  workspaceRoot: string,
  agent: SessionRecord['agent'],
  initial?: SessionRecord,
): {
  readonly record: SessionRecord | undefined;
  commit(transcript: readonly Message[], nextTurn: number, updatedAt: string): void;
  rollback(): void;
  close(): Promise<void>;
} => {
  let record = initial;
  let rollbackRecord = initial;
  return {
    get record() {
      return record;
    },
    commit(transcript, nextTurn, updatedAt) {
      rollbackRecord = record;
      const createdAt = record?.createdAt ?? updatedAt;
      const next: SessionRecord = {
        schemaVersion: 1,
        sessionId: handle.id,
        workspaceRoot,
        agent,
        createdAt,
        updatedAt,
        nextTurn,
        transcript: structuredClone(transcript),
      };
      handle.commit(next);
      record = next;
    },
    rollback() {
      handle.rollback();
      record = rollbackRecord;
    },
    async close() {
      await handle.close();
    },
  };
};

export interface SessionListResult {
  readonly sessions: readonly SessionMetadata[];
  readonly skippedInvalid: number;
}

export interface SessionStorePort {
  read(id: string): Promise<SessionRecord>;
  list(): Promise<SessionListResult>;
  allocate(agent: SessionRecord['agent']): Promise<SessionHandle>;
  openExisting(id: string): Promise<SessionHandle>;
  delete(id: string): Promise<void>;
}

export interface SessionStoreOptions {
  /** Direct-test seam for deterministic UUIDs and collision handling. */
  readonly uuid?: () => string;
  /** Direct-test-only fault seam for first-turn rollback removal. */
  readonly removeSync?: (path: string) => void;
}

const compareMetadata = (a: SessionMetadata, b: SessionMetadata): number =>
  a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt);

type NamespaceEntries = {
  readonly sessions: readonly Deno.DirEntry[];
  readonly locks: readonly Deno.DirEntry[];
};

/** Scan both top-level namespaces while holding the index lock, stopping at entry 513. */
const scanBoundedNamespace = async (path: string): Promise<readonly Deno.DirEntry[]> => {
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

const scanNamespaces = async (paths: {
  readonly sessions: string;
  readonly locks: string;
}): Promise<NamespaceEntries> => ({
  sessions: await scanBoundedNamespace(paths.sessions),
  locks: await scanBoundedNamespace(paths.locks),
});

export class DenoSessionStore implements SessionStorePort {
  readonly pathsPromise: Promise<
    { readonly root: string; readonly sessions: string; readonly locks: string }
  >;
  private paths?: { readonly root: string; readonly sessions: string; readonly locks: string };

  private readonly makeUuid: () => string;
  private readonly removeSync: (path: string) => void;

  constructor(
    readonly stateRoot: string,
    readonly workspaceRoot: string,
    options: SessionStoreOptions = {},
  ) {
    if (!stateRoot.startsWith('/') || stateRoot.trim() === '' || stateRoot.includes('\0')) {
      throw new SessionStoreError('session_io_failure');
    }
    this.makeUuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
    this.removeSync = options.removeSync ?? Deno.removeSync;
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
      if (info.isSymlink || !info.isFile || (info.mode !== null && (info.mode & 0o777) !== 0o600)) {
        throw new SessionStoreError('session_invalid');
      }
      if (info.size <= 0 || info.size > MAX_SESSION_FILE_BYTES) {
        throw new SessionStoreError('session_invalid');
      }
      const record = decodeSessionRecord(await Deno.readFile(path));
      if (record.sessionId !== id || record.workspaceRoot !== this.workspaceRoot) {
        throw new SessionStoreError('session_invalid');
      }
      return record;
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      if (isNotFound(error)) throw new SessionStoreError('session_not_found');
      throw new SessionStoreError('session_io_failure');
    }
  }

  async list(): Promise<SessionListResult> {
    const paths = await this.layout();
    const index = await acquireLock(`${paths.locks}/.index.lock`);
    try {
      const { sessions: entries } = await scanNamespaces(paths);
      const result: SessionMetadata[] = [];
      let skippedInvalid = 0;
      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymlink || !isSessionId(entry.name)) {
          skippedInvalid += 1;
          continue;
        }
        try {
          result.push(metadataFromRecord(await this.read(entry.name)));
        } catch (error) {
          if (error instanceof SessionStoreError && error.code === 'session_invalid') {
            skippedInvalid += 1;
          } else if (
            !(error instanceof SessionStoreError) || error.code !== 'session_not_found'
          ) throw error;
        }
      }
      result.sort(compareMetadata);
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
    let lock: Lock;
    try {
      await scanNamespaces(paths);
      record = await this.read(id);
      lock = await acquireLock(`${paths.locks}/${id}.lock`);
    } catch (error) {
      index.close();
      throw error;
    }
    index.close();
    let previous: Uint8Array | undefined;
    try {
      previous = await Deno.readFile(`${paths.sessions}/${id}/session.json`);
    } catch (error) {
      lock.close();
      if (isNotFound(error)) throw new SessionStoreError('session_not_found');
      throw new SessionStoreError('session_io_failure');
    }
    return this.handle(id, record, lock, previous, record.agent);
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
            (error.code !== 'session_invalid' && error.code !== 'session_not_found')
          ) {
            throw error;
          }
          if (error instanceof SessionStoreError && error.code === 'session_not_found') {
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
          if (error instanceof SessionStoreError && error.code === 'session_busy') active.add(id);
          else throw error;
        }
      }
      for (const id of empty) {
        if (active.has(id)) continue;
        try {
          const entries = [];
          for await (const entry of Deno.readDir(`${paths.sessions}/${id}`)) entries.push(entry);
          if (entries.length === 0) await Deno.remove(`${paths.sessions}/${id}`);
        } catch (error) {
          if (!isNotFound(error)) throw new SessionStoreError('session_io_failure');
        }
      }
      // A new allocation adds one direct entry to each namespace. Re-scan after orphan and
      // empty-reservation cleanup so exactly 512 existing entries cannot become entry 513.
      const remaining = await scanNamespaces(paths);
      if (
        remaining.sessions.length >= MAX_WORKSPACE_DIRECTORY_ENTRIES ||
        remaining.locks.length >= MAX_WORKSPACE_DIRECTORY_ENTRIES
      ) throw new SessionStoreError('session_limit');
      if (new Set([...valid, ...active]).size >= MAX_VALID_SESSIONS_PER_WORKSPACE) {
        throw new SessionStoreError('session_limit');
      }
      let id = '';
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = this.makeUuid().toLowerCase();
        if (!isSessionId(candidate) || valid.has(candidate) || active.has(candidate)) continue;
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
        return this.handle(id, undefined, lock, undefined, agent);
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
        const record = await this.read(id);
        void record;
        await Deno.remove(`${paths.sessions}/${id}`, { recursive: true });
        try {
          await Deno.remove(`${paths.locks}/${id}.lock`);
        } catch {
          // The lock file is reusable and may be removed by another cleanup path.
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

  private handle(
    id: string,
    record: SessionRecord | undefined,
    lock: Lock,
    previous: Uint8Array | undefined,
    expectedAgent: SessionRecord['agent'],
  ): SessionHandle {
    let current = previous;
    let rollbackBytes = previous;
    let closed = false;
    return {
      id,
      record,
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
        for await (const entry of Deno.readDir(`${paths.sessions}/${id}`)) entries.push(entry.name);
      } catch (error) {
        if (isNotFound(error)) return;
        throw new SessionStoreError('session_io_failure');
      }
      if (entries.length === 0) {
        await Deno.remove(`${paths.sessions}/${id}`);
        try {
          await Deno.remove(`${paths.locks}/${id}.lock`);
        } catch (error) {
          if (!isNotFound(error)) throw new SessionStoreError('session_io_failure');
        }
      }
    } finally {
      index.close();
    }
  }
}

/** Permission-free store used by direct runtime/TUI tests and fault-injection seams. */
export class FakeSessionStore implements SessionStorePort {
  private readonly records = new Map<string, SessionRecord>();
  private readonly active = new Set<string>();
  private nextId = 1;

  constructor(readonly workspaceRoot = '/workspace') {}

  async read(id: string): Promise<SessionRecord> {
    await Promise.resolve();
    const value = this.records.get(id);
    if (value === undefined) throw new SessionStoreError('session_not_found');
    return structuredClone(value);
  }

  async list(): Promise<SessionListResult> {
    await Promise.resolve();
    const sessions = [...this.records.values()].map(metadataFromRecord).sort(compareMetadata);
    return { sessions, skippedInvalid: 0 };
  }

  async allocate(agent: SessionRecord['agent']): Promise<SessionHandle> {
    await Promise.resolve();
    if (agent !== 'default' && agent !== 'planner') {
      throw new SessionStoreError('session_invalid');
    }
    if (
      new Set([...this.records.keys(), ...this.active]).size >= MAX_VALID_SESSIONS_PER_WORKSPACE
    ) {
      throw new SessionStoreError('session_limit');
    }
    const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
    this.active.add(id);
    return this.fakeHandle(id, agent, undefined);
  }

  async openExisting(id: string): Promise<SessionHandle> {
    await Promise.resolve();
    const record = this.records.get(id);
    if (record === undefined) throw new SessionStoreError('session_not_found');
    if (this.active.has(id)) throw new SessionStoreError('session_busy');
    this.active.add(id);
    return this.fakeHandle(id, record.agent, record);
  }

  async delete(id: string): Promise<void> {
    await Promise.resolve();
    if (this.active.has(id)) throw new SessionStoreError('session_busy');
    if (!this.records.has(id)) throw new SessionStoreError('session_not_found');
    this.records.delete(id);
  }

  private fakeHandle(
    id: string,
    agent: SessionRecord['agent'],
    initial: SessionRecord | undefined,
  ): SessionHandle {
    let current = initial;
    let rollbackRecord = initial;
    let closed = false;
    return {
      id,
      record: initial,
      commit: (next) => {
        if (closed || next.sessionId !== id || next.workspaceRoot !== this.workspaceRoot) {
          throw new SessionStoreError('session_invalid');
        }
        if (next.agent !== agent) throw new SessionStoreError('session_invalid');
        encodeSessionRecord(next);
        rollbackRecord = current;
        current = structuredClone(next);
        this.records.set(id, structuredClone(next));
      },
      rollback: () => {
        if (rollbackRecord === undefined) this.records.delete(id);
        else this.records.set(id, structuredClone(rollbackRecord));
        current = rollbackRecord;
      },
      close: () => {
        if (closed) return Promise.resolve();
        closed = true;
        this.active.delete(id);
        if (current === undefined) this.records.delete(id);
        return Promise.resolve();
      },
    };
  }
}

// Keep the management command part of the checked v0 module graph without introducing a
// runtime dependency cycle; the CLI itself still remains a provider-free entry point.
export type { SessionCliCommand } from './session_cli.ts';
