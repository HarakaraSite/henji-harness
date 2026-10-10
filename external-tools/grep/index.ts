import {
  CancellationCleanupError,
  type JsonValue,
  type ProcessOperation,
  type Tool,
  type ToolFactory,
  ToolInputError,
  type ToolPathPolicy,
  TurnCancelledError,
} from '@henji/tool';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import {
  GREP_EXECUTABLE,
  GREP_LANG,
  GREP_LC_ALL,
  GREP_PATH,
  GREP_RESULT_BYTES,
  GREP_STDERR_BYTES,
  RIPGREP_EXECUTABLE,
} from './settings.ts';

type Backend = 'rg' | 'grep';
type OutputMode = 'lines' | 'files';
type RecordKind = 'match' | 'context';

export interface GrepToolSettings {
  readonly PATH: string;
  readonly LANG: string;
  readonly LC_ALL: string;
  readonly rgExecutable: string;
  readonly grepExecutable: string;
  readonly resultBytes: number;
  readonly stderrBytes: number;
}

interface GrepArguments {
  readonly pattern: string;
  readonly path: string;
  readonly patternKind: 'regex' | 'literal';
  readonly caseSensitive: boolean;
  readonly output: OutputMode;
  readonly context: number;
  readonly glob: readonly string[];
  readonly includeIgnored: boolean;
  readonly limit: number;
}

interface SelectedBackend {
  readonly backend: Backend;
  readonly executable: string;
}

interface ManagedResult<Output> {
  readonly status: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
  readonly stdout: Output;
  readonly stderr: Uint8Array;
}

interface LineRecord {
  readonly [key: string]: JsonValue;
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly kind: RecordKind;
}

interface PendingLine {
  readonly absolutePath: string;
  readonly record: LineRecord;
}

interface KeptRecord {
  readonly value: JsonValue;
  readonly kind: RecordKind | 'file';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_SETTINGS: GrepToolSettings = {
  PATH: GREP_PATH,
  LANG: GREP_LANG,
  LC_ALL: GREP_LC_ALL,
  rgExecutable: RIPGREP_EXECUTABLE,
  grepExecutable: GREP_EXECUTABLE,
  resultBytes: GREP_RESULT_BYTES,
  stderrBytes: GREP_STDERR_BYTES,
};

const grepSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Required. Regex syntax follows the backend named in the tool description.',
    },
    path: {
      type: 'string',
      description:
        'File or directory to search. Relative paths are workspace-based; defaults to the workspace.',
    },
    patternKind: {
      type: 'string',
      enum: ['regex', 'literal'],
      description: 'Defaults to regex. literal searches the pattern as plain text.',
    },
    caseSensitive: {
      type: 'boolean',
      description: 'Defaults to true.',
    },
    output: {
      type: 'string',
      enum: ['lines', 'files'],
      description: 'Defaults to matching lines; files returns each matching path once.',
    },
    context: {
      type: 'integer',
      minimum: 0,
      description: 'Number of surrounding lines on each side; defaults to 0.',
    },
    glob: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Ordered backend globs. With rg, later patterns override earlier ones and ! excludes. GNU grep accepts positive filename globs; ! exclusions are unavailable.',
    },
    includeIgnored: {
      type: 'boolean',
      description:
        'Defaults to false. rg then respects ignore files; GNU grep does not apply ignore rules.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      description:
        'Maximum matching lines or files returned; defaults to 100. The search and exact total continue to completion.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
} as const;

const isRecord = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseArguments = (value: JsonValue): GrepArguments => {
  if (!isRecord(value)) throw new ToolInputError('grep expects an object');
  const allowed = new Set([
    'pattern',
    'path',
    'patternKind',
    'caseSensitive',
    'output',
    'context',
    'glob',
    'includeIgnored',
    'limit',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ToolInputError('grep received an unknown argument');
  }
  if (typeof value.pattern !== 'string') {
    throw new ToolInputError('pattern is required');
  }
  if (value.path !== undefined && typeof value.path !== 'string') {
    throw new ToolInputError('path must be a string');
  }
  if (
    value.patternKind !== undefined && value.patternKind !== 'regex' &&
    value.patternKind !== 'literal'
  ) {
    throw new ToolInputError('patternKind must be regex or literal');
  }
  if (
    value.caseSensitive !== undefined &&
    typeof value.caseSensitive !== 'boolean'
  ) {
    throw new ToolInputError('caseSensitive must be a boolean');
  }
  if (
    value.output !== undefined && value.output !== 'lines' &&
    value.output !== 'files'
  ) {
    throw new ToolInputError('output must be lines or files');
  }
  if (
    value.context !== undefined &&
    (typeof value.context !== 'number' ||
      !Number.isSafeInteger(value.context) || value.context < 0)
  ) throw new ToolInputError('context must be a non-negative safe integer');
  if (
    value.glob !== undefined &&
    (!Array.isArray(value.glob) ||
      value.glob.some((item) => typeof item !== 'string'))
  ) throw new ToolInputError('glob must be an array of strings');
  if (
    value.includeIgnored !== undefined &&
    typeof value.includeIgnored !== 'boolean'
  ) {
    throw new ToolInputError('includeIgnored must be a boolean');
  }
  if (
    value.limit !== undefined &&
    (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) ||
      value.limit < 1)
  ) throw new ToolInputError('limit must be a positive safe integer');

  return {
    pattern: value.pattern,
    path: typeof value.path === 'string' ? value.path : '.',
    patternKind: value.patternKind === 'literal' ? 'literal' : 'regex',
    caseSensitive: value.caseSensitive !== false,
    output: value.output === 'files' ? 'files' : 'lines',
    context: typeof value.context === 'number' ? value.context : 0,
    glob: Array.isArray(value.glob) ? value.glob as string[] : [],
    includeIgnored: value.includeIgnored === true,
    limit: typeof value.limit === 'number' ? value.limit : 100,
  };
};

const workspaceRelative = (workspaceRoot: string, target: string): string =>
  relative(workspaceRoot, target).split(sep).join('/');

const checkCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new TurnCancelledError();
};

const findExecutable = async (
  name: string,
  pathValue: string,
): Promise<string | undefined> => {
  for (const directory of pathValue.split(':')) {
    if (directory.length === 0) continue;
    const candidate = resolve(directory, name);
    try {
      const info = await Deno.stat(candidate);
      if (info.isFile && info.mode !== null && (info.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return undefined;
};

const selectBackend = async (
  settings: GrepToolSettings,
): Promise<SelectedBackend> => {
  const rg = await findExecutable(settings.rgExecutable, settings.PATH);
  if (rg !== undefined) return { backend: 'rg', executable: rg };
  const grep = await findExecutable(settings.grepExecutable, settings.PATH);
  if (grep !== undefined) return { backend: 'grep', executable: grep };
  throw new Error(
    `grep could not find ${settings.rgExecutable} or ${settings.grepExecutable} in its PATH`,
  );
};

const readDiagnostic = async (
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = maximum - length;
      if (remaining > 0) {
        const chunk = item.value.subarray(0, remaining);
        chunks.push(chunk);
        length += chunk.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const runManaged = async <Output>(input: {
  readonly executor: NonNullable<Parameters<ToolFactory>[0]['processExecutor']>;
  readonly command: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
  };
  readonly settings: GrepToolSettings;
  readonly signal?: AbortSignal;
  readonly readStdout: (stream: ReadableStream<Uint8Array>) => Promise<Output>;
}): Promise<ManagedResult<Output>> => {
  checkCancelled(input.signal);
  const operation: ProcessOperation = input.executor.start({
    ...input.command,
    env: {
      PATH: input.settings.PATH,
      LANG: input.settings.LANG,
      LC_ALL: input.settings.LC_ALL,
    },
  });
  const completion = Promise.all([
    input.readStdout(operation.stdout),
    readDiagnostic(operation.stderr, input.settings.stderrBytes),
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
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
  });

  let result: Awaited<typeof completion> | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const outcome = await Promise.race([completion, cancelled]);
    if (outcome === 'cancelled' || input.signal?.aborted) {
      let cleanupFailed = false;
      try {
        await operation.stop();
      } catch {
        cleanupFailed = true;
      }
      const settled = await Promise.allSettled([completion]);
      try {
        await release();
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed || settled[0]?.status === 'rejected') {
        throw new CancellationCleanupError();
      }
      throw new TurnCancelledError();
    }
    result = outcome;
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (onAbort !== undefined) {
    input.signal?.removeEventListener('abort', onAbort);
  }
  if (failed) {
    try {
      await operation.stop();
    } catch {
      // Preserve the backend or stream failure that caused cleanup.
    }
    await Promise.allSettled([completion]);
  }
  try {
    await release();
  } catch (error) {
    if (input.signal?.aborted) {
      failed = true;
      failure = new CancellationCleanupError();
    } else if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return {
    stdout: result!.stdout,
    stderr: result!.stderr,
    status: result!.status,
  };
};

const escapeGlobPath = (value: string): string => {
  const escaped = [...value].map((character) =>
    '\\*?[]{}'.includes(character) ? `\\${character}` : character
  ).join('');
  return escaped;
};

const excludedPathGlobs = (relativePath: string): readonly string[] => {
  const escaped = escapeGlobPath(relativePath);
  return [`!/${escaped}`, `!/${escaped}/**`];
};

const collectAccessExclusions = async (
  scope: string,
  pathPolicy: ToolPathPolicy,
  signal?: AbortSignal,
): Promise<string[]> => {
  const info = await Deno.stat(scope);
  if (info.isFile) return [];
  if (!info.isDirectory) {
    throw new ToolInputError('path must name a file or directory');
  }
  const excluded: string[] = [];
  const ancestors = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    checkCancelled(signal);
    const realDirectory = await Deno.realPath(directory);
    if (ancestors.has(realDirectory)) return;
    ancestors.add(realDirectory);
    try {
      for await (const entry of Deno.readDir(directory)) {
        checkCancelled(signal);
        const child = resolve(directory, entry.name);
        if (!await pathPolicy.allows(child)) {
          excluded.push(
            ...excludedPathGlobs(relative(scope, child).split(sep).join('/')),
          );
          continue;
        }
        let childInfo: Deno.FileInfo;
        try {
          childInfo = await Deno.stat(child);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        if (childInfo.isDirectory) await visit(child);
      }
    } finally {
      ancestors.delete(realDirectory);
    }
  };
  await visit(scope);
  return excluded;
};

const enumerateAllowedFiles = async (
  scope: string,
  pathPolicy: ToolPathPolicy,
  signal?: AbortSignal,
): Promise<string[]> => {
  const info = await Deno.stat(scope);
  if (info.isFile) return [scope];
  if (!info.isDirectory) {
    throw new ToolInputError('path must name a file or directory');
  }
  const files: string[] = [];
  const ancestors = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    checkCancelled(signal);
    const realDirectory = await Deno.realPath(directory);
    if (ancestors.has(realDirectory)) return;
    ancestors.add(realDirectory);
    try {
      for await (const entry of Deno.readDir(directory)) {
        checkCancelled(signal);
        const child = resolve(directory, entry.name);
        if (!await pathPolicy.allows(child)) continue;
        let childInfo: Deno.FileInfo;
        try {
          childInfo = await Deno.stat(child);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        if (childInfo.isDirectory) await visit(child);
        else if (childInfo.isFile) files.push(child);
      }
    } finally {
      ancestors.delete(realDirectory);
    }
  };
  await visit(scope);
  files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return files;
};

const chunksOf = (files: readonly string[]): string[][] => {
  const chunks: string[][] = [];
  let current: string[] = [];
  let argumentBytes = 0;
  for (const file of files) {
    const bytes = encoder.encode(file).byteLength + 1;
    if (
      current.length > 0 &&
      (current.length >= 128 || argumentBytes + bytes > 48 * 1024)
    ) {
      chunks.push(current);
      current = [];
      argumentBytes = 0;
    }
    current.push(file);
    argumentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

class ResultAccumulator {
  readonly #records: KeptRecord[] = [];
  readonly #files = new Set<string>();
  readonly #pendingContexts: PendingLine[] = [];
  #currentPath: string | undefined;
  #lastKeptMatch: LineRecord | undefined;
  #total = 0;
  #selected = 0;
  #returnedMatches = 0;
  #returnedContexts = 0;
  #omittedContexts = 0;
  #recordBytes = 0;

  constructor(
    readonly input: GrepArguments,
    readonly backend: Backend,
    readonly workspaceRoot: string,
    readonly pathPolicy: ToolPathPolicy,
    readonly ignoreApplied: boolean,
    readonly maximumBytes: number,
  ) {}

  get total(): number {
    return this.#total;
  }

  async matchedFile(absolutePath: string): Promise<void> {
    if (!await this.pathPolicy.allows(absolutePath)) return;
    const path = workspaceRelative(this.workspaceRoot, absolutePath);
    if (this.#files.has(path)) return;
    this.#files.add(path);
    this.#total += 1;
    if (this.#total > this.input.limit) return;
    this.#selected += 1;
    if (this.#append({ path }, 'file')) this.#returnedMatches += 1;
  }

  async matchedLine(
    absolutePath: string,
    line: number,
    text: string,
    kind: RecordKind,
  ): Promise<void> {
    if (!await this.pathPolicy.allows(absolutePath)) return;
    if (this.input.output === 'files') {
      if (kind === 'match') await this.matchedFile(absolutePath);
      return;
    }
    const path = workspaceRelative(this.workspaceRoot, absolutePath);
    if (this.#currentPath !== path) {
      await this.#flushContexts(true);
      this.#pendingContexts.length = 0;
      this.#currentPath = path;
      this.#lastKeptMatch = undefined;
    }
    const record: LineRecord = { path, line, text, kind };
    if (kind === 'context') {
      if (this.#selected < this.input.limit) {
        if (this.#lastKeptMatch === undefined) {
          this.#pendingContexts.push({ absolutePath, record });
          while (this.#pendingContexts.length > this.input.context) {
            this.#pendingContexts.shift();
          }
        } else {
          this.#pendingContexts.push({ absolutePath, record });
        }
      } else if (
        this.#lastKeptMatch !== undefined &&
        line <= this.#lastKeptMatch.line + this.input.context
      ) {
        this.#pendingContexts.push({ absolutePath, record });
      }
      return;
    }

    this.#total += 1;
    if (this.#total <= this.input.limit) {
      this.#selected += 1;
      const matchBytes = encoder.encode(JSON.stringify(record)).byteLength;
      await this.#flushContexts(false, matchBytes + 1);
      if (this.#append(record, 'match')) {
        this.#returnedMatches += 1;
        this.#lastKeptMatch = record;
      }
    } else {
      await this.#flushContexts(true);
    }
  }

  async finish(): Promise<string> {
    await this.#flushContexts(true);
    let result = this.#payload();
    while (
      encoder.encode(result).byteLength > this.maximumBytes &&
      this.#records.length > 0
    ) {
      const removed = this.#records.pop()!;
      const size = encoder.encode(JSON.stringify(removed.value)).byteLength;
      this.#recordBytes -= size + (this.#records.length > 0 ? 1 : 0);
      if (removed.kind === 'match' || removed.kind === 'file') {
        this.#returnedMatches -= 1;
      } else {
        this.#returnedContexts -= 1;
        this.#omittedContexts += 1;
      }
      result = this.#payload();
    }
    return result;
  }

  #payload(): string {
    const returned = this.#returnedMatches;
    const omittedByLimit = Math.max(0, this.#total - this.input.limit);
    const omittedByResultBytes = Math.max(0, this.#selected - returned);
    return JSON.stringify({
      backend: this.backend,
      ignoreApplied: this.ignoreApplied,
      searchCompleted: true,
      output: this.input.output,
      total: this.#total,
      returned,
      omitted: {
        matches: Math.max(0, this.#total - returned),
        byLimit: omittedByLimit,
        byResultBytes: omittedByResultBytes,
        contexts: this.#omittedContexts,
      },
      contextReturned: this.#returnedContexts,
      records: this.#records.map(({ value }) => value),
    });
  }

  async #flushContexts(
    trailingOnly: boolean,
    reservedBytes = 0,
  ): Promise<void> {
    if (this.#pendingContexts.length === 0) return;
    const pending = this.#pendingContexts.splice(0);
    for (const item of pending) {
      if (trailingOnly) {
        const last = this.#lastKeptMatch;
        if (
          last === undefined || item.record.path !== last.path ||
          item.record.line > last.line + this.input.context
        ) {
          this.#omittedContexts += 1;
          continue;
        }
      }
      if (await this.pathPolicy.allows(item.absolutePath)) {
        if (this.#append(item.record, 'context', reservedBytes)) {
          this.#returnedContexts += 1;
        } else this.#omittedContexts += 1;
      }
    }
  }

  #append(
    value: JsonValue,
    kind: KeptRecord['kind'],
    reservedBytes = 0,
  ): boolean {
    const size = encoder.encode(JSON.stringify(value)).byteLength;
    const fits = (): boolean =>
      this.#recordBytes + (this.#records.length === 0 ? 0 : 1) + size +
          reservedBytes <= this.maximumBytes - 2_048;
    if (!fits() && kind !== 'context') {
      const evictions: number[] = [];
      let projectedBytes = this.#recordBytes;
      let projectedCount = this.#records.length;
      for (let index = 0; index < this.#records.length; index += 1) {
        const record = this.#records[index]!;
        if (record.kind !== 'context') continue;
        const contextBytes = encoder.encode(JSON.stringify(record.value))
          .byteLength;
        projectedBytes -= contextBytes + (projectedCount > 1 ? 1 : 0);
        projectedCount -= 1;
        evictions.push(index);
        if (
          projectedBytes + (projectedCount === 0 ? 0 : 1) + size +
              reservedBytes <= this.maximumBytes - 2_048
        ) {
          for (const evictIndex of evictions.toReversed()) {
            this.#records.splice(evictIndex, 1);
          }
          this.#recordBytes = projectedBytes;
          this.#returnedContexts -= evictions.length;
          this.#omittedContexts += evictions.length;
          break;
        }
      }
    }
    // Keep room for the result envelope and exact totals; finish() checks the final JSON size.
    if (!fits()) return false;
    this.#records.push({ value, kind });
    this.#recordBytes += (this.#records.length === 1 ? 0 : 1) + size;
    return true;
  }
}

const base64Bytes = (value: string): Uint8Array => {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const rgPath = (value: unknown, workspaceRoot: string): string | undefined => {
  if (!isRecord(value as JsonValue)) return undefined;
  const path = value as Record<string, unknown>;
  const raw = typeof path.text === 'string'
    ? path.text
    : typeof path.bytes === 'string'
    ? decoder.decode(base64Bytes(path.bytes))
    : undefined;
  return raw === undefined ? undefined : resolve(workspaceRoot, raw);
};

const rgText = (value: unknown): string | undefined => {
  if (!isRecord(value as JsonValue)) return undefined;
  const line = value as Record<string, unknown>;
  const raw = typeof line.text === 'string'
    ? line.text
    : typeof line.bytes === 'string'
    ? decoder.decode(base64Bytes(line.bytes))
    : undefined;
  if (raw === undefined) return undefined;
  return raw.endsWith('\n') ? raw.slice(0, -1).replace(/\r$/u, '') : raw;
};

const readRg = async (
  stream: ReadableStream<Uint8Array>,
  searchRoot: string,
  accumulator: ResultAccumulator,
): Promise<void> => {
  const reader = stream.getReader();
  let pending = new Uint8Array();
  let currentPath: string | undefined;
  let currentAllowed = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const joined = new Uint8Array(pending.byteLength + item.value.byteLength);
      joined.set(pending);
      joined.set(item.value, pending.byteLength);
      let start = 0;
      for (let index = 0; index < joined.byteLength; index += 1) {
        if (joined[index] !== 0x0a) continue;
        const line = decoder.decode(joined.subarray(start, index));
        start = index + 1;
        if (line.length === 0) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          throw new ToolInputError('rg returned an invalid JSON event');
        }
        if (
          !isRecord(event as JsonValue) ||
          !isRecord((event as Record<string, JsonValue>).data)
        ) {
          continue;
        }
        const eventRecord = event as Record<string, unknown>;
        const eventType = eventRecord.type;
        if (eventType !== 'match' && eventType !== 'context') continue;
        const data = eventRecord.data as Record<string, unknown>;
        const absolutePath = rgPath(data.path, searchRoot);
        const lineNumber = data.line_number;
        const text = rgText(data.lines);
        if (
          absolutePath === undefined || typeof lineNumber !== 'number' ||
          !Number.isSafeInteger(lineNumber) || lineNumber < 1 ||
          text === undefined
        ) throw new ToolInputError('rg returned an invalid line event');
        if (absolutePath !== currentPath) {
          currentPath = absolutePath;
          currentAllowed = await accumulator.pathPolicy.allows(absolutePath);
        }
        if (!currentAllowed) continue;
        await accumulator.matchedLine(
          absolutePath,
          lineNumber,
          text,
          eventType as RecordKind,
        );
      }
      pending = joined.subarray(start).slice();
    }
    if (pending.byteLength > 0) {
      throw new ToolInputError('rg returned an incomplete JSON event');
    }
  } finally {
    reader.releaseLock();
  }
};

const gnuModifiers = (input: GrepArguments): string[] => [
  input.patternKind === 'literal' ? '-F' : '-E',
  ...(input.caseSensitive ? [] : ['-i']),
  '-I',
];

const parseGnuLine = async (
  pathBytes: Uint8Array,
  recordBytes: Uint8Array,
  workspaceRoot: string,
  accumulator: ResultAccumulator,
): Promise<void> => {
  const path = decoder.decode(pathBytes);
  const absolutePath = resolve(workspaceRoot, path);
  if (recordBytes.length === 0) return;
  const separator = recordBytes.findIndex((byte) => byte === 0x3a || byte === 0x2d);
  if (separator <= 0) return;
  const lineText = decoder.decode(recordBytes.subarray(0, separator));
  if (!/^\d+$/u.test(lineText)) return;
  const lineNumber = Number(lineText);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return;
  const textBytes = recordBytes.subarray(separator + 1);
  const text = decoder.decode(
    textBytes.length > 0 && textBytes.at(-1) === 0x0d ? textBytes.subarray(0, -1) : textBytes,
  );
  await accumulator.matchedLine(
    absolutePath,
    lineNumber,
    text,
    recordBytes[separator] === 0x3a ? 'match' : 'context',
  );
};

const readGnuLines = async (
  stream: ReadableStream<Uint8Array>,
  workspaceRoot: string,
  accumulator: ResultAccumulator,
): Promise<void> => {
  const reader = stream.getReader();
  let pathBytes: number[] = [];
  let recordBytes: number[] = [];
  let inRecord = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      for (const byte of item.value) {
        if (!inRecord) {
          if (byte === 0) {
            inRecord = true;
            recordBytes = [];
          } else if (
            byte === 0x0a && pathBytes.length === 2 &&
            pathBytes[0] === 0x2d && pathBytes[1] === 0x2d
          ) {
            // GNU grep separates disjoint context groups with a standalone "--" line.
            pathBytes = [];
          } else {
            pathBytes.push(byte);
          }
        } else if (byte === 0x0a) {
          await parseGnuLine(
            Uint8Array.from(pathBytes),
            Uint8Array.from(recordBytes),
            workspaceRoot,
            accumulator,
          );
          pathBytes = [];
          recordBytes = [];
          inRecord = false;
        } else {
          recordBytes.push(byte);
        }
      }
    }
    if (inRecord && recordBytes.length > 0) {
      await parseGnuLine(
        Uint8Array.from(pathBytes),
        Uint8Array.from(recordBytes),
        workspaceRoot,
        accumulator,
      );
    }
  } finally {
    reader.releaseLock();
  }
};

const readGnuFiles = async (
  stream: ReadableStream<Uint8Array>,
  workspaceRoot: string,
  accumulator: ResultAccumulator,
): Promise<void> => {
  const reader = stream.getReader();
  let pending: number[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      for (const byte of item.value) {
        if (byte !== 0) {
          pending.push(byte);
          continue;
        }
        const path = decoder.decode(Uint8Array.from(pending));
        await accumulator.matchedFile(resolve(workspaceRoot, path));
        pending = [];
      }
    }
    if (pending.length > 0) {
      await accumulator.matchedFile(
        resolve(workspaceRoot, decoder.decode(Uint8Array.from(pending))),
      );
    }
  } finally {
    reader.releaseLock();
  }
};

const checkBackendResult = (
  backend: Backend,
  result: ManagedResult<unknown>,
): void => {
  if (result.status.signal !== null || result.status.exitCode === null) {
    throw new ToolInputError(`${backend} search was interrupted`);
  }
  if (result.status.exitCode === 0 || result.status.exitCode === 1) return;
  const detail = decoder.decode(result.stderr).trim();
  throw new ToolInputError(
    detail.length > 0
      ? `${backend} search failed: ${detail}`
      : `${backend} search failed with exit code ${result.status.exitCode}`,
  );
};

const rgCommandArguments = (
  input: GrepArguments,
  accessExclusions: readonly string[],
  scope: string,
): string[] => [
  '--json',
  '--hidden',
  '--follow',
  ...(input.includeIgnored ? ['--no-ignore'] : []),
  ...(input.patternKind === 'literal' ? ['--fixed-strings'] : []),
  ...(input.caseSensitive ? [] : ['--ignore-case']),
  ...(input.output === 'lines' && input.context > 0 ? ['-C', String(input.context)] : []),
  ...input.glob.flatMap((glob) => ['-g', glob]),
  ...accessExclusions.flatMap((glob) => ['-g', glob]),
  '-e',
  input.pattern,
  '--',
  scope,
];

const rgSearchRoot = async (
  scope: string,
): Promise<{ readonly cwd: string; readonly operand: string }> => {
  const info = await Deno.stat(scope);
  if (info.isDirectory) return { cwd: scope, operand: '.' };
  return { cwd: dirname(scope), operand: basename(scope) };
};

const runRg = async (input: {
  readonly args: GrepArguments;
  readonly selected: SelectedBackend;
  readonly workspaceRoot: string;
  readonly scope: string;
  readonly pathPolicy: ToolPathPolicy;
  readonly executor: NonNullable<Parameters<ToolFactory>[0]['processExecutor']>;
  readonly settings: GrepToolSettings;
  readonly signal?: AbortSignal;
}): Promise<string> => {
  const searchRoot = await rgSearchRoot(input.scope);
  const accessExclusions = await collectAccessExclusions(
    input.scope,
    input.pathPolicy,
    input.signal,
  );
  const accumulator = new ResultAccumulator(
    input.args,
    'rg',
    input.workspaceRoot,
    input.pathPolicy,
    !input.args.includeIgnored,
    input.settings.resultBytes,
  );
  const result = await runManaged({
    executor: input.executor,
    command: {
      executable: input.selected.executable,
      args: rgCommandArguments(
        input.args,
        accessExclusions,
        searchRoot.operand,
      ),
      cwd: searchRoot.cwd,
    },
    settings: input.settings,
    signal: input.signal,
    readStdout: (stream) => readRg(stream, searchRoot.cwd, accumulator),
  });
  checkBackendResult('rg', result);
  return await accumulator.finish();
};

const runGnuGrep = async (input: {
  readonly args: GrepArguments;
  readonly selected: SelectedBackend;
  readonly workspaceRoot: string;
  readonly scope: string;
  readonly pathPolicy: ToolPathPolicy;
  readonly executor: NonNullable<Parameters<ToolFactory>[0]['processExecutor']>;
  readonly settings: GrepToolSettings;
  readonly signal?: AbortSignal;
}): Promise<string> => {
  if (input.args.glob.some((glob) => glob.startsWith('!'))) {
    throw new ToolInputError('grep backend does not support ! glob exclusions');
  }
  const files = await enumerateAllowedFiles(
    input.scope,
    input.pathPolicy,
    input.signal,
  );
  const accumulator = new ResultAccumulator(
    input.args,
    'grep',
    input.workspaceRoot,
    input.pathPolicy,
    false,
    input.settings.resultBytes,
  );
  const batches = chunksOf(files);
  // An empty argument list lets GNU grep validate the pattern against empty stdin without
  // opening a path outside the policy scope.
  if (batches.length === 0) batches.push([]);
  for (const batch of batches) {
    checkCancelled(input.signal);
    const args = [
      ...(input.args.output === 'files' ? ['-l', '-Z'] : ['-H', '-n', '-Z']),
      ...(input.args.output === 'lines' && input.args.context > 0
        ? ['-C', String(input.args.context)]
        : []),
      ...gnuModifiers(input.args),
      ...input.args.glob.map((glob) => `--include=${glob}`),
      '-e',
      input.args.pattern,
      '--',
      ...batch,
    ];
    const result = await runManaged({
      executor: input.executor,
      command: {
        executable: input.selected.executable,
        args,
        cwd: input.workspaceRoot,
      },
      settings: input.settings,
      signal: input.signal,
      readStdout: input.args.output === 'files'
        ? (stream) => readGnuFiles(stream, input.workspaceRoot, accumulator)
        : (stream) => readGnuLines(stream, input.workspaceRoot, accumulator),
    });
    checkBackendResult('grep', result);
  }
  return await accumulator.finish();
};

const createGrepTool = (
  input: Parameters<ToolFactory>[0],
  selected: SelectedBackend,
  settings: GrepToolSettings,
): Tool => {
  if (input.processExecutor === undefined) {
    throw new Error('grep requires the managed process executor');
  }
  return {
    name: 'grep',
    fileAccess: 'read',
    description: [
      `Search file contents with the selected native backend. Current backend: ${selected.backend}.`,
      `pattern is required. Regex and glob syntax follow ${selected.backend}; literal patterns use fixed-string search. Default path is the workspace, patternKind is regex, caseSensitive is true, output is lines, context is 0, includeIgnored is false, and limit is 100.`,
      selected.backend === 'rg'
        ? 'glob is an ordered array passed to rg -g: later matching patterns override earlier ones, and ! patterns exclude. Hidden files are included; ignore rules are respected unless includeIgnored is true.'
        : 'Positive glob entries use GNU grep filename selection. ! glob exclusions are unsupported. GNU grep does not apply ignore rules; ignoreApplied is false.',
      'The search always completes and counts all matching lines or unique files. limit and the 1 MiB result budget affect returned records only. Context rows are marked kind=context and do not count as matches.',
    ].join('\n\n'),
    inputSchema: grepSchema,
    promptGuidelines: [
      'Use grep for file contents and matching paths. Provide a required pattern, choose the smallest useful path, and use output=files when only matching filenames are needed.',
      `Use the syntax of the backend shown in the tool description (${selected.backend}); the result JSON repeats the backend used.`,
      'The search runs to completion. Read total and omitted in the result; context records do not count as matching lines.',
    ],
    async execute(argumentsValue, context) {
      const args = parseArguments(argumentsValue);
      const workspaceRoot = await Deno.realPath(input.workspace.root);
      const scope = await input.pathPolicy.resolve(args.path, {
        followSymlinks: false,
      });
      await input.pathPolicy.resolve(args.path);
      if (selected.backend === 'rg') {
        return await runRg({
          args,
          selected,
          workspaceRoot,
          scope,
          pathPolicy: input.pathPolicy,
          executor: input.processExecutor!,
          settings,
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
        });
      }
      return await runGnuGrep({
        args,
        selected,
        workspaceRoot,
        scope,
        pathPolicy: input.pathPolicy,
        executor: input.processExecutor!,
        settings,
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      });
    },
  };
};

/** Test and embedding seam; production uses the settings exported by this tool folder. */
export const createGrepToolFactory = (
  settings: GrepToolSettings = DEFAULT_SETTINGS,
): ToolFactory =>
async (input) => {
  const selected = await selectBackend(settings);
  return createGrepTool(input, selected, settings);
};

const factory = createGrepToolFactory();

export default factory;
