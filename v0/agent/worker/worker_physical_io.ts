import type { Model, ModelGenerateOptions, ModelRequest, ModelResult } from '../core/contracts.ts';
import { throwIfCancelled } from '../core/cancellation.ts';
import type { PhysicalIoBindings } from '../worker_agent_api.ts';
import { type CredentialSource, OpenRouterAgentModel } from '../provider/openrouter_model.ts';
import { readCredentialFile } from '../provider/credential_file.ts';
import { createCredentialResolver } from '../provider/credential_resolver.ts';
import { OpenAIResponsesModel } from '../provider/openai_responses_model.ts';
import { PRODUCTION_PROFILE } from '../provider/provider_profile.ts';
import {
  type ModelSelection,
  openRouterProfileFor,
  PLANNER_DEFAULT_MODEL_SELECTION,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../provider/openrouter_model_catalog.ts';
import {
  createProviderFreeWebSearchBackend,
  OpenRouterSonarWebSearchBackend,
} from '../tools/web_search.ts';

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
    options.reportAssistantProgress?.(`worker progress: ${lastUserText(request)}`);
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
    if (
      !hasCurrentTurnToolResult(request) && this.role === 'parent' &&
      task.includes('delegate')
    ) {
      return {
        kind: 'tool_calls',
        calls: [{
          callId: 'worker-planner-1',
          name: 'delegate_to_planner',
          arguments: {
            task: task.includes('delegate-long')
              ? 'ten-step worker planner child task'
              : 'worker planner child task',
          },
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
      !hasCurrentTurnToolResult(request) && this.role === 'parent' && task.includes('read')
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
    readonly fetcher?: typeof fetch;
    readonly providerTimeoutMs?: number;
  } = {},
): PhysicalIoBindings => {
  const fetcher: typeof fetch = (input, init) => {
    requestCounter?.increment();
    return (options.fetcher ?? fetch)(input, init);
  };
  const resolver = createCredentialResolver({
    openRouter: options.credentialSource ?? readCredentialFile,
    ...(options.openAICredentialSource === undefined
      ? {}
      : { openAI: options.openAICredentialSource }),
  });
  return {
    createModel: (role, selection?: ModelSelection) => {
      const resolved = selection ??
        (role === 'planner' ? PLANNER_DEFAULT_MODEL_SELECTION : ROOT_DEFAULT_MODEL_SELECTION);
      if (resolved.provider === 'openai') {
        return new OpenAIResponsesModel({
          selection: resolved,
          credentialSource: () => resolver.resolve(resolved.authProfile),
          fetcher,
          timeoutMs: options.providerTimeoutMs,
        });
      }
      return new OpenRouterAgentModel({
        profile: role === 'planner' && selection === undefined
          ? openRouterProfileFor(PLANNER_DEFAULT_MODEL_SELECTION)
          : selection === undefined
          ? PRODUCTION_PROFILE
          : openRouterProfileFor(resolved),
        credentialSource: () => resolver.resolve(resolved.authProfile),
        fetcher,
        responseMode: 'sse',
        timeoutMs: options.providerTimeoutMs,
      });
    },
    webSearchBackend: new OpenRouterSonarWebSearchBackend({
      credentialSource: () => resolver.resolve('openrouter-api-key'),
      fetcher,
    }),
  };
};
