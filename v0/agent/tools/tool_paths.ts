import { ToolInputError } from './tools.ts';

/** Runtime declaration; it is not part of the model-facing tool schema. */
export type ToolFileAccess = 'none' | 'read' | 'read-write' | 'unmanaged';

export interface ToolPathOptions {
  readonly followSymlinks?: boolean;
}

export interface ToolPathPolicy {
  readonly allowedPaths: readonly string[];
  readonly deniedPaths: readonly string[];
  /** Original and expanded spellings for run_typescript's code audit. */
  readonly auditDeniedPaths: readonly string[];
  /** Actual destinations, including existing symlinks and an absent suffix. */
  canonicalDeniedPaths(): Promise<readonly string[]>;
  resolve(path: string, options?: ToolPathOptions): Promise<string>;
  allows(path: string, options?: ToolPathOptions): Promise<boolean>;
}

export const normalizeToolPath = (path: string): string => {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
};

export const withinToolPath = (root: string, target: string): boolean =>
  target === root || target.startsWith(root === '/' ? '/' : `${root}/`);

/** Resolve existing components, retaining an absent suffix for new files. */
const realPathWithMissingSuffix = async (path: string): Promise<string> => {
  const parts = path.split('/').filter(Boolean);
  let current = '/';
  for (let index = 0; index < parts.length; index++) {
    const next = normalizeToolPath(`${current}/${parts[index]}`);
    try {
      const info = await Deno.lstat(next);
      current = info.isSymlink ? await Deno.realPath(next) : next;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return normalizeToolPath(`${current}/${parts.slice(index).join('/')}`);
    }
  }
  return current;
};

export const createToolPathPolicy = (
  workspaceRoot: string,
  allowedPaths: readonly string[],
  deniedPaths: readonly string[],
  auditDeniedPaths: readonly string[] = deniedPaths,
  home?: string,
): ToolPathPolicy => {
  const allowed = Object.freeze([...new Set(allowedPaths.map(normalizeToolPath))]);
  const denied = Object.freeze([...new Set(deniedPaths.map(normalizeToolPath))]);
  const absolute = (path: string): string => {
    if (typeof path !== 'string' || path.trim().length === 0 || path.includes('\0')) {
      throw new ToolInputError('path must be a non-empty path');
    }
    if (path === '~' || path.startsWith('~/')) {
      if (home === undefined) throw new ToolInputError('HOME is unavailable for ~ path');
      path = `${home}/${path.slice(2)}`;
    }
    return normalizeToolPath(path.startsWith('/') ? path : `${workspaceRoot}/${path}`);
  };
  const lexicalAllowed = (path: string): boolean =>
    allowed.some((root) => withinToolPath(root, path)) &&
    !denied.some((root) => withinToolPath(root, path));
  const canonicalDeniedPaths = async (): Promise<readonly string[]> =>
    Object.freeze([...new Set(await Promise.all(denied.map(realPathWithMissingSuffix)))]);
  const evaluate = async (
    path: string,
    options: ToolPathOptions = {},
  ): Promise<{ readonly path: string; readonly allowed: boolean }> => {
    const lexical = absolute(path);
    if (!lexicalAllowed(lexical)) return { path: lexical, allowed: false };
    if (options.followSymlinks === false) {
      const realDenied = await canonicalDeniedPaths();
      return {
        path: lexical,
        allowed: !realDenied.some((root) => withinToolPath(root, lexical)),
      };
    }
    const real = await realPathWithMissingSuffix(lexical);
    // Config/workspace roots can themselves be reached through a symlink.
    const realAllowed = await Promise.all(allowed.map(realPathWithMissingSuffix));
    const realDenied = await canonicalDeniedPaths();
    return {
      path: real,
      allowed: realAllowed.some((root) => withinToolPath(root, real)) &&
        !realDenied.some((root) => withinToolPath(root, real)),
    };
  };
  return Object.freeze({
    allowedPaths: allowed,
    deniedPaths: denied,
    auditDeniedPaths: Object.freeze([...new Set(auditDeniedPaths)]),
    canonicalDeniedPaths,
    async resolve(path: string, options?: ToolPathOptions): Promise<string> {
      const result = await evaluate(path, options);
      if (!result.allowed) {
        throw new ToolInputError('path is outside tool allow or inside common deny');
      }
      return result.path;
    },
    async allows(path: string, options?: ToolPathOptions): Promise<boolean> {
      return (await evaluate(path, options)).allowed;
    },
  });
};

export interface ToolPathsConfiguration {
  readonly source?: string;
  readonly deniedPaths: readonly string[];
  readonly configuredAllow: Readonly<Record<string, readonly string[]>>;
  forTool(name: string): ToolPathPolicy;
}

export interface ToolPathsConfigurationOptions {
  readonly workspaceRoot: string;
  readonly configRoot?: string;
  readonly credentialRoot?: string;
  readonly home?: string;
}

/** One configuration read per Worker startup; each tool receives its own immutable policy. */
export const loadToolPathsConfiguration = async (
  options: ToolPathsConfigurationOptions,
): Promise<ToolPathsConfiguration> => {
  let home = options.home;
  if (home === undefined) {
    try {
      home = Deno.env.get('HOME');
    } catch (error) {
      if (!(error instanceof Deno.errors.NotCapable)) throw error;
    }
  }
  const roots: Readonly<Record<string, string | undefined>> = {
    workspace: options.workspaceRoot,
    config: options.configRoot,
    credentials: options.credentialRoot,
  };
  const expand = (entry: unknown): { path: string; spelling: string } => {
    if (typeof entry !== 'string' || !entry || entry.trim() !== entry || /[\0\r\n]/.test(entry)) {
      throw new Error('tool path entries must be non-empty paths or root names');
    }
    let path = Object.hasOwn(roots, entry) ? roots[entry] : entry;
    if (path === undefined) throw new Error(`tool path root ${entry} is unavailable`);
    if (path === '~' || path.startsWith('~/')) {
      if (home === undefined || !home.startsWith('/')) {
        throw new Error('HOME is unavailable for ~ path');
      }
      path = `${home}/${path.slice(2)}`;
    }
    if (!path.startsWith('/')) throw new Error('tool path must be absolute, ~, or a root name');
    return { path: normalizeToolPath(path), spelling: entry };
  };
  const entries = (value: unknown): { path: string; spelling: string }[] => {
    if (!Array.isArray(value)) throw new Error('tool paths allow/deny must be arrays');
    return value.map(expand);
  };
  let source: string | undefined;
  let data: Record<string, unknown> = {};
  if (options.configRoot !== undefined) {
    const file = `${options.configRoot}/tool-paths.json`;
    let text: string | undefined;
    try {
      text = await Deno.readTextFile(file);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (text !== undefined) {
      const value = JSON.parse(text);
      if (
        value === null || typeof value !== 'object' || Array.isArray(value) ||
        value.schemaVersion !== 1
      ) {
        throw new Error('tool-paths.json must contain schemaVersion 1');
      }
      data = value;
      source = file;
    }
  }
  const denyEntries = entries(data.deny ?? []);
  const deniedPaths = Object.freeze([
    ...new Set([
      ...(options.credentialRoot === undefined ? [] : [normalizeToolPath(options.credentialRoot)]),
      ...denyEntries.map(({ path }) => path),
    ]),
  ]);
  const auditDeniedPaths = [
    ...deniedPaths,
    ...denyEntries.flatMap(({ spelling, path }) =>
      Object.hasOwn(roots, spelling) ? [path] : [spelling, path]
    ),
  ];
  const configuredAllow: Record<string, readonly string[]> = {};
  if (data.tools !== undefined) {
    if (data.tools === null || typeof data.tools !== 'object' || Array.isArray(data.tools)) {
      throw new Error('tool-paths.json tools must be an object');
    }
    for (const [name, settings] of Object.entries(data.tools)) {
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error(`tool paths ${name} must contain allow`);
      }
      configuredAllow[name] = Object.freeze(
        entries((settings as Record<string, unknown>).allow).map(({ path }) => path),
      );
    }
  }
  Object.freeze(configuredAllow);
  const writable = [
    options.workspaceRoot,
    '/tmp',
    ...(options.configRoot === undefined ? [] : [options.configRoot]),
  ];
  const defaults: Readonly<Record<string, readonly string[]>> = {
    read: ['/'],
    write: writable,
    edit: writable,
    run_typescript: writable,
    search: ['/'],
    git_inspect: [options.workspaceRoot],
    web_fetch: [options.workspaceRoot, '/tmp'],
  };
  return Object.freeze({
    ...(source === undefined ? {} : { source }),
    deniedPaths,
    configuredAllow,
    forTool(name: string): ToolPathPolicy {
      return createToolPathPolicy(
        options.workspaceRoot,
        configuredAllow[name] ?? defaults[name] ?? [options.workspaceRoot],
        deniedPaths,
        auditDeniedPaths,
        home,
      );
    },
  });
};
