import {
  buildInputFiles,
  hasDirtyBuildInputs,
  moduleClosureFiles,
} from '../../scripts/build_henji.ts';
import { canonicalToolDefinitionRevisionBytes } from '../../v0/agent/definitions/managed_tool_definition_manifest.ts';
import { HENJI_TOOL_DEFINITION_API_CONTRACT } from '../../v0/agent/runtime/build_manifest.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const digest = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const toolDigest = async (root: string, paths: readonly string[]): Promise<string> =>
  await digest(canonicalToolDefinitionRevisionBytes({
    toolIdentity: 'tool:fixture',
    apiContract: HENJI_TOOL_DEFINITION_API_CONTRACT,
    entry: 'entry.ts',
    files: await Promise.all(paths.map(async (path) => ({
      path,
      bytes: await Deno.readFile(`${root}/${path}`),
      dependencies: [] as const,
    }))),
  }));

const git = async (root: string, ...args: string[]): Promise<void> => {
  const output = await new Deno.Command('git', {
    cwd: root,
    args,
    stdout: 'null',
    stderr: 'piped',
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
};

Deno.test('Increment 78 resource closure follows runtime edges and stops at the contract', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-78-closure-' });
  try {
    await Deno.writeTextFile(`${root}/deno.json`, '{}\n');
    await Deno.writeTextFile(
      `${root}/entry.ts`,
      "import { helper } from './helper.ts';\n" +
        "import { contract } from './contract.ts';\n" +
        "import type { Ignored } from './types.ts';\n" +
        'export const value: Ignored = helper + contract;\n',
    );
    await Deno.writeTextFile(`${root}/helper.ts`, 'export const helper = 1;\n');
    await Deno.writeTextFile(`${root}/contract.ts`, 'export const contract = 2;\n');
    await Deno.writeTextFile(`${root}/types.ts`, 'export type Ignored = number;\n');
    await Deno.writeTextFile(`${root}/unrelated.ts`, 'export const unrelated = 3;\n');

    const paths = await moduleClosureFiles(root, 'entry.ts', {
      config: 'deno.json',
      contractBoundaryFiles: ['contract.ts'],
      identityFiles: [],
    });
    assertEquals(paths, ['entry.ts', 'helper.ts']);

    const first = await toolDigest(root, paths);
    await Deno.writeTextFile(`${root}/unrelated.ts`, 'export const unrelated = 4;\n');
    assertEquals(await toolDigest(root, paths), first);
    await Deno.writeTextFile(`${root}/helper.ts`, 'export const helper = 5;\n');
    assert(await toolDigest(root, paths) !== first);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 78 dirty provenance includes the builder but excludes unrelated files', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-78-dirty-' });
  try {
    await Deno.writeTextFile(`${root}/runtime.ts`, 'export const runtime = 1;\n');
    await Deno.writeTextFile(`${root}/builder.ts`, 'export const builder = 1;\n');
    await Deno.writeTextFile(`${root}/notes.md`, 'baseline\n');
    await git(root, 'init', '-q');
    await git(root, 'add', '.');
    await git(
      root,
      '-c',
      'user.name=Henji Test',
      '-c',
      'user.email=henji-test@example.invalid',
      'commit',
      '-qm',
      'baseline',
    );

    const inputs = ['runtime.ts', 'builder.ts'];
    assert(!(await hasDirtyBuildInputs(root, inputs)));
    await Deno.writeTextFile(`${root}/notes.md`, 'unrelated change\n');
    assert(!(await hasDirtyBuildInputs(root, inputs)));
    await Deno.writeTextFile(`${root}/builder.ts`, 'export const builder = 2;\n');
    assert(await hasDirtyBuildInputs(root, inputs));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 78 current build input graph includes its generator', async () => {
  const inputs = await buildInputFiles(Deno.cwd());
  assert(inputs.includes('scripts/build_henji.ts'));
  assert(inputs.includes('v0/agent/cli/henji_cli.ts'));
  assert(inputs.includes('deno.v0.json'));
});
