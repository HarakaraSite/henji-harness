import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import {
  coreDiscoveryLocation,
  resolveCoreId,
  tryAcquireCoreInstanceLock,
} from '../../v0/agent/runtime/core_discovery.ts';
import { resolveRuntimePaths } from '../../v0/agent/runtime/runtime_paths.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { parseCoreInvocation } from '../../v0/agent/cli/core_cli.ts';
const repo = new URL('../../', import.meta.url).pathname;
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const cli = (args: readonly string[], cwd: string, env: Record<string, string>) =>
  new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--no-prompt',
      '--cached-only',
      '--no-check',
      '--unstable-worker-options',
      '-A',
      '--config',
      `${repo}deno.v0.json`,
      `${repo}v0/agent/cli/henji_cli.ts`,
      ...args,
    ],
    cwd,
    env,
    stdout: 'piped',
    stderr: 'piped',
  });
Deno.test('Increment 152 resolves full and unique prefix IDs and reports ambiguous/stopped targets', () => {
  const ids = ['abc00000-0000-4000-8000-000000000001', 'abc10000-0000-4000-8000-000000000002'];
  strictEqual(resolveCoreId(ids, ids[0]), ids[0]);
  strictEqual(resolveCoreId(ids, 'abc1'), ids[1]);
  throws(
    () => resolveCoreId(ids, 'abc'),
    (e) => e instanceof Error && ids.every((id) => e.message.includes(id)),
  );
  throws(() => resolveCoreId(ids, 'stopped'), /not found or has stopped/);
  throws(
    () => parseCoreInvocation(['status', '--core', ids[0], '--connect', 'http://localhost:1']),
    /mutually exclusive/,
  );
});
Deno.test('Increment 152 CLI lists workspace Core rows and stops only the explicit prefix', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i152-management-' }),
    workspace = `${root}/workspace`,
    other = `${root}/other`;
  await Deno.mkdir(workspace);
  await Deno.mkdir(other);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const processes: Deno.ChildProcess[] = [],
    endpoints: { url: string; coreEpoch: string; pid: number }[] = [];
  const run = async (args: readonly string[], cwd = workspace) => {
    const o = await cli(['core', ...args], cwd, env).output();
    strictEqual(o.code, 0, decode(o.stderr));
    return decode(o.stdout);
  };
  try {
    const empty = JSON.parse(await run(['list', '--json']));
    strictEqual(empty.cores.length, 0);
    const paths = resolveRuntimePaths({ workspace, env });
    let stateExists = true;
    try {
      await Deno.stat(paths.stateRoot);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      stateExists = false;
    }
    strictEqual(stateExists, false);
    for (const cwd of [workspace, workspace, other]) {
      const p = cli(['serve', '--json'], cwd, env).spawn();
      processes.push(p);
      const r = p.stdout.getReader();
      let t = '';
      while (!t.includes('\n')) {
        const x = await r.read();
        if (x.done) throw new Error('serve ended');
        t += decode(x.value);
      }
      r.releaseLock();
      endpoints.push(JSON.parse(t.split('\n')[0]));
    }
    const first = new HenjiApiClient(endpoints[0].url),
      second = new HenjiApiClient(endpoints[1].url);
    const opened = await first.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    strictEqual(opened.kind, 'accepted');
    const rows = JSON.parse(await run(['list', '--json'])).cores as Record<string, unknown>[];
    deepStrictEqual(
      rows.map((c) => c.coreEpoch).sort(),
      endpoints.slice(0, 2).map((c) => c.coreEpoch).sort(),
    );
    strictEqual(
      rows.find((c) => c.coreEpoch === endpoints[0].coreEpoch)!.activeSessionId,
      (await first.coreRead()).activeSessionId,
    );
    strictEqual(rows.find((c) => c.coreEpoch === endpoints[1].coreEpoch)!.activeSessionId, null);
    const human = await run(['list']);
    strictEqual(human.includes('unopened'), true);
    strictEqual(human.includes(endpoints[0].coreEpoch.slice(0, 8)), true);
    deepStrictEqual(JSON.parse(await run(['status', '--json'])).cores, rows);
    const noTarget = await run(['stop']);
    strictEqual(noTarget.includes('--core ID'), true);
    await first.coreRead();
    await second.coreRead();
    const status = JSON.parse(
      await run(['status', '--core', endpoints[0].coreEpoch.slice(0, 8), '--json']),
    );
    strictEqual(status.coreEpoch, endpoints[0].coreEpoch);
    strictEqual(status.pid, endpoints[0].pid);
    await run(['stop', '--core', endpoints[0].coreEpoch.slice(0, 8)]);
    strictEqual((await second.coreRead()).coreEpoch, endpoints[1].coreEpoch);
    const stopped = await cli(['core', 'status', '--core', endpoints[0].coreEpoch], workspace, env)
      .output();
    strictEqual(stopped.code, 1);
    strictEqual(decode(stopped.stderr).includes('has stopped'), true);
    strictEqual(JSON.parse(await run(['list', '--json'])).cores.length, 1);
    strictEqual(JSON.parse(await run(['list', '--json'], other)).cores.length, 1);
  } finally {
    for (const e of endpoints) {
      await cli(['core', 'stop', '--connect', e.url], workspace, env).output();
    }
    for (const p of processes) {
      try {
        p.kill('SIGTERM');
      } catch { /* Already stopped. */ }
      await p.output();
    }
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test('Increment 152 an owned unreachable epoch is listed and cannot be replaced by targeting it', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i152-unreachable-' }),
    workspace = `${root}/workspace`;
  await Deno.mkdir(workspace);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const epoch = crypto.randomUUID();
  const location = await coreDiscoveryLocation(resolveRuntimePaths({ workspace, env }), epoch);
  const lock = await tryAcquireCoreInstanceLock(location);
  if (!lock) throw new Error('missing owner');
  try {
    await Deno.writeTextFile(
      location.endpointPath,
      JSON.stringify({
        ready: true,
        workspace: location.workspace,
        coreEpoch: epoch,
        pid: 1,
        url: 'http://127.0.0.1:1',
        build: buildManifest(),
      }),
    );
    const listed = await cli(['core', 'list', '--json'], workspace, env).output();
    strictEqual(listed.code, 0, decode(listed.stderr));
    strictEqual(JSON.parse(decode(listed.stdout)).cores[0].state, 'unreachable');
    const stopped = await cli(['core', 'stop', '--core', epoch], workspace, env).output();
    strictEqual(stopped.code, 1);
    strictEqual(decode(stopped.stderr).includes('unreachable'), true);
    const listedAgain = await cli(['core', 'list', '--json'], workspace, env).output();
    strictEqual(JSON.parse(decode(listedAgain.stdout)).cores.length, 1);
  } finally {
    await lock.close();
    await Deno.remove(root, { recursive: true });
  }
});
