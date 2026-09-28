import { deepStrictEqual, strictEqual } from 'node:assert';
import { HenjiApiClient } from '../../v0/api/client.ts';
import {
  coreCollectionLocation,
  coreDiscoveryLocation,
  coreInstanceOwned,
  prepareLocalCore,
} from '../../v0/agent/runtime/core_discovery.ts';
import { resolveRuntimePaths } from '../../v0/agent/runtime/runtime_paths.ts';
const repoRoot = new URL('../../', import.meta.url).pathname;
const configPath = `${repoRoot}deno.v0.json`, cliPath = `${repoRoot}v0/agent/cli/henji_cli.ts`;
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const fixture = async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i151-launcher-' });
  const workspaceA = `${root}/a`, workspaceB = `${root}/b`;
  await Deno.mkdir(workspaceA);
  await Deno.mkdir(workspaceB);
  return {
    root,
    workspaceA,
    workspaceB,
    environment: {
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_DATA_HOME: `${root}/data`,
      XDG_STATE_HOME: `${root}/state`,
    },
  };
};
const cli = (args: readonly string[], cwd: string, env: Record<string, string>, clearEnv = false) =>
  new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--no-prompt',
      '--cached-only',
      '--unstable-worker-options',
      '-A',
      '--config',
      configPath,
      cliPath,
      ...args,
    ],
    cwd,
    env,
    clearEnv,
    stdout: 'piped',
    stderr: 'piped',
  });
const withEnvironment = async <T>(
  env: Record<string, string>,
  callback: () => Promise<T>,
): Promise<T> => {
  const previous = Object.keys(env).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
};
Deno.test('Increment 151 management without a target never starts a Core or creates discovery', async () => {
  const f = await fixture();
  try {
    const out = await cli(['core', 'status', '--json'], f.workspaceA, f.environment).output();
    strictEqual(out.code, 0, decode(out.stderr));
    deepStrictEqual(JSON.parse(decode(out.stdout)), {
      kind: 'core.list',
      workspace: await Deno.realPath(f.workspaceA),
      cores: [],
    });
    const stop = await cli(['core', 'stop'], f.workspaceA, f.environment).output();
    strictEqual(stop.code, 0, decode(stop.stderr));
    strictEqual(decode(stop.stdout).includes('--connect URL'), true);
    const location = await coreCollectionLocation(
      resolveRuntimePaths({ workspace: f.workspaceA, env: f.environment }),
    );
    let exists = true;
    try {
      await Deno.stat(location.directory);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      exists = false;
    }
    strictEqual(exists, false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
Deno.test('Increment 151 simultaneous launchers create independent epochs and explicit URL stop isolates ownership', async () => {
  const f = await fixture();
  const endpoints: { url: string; coreEpoch: string }[] = [];
  try {
    await withEnvironment(f.environment, async () => {
      const paths = resolveRuntimePaths({ workspace: f.workspaceA, env: f.environment });
      const [first, second] = await Promise.all([prepareLocalCore(paths), prepareLocalCore(paths)]);
      endpoints.push(first.endpoint, second.endpoint);
      strictEqual(first.reused, false);
      strictEqual(second.reused, false);
      for (const field of ['pid', 'coreEpoch', 'url'] as const) {
        strictEqual(first.endpoint[field] === second.endpoint[field], false);
      }
      strictEqual(first.core.coreEpoch, first.endpoint.coreEpoch);
      strictEqual(second.core.coreEpoch, second.endpoint.coreEpoch);
      const firstClient = new HenjiApiClient(first.endpoint.url),
        secondClient = new HenjiApiClient(second.endpoint.url);
      const sessions = await Promise.all(
        [firstClient, secondClient].map((c) =>
          c.sessionOpen({ commandId: crypto.randomUUID(), selection: { kind: 'new' } })
        ),
      );
      strictEqual(sessions[0].kind, 'accepted');
      strictEqual(sessions[1].kind, 'accepted');
      strictEqual(
        (await firstClient.coreRead()).activeSessionId ===
          (await secondClient.coreRead()).activeSessionId,
        false,
      );
      const other = await prepareLocalCore(
        resolveRuntimePaths({ workspace: f.workspaceB, env: f.environment }),
      );
      endpoints.push(other.endpoint);
      strictEqual(other.core.workspace, await Deno.realPath(f.workspaceB));
      const stopped = await cli(['core', 'stop', '--connect', first.endpoint.url], '/tmp', {}, true)
        .output();
      strictEqual(stopped.code, 0, decode(stopped.stderr));
      const loc = await coreDiscoveryLocation(paths, first.endpoint.coreEpoch);
      strictEqual(await coreInstanceOwned(loc), false);
      let present = true;
      try {
        await Deno.stat(loc.endpointPath);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        present = false;
      }
      strictEqual(present, false);
      strictEqual((await secondClient.coreRead()).coreEpoch, second.endpoint.coreEpoch);
      strictEqual(
        await coreInstanceOwned(await coreDiscoveryLocation(paths, second.endpoint.coreEpoch)),
        true,
      );
      const noTarget = await cli(['core', 'stop'], f.workspaceA, f.environment).output();
      strictEqual(noTarget.code, 0);
      strictEqual((await secondClient.coreRead()).coreEpoch, second.endpoint.coreEpoch);
      const next = await prepareLocalCore(paths);
      endpoints.push(next.endpoint);
      strictEqual(next.endpoint.coreEpoch === first.endpoint.coreEpoch, false);
    });
  } finally {
    for (const e of endpoints) {
      try {
        await cli(['core', 'stop', '--connect', e.url], f.workspaceA, f.environment).output();
      } catch { /* Already stopped. */ }
    }
    await Deno.remove(f.root, { recursive: true });
  }
});
Deno.test('Increment 151 serve always starts a fresh foreground Core', async () => {
  const f = await fixture();
  const processes: Deno.ChildProcess[] = [];
  const urls: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const process = cli(['serve', '--json'], f.workspaceA, f.environment).spawn();
      processes.push(process);
      const reader = process.stdout.getReader();
      let text = '';
      while (!text.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('serve ended before ready');
        text += decode(chunk.value);
      }
      reader.releaseLock();
      const ready = JSON.parse(text.split('\n')[0]);
      strictEqual(ready.reused, false);
      urls.push(ready.url);
      strictEqual((await new HenjiApiClient(ready.url).coreRead()).coreEpoch, ready.coreEpoch);
      strictEqual((await new HenjiApiClient(ready.url).coreRead()).activeSessionId, null);
    }
    strictEqual(urls[0] === urls[1], false);
    for (const url of urls) {
      strictEqual(
        (await new HenjiApiClient(url).coreRead()).workspace,
        await Deno.realPath(f.workspaceA),
      );
    }
    const invalid = await cli(
      ['serve', '--unsupported-option', 'value'],
      f.workspaceA,
      f.environment,
    ).output();
    strictEqual(invalid.code, 1);
    strictEqual(decode(invalid.stdout), '');
  } finally {
    for (const url of urls) {
      try {
        await cli(['core', 'stop', '--connect', url], f.workspaceA, f.environment).output();
      } catch { /* Already stopped. */ }
    }
    for (const process of processes) {
      try {
        process.kill('SIGTERM');
      } catch { /* Already stopped. */ }
      await process.output();
    }
    await Deno.remove(f.root, { recursive: true });
  }
});
