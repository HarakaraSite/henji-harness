import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from 'node:assert';
import { loadToolPathsConfiguration } from '../../v0/agent/tools/tool_paths.ts';
import { assertRunTypescriptCodeAllowed } from '../../v0/agent/tools/run_typescript_sandbox.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { WorkerConfigurationSnapshot } from '../../v0/agent/worker/worker_configuration.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';

Deno.test('213 common path settings resolve current roots, share deny, and replace tool allow', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-213-config-' });
  const configRoot = `${root}/config`;
  const workspaceRoot = `${root}/workspace`;
  const credentialRoot = `${root}/credentials`;
  try {
    await Deno.mkdir(configRoot);
    await Deno.mkdir(workspaceRoot);
    await Deno.writeTextFile(
      `${configRoot}/tool-paths.json`,
      JSON.stringify({
        schemaVersion: 1,
        deny: ['~/another-app/auth.json'],
        tools: { run_typescript: { allow: ['config'] }, write: { allow: ['workspace', '/tmp'] } },
      }),
    );
    const settings = await loadToolPathsConfiguration({
      configRoot,
      workspaceRoot,
      credentialRoot,
      home: root,
    });
    deepStrictEqual(settings.forTool('read').allowedPaths, ['/']);
    deepStrictEqual(settings.forTool('run_typescript').allowedPaths, [configRoot]);
    deepStrictEqual(settings.forTool('write').allowedPaths, [workspaceRoot, '/tmp']);
    for (
      const name of [
        'read',
        'write',
        'edit',
        'run_typescript',
        'search',
        'git_inspect',
        'web_fetch',
      ]
    ) {
      strictEqual(await settings.forTool(name).allows(`${credentialRoot}/dummy`), false);
      strictEqual(await settings.forTool(name).allows(`${root}/another-app/auth.json`), false);
    }
    strictEqual(await settings.forTool('read').resolve('~/plain.txt'), `${root}/plain.txt`);
    strictEqual(await settings.forTool('read').resolve('note.txt'), `${workspaceRoot}/note.txt`);
    await rejects(() => settings.forTool('read').resolve(`${credentialRoot}/dummy`), /common deny/);
    match(
      settings.forTool('run_typescript').auditDeniedPaths.join('\n'),
      /~\/another-app\/auth.json/,
    );
    strictEqual(
      assertRunTypescriptCodeAllowed(
        'return 42;',
        settings.forTool('run_typescript').auditDeniedPaths,
      ),
      undefined,
    );
    throws(() =>
      assertRunTypescriptCodeAllowed(
        'return Deno.readTextFile("~/another-app/auth.json");',
        settings.forTool('run_typescript').auditDeniedPaths,
      ), /denied path/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('213 actual Worker dispatch reads outside workspace, writes config/tmp, denies common paths, and captures startup policy', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-213-worker-' });
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${root}/config`;
  const credentialRoot = `${root}/credentials`;
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot);
  await Deno.mkdir(credentialRoot);
  await Deno.writeTextFile(`${root}/outside.txt`, 'outside workspace marker');
  await Deno.writeTextFile(`${credentialRoot}/dummy`, 'nonsecret excluded fixture');
  await Deno.writeTextFile(`${root}/excluded.txt`, 'nonsecret additional exclusion');
  await Deno.writeTextFile(`${root}/alias-excluded.txt`, 'nonsecret alias exclusion');
  await Deno.symlink(`${root}/alias-excluded.txt`, `${root}/deny-alias`);
  const config = {
    schemaVersion: 1,
    deny: [`${root}/excluded.txt`, `${root}/deny-alias`],
    tools: { note_reader: { allow: ['/'] } },
  };
  await Deno.mkdir(`${configRoot}/tools/note_reader`, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/tools/note_reader/tool.json`,
    JSON.stringify({
      name: 'note_reader',
      apiContract: 'henji-tool/v1',
      revision: '1',
      entry: 'index.ts',
    }),
  );
  await Deno.writeTextFile(
    `${configRoot}/tools/note_reader/index.ts`,
    `
export default (input) => ({
  name: 'note_reader', fileAccess: 'read', description: 'Read a note using the shared path API.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async execute(args) { return await Deno.readTextFile(await input.pathPolicy.resolve(args.path)); }
});
`,
  );
  await Deno.writeTextFile(
    `${configRoot}/tools.json`,
    JSON.stringify({ schemaVersion: 1, tools: { note_reader: 'tools/note_reader' } }),
  );
  await Deno.writeTextFile(
    `${configRoot}/root.json`,
    JSON.stringify({
      name: 'paths',
      tools: ['read', 'write', 'edit', 'run_typescript', 'bash', 'note_reader'],
      agents: [],
    }),
  );
  await Deno.writeTextFile(
    `${configRoot}/agents.json`,
    JSON.stringify({ schemaVersion: 1, default: 'root.json', agents: {} }),
  );
  await Deno.writeTextFile(`${configRoot}/tool-paths.json`, JSON.stringify(config));
  const data = await createDataClient({ workspaceRoot, stateRoot: `${root}/state` });
  const sessions: WorkerHostSession[] = [];
  const configurations: WorkerConfigurationSnapshot[] = [];
  const open = async (): Promise<WorkerHostSession> => {
    const descriptor = await data.openSession({
      persistence: 'none',
      agent: 'default',
      agentChoice: {},
    });
    const session = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot,
      configRoot,
      credentialRoot,
      agentChoice: {},
      physicalIoMode: 'provider-free',
      onStartupPrepared: (message) => configurations.push(message.configuration),
    });
    sessions.push(session);
    return session;
  };
  const invoke = async (
    session: WorkerHostSession,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const outcome = await session.submit(
      `bash-tool-call:${JSON.stringify({ name, arguments: args })}`,
    );
    ok(outcome.ok, JSON.stringify(outcome));
    return outcome.finalText!;
  };
  try {
    const session = await open();
    const snapshot = session.startupSnapshot();
    ok(snapshot);
    // Configuration snapshot is retained by the ready Worker, independently of model tool schemas.
    const configuration = configurations[0];
    ok(configuration);
    deepStrictEqual(configuration.toolPaths.deny, [
      credentialRoot,
      `${root}/excluded.txt`,
      `${root}/deny-alias`,
    ]);
    const read = configuration.tools.find((tool) => tool.name === 'read')!;
    strictEqual(read.fileAccess, 'read');
    deepStrictEqual(read.paths.allow, ['/']);
    strictEqual(Object.hasOwn(read.contract, 'fileAccess'), false);
    strictEqual(configuration.tools.find((tool) => tool.name === 'bash')!.fileAccess, 'unmanaged');
    match(
      await invoke(session, 'read', { path: `${root}/outside.txt` }),
      /outside workspace marker/,
    );
    strictEqual(
      await invoke(session, 'note_reader', { path: `${root}/outside.txt` }),
      'outside workspace marker',
    );
    match(await invoke(session, 'note_reader', { path: `${credentialRoot}/dummy` }), /common deny/);
    await invoke(session, 'write', { path: `${configRoot}/notes/note.txt`, content: 'before' });
    await invoke(session, 'edit', {
      path: `${configRoot}/notes/note.txt`,
      edits: [{ oldText: 'before', newText: 'after' }],
    });
    strictEqual(await Deno.readTextFile(`${configRoot}/notes/note.txt`), 'after');
    await invoke(session, 'write', { path: `${root}/tmp-note.txt`, content: 'tmp marker' });
    strictEqual(await Deno.readTextFile(`${root}/tmp-note.txt`), 'tmp marker');
    for (
      const path of [
        `${credentialRoot}/dummy`,
        `${root}/excluded.txt`,
        `${root}/alias-excluded.txt`,
      ]
    ) {
      match(await invoke(session, 'read', { path }), /common deny/);
      match(await invoke(session, 'write', { path, content: 'must not write' }), /common deny/);
      match(
        await invoke(session, 'edit', {
          path,
          edits: [{ oldText: 'nonsecret', newText: 'changed' }],
        }),
        /common deny/,
      );
    }
    await Deno.symlink(`${root}/outside.txt`, `${workspaceRoot}/link.txt`);
    match(await invoke(session, 'read', { path: 'link.txt' }), /symlink/);
    strictEqual(
      await invoke(session, 'run_typescript', {
        code: 'return await Deno.readTextFile(henjiConfigRoot + "/notes/note.txt");',
      }),
      '"after"',
    );
    match(
      await invoke(session, 'run_typescript', {
        code: `return await Deno.readTextFile(${JSON.stringify(`${credentialRoot}/dummy`)});`,
      }),
      /denied path/,
    );

    // Updating files does not mutate a running Worker. A new Worker uses the new allow list.
    await Deno.writeTextFile(
      `${configRoot}/tool-paths.json`,
      JSON.stringify({
        ...config,
        tools: { write: { allow: ['config'] }, run_typescript: { allow: ['config'] } },
      }),
    );
    await invoke(session, 'write', { path: 'still-running.txt', content: 'old policy' });
    strictEqual(await Deno.readTextFile(`${workspaceRoot}/still-running.txt`), 'old policy');
    const next = await open();
    match(
      await invoke(next, 'write', { path: 'blocked.txt', content: 'new policy' }),
      /outside tool allow/,
    );
    strictEqual(
      await invoke(next, 'run_typescript', {
        code: 'return await Deno.readTextFile(henjiConfigRoot + "/notes/note.txt");',
      }),
      '"after"',
    );
    match(
      await invoke(next, 'run_typescript', {
        code: `return await Deno.readTextFile(${JSON.stringify(`${root}/outside.txt`)});`,
      }),
      /NotCapable/,
    );
    // Module acquisition is internal runtime IO, independent of target-file allow roots.
    strictEqual(
      await invoke(next, 'run_typescript', {
        code: 'const module = await import("jsr:@std/csv"); return typeof module;',
      }),
      '"object"',
    );
  } finally {
    for (const session of sessions) await session.close();
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});
