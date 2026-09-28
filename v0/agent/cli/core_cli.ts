import { HenjiApiClient } from '../../api/client.ts';
import { HenjiApiError } from '../../api/client.ts';
import {
  coreCollectionLocation,
  coreDiscoveryLocation,
  coreInstanceOwned,
  listLocalCores,
  type LocalCoreSummary,
  readCoreEndpoint,
  resolveLocalCore,
} from '../runtime/core_discovery.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

export interface CoreInvocation {
  readonly command: 'list' | 'status' | 'stop';
  readonly coreId?: string;
  readonly connect?: string;
  readonly json: boolean;
}

const encoder = new TextEncoder();

const writeStdout = async (text: string): Promise<void> => {
  await Deno.stdout.write(encoder.encode(text));
};

const writeStderr = async (text: string): Promise<void> => {
  await Deno.stderr.write(encoder.encode(text));
};

const parseConnectUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid --connect URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('invalid --connect URL');
  }
  return value;
};

export const parseCoreInvocation = (args: readonly string[]): CoreInvocation => {
  const command = args[0];
  if (command !== 'status' && command !== 'stop' && command !== 'list') {
    throw new Error('expected core list, core status or core stop');
  }
  let connect: string | undefined;
  let coreId: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--connect' && command !== 'list') {
      const value = args[++index];
      if (connect !== undefined || value === undefined || value.startsWith('--')) {
        throw new Error('invalid --connect');
      }
      connect = parseConnectUrl(value);
    } else if (flag === '--core' && command !== 'list') {
      const value = args[++index];
      if (coreId !== undefined || !value || value.startsWith('--')) {
        throw new Error('invalid --core');
      }
      coreId = value;
    } else if (flag === '--json' && command !== 'stop') {
      if (json) throw new Error('duplicate --json');
      json = true;
    } else {
      throw new Error(`unexpected core ${command} option ${flag}`);
    }
  }
  if (coreId !== undefined && connect !== undefined) {
    throw new Error('--core and --connect are mutually exclusive');
  }
  return {
    command,
    ...(connect === undefined ? {} : { connect }),
    ...(coreId === undefined ? {} : { coreId }),
    json,
  };
};

const shortCoreId = (core: LocalCoreSummary, cores: readonly LocalCoreSummary[]): string => {
  let length = Math.min(8, core.coreEpoch.length);
  while (
    cores.some((other) =>
      other.coreEpoch !== core.coreEpoch &&
      other.coreEpoch.startsWith(core.coreEpoch.slice(0, length))
    )
  ) length += 1;
  return core.coreEpoch.slice(0, length);
};

const list = async (invocation: CoreInvocation): Promise<number> => {
  const paths = resolveRuntimePaths();
  const workspace = (await coreCollectionLocation(paths)).workspace;
  const cores = (await listLocalCores(paths)).map((candidate) => candidate.summary);
  if (invocation.json) {
    await writeStdout(`${JSON.stringify({ kind: 'core.list', workspace, cores })}\n`);
  } else {
    const rows = cores.map((core) => {
      const session = core.activeSessionId == null
        ? 'unopened'
        : `${core.activeSessionId.slice(0, 8)} ${core.title ?? 'untitled'}`;
      return `${shortCoreId(core, cores)} · pid ${core.pid ?? '?'} · ${core.state} · ${session} · ${
        core.phase ?? '?'
      } · ${core.url ?? '?'}\n`;
    });
    await writeStdout(
      `Cores · ${workspace}\n${rows.length === 0 ? 'No core is running.\n' : rows.join('')}`,
    );
  }
  return 0;
};

const status = async (invocation: CoreInvocation): Promise<number> => {
  if (invocation.connect === undefined && invocation.coreId === undefined) {
    return await list(invocation);
  }
  const connection = invocation.coreId === undefined
    ? undefined
    : await resolveLocalCore(resolveRuntimePaths(), invocation.coreId);
  const client = new HenjiApiClient(connection?.endpoint.url ?? invocation.connect!);
  const core = connection?.core ?? await client.coreRead();
  const result = {
    kind: 'core.status',
    running: true,
    workspace: core.workspace,
    coreEpoch: core.coreEpoch,
    url: client.baseUrl.replace(/\/api\/v1$/u, ''),
    ...(connection === undefined ? {} : { pid: connection.endpoint.pid }),
    build: core.build,
    activeSessionId: core.activeSessionId,
    phase: core.phase,
  };
  await writeStdout(
    invocation.json
      ? `${JSON.stringify(result)}\n`
      : `Core running · ${core.workspace}\n${result.url}\n${core.coreEpoch}\n`,
  );
  return 0;
};

const waitUntilStopped = async (
  client: HenjiApiClient,
  coreEpoch: string,
): Promise<void> => {
  while (true) {
    try {
      const current = await client.coreRead();
      if (current.coreEpoch !== coreEpoch) return;
    } catch (error) {
      if (
        !(error instanceof HenjiApiError) || error.status === 404
      ) return;
      if (error.status === 503) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const waitUntilLocalCoreReleased = async (
  location: Awaited<ReturnType<typeof coreDiscoveryLocation>>,
): Promise<void> => {
  while (await coreInstanceOwned(location)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const stop = async (invocation: CoreInvocation): Promise<number> => {
  if (invocation.connect === undefined && invocation.coreId === undefined) {
    await list(invocation);
    await writeStdout('Specify --core ID or --connect URL to stop one Core.\n');
    return 0;
  }
  const connection = invocation.coreId === undefined
    ? undefined
    : await resolveLocalCore(resolveRuntimePaths(), invocation.coreId);
  const client = new HenjiApiClient(connection?.endpoint.url ?? invocation.connect!);
  const core = connection?.core ?? await client.coreRead();
  const hasPaths = Deno.env.get('HOME') !== undefined ||
    ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].every((key) =>
      Deno.env.get(key) !== undefined
    );
  const paths = hasPaths ? resolveRuntimePaths() : undefined;
  let local: Awaited<ReturnType<typeof coreDiscoveryLocation>> | undefined;
  if (paths !== undefined) {
    try {
      const candidate = await coreDiscoveryLocation({
        workspace: core.workspace,
        stateRoot: paths.stateRoot,
      }, core.coreEpoch);
      const endpoint = await readCoreEndpoint(candidate);
      if (endpoint?.url === client.baseUrl.replace(/\/api\/v1$/u, '')) local = candidate;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const result = await client.coreShutdown({ commandId: crypto.randomUUID() });
  if (result.kind !== 'accepted') {
    throw new Error('Core shutdown was not accepted');
  }
  await waitUntilStopped(client, core.coreEpoch);
  if (local !== undefined) await waitUntilLocalCoreReleased(local);
  await writeStdout(`Core stopped · ${core.workspace}\n`);
  return 0;
};

export const main = async (args: readonly string[]): Promise<number> => {
  try {
    const invocation = parseCoreInvocation(args);
    return invocation.command === 'list'
      ? await list(invocation)
      : invocation.command === 'status'
      ? await status(invocation)
      : await stop(invocation);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'core command failed';
    await writeStderr(`core command failed: ${message}\n`);
    return 1;
  }
};
