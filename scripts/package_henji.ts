import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_API_CONTRACT } from '../v0/agent/hook_api.ts';

const toolNames = ['search', 'git_inspect', 'web_search', 'web_fetch'] as const;
const hookNames = ['runtime-start-time'] as const;
const repository = fileURLToPath(new URL('../', import.meta.url));

const sha256 = async (path: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', await Deno.readFile(path)))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');

const copyFolder = async (source: string, target: string): Promise<void> => {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory) await copyFolder(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
};

const fileDigests = async (root: string, prefix = ''): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const entries = await Array.fromAsync(Deno.readDir(join(root, prefix)));
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory) Object.assign(result, await fileDigests(root, path));
    else if (entry.isFile) result[path] = await sha256(join(root, path));
  }
  return result;
};

/** Package the executable, editable tools and hooks without changing a user's configuration. */
export const packageHenji = async (
  binary: string,
  outputDirectory: string,
): Promise<{ folder: string; archive: string }> => {
  const executable = resolve(binary);
  const diagnostic = await new Deno.Command(executable, {
    args: ['diagnostics', 'runtime'],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!diagnostic.success) {
    throw new Error(new TextDecoder().decode(diagnostic.stderr));
  }
  const { build } = JSON.parse(new TextDecoder().decode(diagnostic.stdout));
  const name = `henji-${build.productVersion}-${build.target}-${crypto.randomUUID().slice(0, 8)}`;
  const destination = resolve(outputDirectory);
  await Deno.mkdir(destination, { recursive: true });
  const staging = await Deno.makeTempDir({ dir: destination, prefix: '.henji-package-' });
  const folder = join(staging, name);
  await Deno.mkdir(folder);
  try {
    await Deno.copyFile(executable, join(folder, 'henji'));
    await Deno.chmod(join(folder, 'henji'), 0o755);
    await Deno.copyFile(join(repository, 'scripts/install_henji.sh'), join(folder, 'install.sh'));
    await Deno.chmod(join(folder, 'install.sh'), 0o755);
    await Deno.copyFile(join(repository, 'external-tools/README.md'), join(folder, 'README.md'));
    await Deno.copyFile(join(repository, 'external-hooks/README.md'), join(folder, 'HOOKS.md'));
    await Deno.copyFile(join(repository, 'LICENSE'), join(folder, 'LICENSE'));
    const tools = [];
    for (const name of toolNames) {
      const target = join(folder, 'tools', name);
      await copyFolder(join(repository, 'external-tools', name), target);
      const metadata = JSON.parse(await Deno.readTextFile(join(target, 'tool.json')));
      tools.push({ name, revision: metadata.revision, files: await fileDigests(target) });
    }
    const hooks: Array<{ name: string; contract: string; files: Record<string, string> }> = [];
    for (const name of hookNames) {
      const target = join(folder, 'hooks', name);
      await copyFolder(join(repository, 'external-hooks', name), target);
      hooks.push({ name, contract: HOOK_API_CONTRACT, files: await fileDigests(target) });
    }
    await Deno.writeTextFile(
      join(folder, 'manifest.json'),
      JSON.stringify(
        { schemaVersion: 1, binary: { build, sha256: await sha256(executable) }, tools, hooks },
        null,
        2,
      ) + '\n',
    );
    const archive = join(destination, `${name}.tar.gz`);
    const archived = await new Deno.Command('tar', {
      args: ['-czf', archive, '-C', staging, name],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    if (!archived.success) throw new Error(new TextDecoder().decode(archived.stderr));
    const unpacked = join(destination, name);
    await Deno.rename(folder, unpacked);
    return { folder: unpacked, archive };
  } finally {
    await Deno.remove(staging, { recursive: true });
  }
};

if (import.meta.main) {
  const args = Deno.args;
  let binary = join(repository, 'dist/henji');
  let output = join(repository, 'dist');
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error('usage: package_henji.ts [--binary PATH] [--output-dir DIR]');
    }
    if (args[index] === '--binary') binary = value;
    else if (args[index] === '--output-dir') output = value;
    else throw new Error(`unknown option: ${args[index]}`);
  }
  const result = await packageHenji(binary, output);
  console.log(JSON.stringify(result));
}
