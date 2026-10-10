import {
  type JsonValue,
  type Tool,
  type ToolFactory,
  ToolInputError,
  type ToolPathPolicy,
  TurnCancelledError,
} from '@henji/tool';
import { relative, resolve, sep } from 'node:path';

const RESULT_BYTES = 1024 * 1024;
const RESULT_RESERVE_BYTES = 128;
const encoder = new TextEncoder();

type EntryType = 'file' | 'directory' | 'symlink' | 'other';
type OmissionReason = 'depth' | 'limit' | 'bytes';

interface LsArguments {
  readonly path: string;
  readonly tree: boolean;
  readonly depth: number;
  readonly limit: number;
}

interface EntryNode {
  readonly name: string;
  readonly path: string;
  readonly type: EntryType;
  readonly children?: EntryNode[];
  childrenOmitted?: OmissionReason;
}

interface OmittedSummary {
  depth: number;
  limit: boolean;
  bytes: boolean;
}

interface LsPayload {
  readonly path: string;
  readonly tree: boolean;
  readonly depth: number;
  readonly limit: number;
  count: number;
  readonly entries: EntryNode[];
  readonly omitted: OmittedSummary;
  childrenOmitted?: OmissionReason;
}

interface VisibleEntry {
  readonly name: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly info: Deno.FileInfo;
}

const schema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'File-system path to a directory under this tool’s configured allowed paths; defaults to the workspace root (.).',
    },
    tree: {
      type: 'boolean',
      description:
        'Defaults to false for direct children only; true returns directory children as JSON.',
    },
    depth: {
      type: 'integer',
      minimum: 0,
      description:
        'Tree levels below path; path is depth 0. Defaults to 3 when tree is true. Only applies to tree mode.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      description:
        'Maximum number of returned entries across the whole tree; defaults to 100. There is no fixed maximum.',
    },
  },
  additionalProperties: false,
} as const;

const asObject = (value: JsonValue): Record<string, JsonValue> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolInputError('ls expects an object');
  }
  return value as Record<string, JsonValue>;
};

const parseArguments = (value: JsonValue): LsArguments => {
  const args = asObject(value);
  const allowed = new Set(['path', 'tree', 'depth', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new ToolInputError('ls received an unknown argument');
  }
  if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length === 0)) {
    throw new ToolInputError('path must be a non-empty directory path');
  }
  if (args.tree !== undefined && typeof args.tree !== 'boolean') {
    throw new ToolInputError('tree must be a boolean');
  }
  if (args.depth !== undefined) {
    if (args.tree !== true) throw new ToolInputError('depth is only supported when tree is true');
    if (typeof args.depth !== 'number' || !Number.isSafeInteger(args.depth) || args.depth < 0) {
      throw new ToolInputError('depth must be a non-negative safe integer');
    }
  }
  if (
    args.limit !== undefined &&
    (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1)
  ) throw new ToolInputError('limit must be a positive safe integer');

  return {
    path: typeof args.path === 'string' ? args.path : '.',
    tree: args.tree === true,
    depth: typeof args.depth === 'number' ? args.depth : 3,
    limit: typeof args.limit === 'number' ? args.limit : 100,
  };
};

const workspaceRelative = (root: string, target: string): string => {
  const path = relative(root, target).split(sep).join('/');
  return path || '.';
};

const resolveScopePath = async (path: string, pathPolicy: ToolPathPolicy): Promise<string> => {
  // Keep the caller's symlink spelling in returned paths while validating the resolved target too.
  const lexical = await pathPolicy.resolve(path, { followSymlinks: false });
  await pathPolicy.resolve(path);
  return lexical;
};

const entryType = (info: Deno.FileInfo): EntryType =>
  info.isSymlink ? 'symlink' : info.isFile ? 'file' : info.isDirectory ? 'directory' : 'other';

const visibleEntries = async (
  directory: string,
  workspaceRoot: string,
  pathPolicy: ToolPathPolicy,
  signal?: AbortSignal,
): Promise<VisibleEntry[]> => {
  const entries: VisibleEntry[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (signal?.aborted) throw new TurnCancelledError();
    const path = resolve(directory, entry.name);
    if (!await pathPolicy.allows(path)) continue;
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    entries.push({
      name: entry.name,
      path: workspaceRelative(workspaceRoot, path),
      absolutePath: path,
      info,
    });
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return entries;
};

const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

const createLsTool = (input: Parameters<ToolFactory>[0]): Tool => ({
  name: 'ls',
  fileAccess: 'read',
  description: [
    'List the direct children of a directory, or return a JSON directory tree. Paths are resolved with this tool’s configured allow paths (default allow is /); common-denied paths are skipped during traversal and directly targeting one is rejected. Dotfiles are included. Entries report name, path relative to the workspace when possible, and type (file, directory, symlink, or other).',
    'With tree:false (the default), only direct children are returned. With tree:true, directories contain a children array. An empty children array means the directory was read and is empty; childrenOmitted explains a non-empty section omitted by depth, limit, or the 1 MiB result budget. Tree depth counts path as depth 0 and defaults to 3. Directory symlinks are listed but not traversed.',
    'limit defaults to 100 entries across the entire tree and has no fixed maximum. The JSON reports the number returned and omitted.depth, omitted.limit, and omitted.bytes so an empty result is distinct from a partial listing.',
    'Examples: {"path":"src"}, {"path":"src","tree":true}, {"path":"src","tree":true,"depth":4,"limit":250}.',
  ].join('\n\n'),
  inputSchema: schema,
  promptGuidelines: [
    'Use ls instead of bash ls for directory listings. Use tree:false for one directory level and tree:true when nested structure matters. Paths may be inside or outside the workspace when permitted by the configured file access policy.',
    'In tree output, children:[] means an empty directory. Check childrenOmitted and the top-level omitted summary before treating a directory listing as complete; increase depth or limit, or narrow the requested path when the corresponding reason is reported.',
  ],
  async execute(argumentsValue, context) {
    const args = parseArguments(argumentsValue);
    const workspaceRoot = await Deno.realPath(input.workspace.root);
    const target = await resolveScopePath(args.path, input.pathPolicy);
    // Follow a symlink explicitly named as the listing root; returned paths retain its alias.
    // Descendant entries still use lstat, so tree traversal does not follow child symlinks.
    const targetInfo = await Deno.stat(target);
    if (!targetInfo.isDirectory) {
      throw new ToolInputError('path must name a directory');
    }

    const payload: LsPayload = {
      path: workspaceRelative(workspaceRoot, target),
      tree: args.tree,
      depth: args.tree ? args.depth : 1,
      limit: args.limit,
      // count cannot exceed limit, so this placeholder reserves its final JSON width.
      count: args.limit,
      entries: [],
      omitted: { depth: 0, limit: false, bytes: false },
    };
    let serializedBytes = jsonBytes(payload);
    let count = 0;
    let stopped = false;

    const setSummaryFlag = (key: 'limit' | 'bytes'): void => {
      const before = jsonBytes(payload.omitted[key]);
      payload.omitted[key] = true;
      serializedBytes += jsonBytes(payload.omitted[key]) - before;
    };

    const omittedFieldBytes = (reason: OmissionReason): number =>
      encoder.encode(`,"childrenOmitted":${JSON.stringify(reason)}`).byteLength;

    const markChildrenOmitted = (
      parent: EntryNode | undefined,
      reason: OmissionReason,
    ): void => {
      if (parent === undefined) {
        if (payload.childrenOmitted === undefined) {
          payload.childrenOmitted = reason;
          serializedBytes += omittedFieldBytes(reason);
        }
      } else if (parent.childrenOmitted === undefined) {
        parent.childrenOmitted = reason;
        serializedBytes += omittedFieldBytes(reason);
      }
    };

    const markDepthOmitted = (parent: EntryNode | undefined): void => {
      if (parent !== undefined && parent.childrenOmitted === undefined) {
        parent.childrenOmitted = 'depth';
        serializedBytes += omittedFieldBytes('depth');
      }
      const before = jsonBytes(payload.omitted.depth);
      payload.omitted.depth += 1;
      serializedBytes += jsonBytes(payload.omitted.depth) - before;
    };

    const appendEntries = async (
      entries: readonly VisibleEntry[],
      parent: EntryNode | undefined,
      parentDepth: number,
      destination: EntryNode[],
    ): Promise<void> => {
      for (const entry of entries) {
        if (context?.signal?.aborted) throw new TurnCancelledError();
        if (stopped) return;
        if (count >= args.limit) {
          markChildrenOmitted(parent, 'limit');
          setSummaryFlag('limit');
          stopped = true;
          return;
        }

        const isDirectory = entry.info.isDirectory && !entry.info.isSymlink;
        const node: EntryNode = {
          name: entry.name,
          path: entry.path,
          type: entryType(entry.info),
          ...(args.tree && isDirectory ? { children: [] } : {}),
        };
        const nodeBytes = jsonBytes(node);
        const insertionBytes = nodeBytes + (destination.length === 0 ? 0 : 1);
        if (serializedBytes + insertionBytes + RESULT_RESERVE_BYTES > RESULT_BYTES) {
          markChildrenOmitted(parent, 'bytes');
          setSummaryFlag('bytes');
          stopped = true;
          return;
        }

        destination.push(node);
        serializedBytes += insertionBytes;
        count += 1;

        if (args.tree && isDirectory) {
          const children = await visibleEntries(
            entry.absolutePath,
            workspaceRoot,
            input.pathPolicy,
            context?.signal,
          );
          const entryDepth = parentDepth + 1;
          if (entryDepth >= args.depth) {
            if (children.length > 0) markDepthOmitted(node);
          } else {
            await appendEntries(children, node, entryDepth, node.children!);
          }
        }
      }
    };

    const topEntries = await visibleEntries(
      target,
      workspaceRoot,
      input.pathPolicy,
      context?.signal,
    );
    if (args.tree && args.depth === 0) {
      if (topEntries.length > 0) markDepthOmitted(undefined);
    } else {
      await appendEntries(topEntries, undefined, 0, payload.entries);
    }

    payload.count = count;
    const result = JSON.stringify(payload);
    if (encoder.encode(result).byteLength > RESULT_BYTES) {
      throw new Error('ls result exceeded its byte budget');
    }
    return result;
  },
});

const factory: ToolFactory = (input) => createLsTool(input);

export default factory;
