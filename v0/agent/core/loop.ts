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
import { Registry, type RegistryDispatchResult } from '../tools/tools.ts';
import {
  MAX_TOOL_PROGRESS_TEXT_BYTES,
  MAX_TOOL_PROGRESS_UPDATES_PER_CALL,
  type ModelExecutionContext,
  type ModelRequestSourceAttribution,
  type RequestMessageSourceFactory,
} from './execution_context.ts';
import { prepareModelContext } from './context.ts';
import { type SteeringConsumer } from './steering.ts';
import {
  type FailureDiagnosticFact,
  FailureDiagnosticOwner,
  type FailureDiagnosticV1,
  projectFailureDiagnosticFact,
} from '../session/failure_diagnostic.ts';
import {
  isPlannerDelegationFailureError,
  type PlannerDelegationFailureError,
} from '../tools/planner_delegation.ts';
import { MAX_CONVERSATION_TEXT_BYTES } from '../../resource_limits.ts';

/** Maximum UTF-8 bytes retained by one live assistant progress snapshot. */
export const MAX_ASSISTANT_TEXT_BYTES = MAX_CONVERSATION_TEXT_BYTES;
export const MAX_ASSISTANT_PROGRESS_TEXT_BYTES = MAX_ASSISTANT_TEXT_BYTES;

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
  /** Optional pure semantic parent projection, applied before defensive request preparation. */
  readonly projectParentRequest?: (request: ModelRequest) => ModelRequest;
  /** Projection that transforms transcript provenance in the same operation as its messages. */
  readonly projectParentRequestWithSources?: (
    request: ModelRequest,
    sources: ModelRequestSourceAttribution,
  ) => {
    readonly request: ModelRequest;
    readonly sources: ModelRequestSourceAttribution;
  };
  /** Worker-provided causal source factory used as messages are appended to the transcript. */
  readonly requestMessageSource?: RequestMessageSourceFactory;
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

const isProviderState = (
  value: unknown,
): value is NonNullable<ModelResult['providerState']> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  if (state.provider === 'openrouter-chat') {
    return Array.isArray(state.reasoningDetails) &&
      state.reasoningDetails.length > 0 &&
      state.reasoningDetails.every(isJsonValue);
  }
  return typeof state.provider === 'string' && state.provider.length > 0 &&
    Array.isArray(state.replayItems) && state.replayItems.length > 0 &&
    state.replayItems.every(isJsonValue) &&
    (state.model === undefined ||
      (typeof state.model === 'string' && state.model.length > 0));
};

const isModelResult = (value: unknown): value is ModelResult => {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  if (
    result.providerState !== undefined && !isProviderState(result.providerState)
  ) return false;
  if (result.kind === 'final') {
    return typeof result.text === 'string' &&
      new TextEncoder().encode(result.text).byteLength <=
        MAX_ASSISTANT_TEXT_BYTES;
  }
  return result.kind === 'tool_calls' && Array.isArray(result.calls) &&
    result.calls.length > 0 &&
    result.calls.every(isToolCall) &&
    (result.text === undefined ||
      typeof result.text === 'string' && result.text.length > 0 &&
        new TextEncoder().encode(result.text).byteLength <=
          MAX_ASSISTANT_TEXT_BYTES);
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
  text?: string,
  providerState?: ModelResult['providerState'],
): AssistantMessage => ({
  role: 'assistant',
  content: calls.map((call): ToolCallContent => snapshot({ kind: 'tool_call', ...call })),
  ...(text === undefined ? {} : { text }),
  ...(providerState === undefined ? {} : { providerState: snapshot(providerState) }),
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
  const requestMessageSource = options.requestMessageSource ??
    options.executionContext?.requestMessageSource;
  const projectParentRequestWithSources = options.projectParentRequestWithSources ??
    options.executionContext?.projectParentRequestWithSources;
  const transcript: Message[] = snapshotMessages(committedTranscript);
  const transcriptSources: Array<
    readonly import('../history/context_attribution.ts').ContextOccurrenceSource[]
  > = committedTranscript.map((message, messageIndex) =>
    requestMessageSource?.(
      message,
      'committed',
      messageIndex,
      undefined,
      options.executionContext?.lane,
      options.executionContext?.sourceCallId,
    ) ?? []
  );
  const userMessage: Message = {
    role: 'user',
    content: { kind: 'text', text: task },
  };
  transcript.push(userMessage);
  deliverEvent(sink, { kind: 'turn_start', turn });
  if (options.executionContext?.lane !== 'child') {
    deliverEvent(sink, {
      kind: 'user_message',
      turn,
      message: snapshot(userMessage),
    });
  }
  transcriptSources.push(
    requestMessageSource?.(
      userMessage,
      'task',
      committedTranscript.length,
      undefined,
      options.executionContext?.lane,
      options.executionContext?.sourceCallId,
    ) ?? [],
  );

  let steps = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let observedTranscriptLength = 0;

  const terminalRequestCounts = (): RequestCounts => {
    const turn = boundedCount(
      options.turnProviderRequestCount?.() ??
        options.executionContext?.providerRequestCount?.(),
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
  const evidenceLane = options.executionContext?.lane === 'child' ? 'planner' : 'parent';
  const evidenceIdentity = (): Pick<LoopOutcome, 'providerEvidenceId'> =>
    evidence === undefined ? {} : { providerEvidenceId: evidence.evidenceId };

  const diagnosticFor = (
    error: unknown,
    fallback: Partial<FailureDiagnosticFact> = {
      stage: 'unknown_stage',
      code: 'unknown_code',
    },
  ): FailureDiagnosticV1 | undefined => {
    const owner = options.diagnosticOwner ??
      options.executionContext?.diagnosticOwner;
    if (owner === undefined) return undefined;
    // A child or an earlier terminal path may already own the immutable record. Reuse it without
    // calling record again: collision is evidence of two independently-created records, not the
    // expected parent projection of one child failure.
    const existing = owner.snapshot();
    if (existing !== undefined) return existing;
    const observed = projectFailureDiagnosticFact(error);
    const stage = observed?.stage ?? fallback.stage ?? 'unknown_stage';
    const code = observed?.code ?? fallback.code ?? 'unknown_code';
    const count = options.turnProviderRequestCount?.() ??
      options.executionContext?.providerRequestCount?.() ??
      (stage === 'request_build' || stage === 'credential_resolution'
        ? observed?.providerRequestCount ?? fallback.providerRequestCount ?? 0
        : observed?.providerRequestCount ??
          options.executionContext?.snapshot().aggregate ??
          fallback.providerRequestCount ?? 0);
    const step = fallback.modelStep ??
      (stage === 'request_build' || stage === 'request_admission' ||
          stage === 'session_commit' ||
          stage === 'cancellation_cleanup' || stage === 'turn_control'
        ? 0
        : steps);
    try {
      return owner.record({
        stage,
        code,
        lane: options.executionContext?.lane === 'child' ? 'planner' : 'parent',
        providerRequestCount: count,
        retryCount: observed?.retryCount ?? 0,
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
      : {
        ...outcome,
        ...terminalRequestCounts(),
        diagnostic,
        ...evidenceIdentity(),
      };
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
    let preparedSources: import('./execution_context.ts').ModelRequestSourceAttribution = {
      transcript: transcriptSources,
    };
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
      let projected = request;
      if (projectParentRequestWithSources !== undefined) {
        const projectedWithSources = projectParentRequestWithSources(
          request,
          preparedSources,
        );
        projected = projectedWithSources.request;
        preparedSources = projectedWithSources.sources;
      } else if (options.projectParentRequest !== undefined) {
        projected = options.projectParentRequest(request);
      }
      preparedRequest = prepareModelContext(projected).request;
    } catch (error) {
      return finishContractFailure(
        `context preparation failure: ${errorText(error)}`,
        {
          stage: 'request_build',
          code: 'invalid_input',
          modelStep: 0,
        },
      );
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
    let contextRequestOrdinal: number | undefined;
    try {
      contextRequestOrdinal = await options.executionContext
        ?.observeModelRequest?.({
          request: preparedRequest,
          lane: options.executionContext?.lane ?? 'parent',
          modelStep: steps,
          modelSelection: options.executionContext?.modelSelection,
          sourceAttribution: preparedSources,
          previousTranscriptLength: observedTranscriptLength,
        });
      observedTranscriptLength = preparedRequest.transcript.length;
      evidence?.setContextRequestOrdinal(contextRequestOrdinal);
    } catch (error) {
      return finishContractFailure(
        `context request observation failure: ${errorText(error)}`,
        {
          stage: 'request_build',
          code: 'invalid_input',
          modelStep: steps,
        },
        error,
      );
    }
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
        evidence?.recordAssistantProgress(progressText, steps, evidenceLane);
      } catch (error) {
        progressFailure = error instanceof EventDeliveryError ? error : new EventDeliveryError();
        // Delivery failure owns cancellation synchronously. The model remains responsible for
        // settling its response body before this turn can reject.
        cancellation?.request();
        throw progressFailure;
      }
    };
    try {
      const generateOptions:
        | import('./contracts.ts').ModelGenerateOptions
        | undefined = signal === undefined && sink === undefined && evidence === undefined &&
            options.executionContext?.providerExactRequestObserver === undefined
          ? undefined
          : {
            signal,
            reportAssistantProgress: sink === undefined ? undefined : reportAssistantProgress,
            providerEvidence: evidence,
            providerExactRequestObserver: options.executionContext?.providerExactRequestObserver,
            providerEvidenceLane: options.executionContext?.lane === 'child' ? 'planner' : 'parent',
            modelStep: steps,
          };
      result = generateOptions === undefined
        ? await model.generate(preparedRequest)
        : await model.generate(preparedRequest, generateOptions);
    } catch (error) {
      evidence?.setContextRequestOrdinal(undefined);
      progressSettled = true;
      if (progressFailure !== undefined) {
        if (isCancellationCleanupError(error)) {
          cancellation?.markCleanupFailed();
        }
        throw progressFailure;
      }
      if (isCancellationCleanupError(error)) {
        return finishContractFailure('cancellation cleanup failed', {
          stage: 'cancellation_cleanup',
          code: 'cleanup_error',
          modelStep: 0,
        });
      }
      if (cancellationFrom(error)) {
        return finishCancelled();
      }
      return finishContractFailure(
        `model contract failure: ${errorText(error)}`,
        undefined,
        error,
      );
    }
    progressSettled = true;
    if (progressFailure !== undefined) throw progressFailure;
    if (signal?.aborted) {
      return finishCancelled();
    }
    if (!isModelResult(result)) {
      return finishContractFailure('model contract failure: invalid result', {
        stage: 'model_result_validation',
        code: 'invalid_model_result',
      });
    }
    evidence?.recordModelResult(result, steps, evidenceLane);
    if (result.kind === 'final') {
      evidence?.setContextRequestOrdinal(undefined);
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: { kind: 'text', text: result.text },
        ...(result.providerState === undefined
          ? {}
          : { providerState: snapshot(result.providerState) }),
      };
      const assistantIndex = transcript.length;
      transcript.push(assistant);
      deliverEvent(sink, {
        kind: 'assistant_message',
        turn,
        message: snapshot(assistant),
      });
      transcriptSources.push(
        requestMessageSource?.(
          assistant,
          'assistant',
          assistantIndex,
          steps,
          options.executionContext?.lane,
          options.executionContext?.sourceCallId,
        ) ?? [],
      );
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
    const assistant = assistantToolMessage(
      calls,
      result.text,
      result.providerState,
    );
    const assistantIndex = transcript.length;
    transcript.push(assistant);
    deliverEvent(sink, {
      kind: 'assistant_message',
      turn,
      message: snapshot(assistant),
    });
    transcriptSources.push(
      requestMessageSource?.(
        assistant,
        'assistant',
        assistantIndex,
        steps,
        options.executionContext?.lane,
        options.executionContext?.sourceCallId,
      ) ?? [],
    );
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
      evidence?.recordToolCall(call, steps, evidenceLane);
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
        evidence?.recordToolResult(resultContent, steps, evidenceLane);
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
          evidence?.recordToolProgress(call, progressText, steps, evidenceLane);
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
        const toolContext = sink === undefined
          ? {
            modelExecution: options.executionContext,
            modelStep: steps,
            callId: call.callId,
            signal,
            cancellation,
          }
          : {
            modelExecution: options.executionContext,
            modelStep: steps,
            callId: call.callId,
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
          evidence?.recordToolResult(plannerResult, steps, evidenceLane);
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
      evidence?.recordToolResult(results.at(-1)!, steps, evidenceLane);
    }
    const toolMessage: ToolMessage = { role: 'tool', content: results };
    transcript.push(toolMessage);
    transcriptSources.push(
      requestMessageSource?.(
        toolMessage,
        'tool',
        transcript.length - 1,
        steps,
        options.executionContext?.lane,
        options.executionContext?.sourceCallId,
      ) ?? [],
    );
    evidence?.setContextRequestOrdinal(undefined);
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
      transcriptSources.push(
        requestMessageSource?.(
          steeringMessage,
          'steering',
          transcript.length - 1,
          steps,
          options.executionContext?.lane,
          options.executionContext?.sourceCallId,
        ) ?? [],
      );
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
