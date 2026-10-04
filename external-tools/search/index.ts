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
  SEARCH_LANG,
  SEARCH_LC_ALL,
  SEARCH_PATH,
} from './settings.ts';

type SearchMode = 'paths' | 'files' | 'content' | 'count';
type PatternKind = 'literal' | 'regex';
type Backend = 'rg' | 'grep';
type SearchRecord = string | {
  readonly path: string;
  readonly line: number;
  readonly text: string;
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
}

interface ProcessResult<Output> {
  readonly status: { readonly exitCode: number | null; readonly signal: string | null };
  readonly stdout: Output;
  readonly stderr: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const searchSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['paths', 'files', 'content', 'count'] },
    path: {
      type: 'string',
      description:
        'Workspace file or directory, relative or absolute inside the workspace; defaults to the workspace root.',
    },
    glob: {
      type: 'string',
      description: 'Optional path glob matched against workspace-relative paths.',
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
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new ToolInputError('search received an unknown argument');
  }
  if (
    args.mode !== 'paths' && args.mode !== 'files' && args.mode !== 'content' &&
    args.mode !== 'count'
  ) {
    throw new ToolInputError('mode must be paths, files, content, or count');
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
  if (args.mode !== 'paths' && typeof args.pattern !== 'string') {
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

  return {
    mode: args.mode,
    path: typeof args.path === 'string' ? args.path : '.',
    ...(typeof args.glob === 'string' ? { glob: args.glob } : {}),
    ...(typeof args.pattern === 'string' ? { pattern: args.pattern } : {}),
    patternKind: args.patternKind === 'literal' ? 'literal' : 'regex',
    caseSensitive: args.caseSensitive !== false,
    offset: typeof args.offset === 'number' ? args.offset : 0,
    limit: typeof args.limit === 'number' ? args.limit : 100,
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

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      length += result.value.byteLength;
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
  return output;
};

const countOutputLines = async (stream: ReadableStream<Uint8Array>): Promise<number> => {
  let count = 0;
  for await (const chunk of stream) {
    for (const byte of chunk) if (byte === 0x0a) count += 1;
  }
  return count;
};

const runBackend = async <Output>(
  executor: NonNullable<Parameters<ToolFactory>[0]['processExecutor']>,
  command: { readonly executable: string; readonly args: readonly string[]; readonly cwd: string },
  signal: AbortSignal | undefined,
  readStdout: (stream: ReadableStream<Uint8Array>) => Promise<Output>,
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
  const completion = Promise.all([
    readStdout(operation.stdout),
    readAll(operation.stderr),
    operation.status,
    operation.closed,
  ]).then(([stdout, stderr, status]) => ({ stdout, stderr, status }));
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

const decodeNullRecords = (bytes: Uint8Array): string[] => {
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    records.push(decoder.decode(bytes.subarray(start, index)));
    start = index + 1;
  }
  if (start < bytes.length) records.push(decoder.decode(bytes.subarray(start)));
  return records.filter((record) => record.length > 0);
};

const contentRecords = (bytes: Uint8Array, root: string): SearchRecord[] => {
  const records: SearchRecord[] = [];
  let start = 0;
  while (start < bytes.length) {
    const delimiter = bytes.indexOf(0, start);
    if (delimiter < 0) throw new Error('search backend returned an invalid content record');
    const lineEnd = bytes.indexOf(0x0a, delimiter + 1);
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

const sumFileCounts = (bytes: Uint8Array): number => {
  let count = 0;
  let start = 0;
  while (start < bytes.length) {
    const delimiter = bytes.indexOf(0, start);
    if (delimiter < 0) throw new Error('search backend returned an invalid count record');
    const lineEnd = bytes.indexOf(0x0a, delimiter + 1);
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
): Promise<{ readonly mode: 'count'; readonly backend: Backend; readonly matchCount: number }> => {
  const selected = await selectBackend();
  let matchCount = 0;
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
            '--text',
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
        readAll,
      );
      checkBackendResult(selected.backend, result);
      matchCount += sumFileCounts(result.stdout);
    } else {
      const result = await runBackend(
        executor,
        {
          executable: selected.executable,
          args: ['-a', '-h', '-o', ...flags(input), '-e', input.pattern!, '--', ...batch],
          cwd: root,
        },
        signal,
        countOutputLines,
      );
      checkBackendResult(selected.backend, result);
      matchCount += result.stdout;
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
): Promise<{ readonly records: SearchRecord[]; readonly backend?: Backend }> => {
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
  const pattern = input.pattern!;
  for (const batch of chunksOf(files)) {
    if (signal?.aborted) throw new TurnCancelledError();
    const backendArgs = selected.backend === 'rg'
      ? input.mode === 'files'
        ? [
          '--files-with-matches',
          '--null',
          '--text',
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
          '--text',
          '--no-ignore',
          '--hidden',
          ...flags(input),
          '-e',
          pattern,
          '--',
          ...batch,
        ]
      : input.mode === 'files'
      ? ['-a', '-lZ', ...flags(input), '-e', pattern, '--', ...batch]
      : ['-a', '-n', '-H', '-Z', ...flags(input), '-e', pattern, '--', ...batch];
    const result = await runBackend(
      executor,
      {
        executable: selected.executable,
        args: backendArgs,
        cwd: root,
      },
      signal,
      readAll,
    );
    checkBackendResult(selected.backend, result);
    if (input.mode === 'files') {
      for (const file of decodeNullRecords(result.stdout)) {
        matches.push(workspaceRelative(root, resolve(file)));
      }
    } else matches.push(...contentRecords(result.stdout, root));
  }
  if (input.mode === 'files') {
    (matches as string[]).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  } else {
    (matches as { readonly path: string; readonly line: number; readonly text: string }[])
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : left.line - right.line
      );
  }
  return { records: matches, backend: selected.backend };
};

const createSearchTool = (input: Parameters<ToolFactory>[0]): Tool => {
  if (input.processExecutor === undefined) {
    throw new Error('search requires the managed process executor');
  }
  return {
    name: 'search',
    description:
      'Search the workspace using paths (file listing), files (paths whose contents match), content (path, line number, and matching line), or count (total occurrences as matchCount). Use count to answer how many times a string occurs; content total counts matching lines, so several matches on one line count as one record. Searches include hidden, ignored, and dependency files because Deno enumerates the same explicit file paths for rg and grep. File and directory symlinks are followed; a directory cycle is visited only once on its current traversal path. Optional glob without a slash matches a basename at any depth; a glob with a slash matches the workspace-relative path. * matches within one path component, ** can cross components, and ? matches one character. files/content/count use rg when available and otherwise grep; literal patterns work with both, while regex syntax follows that backend. Count uses non-overlapping native matches; rg includes zero-width regex matches, while grep counts only non-empty matches. Count covers the entire selected scope and ignores offset/limit. Other modes return complete records in pages with offset, limit, hasMore, and nextOffset; the default page is 100 records and limit has no fixed maximum.',
    inputSchema: searchSchema,
    async execute(argumentsValue, context) {
      const args = parseArguments(argumentsValue);
      const root = await Deno.realPath(input.workspace.root);
      const files = filterFiles(
        root,
        await enumerateFiles(root, args.path, context?.signal),
        args.glob,
      );
      if (args.mode === 'count') {
        return JSON.stringify(
          await countMatches(args, root, files, input.processExecutor!, context?.signal),
        );
      }
      const result = await search(args, root, files, input.processExecutor!, context?.signal);
      const page = result.records.slice(args.offset, args.offset + args.limit);
      const next = args.offset + page.length;
      const payload = {
        mode: args.mode,
        ...(result.backend === undefined ? {} : { backend: result.backend }),
        offset: args.offset,
        limit: args.limit,
        total: result.records.length,
        hasMore: next < result.records.length,
        nextOffset: next < result.records.length ? next : null,
        records: page,
      };
      return JSON.stringify(payload);
    },
  };
};

const factory: ToolFactory = (input) => createSearchTool(input);

export default factory;
