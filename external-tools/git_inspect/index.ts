import {
  CancellationCleanupError,
  type ToolFactory,
  ToolInputError,
  TurnCancelledError,
} from '@henji/tool';
import type { JsonValue, ProcessOperation, Tool, ToolContext } from '@henji/tool';
import { resolve } from 'node:path';
import { GIT_EXECUTABLE, GIT_LANG, GIT_LC_ALL, GIT_PATH } from './settings.ts';

type Operation = 'status' | 'diff' | 'log' | 'show';

interface ProcessStatus {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface ProcessResult<Output> {
  readonly stdout: Output;
  readonly stderr: Uint8Array;
  readonly status: ProcessStatus;
}

interface InspectArguments {
  readonly op: Operation;
  readonly paths?: readonly string[];
  readonly rev?: string;
  readonly staged?: boolean;
  readonly stat?: boolean;
  readonly context?: number;
  readonly offset: number;
  readonly limit: number;
}

interface InspectPayload {
  readonly op: Operation;
  readonly exitCode: number | null;
  readonly offset: number;
  readonly limit: number;
  readonly totalLines: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
  readonly truncated?: true;
  readonly stderr?: string;
  readonly text: string;
}

const OPERATIONS: readonly Operation[] = Object.freeze(['status', 'diff', 'log', 'show']);
const FIELDS = Object.freeze(
  [
    'op',
    'paths',
    'rev',
    'staged',
    'stat',
    'context',
    'offset',
    'limit',
  ] as const,
);
const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 2_000;
const DEFAULT_LOG_COMMITS = 20;
const MAX_LOG_COMMITS = 200;
/** Bound one call's captured output; larger diffs stay readable through offset/limit. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const REVISION = /^(?:HEAD(?:~\d+)?|[0-9a-f]{7,40})$/;
const decoder = new TextDecoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const relativePath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolInputError('paths must contain non-empty strings');
  }
  if (value.startsWith('/') || value.split('/').includes('..')) {
    throw new ToolInputError('paths must stay within the workspace');
  }
  return value;
};

const integer = (
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum ||
    value > maximum
  ) {
    throw new ToolInputError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
};

const parseArguments = (value: JsonValue): InspectArguments => {
  if (!isRecord(value)) throw new ToolInputError('expected an object with an op field');
  for (const key of Object.keys(value)) {
    if (!FIELDS.includes(key as typeof FIELDS[number])) {
      throw new ToolInputError(`unsupported field: ${key}`);
    }
  }
  const op = value.op;
  if (typeof op !== 'string' || !OPERATIONS.includes(op as Operation)) {
    throw new ToolInputError(`op must be one of ${OPERATIONS.join(', ')}`);
  }
  const operation = op as Operation;
  const paths = value.paths === undefined
    ? undefined
    : (Array.isArray(value.paths) && value.paths.length > 0
      ? Object.freeze(value.paths.map(relativePath))
      : (() => {
        throw new ToolInputError('paths must be a non-empty array of strings');
      })());
  const rev = value.rev === undefined ? undefined : (() => {
    if (typeof value.rev !== 'string' || !REVISION.test(value.rev)) {
      throw new ToolInputError('rev must be HEAD, HEAD~N, or a commit hash');
    }
    return value.rev;
  })();
  const staged = value.staged === undefined ? undefined : (() => {
    if (typeof value.staged !== 'boolean') throw new ToolInputError('staged must be a boolean');
    if (operation !== 'diff') throw new ToolInputError('staged is only supported for op "diff"');
    return value.staged;
  })();
  const stat = value.stat === undefined ? undefined : (() => {
    if (typeof value.stat !== 'boolean') throw new ToolInputError('stat must be a boolean');
    if (operation !== 'diff' && operation !== 'show') {
      throw new ToolInputError('stat is only supported for op "diff" and "show"');
    }
    return value.stat;
  })();
  const context = value.context === undefined ? undefined : (() => {
    if (operation !== 'diff') throw new ToolInputError('context is only supported for op "diff"');
    return integer(value.context, 'context', 0, 10);
  })();
  const offset = value.offset === undefined ? 0 : integer(value.offset, 'offset', 0, 1_000_000);
  const limit = operation === 'log'
    ? (value.limit === undefined
      ? DEFAULT_LOG_COMMITS
      : integer(value.limit, 'limit', 1, MAX_LOG_COMMITS))
    : (value.limit === undefined
      ? DEFAULT_LINE_LIMIT
      : integer(value.limit, 'limit', 1, MAX_LINE_LIMIT));
  if (operation === 'show' && rev === undefined) {
    throw new ToolInputError('rev is required for op "show"');
  }
  return {
    op: operation,
    ...(paths === undefined ? {} : { paths }),
    ...(rev === undefined ? {} : { rev }),
    ...(staged === undefined ? {} : { staged }),
    ...(stat === undefined ? {} : { stat }),
    ...(context === undefined ? {} : { context }),
    offset,
    limit,
  };
};

const inspectSchema = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...OPERATIONS],
      description:
        'status: porcelain worktree state; diff: worktree, index with staged, or a revision; log: oneline history; show: one revision.',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Workspace-relative paths or globs limiting the operation.',
    },
    rev: {
      type: 'string',
      description: 'HEAD, HEAD~N, or a commit hash. Required for show; optional for diff and log.',
    },
    staged: { type: 'boolean', description: 'diff only: compare the index (git diff --cached).' },
    stat: {
      type: 'boolean',
      description: 'diff and show: return the diffstat instead of the patch.',
    },
    context: {
      type: 'integer',
      minimum: 0,
      maximum: 10,
      description: 'diff only: patch context lines; defaults to 3.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'log: commits to skip; status, diff, and show: output lines to skip.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_LINE_LIMIT,
      description:
        `log: commits to return (default ${DEFAULT_LOG_COMMITS}); status, diff, and show: output lines (default ${DEFAULT_LINE_LIMIT}).`,
    },
  },
  required: ['op'],
  additionalProperties: false,
} as const;

const findExecutable = async (name: string): Promise<string | undefined> => {
  for (const directory of GIT_PATH.split(':')) {
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

const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = maxBytes - length;
      if (result.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(result.value.slice(0, remaining));
        length += Math.max(0, remaining);
        truncated = true;
        continue;
      }
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
  return { bytes: output, truncated };
};

const runGit = async (
  executor: NonNullable<Parameters<ToolFactory>[0]['processExecutor']>,
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ProcessResult<{ readonly bytes: Uint8Array; readonly truncated: boolean }>> => {
  if (signal?.aborted) throw new TurnCancelledError();
  const operation: ProcessOperation = executor.start({
    executable,
    args,
    cwd,
    env: {
      PATH: GIT_PATH,
      LANG: GIT_LANG,
      LC_ALL: GIT_LC_ALL,
      GIT_PAGER: 'cat',
      // Read-only inspection must not refresh or lock the worktree index.
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  const completion = Promise.all([
    readBounded(operation.stdout, MAX_CAPTURE_BYTES),
    readBounded(operation.stderr, MAX_STDERR_BYTES),
    operation.status,
    operation.closed,
  ]).then(([stdout, stderr, status]) => ({ stdout, stderr: stderr.bytes, status }));
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
  let result:
    | ProcessResult<{ readonly bytes: Uint8Array; readonly truncated: boolean }>
    | undefined;
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

const buildArgs = (args: InspectArguments): string[] => {
  const global = ['--no-pager'];
  const paths = args.paths === undefined ? [] : ['--', ...args.paths];
  switch (args.op) {
    case 'status':
      return [...global, 'status', '--porcelain=v1', '--branch', ...paths];
    case 'log': {
      const command = [
        ...global,
        'log',
        '--no-color',
        '--oneline',
        `--skip=${args.offset}`,
        '-n',
        String(args.limit),
      ];
      if (args.rev !== undefined) command.push(args.rev);
      return [...command, ...paths];
    }
    case 'diff': {
      const command = [...global, 'diff', '--no-color', '--no-ext-diff', '--no-textconv'];
      if (args.staged === true) command.push('--cached');
      if (args.stat === true) command.push('--stat');
      else command.push(`--unified=${args.context ?? 3}`);
      if (args.rev !== undefined) command.push(args.rev);
      return [...command, ...paths];
    }
    case 'show': {
      const command = [
        ...global,
        'show',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        ...(args.stat === true ? ['--stat'] : []),
        args.rev!,
      ];
      return [...command, ...paths];
    }
  }
};

const splitLines = (text: string): string[] => {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const firstLine = (text: string): string => text.split('\n', 1)[0]?.trim() ?? '';

const payloadFor = (
  args: InspectArguments,
  result: ProcessResult<{ readonly bytes: Uint8Array; readonly truncated: boolean }>,
): InspectPayload => {
  const stdout = decoder.decode(result.stdout.bytes);
  const stderr = decoder.decode(result.stderr);
  const lines = splitLines(stdout);
  if (args.op === 'log') {
    const text = lines.join('\n');
    return {
      op: args.op,
      exitCode: result.status.exitCode,
      offset: args.offset,
      limit: args.limit,
      totalLines: lines.length,
      hasMore: false,
      nextOffset: null,
      ...(result.stdout.truncated ? { truncated: true as const } : {}),
      ...(stderr.length === 0 ? {} : { stderr }),
      text,
    };
  }
  const start = Math.min(args.offset, lines.length);
  const selected = lines.slice(start, start + args.limit);
  const next = start + selected.length;
  const hasMore = next < lines.length || result.stdout.truncated;
  return {
    op: args.op,
    exitCode: result.status.exitCode,
    offset: args.offset,
    limit: args.limit,
    totalLines: lines.length,
    hasMore,
    nextOffset: hasMore ? next : null,
    ...(result.stdout.truncated ? { truncated: true as const } : {}),
    ...(stderr.length === 0 ? {} : { stderr }),
    text: selected.join('\n'),
  };
};

const createGitInspectTool = (input: Parameters<ToolFactory>[0]): Tool => {
  if (input.processExecutor === undefined) {
    throw new Error('git_inspect requires the managed process executor');
  }
  const executor = input.processExecutor;
  return {
    name: 'git_inspect',
    description:
      'Use this tool instead of bash for workspace git status, git diff, git log, and git show. Examples: {"op":"status"}, {"op":"diff"} for unstaged changes, {"op":"diff","staged":true} for git diff --cached, {"op":"diff","stat":true} for git diff --stat, {"op":"diff","paths":["src"]} to limit paths, {"op":"log"}, and {"op":"show","rev":"HEAD"}. status returns porcelain worktree state, diff compares the worktree, staged index, or a revision, log returns oneline history, and show displays one revision. Paths are workspace-relative and limit the operation; revisions accept HEAD, HEAD~N, or a commit hash. Output is paged with offset and limit: for log they select commits, otherwise output lines. The tool never writes to the repository, index, or working tree, and it fails with a distinct error when git or the repository is unavailable.',
    inputSchema: inspectSchema,
    promptGuidelines: Object.freeze([
      'Use git_inspect for supported workspace Git status, diff, log, and show operations; do not run these operations through bash. Use op:"diff" for git diff, add staged:true for git diff --cached, or stat:true for git diff --stat. Use paths to scope a diff and offset/limit to page it without shell filters.',
    ]),
    async execute(argumentsValue, context?: ToolContext) {
      const args = parseArguments(argumentsValue);
      const executable = await findExecutable(GIT_EXECUTABLE);
      if (executable === undefined) {
        throw new Error(
          `git_inspect could not find ${GIT_EXECUTABLE} in its PATH (${GIT_PATH})`,
        );
      }
      const result = await runGit(
        executor,
        executable,
        buildArgs(args),
        input.workspace.root,
        context?.signal,
      );
      const stderr = decoder.decode(result.stderr);
      if (result.status.exitCode !== 0) {
        if (stderr.includes('not a git repository')) {
          throw new Error('git_inspect: the workspace is not a git repository');
        }
        const detail = firstLine(stderr);
        throw new Error(
          `git_inspect ${args.op} failed with exit code ${result.status.exitCode}${
            detail.length === 0 ? '' : `: ${detail}`
          }`,
        );
      }
      return JSON.stringify(payloadFor(args, result));
    },
  };
};

const factory: ToolFactory = (input) => createGitInspectTool(input);

export default factory;
