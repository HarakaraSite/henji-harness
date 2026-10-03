import type { SessionActivation } from '../../api/contract.ts';
import type { RemoteTuiDependencies, RemoteTuiLaunchTarget } from '../../tui/remote_session.ts';
import { runRemoteTui } from '../../tui/remote_session.ts';
import { isSessionId } from '../session/session_store_contract.ts';

interface RemoteTuiInvocation {
  readonly url?: string;
  readonly coreId?: string;
  readonly target: RemoteTuiLaunchTarget;
  readonly activation?: SessionActivation;
}

const valueAfter = (
  args: readonly string[],
  index: number,
  flag: string,
): string => {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
};

const positiveSafeInteger = (value: string, flag: string): number => {
  if (!/^\d+$/u.test(value)) throw new Error(`invalid ${flag}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag}`);
  }
  return parsed;
};

/** Parse connection and Session activation without loading TUI provider catalogs or defaults. */
export const parseRemoteTuiInvocation = (
  args: readonly string[],
): RemoteTuiInvocation => {
  let url: string | undefined;
  let coreId: string | undefined;
  let target: RemoteTuiLaunchTarget = { kind: 'implicit' };
  let targetSeen = false;
  let agent: string | undefined;
  let agentFile: string | undefined;
  let maxSteps: number | undefined;
  let providerTimeoutMs: number | undefined;
  let rootProvider: string | undefined;

  const setTarget = (next: RemoteTuiLaunchTarget): void => {
    if (targetSeen) throw new Error('duplicate Session target');
    target = next;
    targetSeen = true;
  };

  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === '--connect') {
      if (url !== undefined) throw new Error('duplicate --connect');
      const value = valueAfter(args, index, flag);
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error('invalid --connect');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('invalid --connect');
      }
      url = value;
      index += 2;
    } else if (flag === '--core') {
      if (coreId !== undefined) throw new Error('duplicate --core');
      coreId = valueAfter(args, index, flag);
      index += 2;
    } else if (flag === '--new') {
      setTarget({ kind: 'new' });
      index += 1;
    } else if (flag === '--continue') {
      setTarget({ kind: 'continue' });
      index += 1;
    } else if (flag === '--no-session') {
      setTarget({ kind: 'none' });
      index += 1;
    } else if (flag === '--session') {
      const value = valueAfter(args, index, flag);
      if (!isSessionId(value)) throw new Error('invalid --session');
      setTarget({ kind: 'session', sessionId: value });
      index += 2;
    } else if (flag === '--agent') {
      if (agent !== undefined) throw new Error('duplicate --agent');
      agent = valueAfter(args, index, flag);
      index += 2;
    } else if (flag === '--agent-file') {
      if (agentFile !== undefined) {
        throw new Error('duplicate --agent-file');
      }
      agentFile = valueAfter(args, index, flag);
      index += 2;
    } else if (flag === '--max-steps') {
      if (maxSteps !== undefined) throw new Error('duplicate --max-steps');
      maxSteps = positiveSafeInteger(valueAfter(args, index, flag), flag);
      index += 2;
    } else if (flag === '--provider-timeout-ms') {
      if (providerTimeoutMs !== undefined) {
        throw new Error('duplicate --provider-timeout-ms');
      }
      providerTimeoutMs = positiveSafeInteger(
        valueAfter(args, index, flag),
        flag,
      );
      index += 2;
    } else if (flag === '--root-provider') {
      if (rootProvider !== undefined) {
        throw new Error('duplicate --root-provider');
      }
      // The Core selection service owns provider validation; the connected UI has no catalog.
      rootProvider = valueAfter(args, index, flag);
      index += 2;
    } else {
      throw new Error(`unexpected TUI option ${flag}`);
    }
  }

  if (
    (agent !== undefined && agentFile !== undefined)
  ) {
    throw new Error('invalid TUI invocation');
  }
  if (url !== undefined && coreId !== undefined) {
    throw new Error('--core and --connect are mutually exclusive');
  }
  const activation: SessionActivation = {
    ...(agent === undefined ? {} : { agent }),
    ...(agentFile === undefined ? {} : { agentFile }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(providerTimeoutMs === undefined ? {} : { providerTimeoutMs }),
    ...(rootProvider === undefined ? {} : { rootProvider }),
  };
  return {
    ...(url === undefined ? {} : { url }),
    ...(coreId === undefined ? {} : { coreId }),
    target,
    ...(Object.keys(activation).length === 0 ? {} : { activation }),
  };
};

export const runRemoteTuiInvocation = async (
  invocation: RemoteTuiInvocation,
  dependencies: RemoteTuiDependencies = {},
): Promise<number> => {
  let url = invocation.url;
  if (url === undefined) {
    const { resolveRuntimePaths } = await import('../runtime/runtime_paths.ts');
    const { prepareLocalCore, resolveLocalCore } = await import('../runtime/core_discovery.ts');
    const paths = resolveRuntimePaths();
    const connection = invocation.coreId === undefined
      ? await prepareLocalCore(paths)
      : await resolveLocalCore(paths, invocation.coreId);
    url = connection.endpoint.url;
  }
  return await runRemoteTui(url, undefined, dependencies, {
    target: invocation.target,
    ...(invocation.activation === undefined ? {} : { activation: invocation.activation }),
  });
};
