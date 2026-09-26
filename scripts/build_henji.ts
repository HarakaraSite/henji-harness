import {
  AGENT_DEFINITION_API_CONTRACT,
  type BuiltinResourceRevisionV1,
  HENJI_TOOL_DEFINITION_API_CONTRACT,
} from '../v0/agent/runtime/build_manifest.ts';
import type { BuildManifestV1 } from '../v0/agent/runtime/build_manifest.ts';
import { canonicalDefinitionRevisionBytes } from '../v0/agent/definitions/managed_definition_manifest.ts';
import { canonicalToolDefinitionRevisionBytes } from '../v0/agent/definitions/managed_tool_definition_manifest.ts';

const EXPECTED_DENO = '2.9.7';
const ROOTS = [
  'v0/agent/cli/henji_cli.ts',
  'v0/agent/worker/worker_bootstrap.ts',
  'v0/agent/worker/worker_builtin_definition.ts',
  'v0/agent/worker/worker_builtin_bash_tool.ts',
  'v0/agent/worker/worker_builtin_bash_output_tool.ts',
  'v0/agent/worker/worker_builtin_edit_tool.ts',
  'v0/agent/worker/worker_builtin_read_tool.ts',
  'v0/agent/worker/worker_builtin_write_tool.ts',
  'v0/agent/worker/worker_builtin_web_search_tool.ts',
  'v0/agent/worker/worker_builtin_web_fetch_tool.ts',
] as const;
const IDENTITY_FILES = ['deno.v0.json', 'deno.lock', 'jsr.json'] as const;
/** The `@henji/agent` contract module: a built-in resource's closure does not traverse into it. */
const CONTRACT_BOUNDARY_FILES: ReadonlySet<string> = new Set([
  'v0/agent/worker_agent_api.ts',
]);
const encoder = new TextEncoder();

interface BuiltinDefinitionEntry {
  readonly resourceId: string;
  readonly declaredRole: 'parent';
  readonly entry: string;
}

interface BuiltinToolEntry {
  readonly resourceId: string;
  readonly identity: string;
  readonly entry: string;
}

const BUILTIN_DEFINITIONS: readonly BuiltinDefinitionEntry[] = [
  {
    resourceId: 'builtin/default',
    declaredRole: 'parent',
    entry: 'v0/agent/worker/worker_builtin_definition.ts',
  },
  {
    resourceId: 'builtin/generic',
    declaredRole: 'parent',
    entry: 'v0/agent/worker/worker_builtin_generic_definition.ts',
  },
];

const BUILTIN_TOOLS: readonly BuiltinToolEntry[] = [
  {
    resourceId: 'builtin/bash',
    identity: 'tool:bash',
    entry: 'v0/agent/worker/worker_builtin_bash_tool.ts',
  },
  {
    resourceId: 'builtin/bash-output',
    identity: 'tool:bash_output',
    entry: 'v0/agent/worker/worker_builtin_bash_output_tool.ts',
  },
  {
    resourceId: 'builtin/edit',
    identity: 'tool:edit',
    entry: 'v0/agent/worker/worker_builtin_edit_tool.ts',
  },
  {
    resourceId: 'builtin/read',
    identity: 'tool:read',
    entry: 'v0/agent/worker/worker_builtin_read_tool.ts',
  },
  {
    resourceId: 'builtin/write',
    identity: 'tool:write',
    entry: 'v0/agent/worker/worker_builtin_write_tool.ts',
  },
  {
    resourceId: 'builtin/web-fetch',
    identity: 'tool:web_fetch',
    entry: 'v0/agent/worker/worker_builtin_web_fetch_tool.ts',
  },
  {
    resourceId: 'builtin/web-search',
    identity: 'tool:web_search',
    entry: 'v0/agent/worker/worker_builtin_web_search_tool.ts',
  },
];

const run = async (
  command: string,
  args: readonly string[],
): Promise<Uint8Array> => {
  const output = await new Deno.Command(command, {
    args: [...args],
    stdout: 'piped',
    stderr: 'inherit',
  })
    .output();
  if (!output.success) throw new Error(`${command} failed with ${output.code}`);
  return output.stdout;
};

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const append = (chunks: Uint8Array[], value: string | Uint8Array): void => {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  chunks.push(encoder.encode(`${bytes.byteLength}:`), bytes);
};

const repositoryRoot = async (): Promise<string> =>
  new TextDecoder().decode(await run('git', ['rev-parse', '--show-toplevel']))
    .trim();

const localModuleFiles = async (
  root: string,
  entry: string,
  config = 'deno.v0.json',
): Promise<readonly string[]> => {
  const info = JSON.parse(new TextDecoder().decode(
    await run(Deno.execPath(), [
      'info',
      '--json',
      '--config',
      `${root}/${config}`,
      `${root}/${entry}`,
    ]),
  )) as { readonly modules: readonly { readonly local?: string }[] };
  const paths = new Set<string>();
  for (const module of info.modules) {
    if (module.local?.startsWith(`${root}/`)) {
      paths.add(module.local.slice(root.length + 1));
    }
  }
  return [...paths].sort();
};

const runtimeFiles = async (root: string): Promise<readonly string[]> => {
  const paths = new Set<string>();
  for (const entry of ROOTS) {
    for (const path of await localModuleFiles(root, entry)) paths.add(path);
  }
  for (const path of IDENTITY_FILES) paths.add(path);
  return [...paths].sort();
};

/** Inputs whose tracked content can change the compiled artifact or its embedded manifest. */
export const buildInputFiles = async (
  root: string,
  runtimePaths?: readonly string[],
): Promise<readonly string[]> => {
  const paths = new Set(runtimePaths ?? await runtimeFiles(root));
  for (const path of await localModuleFiles(root, 'scripts/build_henji.ts')) {
    paths.add(path);
  }
  return [...paths].sort();
};

const runtimeDigest = async (
  root: string,
  paths: readonly string[],
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for (const path of paths) {
    append(chunks, path);
    append(chunks, await Deno.readFile(`${root}/${path}`));
  }
  const size = chunks.reduce((total, bytes) => total + bytes.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const bytes of chunks) {
    joined.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return await sha256(joined);
};

export interface ModuleClosureOptions {
  readonly config?: string;
  readonly contractBoundaryFiles?: readonly string[];
  readonly identityFiles?: readonly string[];
}

/** Runtime module closure of one built-in resource entry, excluding contract and identity files. */
export const moduleClosureFiles = async (
  root: string,
  entry: string,
  options: ModuleClosureOptions = {},
): Promise<readonly string[]> => {
  const info = JSON.parse(new TextDecoder().decode(
    await run(Deno.execPath(), [
      'info',
      '--json',
      '--config',
      `${root}/${options.config ?? 'deno.v0.json'}`,
      `${root}/${entry}`,
    ]),
  )) as {
    readonly modules: readonly {
      readonly local?: string;
      readonly dependencies?: readonly {
        readonly code?: { readonly specifier?: string };
      }[];
    }[];
  };
  const prefix = `file://${root}/`;
  const identityFiles = new Set(options.identityFiles ?? IDENTITY_FILES);
  const contractBoundaryFiles = new Set(
    options.contractBoundaryFiles ?? CONTRACT_BOUNDARY_FILES,
  );
  const edges = new Map<string, string[]>();
  for (const module of info.modules) {
    if (!module.local?.startsWith(`${root}/`)) continue;
    const relative = module.local.slice(root.length + 1);
    const dependencies: string[] = [];
    for (const dependency of module.dependencies ?? []) {
      const specifier = dependency.code?.specifier;
      if (specifier === undefined || !specifier.startsWith(prefix)) continue;
      dependencies.push(decodeURIComponent(specifier.slice(prefix.length)));
    }
    edges.set(relative, dependencies);
  }
  // The built-in resource artifact is its own runtime module closure. The `@henji/agent`
  // contract module is a boundary: external Definitions treat it as the contract, so built-in
  // resources do not traverse into it (nor into type-only edges, which never run).
  const reachable = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    if (identityFiles.has(current)) continue;
    if (contractBoundaryFiles.has(current)) continue;
    reachable.add(current);
    for (const dependency of edges.get(current) ?? []) pending.push(dependency);
  }
  return [...reachable].sort();
};

const closureFiles = async (
  root: string,
  entry: string,
): Promise<
  readonly { path: string; bytes: Uint8Array; dependencies: readonly [] }[]
> => {
  const paths = await moduleClosureFiles(root, entry);
  const files: {
    path: string;
    bytes: Uint8Array;
    dependencies: readonly [];
  }[] = [];
  for (const path of paths) {
    files.push({
      path,
      bytes: await Deno.readFile(`${root}/${path}`),
      dependencies: [],
    });
  }
  return files;
};

const builtinResourceRevisions = async (
  root: string,
): Promise<readonly BuiltinResourceRevisionV1[]> => {
  const revisions: BuiltinResourceRevisionV1[] = [];
  for (const definition of BUILTIN_DEFINITIONS) {
    const bytes = canonicalDefinitionRevisionBytes({
      declaredRole: definition.declaredRole,
      apiContract: AGENT_DEFINITION_API_CONTRACT,
      entry: definition.entry,
      files: await closureFiles(root, definition.entry),
    });
    revisions.push({
      kind: 'agent-definition',
      resourceId: definition.resourceId,
      digest: await sha256(bytes),
    });
  }
  for (const tool of BUILTIN_TOOLS) {
    const bytes = canonicalToolDefinitionRevisionBytes({
      toolIdentity: tool.identity,
      apiContract: HENJI_TOOL_DEFINITION_API_CONTRACT,
      entry: tool.entry,
      files: await closureFiles(root, tool.entry),
    });
    revisions.push({
      kind: 'tool-definition',
      resourceId: tool.resourceId,
      identity: tool.identity,
      digest: await sha256(bytes),
    });
  }
  return revisions;
};

export const hasDirtyBuildInputs = async (
  root: string,
  paths: readonly string[],
): Promise<boolean> =>
  new TextDecoder().decode(
    await run('git', [
      '-C',
      root,
      'status',
      '--porcelain=v1',
      '--',
      ...paths,
    ]),
  ).trim().length > 0;

const parseOutput = (args: readonly string[], root: string): string => {
  if (args.length === 0) return `${root}/dist/henji`;
  if (args.length === 2 && args[0] === '--output' && args[1].length > 0) {
    return args[1].startsWith('/') ? args[1] : `${Deno.cwd()}/${args[1]}`;
  }
  throw new Error('usage: henji:compile [--output PATH]');
};

export interface StagedCompileInputs {
  readonly entry: string;
  readonly manifestModule: string;
  readonly cliModule: string;
  readonly config: string;
  readonly includes: readonly string[];
}

export const stagedCompileInputs = (
  stagingRoot: string,
): StagedCompileInputs => ({
  entry: `${stagingRoot}/henji_entry.ts`,
  manifestModule: './v0/agent/runtime/build_manifest.ts',
  cliModule: './v0/agent/cli/henji_cli.ts',
  config: `${stagingRoot}/deno.v0.json`,
  includes: ROOTS.slice(1).map((path) => `${stagingRoot}/${path}`),
});

const copyDirectory = async (source: string, target: string): Promise<void> => {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = `${source}/${entry.name}`;
    const targetPath = `${target}/${entry.name}`;
    if (entry.isDirectory) await copyDirectory(sourcePath, targetPath);
    else if (entry.isFile) await Deno.copyFile(sourcePath, targetPath);
    else if (entry.isSymlink) {
      await Deno.symlink(await Deno.readLink(sourcePath), targetPath);
    }
  }
};

const copyRuntimeToStaging = async (
  root: string,
  stagingRoot: string,
  paths: readonly string[],
): Promise<void> => {
  for (const path of paths) {
    const target = `${stagingRoot}/${path}`;
    const slash = target.lastIndexOf('/');
    if (slash > 0) {
      await Deno.mkdir(target.slice(0, slash), { recursive: true });
    }
    await Deno.copyFile(`${root}/${path}`, target);
  }
  await copyDirectory(`${root}/vendor`, `${stagingRoot}/vendor`);
};

const main = async (): Promise<void> => {
  if (Deno.version.deno !== EXPECTED_DENO) {
    throw new Error(
      `Deno ${EXPECTED_DENO} required; found ${Deno.version.deno}`,
    );
  }
  const root = await repositoryRoot();
  const output = parseOutput(Deno.args, root);
  const files = await runtimeFiles(root);
  const buildInputs = await buildInputFiles(root, files);
  const embeddedRuntimeSha256 = await runtimeDigest(root, files);
  const jsr = JSON.parse(await Deno.readTextFile(`${root}/jsr.json`)) as {
    version: string;
  };
  const sourceRevision = new TextDecoder().decode(
    await run('git', ['-C', root, 'rev-parse', 'HEAD']),
  ).trim();
  const builtinResources = await builtinResourceRevisions(root);
  const identity = {
    schemaVersion: 1,
    productVersion: jsr.version,
    sourceRevision,
    sourceDirty: await hasDirtyBuildInputs(root, buildInputs),
    denoVersion: Deno.version.deno,
    target: Deno.build.target,
    embeddedRuntimeSha256,
    supportedAgentDefinitionApiContracts: [AGENT_DEFINITION_API_CONTRACT],
    supportedToolDefinitionApiContracts: [HENJI_TOOL_DEFINITION_API_CONTRACT],
    builtinResources,
  } as const;
  const buildId = await sha256(
    encoder.encode(`henji-build-v1\0${JSON.stringify(identity)}`),
  );
  const manifest: BuildManifestV1 = { ...identity, buildId };
  const temporary = await Deno.makeTempDir({ prefix: 'henji-compile-' });
  try {
    const stagingRoot = `${temporary}/runtime`;
    await copyRuntimeToStaging(root, stagingRoot, files);
    const inputs = stagedCompileInputs(stagingRoot);
    await Deno.writeTextFile(
      inputs.entry,
      `import { installBuildManifest } from ${JSON.stringify(inputs.manifestModule)};\n` +
        `installBuildManifest(${JSON.stringify(manifest)});\n` +
        `const { main } = await import(${JSON.stringify(inputs.cliModule)});\n` +
        `Deno.exit(await main(Deno.args));\n`,
    );
    const slash = output.lastIndexOf('/');
    if (slash > 0) {
      await Deno.mkdir(output.slice(0, slash), { recursive: true });
    }
    await run(Deno.execPath(), [
      'compile',
      '--no-prompt',
      '--cached-only',
      '--unstable-worker-options',
      '--allow-read',
      '--allow-write',
      '--allow-run=/bin/bash',
      '--allow-net',
      '--allow-sys=uid',
      '--allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME,OPENAI_LOG,OPENAI_CUSTOM_HEADERS,NODE_V8_COVERAGE',
      `--config=${inputs.config}`,
      ...inputs.includes.map((path) => `--include=${path}`),
      `--output=${output}`,
      inputs.entry,
    ]);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
  console.log(`${output} ${manifest.buildId}`);
};

if (import.meta.main) await main();
