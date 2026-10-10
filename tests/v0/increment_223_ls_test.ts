import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createToolPathPolicy, type JsonValue, type ToolFactoryInput } from '@henji/tool';
import createLsTool from '../../external-tools/ls/index.ts';

const openLs = async (workspaceRoot: string, deniedPaths: readonly string[] = []) => {
  const workspace = { root: await Deno.realPath(workspaceRoot) };
  return await createLsTool({
    workspace,
    pathPolicy: createToolPathPolicy(workspace.root, ['/'], deniedPaths),
  } as ToolFactoryInput);
};

const execute = async (
  tool: Awaited<ReturnType<typeof openLs>>,
  args: JsonValue,
): Promise<Record<string, unknown>> => {
  const result = await tool.execute(args);
  ok(typeof result === 'string');
  return JSON.parse(result) as Record<string, unknown>;
};

Deno.test('increment 223 ls lists direct children and distinguishes empty and depth-omitted directories', async () => {
  const base = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-i223-ls-' });
  const workspaceRoot = `${base}/workspace`;
  await Deno.mkdir(`${workspaceRoot}/nested/child`, { recursive: true });
  await Deno.mkdir(`${workspaceRoot}/empty`, { recursive: true });
  await Deno.mkdir(`${workspaceRoot}/private`, { recursive: true });
  await Deno.writeTextFile(`${workspaceRoot}/.dotfile`, 'hidden');
  await Deno.writeTextFile(`${workspaceRoot}/nested/child/file.txt`, 'content');
  await Deno.writeTextFile(`${workspaceRoot}/private/secret.txt`, 'secret');
  const tool = await openLs(workspaceRoot, [`${workspaceRoot}/private`]);

  try {
    const direct = await execute(tool, {});
    strictEqual(direct.path, '.');
    strictEqual(direct.tree, false);
    deepStrictEqual(
      (direct.entries as { name: string }[]).map((entry) => entry.name),
      ['.dotfile', 'empty', 'nested'],
    );
    strictEqual(direct.count, 3);
    strictEqual((direct.entries as Record<string, unknown>[])[0]!.type, 'file');

    const tree = await execute(tool, { tree: true, depth: 1 });
    const treeEntries = tree.entries as Record<string, unknown>[];
    const empty = treeEntries.find((entry) => entry.name === 'empty')!;
    const nested = treeEntries.find((entry) => entry.name === 'nested')!;
    deepStrictEqual(empty.children, []);
    strictEqual(empty.childrenOmitted, undefined);
    deepStrictEqual(nested.children, []);
    strictEqual(nested.childrenOmitted, 'depth');
    strictEqual((tree.omitted as Record<string, unknown>).depth, 1);
    strictEqual((tree.omitted as Record<string, unknown>).bytes, false);

    const limited = await execute(tool, { tree: true, limit: 1 });
    strictEqual(limited.count, 1);
    strictEqual(limited.childrenOmitted, 'limit');
    strictEqual((limited.omitted as Record<string, unknown>).limit, true);

    let denied: unknown;
    try {
      await tool.execute({ path: 'private' });
    } catch (error) {
      denied = error;
    }
    ok(denied instanceof Error);

    await Deno.mkdir(`${workspaceRoot}/real/child`, { recursive: true });
    await Deno.writeTextFile(`${workspaceRoot}/real/child/file.txt`, 'content');
    await Deno.symlink(`${workspaceRoot}/real`, `${workspaceRoot}/alias`);
    await Deno.symlink(`${workspaceRoot}/real/child`, `${workspaceRoot}/real/child-link`);
    const aliasTree = await execute(tool, { path: 'alias', tree: true });
    strictEqual(aliasTree.path, 'alias');
    const childLink = (aliasTree.entries as Record<string, unknown>[]).find((entry) =>
      entry.name === 'child-link'
    )!;
    strictEqual(childLink.type, 'symlink');
    strictEqual(childLink.children, undefined);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('increment 223 ls reports byte-budget omissions within the 1 MiB result limit', async () => {
  const base = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-i223-ls-bytes-' });
  const workspaceRoot = `${base}/workspace`;
  const many = `${workspaceRoot}/many`;
  await Deno.mkdir(many, { recursive: true });
  for (let index = 0; index < 2_200; index += 1) {
    const name = `f${String(index).padStart(4, '0')}${'x'.repeat(230)}`;
    await Deno.writeTextFile(`${many}/${name}`, '');
  }
  const tool = await openLs(workspaceRoot);

  try {
    const result = await tool.execute({ path: 'many', limit: 5_000 });
    ok(typeof result === 'string');
    strictEqual(new TextEncoder().encode(result).byteLength <= 1024 * 1024, true);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    strictEqual((parsed.omitted as Record<string, unknown>).bytes, true);
    ok((parsed.count as number) < 2_200);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('increment 223 ls accounts for depth omission metadata in the tree byte budget', async () => {
  const base = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-i223-ls-depth-bytes-' });
  const workspaceRoot = `${base}/workspace`;
  const many = `${workspaceRoot}/many`;
  await Deno.mkdir(many, { recursive: true });
  for (let index = 0; index < 2_100; index += 1) {
    const name = `d${String(index).padStart(4, '0')}${'x'.repeat(230)}`;
    const directory = `${many}/${name}`;
    await Deno.mkdir(directory);
    await Deno.writeTextFile(`${directory}/child.txt`, '');
  }
  const tool = await openLs(workspaceRoot);

  try {
    const result = await tool.execute({ path: 'many', tree: true, depth: 1, limit: 5_000 });
    ok(typeof result === 'string');
    strictEqual(new TextEncoder().encode(result).byteLength <= 1024 * 1024, true);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const omitted = parsed.omitted as Record<string, unknown>;
    strictEqual(omitted.bytes, true);
    strictEqual(omitted.depth, parsed.count);
    ok((parsed.count as number) < 2_100);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
