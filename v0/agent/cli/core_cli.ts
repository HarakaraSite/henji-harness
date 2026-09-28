import { HenjiApiClient } from '../../api/client.ts';
import { HenjiApiError } from '../../api/client.ts';
import {
  coreDiscoveryLocation,
  coreInstanceOwned,
  findLocalCore,
  probeCoreEndpoint,
  readCoreEndpoint,
  tryAcquireCoreInstanceLock,
} from '../runtime/core_discovery.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

export interface CoreInvocation {
  readonly command: 'status' | 'stop';
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
  if (command !== 'status' && command !== 'stop') {
    throw new Error('expected core status or core stop');
  }
  let connect: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--connect') {
      const value = args[++index];
      if (connect !== undefined || value === undefined || value.startsWith('--')) {
        throw new Error('invalid --connect');
      }
      connect = parseConnectUrl(value);
    } else if (flag === '--json' && command === 'status') {
      if (json) throw new Error('duplicate --json');
      json = true;
    } else {
      throw new Error(`unexpected core ${command} option ${flag}`);
    }
  }
  return { command, ...(connect === undefined ? {} : { connect }), json };
};

const status = async (invocation: CoreInvocation): Promise<number> => {
  const connection = invocation.connect === undefined
    ? await findLocalCore(resolveRuntimePaths())
    : undefined;
  if (connection === undefined && invocation.connect === undefined) {
    const location = await coreDiscoveryLocation(resolveRuntimePaths());
    const endpoint = await readCoreEndpoint(location);
    if (await coreInstanceOwned(location)) {
      const result = {
        kind: 'core.status',
        running: null,
        workspace: location.workspace,
        state: 'unreachable',
        ...(endpoint === undefined ? {} : { url: endpoint.url }),
      };
      await writeStdout(
        invocation.json
          ? `${JSON.stringify(result)}\n`
          : `Core owns this workspace but is unreachable${
            endpoint === undefined ? '' : ` · ${endpoint.url}`
          }\n`,
      );
      return 0;
    }
    const result = { kind: 'core.status', running: false, workspace: location.workspace };
    await writeStdout(invocation.json ? `${JSON.stringify(result)}\n` : 'No core is running.\n');
    return 0;
  }
  const client = connection === undefined ? new HenjiApiClient(invocation.connect!) : undefined;
  const core = connection?.core ?? await client!.coreRead();
  const result = {
    kind: 'core.status',
    running: true,
    workspace: core.workspace,
    coreEpoch: core.coreEpoch,
    url: connection?.endpoint.url ?? client!.baseUrl.replace(/\/api\/v1$/u, ''),
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
  coreEpoch: string,
): Promise<void> => {
  while (true) {
    const endpoint = await readCoreEndpoint(location);
    if (endpoint !== undefined && endpoint.coreEpoch !== coreEpoch) {
      if (await probeCoreEndpoint(endpoint) !== undefined) return;
    }
    const instance = await tryAcquireCoreInstanceLock(location);
    if (instance !== undefined) {
      await instance.close();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const stop = async (invocation: CoreInvocation): Promise<number> => {
  const paths = invocation.connect === undefined ? resolveRuntimePaths() : undefined;
  const connection = invocation.connect === undefined ? await findLocalCore(paths!) : undefined;
  if (connection === undefined && invocation.connect === undefined) {
    const location = await coreDiscoveryLocation(paths!);
    if (await coreInstanceOwned(location)) {
      const endpoint = await readCoreEndpoint(location);
      throw new Error(
        `Core owns this workspace but is unreachable${
          endpoint === undefined ? '' : ` at ${endpoint.url}`
        }; cannot stop it through HTTP`,
      );
    }
    await writeStdout('No core is running.\n');
    return 0;
  }
  const url = connection?.endpoint.url ?? invocation.connect!;
  const client = new HenjiApiClient(url);
  const core = connection?.core ?? await client.coreRead();
  const result = await client.coreShutdown({ commandId: crypto.randomUUID() });
  if (result.kind !== 'accepted') {
    throw new Error('Core shutdown was not accepted');
  }
  await waitUntilStopped(client, core.coreEpoch);
  if (connection !== undefined) {
    await waitUntilLocalCoreReleased(
      await coreDiscoveryLocation(paths!),
      core.coreEpoch,
    );
  }
  await writeStdout(`Core stopped · ${core.workspace}\n`);
  return 0;
};

export const main = async (args: readonly string[]): Promise<number> => {
  try {
    const invocation = parseCoreInvocation(args);
    return invocation.command === 'status' ? await status(invocation) : await stop(invocation);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'core command failed';
    await writeStderr(`core command failed: ${message}\n`);
    return 1;
  }
};
