import { deepStrictEqual, strictEqual } from 'node:assert';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import {
  coreDiscoveryLocation,
  coreInstanceOwned,
  findLocalCore,
  prepareLocalCore,
  tryAcquireCoreInstanceLock,
} from '../../v0/agent/runtime/core_discovery.ts';
import { resolveRuntimePaths } from '../../v0/agent/runtime/runtime_paths.ts';

const repoRoot = new URL('../../', import.meta.url).pathname;
const configPath = `${repoRoot}deno.v0.json`;
const cliPath = `${repoRoot}v0/agent/cli/henji_cli.ts`;

interface Fixture {
  readonly root: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly environment: Readonly<Record<string, string>>;
}

const fixture = async (): Promise<Fixture> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-increment-145-' });
  const workspaceA = `${root}/workspace-a`;
  const workspaceB = `${root}/workspace-b`;
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

const runCli = async (
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  clearEnv = false,
): Promise<Deno.CommandOutput> =>
  await new Deno.Command(Deno.execPath(), {
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
    clearEnv,
    env: { ...environment },
    stdout: 'piped',
    stderr: 'piped',
  }).output();

const withEnvironment = async <T>(
  environment: Readonly<Record<string, string>>,
  callback: () => Promise<T>,
): Promise<T> => {
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

Deno.test('Increment 145 core status queries without starting or creating discovery state', async () => {
  const selected = await fixture();
  try {
    const output = await runCli(
      ['core', 'status', '--json'],
      selected.workspaceA,
      selected.environment,
    );
    strictEqual(output.code, 0, decode(output.stderr));
    const result = JSON.parse(decode(output.stdout)) as Record<string, unknown>;
    deepStrictEqual(result, {
      kind: 'core.status',
      running: false,
      workspace: await Deno.realPath(selected.workspaceA),
    });
    const location = await coreDiscoveryLocation(
      resolveRuntimePaths({ workspace: selected.workspaceA, env: selected.environment }),
    );
    let exists = true;
    try {
      await Deno.stat(location.directory);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      exists = false;
    }
    strictEqual(exists, false);
  } finally {
    await Deno.remove(selected.root, { recursive: true });
  }
});

Deno.test('Increment 145 status and stop distinguish an unreachable instance owner from no Core', async () => {
  const selected = await fixture();
  const location = await coreDiscoveryLocation(
    resolveRuntimePaths({ workspace: selected.workspaceA, env: selected.environment }),
  );
  await Deno.mkdir(location.directory, { recursive: true });
  await Deno.writeTextFile(
    location.endpointPath,
    `${
      JSON.stringify({
        ready: true,
        workspace: location.workspace,
        coreEpoch: crypto.randomUUID(),
        pid: 1,
        url: 'http://127.0.0.1:1',
        build: buildManifest(),
      })
    }\n`,
  );
  const instance = await tryAcquireCoreInstanceLock(location);
  if (instance === undefined) throw new Error('could not hold test instance lock');
  try {
    strictEqual(await coreInstanceOwned(location), true);
    const status = await runCli(
      ['core', 'status', '--json'],
      selected.workspaceA,
      selected.environment,
    );
    strictEqual(status.code, 0, decode(status.stderr));
    deepStrictEqual(JSON.parse(decode(status.stdout)), {
      kind: 'core.status',
      running: null,
      workspace: location.workspace,
      state: 'unreachable',
      url: 'http://127.0.0.1:1',
    });
    const stop = await runCli(
      ['core', 'stop'],
      selected.workspaceA,
      selected.environment,
    );
    strictEqual(stop.code, 1);
    strictEqual(decode(stop.stderr).includes('Core owns this workspace but is unreachable'), true);
  } finally {
    await instance.close();
    await Deno.remove(selected.root, { recursive: true });
  }
});

Deno.test('Increment 145 launchers share one workspace epoch, isolate workspaces, and stop before relaunch', async () => {
  const selected = await fixture();
  try {
    await withEnvironment(selected.environment, async () => {
      const pathsA = resolveRuntimePaths({
        workspace: selected.workspaceA,
        env: selected.environment,
      });
      const pathsB = resolveRuntimePaths({
        workspace: selected.workspaceB,
        env: selected.environment,
      });
      const locationA = await coreDiscoveryLocation(pathsA);
      await Deno.mkdir(locationA.directory, { recursive: true });
      await Deno.writeTextFile(
        locationA.endpointPath,
        `${
          JSON.stringify({
            ready: true,
            workspace: locationA.workspace,
            coreEpoch: crypto.randomUUID(),
            pid: 1,
            url: 'http://127.0.0.1:1',
            build: buildManifest(),
          })
        }\n`,
      );
      strictEqual(await findLocalCore(pathsA), undefined);

      const [first, concurrent] = await Promise.all([
        prepareLocalCore(pathsA),
        prepareLocalCore(pathsA),
      ]);
      strictEqual(first.endpoint.coreEpoch, concurrent.endpoint.coreEpoch);
      strictEqual(first.endpoint.workspace, await Deno.realPath(selected.workspaceA));
      strictEqual([first.reused, concurrent.reused].filter(Boolean).length, 1);

      const otherWorkspace = await prepareLocalCore(pathsB);
      strictEqual(otherWorkspace.endpoint.workspace, await Deno.realPath(selected.workspaceB));
      strictEqual(otherWorkspace.endpoint.coreEpoch === first.endpoint.coreEpoch, false);

      const duplicateServe = await runCli(
        ['serve', '--port', '0', '--json', '--no-session'],
        selected.workspaceA,
        selected.environment,
      );
      strictEqual(duplicateServe.code, 0, decode(duplicateServe.stderr));
      const reused = JSON.parse(decode(duplicateServe.stdout)) as Record<string, unknown>;
      strictEqual(reused.kind, 'core.ready');
      strictEqual(reused.coreEpoch, first.endpoint.coreEpoch);
      strictEqual(reused.reused, true);

      const invalidServe = await runCli(
        ['serve', '--unsupported-option', 'value'],
        selected.workspaceA,
        selected.environment,
      );
      strictEqual(invalidServe.code, 1, decode(invalidServe.stdout));
      strictEqual(decode(invalidServe.stdout), '');

      const stoppedA = await runCli(
        ['core', 'stop', '--connect', first.endpoint.url],
        '/tmp',
        {},
        true,
      );
      strictEqual(stoppedA.code, 0, decode(stoppedA.stderr));
      const restarted = await prepareLocalCore(pathsA);
      strictEqual(restarted.endpoint.coreEpoch === first.endpoint.coreEpoch, false);
      const stoppedRestarted = await runCli(
        ['core', 'stop'],
        selected.workspaceA,
        selected.environment,
      );
      strictEqual(stoppedRestarted.code, 0, decode(stoppedRestarted.stderr));
      const stoppedB = await runCli(
        ['core', 'stop'],
        selected.workspaceB,
        selected.environment,
      );
      strictEqual(stoppedB.code, 0, decode(stoppedB.stderr));
    });
  } finally {
    for (const workspace of [selected.workspaceA, selected.workspaceB]) {
      try {
        await runCli(['core', 'stop'], workspace, selected.environment);
      } catch {
        // The Core may not have started or may already have completed its stop.
      }
    }
    await Deno.remove(selected.root, { recursive: true });
  }
});
