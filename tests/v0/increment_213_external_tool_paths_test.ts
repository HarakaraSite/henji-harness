import { ok, strictEqual } from 'node:assert';
import { createToolPathPolicy, type ToolFactoryInput, type Workspace } from '@henji/tool';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import lsFactory from '../../external-tools/ls/index.ts';
import wcFactory from '../../external-tools/wc/index.ts';
import { createWebFetchTool } from './helpers/external_web_tools.ts';

const decoder = new TextDecoder();
const TEST_PATH = '/usr/local/bin:/usr/bin:/bin';

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

const configureExternalTools = async (
  configRoot: string,
  deniedPath: string,
): Promise<void> => {
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: {},
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'increment-213-external-paths',
    revision: 'test',
    instruction: '',
    tools: ['git_inspect', 'ls', 'find', 'grep', 'wc'],
    agents: [],
  });
  await writeJson(`${configRoot}/tools.json`, {
    schemaVersion: 1,
    tools: {
      git_inspect: 'tools/git_inspect',
      ls: 'tools/ls',
      find: 'tools/find',
      grep: 'tools/grep',
      wc: 'tools/wc',
    },
  });
  await writeJson(`${configRoot}/tool-paths.json`, {
    schemaVersion: 1,
    deny: [deniedPath],
  });
  for (const name of ['git_inspect', 'ls', 'find', 'grep', 'wc']) {
    const source = decodeURIComponent(
      new URL(`../../external-tools/${name}/`, import.meta.url).pathname,
    );
    await copyDirectory(source, `${configRoot}/tools/${name}`);
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

const openWorker = async (
  workspaceRoot: string,
  configRoot: string,
  stateRoot: string,
): Promise<{ readonly session: WorkerHostSession; readonly close: () => Promise<void> }> => {
  const data = await createDataClient({ stateRoot, workspaceRoot });
  const descriptor = await data.openSession({
    persistence: 'none',
    agent: 'increment-213-external-paths',
    agentChoice: {},
  });
  try {
    const session = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot,
      configRoot,
      credentialRoot: `${stateRoot}/credentials`,
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

const makeRepository = async (workspaceRoot: string, home: string): Promise<void> => {
  await Deno.mkdir(`${workspaceRoot}/private`, { recursive: true });
  await git(workspaceRoot, home, ['init', '-q']);
  await Deno.writeTextFile(`${workspaceRoot}/private/denied.txt`, 'PRIVATE_TOKEN original\n');
  await Deno.writeTextFile(`${workspaceRoot}/visible.txt`, 'VISIBLE_TOKEN original\n');
  await git(workspaceRoot, home, ['add', '-A']);
  await git(workspaceRoot, home, [
    '-c',
    'user.name=Henji Test',
    '-c',
    'user.email=henji@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture commit',
  ]);
  await Deno.writeTextFile(
    `${workspaceRoot}/private/denied.txt`,
    'PRIVATE_TOKEN private-only commit\n',
  );
  await git(workspaceRoot, home, ['add', 'private/denied.txt']);
  await git(workspaceRoot, home, [
    '-c',
    'user.name=Henji Test',
    '-c',
    'user.email=henji@example.invalid',
    'commit',
    '-q',
    '-m',
    'private-only commit',
  ]);
  await Deno.writeTextFile(`${workspaceRoot}/private/denied.txt`, 'PRIVATE_TOKEN changed\n');
  await Deno.writeTextFile(`${workspaceRoot}/visible.txt`, 'VISIBLE_TOKEN changed\n');
};

Deno.test('increment 213 external inspection tools and git_inspect omit common-denied files', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i213-external-paths-' });
  const workspaceRoot = `${base}/workspace`;
  const configRoot = `${base}/config`;
  const deniedPath = `${workspaceRoot}/private`;
  const deniedPathAlias = `${base}/private-alias`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await makeRepository(workspaceRoot, base);
  await Deno.symlink(deniedPath, deniedPathAlias);
  await configureExternalTools(configRoot, deniedPathAlias);
  await Deno.writeTextFile(`${configRoot}/catalog-note.txt`, 'CATALOG_TOKEN config contents\n');
  const credentialRoot = `${base}/state/credentials`;
  await Deno.mkdir(credentialRoot, { recursive: true });
  await Deno.writeTextFile(`${credentialRoot}/dummy`, 'CATALOG_TOKEN excluded fixture\n');
  await Deno.symlink(credentialRoot, `${configRoot}/credential-alias`);

  const worker = await openWorker(workspaceRoot, configRoot, `${base}/state`);
  try {
    const configEntries = await callTool(worker.session, 'ls', {
      path: configRoot,
    });
    const configEntryPaths = (configEntries.entries as Array<Record<string, unknown>>).map(
      (record) => String(record.path),
    );
    ok(configEntryPaths.includes('../config/catalog-note.txt'), configEntryPaths.join(','));
    ok(!configEntryPaths.includes('../config/credential-alias'), configEntryPaths.join(','));
    const configContent = await callTool(worker.session, 'grep', {
      path: configRoot,
      pattern: 'CATALOG_TOKEN',
    });
    const configRecords = configContent.records as Array<Record<string, unknown>>;
    strictEqual(configRecords.length, 1);
    strictEqual(configRecords[0]?.path, '../config/catalog-note.txt');
    ok(String(configRecords[0]?.text).includes('config contents'));

    const content = await callTool(worker.session, 'grep', {
      pattern: 'TOKEN',
      path: '.',
      limit: 100,
    });
    const contentRecords = content.records as Array<Record<string, unknown>>;
    strictEqual(contentRecords.length, 1);
    strictEqual(contentRecords[0]?.path, 'visible.txt');
    ok(String(contentRecords[0]?.text).includes('VISIBLE_TOKEN'));
    ok(!JSON.stringify(content).includes('PRIVATE_TOKEN'));

    const entries = await callTool(worker.session, 'ls', {
      path: '.',
      tree: true,
      depth: 2,
      limit: 100,
    });
    const entryPaths = (entries.entries as Array<Record<string, unknown>>).map((record) =>
      String(record.path)
    );
    ok(!entryPaths.includes('private'), entryPaths.join(','));
    ok(!entryPaths.includes('private/denied.txt'), entryPaths.join(','));

    const found = await callTool(worker.session, 'find', { pattern: '*.txt' });
    ok((found.records as string[]).includes('visible.txt'));
    ok(!(found.records as string[]).includes('private/denied.txt'));
    const stats = await callTool(worker.session, 'wc', { files: ['visible.txt'] });
    strictEqual((stats.records as Array<Record<string, unknown>>)[0]?.path, 'visible.txt');
    const status = await callTool(worker.session, 'git_inspect', { op: 'status' });
    ok(String(status.text).includes('visible.txt'), String(status.text));
    ok(!String(status.text).includes('private/denied.txt'), String(status.text));

    const diff = await callTool(worker.session, 'git_inspect', { op: 'diff' });
    ok(String(diff.text).includes('VISIBLE_TOKEN changed'), String(diff.text));
    ok(!String(diff.text).includes('PRIVATE_TOKEN'), String(diff.text));

    const log = await callTool(worker.session, 'git_inspect', { op: 'log', limit: 10 });
    ok(String(log.text).includes('fixture commit'), String(log.text));
    ok(!String(log.text).includes('private-only commit'), String(log.text));

    const show = await callTool(worker.session, 'git_inspect', { op: 'show', rev: 'HEAD~1' });
    ok(String(show.text).includes('VISIBLE_TOKEN original'), String(show.text));
    ok(!String(show.text).includes('PRIVATE_TOKEN'), String(show.text));
  } finally {
    await worker.close();
    await Deno.remove(base, { recursive: true });
  }
});

for (const restricted of [false, true]) {
  Deno.test(`increment 213 git_inspect respects ${restricted ? 'subtree allow replacement' : 'child workspace allow'} in the actual Worker`, async () => {
    const base = await Deno.makeTempDir({ prefix: 'henji-i213-git-allow-' });
    const repositoryRoot = `${base}/repo`;
    const app = `${repositoryRoot}/app`;
    const configRoot = `${base}/config`;
    await Deno.mkdir(app, { recursive: true });
    await git(repositoryRoot, base, ['init', '-q']);
    await Deno.writeTextFile(`${app}/inside.txt`, 'INSIDE original\n');
    await Deno.writeTextFile(`${app}/second.txt`, 'SECOND original\n');
    await Deno.writeTextFile(`${app}/gone.txt`, 'GONE original\n');
    await Deno.writeTextFile(`${app}/excluded.txt`, 'EXCLUDED original\n');
    await Deno.writeTextFile(`${repositoryRoot}/outside.txt`, 'OUTSIDE original\n');
    const commit = async (message: string): Promise<void> => {
      await git(repositoryRoot, base, ['add', '-A']);
      await git(repositoryRoot, base, [
        '-c',
        'user.name=Henji Test',
        '-c',
        'user.email=henji@example.invalid',
        'commit',
        '-q',
        '-m',
        message,
      ]);
    };
    await commit('initial commit');
    await Deno.remove(`${app}/gone.txt`);
    await commit('inside deletion');
    await Deno.writeTextFile(`${repositoryRoot}/outside.txt`, 'OUTSIDE committed\n');
    await commit('outside-only commit');
    for (
      const [path, text] of [
        [`${app}/inside.txt`, 'INSIDE changed\n'],
        [`${app}/second.txt`, 'SECOND changed\n'],
        [`${app}/excluded.txt`, 'EXCLUDED changed\n'],
        [`${repositoryRoot}/outside.txt`, 'OUTSIDE changed\n'],
      ]
    ) await Deno.writeTextFile(path, text);
    await configureExternalTools(configRoot, `${app}/excluded.txt`);
    if (restricted) {
      await writeJson(`${configRoot}/tool-paths.json`, {
        schemaVersion: 1,
        deny: [`${app}/excluded.txt`],
        tools: { git_inspect: { allow: [app] } },
      });
    }
    const worker = await openWorker(restricted ? repositoryRoot : app, configRoot, `${base}/state`);
    try {
      const assertOperations = async (paths?: string[]): Promise<void> => {
        for (const op of ['status', 'diff', 'log', 'show']) {
          const output = await callTool(worker.session, 'git_inspect', {
            op,
            ...(op === 'show' ? { rev: 'HEAD~2' } : {}),
            ...(paths === undefined ? {} : { paths }),
          });
          strictEqual(output.exitCode, 0, String(output.text));
          const text = String(output.text);
          if (op === 'log') {
            ok(text.includes('initial commit'), text);
            ok(text.includes('inside deletion'), text);
            ok(!text.includes('outside-only commit'), text);
          } else {
            ok(text.includes('inside.txt'), text);
            ok(!text.includes('outside.txt'), text);
            ok(!text.includes('excluded.txt'), text);
          }
        }
      };
      await assertOperations();
      await assertOperations(['*.txt']);
      const path = restricted ? 'app/inside.txt' : 'inside.txt';
      const selected = await callTool(worker.session, 'git_inspect', { op: 'diff', paths: [path] });
      ok(String(selected.text).includes('INSIDE changed'), String(selected.text));
      ok(!String(selected.text).includes('SECOND'), String(selected.text));
      const glob = restricted ? 'app/*inside*' : '*inside*';
      const selectedGlob = await callTool(worker.session, 'git_inspect', {
        op: 'diff',
        paths: [glob],
      });
      ok(String(selectedGlob.text).includes('INSIDE changed'), String(selectedGlob.text));
      ok(!String(selectedGlob.text).includes('SECOND'), String(selectedGlob.text));
      const gone = restricted ? 'app/gone.txt' : 'gone.txt';
      const historical = await callTool(worker.session, 'git_inspect', {
        op: 'show',
        rev: 'HEAD~2',
        paths: [gone],
      });
      ok(String(historical.text).includes('GONE original'), String(historical.text));
      const deleted = await callTool(worker.session, 'git_inspect', {
        op: 'diff',
        rev: 'HEAD~2',
        paths: [gone],
      });
      ok(String(deleted.text).includes('-GONE original'), String(deleted.text));
      await git(repositoryRoot, base, ['add', 'app/inside.txt', 'outside.txt']);
      const staged = await callTool(worker.session, 'git_inspect', {
        op: 'diff',
        staged: true,
        paths: ['*.txt'],
      });
      ok(String(staged.text).includes('INSIDE changed'), String(staged.text));
      ok(!String(staged.text).includes('OUTSIDE'), String(staged.text));
      await git(repositoryRoot, base, ['rm', '-f', 'app/second.txt']);
      const stagedDeletion = await callTool(worker.session, 'git_inspect', {
        op: 'status',
        paths: [restricted ? 'app/second.txt' : 'second.txt'],
      });
      ok(String(stagedDeletion.text).includes('D  app/second.txt'), String(stagedDeletion.text));
      if (restricted) {
        const outside = await callTool(worker.session, 'git_inspect', {
          op: 'diff',
          staged: true,
          paths: ['outside.txt'],
        });
        strictEqual(outside.text, '');
      }
    } finally {
      await worker.close();
      await Deno.remove(base, { recursive: true });
    }
  });
}

const responseWithBytes = (bytes: Uint8Array): Response => {
  const response = new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: { 'content-type': 'application/octet-stream' },
  });
  Object.defineProperty(response, 'url', { value: 'https://example.com/final' });
  return response;
};

Deno.test('increment 213 web_fetch save_to follows common deny and tool allow paths', async () => {
  const base = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-i213-fetch-paths-' });
  const workspaceRoot = `${base}/workspace`;
  await Deno.mkdir(`${workspaceRoot}/private`, { recursive: true });
  const workspace: Workspace = { root: await Deno.realPath(workspaceRoot) };
  const pathPolicy = createToolPathPolicy(
    workspace.root,
    [workspace.root, '/tmp'],
    [`${workspace.root}/private`],
  );
  const bytes = new Uint8Array([0, 3, 9, 255]);
  let fetchCalls = 0;
  const tool = createWebFetchTool(() => {
    fetchCalls += 1;
    return Promise.resolve(responseWithBytes(bytes));
  }, { workspace, pathPolicy });

  try {
    let denied: unknown;
    try {
      await tool.execute({ url: 'https://example.com/blob', save_to: 'private/denied.bin' });
    } catch (error) {
      denied = error;
    }
    ok(denied instanceof Error);
    strictEqual(fetchCalls, 0);
    try {
      await Deno.stat(`${workspace.root}/private/denied.bin`);
      throw new Error('common-denied target was written');
    } catch (error) {
      ok(error instanceof Deno.errors.NotFound);
    }

    const output = await tool.execute({
      url: 'https://example.com/blob',
      save_to: 'downloads/allowed.bin',
    });
    ok(typeof output === 'string' && output.includes('Status: 200'));
    strictEqual(fetchCalls, 1);
    const saved = await Deno.readFile(`${workspace.root}/downloads/allowed.bin`);
    strictEqual(saved.length, bytes.length);
    ok(saved.every((value, index) => value === bytes[index]));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('increment 213 ls and wc expand allowed home paths and preserves workspace symlink names', async () => {
  const base = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-i213-inspection-home-' });
  const workspaceRoot = `${base}/workspace`;
  const homeRoot = `${base}/home`;
  await Deno.mkdir(`${workspaceRoot}/real`, { recursive: true });
  await Deno.mkdir(`${homeRoot}/docs`, { recursive: true });
  await Deno.writeTextFile(`${homeRoot}/README.md`, 'home document\n');
  await Deno.writeTextFile(`${homeRoot}/docs/article.md`, 'home article\n');
  await Deno.writeTextFile(`${workspaceRoot}/real/alias.md`, 'workspace symlink target\n');
  await Deno.symlink(
    `${workspaceRoot}/real/alias.md`,
    `${workspaceRoot}/alias.md`,
  );

  const workspace: Workspace = { root: await Deno.realPath(workspaceRoot) };
  const home = await Deno.realPath(homeRoot);
  const pathPolicy = createToolPathPolicy(
    workspace.root,
    [workspace.root, home],
    [],
    [],
    home,
  );
  const input = { workspace, pathPolicy } as unknown as ToolFactoryInput;
  const listing = await lsFactory(input);
  const stats = await wcFactory(input);
  const stat = async (path: string): Promise<Record<string, unknown>> =>
    JSON.parse(String(await stats.execute({ files: [path] })));
  const list = async (path: string): Promise<Record<string, unknown>> =>
    JSON.parse(String(await listing.execute({ path })));

  try {
    const homeStats = await stat('~/README.md');
    const homeStat = (homeStats.records as Array<Record<string, unknown>>)[0];
    ok(String(homeStat?.path).endsWith('/home/README.md'), String(homeStat?.path));
    strictEqual(homeStat?.bytes, 'home document\n'.length);

    const homeEntries = await list('~/docs');
    const homeEntry = (homeEntries.entries as Array<Record<string, unknown>>).find((record) =>
      String(record.path).endsWith('/home/docs/article.md')
    );
    ok(homeEntry, JSON.stringify(homeEntries.entries));

    const symlinkStats = await stat('alias.md');
    const symlinkRecord = (symlinkStats.records as Array<Record<string, unknown>>)[0];
    strictEqual(symlinkRecord?.path, 'alias.md');
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
