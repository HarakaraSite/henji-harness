import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import type { JsonValue, ToolFactoryInput } from '../../v0/agent/tool_api.ts';
import { createToolPathPolicy } from '../../v0/agent/tools/tool_paths.ts';
import {
  LinuxProcessExecutor,
  sourceProcessRunnerLaunch,
} from '../../v0/agent/runtime/process_executor.ts';
import { createGrepToolFactory, type GrepToolSettings } from '../../external-tools/grep/index.ts';
import {
  GREP_EXECUTABLE,
  GREP_LANG,
  GREP_LC_ALL,
  GREP_RESULT_BYTES,
  GREP_STDERR_BYTES,
  RIPGREP_EXECUTABLE,
} from '../../external-tools/grep/settings.ts';

const findExecutable = async (name: string): Promise<string> => {
  for (const directory of (Deno.env.get('PATH') ?? '').split(':')) {
    if (!directory) continue;
    const path = `${directory}/${name}`;
    try {
      const info = await Deno.stat(path);
      if (info.isFile && info.mode !== null && (info.mode & 0o111) !== 0) {
        return path;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  throw new Error(`test requires ${name} on PATH`);
};

const settings = (PATH: string): GrepToolSettings => ({
  PATH,
  LANG: GREP_LANG,
  LC_ALL: GREP_LC_ALL,
  rgExecutable: RIPGREP_EXECUTABLE,
  grepExecutable: GREP_EXECUTABLE,
  resultBytes: GREP_RESULT_BYTES,
  stderrBytes: GREP_STDERR_BYTES,
});

const openGrep = async (
  workspaceRoot: string,
  PATH: string,
  deniedPaths: readonly string[] = [],
): Promise<{
  readonly tool: Awaited<ReturnType<ReturnType<typeof createGrepToolFactory>>>;
  readonly close: () => Promise<void>;
}> => {
  const executor = new LinuxProcessExecutor(sourceProcessRunnerLaunch());
  try {
    const tool = await createGrepToolFactory(settings(PATH))({
      workspace: { root: workspaceRoot },
      pathPolicy: createToolPathPolicy(workspaceRoot, ['/'], deniedPaths),
      processExecutor: executor,
    } as unknown as ToolFactoryInput);
    return { tool, close: () => executor.close() };
  } catch (error) {
    await executor.close();
    throw error;
  }
};

const callGrep = async (
  tool: Awaited<ReturnType<ReturnType<typeof createGrepToolFactory>>>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  JSON.parse(String(await tool.execute(args as JsonValue))) as Record<
    string,
    unknown
  >;

const makeFixture = async (root: string): Promise<void> => {
  await Deno.mkdir(`${root}/globset`, { recursive: true });
  await Deno.mkdir(`${root}/private`, { recursive: true });
  await Deno.mkdir(`${root}/.git`, { recursive: true });
  await Deno.writeTextFile(`${root}/.gitignore`, 'globset/ignored.txt\n');
  await Deno.writeTextFile(
    `${root}/context.txt`,
    'before\nHIT first\nafter\nHIT second\nend\n',
  );
  await Deno.writeTextFile(
    `${root}/globset/included.ts`,
    'GLOB_HIT TypeScript\n',
  );
  await Deno.writeTextFile(`${root}/globset/excluded.txt`, 'GLOB_HIT text\n');
  await Deno.writeTextFile(`${root}/globset/ignored.txt`, 'GLOB_HIT ignored\n');
  await Deno.writeTextFile(`${root}/regex.txt`, 'ddd\n123\n');
  await Deno.writeTextFile(`${root}/private/secret.txt`, 'PRIVATE_HIT\n');
  await Deno.symlink(`${root}/private`, `${root}/private-link`);
};

const writeLargeMatches = async (
  path: string,
  count: number,
): Promise<number> => {
  const text = Array.from(
    { length: count },
    (_, index) => `MATCH-${index}-${'x'.repeat(700)}`,
  ).join('\n') + '\n';
  await Deno.writeTextFile(path, text);
  return new TextEncoder().encode(text).byteLength;
};

Deno.test('increment 223 rg search preserves native ignore/glob and completes past result budgets', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i223-grep-rg-' });
  const root = `${base}/workspace`;
  const rgBin = `${base}/rg-bin`;
  await Deno.mkdir(root, { recursive: true });
  await Deno.mkdir(rgBin);
  await makeFixture(root);
  const nativeRg = await findExecutable(RIPGREP_EXECUTABLE);
  await Deno.symlink(nativeRg, `${rgBin}/rg`);
  const largeBytes = await writeLargeMatches(`${root}/large.txt`, 2_200);
  const opened = await openGrep(root, `${rgBin}:/usr/bin:/bin`, [
    `${root}/private`,
  ]);
  try {
    ok(opened.tool.description.includes('Current backend: rg'));

    const context = await callGrep(opened.tool, {
      path: 'context.txt',
      pattern: 'HIT',
      patternKind: 'literal',
      context: 1,
      limit: 1,
    });
    strictEqual(context.backend, 'rg');
    strictEqual(context.ignoreApplied, true);
    strictEqual(context.searchCompleted, true);
    strictEqual(context.total, 2);
    strictEqual(context.returned, 1);
    deepStrictEqual(context.omitted, {
      matches: 1,
      byLimit: 1,
      byResultBytes: 0,
      contexts: 0,
    });
    const contextRecords = context.records as Array<Record<string, unknown>>;
    deepStrictEqual(
      contextRecords.map((record) => [record.line, record.kind]),
      [
        [1, 'context'],
        [2, 'match'],
        [3, 'context'],
      ],
    );
    strictEqual(context.contextReturned, 2);

    const defaultIgnore = await callGrep(opened.tool, {
      path: 'globset',
      pattern: 'GLOB_HIT',
      patternKind: 'literal',
    });
    strictEqual(defaultIgnore.total, 2);
    ok(
      !(defaultIgnore.records as Array<Record<string, unknown>>).some((row) =>
        row.path === 'globset/ignored.txt'
      ),
    );

    const positiveReincludesIgnored = await callGrep(opened.tool, {
      path: 'globset',
      pattern: 'GLOB_HIT',
      patternKind: 'literal',
      glob: ['*.txt'],
    });
    deepStrictEqual(
      (positiveReincludesIgnored.records as Array<Record<string, unknown>>).map(
        (row) => row.path,
      ).sort(),
      ['globset/excluded.txt', 'globset/ignored.txt'],
    );

    const orderedInclude = await callGrep(opened.tool, {
      path: 'globset',
      pattern: 'GLOB_HIT',
      patternKind: 'literal',
      glob: ['!*.ts', '*.ts'],
    });
    deepStrictEqual(
      (orderedInclude.records as Array<Record<string, unknown>>).map((row) => row.path),
      ['globset/included.ts'],
    );
    const orderedExclude = await callGrep(opened.tool, {
      path: 'globset',
      pattern: 'GLOB_HIT',
      patternKind: 'literal',
      glob: ['*.ts', '!*.ts'],
    });
    strictEqual(orderedExclude.total, 0);

    const ignoredWhenRequested = await callGrep(opened.tool, {
      path: 'globset',
      pattern: 'GLOB_HIT',
      patternKind: 'literal',
      includeIgnored: true,
    });
    strictEqual(ignoredWhenRequested.ignoreApplied, false);
    strictEqual(ignoredWhenRequested.total, 3);

    const denied = await callGrep(opened.tool, {
      pattern: 'PRIVATE_HIT',
      patternKind: 'literal',
    });
    strictEqual(denied.total, 0);
    ok(!JSON.stringify(denied).includes('PRIVATE_HIT'));

    const regex = await callGrep(opened.tool, {
      path: 'regex.txt',
      pattern: String.raw`\d+`,
    });
    deepStrictEqual(
      (regex.records as Array<Record<string, unknown>>).map((row) => row.line),
      [2],
    );
    await rejects(
      async () => await opened.tool.execute({ path: 'regex.txt', pattern: '[' }),
      /rg search failed/,
    );

    const files = await callGrep(opened.tool, {
      path: 'context.txt',
      pattern: 'HIT',
      output: 'files',
    });
    strictEqual(files.total, 1);
    strictEqual(files.returned, 1);
    deepStrictEqual(files.records, [{ path: 'context.txt' }]);

    ok(largeBytes > GREP_RESULT_BYTES);
    const large = await callGrep(opened.tool, {
      path: 'large.txt',
      pattern: 'MATCH-',
      patternKind: 'literal',
      limit: 3_000,
    });
    strictEqual(large.total, 2_200);
    ok(
      Number(large.returned) < 2_200,
      'the 1 MiB response budget omits matching records',
    );
    strictEqual((large.records as unknown[]).length, large.returned);
    strictEqual((large.omitted as Record<string, unknown>).byLimit, 0);
    strictEqual(
      (large.omitted as Record<string, unknown>).byResultBytes,
      2_200 - Number(large.returned),
    );
    ok(
      new TextEncoder().encode(JSON.stringify(large)).byteLength <=
        GREP_RESULT_BYTES,
    );
  } finally {
    await opened.close();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('increment 223 rg keeps denied descendants and context budget scoped to the selected match', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i223-grep-rg-scope-' });
  const root = `${base}/workspace`;
  const rgBin = `${base}/rg-bin`;
  const scope = `${root}/sub`;
  await Deno.mkdir(`${scope}/private`, { recursive: true });
  await Deno.mkdir(rgBin);
  await Deno.writeTextFile(`${scope}/ok.txt`, 'MATCH ordinary\n');
  await Deno.symlink('.', `${scope}/private/loop`);
  const leadingContext = 'c'.repeat(1_045_900);
  const matchingLine = `MATCH ${'m'.repeat(1_000)}`;
  await Deno.writeTextFile(
    `${root}/context-budget.txt`,
    `${leadingContext}\n${matchingLine}\n`,
  );
  const nativeRg = await findExecutable(RIPGREP_EXECUTABLE);
  await Deno.symlink(nativeRg, `${rgBin}/rg`);
  const opened = await openGrep(root, `${rgBin}:/usr/bin:/bin`, [
    `${scope}/private`,
  ]);
  try {
    const scoped = await callGrep(opened.tool, {
      path: 'sub',
      pattern: 'MATCH',
      patternKind: 'literal',
    });
    strictEqual(scoped.total, 1);
    deepStrictEqual(scoped.records, [
      { path: 'sub/ok.txt', line: 1, text: 'MATCH ordinary', kind: 'match' },
    ]);

    const context = await callGrep(opened.tool, {
      path: 'context-budget.txt',
      pattern: 'MATCH',
      patternKind: 'literal',
      context: 1,
    });
    strictEqual(context.total, 1);
    strictEqual(context.returned, 1);
    strictEqual(context.contextReturned, 0);
    deepStrictEqual(context.records, [
      {
        path: 'context-budget.txt',
        line: 2,
        text: matchingLine,
        kind: 'match',
      },
    ]);
    ok(
      new TextEncoder().encode(JSON.stringify(context)).byteLength <=
        GREP_RESULT_BYTES,
    );

    const secondLeadingContext = 'c'.repeat(1_040_000);
    const firstMatch = `MATCH ${'m'.repeat(1_000)}`;
    const secondMatch = `MATCH ${'m'.repeat(8_000)}`;
    await Deno.writeTextFile(
      `${root}/context-budget-two-matches.txt`,
      `${secondLeadingContext}\n${firstMatch}\n${secondMatch}\n`,
    );
    const twoMatches = await callGrep(opened.tool, {
      path: 'context-budget-two-matches.txt',
      pattern: 'MATCH',
      patternKind: 'literal',
      context: 1,
    });
    strictEqual(twoMatches.total, 2);
    strictEqual(twoMatches.returned, 2);
    strictEqual(twoMatches.contextReturned, 0);
    strictEqual(
      (twoMatches.omitted as Record<string, unknown>).contexts,
      1,
    );
    deepStrictEqual(
      (twoMatches.records as Array<Record<string, unknown>>).map((
        record,
      ) => [record.line, record.kind]),
      [[2, 'match'], [3, 'match']],
    );
    ok(
      new TextEncoder().encode(JSON.stringify(twoMatches)).byteLength <=
        GREP_RESULT_BYTES,
    );
  } finally {
    await opened.close();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('increment 223 GNU grep fallback returns native regex results and keeps exact totals', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i223-grep-gnu-' });
  const root = `${base}/workspace`;
  const grepBin = `${base}/grep-bin`;
  await Deno.mkdir(root, { recursive: true });
  await Deno.mkdir(grepBin);
  await makeFixture(root);
  const nativeGrep = await findExecutable(GREP_EXECUTABLE);
  await Deno.symlink(nativeGrep, `${grepBin}/grep`);
  const opened = await openGrep(root, grepBin);
  try {
    ok(opened.tool.description.includes('Current backend: grep'));

    const regex = await callGrep(opened.tool, {
      path: 'regex.txt',
      pattern: String.raw`\d+`,
    });
    strictEqual(regex.backend, 'grep');
    strictEqual(regex.ignoreApplied, false);
    deepStrictEqual(
      (regex.records as Array<Record<string, unknown>>).map((row) => row.line),
      [1],
    );

    const context = await callGrep(opened.tool, {
      path: 'context.txt',
      pattern: 'HIT',
      patternKind: 'literal',
      context: 1,
      limit: 1,
    });
    strictEqual(context.total, 2);
    strictEqual(context.returned, 1);
    deepStrictEqual(
      (context.records as Array<Record<string, unknown>>).map((
        record,
      ) => [record.line, record.kind]),
      [[1, 'context'], [2, 'match'], [3, 'context']],
    );
    strictEqual(context.contextReturned, 2);

    const noMatches = await callGrep(opened.tool, {
      path: 'regex.txt',
      pattern: 'not-present',
    });
    strictEqual(noMatches.total, 0);
    deepStrictEqual(noMatches.records, []);

    const matchingFiles = await callGrep(opened.tool, {
      path: 'context.txt',
      pattern: 'HIT',
      output: 'files',
    });
    strictEqual(matchingFiles.total, 1);
    strictEqual(matchingFiles.returned, 1);
    deepStrictEqual(matchingFiles.records, [{ path: 'context.txt' }]);

    const positiveGlob = await callGrep(opened.tool, {
      path: 'globset',
      pattern: 'GLOB_HIT',
      patternKind: 'literal',
      glob: ['*.ts'],
    });
    strictEqual(positiveGlob.ignoreApplied, false);
    deepStrictEqual(
      (positiveGlob.records as Array<Record<string, unknown>>).map((row) => row.path),
      ['globset/included.ts'],
    );
    const ignored = await callGrep(opened.tool, {
      path: 'globset',
      pattern: 'GLOB_HIT',
      patternKind: 'literal',
    });
    strictEqual(ignored.total, 3);

    await rejects(
      async () =>
        await opened.tool.execute({
          path: 'globset',
          pattern: 'GLOB_HIT',
          glob: ['!*.ts'],
        }),
      /grep backend does not support ! glob exclusions/,
    );
    await rejects(
      async () => await opened.tool.execute({ path: 'regex.txt', pattern: '[' }),
      /grep search failed/,
    );

    const largeBytes = await writeLargeMatches(`${root}/large.txt`, 2_200);
    ok(largeBytes > GREP_RESULT_BYTES);
    const large = await callGrep(opened.tool, {
      path: 'large.txt',
      pattern: 'MATCH-',
      patternKind: 'literal',
      limit: 3_000,
    });
    strictEqual(large.total, 2_200);
    ok(
      Number(large.returned) < 2_200,
      'the 1 MiB response budget omits matching records',
    );
    strictEqual((large.records as unknown[]).length, large.returned);
    strictEqual((large.omitted as Record<string, unknown>).byLimit, 0);
    strictEqual(
      (large.omitted as Record<string, unknown>).byResultBytes,
      2_200 - Number(large.returned),
    );
    ok(
      new TextEncoder().encode(JSON.stringify(large)).byteLength <=
        GREP_RESULT_BYTES,
    );
  } finally {
    await opened.close();
    await Deno.remove(base, { recursive: true });
  }
});
