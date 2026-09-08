import {
  CancellationCleanupError,
  isTurnCancelledError,
  throwIfCancelled,
} from '../core/cancellation.ts';
import { ToolInputError } from './tools.ts';
import type { Workspace, WorkToolSeams } from './work_tool_contract.ts';
import { type CheckedPath, checkedPath, ensureParent } from './work_tool_workspace.ts';
import { encoder, MAX_TEXT_BYTES } from './work_tool_value.ts';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const TEMP_ATTEMPTS = 8;

export const readBytesBounded = async (path: string): Promise<Uint8Array> => {
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

export const readTarget = async (
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

export const readWindow = async (
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

export const atomicReplace = async (
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

export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);
