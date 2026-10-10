import {
  CancellationCleanupError,
  type JsonValue,
  type Tool,
  type ToolFactory,
  ToolInputError,
  TurnCancelledError,
} from '@henji/tool';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { FIND_SETTINGS } from './settings.ts';

type Settings = typeof FIND_SETTINGS;
const encoder = new TextEncoder();
const globLiteral = (text: string): string => text.replace(/[\\*?\[\]{}]/g, '\\$&');

const executable = async (name: string, path: string): Promise<string | undefined> => {
  const candidates = name.includes('/')
    ? [resolve(name)]
    : path.split(':').map((p) => resolve(p, name));
  for (const candidate of candidates) {
    try {
      const info = await Deno.stat(candidate);
      if (info.isFile && (info.mode === null || (info.mode & 0o111) !== 0)) return candidate;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
};

const insideRepository = async (directory: string): Promise<boolean> => {
  for (let current = directory;; current = dirname(current)) {
    try {
      await Deno.stat(`${current}/.git`);
      return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (dirname(current) === current) return false;
  }
};

const parse = (value: JsonValue) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInputError('find expects an object');
  }
  const args = value as Record<string, JsonValue>;
  const path = args.path ?? '.';
  const pattern = args.pattern ?? '*';
  const limit = args.limit ?? 100;
  const type = args.type ?? 'any';
  const includeIgnored = args.includeIgnored ?? false;
  const exclude = args.exclude ?? [];
  if (typeof path !== 'string' || !path || typeof pattern !== 'string') {
    throw new ToolInputError('path and pattern must be strings; path must not be empty');
  }
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new ToolInputError('limit must be a positive integer');
  }
  if (type !== 'any' && type !== 'file' && type !== 'directory') {
    throw new ToolInputError('type must be any, file, or directory');
  }
  if (
    typeof includeIgnored !== 'boolean' || !Array.isArray(exclude) ||
    exclude.some((p) => typeof p !== 'string')
  ) {
    throw new ToolInputError('includeIgnored must be boolean and exclude must be a string array');
  }
  return { path, pattern, limit, type, includeIgnored, exclude: exclude as string[] };
};

const displayPath = (root: string, path: string): string => {
  const local = relative(root, path);
  return local === '' ? '.' : local === '..' || local.startsWith('../') ? path : local;
};

/** Resolve once so the declaration and every call use the same native backend. */
export const createFindTool = async (
  input: Parameters<ToolFactory>[0],
  settings: Settings = FIND_SETTINGS,
): Promise<Tool> => {
  if (!input.processExecutor) throw new Error('find requires the managed process executor');
  const fd = await executable(settings.fd, settings.path);
  const native = fd ?? await executable(settings.find, settings.path);
  if (!native) throw new Error('find could not find fd or GNU find in its configured PATH');
  const backend = fd ? 'fd' : 'find';
  return {
    name: 'find',
    fileAccess: 'read',
    description: [
      'Find filesystem names using native glob patterns. Current backend: ' + backend + '.',
      'Defaults: path=".", pattern="*", type="any", limit=100. A pattern without / matches basenames at any depth; with / it targets paths rooted at the search directory. Case-sensitive. Dotfiles are included. Glob semantics follow the selected backend, including differences in *, ** and ?; no compatibility conversion is performed.',
      backend === 'fd'
        ? 'fd respects ignore files including .gitignore. includeIgnored=true disables ignore filtering. exclude supplies native fd exclusion globs.'
        : 'GNU find does not apply .gitignore; results report ignoreApplied:false. The exclude option is unsupported and returns an error.',
      'The limit stops traversal after that many allowed matching entries, not after that many candidates. JSON records contain paths; backend, ignoreApplied, returned, searchCompleted and truncationReason describe the actual search. A stopped search has no exact total. Increase limit or narrow path/pattern when truncated. The default allow is /; common-denied paths are excluded.',
    ].join('\n\n'),
    promptGuidelines: [
      'Use find for name/path discovery, grep for file contents, ls for a directory listing/tree, and wc for explicit file statistics.',
      'Current find backend: ' + backend +
      '. Interpret globs according to this backend; do not treat a truncated listing as complete.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Search directory, relative to workspace or absolute; defaults to .',
        },
        pattern: {
          type: 'string',
          description: 'Native glob. Defaults to *. Semantics follow the current backend.',
        },
        type: {
          type: 'string',
          enum: ['any', 'file', 'directory'],
          description: 'Defaults to any entry type.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Stop after matching this many entries; defaults to 100, no fixed maximum.',
        },
        includeIgnored: {
          type: 'boolean',
          description:
            'Disable fd ignore filtering; defaults to false. GNU find never applies ignore filtering.',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Native fd exclusion globs; GNU find fallback returns an error when provided.',
        },
      },
      additionalProperties: false,
    },
    async execute(value, context) {
      const args = parse(value);
      if (backend === 'find' && args.exclude.length > 0) {
        throw new ToolInputError('find backend does not support exclusion globs; backend=find');
      }
      const directory = await input.pathPolicy.resolve(args.path, { followSymlinks: false });
      await input.pathPolicy.resolve(args.path);
      if (!(await Deno.stat(directory)).isDirectory) {
        throw new ToolInputError('find path must be a directory');
      }
      const denied = [
        ...new Set([
          ...input.pathPolicy.deniedPaths,
          ...await input.pathPolicy.canonicalDeniedPaths(),
        ]),
      ];
      const fullPattern = `${globLiteral(directory === '/' ? '' : directory)}/${args.pattern}`;
      const commandArgs: string[] = backend === 'fd'
        ? [
          '--glob',
          '--case-sensitive',
          '--hidden',
          ...(await insideRepository(directory) ? [] : ['--no-require-git']),
          '--color=never',
          '--print0',
          ...(args.includeIgnored ? ['--no-ignore'] : []),
          ...(args.type === 'any' ? [] : ['--type', args.type]),
          ...denied.flatMap((p) => ['--exclude', globLiteral(p)]),
          ...args.exclude.flatMap((p) => ['--exclude', p]),
          ...(args.pattern.includes('/') ? ['--full-path'] : []),
          '--',
          args.pattern.includes('/') ? fullPattern : args.pattern,
          directory,
        ]
        : [
          directory,
          '-mindepth',
          '1',
          ...(denied.length === 0 ? [] : [
            '(',
            ...denied.flatMap((p, i) => [...(i === 0 ? [] : ['-o']), '-path', globLiteral(p)]),
            ')',
            '-prune',
            '-o',
          ]),
          ...(args.type === 'any' ? [] : ['-type', args.type === 'file' ? 'f' : 'd']),
          args.pattern.includes('/') ? '-path' : '-name',
          args.pattern.includes('/') ? fullPattern : args.pattern,
          '-print0',
        ];
      if (context?.signal?.aborted) throw new TurnCancelledError();
      const operation = input.processExecutor!.start({
        executable: native,
        args: commandArgs,
        cwd: directory,
        env: { PATH: settings.path, LANG: settings.locale, LC_ALL: settings.locale },
      });
      let stopPromise: Promise<void> | undefined;
      const stop = () => {
        stopPromise ??= operation.stop();
        void stopPromise.catch(() => {});
      };
      const onAbort = () => stop();
      context?.signal?.addEventListener('abort', onAbort, { once: true });
      if (context?.signal?.aborted) stop();
      const records: string[] = [];
      let usedBytes = 1024;
      let truncationReason: 'limit' | 'bytes' | null = null;
      const readOutput = async () => {
        const reader = operation.stdout.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        try {
          for (;;) {
            const chunk = await reader.read();
            pending += decoder.decode(chunk.value, { stream: !chunk.done });
            let end: number;
            while ((end = pending.indexOf('\0')) !== -1) {
              const name = pending.slice(0, end).replace(/\/$/, '');
              pending = pending.slice(end + 1);
              const path = isAbsolute(name) ? name : resolve(directory, name);
              if (!await input.pathPolicy.allows(path)) continue;
              const record = displayPath(input.workspace.root, path);
              const bytes = encoder.encode(JSON.stringify(record)).length + 1;
              if (usedBytes + bytes > settings.resultBytes) {
                truncationReason = 'bytes';
              } else {
                records.push(record);
                usedBytes += bytes;
                if (records.length >= args.limit) truncationReason = 'limit';
              }
              if (truncationReason !== null) {
                stop();
                await reader.cancel();
                return;
              }
            }
            if (chunk.done) return;
          }
        } finally {
          reader.releaseLock();
        }
      };
      const readError = async () => {
        const reader = operation.stderr.getReader();
        const decoder = new TextDecoder();
        let text = '';
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return text;
            // Retain the native diagnostic prefix, but drain the whole stream.
            if (text.length < 65536) text += decoder.decode(chunk.value, { stream: true });
          }
        } finally {
          reader.releaseLock();
        }
      };
      const completion = Promise.all([
        readOutput(),
        readError(),
        operation.status,
        operation.closed,
      ]);
      try {
        const [, error, status] = await completion;
        await stopPromise;
        if (context?.signal?.aborted) throw new TurnCancelledError();
        if (
          !truncationReason && status.exitCode !== 0
        ) {
          throw new ToolInputError(`${backend} failed (exit ${status.exitCode}): ${error.trim()}`);
        }
        return JSON.stringify({
          backend,
          ignoreApplied: backend === 'fd' && !args.includeIgnored,
          path: displayPath(input.workspace.root, directory),
          records,
          returned: records.length,
          limit: args.limit,
          searchCompleted: truncationReason === null,
          truncated: truncationReason !== null,
          truncationReason,
          ...(truncationReason === null ? { total: records.length } : {}),
        });
      } catch (error) {
        stop();
        await Promise.allSettled([completion]);
        try {
          await stopPromise;
        } catch {
          if (context?.signal?.aborted) throw new CancellationCleanupError();
        }
        throw error;
      } finally {
        context?.signal?.removeEventListener('abort', onAbort);
        await operation.release();
      }
    },
  };
};

const factory: ToolFactory = (input) => createFindTool(input);
export default factory;
