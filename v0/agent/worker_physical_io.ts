import type { Model, ModelGenerateOptions, ModelRequest, ModelResult } from './contracts.ts';
import { throwIfCancelled } from './cancellation.ts';
import type { PhysicalIoBindings } from './worker_agent_api.ts';
import { type CredentialSource, OpenRouterAgentModel } from './openrouter_model.ts';
import { readCredentialFile } from './credential_file.ts';
import { PRODUCTION_PROFILE } from './provider_profile.ts';

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
          arguments: { task: 'worker planner child task' },
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
          arguments: { path: 'v0/agent/worker_protocol.ts' },
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
});

/** Production Worker-local physical I/O; credentials resolve only at provider-request time. */
export const createProductionPhysicalIo = (
  requestCounter?: WorkerRequestCounter,
  options: {
    readonly credentialSource?: CredentialSource;
    readonly fetcher?: typeof fetch;
  } = {},
): PhysicalIoBindings => ({
  createModel: () => {
    const fetcher: typeof fetch = (input, init) => {
      requestCounter?.increment();
      return (options.fetcher ?? fetch)(input, init);
    };
    return new OpenRouterAgentModel({
      profile: PRODUCTION_PROFILE,
      credentialSource: options.credentialSource ?? readCredentialFile,
      fetcher,
      responseMode: 'sse',
    });
  },
});
