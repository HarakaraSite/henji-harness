import { cliErrorMessage, cliErrorText } from './cli_error.ts';
import { type CoreInitialSession, createCoreService } from '../host/core_service.ts';
import { startCoreServer } from '../http/api_worker_client.ts';
import { parseTuiInvocation } from './session_invocation.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import {
  builtinProviderDeclarations,
  loadProviderDeclarations,
  resolveProviderRegistry,
} from '../provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../provider/model_catalog.ts';
import { setActiveProviderDeclarations } from '../provider/provider_runtime.ts';
import {
  acquireCoreStartupLock,
  coreDiscoveryLocation,
  type CoreEndpoint,
  type CoreFileLock,
  publishCoreEndpoint,
  removeCoreEndpoint,
  tryAcquireCoreInstanceLock,
  writeCoreBootResult,
} from '../runtime/core_discovery.ts';
import { buildManifest } from '../runtime/build_manifest.ts';

interface ServeMainOptions {
  readonly bootstrapToken?: string;
  readonly coreEpoch?: string;
}

interface ServeInvocation {
  readonly hostname: string;
  readonly port: number;
  readonly json: boolean;
  readonly sessionArgs: readonly string[];
  readonly openInitialSession: boolean;
}

/** Separate listen options from the existing Session activation options before startup. */
const parseServeInvocation = (args: readonly string[]): ServeInvocation => {
  let hostname = '127.0.0.1';
  let port = 0;
  let json = false;
  let hostSeen = false;
  let portSeen = false;
  let openInitialSession = false;
  const sessionArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      if (json) throw new Error('duplicate --json');
      json = true;
    } else if (flag === '--host') {
      const value = args[++index];
      if (hostSeen) throw new Error('Duplicate --host');
      if (!value || value.startsWith('--')) throw new Error('Missing value for --host');
      hostname = value;
      hostSeen = true;
    } else if (flag === '--port') {
      const value = args[++index];
      if (portSeen || value === undefined || !/^\d+$/.test(value)) {
        throw new Error(
          portSeen
            ? 'Duplicate --port'
            : value === undefined || value.startsWith('--')
            ? 'Missing value for --port'
            : '--port must be an integer from 0 to 65535',
        );
      }
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('--port must be an integer from 0 to 65535');
      }
      portSeen = true;
    } else if (flag === '--new') {
      if (openInitialSession) throw new Error('duplicate Session target');
      openInitialSession = true;
    } else {
      if (
        ![
          '--session',
          '--continue',
          '--no-session',
          '--agent',
          '--agent-file',
          '--max-steps',
          '--provider-timeout-ms',
          '--root-provider',
        ].includes(flag)
      ) throw new Error(`Unknown option '${flag}'`);
      if (flag === '--session' || flag === '--continue' || flag === '--no-session') {
        if (openInitialSession) throw new Error('duplicate Session target');
        openInitialSession = true;
      }
      sessionArgs.push(flag);
      if (flag !== '--continue' && flag !== '--no-session') {
        const value = args[++index];
        if (value === undefined) throw new Error(`missing value for ${flag}`);
        sessionArgs.push(value);
      }
    }
  }
  return { hostname, port, json, sessionArgs, openInitialSession };
};

const encoder = new TextEncoder();

/** Foreground core entry; no terminal acquisition and no implicit task or Session. */
export const main = async (
  args: readonly string[],
  options: ServeMainOptions = {},
): Promise<number> => {
  let service: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let startupLock: CoreFileLock | undefined;
  let instanceLock: CoreFileLock | undefined;
  let location: Awaited<ReturnType<typeof coreDiscoveryLocation>> | undefined;
  let coreEpoch: string | undefined;
  let ownershipCleanup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= server?.shutdown();
  };
  const cleanupOwnership = (): Promise<void> => {
    if (ownershipCleanup !== undefined) return ownershipCleanup;
    ownershipCleanup = (async () => {
      const lock = instanceLock;
      try {
        if (location !== undefined && coreEpoch !== undefined) {
          await removeCoreEndpoint(location, coreEpoch);
        }
      } finally {
        try {
          await lock?.close();
        } finally {
          if (instanceLock === lock) instanceLock = undefined;
        }
      }
    })();
    return ownershipCleanup;
  };
  let signalsInstalled = false;
  try {
    const command = parseServeInvocation(args);
    const paths = resolveRuntimePaths();
    const providerDeclarations = resolveProviderRegistry(
      builtinProviderDeclarations(),
      await loadProviderDeclarations({ configRoot: paths.configRoot }),
    );
    setActiveProviderDeclarations(providerDeclarations);
    const invocation = parseTuiInvocation(
      command.sessionArgs,
      providerDeclarations.map((entry) => entry.providerId),
    );
    const agentChoice = invocation.rawAgentFile === undefined
      ? (invocation.rawAgentName === undefined ? undefined : { name: invocation.rawAgentName })
      : { file: invocation.rawAgentFile };
    const initialSession: CoreInitialSession | undefined = command.openInitialSession
      ? invocation.persistence === 'session'
        ? { kind: 'exact', sessionId: invocation.sessionId! }
        : { kind: invocation.persistence }
      : undefined;
    coreEpoch = options.coreEpoch ?? crypto.randomUUID().toLowerCase();
    location = await coreDiscoveryLocation(paths, coreEpoch);
    if (options.bootstrapToken === undefined) {
      startupLock = await acquireCoreStartupLock(location);
    }
    instanceLock = await tryAcquireCoreInstanceLock(location);
    if (instanceLock === undefined) {
      throw new Error(
        'Core instance is already owned; check its ID or URL',
      );
    }
    service = await createCoreService({
      coreEpoch,
      workspaceRoot: location.workspace,
      stateRoot: paths.stateRoot,
      configRoot: paths.configRoot,
      dataRoot: paths.dataRoot,
      agentChoice,
      physicalIoMode: 'production',
      rootMaxSteps: invocation.rootMaxSteps,
      providerTimeoutMs: invocation.providerTimeoutMs,
      ...(invocation.rootProvider === undefined ? {} : {
        initialModelSelection: defaultModelSelectionFor(invocation.rootProvider),
      }),
      providerDeclarations,
      ...(initialSession === undefined ? {} : { initialSession }),
    });
    const core = service.coreRead();
    coreEpoch = core.coreEpoch;
    server = await startCoreServer(service, {
      hostname: command.hostname,
      port: command.port,
      onServiceClosed: cleanupOwnership,
    });
    const endpoint: CoreEndpoint = {
      ready: true,
      workspace: core.workspace,
      coreEpoch: core.coreEpoch,
      pid: Deno.pid,
      url: server.url,
      build: buildManifest(),
    };
    await publishCoreEndpoint(location, endpoint);
    if (options.bootstrapToken !== undefined) {
      await writeCoreBootResult(location, options.bootstrapToken, {
        kind: 'ready',
        coreEpoch,
      });
    }
    await startupLock?.close();
    startupLock = undefined;
    Deno.addSignalListener('SIGINT', stop);
    Deno.addSignalListener('SIGTERM', stop);
    signalsInstalled = true;
    const ready = {
      kind: 'core.ready',
      apiVersion: core.apiVersion,
      coreEpoch: core.coreEpoch,
      workspace: core.workspace,
      url: server.url,
      pid: Deno.pid,
      reused: false,
    };
    await Deno.stdout.write(
      encoder.encode(
        command.json
          ? `${JSON.stringify(ready)}\n`
          : `Henji core ready · ${core.workspace}\n${server.url}\n`,
      ),
    );
    await server.finished;
    return 0;
  } catch (error) {
    if (location !== undefined && options.bootstrapToken !== undefined) {
      try {
        await writeCoreBootResult(location, options.bootstrapToken, {
          kind: 'failed',
          code: 'startup_failed',
        });
      } catch {
        // The launcher will report that this Core did not become ready.
      }
    }
    await Deno.stderr.write(
      encoder.encode(cliErrorText('serve', cliErrorMessage(error), true)),
    );
    return 1;
  } finally {
    if (signalsInstalled) {
      Deno.removeSignalListener('SIGINT', stop);
      Deno.removeSignalListener('SIGTERM', stop);
    }
    await stopping;
    await server?.shutdown();
    await service?.close();
    await cleanupOwnership();
    await startupLock?.close();
  }
};
