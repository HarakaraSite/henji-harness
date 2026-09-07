import { type Tool, ToolInputError } from './tools.ts';
import type { JsonObject, JsonValue } from '../core/contracts.ts';
import { type ToolExecutionContext } from '../core/execution_context.ts';
import {
  CancellationCleanupError,
  isCancellationCleanupError,
  isTurnCancelledError,
  throwIfCancelled,
  TurnCancelledError,
} from '../core/cancellation.ts';
import {
  BASH_OUTPUT_DEFAULT_WINDOW_BYTES,
  type BashOutputCommandCapture,
  type BashOutputLimitSnapshot,
  BashOutputPersistenceError,
  type BashOutputStore,
  type BashOutputStream,
  createBashOutputStore,
  createBashOutputTool,
} from './bash_output.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_TEXT_BYTES = 65_536;
const MAX_PATH_BYTES = 4_096;
const MAX_COMMAND_BYTES = 16_384;
const MAX_CAPTURE_BYTES = 4_096;
const MAX_PROGRESS_STREAM_BYTES = 4_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const CAPTURE_GRACE_MS = 250;
const TEMP_ATTEMPTS = 8;

export interface Workspace {
  readonly root: string;
}

export interface WorkToolSeams {
  /** Test-only hook executed after the temp file is synced and before rename. */
  readonly beforeRename?: (
    target: string,
    temporary: string,
  ) => void | Promise<void>;
  /** Test-only hook executed after rename and before cancellation arbitration. */
  readonly afterRename?: (
    target: string,
    temporary: string,
  ) => void | Promise<void>;
  /** Test-only hook for exercising cancellation cleanup failures. */
  readonly cleanupTemporary?: (temporary: string) => void | Promise<void>;
  /** Direct-test store injection; production creates one Registry-owned store. */
  readonly bashOutputStore?: BashOutputStore;
  readonly bash?: BashToolSeams;
}

export interface BashToolSeams {
  /** Test-only hook at the bounded stdout/stderr capture cleanup boundary. */
  readonly beforeCapture?: (waitForSettlement: boolean) => void | Promise<void>;
}

export const resolveWorkspace = async (
  root = Deno.cwd(),
): Promise<Workspace> => {
  const canonical = await Deno.realPath(root);
  const info = await Deno.lstat(canonical);
  if (!info.isDirectory) throw new Error('workspace root is not a directory');
  return { root: canonical };
};

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const validTextArgument = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string' && hasWellFormedUnicode(value) &&
  !value.includes('\0') &&
  encoder.encode(value).byteLength <= maxBytes;

const exactKeys = (value: JsonObject, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

const invalidToolArguments = (name: string): ToolInputError =>
  new ToolInputError(`invalid ${name} arguments`);

const invalidPath = (): ToolInputError => new ToolInputError('path must stay within workspace');
const invalidSymlink = (): ToolInputError => new ToolInputError('path must not contain a symlink');

const splitAbsolute = (path: string): string[] => path.split('/').filter((part) => part.length > 0);

const normalizeAbsolute = (path: string): string => {
  const parts: string[] = [];
  for (const part of splitAbsolute(path)) {
    if (part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join('/')}`;
};

const isWithin = (root: string, target: string): boolean => {
  if (target === root) return true;
  return target.startsWith(`${root}/`);
};

const relativePath = (root: string, target: string): string => {
  const result = target.slice(root.length).replace(/^\/+/, '');
  return result;
};

interface CheckedPath {
  readonly absolute: string;
  readonly relative: string;
  readonly parent: string;
  readonly targetInfo?: Deno.FileInfo;
}

const checkedPath = async (
  workspace: Workspace,
  input: unknown,
  allowMissingTarget: boolean,
  signal?: AbortSignal,
): Promise<CheckedPath> => {
  throwIfCancelled(signal);
  if (!validTextArgument(input, MAX_PATH_BYTES) || input.trim().length === 0) {
    throw invalidPath();
  }
  const path = input;
  const absolute = normalizeAbsolute(
    path.startsWith('/') ? path : `${workspace.root}/${path}`,
  );
  if (!isWithin(workspace.root, absolute)) throw invalidPath();
  const components = splitAbsolute(absolute).slice(
    splitAbsolute(workspace.root).length,
  );
  let current = workspace.root;
  for (const component of components) {
    current = current === '/' ? `/${component}` : `${current}/${component}`;
    try {
      const info = await Deno.lstat(current);
      throwIfCancelled(signal);
      if (info.isSymlink) throw invalidSymlink();
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      break;
    }
  }

  const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
  let targetInfo: Deno.FileInfo | undefined;
  try {
    targetInfo = await Deno.lstat(absolute);
    throwIfCancelled(signal);
    if (targetInfo.isSymlink) throw invalidSymlink();
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    if (!(error instanceof Deno.errors.NotFound) || !allowMissingTarget) {
      throw error;
    }
  }
  return {
    absolute,
    relative: relativePath(workspace.root, absolute),
    parent,
    targetInfo,
  };
};

const ensureParent = async (
  workspace: Workspace,
  path: string,
  create: boolean,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfCancelled(signal);
  if (!isWithin(workspace.root, path)) throw invalidPath();
  const rootParts = splitAbsolute(workspace.root);
  const parts = splitAbsolute(path);
  if (parts.length < rootParts.length) throw invalidPath();
  let current = workspace.root;
  for (const part of parts.slice(rootParts.length)) {
    current = `${current}/${part}`;
    try {
      const info = await Deno.lstat(current);
      throwIfCancelled(signal);
      if (info.isSymlink) throw invalidSymlink();
      if (!info.isDirectory) throw new Error('parent is not a directory');
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      if (!create) throw error;
      await Deno.mkdir(current, { mode: 0o755 });
      throwIfCancelled(signal);
    }
  }
  // Re-check after mkdir so an ordinary race cannot turn the sibling into a link.
  let verify = workspace.root;
  for (const part of parts.slice(rootParts.length)) {
    verify = `${verify}/${part}`;
    const info = await Deno.lstat(verify);
    throwIfCancelled(signal);
    if (info.isSymlink) throw invalidSymlink();
    if (!info.isDirectory) throw new Error('parent is not a directory');
  }
};

const readBytesBounded = async (path: string): Promise<Uint8Array> => {
  const file = await Deno.open(path, { read: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const remaining = MAX_TEXT_BYTES + 1 - total;
      if (remaining <= 0) return concatBytes(chunks, total);
      const chunk = new Uint8Array(Math.min(8192, remaining));
      const count = await file.read(chunk);
      if (count === null) break;
      if (count > 0) {
        chunks.push(chunk.slice(0, count));
        total += count;
      }
      if (total > MAX_TEXT_BYTES) return concatBytes(chunks, total);
    }
  } finally {
    file.close();
  }
  return concatBytes(chunks, total);
};

const concatBytes = (
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array => {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const decodeText = (bytes: Uint8Array): string => {
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error('file exceeds 64 KiB');
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error('file is not valid UTF-8 text');
  }
  if (text.includes('\0')) throw new Error('file is not valid UTF-8 text');
  return text;
};

const readTarget = async (
  workspace: Workspace,
  input: unknown,
  toolName: string,
  signal?: AbortSignal,
) => {
  const checked = await checkedPath(workspace, input, false, signal).catch(
    (error: unknown) => {
      if (error instanceof ToolInputError) throw error;
      if (isTurnCancelledError(error)) throw error;
      if (error instanceof Deno.errors.NotFound) {
        throw new Error('file not found');
      }
      throw new Error(`local ${toolName} failed`);
    },
  );
  if (!checked.targetInfo?.isFile) {
    throw new Error('target is not a regular file');
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBytesBounded(checked.absolute);
    throwIfCancelled(signal);
  } catch (error) {
    if (isTurnCancelledError(error)) throw error;
    if (
      error instanceof Error &&
      (error.message === 'file exceeds 64 KiB' ||
        error.message === 'file is not valid UTF-8 text')
    ) throw error;
    throw new Error(`local ${toolName} failed`);
  }
  const text = decodeText(bytes);
  throwIfCancelled(signal);
  return { checked, bytes, text };
};

const readWindow = async (
  workspace: Workspace,
  input: unknown,
  offset: number,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<string> => {
  const checked = await checkedPath(workspace, input, false, signal).catch(
    (error: unknown) => {
      if (error instanceof ToolInputError) throw error;
      if (isTurnCancelledError(error)) throw error;
      if (error instanceof Deno.errors.NotFound) {
        throw new Error('file not found');
      }
      throw new Error('local read failed');
    },
  );
  if (!checked.targetInfo?.isFile) {
    throw new Error('target is not a regular file');
  }
  const file = await Deno.open(checked.absolute, { read: true }).catch(() => {
    throw new Error('local read failed');
  });
  const streamDecoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  const selected: string[] = [];
  const selectedSizes: number[] = [];
  let selectedBytes = 0;
  let totalLines = 0;
  let line = '';
  let lineBytes = 0;
  let linePresent = false;
  let selectionClosed = false;

  const finishLine = (): void => {
    const lineNumber = totalLines + 1;
    if (
      !selectionClosed && lineNumber >= offset &&
      (limit === undefined || selected.length < limit)
    ) {
      if (lineBytes > MAX_TEXT_BYTES) {
        throw new Error(`line ${lineNumber} exceeds 64 KiB read result limit`);
      }
      if (selectedBytes + lineBytes <= MAX_TEXT_BYTES) {
        selected.push(line);
        selectedSizes.push(lineBytes);
        selectedBytes += lineBytes;
      } else selectionClosed = true;
    }
    totalLines += 1;
    line = '';
    lineBytes = 0;
    linePresent = false;
  };

  const consume = (text: string): void => {
    for (const character of text) {
      if (character === '\0') throw new Error('file is not valid UTF-8 text');
      linePresent = true;
      const characterBytes = encoder.encode(character).byteLength;
      lineBytes += characterBytes;
      if (lineBytes <= MAX_TEXT_BYTES + 1) line += character;
      if (character === '\n') finishLine();
    }
  };

  try {
    const chunk = new Uint8Array(8192);
    for (;;) {
      throwIfCancelled(signal);
      const count = await file.read(chunk);
      if (count === null) break;
      consume(streamDecoder.decode(chunk.subarray(0, count), { stream: true }));
    }
    consume(streamDecoder.decode());
    if (linePresent) finishLine();
    throwIfCancelled(signal);
  } catch (error) {
    if (isTurnCancelledError(error)) throw error;
    if (
      error instanceof Error &&
      (error.message === 'file is not valid UTF-8 text' ||
        error.message.startsWith('line '))
    ) throw error;
    if (error instanceof TypeError) {
      throw new Error('file is not valid UTF-8 text');
    }
    throw new Error('local read failed');
  } finally {
    file.close();
  }

  const hasMore = (): boolean => offset + selected.length <= totalLines;
  while (hasMore()) {
    const next = offset + selected.length;
    const last = next - 1;
    const marker = selected.length === 0
      ? `[More content available. Use offset=${next} to continue.]`
      : `[Showing lines ${offset}-${last} of ${totalLines}. Use offset=${next} to continue.]`;
    const text = selected.join('');
    const separator = text.endsWith('\n') ? '\n' : '\n\n';
    if (
      encoder.encode(`${text}${separator}${marker}`).byteLength <=
        MAX_TEXT_BYTES
    ) {
      return `${text}${separator}${marker}`;
    }
    const removed = selectedSizes.pop();
    selected.pop();
    if (removed === undefined) {
      throw new Error(`line ${offset} exceeds 64 KiB read result limit`);
    }
    selectedBytes -= removed;
  }
  return selected.join('');
};

const atomicReplace = async (
  workspace: Workspace,
  checked: CheckedPath,
  bytes: Uint8Array,
  mode: number,
  seams: WorkToolSeams,
  expectedBytes?: Uint8Array,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfCancelled(signal);
  await ensureParent(workspace, checked.parent, true, signal);
  const base = checked.absolute.slice(checked.absolute.lastIndexOf('/') + 1) ||
    'target';
  let temporary: string | undefined;
  let file: Deno.FsFile | undefined;
  let cleanupError: unknown;
  let operationFailed = false;
  let operationError: unknown;
  try {
    for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
      const candidate = `${checked.parent}/.${base}.henji-${attempt}`;
      try {
        file = await Deno.open(candidate, {
          write: true,
          createNew: true,
          mode: 0o600,
        });
        temporary = candidate;
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
    }
    if (!file || !temporary) throw new Error('temp file unavailable');
    throwIfCancelled(signal);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = await file.write(bytes.subarray(offset));
      if (written <= 0) throw new Error('temp write failed');
      offset += written;
      throwIfCancelled(signal);
    }
    await file.sync();
    throwIfCancelled(signal);
    await Deno.chmod(temporary, mode);
    throwIfCancelled(signal);
    file.close();
    file = undefined;
    await seams.beforeRename?.(checked.absolute, temporary);
    throwIfCancelled(signal);
    await ensureParent(workspace, checked.parent, true, signal);
    await ensureParent(workspace, checked.parent, false, signal);
    const current = await Deno.lstat(checked.absolute).catch(
      (error: unknown) => {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      },
    );
    if (current?.isSymlink || (current && !current.isFile)) {
      throw new Error('target changed');
    }
    if (expectedBytes !== undefined) {
      if (!current) throw new Error('target changed');
      const latest = await readBytesBounded(checked.absolute);
      throwIfCancelled(signal);
      if (!bytesEqual(expectedBytes, latest)) throw new Error('target changed');
    }
    throwIfCancelled(signal);
    await Deno.rename(temporary, checked.absolute);
    const renamedTemporary = temporary;
    temporary = undefined;
    await seams.afterRename?.(checked.absolute, renamedTemporary);
    throwIfCancelled(signal);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    try {
      file?.close();
    } catch {
      if (signal?.aborted) cleanupError = new CancellationCleanupError();
    }
    if (temporary) {
      try {
        await seams.cleanupTemporary?.(temporary);
        await Deno.remove(temporary);
      } catch {
        if (signal?.aborted) cleanupError = new CancellationCleanupError();
      }
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (operationFailed) throw operationError;
};

const readSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    offset: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1 },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

const writeSchema = {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
  additionalProperties: false,
} as const;

const editSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    edits: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['oldText', 'newText'],
        additionalProperties: false,
      },
    },
  },
  required: ['path', 'edits'],
  additionalProperties: false,
} as const;

const bashSchema = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

const validateObject = (
  value: JsonValue,
  keys: readonly string[],
  name: string,
): JsonObject => {
  if (!isObject(value) || !exactKeys(value, keys)) {
    throw invalidToolArguments(name);
  }
  return value;
};

export const createReadTool = (workspace: Workspace): Tool => ({
  name: 'read',
  description:
    'Read complete lines from one UTF-8 workspace file (64 KiB result). offset is 1-based; use offset/limit and the continuation notice for large files.',
  inputSchema: readSchema,
  promptGuidelines: Object.freeze([
    'File調査ではcatやsedをbashで実行するよりreadを優先し、続きはoffset・limitで読む。',
  ]),
  async execute(argumentsValue, context?: ToolExecutionContext) {
    if (!isObject(argumentsValue)) throw invalidToolArguments('read');
    const keys = Object.keys(argumentsValue);
    if (
      !keys.includes('path') ||
      keys.some((key) => key !== 'path' && key !== 'offset' && key !== 'limit') ||
      typeof argumentsValue.path !== 'string' ||
      (argumentsValue.offset !== undefined &&
        (typeof argumentsValue.offset !== 'number' ||
          !Number.isSafeInteger(argumentsValue.offset) ||
          argumentsValue.offset < 1)) ||
      (argumentsValue.limit !== undefined &&
        (typeof argumentsValue.limit !== 'number' ||
          !Number.isSafeInteger(argumentsValue.limit) ||
          argumentsValue.limit < 1))
    ) throw invalidToolArguments('read');
    return await readWindow(
      workspace,
      argumentsValue.path,
      typeof argumentsValue.offset === 'number' ? argumentsValue.offset : 1,
      typeof argumentsValue.limit === 'number' ? argumentsValue.limit : undefined,
      context?.signal,
    );
  },
});

export const createWriteTool = (
  workspace: Workspace,
  seams: WorkToolSeams = {},
): Tool => ({
  name: 'write',
  description:
    'Create or replace one UTF-8 text file inside the workspace. Missing parent directories are created.',
  inputSchema: writeSchema,
  async execute(argumentsValue, context?: ToolExecutionContext) {
    const args = validateObject(argumentsValue, ['path', 'content'], 'write');
    if (
      typeof args.path !== 'string' ||
      !validTextArgument(args.content, MAX_TEXT_BYTES)
    ) throw invalidToolArguments('write');
    const content = args.content;
    const encoded = encoder.encode(content);
    const checked = await checkedPath(
      workspace,
      args.path,
      true,
      context?.signal,
    ).catch(
      (error: unknown) => {
        if (error instanceof ToolInputError) throw error;
        if (isTurnCancelledError(error)) throw error;
        throw new Error('local write failed');
      },
    );
    if (checked.targetInfo && !checked.targetInfo.isFile) {
      throw new Error('target is not a regular file');
    }
    const mode = checked.targetInfo?.mode == null ? 0o644 : checked.targetInfo.mode & 0o7777;
    try {
      await atomicReplace(
        workspace,
        checked,
        encoded,
        mode,
        seams,
        undefined,
        context?.signal,
      );
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      if (isTurnCancelledError(error) || isCancellationCleanupError(error)) {
        throw error;
      }
      throw new Error('local write failed');
    }
    return JSON.stringify({
      path: checked.relative,
      bytes: encoded.byteLength,
    });
  },
});

interface EditOperation {
  readonly oldText: string;
  readonly newText: string;
}

export const createEditTool = (
  workspace: Workspace,
  seams: WorkToolSeams = {},
): Tool => ({
  name: 'edit',
  description:
    'Apply up to 32 non-overlapping exact replacements to one existing UTF-8 text file. Each oldText must match exactly once in the original file.',
  inputSchema: editSchema,
  async execute(argumentsValue, context?: ToolExecutionContext) {
    const args = validateObject(argumentsValue, ['path', 'edits'], 'edit');
    if (
      typeof args.path !== 'string' || !Array.isArray(args.edits) ||
      args.edits.length < 1 ||
      args.edits.length > 32
    ) {
      throw invalidToolArguments('edit');
    }
    const operations: EditOperation[] = [];
    for (let index = 0; index < args.edits.length; index += 1) {
      const operation = args.edits[index];
      if (
        !isObject(operation) || !exactKeys(operation, ['oldText', 'newText']) ||
        typeof operation.oldText !== 'string' ||
        typeof operation.newText !== 'string' ||
        !validTextArgument(operation.oldText, MAX_TEXT_BYTES) ||
        !validTextArgument(operation.newText, MAX_TEXT_BYTES)
      ) {
        throw invalidToolArguments('edit');
      }
      if (operation.oldText.length === 0) {
        throw new ToolInputError(`edit ${index + 1} oldText is empty`);
      }
      if (operation.oldText === operation.newText) {
        throw new ToolInputError(`edit ${index + 1} does not change content`);
      }
      operations.push({
        oldText: operation.oldText,
        newText: operation.newText,
      });
    }
    const snapshot = await readTarget(
      workspace,
      args.path,
      'edit',
      context?.signal,
    );
    const spans: { start: number; end: number; operation: EditOperation }[] = [];
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const first = snapshot.text.indexOf(operation.oldText);
      if (first < 0) {
        throw new ToolInputError(`edit ${index + 1} oldText was not found`);
      }
      if (snapshot.text.indexOf(operation.oldText, first + 1) >= 0) {
        throw new ToolInputError(`edit ${index + 1} oldText is not unique`);
      }
      spans.push({
        start: first,
        end: first + operation.oldText.length,
        operation,
      });
    }
    spans.sort((left, right) => left.start - right.start);
    for (let index = 1; index < spans.length; index += 1) {
      if (spans[index - 1].end > spans[index].start) {
        throw new ToolInputError('edits overlap');
      }
    }
    let output = '';
    let cursor = 0;
    for (const span of spans) {
      output += snapshot.text.slice(cursor, span.start) +
        span.operation.newText;
      cursor = span.end;
    }
    output += snapshot.text.slice(cursor);
    const encoded = encoder.encode(output);
    if (encoded.byteLength > MAX_TEXT_BYTES) {
      throw new Error('file exceeds 64 KiB');
    }
    throwIfCancelled(context?.signal);
    let latest: Uint8Array;
    try {
      latest = await readBytesBounded(snapshot.checked.absolute);
      throwIfCancelled(context?.signal);
    } catch (error) {
      if (isTurnCancelledError(error)) throw error;
      throw new Error('local edit failed');
    }
    if (!bytesEqual(snapshot.bytes, latest)) {
      throw new Error('local edit failed');
    }
    const mode = snapshot.checked.targetInfo?.mode == null
      ? 0o644
      : snapshot.checked.targetInfo.mode & 0o7777;
    try {
      await atomicReplace(
        workspace,
        snapshot.checked,
        encoded,
        mode,
        seams,
        snapshot.bytes,
        context?.signal,
      );
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      if (isTurnCancelledError(error) || isCancellationCleanupError(error)) {
        throw error;
      }
      throw new Error('local edit failed');
    }
    return JSON.stringify({
      path: snapshot.checked.relative,
      edits: operations.length,
      bytes: encoded.byteLength,
    });
  },
});

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);

interface CapturedStream {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

interface CaptureState {
  readonly done: Promise<CapturedStream>;
  readonly snapshot: () => CapturedStream;
  readonly cancelAndWait: () => Promise<void>;
  readonly progressText: () => string;
}

type BashOutputStopEvent =
  | { readonly kind: 'limit'; readonly limit: BashOutputLimitSnapshot }
  | { readonly kind: 'persistence' };

class BashOutputToolResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BashOutputToolResultError';
  }
}

const startDrain = (
  stream: ReadableStream<Uint8Array>,
  output: BashOutputCommandCapture,
  outputStream: BashOutputStream,
  onOutputStop: (event: BashOutputStopEvent) => void,
  onProgress?: (prefix: string) => void,
): CaptureState => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let progressPrefix = '';
  let progressBytes = 0;
  let progressFrozen = false;
  let progressDisabled = false;
  const progressDecoder = new TextDecoder('utf-8', { fatal: true });
  const outputDecoder = new TextDecoder('utf-8');
  let pendingOutput = '';
  let spooling = false;
  let storageStopped = false;
  const snapshot = (): CapturedStream => ({
    bytes: concatBytes(chunks, total),
    truncated,
  });
  const progressText = (): string => progressPrefix;
  const observe = (bytes: Uint8Array): void => {
    if (progressDisabled || progressFrozen || bytes.byteLength === 0) return;
    let decoded: string;
    try {
      decoded = progressDecoder.decode(bytes, { stream: true });
    } catch {
      // The final bounded capture remains authoritative; only live observation is disabled.
      progressDisabled = true;
      return;
    }
    if (decoded.length === 0) return;
    let changed = false;
    for (const character of decoded) {
      const size = encoder.encode(character).byteLength;
      if (progressBytes + size > MAX_PROGRESS_STREAM_BYTES) {
        // Do not classify a valid scalar crossing the observation cap as malformed. Freeze this
        // stream before the scalar while raw capture continues unchanged.
        progressFrozen = true;
        break;
      }
      progressPrefix += character;
      progressBytes += size;
      changed = true;
    }
    if (changed) onProgress?.(progressPrefix);
  };
  const done = (async (): Promise<CapturedStream> => {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        const remaining = MAX_CAPTURE_BYTES - total;
        if (remaining > 0) {
          const retained = item.value.slice(0, remaining);
          chunks.push(retained);
          total += retained.byteLength;
        }
        if (item.value.byteLength > remaining) truncated = true;
        observe(item.value);
        const decoded = outputDecoder.decode(item.value, { stream: true });
        if (!spooling) {
          pendingOutput += decoded;
          if (truncated) {
            spooling = true;
            if (pendingOutput.length > 0) {
              try {
                const result = await output.append(outputStream, pendingOutput);
                if (result.limit) {
                  storageStopped = true;
                  onOutputStop({ kind: 'limit', limit: result.limit });
                }
              } catch {
                storageStopped = true;
                onOutputStop({ kind: 'persistence' });
              }
              pendingOutput = '';
            }
          }
        } else if (!storageStopped && decoded.length > 0) {
          try {
            const result = await output.append(outputStream, decoded);
            if (result.limit) {
              storageStopped = true;
              onOutputStop({ kind: 'limit', limit: result.limit });
            }
          } catch {
            storageStopped = true;
            onOutputStop({ kind: 'persistence' });
          }
        }
      }
      const finalText = outputDecoder.decode();
      if (spooling && !storageStopped && finalText.length > 0) {
        try {
          const result = await output.append(outputStream, finalText);
          if (result.limit) {
            onOutputStop({ kind: 'limit', limit: result.limit });
          }
        } catch {
          onOutputStop({ kind: 'persistence' });
        }
      }
      if (!progressDisabled && !progressFrozen) {
        try {
          observe(new Uint8Array());
          progressDecoder.decode();
        } catch {
          // An incomplete terminal sequence is malformed for live observation only.
          progressDisabled = true;
        }
      }
    } catch {
      // Cancellation after the bounded capture grace is an expected cleanup path.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The stream may already have released its reader during cancellation.
      }
    }
    return snapshot();
  })();
  return {
    done,
    snapshot,
    cancelAndWait: async () => {
      await reader.cancel();
      await done;
    },
    progressText,
  };
};

const waitForCapture = async (
  stdout: CaptureState,
  stderr: CaptureState,
  waitForSettlement: boolean,
  seams: BashToolSeams,
): Promise<readonly [CapturedStream, CapturedStream]> => {
  await seams.beforeCapture?.(waitForSettlement);
  if (waitForSettlement) {
    await Promise.all([stdout.done, stderr.done]);
    return [await stdout.done, await stderr.done];
  }
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      Promise.all([stdout.done, stderr.done]).then(() => true),
      new Promise<boolean>((resolve) => {
        captureTimer = setTimeout(() => resolve(false), CAPTURE_GRACE_MS);
      }),
    ]);
    if (completed) return [await stdout.done, await stderr.done];
    const settled = await Promise.allSettled([
      stdout.cancelAndWait(),
      stderr.cancelAndWait(),
    ]);
    if (settled.some((result) => result.status === 'rejected')) {
      throw new Error('capture cleanup failed');
    }
    return [stdout.snapshot(), stderr.snapshot()];
  } finally {
    if (captureTimer !== undefined) clearTimeout(captureTimer);
  }
};

export const createBashTool = (
  workspace: Workspace,
  outputStore: BashOutputStore = createBashOutputStore(),
  seams: BashToolSeams = {},
): Tool => ({
  name: 'bash',
  description:
    'Run one Bash command from the workspace. Default timeout 30000 ms; maximum 120000 ms. stdout and stderr are captured separately. Truncated output can be continued with bash_output.',
  inputSchema: bashSchema,
  async execute(argumentsValue, context?: ToolExecutionContext) {
    const args = validateObject(argumentsValue, [
      'command',
      ...(isObject(argumentsValue) && 'timeoutMs' in argumentsValue ? ['timeoutMs'] : []),
    ], 'bash');
    if (
      !Object.hasOwn(args, 'command') || typeof args.command !== 'string' ||
      !validTextArgument(args.command, MAX_COMMAND_BYTES) ||
      args.command.trim().length === 0
    ) {
      throw invalidToolArguments('bash');
    }
    const timeoutMs = Object.hasOwn(args, 'timeoutMs') ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
    if (
      typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) throw invalidToolArguments('bash');
    throwIfCancelled(context?.signal);
    const outputCapture = outputStore.beginCommand();
    const abandonCancelledCapture = async (): Promise<void> => {
      try {
        await outputCapture.abandon();
      } catch {
        throw new CancellationCleanupError();
      }
    };
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command('/bin/bash', {
        args: ['--noprofile', '--norc', '-c', args.command],
        cwd: workspace.root,
        clearEnv: true,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
    } catch {
      await outputCapture.finish().catch(() => undefined);
      throw new Error('bash could not start');
    }
    let timedOut = false;
    let cancellationRequested = false;
    let outputStopEvent: BashOutputStopEvent | undefined;
    let outputStopResolve!: (value: 'output') => void;
    const outputStop = new Promise<'output'>((resolve) => {
      outputStopResolve = resolve;
    });
    const noteOutputStop = (event: BashOutputStopEvent): void => {
      if (outputStopEvent !== undefined) return;
      outputStopEvent = event;
      outputStopResolve('output');
    };
    const reportProgress = context?.reportProgress;
    const stderrCapture: { current?: CaptureState } = {};
    const stdout = startDrain(
      child.stdout,
      outputCapture,
      'stdout',
      noteOutputStop,
      (prefix) => {
        reportProgress?.(
          `stdout:\n${prefix}\nstderr:\n${stderrCapture.current?.progressText() ?? ''}`,
        );
      },
    );
    const stderr = startDrain(
      child.stderr,
      outputCapture,
      'stderr',
      noteOutputStop,
      (prefix) => {
        reportProgress?.(
          `stdout:\n${stdout.progressText()}\nstderr:\n${prefix}`,
        );
      },
    );
    stderrCapture.current = stderr;
    let status: Deno.CommandStatus | undefined;
    const statusPromise = child.status.then((value) => {
      status = value;
      return value;
    });
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      cancellationRequested = true;
      cancellationResolve?.('cancelled');
    };
    let cancellationResolve: ((value: 'cancelled') => void) | undefined;
    const cancellation = new Promise<'cancelled'>((resolve) => {
      cancellationResolve = resolve;
      context?.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutTimer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const teardown = async (cancelledByUser: boolean): Promise<void> => {
      let cleanupFailedAfterCancellation = false;
      const cancellationWon = (): boolean =>
        cancellationRequested || context?.signal?.aborted === true;
      const noteCleanupFailure = (): void => {
        if (cancellationWon()) cleanupFailedAfterCancellation = true;
      };
      if (status === undefined) {
        try {
          child.kill('SIGTERM');
        } catch {
          if (status === undefined) noteCleanupFailure();
        }
        const termGrace = await Promise.race([
          statusPromise.then(() => 'status' as const),
          new Promise<'grace'>((resolve) => setTimeout(() => resolve('grace'), CAPTURE_GRACE_MS)),
        ]);
        if (termGrace === 'grace' && status === undefined) {
          try {
            child.kill('SIGKILL');
          } catch {
            if (status === undefined) noteCleanupFailure();
          }
        }
        try {
          await statusPromise;
        } catch {
          noteCleanupFailure();
        }
      }
      try {
        await waitForCapture(stdout, stderr, cancelledByUser, seams);
        // A timeout may begin ordinary bounded capture cleanup before the user requests
        // cancellation. Once that request arrives, upgrade to full capture settlement before
        // allowing the interrupted turn to surface.
        if (cancellationWon() && !cancelledByUser) {
          await waitForCapture(stdout, stderr, true, seams);
        }
      } catch {
        noteCleanupFailure();
        const settled = await Promise.allSettled([
          stdout.cancelAndWait(),
          stderr.cancelAndWait(),
        ]);
        if (settled.some((result) => result.status === 'rejected')) {
          noteCleanupFailure();
        }
      }
      if (cancellationWon() && cleanupFailedAfterCancellation) {
        throw new CancellationCleanupError();
      }
    };
    try {
      const first = await Promise.race([
        statusPromise.then(() => 'status' as const),
        timeout,
        cancellation,
        outputStop,
      ]);
      if (first === 'timeout' || first === 'cancelled' || first === 'output') {
        if (first === 'cancelled') cancellationRequested = true;
        if (first === 'timeout') timedOut = true;
        await teardown(cancellationRequested);
      } else {
        await statusPromise;
        // A cancellation can be requested in the same turn as child completion. It wins only
        // before the result is settled, after all direct resources have been reaped.
        if (cancellationRequested || context?.signal?.aborted) {
          await teardown(true);
        }
        await waitForCapture(stdout, stderr, false, seams);
      }
      if (cancellationRequested || context?.signal?.aborted) {
        await abandonCancelledCapture();
        throw new TurnCancelledError();
      }
      const [capturedStdout, capturedStderr] = await waitForCapture(
        stdout,
        stderr,
        false,
        seams,
      );
      let outputSummary;
      try {
        outputSummary = await outputCapture.finish();
      } catch (error) {
        if (error instanceof BashOutputPersistenceError) {
          outputStopEvent = { kind: 'persistence' };
          outputSummary = await outputCapture.summary();
        } else throw error;
      }
      // The final partial segment is persisted asynchronously. Cancellation that arrives while
      // that flush is in flight still owns the turn, so do not retain an identity that the loop
      // will never commit to the transcript.
      if (cancellationRequested || context?.signal?.aborted) {
        await abandonCancelledCapture();
        throw new TurnCancelledError();
      }
      const result: Record<string, unknown> = {
        stdout: new TextDecoder().decode(capturedStdout.bytes),
        stderr: new TextDecoder().decode(capturedStderr.bytes),
        exitCode: status?.signal === null ? status.code : null,
        signal: status?.signal ?? null,
        timedOut,
        stdoutTruncated: capturedStdout.truncated,
        stderrTruncated: capturedStderr.truncated,
      };
      if (outputSummary.available && outputSummary.outputId !== undefined) {
        const streams = Object.entries(outputSummary.streams).map((
          [stream, totalBytes],
        ) => ({
          stream,
          totalBytes,
          offset: 0,
          limit: BASH_OUTPUT_DEFAULT_WINDOW_BYTES,
        }));
        result.outputId = outputSummary.outputId;
        result.savedStreams = outputSummary.streams;
        result.outputComplete = outputSummary.limit === undefined;
        result.readback = {
          tool: 'bash_output',
          outputId: outputSummary.outputId,
          streams,
        };
      }
      if (outputSummary.limit !== undefined) {
        result.outputLimitExceeded = true;
        result.outputComplete = false;
        result.outputLimit = outputSummary.limit;
      }
      if (outputStopEvent?.kind === 'persistence') {
        result.outputComplete = false;
        result.error = 'bash output persistence failed';
        throw new BashOutputToolResultError(JSON.stringify(result));
      }
      return JSON.stringify(result);
    } catch (error) {
      if (
        error instanceof CancellationCleanupError || isTurnCancelledError(error)
      ) {
        await abandonCancelledCapture();
        throw error;
      }
      if (error instanceof BashOutputToolResultError) throw error;
      throw new Error('bash could not start');
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      context?.signal?.removeEventListener('abort', onAbort);
    }
  },
});

export const createWorkTools = (
  workspace: Workspace,
  seams: WorkToolSeams = {},
): readonly Tool[] => {
  const outputStore = seams.bashOutputStore ?? createBashOutputStore();
  return [
    createBashTool(workspace, outputStore, seams.bash ?? {}),
    createBashOutputTool(outputStore),
    createEditTool(workspace, seams),
    createReadTool(workspace),
    createWriteTool(workspace, seams),
  ];
};
