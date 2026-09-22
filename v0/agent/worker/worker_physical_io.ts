import type { Model, ModelGenerateOptions, ModelRequest, ModelResult } from '../core/contracts.ts';
import { throwIfCancelled } from '../core/cancellation.ts';
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
import { createProviderFreeWebSearchBackend } from '../tools/web_search.ts';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../provider/openrouter_contract.ts';
import type { WorkerStageName } from './worker_stage_probe.ts';
import { createProviderRequestDispatcher } from '../provider/auxiliary_request.ts';

const lastUserText = (request: ModelRequest): string => {
  for (let index = request.transcript.length - 1; index >= 0; index -= 1) {
    const message = request.transcript[index];
    if (message?.role === 'user') return message.content.text;
  }
  return '';
};

const hasCurrentTurnToolResult = (request: ModelRequest): boolean => {
  const lastUser = request.transcript.findLastIndex((message) => message.role === 'user');
  return lastUser >= 0 &&
    request.transcript.slice(lastUser + 1).some((message) => message.role === 'tool');
};

const currentTurnToolResultCount = (request: ModelRequest): number => {
  const lastUser = request.transcript.findLastIndex((message) => message.role === 'user');
  return lastUser < 0
    ? 0
    : request.transcript.slice(lastUser + 1).filter((message) => message.role === 'tool').length;
};

const lastToolResultText = (request: ModelRequest): string => {
  const lastUser = request.transcript.findLastIndex((message) => message.role === 'user');
  if (lastUser < 0) return '';
  const tool = request.transcript.slice(lastUser + 1).reverse().find((message) =>
    message.role === 'tool'
  );
  if (tool === undefined || !Array.isArray(tool.content)) return '';
  return tool.content.map((content) => content.text).join('\n');
};

const delayed = async (options: ModelGenerateOptions): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  throwIfCancelled(options.signal);
};

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

/** Provider-free model used only to drive the real Worker composition graph in focused tests. */
class WorkerProbeModel implements Model {
  constructor(private readonly role: 'parent' | 'planner') {}

  async generate(
    request: ModelRequest,
    options: ModelGenerateOptions = {},
  ): Promise<ModelResult> {
    throwIfCancelled(options.signal);
    options.reportAssistantProgress?.(
      `worker progress: ${lastUserText(request)}`,
    );
    if (request.systemInstruction?.includes('semantic context checkpoint')) {
      return {
        kind: 'final',
        text: '{"schemaVersion":1,"summary":"worker checkpoint summary"}',
      };
    }
    const task = lastUserText(request);
    if (task === 'return active tool guidelines') {
      return { kind: 'final', text: request.systemInstruction ?? '' };
    }
    if (task.includes('very-slow')) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5_200));
      throwIfCancelled(options.signal);
    } else if (task.includes('slow')) await delayed(options);
    if (this.role === 'parent' && task.includes('async-spawn')) {
      const toolText = lastToolResultText(request);
      if (toolText.includes('"finalText"')) {
        const parsed = JSON.parse(toolText) as { readonly finalText?: string };
        return { kind: 'final', text: `async child: ${parsed.finalText ?? ''}` };
      }
      if (toolText.includes('"runId"')) {
        const parsed = JSON.parse(toolText) as { readonly runId?: string };
        if (parsed.runId !== undefined) {
          return {
            kind: 'tool_calls',
            calls: [{
              callId: 'async-collect-1',
              name: 'collect_subagent',
              arguments: { runId: parsed.runId },
            }],
          };
        }
      }
      return {
        kind: 'tool_calls',
        calls: [{
          callId: 'async-spawn-1',
          name: 'spawn_subagent',
          arguments: { agent: 'planner', task: 'async child planning task' },
        }],
      };
    }
    if (
      task.includes('ten-step') && currentTurnToolResultCount(request) < 9
    ) {
      const ordinal = currentTurnToolResultCount(request) + 1;
      return {
        kind: 'tool_calls',
        calls: [{
          callId: `worker-read-${ordinal}`,
          name: 'read',
          arguments: { path: 'v0/agent/worker/worker_protocol.ts' },
        }],
      };
    }
    if (
      !hasCurrentTurnToolResult(request) && this.role === 'parent' &&
      task.includes('read')
    ) {
      return {
        kind: 'tool_calls',
        calls: [{
          callId: 'worker-read-1',
          name: 'read',
          arguments: { path: 'v0/agent/worker/worker_protocol.ts' },
        }],
      };
    }
    return {
      kind: 'final',
      text: this.role === 'planner' ? 'worker planner result' : `worker answer: ${task}`,
    };
  }
}

/**
 * Construct physical bindings inside the Worker. No model, registry, filesystem closure, or
 * credential-bearing object is sent through the Host protocol.
 */
export const createProviderFreePhysicalIo = (): PhysicalIoBindings => ({
  createModel: (role) => new WorkerProbeModel(role),
  webSearchBackend: createProviderFreeWebSearchBackend(),
});

/** Production Worker-local physical I/O; credentials resolve only at provider-request time. */
export const createProductionPhysicalIo = (
  requestCounter?: WorkerRequestCounter,
  options: {
    readonly credentialSource?: CredentialSource;
    readonly openAICredentialSource?: CredentialSource;
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
  const sources: Record<string, CredentialSource> = { ...(options.credentialSources ?? {}) };
  if (options.credentialSource !== undefined) {
    sources['openrouter-api-key'] = options.credentialSource;
  }
  if (options.openAICredentialSource !== undefined) {
    sources['openai-api-key'] = options.openAICredentialSource;
  }
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
      if (options.credentialPresence !== undefined) return options.credentialPresence(authProfile);
      if (sources[authProfile] !== undefined) return Promise.resolve('unknown');
      return credentialFilePresenceFor(authProfile);
    },
  };
};
