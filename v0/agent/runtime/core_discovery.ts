import { HenjiApiClient } from '../../api/client.ts';
import type { CoreReadView } from '../../api/contract.ts';
import { workspaceDigest } from '../session/session_store_paths.ts';
import { type BuildManifestV1, isBuildManifest } from './build_manifest.ts';
import { runtimeProcessRunnerLaunch } from './process_executor.ts';
import type { RuntimePaths } from './runtime_paths.ts';

export interface CoreEndpoint {
  readonly ready: true;
  readonly workspace: string;
  readonly coreEpoch: string;
  readonly pid: number;
  readonly url: string;
  readonly build: BuildManifestV1;
}

export interface CoreDiscoveryLocation {
  readonly workspace: string;
  readonly stateRoot: string;
  readonly directory: string;
  readonly endpointPath: string;
  readonly coreEpoch: string;
}

export interface CoreFileLock {
  close(): Promise<void>;
}

export interface CoreConnection {
  readonly endpoint: CoreEndpoint;
  readonly core: CoreReadView;
  readonly reused: boolean;
}

type BootResult =
  | Readonly<{ kind: 'ready'; coreEpoch: string }>
  | Readonly<{ kind: 'failed'; code: string }>;

/** Canonical workspace identifies the collection; epoch identifies one process. */
export const coreCollectionLocation = async (
  paths: Pick<RuntimePaths, 'workspace' | 'stateRoot'>,
): Promise<Pick<CoreDiscoveryLocation, 'workspace' | 'stateRoot' | 'directory'>> => {
  const workspace = await Deno.realPath(paths.workspace);
  return {
    workspace,
    stateRoot: paths.stateRoot,
    directory: `${paths.stateRoot}/cores/${await workspaceDigest(workspace)}`,
  };
};

export const coreDiscoveryLocation = async (
  paths: Pick<RuntimePaths, 'workspace' | 'stateRoot'>,
  coreEpoch: string,
): Promise<CoreDiscoveryLocation> => {
  const collection = await coreCollectionLocation(paths);
  const directory = `${collection.directory}/${coreEpoch}`;
  return { ...collection, directory, coreEpoch, endpointPath: `${directory}/endpoint.json` };
};

const fileLock = (file: Deno.FsFile): CoreFileLock => {
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      closing ??= (async () => {
        try {
          await file.unlock();
        } finally {
          file.close();
        }
      })(),
  };
};

const openLock = async (location: CoreDiscoveryLocation, name: string): Promise<Deno.FsFile> => {
  await Deno.mkdir(location.directory, { recursive: true });
  return await Deno.open(`${location.directory}/${name}.lock`, {
    create: true,
    read: true,
    write: true,
  });
};

export const acquireCoreStartupLock = async (
  location: CoreDiscoveryLocation,
): Promise<CoreFileLock> => {
  const file = await openLock(location, 'startup');
  try {
    await file.lock(true);
    return fileLock(file);
  } catch (error) {
    file.close();
    throw error;
  }
};

export const tryAcquireCoreInstanceLock = async (
  location: CoreDiscoveryLocation,
): Promise<CoreFileLock | undefined> => {
  const file = await openLock(location, 'instance');
  try {
    if (await file.tryLock(true)) return fileLock(file);
    file.close();
    return undefined;
  } catch (error) {
    file.close();
    throw error;
  }
};

/** Inspect an existing lock without creating discovery state for a status query. */
export const coreInstanceOwned = async (location: CoreDiscoveryLocation): Promise<boolean> => {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(`${location.directory}/instance.lock`, { read: true, write: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  try {
    if (!(await file.tryLock(true))) return true;
    await file.unlock();
    return false;
  } finally {
    file.close();
  }
};

const readMetadata = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const removeMetadata = async (path: string): Promise<void> => {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

export const readCoreEndpoint = async (
  location: CoreDiscoveryLocation,
): Promise<CoreEndpoint | undefined> => {
  const value = await readMetadata(location.endpointPath);
  if (typeof value !== 'object' || value === null) return undefined;
  const endpoint = value as CoreEndpoint;
  return endpoint.ready === true && endpoint.workspace === location.workspace &&
      endpoint.coreEpoch === location.coreEpoch && typeof endpoint.pid === 'number' &&
      typeof endpoint.url === 'string' && isBuildManifest(endpoint.build)
    ? endpoint
    : undefined;
};

/** URL reachability alone cannot identify a descriptor left by an older process. */
export const probeCoreEndpoint = async (
  endpoint: CoreEndpoint,
): Promise<CoreReadView | undefined> => {
  try {
    const client = new HenjiApiClient(
      endpoint.url,
      (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(2_000) }),
    );
    const core = await client.coreRead();
    return core.workspace === endpoint.workspace && core.coreEpoch === endpoint.coreEpoch
      ? core
      : undefined;
  } catch {
    return undefined;
  }
};

const atomicMetadata = async (
  location: CoreDiscoveryLocation,
  path: string,
  value: unknown,
): Promise<void> => {
  await Deno.mkdir(location.directory, { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temporary, `${JSON.stringify(value)}\n`);
    await Deno.rename(temporary, path);
  } finally {
    await removeMetadata(temporary);
  }
};

export const publishCoreEndpoint = async (
  location: CoreDiscoveryLocation,
  endpoint: CoreEndpoint,
): Promise<void> => await atomicMetadata(location, location.endpointPath, endpoint);

/** The Core retains its instance lock until this epoch's discovery metadata is removed. */
export const removeCoreEndpoint = async (
  location: CoreDiscoveryLocation,
  coreEpoch: string,
): Promise<void> => {
  if ((await readCoreEndpoint(location))?.coreEpoch !== coreEpoch) return;
  await removeMetadata(location.endpointPath);
};

export const writeCoreBootResult = async (
  location: CoreDiscoveryLocation,
  token: string,
  result: BootResult,
): Promise<void> =>
  await atomicMetadata(location, `${location.directory}/boot.json`, {
    token,
    ...result,
  });

const sourcePath = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);

const spawnCore = (location: CoreDiscoveryLocation, token: string): void => {
  const bootstrap = ['--internal-core-bootstrap', token, location.coreEpoch];
  const args = Deno.build.standalone ? bootstrap : [
    'run',
    '--no-prompt',
    '--cached-only',
    '--unstable-worker-options',
    '-A',
    '--config',
    sourcePath('../../../deno.v0.json'),
    sourcePath('../cli/henji_cli.ts'),
    ...bootstrap,
  ];
  const launch = runtimeProcessRunnerLaunch(Deno.execPath(), args);
  const child = new Deno.Command(launch.executable, {
    args: [...launch.args],
    cwd: location.workspace,
    detached: true,
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  child.unref();
};

/** Prepare a fresh epoch; bootstrap owns only that instance directory. */
export const prepareLocalCore = async (paths: RuntimePaths): Promise<CoreConnection> => {
  const location = await coreDiscoveryLocation(paths, crypto.randomUUID().toLowerCase());
  const startup = await acquireCoreStartupLock(location);
  try {
    const token = crypto.randomUUID();
    spawnCore(location, token);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await readMetadata(`${location.directory}/boot.json`) as
        | (BootResult & { token: string })
        | undefined;
      if (result?.token === token) {
        if (result.kind === 'failed') throw new Error(`Core startup failed: ${result.code}`);
        if (result.kind === 'ready' && result.coreEpoch === location.coreEpoch) {
          const ready = await readCoreEndpoint(location);
          if (ready !== undefined && ready.coreEpoch === result.coreEpoch) {
            const core = await probeCoreEndpoint(ready);
            if (core !== undefined) return { endpoint: ready, core, reused: false };
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Core startup did not become ready; check core status before launching again');
  } finally {
    await startup.close();
  }
};

export interface LocalCoreSummary {
  readonly coreEpoch: string;
  readonly workspace: string;
  readonly state: 'running' | 'unreachable';
  readonly pid?: number;
  readonly url?: string;
  readonly activeSessionId?: string | null;
  readonly title?: string;
  readonly phase?: CoreReadView['phase'];
}

export interface LocalCoreCandidate {
  readonly location: CoreDiscoveryLocation;
  readonly endpoint?: CoreEndpoint;
  readonly core?: CoreReadView;
  readonly summary: LocalCoreSummary;
}

/** Enumerate existing epoch directories without changing discovery or Session state. */
export const listLocalCores = async (
  paths: Pick<RuntimePaths, 'workspace' | 'stateRoot'>,
): Promise<readonly LocalCoreCandidate[]> => {
  const collection = await coreCollectionLocation(paths);
  const epochs: string[] = [];
  try {
    for await (const entry of Deno.readDir(collection.directory)) {
      if (entry.isDirectory) epochs.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const candidates = await Promise.all(
    epochs.sort().map(async (coreEpoch) => {
      const location = await coreDiscoveryLocation(paths, coreEpoch);
      if (!await coreInstanceOwned(location)) return undefined;
      const endpoint = await readCoreEndpoint(location);
      const core = endpoint === undefined ? undefined : await probeCoreEndpoint(endpoint);
      let title: string | undefined;
      if (core?.activeSessionId != null && endpoint !== undefined) {
        try {
          const client = new HenjiApiClient(
            endpoint.url,
            (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(2_000) }),
          );
          title = (await client.sessionRead(core.activeSessionId)).session.position.title;
        } catch {
          // A slot may change or the Core may stop between these read-only queries.
        }
      }
      const summary: LocalCoreSummary = {
        coreEpoch,
        workspace: collection.workspace,
        state: core === undefined ? 'unreachable' : 'running',
        ...(endpoint === undefined ? {} : { pid: endpoint.pid, url: endpoint.url }),
        ...(core === undefined ? {} : { activeSessionId: core.activeSessionId, phase: core.phase }),
        ...(title === undefined ? {} : { title }),
      };
      return { location, endpoint, core, summary };
    }),
  );
  return candidates.filter((candidate): candidate is NonNullable<typeof candidate> =>
    candidate !== undefined
  );
};

/** IDs are process identity; any unambiguous prefix selects the same identity. */
export const resolveCoreId = (epochs: readonly string[], id: string): string => {
  const matches = epochs.filter((epoch) => epoch.startsWith(id));
  if (matches.length === 0) {
    throw new Error(`Core ${id} was not found or has stopped; use hjh core list`);
  }
  if (matches.length > 1) {
    throw new Error(`Core ID ${id} is ambiguous; specify a longer ID:\n${matches.join('\n')}`);
  }
  return matches[0];
};

export const resolveLocalCore = async (
  paths: Pick<RuntimePaths, 'workspace' | 'stateRoot'>,
  id: string,
): Promise<CoreConnection> => {
  const candidates = await listLocalCores(paths);
  const epoch = resolveCoreId(candidates.map((candidate) => candidate.summary.coreEpoch), id);
  const selected = candidates.find((candidate) => candidate.summary.coreEpoch === epoch)!;
  if (selected.endpoint === undefined || selected.core === undefined) {
    throw new Error(
      `Core ${epoch} is unreachable${
        selected.endpoint === undefined ? '' : ` at ${selected.endpoint.url}`
      }`,
    );
  }
  return { endpoint: selected.endpoint, core: selected.core, reused: true };
};
