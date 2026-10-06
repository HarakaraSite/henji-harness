import { ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';

const TEST_PATH = '/usr/local/bin:/usr/bin:/bin';
const decoder = new TextDecoder();

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

const git = async (cwd: string, home: string, args: readonly string[]): Promise<string> => {
  const output = await new Deno.Command('git', {
    args: [...args],
    cwd,
    env: { PATH: TEST_PATH, HOME: home },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!output.success) {
    throw new Error(`git ${args.join(' ')} failed: ${decoder.decode(output.stderr)}`);
  }
  return decoder.decode(output.stdout);
};

const configureInspection = async (
  configRoot: string,
  gitPath = TEST_PATH,
): Promise<void> => {
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: {},
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'inspection-test',
    revision: 'test',
    instruction: '',
    tools: ['git_inspect', 'search'],
    agents: [],
  });
  await writeJson(`${configRoot}/tools.json`, {
    schemaVersion: 1,
    tools: {
      git_inspect: 'tools/git_inspect',
      search: 'tools/search',
    },
  });
  await copyDirectory(
    new URL('../../external-tools/git_inspect/', import.meta.url).pathname,
    `${configRoot}/tools/git_inspect`,
  );
  await copyDirectory(
    new URL('../../external-tools/search/', import.meta.url).pathname,
    `${configRoot}/tools/search`,
  );
  if (gitPath !== TEST_PATH) {
    const settingsFile = `${configRoot}/tools/git_inspect/settings.ts`;
    const settings = await Deno.readTextFile(settingsFile);
    const changed = settings.replace(
      `export const GIT_PATH = '${TEST_PATH}';`,
      `export const GIT_PATH = ${JSON.stringify(gitPath)};`,
    );
    if (changed === settings) throw new Error('could not configure copied git PATH');
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
): Promise<OpenedWorker> => {
  const data = await createDataClient({ stateRoot, workspaceRoot });
  const descriptor = await data.openSession({
    persistence: 'none',
    agent: 'inspection-test',
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

const callTool = async (
  worker: WorkerHostSession,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const outcome = await worker.submit(
    `bash-tool-call:${JSON.stringify({ name, arguments: args })}`,
  );
  ok(outcome.ok, JSON.stringify(outcome));
  try {
    return JSON.parse(outcome.finalText!) as Record<string, unknown>;
  } catch {
    throw new Error(`${name} returned non-JSON text: ${outcome.finalText}`);
  }
};

const callToolText = async (
  worker: WorkerHostSession,
  name: string,
  args: Record<string, unknown>,
): Promise<string> => {
  const outcome = await worker.submit(
    `bash-tool-call:${JSON.stringify({ name, arguments: args })}`,
  );
  ok(outcome.ok, JSON.stringify(outcome));
  return outcome.finalText ?? '';
};

const makeRepository = async (workspaceRoot: string, home: string): Promise<void> => {
  await Deno.mkdir(`${workspaceRoot}/docs`, { recursive: true });
  await git(workspaceRoot, home, ['init', '-q']);
  await Deno.writeTextFile(`${workspaceRoot}/note.txt`, 'first line\n');
  await Deno.writeTextFile(`${workspaceRoot}/docs/readme.md`, 'docs line\n');
  await git(workspaceRoot, home, ['add', '-A']);
  await git(workspaceRoot, home, [
    '-c',
    'user.name=Henji Test',
    '-c',
    'user.email=henji@example.invalid',
    'commit',
    '-q',
    '-m',
    'initial commit',
  ]);
  await Deno.writeTextFile(`${workspaceRoot}/docs/readme.md`, 'docs line\ndocs second line\n');
  await git(workspaceRoot, home, ['add', 'docs/readme.md']);
  await git(workspaceRoot, home, [
    '-c',
    'user.name=Henji Test',
    '-c',
    'user.email=henji@example.invalid',
    'commit',
    '-q',
    '-m',
    'docs update',
  ]);
  // Working tree state: one unstaged edit and one staged addition.
  await Deno.writeTextFile(`${workspaceRoot}/note.txt`, 'first line\nsecond line\n');
  await Deno.writeTextFile(`${workspaceRoot}/new.txt`, 'brand new\n');
  await git(workspaceRoot, home, ['add', 'new.txt']);
};

Deno.test('increment 201 git_inspect and search entries inspect a workspace read-only', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i201-inspect-' });
  const workspaceRoot = `${base}/workspace`;
  const configRoot = `${base}/config`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await makeRepository(workspaceRoot, base);
  await configureInspection(configRoot);

  const indexBefore = await Deno.readFile(`${workspaceRoot}/.git/index`);
  const statusBefore = await git(workspaceRoot, base, ['status', '--porcelain=v1']);
  const headBefore = await git(workspaceRoot, base, ['rev-parse', 'HEAD']);

  const worker = await openWorker(workspaceRoot, configRoot, `${base}/state`);
  try {
    const status = await callTool(worker.session, 'git_inspect', { op: 'status' });
    ok(String(status.text).includes(' M note.txt'), String(status.text));
    ok(String(status.text).includes('A  new.txt'), String(status.text));
    strictEqual(status.exitCode, 0);

    const diff = await callTool(worker.session, 'git_inspect', { op: 'diff' });
    ok(String(diff.text).includes('+second line'), String(diff.text));
    strictEqual(diff.hasMore, false);

    const stat = await callTool(worker.session, 'git_inspect', { op: 'diff', stat: true });
    ok(String(stat.text).includes('1 file changed'), String(stat.text));

    const staged = await callTool(worker.session, 'git_inspect', {
      op: 'diff',
      staged: true,
    });
    ok(String(staged.text).includes('+brand new'), String(staged.text));

    const scoped = await callTool(worker.session, 'git_inspect', {
      op: 'diff',
      paths: ['docs'],
    });
    strictEqual(scoped.totalLines, 0);
    strictEqual(scoped.text, '');

    const log = await callTool(worker.session, 'git_inspect', { op: 'log', limit: 1 });
    ok(String(log.text).includes('docs update'), String(log.text));
    ok(!String(log.text).includes('initial commit'), String(log.text));
    const older = await callTool(worker.session, 'git_inspect', {
      op: 'log',
      limit: 1,
      offset: 1,
    });
    ok(String(older.text).includes('initial commit'), String(older.text));

    const show = await callTool(worker.session, 'git_inspect', { op: 'show', rev: 'HEAD' });
    ok(String(show.text).includes('docs update'), String(show.text));
    ok(String(show.text).includes('+docs second line'), String(show.text));

    const windowed = await callTool(worker.session, 'git_inspect', {
      op: 'show',
      rev: 'HEAD',
      limit: 1,
    });
    strictEqual(Number(windowed.totalLines) > 1, true);
    strictEqual(windowed.hasMore, true);
    strictEqual(windowed.nextOffset, 1);
    const nextWindow = await callTool(worker.session, 'git_inspect', {
      op: 'show',
      rev: 'HEAD',
      limit: 1,
      offset: windowed.nextOffset as number,
    });
    ok(String(nextWindow.text).length > 0);

    // Argument validation rejects anything outside the fixed operation set.
    for (
      const [args, expected] of [
        [{ op: 'rebase' }, 'op must be one of'],
        [{ op: 'log', rev: '-c' }, 'rev must be HEAD, HEAD~N, or a commit hash'],
        [{ op: 'diff', paths: ['/etc'] }, 'paths must stay within the workspace'],
        [{ op: 'log', staged: true }, 'staged is only supported for op "diff"'],
        [{ op: 'show' }, 'rev is required for op "show"'],
        [{ op: 'status', args: '--porcelain' }, 'unsupported field'],
      ] as ReadonlyArray<readonly [Record<string, unknown>, string]>
    ) {
      const text = await callToolText(worker.session, 'git_inspect', args);
      ok(text.includes(expected), `${JSON.stringify(args)} -> ${text}`);
    }

    // entries mode lists metadata for files and directories.
    const entries = await callTool(worker.session, 'search', {
      mode: 'entries',
      limit: 100,
    });
    const byPath = new Map(
      (entries.records as Array<Record<string, unknown>>).map((record) => [
        String(record.path),
        record,
      ]),
    );
    strictEqual(byPath.get('docs')?.type, 'directory');
    strictEqual(byPath.get('new.txt')?.type, 'file');
    strictEqual(byPath.get('new.txt')?.bytes, 10);
    ok(typeof byPath.get('new.txt')?.modifiedAt === 'string');
    strictEqual(byPath.has('docs/readme.md'), false);

    const deeper = await callTool(worker.session, 'search', {
      mode: 'entries',
      depth: 2,
      limit: 100,
    });
    const deeperPaths = (deeper.records as Array<Record<string, unknown>>).map((record) =>
      String(record.path)
    );
    ok(deeperPaths.includes('docs/readme.md'), deeperPaths.join(','));

    const filtered = await callTool(worker.session, 'search', {
      mode: 'entries',
      glob: '*.txt',
      limit: 100,
    });
    const filteredPaths = (filtered.records as Array<Record<string, unknown>>).map((record) =>
      String(record.path)
    );
    ok(filteredPaths.includes('note.txt'), filteredPaths.join(','));
    ok(!filteredPaths.includes('docs'), filteredPaths.join(','));

    const paged = await callTool(worker.session, 'search', { mode: 'entries', limit: 1 });
    strictEqual(paged.hasMore, true);
    strictEqual(paged.nextOffset, 1);

    const fileScope = await callToolText(worker.session, 'search', {
      mode: 'entries',
      path: 'note.txt',
    });
    ok(fileScope.includes('path must name a directory'), fileScope);
    const depthRejected = await callToolText(worker.session, 'search', {
      mode: 'paths',
      depth: 2,
    });
    ok(depthRejected.includes('depth is only supported'), depthRejected);
  } finally {
    await worker.close();
  }

  // Every inspection above left the repository, index, and worktree unchanged.
  const indexAfter = await Deno.readFile(`${workspaceRoot}/.git/index`);
  strictEqual(indexAfter.byteLength, indexBefore.byteLength);
  ok(indexAfter.every((byte, index) => byte === indexBefore[index]));
  const statusAfter = await git(workspaceRoot, base, ['status', '--porcelain=v1']);
  strictEqual(statusAfter, statusBefore);
  strictEqual(await git(workspaceRoot, base, ['rev-parse', 'HEAD']), headBefore);

  await Deno.remove(base, { recursive: true });
});

Deno.test('increment 201 git_inspect reports missing git and non-repository workspaces', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i201-git-errors-' });
  const plainRoot = `${base}/plain`;
  const missingConfig = `${base}/config-missing`;
  const plainConfig = `${base}/config-plain`;
  await Deno.mkdir(plainRoot, { recursive: true });
  await Deno.writeTextFile(`${plainRoot}/note.txt`, 'no repository here\n');
  await configureInspection(missingConfig, '/nonexistent-henji-test-path');
  await configureInspection(plainConfig);

  const missingWorker = await openWorker(
    plainRoot,
    missingConfig,
    `${base}/state-missing`,
  );
  try {
    const text = await callToolText(missingWorker.session, 'git_inspect', { op: 'status' });
    ok(text.includes('could not find git in its PATH'), text);
  } finally {
    await missingWorker.close();
  }

  const plainWorker = await openWorker(plainRoot, plainConfig, `${base}/state-plain`);
  try {
    const text = await callToolText(plainWorker.session, 'git_inspect', { op: 'status' });
    ok(text.includes('is not a git repository'), text);
  } finally {
    await plainWorker.close();
  }

  await Deno.remove(base, { recursive: true });
});
