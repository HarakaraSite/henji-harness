import { domainDigest, rawDigest } from '../../spike1/src/digests.ts';
import { buildAdmissionProfile } from '../src/admission_profile.ts';

interface InfoModule {
  readonly specifier: string;
}
interface InfoOutput {
  readonly modules: readonly InfoModule[];
}

const repositoryRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const denoExecutable = `${repositoryRoot}/.tools/deno/2.9.4/deno`;
const cacheDirectory = `${repositoryRoot}/.tools/deno-cache/spike2`;
const packageDirectory = `${cacheDirectory}/npm/registry.npmjs.org/typescript/6.0.3`;

const info = async (root: string): Promise<InfoOutput> => {
  const result = await new Deno.Command(denoExecutable, {
    args: [
      'info',
      '--json',
      '--config',
      `${repositoryRoot}/deno.spike2.json`,
      '--lock',
      `${repositoryRoot}/deno.spike2.lock`,
      '--frozen',
      '--no-remote',
      '--deny-import',
      `${repositoryRoot}/${root}`,
    ],
    clearEnv: true,
    env: { DENO_DIR: cacheDirectory },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!result.success) throw new Error(`deno info failed: ${root}`);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as InfoOutput;
};

const sourceManifest = async (roots: readonly string[], schemaVersion: string) => {
  const logicalPaths = new Set<string>();
  for (const root of roots) {
    for (const module of (await info(root)).modules) {
      if (module.specifier === 'npm:/typescript@6.0.3') continue;
      if (!module.specifier.startsWith('file://')) {
        throw new Error(`unknown module: ${module.specifier}`);
      }
      const path = new URL(module.specifier).pathname;
      if (!path.startsWith(`${repositoryRoot}/`)) {
        throw new Error(`module outside repository: ${path}`);
      }
      const logicalPath = path.slice(repositoryRoot.length + 1);
      if (!/^(?:spike0|spike1|spike2)\/(?:src|builder)\/.+\.ts$/.test(logicalPath)) {
        throw new Error(`unapproved source path: ${logicalPath}`);
      }
      logicalPaths.add(logicalPath);
    }
  }
  const files = await Promise.all(
    [...logicalPaths].sort().map(async (logicalPath) => ({
      logicalPath,
      sourceHash: await rawDigest(
        'henji/spike2/tcb-source-file/v1',
        await Deno.readFile(`${repositoryRoot}/${logicalPath}`),
      ),
    })),
  );
  return { schemaVersion, files };
};

const listFiles = async (directory: string, prefix = ''): Promise<string[]> => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isSymlink) throw new Error(`dependency symlink: ${entry.name}`);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) files.push(...await listFiles(`${directory}/${entry.name}`, relative));
    else if (entry.isFile) files.push(relative);
    else throw new Error(`dependency special file: ${entry.name}`);
  }
  return files;
};

const preflightRoots = [
  'spike2/src/admission_service.ts',
  'spike2/src/subset_checker.ts',
  'spike2/src/admission_profile.ts',
  'spike2/src/admission_policy.ts',
  'spike2/src/runtime_schema.ts',
] as const;
const preflightManifest = await sourceManifest(preflightRoots, 'preflight-source-manifest/v1');
const builderManifest = await sourceManifest(
  ['spike2/builder/main.ts'],
  'builder-source-manifest/v1',
);
const packageFiles = (await listFiles(packageDirectory)).sort();
const lock = JSON.parse(await Deno.readTextFile(`${repositoryRoot}/deno.spike2.lock`));
const lockIntegrity = lock.npm?.['typescript@6.0.3']?.integrity;
if (typeof lockIntegrity !== 'string') throw new Error('TypeScript lock integrity missing');
const dependencyManifest = {
  schemaVersion: 'builder-dependency-manifest/v1',
  packages: [{
    name: 'typescript',
    version: '6.0.3',
    lockIntegrity,
    files: await Promise.all(packageFiles.map(async (path) => ({
      logicalPath: `npm/typescript@6.0.3/${path}`,
      sourceHash: await rawDigest(
        'henji/spike2/dependency-file/v1',
        await Deno.readFile(`${packageDirectory}/${path}`),
      ),
    }))),
  }],
};
const versionResult = await new Deno.Command(denoExecutable, {
  args: ['--version'],
  clearEnv: true,
  stdout: 'piped',
  stderr: 'piped',
}).output();
if (!versionResult.success) throw new Error('Deno version failed');
const versionLines = new TextDecoder().decode(versionResult.stdout).trim().split('\n');
const runtime = {
  product: 'deno',
  version: versionLines[0]?.split(' ')[1],
  v8Version: versionLines[1]?.slice(3),
  typescriptVersion: versionLines[2]?.slice('typescript '.length),
  platform: 'aarch64-unknown-linux-gnu',
  binaryHash: await rawDigest(
    'henji/spike2/runtime-binary/v1',
    await Deno.readFile(denoExecutable),
  ),
};
if (runtime.version !== '2.9.4' || runtime.typescriptVersion !== '6.0.3') {
  throw new Error('runtime version mismatch');
}
const profile = await buildAdmissionProfile();
const preflightSourceDigest = await domainDigest(
  'henji/spike2/preflight-source/v1',
  preflightManifest,
);
const builderSourceDigest = await domainDigest(
  'henji/spike2/builder-source/v1',
  builderManifest,
);
const builderDependencyDigest = await domainDigest(
  'henji/spike2/builder-dependency/v1',
  dependencyManifest,
);
const runtimeDigest = await domainDigest('henji/spike2/runtime/v1', runtime);
const parserDigest = await domainDigest('henji/spike2/parser/v1', {
  product: 'typescript',
  version: '6.0.3',
  dependencyDigest: builderDependencyDigest,
  subsetManifestDigest: profile.subsetManifestDigest,
  preflightSourceDigest,
});
const compilerDigest = await domainDigest('henji/spike2/compiler/v1', {
  product: 'typescript',
  version: '6.0.3',
  dependencyDigest: builderDependencyDigest,
  compilerOptionsDigest: profile.compilerOptionsDigest,
});

console.log(JSON.stringify({
  schemaVersion: 'builder-identity/v1',
  preflightSourceDigest,
  builderSourceDigest,
  builderDependencyDigest,
  parserDigest,
  compilerDigest,
  runtimeDigest,
  compilerOptionsDigest: profile.compilerOptionsDigest,
  admissionProfileDigest: profile.digest,
  manifests: {
    preflight: preflightManifest,
    builder: builderManifest,
    dependency: dependencyManifest,
  },
  runtime,
}));
