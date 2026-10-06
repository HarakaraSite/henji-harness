import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await Deno.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(file, JSON.stringify(value));
};

const copyDirectory = async (source: string, target: string): Promise<void> => {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${target}/${entry.name}`;
    if (entry.isDirectory) await copyDirectory(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
};

const configureSearch = async (
  configRoot: string,
  searchPath?: string,
): Promise<void> => {
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: {},
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'search-test',
    revision: 'test',
    instruction: '',
    tools: ['search'],
    agents: [],
  });
  await writeJson(`${configRoot}/tools.json`, {
    schemaVersion: 1,
    tools: { search: 'tools/search' },
  });
  await copyDirectory(
    new URL('../../external-tools/search/', import.meta.url).pathname,
    `${configRoot}/tools/search`,
  );
  if (searchPath !== undefined) {
    const settingsFile = `${configRoot}/tools/search/settings.ts`;
    const settings = await Deno.readTextFile(settingsFile);
    const changed = settings.replace(
      "export const SEARCH_PATH = '/usr/local/bin:/usr/bin:/bin';",
      `export const SEARCH_PATH = ${JSON.stringify(searchPath)};`,
    );
    if (changed === settings) throw new Error('could not configure copied search PATH');
    await Deno.writeTextFile(settingsFile, changed);
  }
};

interface OpenedWorker {
  readonly session: WorkerHostSession;
  readonly close: () => Promise<void>;
}

const openWorker = async (
  workspaceRoot: string,
  configRoot: string,
  stateRoot: string,
  onProcessStart?: () => void,
): Promise<OpenedWorker> => {
  const data = await createDataClient({ stateRoot, workspaceRoot });
  const descriptor = await data.openSession({
    persistence: 'none',
    agent: 'search-test',
    agentChoice: {},
  });
  try {
    const session = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot,
      configRoot,
      agentChoice: {},
      physicalIoMode: 'provider-free',
      ...(onProcessStart === undefined ? {} : {
        capsuleFactory: (url: URL) => {
          const capsule = new WorkerCapsule(url);
          return {
            send(command: WorkerHostCommand, transfer?: Transferable[]): void {
              capsule.send(command, transfer);
            },
            subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
              return capsule.subscribe((message) => {
                if (
                  message.kind === 'process_request' &&
                  message.request.action === 'start'
                ) onProcessStart();
                listener(message);
              });
            },
            terminate(): void {
              capsule.terminate();
            },
          };
        },
      }),
    });
    return {
      session,
      close: async () => {
        try {
          await session.close();
        } finally {
          await data.close();
        }
      },
    };
  } catch (error) {
    await data.close();
    throw error;
  }
};

const callSearch = async (
  worker: WorkerHostSession,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const outcome = await worker.submit(
    `bash-tool-call:${JSON.stringify({ name: 'search', arguments: args })}`,
  );
  ok(outcome.ok, JSON.stringify(outcome));
  try {
    return JSON.parse(outcome.finalText!) as Record<string, unknown>;
  } catch {
    throw new Error(`search returned non-JSON text: ${outcome.finalText}`);
  }
};

const makeFixture = async (root: string): Promise<void> => {
  await Deno.mkdir(`${root}/src/nested`, { recursive: true });
  await Deno.mkdir(`${root}/notes`, { recursive: true });
  await Deno.mkdir(`${root}/.hidden`, { recursive: true });
  await Deno.writeTextFile(`${root}/.gitignore`, 'notes/*.txt\nnotes/*.count\n');
  await Deno.writeTextFile(`${root}/src/alpha.ts`, 'Needle in alpha\nplain line\n');
  await Deno.writeTextFile(
    `${root}/src/nested/beta.ts`,
    'Another NEEDLE appears\nneedleXYZ suffix\n',
  );
  await Deno.writeTextFile(`${root}/notes/ignored note.txt`, 'Needle in ignored file\n');
  await Deno.writeTextFile(`${root}/notes/a:b.txt`, 'Needle in colon: file\n');
  await Deno.writeTextFile(`${root}/notes/line\nbreak.txt`, 'Needle in newline path\n');
  await Deno.writeTextFile(`${root}/.hidden/secret.txt`, 'Needle in hidden file\n');
  await Deno.mkdir(`${root}/counts`);
  await Deno.writeTextFile(`${root}/counts/repeated.count`, 'henji henji HENJI7\nhenji\n');
  await Deno.writeTextFile(`${root}/.hidden/hidden.count`, 'henji henji\n');
  await Deno.writeTextFile(`${root}/notes/ignored.count`, 'henji\n');
  await Deno.writeTextFile(
    `${root}/src/paged.txt`,
    Array.from({ length: 120 }, (_, index) => `ROW-${index} ${'x'.repeat(180)}`).join('\n') + '\n',
  );
};

Deno.test('increment 186 external search handles rg and grep through WorkerHostSession', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i186-search-' });
  const workspaceRoot = `${base}/workspace`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await makeFixture(workspaceRoot);

  const grepBin = `${base}/grep-bin`;
  await Deno.mkdir(grepBin);
  await Deno.symlink(await Deno.realPath('/usr/bin/grep'), `${grepBin}/grep`);
  const cancelBin = `${base}/cancel-bin`;
  await Deno.mkdir(cancelBin);
  const slowRg = `${cancelBin}/rg`;
  await Deno.writeTextFile(slowRg, '#!/bin/sh\nsleep 30\nexec /usr/bin/rg "$@"\n');
  await Deno.chmod(slowRg, 0o755);

  const rgConfig = `${base}/config-rg`;
  const grepConfig = `${base}/config-grep`;
  const cancelConfig = `${base}/config-cancel`;
  await configureSearch(rgConfig);
  await configureSearch(grepConfig, grepBin);
  await configureSearch(cancelConfig, `${cancelBin}:/usr/bin:/bin`);

  const opened: OpenedWorker[] = [];
  try {
    const rgWorker = await openWorker(
      workspaceRoot,
      rgConfig,
      `${base}/state-rg`,
    );
    opened.push(rgWorker);
    const paths = await callSearch(rgWorker.session, {
      mode: 'paths',
      glob: '**/*.ts',
    });
    strictEqual(paths.backend, undefined);
    deepStrictEqual(paths.records, ['src/alpha.ts', 'src/nested/beta.ts']);

    const rgFiles = await callSearch(rgWorker.session, {
      mode: 'files',
      pattern: 'needle',
      patternKind: 'literal',
      caseSensitive: false,
      glob: '*.txt',
    });
    strictEqual(rgFiles.backend, 'rg');
    deepStrictEqual(rgFiles.records, [
      '.hidden/secret.txt',
      'notes/a:b.txt',
      'notes/ignored note.txt',
      'notes/line\nbreak.txt',
    ]);
    strictEqual(rgFiles.hasMore, false);
    strictEqual(rgFiles.nextOffset, null);

    const regexRequest = {
      mode: 'content',
      path: 'src',
      glob: '**/*.ts',
      pattern: 'needle.*',
      patternKind: 'regex',
      caseSensitive: false,
      limit: 10,
    };
    const rgRegex = await callSearch(rgWorker.session, regexRequest);
    strictEqual(rgRegex.backend, 'rg');
    deepStrictEqual(rgRegex.records, [
      { path: 'src/alpha.ts', line: 1, text: 'Needle in alpha' },
      { path: 'src/nested/beta.ts', line: 1, text: 'Another NEEDLE appears' },
      { path: 'src/nested/beta.ts', line: 2, text: 'needleXYZ suffix' },
    ]);
    const rgColonPath = await callSearch(rgWorker.session, {
      mode: 'content',
      path: 'notes',
      pattern: 'Needle in colon',
      patternKind: 'literal',
    });
    deepStrictEqual(rgColonPath.records, [
      { path: 'notes/a:b.txt', line: 1, text: 'Needle in colon: file' },
    ]);
    const rgNewlinePath = await callSearch(rgWorker.session, {
      mode: 'content',
      path: 'notes',
      pattern: 'Needle in newline path',
      patternKind: 'literal',
    });
    deepStrictEqual(rgNewlinePath.records, [
      { path: 'notes/line\nbreak.txt', line: 1, text: 'Needle in newline path' },
    ]);

    const noMatch = await callSearch(rgWorker.session, {
      mode: 'files',
      pattern: 'not-present-in-fixture',
      patternKind: 'literal',
    });
    strictEqual(noMatch.total, 0);
    strictEqual(noMatch.hasMore, false);
    deepStrictEqual(noMatch.records, []);

    const firstPage = await callSearch(rgWorker.session, {
      mode: 'content',
      path: 'src/paged.txt',
      pattern: 'ROW-',
      patternKind: 'literal',
      offset: 0,
      limit: 30,
    });
    strictEqual(firstPage.total, 120);
    strictEqual(firstPage.records instanceof Array ? firstPage.records.length : -1, 30);
    strictEqual(firstPage.hasMore, true);
    strictEqual(firstPage.nextOffset, 30);
    ok(JSON.stringify(firstPage).length > 4_096, 'complete records exceed the old bash window');
    const secondPage = await callSearch(rgWorker.session, {
      mode: 'content',
      path: 'src/paged.txt',
      pattern: 'ROW-',
      patternKind: 'literal',
      offset: 30,
      limit: 30,
    });
    strictEqual(secondPage.records instanceof Array ? secondPage.records.length : -1, 30);
    strictEqual(secondPage.hasMore, true);
    strictEqual(secondPage.nextOffset, 60);
    const finalPage = await callSearch(rgWorker.session, {
      mode: 'content',
      path: 'src/paged.txt',
      pattern: 'ROW-',
      patternKind: 'literal',
      offset: 90,
      limit: 30,
    });
    strictEqual(finalPage.total, 120);
    strictEqual(finalPage.records instanceof Array ? finalPage.records.length : -1, 30);
    strictEqual(finalPage.hasMore, false);
    strictEqual(finalPage.nextOffset, null);

    const grepWorker = await openWorker(
      workspaceRoot,
      grepConfig,
      `${base}/state-grep`,
    );
    opened.push(grepWorker);
    const grepPaths = await callSearch(grepWorker.session, {
      mode: 'paths',
      glob: '**/*.ts',
    });
    const grepFiles = await callSearch(grepWorker.session, {
      mode: 'files',
      pattern: 'needle',
      patternKind: 'literal',
      caseSensitive: false,
      glob: '*.txt',
    });
    const grepContent = await callSearch(grepWorker.session, regexRequest);
    const grepColonPath = await callSearch(grepWorker.session, {
      mode: 'content',
      path: 'notes',
      pattern: 'Needle in colon',
      patternKind: 'literal',
    });
    const grepNewlinePath = await callSearch(grepWorker.session, {
      mode: 'content',
      path: 'notes',
      pattern: 'Needle in newline path',
      patternKind: 'literal',
    });
    const grepPage = await callSearch(grepWorker.session, {
      mode: 'content',
      path: 'src/paged.txt',
      pattern: 'ROW-',
      patternKind: 'literal',
      offset: 0,
      limit: 30,
    });
    const grepNoMatch = await callSearch(grepWorker.session, {
      mode: 'files',
      pattern: 'not-present-in-fixture',
      patternKind: 'literal',
    });
    deepStrictEqual(grepPaths.records, paths.records);
    strictEqual(grepFiles.backend, 'grep');
    deepStrictEqual(grepFiles.records, rgFiles.records);
    strictEqual(grepContent.backend, 'grep');
    deepStrictEqual(grepContent.records, rgRegex.records);
    deepStrictEqual(grepColonPath.records, rgColonPath.records);
    deepStrictEqual(grepNewlinePath.records, rgNewlinePath.records);
    strictEqual(grepPage.total, 120);
    strictEqual(grepPage.records instanceof Array ? grepPage.records.length : -1, 30);
    strictEqual(grepPage.hasMore, true);
    strictEqual(grepPage.nextOffset, 30);
    deepStrictEqual(grepPage.records, firstPage.records);
    ok(JSON.stringify(grepPage).length > 4_096);
    strictEqual(grepNoMatch.total, 0);
    deepStrictEqual(grepNoMatch.records, []);

    for (const [backend, worker] of [['rg', rgWorker], ['grep', grepWorker]] as const) {
      const selectedFile = {
        path: 'counts/repeated.count',
        pattern: 'henji',
        patternKind: 'literal',
      };
      const matchingLines = await callSearch(worker.session, { mode: 'content', ...selectedFile });
      strictEqual(matchingLines.total, 2);
      const occurrences = await callSearch(worker.session, { mode: 'count', ...selectedFile });
      deepStrictEqual(occurrences, { mode: 'count', backend, matchCount: 3 });
      const insensitive = await callSearch(worker.session, {
        mode: 'count',
        ...selectedFile,
        caseSensitive: false,
      });
      strictEqual(insensitive.matchCount, 4);
      const allFiles = await callSearch(worker.session, {
        mode: 'count',
        pattern: 'henji',
        patternKind: 'literal',
        caseSensitive: false,
        glob: '*.count',
        offset: 1,
        limit: 1,
      });
      deepStrictEqual(allFiles, { mode: 'count', backend, matchCount: 7 });
      const regexCount = await callSearch(worker.session, {
        mode: 'count',
        path: 'counts',
        pattern: 'henji[0-9]*',
        caseSensitive: false,
      });
      strictEqual(regexCount.matchCount, 4);
      const countNoMatch = await callSearch(worker.session, {
        mode: 'count',
        ...selectedFile,
        pattern: 'not-present-in-fixture',
      });
      strictEqual(countNoMatch.matchCount, 0);
      const emptyScope = await callSearch(worker.session, {
        mode: 'count',
        pattern: 'henji',
        glob: '*.absent',
      });
      strictEqual(emptyScope.matchCount, 0);
      const zeroWidth = await callSearch(worker.session, {
        mode: 'count',
        path: 'counts/repeated.count',
        pattern: '^',
      });
      strictEqual(zeroWidth.matchCount, backend === 'rg' ? 2 : 0);
    }

    // Increment 202: text search excludes the DB/blob data that caused the observed crash.
    await Deno.mkdir(`${workspaceRoot}/text-scope`);
    await Deno.writeTextFile(`${workspaceRoot}/text-scope/document.txt`, 'normal-use-inbox\n');
    await Deno.writeTextFile(`${workspaceRoot}/text-scope/archive.db`, 'normal-use-inbox\n');
    await Deno.writeTextFile(`${workspaceRoot}/text-scope/archive.blob`, 'normal-use-inbox\n');
    await Deno.writeTextFile(
      `${workspaceRoot}/text-scope/sqlite.data`,
      'SQLite format 3\0normal-use-inbox\n',
    );
    await Deno.writeTextFile(`${workspaceRoot}/text-scope/binary.data`, '\0normal-use-inbox\n');
    const longLine = 'normal-use-inbox ' + '界'.repeat(600_000) + '\n';
    await Deno.writeTextFile(`${workspaceRoot}/large-line.txt`, longLine);
    const manyLines = ('normal-use-inbox ' + 'x'.repeat(240) + '\n').repeat(40_000);
    await Deno.writeTextFile(`${workspaceRoot}/many-lines.txt`, manyLines);
    const utf16Text = 'normal-use-inbox\n';
    const utf16Bytes = new Uint8Array(2 + utf16Text.length * 2);
    utf16Bytes.set([0xff, 0xfe]);
    for (let index = 0; index < utf16Text.length; index++) {
      utf16Bytes[2 + index * 2] = utf16Text.charCodeAt(index);
    }
    await Deno.writeFile(`${workspaceRoot}/utf16.txt`, utf16Bytes);
    const encodedBlob = new Uint8Array(utf16Bytes.length + 2);
    encodedBlob.set(utf16Bytes);
    await Deno.writeFile(`${workspaceRoot}/text-scope/encoded-blob.data`, encodedBlob);
    const utf16 = await callSearch(rgWorker.session, {
      mode: 'content',
      path: 'utf16.txt',
      pattern: 'normal-use-inbox',
    });
    deepStrictEqual(utf16.records, [
      { path: 'utf16.txt', line: 1, text: 'normal-use-inbox' },
    ], 'keep rg automatic BOM text decoding');
    for (const [backend, worker] of [['rg', rgWorker], ['grep', grepWorker]] as const) {
      const scope = { path: 'text-scope', pattern: 'normal-use-inbox', patternKind: 'literal' };
      const content = await callSearch(worker.session, { mode: 'content', ...scope });
      deepStrictEqual(content.records, [
        { path: 'text-scope/document.txt', line: 1, text: 'normal-use-inbox' },
      ]);
      const matchedFiles = await callSearch(worker.session, { mode: 'files', ...scope });
      deepStrictEqual(matchedFiles.records, ['text-scope/document.txt']);
      const counted = await callSearch(worker.session, { mode: 'count', ...scope });
      deepStrictEqual(counted, { mode: 'count', backend, matchCount: 1 });
      const listing = await callSearch(worker.session, { mode: 'paths', path: 'text-scope' });
      strictEqual(
        (listing.records as string[]).length,
        6,
        'metadata listing still includes binaries',
      );

      const clipped = await callSearch(worker.session, {
        mode: 'content',
        path: 'large-line.txt',
        pattern: 'normal-use-inbox',
      });
      strictEqual(clipped.truncated, true);
      strictEqual(clipped.totalIsExact, true);
      strictEqual(clipped.total, 1);
      ok(new TextEncoder().encode(JSON.stringify(clipped)).byteLength <= 1024 * 1024);
      const text = (clipped.records as { text: string }[])[0]!.text;
      ok(text.startsWith('normal-use-inbox '));
      ok(text.endsWith('\n[truncated]'));
      ok(!text.includes('\ufffd'), 'UTF-8 prefix remains intact');

      const stopped = await callSearch(worker.session, {
        mode: 'content',
        path: 'many-lines.txt',
        pattern: 'normal-use-inbox',
      });
      strictEqual(stopped.truncated, true);
      strictEqual(stopped.totalIsExact, false);
      ok((stopped.total as number) > 100 && (stopped.total as number) < 40_000);
      strictEqual((stopped.records as unknown[]).length, 100);
      const afterLimit = await callSearch(worker.session, { mode: 'content', ...scope });
      deepStrictEqual(afterLimit.records, content.records, 'Worker remains usable after stopping');
    }

    let processStartedResolve!: () => void;
    const processStarted = new Promise<void>((resolveStart) => {
      processStartedResolve = resolveStart;
    });
    const cancelWorker = await openWorker(
      workspaceRoot,
      cancelConfig,
      `${base}/state-cancel`,
      processStartedResolve,
    );
    opened.push(cancelWorker);
    const pending = cancelWorker.session.submit(
      `bash-tool-call:${
        JSON.stringify({
          name: 'search',
          arguments: {
            mode: 'count',
            path: 'src/paged.txt',
            pattern: 'ROW-',
            patternKind: 'literal',
          },
        })
      }`,
    );
    await processStarted;
    strictEqual(cancelWorker.session.cancelActiveTurn(), 'requested');
    const cancelled = await pending;
    strictEqual(cancelled.ok, false);
  } finally {
    for (const worker of opened) await worker.close().catch(() => {});
    await Deno.remove(base, { recursive: true });
  }
});
