import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createFindTool } from '../../external-tools/find/index.ts';
import { FIND_SETTINGS } from '../../external-tools/find/settings.ts';
import type { ToolFactoryInput } from '../../v0/agent/tool_api.ts';
import { createToolPathPolicy } from '../../v0/agent/tools/tool_paths.ts';
import {
  LinuxProcessExecutor,
  sourceProcessRunnerLaunch,
} from '../../v0/agent/runtime/process_executor.ts';

const nativeFd = async (): Promise<string | undefined> => {
  for (const directory of (Deno.env.get('PATH') ?? '').split(':')) {
    try {
      const path = `${directory}/fd`;
      if ((await Deno.stat(path)).isFile) return path;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
};
const fd = await nativeFd();

Deno.test('find GNU fallback preserves native path globs, matches before limiting, and declares its backend', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i223-find-' });
  const root = `${base}/workspace`;
  await Deno.mkdir(`${root}/src/sub`, { recursive: true });
  await Deno.mkdir(`${root}/private`);
  await Deno.writeTextFile(`${root}/src/a.ts`, 'a');
  await Deno.writeTextFile(`${root}/src/sub/b.ts`, 'b');
  await Deno.writeTextFile(`${root}/private/secret.ts`, 'secret');
  await Deno.writeTextFile(`${root}/ignored.ts`, 'ignored');
  await Deno.writeTextFile(`${root}/.gitignore`, 'ignored.ts\n');
  await Deno.writeTextFile(`${base}/outside.ts`, 'outside');
  const executor = new LinuxProcessExecutor(sourceProcessRunnerLaunch());
  try {
    const tool = await createFindTool({
      workspace: { root },
      pathPolicy: createToolPathPolicy(root, ['/'], [`${root}/private`]),
      processExecutor: executor,
    } as unknown as ToolFactoryInput, { ...FIND_SETTINGS, fd: 'henji-no-fd-installed' });
    ok(tool.description.includes('Current backend: find'));
    const paths = JSON.parse(String(await tool.execute({ pattern: 'src/*.ts' })));
    deepStrictEqual(paths.records.sort(), ['src/a.ts', 'src/sub/b.ts']);
    strictEqual(paths.backend, 'find');
    strictEqual(paths.ignoreApplied, false);
    strictEqual(paths.searchCompleted, true);
    const limited = JSON.parse(String(await tool.execute({ pattern: '*.ts', limit: 2 })));
    strictEqual(limited.records.length, 2);
    strictEqual(limited.truncationReason, 'limit');
    strictEqual(limited.searchCompleted, false);
    strictEqual(limited.total, undefined);
    const all = JSON.parse(String(await tool.execute({ pattern: '*.ts' })));
    ok(all.records.includes('ignored.ts'));
    ok(!all.records.includes('private/secret.ts'));
    const outside = JSON.parse(String(await tool.execute({ path: base, pattern: 'outside.ts' })));
    deepStrictEqual(outside.records, [`${base}/outside.ts`]);
    const empty = JSON.parse(String(await tool.execute({ pattern: 'missing-file' })));
    strictEqual(empty.total, 0);
    await rejects(async () => await tool.execute({ exclude: ['*.ts'] }), /backend=find/);
  } finally {
    await executor.close();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test({
  name:
    'find fd prioritizes installed executable, respects ignore, and propagates native glob errors',
  ignore: fd === undefined,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: 'henji-i223-fd-' });
    await Deno.mkdir(`${root}/src/sub`, { recursive: true });
    await Deno.writeTextFile(`${root}/src/a.ts`, 'a');
    await Deno.writeTextFile(`${root}/src/sub/b.ts`, 'b');
    await Deno.writeTextFile(`${root}/ignored.ts`, 'ignored');
    await Deno.writeTextFile(`${root}/.gitignore`, 'ignored.ts\n');
    const executor = new LinuxProcessExecutor(sourceProcessRunnerLaunch());
    try {
      const tool = await createFindTool({
        workspace: { root },
        pathPolicy: createToolPathPolicy(root, ['/'], []),
        processExecutor: executor,
      } as unknown as ToolFactoryInput, { ...FIND_SETTINGS, fd: fd! });
      ok(tool.description.includes('Current backend: fd'));
      const result = JSON.parse(String(await tool.execute({ pattern: 'src/*.ts' })));
      deepStrictEqual(result.records, ['src/a.ts']);
      strictEqual(result.backend, 'fd');
      strictEqual(result.ignoreApplied, true);
      const all = JSON.parse(String(await tool.execute({ pattern: '*.ts' })));
      ok(!all.records.includes('ignored.ts'));
      const included = JSON.parse(
        String(await tool.execute({ pattern: '*.ts', includeIgnored: true })),
      );
      ok(included.records.includes('ignored.ts'));
      strictEqual(included.ignoreApplied, false);
      await rejects(async () => await tool.execute({ pattern: '[' }), /fd failed/);
      const empty = JSON.parse(String(await tool.execute({ pattern: 'missing-file' })));
      strictEqual(empty.total, 0);
      // A nested checkout starts a new native Git ignore boundary.
      await Deno.mkdir(`${root}/.git`);
      await Deno.mkdir(`${root}/inner/.git`, { recursive: true });
      await Deno.writeTextFile(`${root}/.gitignore`, '*.ts\n');
      await Deno.writeTextFile(`${root}/inner/inside.ts`, 'inside');
      const nested = JSON.parse(String(await tool.execute({ path: 'inner', pattern: '*.ts' })));
      deepStrictEqual(nested.records, ['inner/inside.ts']);
    } finally {
      await executor.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});
