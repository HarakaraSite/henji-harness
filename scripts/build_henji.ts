import { AGENT_DEFINITION_API_CONTRACT } from '../v0/agent/runtime/build_manifest.ts';
import type { BuildManifestV1 } from '../v0/agent/runtime/build_manifest.ts';

const EXPECTED_DENO = '2.9.4';
const ROOTS = [
  'v0/agent/cli/henji_cli.ts',
  'v0/agent/worker/worker_bootstrap.ts',
  'v0/agent/worker/worker_builtin_definition.ts',
  'v0/agent/worker/worker_builtin_planner_definition.ts',
] as const;
const IDENTITY_FILES = ['deno.v0.json', 'deno.lock', 'jsr.json'] as const;
const encoder = new TextEncoder();

const run = async (command: string, args: readonly string[]): Promise<Uint8Array> => {
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
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const append = (chunks: Uint8Array[], value: string | Uint8Array): void => {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  chunks.push(encoder.encode(`${bytes.byteLength}:`), bytes);
};

const repositoryRoot = async (): Promise<string> =>
  new TextDecoder().decode(await run('git', ['rev-parse', '--show-toplevel'])).trim();

const runtimeFiles = async (root: string): Promise<readonly string[]> => {
  const paths = new Set<string>();
  for (const entry of ROOTS) {
    const info = JSON.parse(new TextDecoder().decode(
      await run(Deno.execPath(), [
        'info',
        '--json',
        '--config',
        `${root}/deno.v0.json`,
        `${root}/${entry}`,
      ]),
    )) as { readonly modules: readonly { readonly local?: string }[] };
    for (const module of info.modules) {
      if (module.local?.startsWith(`${root}/`)) paths.add(module.local.slice(root.length + 1));
    }
  }
  for (const path of IDENTITY_FILES) paths.add(path);
  return [...paths].sort();
};

const runtimeDigest = async (root: string, paths: readonly string[]): Promise<string> => {
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

const dirtyRuntime = async (root: string, paths: readonly string[]): Promise<boolean> =>
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

const main = async (): Promise<void> => {
  if (Deno.version.deno !== EXPECTED_DENO) {
    throw new Error(`Deno ${EXPECTED_DENO} required; found ${Deno.version.deno}`);
  }
  const root = await repositoryRoot();
  const output = parseOutput(Deno.args, root);
  const files = await runtimeFiles(root);
  const embeddedRuntimeSha256 = await runtimeDigest(root, files);
  const jsr = JSON.parse(await Deno.readTextFile(`${root}/jsr.json`)) as { version: string };
  const sourceRevision = new TextDecoder().decode(
    await run('git', ['-C', root, 'rev-parse', 'HEAD']),
  ).trim();
  const identity = {
    schemaVersion: 1,
    productVersion: jsr.version,
    sourceRevision,
    sourceDirty: await dirtyRuntime(root, files),
    denoVersion: Deno.version.deno,
    target: Deno.build.target,
    embeddedRuntimeSha256,
    supportedAgentDefinitionApiContracts: [AGENT_DEFINITION_API_CONTRACT],
  } as const;
  const buildId = await sha256(encoder.encode(`henji-build-v1\0${JSON.stringify(identity)}`));
  const manifest: BuildManifestV1 = { ...identity, buildId };
  const temporary = await Deno.makeTempDir({ prefix: 'henji-compile-' });
  try {
    const manifestModule = new URL(`file://${root}/v0/agent/runtime/build_manifest.ts`).href;
    const cliModule = new URL(`file://${root}/v0/agent/cli/henji_cli.ts`).href;
    const entry = `${temporary}/henji_entry.ts`;
    await Deno.writeTextFile(
      entry,
      `import { installBuildManifest } from ${JSON.stringify(manifestModule)};\n` +
        `installBuildManifest(${JSON.stringify(manifest)});\n` +
        `const { main } = await import(${JSON.stringify(cliModule)});\n` +
        `Deno.exit(await main(Deno.args));\n`,
    );
    const slash = output.lastIndexOf('/');
    if (slash > 0) await Deno.mkdir(output.slice(0, slash), { recursive: true });
    const include = ROOTS.slice(1).map((path) => `--include=${root}/${path}`);
    await run(Deno.execPath(), [
      'compile',
      '--no-prompt',
      '--cached-only',
      '--unstable-worker-options',
      '--allow-read',
      '--allow-write',
      '--allow-run=/bin/bash',
      '--allow-net=openrouter.ai,api.openai.com',
      '--allow-sys=uid',
      '--allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME,OPENAI_LOG,OPENAI_CUSTOM_HEADERS',
      `--config=${root}/deno.v0.json`,
      ...include,
      `--output=${output}`,
      entry,
    ]);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
  console.log(`${output} ${manifest.buildId}`);
};

if (import.meta.main) await main();
