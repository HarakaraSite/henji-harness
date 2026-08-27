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
import { type AgentEventSink, deliverEvent, snapshot, snapshotMessages } from './events.ts';
import {
  isCancellationCleanupError,
  isTurnCancelledError,
  throwIfCancelled,
  type TurnCancellation,
} from './cancellation.ts';
import { Registry } from './tools.ts';
import { type ModelExecutionContext } from './execution_context.ts';
import { prepareModelContext } from './context.ts';

export interface AgentLoopOptions {
  readonly maxSteps?: number;
  readonly systemInstruction?: string;
  readonly executionContext?: ModelExecutionContext;
  readonly cancellation?: TurnCancellation;
  readonly signal?: AbortSignal;
  /** Child loops share the owner for failure poisoning but do not settle the parent turn. */
  readonly ownsCancellation?: boolean;
}

export interface AgentTurnOptions extends AgentLoopOptions {
  readonly eventSink?: AgentEventSink;
  readonly turn?: number;
  readonly commit?: (transcript: readonly Message[]) => void;
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
  content: calls.map((call): ToolCallContent => snapshot({ kind: 'tool_call', ...call })),
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
  transcript: snapshotMessages(transcript),
});

const cancelled = (
  task: string,
  transcript: readonly Message[],
  steps: number,
  toolCallCount: number,
  toolResultCount: number,
): LoopOutcome => ({
  ok: false,
  task,
  outcome: 'cancelled',
  stopReason: 'cancelled',
  steps,
  toolCallCount,
  toolResultCount,
  transcript: snapshotMessages(transcript),
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
  transcript: snapshotMessages(transcript),
});

const terminalBatchError = (call: ToolCall): ToolMessage['content'][number] => ({
  kind: 'tool_result',
  callId: call.callId,
  name: call.name,
  text: 'terminal tool must be the sole call in its batch',
  outcome: 'error',
});

/** Execute exactly one user turn from a defensive copy of a committed transcript. */
export const runAgentTurn = async (
  task: string,
  committedTranscript: readonly Message[],
  model: Model,
  registry: Registry,
  options: AgentTurnOptions = {},
): Promise<LoopOutcome> => {
  const limit = options.maxSteps ?? 8;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }
  const turn = options.turn ?? 1;
  if (!Number.isInteger(turn) || turn <= 0) throw new RangeError('turn must be a positive integer');

  const sink = options.eventSink;
  const signal = options.cancellation?.signal ?? options.signal ?? options.executionContext?.signal;
  const cancellation = options.cancellation;
  const ownsCancellation = options.ownsCancellation !== false;
  const transcript: Message[] = snapshotMessages(committedTranscript);
  const userMessage: Message = { role: 'user', content: { kind: 'text', text: task } };
  transcript.push(userMessage);
  deliverEvent(sink, { kind: 'turn_start', turn });
  deliverEvent(sink, { kind: 'user_message', turn, message: snapshot(userMessage) });

  let steps = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;

  const finishContractFailure = (error: string): LoopOutcome => {
    if (error === 'cancellation cleanup failed') cancellation?.markCleanupFailed();
    if (
      error !== 'cancellation cleanup failed' && ownsCancellation && cancellation !== undefined &&
      !cancellation.trySettleNormally()
    ) return finishCancelled();
    const outcome = contractFailure(
      task,
      transcript,
      steps,
      toolCallCount,
      toolResultCount,
      error,
    );
    deliverEvent(sink, { kind: 'turn_end', turn, outcome: 'contract_failure', committed: false });
    return outcome;
  };
  const finishCancelled = (): LoopOutcome => {
    if (cancellation?.state === 'cleanup_failed') {
      return finishContractFailure('cancellation cleanup failed');
    }
    if (ownsCancellation) cancellation?.settleCancelled();
    const outcome = cancelled(task, transcript, steps, toolCallCount, toolResultCount);
    deliverEvent(sink, { kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
    return outcome;
  };
  const finishNormal = (outcome: LoopOutcome): LoopOutcome => {
    // A re-entrant cancellation from the final event sink wins over normal settlement.
    if (ownsCancellation && cancellation !== undefined && !cancellation.trySettleNormally()) {
      return finishCancelled();
    }
    const successful = outcome.ok &&
      (outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal');
    if (successful) options.commit?.(outcome.transcript);
    deliverEvent(sink, {
      kind: 'turn_end',
      turn,
      outcome: outcome.stopReason,
      committed: successful && options.commit !== undefined,
    });
    return outcome;
  };
  const finishMaxSteps = (): LoopOutcome => {
    if (signal?.aborted) return finishCancelled();
    return finishNormal(maxSteps(task, transcript, steps, toolCallCount, toolResultCount));
  };
  const cancellationFrom = (error: unknown): boolean =>
    isTurnCancelledError(error) || (signal?.aborted === true && !isCancellationCleanupError(error));

  for (;;) {
    if (signal?.aborted) return finishCancelled();
    if (steps >= limit) return finishMaxSteps();
    try {
      throwIfCancelled(signal);
    } catch (error) {
      if (isTurnCancelledError(error)) return finishCancelled();
      throw error;
    }
    let preparedRequest: ModelRequest;
    try {
      const request: ModelRequest = options.systemInstruction === undefined
        ? { transcript: snapshotMessages(transcript), tools: snapshot(registry.definitions()) }
        : {
          systemInstruction: options.systemInstruction,
          transcript: snapshotMessages(transcript),
          tools: snapshot(registry.definitions()),
        };
      preparedRequest = prepareModelContext(request).request;
    } catch (error) {
      return finishNormal(
        contractFailure(
          task,
          transcript,
          steps,
          toolCallCount,
          toolResultCount,
          `context preparation failure: ${errorText(error)}`,
        ),
      );
    }
    try {
      throwIfCancelled(signal);
      if (options.executionContext !== undefined && !options.executionContext.claimModelRequest()) {
        return finishNormal(
          contractFailure(
            task,
            transcript,
            steps,
            toolCallCount,
            toolResultCount,
            'model request budget exhausted',
          ),
        );
      }
      throwIfCancelled(signal);
    } catch (error) {
      if (isTurnCancelledError(error)) return finishCancelled();
      throw error;
    }
    steps += 1;
    let result: unknown;
    try {
      result = signal === undefined
        ? await model.generate(preparedRequest)
        : await model.generate(preparedRequest, { signal });
    } catch (error) {
      if (isCancellationCleanupError(error)) {
        return finishContractFailure('cancellation cleanup failed');
      }
      if (cancellationFrom(error)) return finishCancelled();
      return finishContractFailure(`model contract failure: ${errorText(error)}`);
    }
    if (signal?.aborted) return finishCancelled();
    if (!isModelResult(result)) {
      return finishNormal(
        contractFailure(
          task,
          transcript,
          steps,
          toolCallCount,
          toolResultCount,
          'model contract failure: invalid result',
        ),
      );
    }
    if (result.kind === 'final') {
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: { kind: 'text', text: result.text },
      };
      transcript.push(assistant);
      deliverEvent(sink, { kind: 'assistant_message', turn, message: snapshot(assistant) });
      if (signal?.aborted) return finishCancelled();
      return finishNormal({
        ok: true,
        task,
        outcome: 'final',
        stopReason: 'final',
        finalText: result.text,
        steps,
        toolCallCount,
        toolResultCount,
        transcript: snapshotMessages(transcript),
      });
    }

    const calls = snapshot(result.calls);
    const assistant = assistantToolMessage(calls);
    transcript.push(assistant);
    deliverEvent(sink, { kind: 'assistant_message', turn, message: snapshot(assistant) });
    const results: ToolMessage['content'][number][] = [];
    const terminalCalls = calls.filter((call) => registry.resolve(call.name)?.terminal === true);
    const invalidTerminalBatch = terminalCalls.length > 0 &&
      (calls.length !== 1 || terminalCalls.length !== 1);
    let terminalResult: { readonly kind: 'json_result'; readonly finalText: string } | null = null;
    for (const call of calls) {
      if (signal?.aborted) return finishCancelled();
      deliverEvent(sink, { kind: 'tool_call', turn, call: snapshot(call) });
      toolCallCount += 1;
      if (signal?.aborted) return finishCancelled();
      if (invalidTerminalBatch) {
        const resultContent = terminalBatchError(call);
        results.push(resultContent);
        deliverEvent(sink, { kind: 'tool_result', turn, result: snapshot(resultContent) });
        toolResultCount += 1;
        continue;
      }
      try {
        const toolContext = signal === undefined && options.executionContext === undefined &&
            cancellation === undefined
          ? undefined
          : {
            modelExecution: options.executionContext,
            signal,
            cancellation,
          };
        const dispatched = await registry.dispatch(snapshot(call), toolContext);
        results.push(dispatched.content);
        if (dispatched.terminal !== null) terminalResult = dispatched.terminal;
      } catch (error) {
        if (isCancellationCleanupError(error)) {
          return finishContractFailure('cancellation cleanup failed');
        }
        if (cancellationFrom(error)) return finishCancelled();
        results.push({
          kind: 'tool_result',
          callId: call.callId,
          name: call.name,
          text: `tool execution error: ${errorText(error)}`,
          outcome: 'error',
        });
      }
      if (signal?.aborted) return finishCancelled();
      deliverEvent(sink, { kind: 'tool_result', turn, result: snapshot(results.at(-1)!) });
      toolResultCount += 1;
    }
    transcript.push({ role: 'tool', content: results });
    if (signal?.aborted) return finishCancelled();
    if (terminalResult !== null) {
      return finishNormal({
        ok: true,
        task,
        outcome: 'final',
        stopReason: 'tool_terminal',
        finalText: terminalResult.finalText,
        terminalKind: terminalResult.kind,
        steps,
        toolCallCount,
        toolResultCount,
        transcript: snapshotMessages(transcript),
      });
    }
    if (steps >= limit) return finishMaxSteps();
  }
};

export const runAgent = (
  task: string,
  model: Model,
  registry: Registry,
  options: AgentLoopOptions = {},
): Promise<LoopOutcome> => runAgentTurn(task, [], model, registry, options);
