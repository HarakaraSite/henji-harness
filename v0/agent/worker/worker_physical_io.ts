import type { PhysicalIoBindings } from '../worker_agent_api.ts';
import { type CredentialSource, OpenRouterAgentModel } from '../provider/openrouter_model.ts';
import { credentialFilePresenceFor } from '../provider/credential_file.ts';
import { createCredentialResolver } from '../provider/credential_resolver.ts';
import {
  DeclaredResponsesModel,
  OpenAIResponsesModel,
  OpenRouterResponsesModel,
} from '../provider/openai_responses_model.ts';
import type { ProviderDeclarationV1 } from '../provider/provider_declaration.ts';
import type {
  AuthProfileId,
  CredentialAvailabilityStatus,
  DeclaredProviderModelSelection,
  OpenAIModelSelection,
  OpenRouterModelSelection,
  OpenRouterResponsesModelSelection,
} from '../provider/model_selection.ts';
import {
  type ModelSelection,
  openRouterProfileFor,
  openRouterProfileForDeclaredChat,
} from '../provider/openrouter_model_catalog.ts';
import { defaultModelSelectionFor, roleDefaultModelSelection } from '../provider/model_catalog.ts';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../provider/openrouter_contract.ts';
import type { WorkerStageName } from './worker_stage_probe.ts';
import { createProviderRequestDispatcher } from '../provider/auxiliary_request.ts';

export interface WorkerRequestCounter {
  readonly increment: () => void;
  readonly count: () => number;
}

export const createWorkerRequestCounter = (): WorkerRequestCounter => {
  let value = 0;
  return {
    increment: () => {
      value += 1;
    },
    count: () => value,
  };
};

/** Production Worker-local physical I/O; credentials resolve only at provider-request time. */
export const createProductionPhysicalIo = (
  requestCounter?: WorkerRequestCounter,
  options: {
    readonly credentialSources?: Readonly<Record<string, CredentialSource>>;
    readonly credentialPresence?: (
      profile: AuthProfileId,
    ) => Promise<CredentialAvailabilityStatus>;
    readonly sessionId?: string;
    readonly fetcher?: typeof fetch;
    readonly providerTimeoutMs?: number;
    readonly providerDeclarations?: readonly ProviderDeclarationV1[];
    readonly reportAuxiliaryStage?: (stage: WorkerStageName) => void;
  } = {},
): PhysicalIoBindings => {
  const declaredProviders = new Map(
    (options.providerDeclarations ?? []).map((declaration) => [
      declaration.providerId,
      declaration,
    ]),
  );
  const fetcher: typeof fetch = (input, init) => {
    requestCounter?.increment();
    return (options.fetcher ?? fetch)(input, init);
  };
  const sources = options.credentialSources ?? {};
  const resolver = createCredentialResolver({ sources });
  return {
    createModel: (role, selection?: ModelSelection) => {
      const resolved = selection ??
        (role === 'planner'
          ? roleDefaultModelSelection('subagent:planner')
          : defaultModelSelectionFor('openrouter-chat'));
      if (resolved.provider === 'openai-responses') {
        return new OpenAIResponsesModel({
          selection: resolved as OpenAIModelSelection,
          credentialSource: () => resolver.resolve(resolved.authProfile),
          fetcher,
          timeoutMs: options.providerTimeoutMs,
        });
      }
      if (resolved.provider === 'openrouter-responses') {
        const endpoint = declaredProviders.get('openrouter-responses')
          ?.endpoint;
        return new OpenRouterResponsesModel({
          selection: resolved as OpenRouterResponsesModelSelection,
          credentialSource: () => resolver.resolve(resolved.authProfile),
          fetcher,
          timeoutMs: options.providerTimeoutMs,
          ...(endpoint === undefined ? {} : { baseURL: endpoint }),
        });
      }
      if (resolved.api === 'openai-responses') {
        const declaration = declaredProviders.get(resolved.provider);
        if (
          declaration === undefined ||
          declaration.protocol !== 'openai-responses'
        ) {
          throw new Error('declared provider is unavailable');
        }
        return new DeclaredResponsesModel({
          selection: resolved as DeclaredProviderModelSelection,
          credentialSource: () => resolver.resolve(declaration.authProfile),
          fetcher,
          timeoutMs: options.providerTimeoutMs,
          baseURL: declaration.endpoint,
          ...(declaration.headers === undefined ? {} : { requestHeaders: declaration.headers }),
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        });
      }
      if (resolved.api === 'openai-chat-completions') {
        const declaration = declaredProviders.get(resolved.provider);
        if (
          declaration === undefined ||
          declaration.protocol !== 'openai-chat-completions'
        ) {
          throw new Error('declared provider is unavailable');
        }
        return new OpenRouterAgentModel({
          profile: openRouterProfileForDeclaredChat(
            resolved.provider,
            resolved.modelId,
            resolved.effort,
            declaration.endpoint,
            declaration.headers,
          ),
          evidenceIdentity: {
            provider: resolved.provider,
            api: 'openai-chat-completions',
            authProfile: declaration.authProfile,
          },
          credentialSource: () => resolver.resolve(declaration.authProfile),
          fetcher,
          responseMode: 'sse',
          timeoutMs: options.providerTimeoutMs,
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        });
      }
      return new OpenRouterAgentModel({
        profile: openRouterProfileFor(resolved as OpenRouterModelSelection),
        credentialSource: () => resolver.resolve(resolved.authProfile),
        fetcher,
        responseMode: 'sse',
        timeoutMs: options.providerTimeoutMs,
      });
    },
    requestProvider: createProviderRequestDispatcher({
      resolveCredential: (authProfile) => resolver.resolve(authProfile),
      fetcher,
      timeoutMs: options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      reportStage: options.reportAuxiliaryStage,
    }),
    credentialAvailability: (authProfile) => {
      if (options.credentialPresence !== undefined) {
        return options.credentialPresence(authProfile);
      }
      if (sources[authProfile] !== undefined) return Promise.resolve('unknown');
      return credentialFilePresenceFor(authProfile);
    },
  };
};
