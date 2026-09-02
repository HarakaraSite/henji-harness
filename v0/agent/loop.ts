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
  type ToolResultContent,
} from './contracts.ts';
import {
  type AgentEventSink,
  deliverEvent,
  EventDeliveryError,
  snapshot,
  snapshotMessages,
} from './events.ts';
import {
  isCancellationCleanupError,
  isTurnCancelledError,
  throwIfCancelled,
  type TurnCancellation,
} from './cancellation.ts';
import { Registry, type RegistryDispatchResult } from './tools.ts';
import {
  MAX_TOOL_PROGRESS_TEXT_BYTES,
  MAX_TOOL_PROGRESS_UPDATES_PER_CALL,
  type ModelExecutionContext,
} from './execution_context.ts';
import { prepareModelContext } from './context.ts';
import { type SteeringConsumer } from './steering.ts';
import {
  type FailureDiagnosticFact,
  FailureDiagnosticOwner,
  type FailureDiagnosticV1,
} from './failure_diagnostic.ts';
import {
  isPlannerDelegationFailureError,
  type PlannerDelegationFailureError,
} from './planner_delegation.ts';

/** Maximum UTF-8 bytes retained by one live assistant progress snapshot. */
export const MAX_ASSISTANT_PROGRESS_TEXT_BYTES = 65_536;

/** Maximum accepted live assistant snapshots for one admitted model request. */
export const MAX_ASSISTANT_PROGRESS_UPDATES_PER_REQUEST = 256;

export interface AgentLoopOptions {
  readonly maxSteps?: number;
  readonly systemInstruction?: string;
  readonly executionContext?: ModelExecutionContext;
  readonly cancellation?: TurnCancellation;
  readonly signal?: AbortSignal;
  /** Child loops share the owner for failure poisoning but do not settle the parent turn. */
  readonly ownsCancellation?: boolean;
  /** Optional turn-local owner. Direct compatibility callers may omit diagnostics. */
  readonly diagnosticOwner?: FailureDiagnosticOwner;
  /** Actual fetch starts attributed to this accepted turn, supplied by a session host. */
  readonly turnProviderRequestCount?: () => number;
  /** Cumulative actual fetch starts since the runtime process began. */
  readonly runtimeProviderRequestCount?: () => number;
}

export interface AgentTurnOptions extends AgentLoopOptions {
  readonly eventSink?: AgentEventSink;
  readonly turn?: number;
  readonly commit?: (transcript: readonly Message[]) => void;
  /** Internal single-use parent-turn steering lane. Planner child loops do not receive it. */
  readonly steering?: SteeringConsumer;
  /** Backwards-compatible internal port spelling for direct loop callers. */
  readonly steeringConsumer?: SteeringConsumer;
  /** Optional pure semantic parent projection, applied before mechanical omission. */
  readonly projectParentRequest?: (request: ModelRequest) => ModelRequest;
}

/**
 * Step-80-only observation boundary.  This is deliberately not part of the normal loop
 * options or event contract; the comparison runner is the only caller of the observed wrapper.
 */
export interface AgentComparisonExecutionObserver {
  readonly modelSettled: (kind: 'final' | 'tool_calls' | 'error' | 'cancelled') => void;
  readonly toolCallAccepted: (call: ToolCall) => void;
  readonly toolResultAccepted: (result: ToolResultContent) => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

const isToolCall = (value: unknown): value is ToolCall => {
  if (typeof value !== 'object' || value === null) return false;
  const call = value as Record<string, unknown>;
  return typeof call.callId === 'string' && call.callId.trim() !== '' &&
    typeof call.name === 'string' && call.name.trim() !== '' &&
    isJsonValue(call.arguments);
};

const isModelResult = (value: unknown): value is ModelResult => {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.kind === 'final') return typeof result.text === 'string';
  return result.kind === 'tool_calls' && Array.isArray(result.calls) &&
    result.calls.length > 0 &&
    result.calls.every(isToolCall);
};

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const isValidAssistantProgressSnapshot = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 &&
  hasWellFormedUnicode(value) &&
  new TextEncoder().encode(value).byteLength <=
    MAX_ASSISTANT_PROGRESS_TEXT_BYTES;

const isValidToolProgressSnapshot = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 &&
  hasWellFormedUnicode(value) &&
  new TextEncoder().encode(value).byteLength <= MAX_TOOL_PROGRESS_TEXT_BYTES;

const assistantToolMessage = (
  calls: readonly ToolCall[],
): AssistantMessage => ({
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
  diagnostic?: FailureDiagnosticV1,
  requestCounts: RequestCounts = {},
): LoopOutcome => ({
  ok: false,
  task,
  outcome: 'contract_failure',
  stopReason: 'contract_failure',
  error,
  ...(diagnostic === undefined ? {} : { diagnostic }),
  ...requestCounts,
  steps,
  toolCallCount,
  toolResultCount,
  transcript: snapshotMessages(transcript),
});

const failureFact = (error: unknown): Partial<FailureDiagnosticFact> | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = (error as { readonly failureFact?: unknown }).failureFact;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.stage !== 'string' || typeof value.code !== 'string' ||
    (value.requestCount !== 0 && value.requestCount !== 1)
  ) return undefined;
  return {
    stage: value.stage as FailureDiagnosticFact['stage'],
    code: value.code as FailureDiagnosticFact['code'],
    providerRequestCount: value.requestCount,
    ...(typeof value.httpStatus === 'number' ? { httpStatus: value.httpStatus } : {}),
    ...(typeof value.parseReason === 'string'
      ? { parseReason: value.parseReason as FailureDiagnosticFact['parseReason'] }
      : {}),
  };
};

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

interface RequestCounts {
  readonly turnProviderRequestCount?: number;
  readonly runtimeProviderRequestCount?: number;
}

const boundedCount = (value: unknown, max?: number): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
    (max === undefined || value <= max)
    ? value
    : undefined;

const terminalBatchError = (
  call: ToolCall,
): ToolMessage['content'][number] => ({
  kind: 'tool_result',
  callId: call.callId,
  name: call.name,
  text: 'terminal tool must be the sole call in its batch',
  outcome: 'error',
});

/** Execute exactly one user turn from a defensive copy of a committed transcript. */
const runAgentTurnInternal = async (
  task: string,
  committedTranscript: readonly Message[],
  model: Model,
  registry: Registry,
  observer: AgentComparisonExecutionObserver | undefined,
  options: AgentTurnOptions = {},
): Promise<LoopOutcome> => {
  const limit = options.maxSteps ?? 8;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }
  const turn = options.turn ?? 1;
  if (!Number.isInteger(turn) || turn <= 0) {
    throw new RangeError('turn must be a positive integer');
  }

  const sink = options.eventSink;
  const signal = options.cancellation?.signal ?? options.signal ??
    options.executionContext?.signal;
  const cancellation = options.cancellation;
  const steering = options.steering ?? options.steeringConsumer;
  const ownsCancellation = options.ownsCancellation !== false;
  const transcript: Message[] = snapshotMessages(committedTranscript);
  const userMessage: Message = {
    role: 'user',
    content: { kind: 'text', text: task },
  };
  transcript.push(userMessage);
  deliverEvent(sink, { kind: 'turn_start', turn });
  deliverEvent(sink, {
    kind: 'user_message',
    turn,
    message: snapshot(userMessage),
  });

  let steps = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;

  const terminalRequestCounts = (): RequestCounts => {
    const turn = boundedCount(
      options.turnProviderRequestCount?.() ?? options.executionContext?.providerRequestCount?.(),
      16,
    );
    const runtime = boundedCount(
      options.runtimeProviderRequestCount?.() ??
        options.executionContext?.runtimeProviderRequestCount?.(),
    );
    return {
      ...(turn === undefined ? {} : { turnProviderRequestCount: turn }),
      ...(runtime === undefined ? {} : { runtimeProviderRequestCount: runtime }),
    };
  };

  const evidence = options.executionContext?.providerEvidence;
  const evidenceIdentity = (): Pick<LoopOutcome, 'providerEvidenceId'> =>
    evidence === undefined ? {} : { providerEvidenceId: evidence.evidenceId };

  const diagnosticFor = (
    error: unknown,
    fallback: Partial<FailureDiagnosticFact> = {
      stage: 'unknown_stage',
      code: 'unknown_code',
    },
  ): FailureDiagnosticV1 | undefined => {
    const owner = options.diagnosticOwner ?? options.executionContext?.diagnosticOwner;
    if (owner === undefined) return undefined;
    // A child or an earlier terminal path may already own the immutable record. Reuse it without
    // calling record again: collision is evidence of two independently-created records, not the
    // expected parent projection of one child failure.
    const existing = owner.snapshot();
    if (existing !== undefined) return existing;
    const observed = failureFact(error);
    const stage = observed?.stage ?? fallback.stage ?? 'unknown_stage';
    const code = observed?.code ?? fallback.code ?? 'unknown_code';
    const count = options.turnProviderRequestCount?.() ??
      options.executionContext?.providerRequestCount?.() ??
      (stage === 'request_build' || stage === 'credential_resolution'
        ? observed?.providerRequestCount ?? fallback.providerRequestCount ?? 0
        : observed?.providerRequestCount ?? options.executionContext?.snapshot().aggregate ??
          fallback.providerRequestCount ?? 0);
    const step = fallback.modelStep ??
      (stage === 'request_build' || stage === 'request_admission' || stage === 'session_commit' ||
          stage === 'cancellation_cleanup' || stage === 'turn_control'
        ? 0
        : steps);
    try {
      return owner.record({
        stage,
        code,
        lane: options.executionContext?.lane === 'child' ? 'planner' : 'parent',
        providerRequestCount: count,
        modelStep: step,
        ...(observed?.httpStatus === undefined ? {} : { httpStatus: observed.httpStatus }),
        ...(observed?.parseReason === undefined ? {} : { parseReason: observed.parseReason }),
      });
    } catch {
      return owner.snapshot();
    }
  };

  const finishContractFailure = (
    error: string,
    fallback?: Partial<FailureDiagnosticFact>,
    cause: unknown = error,
  ): LoopOutcome => {
    if (error === 'cancellation cleanup failed') {
      cancellation?.markCleanupFailed();
    }
    if (
      error !== 'cancellation cleanup failed' && ownsCancellation &&
      cancellation !== undefined &&
      !cancellation.trySettleNormally()
    ) return finishCancelled();
    const diagnostic = diagnosticFor(cause, fallback);
    const outcome = contractFailure(
      task,
      transcript,
      steps,
      toolCallCount,
      toolResultCount,
      error,
      diagnostic,
      terminalRequestCounts(),
    );
    const withEvidence = { ...outcome, ...evidenceIdentity() };
    deliverEvent(sink, {
      kind: 'turn_end',
      turn,
      outcome: 'contract_failure',
      committed: false,
      ...terminalRequestCounts(),
      ...evidenceIdentity(),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
    return withEvidence;
  };
  const finishCancelled = (): LoopOutcome => {
    if (cancellation?.state === 'cleanup_failed') {
      return finishContractFailure('cancellation cleanup failed');
    }
    if (ownsCancellation) cancellation?.settleCancelled();
    const diagnostic = diagnosticFor(undefined, {
      stage: 'turn_control',
      code: 'turn_cancelled',
      modelStep: 0,
    });
    const outcome = cancelled(
      task,
      transcript,
      steps,
      toolCallCount,
      toolResultCount,
    );
    const settledOutcome = diagnostic === undefined
      ? { ...outcome, ...terminalRequestCounts(), ...evidenceIdentity() }
      : { ...outcome, ...terminalRequestCounts(), diagnostic, ...evidenceIdentity() };
    deliverEvent(sink, {
      kind: 'turn_end',
      turn,
      outcome: 'cancelled',
      committed: false,
      ...terminalRequestCounts(),
      ...evidenceIdentity(),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
    return settledOutcome;
  };
  const finishNormal = (outcome: LoopOutcome): LoopOutcome => {
    // A re-entrant cancellation from the final event sink wins over normal settlement.
    if (
      ownsCancellation && cancellation !== undefined &&
      !cancellation.trySettleNormally()
    ) {
      return finishCancelled();
    }
    const successful = outcome.ok &&
      (outcome.stopReason === 'final' ||
        outcome.stopReason === 'tool_terminal');
    const diagnostic = (
      options.diagnosticOwner ?? options.executionContext?.diagnosticOwner
    )?.snapshot();
    const requestCounts = terminalRequestCounts();
    const settledOutcome = diagnostic === undefined
      ? { ...outcome, ...requestCounts, ...evidenceIdentity() }
      : { ...outcome, ...requestCounts, diagnostic, ...evidenceIdentity() };
    if (successful) {
      try {
        options.commit?.(outcome.transcript);
      } catch (error) {
        const diagnostic = diagnosticFor(error, {
          stage: 'session_commit',
          code: 'commit_error',
          modelStep: 0,
        });
        const failure = contractFailure(
          task,
          transcript,
          steps,
          toolCallCount,
          toolResultCount,
          `session commit failure: ${errorText(error)}`,
          diagnostic,
          requestCounts,
        );
        deliverEvent(sink, {
          kind: 'turn_end',
          turn,
          outcome: 'contract_failure',
          committed: false,
          ...requestCounts,
          ...evidenceIdentity(),
          ...(diagnostic === undefined ? {} : { diagnostic }),
        });
        return { ...failure, ...evidenceIdentity() };
      }
    }
    deliverEvent(sink, {
      kind: 'turn_end',
      turn,
      outcome: settledOutcome.stopReason,
      committed: successful && options.commit !== undefined,
      ...terminalRequestCounts(),
      ...evidenceIdentity(),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
    return settledOutcome;
  };
  const finishMaxSteps = (): LoopOutcome => {
    if (signal?.aborted) return finishCancelled();
    diagnosticFor(undefined, {
      stage: 'turn_control',
      code: 'model_step_limit',
      modelStep: 0,
    });
    return finishNormal(
      maxSteps(task, transcript, steps, toolCallCount, toolResultCount),
    );
  };
  const cancellationFrom = (error: unknown): boolean =>
    isTurnCancelledError(error) ||
    (signal?.aborted === true && !isCancellationCleanupError(error));

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
        ? {
          transcript: snapshotMessages(transcript),
          tools: snapshot(registry.definitions()),
        }
        : {
          systemInstruction: options.systemInstruction,
          transcript: snapshotMessages(transcript),
          tools: snapshot(registry.definitions()),
        };
      const projected = options.projectParentRequest === undefined
        ? request
        : options.projectParentRequest(request);
      preparedRequest = prepareModelContext(projected).request;
    } catch (error) {
      return finishContractFailure(`context preparation failure: ${errorText(error)}`, {
        stage: 'request_build',
        code: 'invalid_input',
        modelStep: 0,
      });
    }
    try {
      throwIfCancelled(signal);
      if (
        options.executionContext !== undefined &&
        !options.executionContext.claimModelRequest()
      ) {
        return finishContractFailure('model request budget exhausted', {
          stage: 'request_admission',
          code: 'request_budget_exhausted',
          modelStep: 0,
        });
      }
      throwIfCancelled(signal);
    } catch (error) {
      if (isTurnCancelledError(error)) return finishCancelled();
      throw error;
    }
    steps += 1;
    let result: unknown;
    let progressFailure: EventDeliveryError | undefined;
    let progressSettled = false;
    let acceptedProgress = 0;
    const reportAssistantProgress = (progressText: string): void => {
      if (
        progressFailure !== undefined || progressSettled ||
        signal?.aborted === true ||
        acceptedProgress >= MAX_ASSISTANT_PROGRESS_UPDATES_PER_REQUEST ||
        !isValidAssistantProgressSnapshot(progressText)
      ) return;
      acceptedProgress += 1;
      try {
        deliverEvent(sink, {
          kind: 'assistant_progress',
          turn,
          text: progressText,
        });
      } catch (error) {
        progressFailure = error instanceof EventDeliveryError ? error : new EventDeliveryError();
        // Delivery failure owns cancellation synchronously. The model remains responsible for
        // settling its response body before this turn can reject.
        cancellation?.request();
        throw progressFailure;
      }
    };
    try {
      const generateOptions: import('./contracts.ts').ModelGenerateOptions | undefined =
        signal === undefined && sink === undefined && evidence === undefined ? undefined : {
          signal,
          reportAssistantProgress: sink === undefined ? undefined : reportAssistantProgress,
          providerEvidence: evidence,
          providerEvidenceLane: options.executionContext?.lane === 'child' ? 'planner' : 'parent',
          modelStep: steps,
        };
      result = generateOptions === undefined
        ? await model.generate(preparedRequest)
        : await model.generate(preparedRequest, generateOptions);
    } catch (error) {
      progressSettled = true;
      if (progressFailure !== undefined) {
        if (isCancellationCleanupError(error)) {
          cancellation?.markCleanupFailed();
        }
        throw progressFailure;
      }
      if (isCancellationCleanupError(error)) {
        observer?.modelSettled('error');
        return finishContractFailure('cancellation cleanup failed', {
          stage: 'cancellation_cleanup',
          code: 'cleanup_error',
          modelStep: 0,
        });
      }
      if (cancellationFrom(error)) {
        observer?.modelSettled('cancelled');
        return finishCancelled();
      }
      observer?.modelSettled('error');
      return finishContractFailure(
        `model contract failure: ${errorText(error)}`,
        undefined,
        error,
      );
    }
    progressSettled = true;
    if (progressFailure !== undefined) throw progressFailure;
    if (signal?.aborted) {
      observer?.modelSettled('cancelled');
      return finishCancelled();
    }
    if (!isModelResult(result)) {
      observer?.modelSettled('error');
      return finishContractFailure('model contract failure: invalid result', {
        stage: 'model_result_validation',
        code: 'invalid_model_result',
      });
    }
    evidence?.recordModelResult(result, steps);
    if (result.kind === 'final') {
      observer?.modelSettled('final');
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: { kind: 'text', text: result.text },
      };
      transcript.push(assistant);
      deliverEvent(sink, {
        kind: 'assistant_message',
        turn,
        message: snapshot(assistant),
      });
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
    observer?.modelSettled('tool_calls');
    const assistant = assistantToolMessage(calls);
    transcript.push(assistant);
    deliverEvent(sink, {
      kind: 'assistant_message',
      turn,
      message: snapshot(assistant),
    });
    const results: ToolMessage['content'][number][] = [];
    const terminalCalls = calls.filter((call) => registry.resolve(call.name)?.terminal === true);
    const invalidTerminalBatch = terminalCalls.length > 0 &&
      (calls.length !== 1 || terminalCalls.length !== 1);
    let terminalResult: {
      readonly kind: 'json_result';
      readonly finalText: string;
    } | null = null;
    for (const call of calls) {
      if (signal?.aborted) return finishCancelled();
      deliverEvent(sink, { kind: 'tool_call', turn, call: snapshot(call) });
      toolCallCount += 1;
      evidence?.recordToolCall(call, steps);
      observer?.toolCallAccepted(snapshot(call));
      if (signal?.aborted) return finishCancelled();
      if (invalidTerminalBatch) {
        const resultContent = terminalBatchError(call);
        results.push(resultContent);
        deliverEvent(sink, {
          kind: 'tool_result',
          turn,
          result: snapshot(resultContent),
        });
        toolResultCount += 1;
        observer?.toolResultAccepted(snapshot(resultContent));
        evidence?.recordToolResult(resultContent, steps);
        continue;
      }
      let progressFailure: EventDeliveryError | undefined;
      let progressSettled = false;
      let acceptedProgress = 0;
      const reportProgress = (progressText: string): void => {
        if (
          progressFailure !== undefined || progressSettled ||
          signal?.aborted === true ||
          acceptedProgress >= MAX_TOOL_PROGRESS_UPDATES_PER_CALL ||
          !isValidToolProgressSnapshot(progressText)
        ) return;
        acceptedProgress += 1;
        try {
          deliverEvent(sink, {
            kind: 'tool_progress',
            turn,
            callId: call.callId,
            name: call.name,
            text: progressText,
          });
        } catch (error) {
          progressFailure = error instanceof EventDeliveryError ? error : new EventDeliveryError();
          // The cancellation owner is synchronous by contract. The callback caller observes
          // the stable delivery error, while the active tool still owns resource settlement.
          cancellation?.request();
          throw progressFailure;
        }
      };
      let dispatched: RegistryDispatchResult | undefined;
      try {
        const toolContext = signal === undefined && options.executionContext === undefined &&
            cancellation === undefined && sink === undefined
          ? undefined
          : sink === undefined
          ? {
            modelExecution: options.executionContext,
            signal,
            cancellation,
          }
          : {
            modelExecution: options.executionContext,
            signal,
            cancellation,
            reportProgress,
          };
        const dispatchPromise = registry.dispatch(snapshot(call), toolContext);
        // Register before awaiting so the settlement gate closes before any continuation can
        // invoke a retained reporter after dispatch has resolved or rejected.
        void dispatchPromise.then(
          () => {
            progressSettled = true;
          },
          () => {
            progressSettled = true;
          },
        );
        dispatched = await dispatchPromise;
      } catch (error) {
        if (progressFailure !== undefined) {
          if (isCancellationCleanupError(error)) {
            cancellation?.markCleanupFailed();
          }
          throw progressFailure;
        }
        if (isCancellationCleanupError(error)) {
          return finishContractFailure('cancellation cleanup failed');
        }
        if (cancellationFrom(error)) return finishCancelled();
        if (isPlannerDelegationFailureError(error)) {
          const plannerFailure = error as PlannerDelegationFailureError;
          const plannerResult: ToolMessage['content'][number] = {
            kind: 'tool_result',
            callId: call.callId,
            name: call.name,
            text: plannerFailure.message,
            outcome: 'error',
          };
          results.push(plannerResult);
          deliverEvent(sink, {
            kind: 'tool_result',
            turn,
            result: snapshot(plannerResult),
          });
          toolResultCount += 1;
          observer?.toolResultAccepted(snapshot(plannerResult));
          return finishContractFailure(
            'planner delegation failed',
            {
              stage: plannerFailure.failureStage,
              code: plannerFailure.failureCode,
              modelStep: 0,
            },
            error,
          );
        }
        results.push({
          kind: 'tool_result',
          callId: call.callId,
          name: call.name,
          text: `tool execution error: ${errorText(error)}`,
          outcome: 'error',
        });
      } finally {
        progressSettled = true;
      }
      if (progressFailure !== undefined) throw progressFailure;
      if (dispatched !== undefined) {
        results.push(dispatched.content);
        if (dispatched.terminal !== null) terminalResult = dispatched.terminal;
      }
      if (signal?.aborted) return finishCancelled();
      deliverEvent(sink, {
        kind: 'tool_result',
        turn,
        result: snapshot(results.at(-1)!),
      });
      toolResultCount += 1;
      observer?.toolResultAccepted(snapshot(results.at(-1)!));
      evidence?.recordToolResult(results.at(-1)!, steps);
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
    if (signal?.aborted) return finishCancelled();
    const steeringText = steering?.consume();
    if (steeringText !== undefined) {
      const steeringMessage: Message = {
        role: 'user',
        content: { kind: 'text', text: steeringText },
      };
      transcript.push(steeringMessage);
      deliverEvent(sink, {
        kind: 'steering_message',
        turn,
        message: snapshot(steeringMessage),
      });
    }
  }
};

/** Execute one turn and close its optional steering lane on every terminal path. */
export const runAgentTurn = async (
  task: string,
  committedTranscript: readonly Message[],
  model: Model,
  registry: Registry,
  options: AgentTurnOptions = {},
): Promise<LoopOutcome> => {
  const steering = options.steering ?? options.steeringConsumer;
  try {
    return await runAgentTurnInternal(
      task,
      committedTranscript,
      model,
      registry,
      undefined,
      options,
    );
  } finally {
    steering?.close();
  }
};

/** Execute one turn with the private Step-80 comparison observation boundary enabled. */
export const runAgentTurnObservedForComparison = async (
  task: string,
  committedTranscript: readonly Message[],
  model: Model,
  registry: Registry,
  observer: AgentComparisonExecutionObserver,
  options: AgentTurnOptions = {},
): Promise<LoopOutcome> => {
  const steering = options.steering ?? options.steeringConsumer;
  try {
    return await runAgentTurnInternal(
      task,
      committedTranscript,
      model,
      registry,
      observer,
      options,
    );
  } finally {
    steering?.close();
  }
};

export const runAgent = (
  task: string,
  model: Model,
  registry: Registry,
  options: AgentLoopOptions = {},
): Promise<LoopOutcome> => runAgentTurn(task, [], model, registry, options);
