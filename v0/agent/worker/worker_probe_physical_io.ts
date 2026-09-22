import type { Model, ModelGenerateOptions, ModelRequest, ModelResult } from '../core/contracts.ts';
import { throwIfCancelled } from '../core/cancellation.ts';
import { createProviderFreeWebSearchBackend } from '../tools/web_search.ts';
import type { PhysicalIoBindings } from '../worker_agent_api.ts';

const probeTask = {
  childBarrier: 'barrier-child:',
  stubbornChildBarrier: 'stubborn-barrier-child:',
  spawnUncollected: 'async-spawn-uncollected:',
  spawnBarrier: 'async-spawn-barrier:',
} as const;

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

const barrierParts = (
  task: string,
  prefix: string,
): { readonly channelName: string; readonly label: string } | undefined => {
  if (!task.startsWith(prefix)) return undefined;
  const [channelName, label] = task.slice(prefix.length).split(':', 2);
  if (channelName === undefined || channelName.length === 0 || label === undefined) {
    throw new Error('invalid provider-free child barrier task');
  }
  return { channelName, label };
};

const waitForChildBarrier = async (
  task: string,
  options: ModelGenerateOptions,
): Promise<boolean> => {
  const barrier = barrierParts(task, probeTask.childBarrier);
  if (barrier === undefined) return false;
  const channel = new BroadcastChannel(barrier.channelName);
  try {
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        options.signal?.removeEventListener('abort', finish);
        resolve();
      };
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { readonly kind?: unknown };
        if (message?.kind === 'release') finish();
      };
      options.signal?.addEventListener('abort', finish, { once: true });
      if (options.signal?.aborted) finish();
      channel.postMessage({ kind: 'started', label: barrier.label });
    });
  } finally {
    channel.close();
  }
  throwIfCancelled(options.signal);
  return true;
};

const waitForStubbornChildBarrier = async (
  task: string,
  options: ModelGenerateOptions,
): Promise<boolean> => {
  const barrier = barrierParts(task, probeTask.stubbornChildBarrier);
  if (barrier === undefined) return false;
  const channel = new BroadcastChannel(barrier.channelName);
  let cancellationObserved = false;
  const onAbort = (): void => {
    if (cancellationObserved) return;
    cancellationObserved = true;
    channel.postMessage({ kind: 'cancel_observed', label: barrier.label });
  };
  try {
    await new Promise<void>((resolve) => {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { readonly kind?: unknown };
        if (message?.kind === 'release') resolve();
        if (message?.kind === 'probe') {
          channel.postMessage({ kind: 'started', label: barrier.label });
        }
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      channel.postMessage({ kind: 'started', label: barrier.label });
    });
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    channel.close();
  }
  throwIfCancelled(options.signal);
  return true;
};

const waitForStubbornChildStart = async (
  channelName: string,
  options: ModelGenerateOptions,
): Promise<void> => {
  const channel = new BroadcastChannel(channelName);
  try {
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        options.signal?.removeEventListener('abort', finish);
        resolve();
      };
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { readonly kind?: unknown };
        if (message?.kind === 'started') finish();
      };
      options.signal?.addEventListener('abort', finish, { once: true });
      if (options.signal?.aborted) {
        finish();
        return;
      }
      channel.postMessage({ kind: 'probe' });
    });
  } finally {
    channel.close();
  }
  throwIfCancelled(options.signal);
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
    if (this.role === 'planner' && task.includes('child-fail')) {
      throw new Error('child task failed on purpose');
    }
    if (task === 'return active tool guidelines') {
      return { kind: 'final', text: request.systemInstruction ?? '' };
    }
    if (await waitForChildBarrier(task, options)) {
      // The focused concurrency test releases both child Workers together.
    } else if (await waitForStubbornChildBarrier(task, options)) {
      // The focused pre-commit test controls when a cancelled child may settle.
    } else if (task.includes('cancel-child')) {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      throwIfCancelled(options.signal);
    } else if (task.includes('very-slow')) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5_200));
      throwIfCancelled(options.signal);
    } else if (task.includes('slow')) await delayed(options);
    if (this.role === 'parent' && task.includes('async-child-fail')) {
      const count = currentTurnToolResultCount(request);
      if (count === 0) {
        return {
          kind: 'tool_calls',
          calls: [{
            callId: 'async-spawn-fail',
            name: 'spawn_subagent',
            arguments: { agent: 'planner', task: 'child-fail task' },
          }],
        };
      }
      const toolText = lastToolResultText(request);
      if (count === 1) {
        const parsed = JSON.parse(toolText) as { readonly runId?: string };
        return {
          kind: 'tool_calls',
          calls: parsed.runId === undefined ? [] : [{
            callId: 'async-collect-fail',
            name: 'collect_subagent',
            arguments: { runId: parsed.runId },
          }],
        };
      }
      const parsed = JSON.parse(toolText) as {
        readonly state?: string;
        readonly error?: string;
      };
      return {
        kind: 'final',
        text: `child failed: ${parsed.error ?? parsed.state ?? 'unknown'}`,
      };
    }
    if (this.role === 'parent' && task.includes('async-spawn-two')) {
      const count = currentTurnToolResultCount(request);
      if (count === 0) {
        return {
          kind: 'tool_calls',
          calls: [
            {
              callId: 'async-spawn-a',
              name: 'spawn_subagent',
              arguments: { agent: 'planner', task: 'slow child A' },
            },
            {
              callId: 'async-spawn-b',
              name: 'spawn_subagent',
              arguments: { agent: 'planner', task: 'slow child B' },
            },
          ],
        };
      }
      const toolText = lastToolResultText(request);
      const runIds = [...toolText.matchAll(/"runId":"([^"]+)"/gu)].map((match) => match[1]);
      if (count === 1) {
        return {
          kind: 'tool_calls',
          calls: runIds.map((runId, index) => ({
            callId: `async-collect-${index}`,
            name: 'collect_subagent',
            arguments: { runId },
          })),
        };
      }
      return { kind: 'final', text: 'two children completed' };
    }
    if (this.role === 'parent' && task.startsWith(probeTask.spawnUncollected)) {
      const channelName = task.slice(probeTask.spawnUncollected.length);
      if (!hasCurrentTurnToolResult(request)) {
        return {
          kind: 'tool_calls',
          calls: [{
            callId: 'async-spawn-uncollected',
            name: 'spawn_subagent',
            arguments: {
              agent: 'planner',
              task: `${probeTask.stubbornChildBarrier}${channelName}:U`,
            },
          }],
        };
      }
      await waitForStubbornChildStart(channelName, options);
      return { kind: 'final', text: 'parent proposal with uncollected child' };
    }
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
          arguments: {
            agent: 'planner',
            task: task.startsWith(probeTask.spawnBarrier)
              ? `${probeTask.childBarrier}${task.slice(probeTask.spawnBarrier.length)}:C`
              : 'async child planning task',
          },
        }],
      };
    }
    if (task.includes('ten-step') && currentTurnToolResultCount(request) < 9) {
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

/** Construct deterministic physical bindings for focused Worker/Host integration tests. */
export const createProviderFreePhysicalIo = (): PhysicalIoBindings => ({
  createModel: (role) => new WorkerProbeModel(role),
  webSearchBackend: createProviderFreeWebSearchBackend(),
});
