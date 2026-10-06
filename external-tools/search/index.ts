import {
  CancellationCleanupError,
  type ToolFactory,
  ToolInputError,
  TurnCancelledError,
} from '@henji/tool';
import type { JsonValue, ProcessOperation, Tool } from '@henji/tool';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  GREP_EXECUTABLE,
  RIPGREP_EXECUTABLE,
  SEARCH_CAPTURE_BYTES,
  SEARCH_LANG,
  SEARCH_LC_ALL,
  SEARCH_PATH,
  SEARCH_RESULT_BYTES,
  SEARCH_STDERR_BYTES,
} from './settings.ts';

type SearchMode = 'paths' | 'files' | 'content' | 'count' | 'entries';
type PatternKind = 'literal' | 'regex';
type Backend = 'rg' | 'grep';
type EntryType = 'file' | 'directory' | 'symlink' | 'other';
type SearchRecord = string | {
  readonly path: string;
  readonly line: number;
  readonly text: string;
} | {
  readonly path: string;
  readonly type: EntryType;
  readonly bytes?: number;
  readonly modifiedAt?: string;
};

interface SearchArguments {
  readonly mode: SearchMode;
  readonly path: string;
  readonly glob?: string;
  readonly pattern?: string;
  readonly patternKind: PatternKind;
  readonly caseSensitive: boolean;
  readonly offset: number;
  readonly limit: number;
  readonly depth?: number;
}

interface ProcessResult<Output> {
  readonly status: { readonly exitCode: number | null; readonly signal: string | null };
  readonly stdout: Output;
  readonly stderr: Uint8Array;
  readonly truncated: boolean;
}

interface CapturedOutput {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const searchSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['paths', 'files', 'content', 'count', 'entries'] },
    path: {
      type: 'string',
      description:
        'Workspace file or directory, relative or absolute inside the workspace; defaults to the workspace root.',
    },
    glob: {
      type: 'string',
      description:
        'Optional Henji path glob; not passed to rg. A leading ! does not exclude paths.',
    },
    pattern: { type: 'string', description: 'Required for files, content, and count modes.' },
    patternKind: {
      type: 'string',
      enum: ['literal', 'regex'],
      description: 'Defaults to regex; regex syntax follows the selected backend.',
    },
    caseSensitive: { type: 'boolean', description: 'Defaults to true.' },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Zero-based record offset; defaults to 0. Does not apply to count mode.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      description:
        'Records per page; defaults to 100 and has no fixed maximum. Does not apply to count mode.',
    },
    depth: {
      type: 'integer',
      minimum: 1,
      maximum: 16,
      description:
        'entries only: directory levels to list below path; defaults to 1 (direct children).',
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

const asObject = (value: JsonValue): Record<string, JsonValue> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolInputError('search expects an object');
  }
  return value as Record<string, JsonValue>;
};

const parseArguments = (value: JsonValue): SearchArguments => {
  const args = asObject(value);
  const allowed = new Set([
    'mode',
    'path',
    'glob',
    'pattern',
    'patternKind',
    'caseSensitive',
    'offset',
    'limit',
    'depth',
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new ToolInputError('search received an unknown argument');
  }
  if (
    args.mode !== 'paths' && args.mode !== 'files' && args.mode !== 'content' &&
    args.mode !== 'count' && args.mode !== 'entries'
  ) {
    throw new ToolInputError('mode must be paths, files, content, count, or entries');
  }
  if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length === 0)) {
    throw new ToolInputError('path must be a non-empty workspace path');
  }
  if (args.glob !== undefined && typeof args.glob !== 'string') {
    throw new ToolInputError('glob must be a string');
  }
  if (args.pattern !== undefined && typeof args.pattern !== 'string') {
    throw new ToolInputError('pattern must be a string');
  }
  if (args.mode !== 'paths' && args.mode !== 'entries' && typeof args.pattern !== 'string') {
    throw new ToolInputError('pattern is required for files, content, and count modes');
  }
  if (
    args.patternKind !== undefined && args.patternKind !== 'literal' && args.patternKind !== 'regex'
  ) {
    throw new ToolInputError('patternKind must be literal or regex');
  }
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean') {
    throw new ToolInputError('caseSensitive must be a boolean');
  }
  if (
    args.offset !== undefined &&
    (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0)
  ) throw new ToolInputError('offset must be a non-negative safe integer');
  if (
    args.limit !== undefined &&
    (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1)
  ) throw new ToolInputError('limit must be a positive safe integer');
  if (args.depth !== undefined) {
    if (args.mode !== 'entries') {
      throw new ToolInputError('depth is only supported for the entries mode');
    }
    if (
      typeof args.depth !== 'number' || !Number.isSafeInteger(args.depth) || args.depth < 1 ||
      args.depth > 16
    ) throw new ToolInputError('depth must be an integer from 1 to 16');
  }

  return {
    mode: args.mode,
    path: typeof args.path === 'string' ? args.path : '.',
    ...(typeof args.glob === 'string' ? { glob: args.glob } : {}),
    ...(typeof args.pattern === 'string' ? { pattern: args.pattern } : {}),
    patternKind: args.patternKind === 'literal' ? 'literal' : 'regex',
    caseSensitive: args.caseSensitive !== false,
    offset: typeof args.offset === 'number' ? args.offset : 0,
    limit: typeof args.limit === 'number' ? args.limit : 100,
    ...(typeof args.depth === 'number' ? { depth: args.depth } : {}),
  };
};

const within = (root: string, target: string): boolean => {
  const fromRoot = relative(root, target);
  return fromRoot === '' ||
    (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

const workspaceRelative = (root: string, target: string): string =>
  relative(root, target).split(sep).join('/');

const globRegExp = (glob: string): RegExp => {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const close = glob.indexOf(']', index + 1);
      if (close <= index + 1 || glob.slice(index + 1, close) === '!') source += '\\[';
      else {
        const body = glob.slice(index + 1, close);
        const negative = body.startsWith('!');
        const contents = negative ? body.slice(1) : body;
        source += `[${negative ? '^' : ''}${
          contents.replaceAll('\\', '\\\\').replaceAll('^', '\\^')
        }]`;
        index = close;
      }
    } else source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`);
};

const enumerateFiles = async (
  workspaceRoot: string,
  scopePath: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const absolute = resolve(workspaceRoot, scopePath);
  if (!within(workspaceRoot, absolute)) {
    throw new ToolInputError('path must stay within the workspace');
  }
  const scopeInfo = await Deno.stat(absolute);
  const files: string[] = [];
  if (scopeInfo.isFile) return [absolute];
  if (!scopeInfo.isDirectory) throw new ToolInputError('path must name a file or directory');

  const ancestors = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    if (signal?.aborted) throw new TurnCancelledError();
    const realDirectory = await Deno.realPath(directory);
    if (ancestors.has(realDirectory)) return;
    ancestors.add(realDirectory);
    try {
      for await (const entry of Deno.readDir(directory)) {
        if (signal?.aborted) throw new TurnCancelledError();
        const child = resolve(directory, entry.name);
        let info: Deno.FileInfo;
        try {
          info = await Deno.stat(child);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        if (info.isDirectory) await visit(child);
        else if (info.isFile) files.push(child);
      }
    } finally {
      ancestors.delete(realDirectory);
    }
  };
  await visit(absolute);
  files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return files;
};

interface EntryRecord {
  readonly path: string;
  readonly type: EntryType;
  readonly bytes?: number;
  readonly modifiedAt?: string;
}

const entryType = (info: Deno.FileInfo): EntryType =>
  info.isSymlink ? 'symlink' : info.isFile ? 'file' : info.isDirectory ? 'directory' : 'other';

const entryRecord = (
  workspaceRoot: string,
  absolute: string,
  info: Deno.FileInfo,
): EntryRecord => ({
  path: workspaceRelative(workspaceRoot, absolute),
  type: entryType(info),
  ...(info.isFile ? { bytes: info.size } : {}),
  ...(info.mtime === null ? {} : { modifiedAt: info.mtime.toISOString() }),
});

/** List workspace entries with type, size, and modification time; symlinked directories are not followed. */
const enumerateEntries = async (
  workspaceRoot: string,
  scopePath: string,
  depth: number,
  signal?: AbortSignal,
): Promise<EntryRecord[]> => {
  const absolute = resolve(workspaceRoot, scopePath);
  if (!within(workspaceRoot, absolute)) {
    throw new ToolInputError('path must stay within the workspace');
  }
  const scopeInfo = await Deno.lstat(absolute);
  if (!scopeInfo.isDirectory) {
    throw new ToolInputError('path must name a directory for the entries mode');
  }
  const records: EntryRecord[] = [];
  const ancestors = new Set<string>();
  const visit = async (directory: string, remaining: number): Promise<void> => {
    if (signal?.aborted) throw new TurnCancelledError();
    const realDirectory = await Deno.realPath(directory);
    if (ancestors.has(realDirectory)) return;
    ancestors.add(realDirectory);
    try {
      for await (const entry of Deno.readDir(directory)) {
        if (signal?.aborted) throw new TurnCancelledError();
        const child = resolve(directory, entry.name);
        let info: Deno.FileInfo;
        try {
          info = await Deno.lstat(child);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        records.push(entryRecord(workspaceRoot, child, info));
        if (info.isDirectory && !info.isSymlink && remaining > 1) {
          await visit(child, remaining - 1);
        }
      }
    } finally {
      ancestors.delete(realDirectory);
    }
  };
  await visit(absolute, depth);
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return records;
};

const filterEntries = (
  entries: readonly EntryRecord[],
  glob: string | undefined,
): EntryRecord[] => {
  const matcher = glob === undefined ? undefined : globRegExp(glob);
  return matcher === undefined ? [...entries] : entries.filter((entry) => {
    const candidate = glob!.includes('/') ? entry.path : entry.path.split('/').at(-1)!;
    return matcher.test(candidate);
  });
};

const filterFiles = (
  root: string,
  files: readonly string[],
  glob: string | undefined,
): string[] => {
  const matcher = glob === undefined ? undefined : globRegExp(glob);
  return matcher === undefined ? [...files] : files.filter((file) => {
    const relativePath = workspaceRelative(root, file);
    const candidate = glob!.includes('/') ? relativePath : relativePath.split('/').at(-1)!;
    return matcher.test(candidate);
  });
};

/** Contents modes search text, not database files or NUL-containing binary blobs. */
const textFiles = async (
  files: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> => {
  const selected: string[] = [];
  const buffer = new Uint8Array(64 * 1024);
  for (const path of files) {
    if (signal?.aborted) throw new TurnCancelledError();
    if (/\.(?:db|sqlite|sqlite3|blob)(?:-(?:wal|shm))?$/i.test(path)) continue;
    const file = await Deno.open(path, { read: true });
    let binary = false;
    let first = true;
    let utf16 = false;
    let previousByte: number | undefined;
    try {
      for (;;) {
        if (signal?.aborted) throw new TurnCancelledError();
        const count = await file.read(buffer);
        if (count === null) break;
        // rg detects UTF-16 BOMs. Reject encoded U+0000, not its normal zero bytes.
        if (first && count >= 2) {
          utf16 = (buffer[0] === 0xff && buffer[1] === 0xfe) ||
            (buffer[0] === 0xfe && buffer[1] === 0xff);
        }
        first = false;
        if (utf16) {
          for (let index = 0; index < count; index++) {
            if (previousByte === undefined) previousByte = buffer[index];
            else {
              if (previousByte === 0 && buffer[index] === 0) {
                binary = true;
                break;
              }
              previousByte = undefined;
            }
          }
        } else {
          binary = buffer.subarray(0, count).includes(0);
        }
        if (binary) break;
      }
    } finally {
      file.close();
    }
    if (!binary) selected.push(path);
  }
  return selected;
};

const findExecutable = async (name: string): Promise<string | undefined> => {
  for (const directory of SEARCH_PATH.split(':')) {
    if (directory.length === 0) continue;
    const candidate = resolve(directory, name);
    try {
      const info = await Deno.stat(candidate);
      if (info.isFile && info.mode !== null && (info.mode & 0o111) !== 0) return candidate;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return undefined;
};

const selectBackend = async (): Promise<
  { readonly backend: Backend; readonly executable: string }
> => {
  const rg = await findExecutable(RIPGREP_EXECUTABLE);
  if (rg !== undefined) return { backend: 'rg', executable: rg };
  const grep = await findExecutable(GREP_EXECUTABLE);
  if (grep !== undefined) return { backend: 'grep', executable: grep };
  throw new Error(`search could not find ${RIPGREP_EXECUTABLE} or ${GREP_EXECUTABLE} in its PATH`);
};

const readLimited = async (
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  stop: () => void,
): Promise<CapturedOutput> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = maximum - length;
      if (remaining > 0) {
        const retained = result.value.subarray(0, remaining);
        chunks.push(retained);
        length += retained.byteLength;
      }
      if (result.value.byteLength > remaining) {
        truncated = true;
        stop();
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: output, truncated };
};

const runBackend = async <Output>(
  executor: NonNullable<Parameters<ToolFactory>[0]['processExecutor']>,
  command: { readonly executable: string; readonly args: readonly string[]; readonly cwd: string },
  signal: AbortSignal | undefined,
  readStdout: (stream: ReadableStream<Uint8Array>, stop: () => void) => Promise<Output>,
): Promise<ProcessResult<Output>> => {
  if (signal?.aborted) throw new TurnCancelledError();
  const operation: ProcessOperation = executor.start({
    ...command,
    env: {
      PATH: SEARCH_PATH,
      LANG: SEARCH_LANG,
      LC_ALL: SEARCH_LC_ALL,
    },
  });
  let stoppingForLimit: Promise<void> | undefined;
  const stopForLimit = (): void => {
    stoppingForLimit ??= operation.stop();
    void stoppingForLimit.catch(() => {});
  };
  const completion = Promise.all([
    readStdout(operation.stdout, stopForLimit),
    readLimited(operation.stderr, SEARCH_STDERR_BYTES, stopForLimit),
    operation.status,
    operation.closed,
  ]).then(([stdout, stderr, status]) => ({
    stdout,
    stderr: stderr.bytes,
    status,
    truncated: stoppingForLimit !== undefined,
  }));
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await operation.release();
  };
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<'cancelled'>((resolveCancel) => {
    onAbort = () => resolveCancel('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  let result: ProcessResult<Output> | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const outcome = await Promise.race([completion, cancelled]);
    if (outcome === 'cancelled' || signal?.aborted) {
      let stopFailed = false;
      try {
        await operation.stop();
      } catch {
        stopFailed = true;
      }
      const settled = await Promise.allSettled([completion]);
      try {
        await release();
      } catch {
        stopFailed = true;
      }
      if (stopFailed || settled[0]?.status === 'rejected') {
        throw new CancellationCleanupError();
      }
      throw new TurnCancelledError();
    }
    result = outcome;
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  try {
    await stoppingForLimit;
    await release();
  } catch (error) {
    if (signal?.aborted) {
      failed = true;
      failure = new CancellationCleanupError();
    } else if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return result!;
};

const chunksOf = (files: readonly string[]): string[][] => {
  const chunks: string[][] = [];
  let current: string[] = [];
  let encodedBytes = 0;
  for (const file of files) {
    const bytes = encoder.encode(file).byteLength + 1;
    if (current.length > 0 && (current.length >= 128 || encodedBytes + bytes > 48 * 1024)) {
      chunks.push(current);
      current = [];
      encodedBytes = 0;
    }
    current.push(file);
    encodedBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const flags = (input: SearchArguments): string[] => [
  ...(input.patternKind === 'literal' ? ['--fixed-strings'] : []),
  ...(input.caseSensitive ? [] : ['--ignore-case']),
];

const decodeNullRecords = (bytes: Uint8Array, truncated = false): string[] => {
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    records.push(decoder.decode(bytes.subarray(start, index)));
    start = index + 1;
  }
  if (!truncated && start < bytes.length) records.push(decoder.decode(bytes.subarray(start)));
  return records.filter((record) => record.length > 0);
};

const contentRecords = (
  bytes: Uint8Array,
  root: string,
  truncated = false,
): SearchRecord[] => {
  const records: SearchRecord[] = [];
  let start = 0;
  while (start < bytes.length) {
    const delimiter = bytes.indexOf(0, start);
    if (delimiter < 0 && truncated) break;
    if (delimiter < 0) throw new Error('search backend returned an invalid content record');
    const lineEnd = bytes.indexOf(0x0a, delimiter + 1);
    if (lineEnd < 0 && truncated) break;
    const end = lineEnd < 0 ? bytes.length : lineEnd;
    const file = decoder.decode(bytes.subarray(start, delimiter));
    const rest = bytes.subarray(delimiter + 1, end);
    const colon = rest.indexOf(0x3a);
    if (colon < 1) throw new Error('search backend returned an invalid line record');
    const lineText = decoder.decode(rest.subarray(0, colon));
    const line = Number(lineText);
    if (!Number.isSafeInteger(line) || line < 1) {
      throw new Error('search backend returned an invalid line number');
    }
    records.push({
      path: workspaceRelative(root, resolve(file)),
      line,
      text: decoder.decode(rest.subarray(colon + 1)),
    });
    start = lineEnd < 0 ? bytes.length : lineEnd + 1;
  }
  return records;
};

const checkBackendResult = (backend: Backend, result: ProcessResult<unknown>): void => {
  if (result.truncated && result.status.signal !== null) return;
  const exitCode = result.status.exitCode;
  if (exitCode !== 0 && exitCode !== 1) {
    const detail = decoder.decode(result.stderr).trim();
    throw new ToolInputError(
      detail.length > 0
        ? `${backend} search failed: ${detail}`
        : `${backend} search failed with exit code ${exitCode}`,
    );
  }
};

const sumFileCounts = (bytes: Uint8Array, truncated = false): number => {
  let count = 0;
  let start = 0;
  while (start < bytes.length) {
    const delimiter = bytes.indexOf(0, start);
    if (delimiter < 0 && truncated) break;
    if (delimiter < 0) throw new Error('search backend returned an invalid count record');
    const lineEnd = bytes.indexOf(0x0a, delimiter + 1);
    if (lineEnd < 0 && truncated) break;
    const end = lineEnd < 0 ? bytes.length : lineEnd;
    count += Number(decoder.decode(bytes.subarray(delimiter + 1, end)));
    start = end + 1;
  }
  return count;
};

const countMatches = async (
  input: SearchArguments,
  root: string,
  files: readonly string[],
  executor: NonNullable<Parameters<ToolFactory>[0]['processExecutor']>,
  signal?: AbortSignal,
): Promise<{
  readonly mode: 'count';
  readonly backend: Backend;
  readonly matchCount: number;
  readonly truncated?: true;
}> => {
  const selected = await selectBackend();
  let matchCount = 0;
  let capturedBytes = 0;
  for (const batch of chunksOf(files)) {
    if (selected.backend === 'rg') {
      const result = await runBackend(
        executor,
        {
          executable: selected.executable,
          args: [
            '--count-matches',
            '--with-filename',
            '--null',
            '--no-ignore',
            '--hidden',
            ...flags(input),
            '-e',
            input.pattern!,
            '--',
            ...batch,
          ],
          cwd: root,
        },
        signal,
        (stream, stop) => readLimited(stream, SEARCH_CAPTURE_BYTES - capturedBytes, stop),
      );
      checkBackendResult(selected.backend, result);
      matchCount += sumFileCounts(result.stdout.bytes, result.truncated);
      capturedBytes += result.stdout.bytes.byteLength;
      if (result.truncated) {
        return { mode: 'count', backend: selected.backend, matchCount, truncated: true };
      }
    } else {
      const result = await runBackend(
        executor,
        {
          executable: selected.executable,
          args: ['-I', '-h', '-o', ...flags(input), '-e', input.pattern!, '--', ...batch],
          cwd: root,
        },
        signal,
        (stream, stop) => readLimited(stream, SEARCH_CAPTURE_BYTES - capturedBytes, stop),
      );
      checkBackendResult(selected.backend, result);
      for (const byte of result.stdout.bytes) if (byte === 0x0a) matchCount += 1;
      capturedBytes += result.stdout.bytes.byteLength;
      if (result.truncated) {
        return { mode: 'count', backend: selected.backend, matchCount, truncated: true };
      }
    }
  }
  return { mode: 'count', backend: selected.backend, matchCount };
};

const search = async (
  input: SearchArguments,
  root: string,
  files: readonly string[],
  executor: NonNullable<Parameters<ToolFactory>[0]['processExecutor']>,
  signal?: AbortSignal,
): Promise<{
  readonly records: SearchRecord[];
  readonly backend?: Backend;
  readonly truncated?: true;
}> => {
  if (input.mode === 'paths') {
    return {
      records: files.map((file) => workspaceRelative(root, file)),
    };
  }
  if (files.length === 0) {
    return { records: [], backend: (await selectBackend()).backend };
  }
  const selected = await selectBackend();
  const matches: SearchRecord[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const pattern = input.pattern!;
  for (const batch of chunksOf(files)) {
    if (signal?.aborted) throw new TurnCancelledError();
    const backendArgs = selected.backend === 'rg'
      ? input.mode === 'files'
        ? [
          '--files-with-matches',
          '--null',
          '--no-ignore',
          '--hidden',
          ...flags(input),
          '-e',
          pattern,
          '--',
          ...batch,
        ]
        : [
          '--null',
          '--line-number',
          '--with-filename',
          '--no-heading',
          '--color',
          'never',
          '--no-ignore',
          '--hidden',
          ...flags(input),
          '-e',
          pattern,
          '--',
          ...batch,
        ]
      : input.mode === 'files'
      ? ['-I', '-lZ', ...flags(input), '-e', pattern, '--', ...batch]
      : ['-I', '-n', '-H', '-Z', ...flags(input), '-e', pattern, '--', ...batch];
    const result = await runBackend(
      executor,
      {
        executable: selected.executable,
        args: backendArgs,
        cwd: root,
      },
      signal,
      (stream, stop) => readLimited(stream, SEARCH_CAPTURE_BYTES - capturedBytes, stop),
    );
    checkBackendResult(selected.backend, result);
    if (input.mode === 'files') {
      for (const file of decodeNullRecords(result.stdout.bytes, result.truncated)) {
        matches.push(workspaceRelative(root, resolve(file)));
      }
    } else {
      for (const record of contentRecords(result.stdout.bytes, root, result.truncated)) {
        matches.push(record);
      }
    }
    capturedBytes += result.stdout.bytes.byteLength;
    if (result.truncated) {
      truncated = true;
      break;
    }
  }
  if (input.mode === 'files') {
    (matches as string[]).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  } else {
    (matches as { readonly path: string; readonly line: number; readonly text: string }[])
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : left.line - right.line
      );
  }
  return { records: matches, backend: selected.backend, ...(truncated ? { truncated: true } : {}) };
};

const resultRecord = (record: SearchRecord, maximum: number): SearchRecord | undefined => {
  if (encoder.encode(JSON.stringify(record)).byteLength <= maximum) return record;
  if (typeof record !== 'object' || !('text' in record)) return undefined;
  const marker = '\n[truncated]';
  let lower = 0;
  let upper = record.text.length;
  let selected: SearchRecord | undefined;
  while (lower <= upper) {
    const length = Math.floor((lower + upper) / 2);
    let end = length;
    const last = record.text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    const candidate = { ...record, text: record.text.slice(0, end) + marker };
    if (encoder.encode(JSON.stringify(candidate)).byteLength <= maximum) {
      selected = candidate;
      lower = length + 1;
    } else upper = length - 1;
  }
  return selected;
};

const pagePayload = (
  args: SearchArguments,
  records: readonly SearchRecord[],
  backend: Backend | undefined,
  captureTruncated = false,
): string => {
  const page: SearchRecord[] = [];
  // Keep room for the fixed envelope and truncation fields, then budget each JSON record.
  let remaining = SEARCH_RESULT_BYTES - 1024;
  let truncated = captureTruncated;
  for (
    let index = args.offset;
    index < Math.min(records.length, args.offset + args.limit);
    index++
  ) {
    const original = records[index]!;
    const record = resultRecord(original, remaining - 1);
    if (record === undefined) {
      truncated = true;
      break;
    }
    page.push(record);
    remaining -= encoder.encode(JSON.stringify(record)).byteLength + 1;
    if (record !== original) {
      truncated = true;
      break;
    }
  }
  const next = args.offset + page.length;
  return JSON.stringify({
    mode: args.mode,
    ...(backend === undefined ? {} : { backend }),
    offset: args.offset,
    limit: args.limit,
    total: records.length,
    hasMore: next < records.length,
    nextOffset: next < records.length ? next : null,
    records: page,
    ...(truncated ? { truncated: true, totalIsExact: !captureTruncated } : {}),
  });
};

const createSearchTool = (input: Parameters<ToolFactory>[0]): Tool => {
  if (input.processExecutor === undefined) {
    throw new Error('search requires the managed process executor');
  }
  return {
    name: 'search',
    description:
      'Search the workspace using paths (file listing), entries (directory listing with type, size, and modification time), files (text files whose contents match), content (path, line number, and matching text), or count (occurrences as matchCount). Content searches exclude database files and NUL-containing binary blobs. Use bash, SQL, or run_typescript for database/blob investigation. Hidden, ignored, and dependency text files are included. File and directory symlinks are followed; a directory cycle is visited only once on its current traversal path. entries reports symlinks without following symlinked directories. Optional glob is a Henji path filter, not an rg argument: without a slash it matches a basename at any depth; with a slash it matches the workspace-relative path. * matches within a component, ** crosses components, and ? matches one character. A leading ! is not an exclusion. files/content/count use rg when available and otherwise grep; regex syntax follows the backend. Count counts non-overlapping matches (rg includes zero-width matches, grep only non-empty matches) and ignores offset/limit. Other modes page with offset, limit, hasMore, and nextOffset; default limit is 100. Search output capture stops at 8 MiB; result JSON is limited to 1 MiB, with oversized matching text cut to a prefix. truncated:true marks partial results; totalIsExact:false means total is only the collected line count. A truncated count is a partial matchCount. hasMore/nextOffset only page the collected records; narrow path/glob/pattern to obtain results omitted by capture limits.',
    inputSchema: searchSchema,
    promptGuidelines: [
      'Prefer search over bash find, grep, or rg for listing, locating, and counting workspace paths and content; use the entries mode when file type, size, or modification time matters.',
      'Choose the smallest relevant path/glob for the question. glob is a Henji include filter; leading ! exclusions are not supported. Refine the scope when truncated is true; do not treat a partial count or totalIsExact:false as the full total.',
    ],
    async execute(argumentsValue, context) {
      const args = parseArguments(argumentsValue);
      const root = await Deno.realPath(input.workspace.root);
      if (args.mode === 'entries') {
        const entries = await enumerateEntries(
          root,
          args.path,
          args.depth ?? 1,
          context?.signal,
        );
        return pagePayload(args, filterEntries(entries, args.glob), undefined);
      }
      const candidates = filterFiles(
        root,
        await enumerateFiles(root, args.path, context?.signal),
        args.glob,
      );
      const files = args.mode === 'paths'
        ? candidates
        : await textFiles(candidates, context?.signal);
      if (args.mode === 'count') {
        return JSON.stringify(
          await countMatches(args, root, files, input.processExecutor!, context?.signal),
        );
      }
      const result = await search(args, root, files, input.processExecutor!, context?.signal);
      return pagePayload(args, result.records, result.backend, result.truncated);
    },
  };
};

const factory: ToolFactory = (input) => createSearchTool(input);

export default factory;
