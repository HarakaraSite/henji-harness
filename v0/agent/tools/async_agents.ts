import { type JsonValue } from '../core/contracts.ts';
import { isTurnCancelledError } from '../core/cancellation.ts';
import { type Tool, type ToolContext, ToolInputError } from './tools.ts';

/** Lifecycle state of one async child run (see Increment 107 run contract). */
export type AsyncAgentRunState =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type AsyncAgentTerminalState = Exclude<
  AsyncAgentRunState,
  'starting' | 'running'
>;

export interface AsyncAgentTerminalResult {
  readonly runId: string;
  readonly state: AsyncAgentTerminalState;
  readonly definitionRef?: string;
  readonly parentExecutionId?: string;
  readonly spawnCallId?: string;
  /** Exact Worker stop reason. Provider failures remain contract_failure and are refined below. */
  readonly stopReason?:
    | 'final'
    | 'tool_terminal'
    | 'max_steps'
    | 'contract_failure'
    | 'cancelled'
    | 'interrupted';
  /** Actual provider fetch starts attributed to this child turn. */
  readonly providerRequestCount?: number;
  readonly providerEvidenceId?: string;
  readonly providerEvidenceDurability?: 'yes' | 'failed' | 'unknown';
  readonly providerEvidencePersistenceError?: string;
  readonly diagnosticId?: string;
  readonly diagnosticCode?: string;
  readonly diagnosticDurability?: 'yes' | 'failed' | 'unknown';
  readonly diagnosticPersistenceError?: string;
  readonly contextDurability?: 'complete' | 'failed' | 'none' | 'partial';
  readonly contextPersistenceError?: string;
  readonly finalText?: string;
  readonly error?: string;
}

export type AsyncAgentRequest =
  | { readonly kind: 'spawn'; readonly agent: string; readonly task: string }
  | { readonly kind: 'status'; readonly runId: string }
  | { readonly kind: 'collect'; readonly runId: string }
  | { readonly kind: 'cancel'; readonly runId: string };

export type AsyncAgentResponse =
  | { readonly ok: true; readonly kind: 'spawn'; readonly runId: string }
  | {
    readonly ok: true;
    readonly kind: 'status';
    readonly runId: string;
    readonly state: AsyncAgentRunState;
  }
  | { readonly ok: true; readonly kind: 'collect'; readonly result: AsyncAgentTerminalResult }
  | {
    readonly ok: true;
    readonly kind: 'cancel';
    readonly runId: string;
    readonly state: AsyncAgentTerminalState;
  }
  | { readonly ok: false; readonly error: string };

/** Worker-local seam that performs the data-only Worker→Host async agent request. */
export type AsyncAgentRpc = (
  request: AsyncAgentRequest,
  callId?: string,
  signal?: AbortSignal,
) => Promise<AsyncAgentResponse>;

const MAX_TASK_BYTES = 65_536;
const encoder = new TextEncoder();

const isObject = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (
  value: Record<string, JsonValue>,
  key: string,
): string | undefined => typeof value[key] === 'string' ? value[key] as string : undefined;

const callIdOf = (context?: ToolContext): string | undefined =>
  context !== undefined && 'callId' in context && typeof context.callId === 'string'
    ? context.callId
    : undefined;

const requireRunId = (value: JsonValue): string => {
  if (!isObject(value)) throw new ToolInputError('expected an object with a runId string');
  const runId = readString(value, 'runId');
  if (runId === undefined || runId.length === 0) {
    throw new ToolInputError('expected a nonblank runId string');
  }
  return runId;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const invokeAsyncAgentRpc = async (
  rpc: AsyncAgentRpc,
  request: AsyncAgentRequest,
  context?: ToolContext,
): Promise<AsyncAgentResponse> => {
  try {
    return await rpc(request, callIdOf(context), context?.signal);
  } catch (error) {
    if (isTurnCancelledError(error)) throw error;
    return { ok: false, error: errorText(error) };
  }
};

const failedResponse = (response: AsyncAgentResponse): string =>
  JSON.stringify({
    ok: false,
    error: response.ok ? 'unexpected response' : response.error,
  });

/**
 * Materialize the core-owned async child agent tools for one declared catalog. The model sees a
 * fixed four-operation surface; the catalog bounds which `agent` names are spawnable.
 */
export const createAsyncAgentTools = (
  catalog: readonly string[],
  rpc: AsyncAgentRpc,
): readonly Tool[] => {
  const known = new Set(catalog);
  const spawn: Tool = {
    name: 'spawn_subagent',
    description:
      'Start one async child agent run for an explicit task and return its runId immediately. The child runs in a separate execution; it does not share this conversation. Call collect_subagent to read its result.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...catalog] },
        task: { type: 'string', minLength: 1, maxLength: MAX_TASK_BYTES },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
    async execute(argumentsValue: JsonValue, context?: ToolContext): Promise<string> {
      if (!isObject(argumentsValue)) {
        throw new ToolInputError('expected an object with agent and task');
      }
      const agent = readString(argumentsValue, 'agent');
      const task = readString(argumentsValue, 'task');
      if (agent === undefined || !known.has(agent)) {
        throw new ToolInputError(`agent must be one of: ${catalog.join(', ')}`);
      }
      if (task === undefined || task.trim().length === 0 || task.includes('\0')) {
        throw new ToolInputError('expected a nonblank task string');
      }
      if (encoder.encode(task).byteLength > MAX_TASK_BYTES) {
        throw new ToolInputError('task exceeds the 64 KiB limit');
      }
      const response = await invokeAsyncAgentRpc(rpc, { kind: 'spawn', agent, task }, context);
      if (response.ok && response.kind === 'spawn') {
        return JSON.stringify({ ok: true, runId: response.runId });
      }
      return failedResponse(response);
    },
  };
  const status: Tool = {
    name: 'subagent_status',
    description: 'Report the lifecycle state of one async child run by runId.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', minLength: 1 } },
      required: ['runId'],
      additionalProperties: false,
    },
    async execute(argumentsValue: JsonValue, context?: ToolContext): Promise<string> {
      const runId = requireRunId(argumentsValue);
      const response = await invokeAsyncAgentRpc(rpc, { kind: 'status', runId }, context);
      if (response.ok && response.kind === 'status') {
        return JSON.stringify({ ok: true, runId: response.runId, state: response.state });
      }
      return failedResponse(response);
    },
  };
  const collect: Tool = {
    name: 'collect_subagent',
    description:
      'Wait for one async child run to reach a terminal state and return its result. The result enters this conversation only through this tool result.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', minLength: 1 } },
      required: ['runId'],
      additionalProperties: false,
    },
    async execute(argumentsValue: JsonValue, context?: ToolContext): Promise<string> {
      const runId = requireRunId(argumentsValue);
      const response = await invokeAsyncAgentRpc(rpc, { kind: 'collect', runId }, context);
      if (response.ok && response.kind === 'collect') {
        return JSON.stringify({ ok: true, ...response.result });
      }
      return failedResponse(response);
    },
  };
  const cancel: Tool = {
    name: 'cancel_subagent',
    description: 'Cancel one async child run by runId.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', minLength: 1 } },
      required: ['runId'],
      additionalProperties: false,
    },
    async execute(argumentsValue: JsonValue, context?: ToolContext): Promise<string> {
      const runId = requireRunId(argumentsValue);
      const response = await invokeAsyncAgentRpc(rpc, { kind: 'cancel', runId }, context);
      if (response.ok && response.kind === 'cancel') {
        return JSON.stringify({ ok: true, runId: response.runId, state: response.state });
      }
      return failedResponse(response);
    },
  };
  return [spawn, status, collect, cancel];
};
