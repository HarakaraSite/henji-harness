import { parseDefinitionRevisionSelector } from '../definitions/definition_selector.ts';
import { isSessionId } from '../session/session_store_contract.ts';
import { BUILTIN_PROVIDER_IDS, type ProviderId } from '../provider/model_selection.ts';

interface ParsedTuiInvocation {
  readonly rawAgentName: string | undefined;
  readonly rawDefinitionRevision?: string;
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
  let rawDefinitionRevision: string | undefined;
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
        throw new Error('invalid invocation');
      }
      rawAgentName = value;
      index += 2;
    } else if (flag === '--definition-revision') {
      const value = args[index + 1];
      if (
        rawDefinitionRevision !== undefined ||
        value === undefined ||
        value.length === 0
      ) {
        throw new Error('invalid invocation');
      }
      try {
        parseDefinitionRevisionSelector(value);
      } catch {
        throw new Error('invalid invocation');
      }
      rawDefinitionRevision = value;
      index += 2;
    } else if (flag === '--continue') {
      if (persistence !== 'new') throw new Error('invalid invocation');
      persistence = 'continue';
      index += 1;
    } else if (flag === '--session') {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || persistence !== 'new') {
        throw new Error('invalid invocation');
      }
      if (!isSessionId(value)) throw new Error('invalid invocation');
      sessionId = value;
      persistence = 'session';
      index += 2;
    } else if (flag === '--no-session') {
      if (persistence !== 'new') throw new Error('invalid invocation');
      persistence = 'none';
      index += 1;
    } else if (flag === '--max-steps') {
      const value = args[index + 1];
      if (
        rootMaxSteps !== undefined || value === undefined ||
        !/^[0-9]+$/.test(value)
      ) throw new Error('invalid invocation');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('invalid invocation');
      }
      rootMaxSteps = parsed;
      index += 2;
    } else if (flag === '--provider-timeout-ms') {
      const value = args[index + 1];
      if (
        providerTimeoutMs !== undefined || value === undefined ||
        !/^[0-9]+$/.test(value)
      ) throw new Error('invalid invocation');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('invalid invocation');
      }
      providerTimeoutMs = parsed;
      index += 2;
    } else if (flag === '--root-provider') {
      const value = args[index + 1];
      if (
        rootProviderSeen || value === undefined ||
        !allowedProviders.includes(value)
      ) {
        throw new Error('invalid invocation');
      }
      rootProvider = value;
      rootProviderSeen = true;
      index += 2;
    } else {
      throw new Error('invalid invocation');
    }
  }
  if (rawAgentName !== undefined && rawDefinitionRevision !== undefined) {
    throw new Error('invalid invocation');
  }
  return {
    rawAgentName,
    ...(rawDefinitionRevision === undefined ? {} : { rawDefinitionRevision }),
    ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
    ...(providerTimeoutMs === undefined ? {} : { providerTimeoutMs }),
    ...(rootProviderSeen ? { rootProvider } : {}),
    persistence,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
};
