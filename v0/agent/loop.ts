import {
  type AssistantMessage,
  type JsonValue,
  type LoopOutcome,
  type Message,
  type Model,
  type ModelRequest,
  type ModelResult,
  type ToolCall,
  type ToolCallContent,
  type ToolMessage,
} from './contracts.ts';
import { Registry } from './tools.ts';

export interface AgentLoopOptions {
  readonly maxSteps?: number;
  readonly systemInstruction?: string;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

const isToolCall = (value: unknown): value is ToolCall => {
  if (typeof value !== 'object' || value === null) return false;
  const call = value as Record<string, unknown>;
  return typeof call.callId === 'string' && call.callId.trim() !== '' &&
    typeof call.name === 'string' && call.name.trim() !== '' && isJsonValue(call.arguments);
};

const isModelResult = (value: unknown): value is ModelResult => {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.kind === 'final') return typeof result.text === 'string';
  return result.kind === 'tool_calls' && Array.isArray(result.calls) && result.calls.length > 0 &&
    result.calls.every(isToolCall);
};

const assistantToolMessage = (calls: readonly ToolCall[]): AssistantMessage => ({
  role: 'assistant',
  content: calls.map((call): ToolCallContent => ({ kind: 'tool_call', ...call })),
});

const contractFailure = (
  task: string,
  transcript: readonly Message[],
  steps: number,
  toolCallCount: number,
  toolResultCount: number,
  error: string,
): LoopOutcome => ({
  ok: false,
  task,
  outcome: 'contract_failure',
  stopReason: 'contract_failure',
  error,
  steps,
  toolCallCount,
  toolResultCount,
  transcript,
});

const maxSteps = (
  task: string,
  transcript: readonly Message[],
  steps: number,
  toolCallCount: number,
  toolResultCount: number,
): LoopOutcome => ({
  ok: false,
  task,
  outcome: 'max_steps',
  stopReason: 'max_steps',
  steps,
  toolCallCount,
  toolResultCount,
  transcript,
});

const terminalBatchError = (call: ToolCall): ToolMessage['content'][number] => ({
  kind: 'tool_result',
  callId: call.callId,
  name: call.name,
  text: 'terminal tool must be the sole call in its batch',
  outcome: 'error',
});

export const runAgent = async (
  task: string,
  model: Model,
  registry: Registry,
  options: AgentLoopOptions = {},
): Promise<LoopOutcome> => {
  const limit = options.maxSteps ?? 8;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }

  const transcript: Message[] = [{ role: 'user', content: { kind: 'text', text: task } }];
  let steps = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;

  for (;;) {
    if (steps >= limit) return maxSteps(task, transcript, steps, toolCallCount, toolResultCount);
    const request: ModelRequest = options.systemInstruction === undefined
      ? { transcript, tools: registry.definitions() }
      : { systemInstruction: options.systemInstruction, transcript, tools: registry.definitions() };
    steps += 1;

    let result: unknown;
    try {
      result = await model.generate(request);
    } catch (error) {
      return contractFailure(
        task,
        transcript,
        steps,
        toolCallCount,
        toolResultCount,
        `model contract failure: ${errorText(error)}`,
      );
    }
    if (!isModelResult(result)) {
      return contractFailure(
        task,
        transcript,
        steps,
        toolCallCount,
        toolResultCount,
        'model contract failure: invalid result',
      );
    }

    if (result.kind === 'final') {
      transcript.push({ role: 'assistant', content: { kind: 'text', text: result.text } });
      return {
        ok: true,
        task,
        outcome: 'final',
        stopReason: 'final',
        finalText: result.text,
        steps,
        toolCallCount,
        toolResultCount,
        transcript,
      };
    }

    transcript.push(assistantToolMessage(result.calls));
    const results: ToolMessage['content'][number][] = [];
    const terminalCalls = result.calls.filter((call) =>
      registry.resolve(call.name)?.terminal === true
    );
    const invalidTerminalBatch = terminalCalls.length > 0 &&
      (result.calls.length !== 1 || terminalCalls.length !== 1);
    let terminalResult: { readonly kind: 'json_result'; readonly finalText: string } | null = null;
    if (invalidTerminalBatch) {
      for (const call of result.calls) results.push(terminalBatchError(call));
      toolCallCount += result.calls.length;
      toolResultCount += result.calls.length;
    } else {
      for (const call of result.calls) {
        toolCallCount += 1;
        try {
          const dispatched = await registry.dispatch(call);
          results.push(dispatched.content);
          if (dispatched.terminal !== null) terminalResult = dispatched.terminal;
        } catch (error) {
          results.push({
            kind: 'tool_result',
            callId: call.callId,
            name: call.name,
            text: `tool execution error: ${errorText(error)}`,
            outcome: 'error',
          });
        }
        toolResultCount += 1;
      }
    }
    transcript.push({ role: 'tool', content: results });

    if (terminalResult !== null) {
      return {
        ok: true,
        task,
        outcome: 'final',
        stopReason: 'tool_terminal',
        finalText: terminalResult.finalText,
        terminalKind: terminalResult.kind,
        steps,
        toolCallCount,
        toolResultCount,
        transcript,
      };
    }

    if (steps >= limit) return maxSteps(task, transcript, steps, toolCallCount, toolResultCount);
  }
};
