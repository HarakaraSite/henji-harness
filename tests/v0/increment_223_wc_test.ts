import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createToolPathPolicy, type JsonValue, type ToolFactoryInput } from '@henji/tool';
import createWcTool from '../../external-tools/wc/index.ts';

const openWc = async (workspaceRoot: string) => {
  const workspace = { root: await Deno.realPath(workspaceRoot) };
  return await createWcTool({
    workspace,
    pathPolicy: createToolPathPolicy(workspace.root, ['/'], []),
  } as ToolFactoryInput);
};

const execute = async (
  tool: Awaited<ReturnType<typeof openWc>>,
  args: JsonValue,
): Promise<Record<string, unknown>> => {
  const result = await tool.execute(args);
  ok(typeof result === 'string');
  return JSON.parse(result) as Record<string, unknown>;
};

Deno.test('increment 223 wc streams UTF-8 boundaries and pages records while preserving full totals', async () => {
  const base = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-i223-wc-' });
  const workspaceRoot = `${base}/workspace`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  const largeText = `${'a'.repeat(65_534)} 界 b\n`;
  const smallText = 'A\u2003B\r\nC';
  await Deno.writeTextFile(`${workspaceRoot}/large.txt`, largeText);
  await Deno.writeTextFile(`${workspaceRoot}/small.txt`, smallText);
  const tool = await openWc(workspaceRoot);

  try {
    const firstPage = await execute(tool, { files: ['large.txt', 'small.txt'], limit: 1 });
    strictEqual(firstPage.total, 2);
    strictEqual(firstPage.hasMore, true);
    strictEqual(firstPage.nextOffset, 1);
    deepStrictEqual(firstPage.totals, {
      lines: 2,
      words: 6,
      bytes: new TextEncoder().encode(largeText + smallText).byteLength,
    });
    deepStrictEqual(firstPage.pageTotals, {
      lines: 1,
      words: 3,
      bytes: new TextEncoder().encode(largeText).byteLength,
    });
    deepStrictEqual(firstPage.records, [{
      path: 'large.txt',
      lines: 1,
      words: 3,
      bytes: new TextEncoder().encode(largeText).byteLength,
    }]);

    const secondPage = await execute(tool, {
      files: ['large.txt', 'small.txt'],
      offset: 1,
      limit: 1,
    });
    strictEqual(secondPage.hasMore, false);
    strictEqual(secondPage.nextOffset, null);
    deepStrictEqual(secondPage.totals, firstPage.totals);
    deepStrictEqual(secondPage.pageTotals, {
      lines: 1,
      words: 3,
      bytes: new TextEncoder().encode(smallText).byteLength,
    });
    deepStrictEqual(secondPage.records, [{
      path: 'small.txt',
      lines: 1,
      words: 3,
      bytes: new TextEncoder().encode(smallText).byteLength,
    }]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('increment 223 wc reports byte-budget omissions after counting every requested file', async () => {
  const base = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-i223-wc-bytes-' });
  const workspaceRoot = `${base}/workspace`;
  const many = `${workspaceRoot}/many`;
  await Deno.mkdir(many, { recursive: true });
  const files: string[] = [];
  for (let index = 0; index < 4_200; index += 1) {
    const name = `f${String(index).padStart(5, '0')}${'x'.repeat(240)}`;
    const path = `many/${name}`;
    files.push(path);
    await Deno.writeTextFile(`${workspaceRoot}/${path}`, 'x');
  }
  const tool = await openWc(workspaceRoot);

  try {
    const result = await tool.execute({ files, limit: 5_000 });
    ok(typeof result === 'string');
    strictEqual(new TextEncoder().encode(result).byteLength <= 1024 * 1024, true);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    strictEqual(parsed.total, 4_200);
    strictEqual((parsed.omitted as Record<string, unknown>).bytes, true);
    const returned = parsed.returned as number;
    ok(returned < 4_200);
    deepStrictEqual(parsed.totals, { lines: 0, words: 4_200, bytes: 4_200 });
    deepStrictEqual(parsed.pageTotals, { lines: 0, words: returned, bytes: returned });
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
