import type { PhysicalIoBindings } from '../worker_agent_api.ts';
import type { Model } from '../core/contracts.ts';
import type { CredentialSource, CredentialSourceContext } from '../provider/openrouter_contract.ts';
import { createCredentialResolver } from '../provider/credential_resolver.ts';
import { measureModelRequestWire } from '../provider/openrouter_request.ts';
import { measureResponsesRequestWire } from '../provider/openai_responses_request.ts';
import type { ProviderDeclarationV1 } from '../provider/provider_declaration.ts';
import type {
  AuthProfileId,
  ChatGPTModelSelection,
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
import { defaultModelSelectionFor } from '../provider/model_catalog.ts';
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

/** Keep synchronous wire measurement while loading the adapter on the first generation. */
const deferredModel = (
  measureRequestWire: NonNullable<Model['measureRequestWire']>,
  createAdapter: () => Promise<Model>,
  requestOutputReserve?: number,
): Model => {
  let adapter: Promise<Model> | undefined;
  return {
    measureRequestWire,
    ...(requestOutputReserve === undefined ? {} : { requestOutputReserve }),
    generate: async (request, options) =>
      (await (adapter ??= createAdapter())).generate(request, options),
  };
};

/** Production Worker-local physical I/O; credentials resolve only at provider-request time. */
export const createProductionPhysicalIo = (
  requestCounter: WorkerRequestCounter | undefined,
  options: {
    readonly credentialSources?: Readonly<Record<string, CredentialSource>>;
    readonly credentialPresence?: (
      profile: AuthProfileId,
      registrationId?: string | null,
    ) => Promise<CredentialAvailabilityStatus>;
    readonly credentialRoot: string;
    readonly sessionId?: string;
    readonly fetcher?: typeof fetch;
    readonly providerTimeoutMs?: number;
    readonly providerDeclarations?: readonly ProviderDeclarationV1[];
    readonly reportAuxiliaryStage?: (stage: WorkerStageName) => void;
  },
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
  const resolver = createCredentialResolver({
    sources,
    credentialRoot: options.credentialRoot,
  });
  return {
    createModel: (_role, selection?: ModelSelection) => {
      const resolved = selection ?? defaultModelSelectionFor('openrouter-chat');
      if (resolved.provider === 'openai-chatgpt') {
        const chatgpt = resolved as ChatGPTModelSelection;
        return deferredModel(
          (request) =>
            measureResponsesRequestWire(request, resolved.modelId, {
              stateProvider: chatgpt.registrationId === undefined
                ? chatgpt.provider
                : `${chatgpt.provider}@${chatgpt.registrationId ?? 'unselected'}`,
              includeStore: true,
              namespaceTools: true,
            }, resolved.effort),
          async () => {
            const { ChatGPTResponsesModel } = await import('../provider/openai_responses_model.ts');
            return new ChatGPTResponsesModel({
              selection: chatgpt,
              credentialSource: (context?: CredentialSourceContext) =>
                resolver.resolve(chatgpt.authProfile, chatgpt.registrationId, {
                  ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                  ...context,
                }),
              fetcher,
              timeoutMs: options.providerTimeoutMs,
              ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            });
          },
        );
      }
      if (resolved.provider === 'openai-responses') {
        return deferredModel(
          (request) =>
            measureResponsesRequestWire(request, resolved.modelId, {
              stateProvider: resolved.provider,
              includeStore: true,
            }, resolved.effort),
          async () => {
            const { OpenAIResponsesModel } = await import('../provider/openai_responses_model.ts');
            return new OpenAIResponsesModel({
              selection: resolved as OpenAIModelSelection,
              credentialSource: () => resolver.resolve(resolved.authProfile),
              fetcher,
              timeoutMs: options.providerTimeoutMs,
            });
          },
        );
      }
      if (resolved.provider === 'openrouter-responses') {
        const endpoint = declaredProviders.get('openrouter-responses')
          ?.endpoint;
        return deferredModel(
          (request) =>
            measureResponsesRequestWire(request, resolved.modelId, {
              stateProvider: resolved.provider,
              includeStore: false,
            }, resolved.effort),
          async () => {
            const { OpenRouterResponsesModel } = await import(
              '../provider/openai_responses_model.ts'
            );
            return new OpenRouterResponsesModel({
              selection: resolved as OpenRouterResponsesModelSelection,
              credentialSource: () => resolver.resolve(resolved.authProfile),
              fetcher,
              timeoutMs: options.providerTimeoutMs,
              ...(endpoint === undefined ? {} : { baseURL: endpoint }),
            });
          },
        );
      }
      if (resolved.api === 'openai-responses') {
        const declaration = declaredProviders.get(resolved.provider);
        if (
          declaration === undefined ||
          declaration.protocol !== 'openai-responses'
        ) {
          throw new Error('declared provider is unavailable');
        }
        return deferredModel(
          (request) =>
            measureResponsesRequestWire(request, resolved.modelId, {
              stateProvider: resolved.provider,
              includeStore: false,
            }, resolved.effort),
          async () => {
            const { DeclaredResponsesModel } = await import(
              '../provider/openai_responses_model.ts'
            );
            return new DeclaredResponsesModel({
              selection: resolved as DeclaredProviderModelSelection,
              credentialSource: () => resolver.resolve(declaration.authProfile),
              fetcher,
              timeoutMs: options.providerTimeoutMs,
              baseURL: declaration.endpoint,
              ...(declaration.headers === undefined ? {} : { requestHeaders: declaration.headers }),
              ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            });
          },
        );
      }
      if (resolved.api === 'openai-chat-completions') {
        const declaration = declaredProviders.get(resolved.provider);
        if (
          declaration === undefined ||
          declaration.protocol !== 'openai-chat-completions'
        ) {
          throw new Error('declared provider is unavailable');
        }
        const profile = openRouterProfileForDeclaredChat(
          resolved.provider,
          resolved.modelId,
          resolved.effort,
          declaration.endpoint,
          declaration.headers,
        );
        return deferredModel(
          (request) => measureModelRequestWire(request, profile, 'sse', resolved.provider),
          async () => {
            const { OpenRouterAgentModel } = await import('../provider/openrouter_model.ts');
            return new OpenRouterAgentModel({
              profile,
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
          },
          profile.maxCompletionTokens,
        );
      }
      const profile = openRouterProfileFor(resolved as OpenRouterModelSelection);
      return deferredModel(
        (request) => measureModelRequestWire(request, profile),
        async () => {
          const { OpenRouterAgentModel } = await import('../provider/openrouter_model.ts');
          return new OpenRouterAgentModel({
            profile,
            credentialSource: () => resolver.resolve(resolved.authProfile),
            fetcher,
            responseMode: 'sse',
            timeoutMs: options.providerTimeoutMs,
          });
        },
        profile.maxCompletionTokens,
      );
    },
    requestProvider: createProviderRequestDispatcher({
      resolveCredential: (authProfile) => resolver.resolve(authProfile),
      fetcher,
      timeoutMs: options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      reportStage: options.reportAuxiliaryStage,
    }),
    credentialAvailability: (authProfile, registrationId) => {
      if (options.credentialPresence !== undefined) {
        return options.credentialPresence(authProfile, registrationId);
      }
      return resolver.presence(authProfile, registrationId);
    },
  };
};
