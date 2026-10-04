import { isSessionId } from '../session/session_store_contract.ts';
import { BUILTIN_PROVIDER_IDS, type ProviderId } from '../provider/model_selection.ts';

interface ParsedTuiInvocation {
  readonly rawAgentName: string | undefined;
  readonly rawAgentFile?: string;
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  readonly rootProvider?: ProviderId;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  readonly sessionId?: string;
}

/** Parse both flag orders before terminal, workspace, state, provider, or credential setup. */
export const parseTuiInvocation = (
  args: readonly string[],
  allowedProviders: readonly string[] = BUILTIN_PROVIDER_IDS,
): ParsedTuiInvocation => {
  let rawAgentName: string | undefined;
  let rawAgentFile: string | undefined;
  let rootMaxSteps: number | undefined;
  let providerTimeoutMs: number | undefined;
  let rootProvider: ProviderId = 'openrouter-chat';
  let rootProviderSeen = false;
  let persistence: ParsedTuiInvocation['persistence'] = 'new';
  let sessionId: string | undefined;
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === '--agent') {
      const value = args[index + 1];
      if (
        rawAgentName !== undefined ||
        value === undefined ||
        value.length === 0
      ) {
        throw new Error(
          rawAgentName !== undefined ? 'Duplicate --agent' : 'Missing value for --agent',
        );
      }
      rawAgentName = value;
      index += 2;
    } else if (flag === '--agent-file') {
      const value = args[index + 1];
      if (
        rawAgentFile !== undefined ||
        value === undefined ||
        value.length === 0
      ) {
        throw new Error(
          rawAgentFile !== undefined ? 'Duplicate --agent-file' : 'Missing value for --agent-file',
        );
      }
      rawAgentFile = value;
      index += 2;
    } else if (flag === '--continue') {
      if (persistence !== 'new') throw new Error('Session targets are mutually exclusive');
      persistence = 'continue';
      index += 1;
    } else if (flag === '--session') {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || persistence !== 'new') {
        throw new Error(
          persistence !== 'new'
            ? 'Session targets are mutually exclusive'
            : 'Missing value for --session',
        );
      }
      if (!isSessionId(value)) throw new Error('--session must be a full Session UUID');
      sessionId = value;
      persistence = 'session';
      index += 2;
    } else if (flag === '--no-session') {
      if (persistence !== 'new') throw new Error('Session targets are mutually exclusive');
      persistence = 'none';
      index += 1;
    } else if (flag === '--max-steps') {
      const value = args[index + 1];
      if (
        rootMaxSteps !== undefined || value === undefined ||
        !/^[0-9]+$/.test(value)
      ) {
        throw new Error(
          rootMaxSteps !== undefined
            ? 'Duplicate --max-steps'
            : value === undefined
            ? 'Missing value for --max-steps'
            : '--max-steps must be a positive integer',
        );
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('--max-steps must be a positive integer');
      }
      rootMaxSteps = parsed;
      index += 2;
    } else if (flag === '--provider-timeout-ms') {
      const value = args[index + 1];
      if (
        providerTimeoutMs !== undefined || value === undefined ||
        !/^[0-9]+$/.test(value)
      ) {
        throw new Error(
          providerTimeoutMs !== undefined
            ? 'Duplicate --provider-timeout-ms'
            : value === undefined
            ? 'Missing value for --provider-timeout-ms'
            : '--provider-timeout-ms must be a positive integer',
        );
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('--provider-timeout-ms must be a positive integer');
      }
      providerTimeoutMs = parsed;
      index += 2;
    } else if (flag === '--root-provider') {
      const value = args[index + 1];
      if (
        rootProviderSeen || value === undefined ||
        !allowedProviders.includes(value)
      ) {
        throw new Error(
          rootProviderSeen
            ? 'Duplicate --root-provider'
            : value === undefined
            ? 'Missing value for --root-provider'
            : '--root-provider must name a configured provider',
        );
      }
      rootProvider = value;
      rootProviderSeen = true;
      index += 2;
    } else {
      throw new Error(`Unknown option '${flag}'`);
    }
  }
  if (rawAgentName !== undefined && rawAgentFile !== undefined) {
    throw new Error('--agent and --agent-file are mutually exclusive');
  }
  return {
    rawAgentName,
    ...(rawAgentFile === undefined ? {} : { rawAgentFile }),
    ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
    ...(providerTimeoutMs === undefined ? {} : { providerTimeoutMs }),
    ...(rootProviderSeen ? { rootProvider } : {}),
    persistence,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
};
