import type {
  AssistantMessage,
  LoopStopReason,
  ToolCall,
  ToolResultContent,
  UserMessage,
} from '../core/contracts.ts';
import type {
  ProviderEvidenceLane,
  ProviderEvidencePhase,
  ProviderEvidenceRuntimeEvent,
} from '../provider/provider_evidence.ts';
import type { WorkerExecutionSettlement } from './worker_execution_artifact.ts';
import type { WorkerExecutionArtifactStore } from './worker_execution_artifact_store.ts';
import type {
  HistoryPersistencePort,
  StoredExecutionEffect,
  StoredExecutionEvent,
  StoredExecutionRow,
} from '../history/history_store_contract.ts';

export type RecalledExecutionObservationV1 =
  | {
    readonly kind: 'assistant_completed';
    readonly modelStep: number;
    readonly text: string;
    readonly lane?: ProviderEvidenceLane;
  }
  | {
    readonly kind: 'assistant_incomplete';
    readonly modelStep: number;
    readonly text: string;
    readonly lane?: ProviderEvidenceLane;
  }
  | {
    readonly kind: 'tool_completed';
    readonly modelStep: number;
    readonly call: ToolCall;
    readonly result: ToolResultContent;
    readonly lane?: ProviderEvidenceLane;
  }
  | {
    readonly kind: 'tool_incomplete';
    readonly modelStep: number;
    readonly call: ToolCall;
    readonly progress?: string;
    readonly lane?: ProviderEvidenceLane;
  };

export interface RecalledExecutionContextV1 {
  readonly schemaVersion: 1;
  readonly sourceExecutionId: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly settlement: Extract<WorkerExecutionSettlement, 'uncommitted'>;
  readonly stopReason: LoopStopReason;
  readonly task: string;
  readonly error?: string;
  readonly evidence: 'available' | 'unavailable';
  readonly observations: readonly RecalledExecutionObservationV1[];
  readonly effectCommitRelation: 'not_transactional';
  readonly automaticReplay: false;
}

export interface RecalledProviderObservationV2 {
  readonly requestCount: number;
  readonly requests: readonly {
    readonly ordinal: number;
    readonly lane: ProviderEvidenceLane;
    readonly phase?: ProviderEvidencePhase;
    readonly modelStep: number;
    readonly endpoint: string;
    readonly provider?: string;
    readonly modelId?: string;
    readonly effort?: string;
    readonly api?: string;
    readonly contextRequestOrdinal?: number;
    readonly httpStatus?: number;
    readonly failure?: {
      readonly stage: string;
      readonly code: string;
      readonly parseReason?: string;
      readonly field?: string;
      readonly expectedShape?: string;
      readonly actualShape?: string;
    };
  }[];
  readonly responseCount: number;
}

export type RecalledJournalObservationV2 =
  | {
    readonly kind: 'user_message';
    readonly turn: number;
    readonly message: UserMessage;
  }
  | {
    readonly kind: 'steering_message';
    readonly turn: number;
    readonly message: UserMessage;
  }
  | {
    readonly kind: 'assistant_message';
    readonly turn: number;
    readonly message: Omit<AssistantMessage, 'providerState'>;
  }
  | {
    readonly kind: 'assistant_progress';
    readonly turn: number;
    readonly text: string;
  }
  | {
    readonly kind: 'tool_call';
    readonly turn: number;
    readonly call: ToolCall;
  }
  | {
    readonly kind: 'tool_progress';
    readonly turn: number;
    readonly callId: string;
    readonly name: string;
    readonly text: string;
  }
  | {
    readonly kind: 'tool_result';
    readonly turn: number;
    readonly result: ToolResultContent;
  };

/** Recall projection for schema-v2 reconciled executions without a fabricated LoopOutcome. */
export interface RecalledExecutionContextV2 {
  readonly schemaVersion: 2;
  readonly sourceExecutionId: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly lifecycle: 'settled';
  readonly outcome: 'cancelled' | 'failed' | 'interrupted' | 'unknown';
  readonly capture: 'complete' | 'partial';
  readonly task: string;
  readonly error?: string;
  readonly evidence: 'available' | 'unavailable';
  readonly observations: readonly RecalledExecutionObservationV1[];
  /** Meaning events observed by Host, retained independently of provider coalescing. */
  readonly journalObservations: readonly RecalledJournalObservationV2[];
  readonly journalEventCount: number;
  readonly effectObservations: readonly {
    readonly callId: string;
    readonly name: string;
    readonly status: StoredExecutionEffect['status'];
  }[];
  readonly providerObservation?: RecalledProviderObservationV2;
  readonly effectCommitRelation: 'not_transactional';
  readonly automaticReplay: false;
}

export type RecalledExecutionContext =
  | RecalledExecutionContextV1
  | RecalledExecutionContextV2;

export interface ResolveRecalledExecutionContextOptions {
  readonly sessionId: string;
  readonly executionId: string;
  /** Legacy V1 recall requires the artifact; schema-v2 rows are authoritative without it. */
  readonly executionArtifactStore?: WorkerExecutionArtifactStore;
  /** The v2 execution row/journal is the source of lifecycle and outcome truth. */
  readonly historyPersistence?: Pick<
    HistoryPersistencePort,
    'readExecution' | 'listExecutionEvents' | 'listExecutionEffects'
  >;
}

export class RecalledExecutionContextError extends Error {
  constructor(
    readonly code:
      | 'recall_session_mismatch'
      | 'recall_execution_not_uncommitted'
      | 'recall_evidence_mismatch',
  ) {
    super(code);
    this.name = 'RecalledExecutionContextError';
  }
}

const sameLane = (
  left: { readonly lane?: ProviderEvidenceLane },
  right: { readonly lane?: ProviderEvidenceLane },
): boolean => left.lane === right.lane;

const matchingModelResult = (
  events: readonly ProviderEvidenceRuntimeEvent[],
  progress: Extract<
    ProviderEvidenceRuntimeEvent,
    { readonly kind: 'assistant_progress' }
  >,
  progressIndex: number,
): boolean =>
  events.slice(progressIndex + 1).some((event) =>
    event.kind === 'model_result' && event.modelStep === progress.modelStep &&
    sameLane(event, progress)
  );

const matchingToolResult = (
  events: readonly ProviderEvidenceRuntimeEvent[],
  call: Extract<ProviderEvidenceRuntimeEvent, { readonly kind: 'tool_call' }>,
  callIndex: number,
  used: ReadonlySet<number>,
): {
  readonly index: number;
  readonly event: Extract<
    ProviderEvidenceRuntimeEvent,
    { readonly kind: 'tool_result' }
  >;
} | undefined => {
  for (let index = callIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (
      !used.has(index) && event.kind === 'tool_result' &&
      event.modelStep === call.modelStep &&
      event.result.callId === call.call.callId &&
      event.result.name === call.call.name && sameLane(event, call)
    ) return { index, event };
  }
  return undefined;
};

const matchingToolProgress = (
  events: readonly ProviderEvidenceRuntimeEvent[],
  call: Extract<ProviderEvidenceRuntimeEvent, { readonly kind: 'tool_call' }>,
  callIndex: number,
):
  | Extract<ProviderEvidenceRuntimeEvent, { readonly kind: 'tool_progress' }>
  | undefined =>
  events.slice(callIndex + 1).find((event): event is Extract<
    ProviderEvidenceRuntimeEvent,
    { readonly kind: 'tool_progress' }
  > =>
    event.kind === 'tool_progress' && event.modelStep === call.modelStep &&
    event.callId === call.call.callId && event.name === call.call.name &&
    sameLane(event, call)
  );

const observationsFromRuntimeEvents = (
  runtimeEvents: readonly ProviderEvidenceRuntimeEvent[],
): readonly RecalledExecutionObservationV1[] => {
  const observations: RecalledExecutionObservationV1[] = [];
  const usedToolResults = new Set<number>();
  for (
    let eventIndex = 0;
    eventIndex < runtimeEvents.length;
    eventIndex += 1
  ) {
    const event = runtimeEvents[eventIndex];
    if (event.kind === 'assistant_progress') {
      if (!matchingModelResult(runtimeEvents, event, eventIndex)) {
        observations.push({
          kind: 'assistant_incomplete',
          modelStep: event.modelStep,
          text: event.text,
          ...(event.lane === undefined ? {} : { lane: event.lane }),
        });
      }
      continue;
    }
    if (event.kind === 'model_result') {
      const text = event.result.text;
      if (text !== undefined) {
        observations.push({
          kind: 'assistant_completed',
          modelStep: event.modelStep,
          text,
          ...(event.lane === undefined ? {} : { lane: event.lane }),
        });
      }
      continue;
    }
    if (event.kind !== 'tool_call') continue;
    const matchedResult = matchingToolResult(
      runtimeEvents,
      event,
      eventIndex,
      usedToolResults,
    );
    const lane = event.lane === undefined ? {} : { lane: event.lane };
    if (matchedResult !== undefined) {
      usedToolResults.add(matchedResult.index);
      observations.push({
        kind: 'tool_completed',
        modelStep: event.modelStep,
        call: structuredClone(event.call),
        result: structuredClone(matchedResult.event.result),
        ...lane,
      });
      continue;
    }
    const progress = matchingToolProgress(
      runtimeEvents,
      event,
      eventIndex,
    );
    observations.push({
      kind: 'tool_incomplete',
      modelStep: event.modelStep,
      call: structuredClone(event.call),
      ...(progress === undefined ? {} : { progress: progress.text }),
      ...lane,
    });
  }
  return structuredClone(observations);
};

const observationsFromJournal = (
  events: readonly StoredExecutionEvent[],
): readonly RecalledJournalObservationV2[] => {
  const observations: RecalledJournalObservationV2[] = [];
  for (const stored of events) {
    const payload = stored.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;
    const payloadObject = payload as Record<string, unknown>;
    // Runtime deliveries and effects use different envelopes. Unwrap both forms, while also
    // accepting an already-unwrapped AgentEvent for journals produced by older host adapters.
    const workerEvent = stored.kind === 'effect_observation'
      ? payloadObject.effect ?? payloadObject
      : stored.kind === 'runtime_event'
      ? payloadObject.kind === 'provider_observation' &&
          typeof payloadObject.observation === 'object' &&
          payloadObject.observation !== null && !Array.isArray(payloadObject.observation)
        ? (payloadObject.observation as Record<string, unknown>).kind === 'runtime_event'
          ? (payloadObject.observation as Record<string, unknown>).event
          : undefined
        : payloadObject.event ?? payloadObject
      : undefined;
    if (typeof workerEvent !== 'object' || workerEvent === null || Array.isArray(workerEvent)) {
      continue;
    }
    const workerEventObject = workerEvent as Record<string, unknown>;
    const event = workerEventObject.kind === 'agent_event'
      ? workerEventObject.event
      : workerEventObject.kind === 'runtime_event'
      ? workerEventObject.event
      : workerEventObject;
    if (typeof event !== 'object' || event === null || Array.isArray(event)) continue;
    const eventObject = event as Record<string, unknown>;
    // Provider runtime observations do not carry the AgentEvent turn field. They are retained
    // when the Worker envelope did include it; the ordinary runtime/effect channels remain the
    // authoritative source for turn-scoped message/tool observations.
    const eventTurn = eventObject.turn ?? payloadObject.turn;
    if (!Number.isSafeInteger(eventTurn) || (eventTurn as number) < 1) continue;
    const turn = eventTurn as number;
    if (
      (eventObject.kind === 'user_message' || eventObject.kind === 'steering_message') &&
      typeof eventObject.message === 'object' &&
      eventObject.message !== null && !Array.isArray(eventObject.message)
    ) {
      observations.push({
        kind: eventObject.kind,
        turn,
        message: structuredClone(eventObject.message) as UserMessage,
      });
    } else if (
      eventObject.kind === 'assistant_message' &&
      typeof eventObject.message === 'object' &&
      eventObject.message !== null && !Array.isArray(eventObject.message)
    ) {
      const message = eventObject.message as AssistantMessage;
      observations.push({
        kind: eventObject.kind,
        turn,
        message: {
          role: 'assistant',
          content: structuredClone(message.content),
          ...(message.text === undefined ? {} : { text: message.text }),
        },
      });
    } else if (
      eventObject.kind === 'assistant_progress' &&
      typeof eventObject.text === 'string'
    ) {
      observations.push({
        kind: eventObject.kind,
        turn,
        text: eventObject.text,
      });
    } else if (
      eventObject.kind === 'tool_call' &&
      typeof eventObject.call === 'object' &&
      eventObject.call !== null && !Array.isArray(eventObject.call)
    ) {
      observations.push({
        kind: eventObject.kind,
        turn,
        call: structuredClone(eventObject.call) as ToolCall,
      });
    } else if (
      eventObject.kind === 'tool_progress' &&
      typeof eventObject.callId === 'string' &&
      typeof eventObject.name === 'string' &&
      typeof eventObject.text === 'string'
    ) {
      observations.push({
        kind: eventObject.kind,
        turn,
        callId: eventObject.callId,
        name: eventObject.name,
        text: eventObject.text,
      });
    } else if (
      eventObject.kind === 'tool_result' &&
      typeof eventObject.result === 'object' &&
      eventObject.result !== null && !Array.isArray(eventObject.result)
    ) {
      observations.push({
        kind: eventObject.kind,
        turn,
        result: structuredClone(eventObject.result) as ToolResultContent,
      });
    }
  }
  return structuredClone(observations);
};

const runtimeEventsFromJournal = (
  events: readonly StoredExecutionEvent[],
): readonly ProviderEvidenceRuntimeEvent[] =>
  events.flatMap((stored) => {
    if (stored.kind !== 'runtime_event') return [];
    const payload = stored.payload as Record<string, unknown>;
    if (payload.kind !== 'provider_observation') return [];
    const observation = payload.observation as Record<string, unknown> | undefined;
    if (observation?.kind !== 'runtime_event') return [];
    return [observation.event as ProviderEvidenceRuntimeEvent];
  });

const providerFactsFromJournal = (
  events: readonly StoredExecutionEvent[],
): RecalledProviderObservationV2 | undefined => {
  const requests = new Map<number, RecalledProviderObservationV2['requests'][number]>();
  for (const stored of events) {
    if (!stored.kind.startsWith('provider_')) continue;
    const payload = stored.payload as Record<string, unknown>;
    const observation = payload.observation as Record<string, unknown> | undefined;
    if (observation?.kind === 'request_start') {
      const request = observation.request as Record<string, unknown>;
      const metadata = request.requestMetadata as Record<string, unknown>;
      const ordinal = request.ordinal as number;
      requests.set(ordinal, {
        ordinal,
        lane: request.lane as ProviderEvidenceLane,
        ...(typeof request.phase === 'string'
          ? { phase: request.phase as ProviderEvidencePhase }
          : {}),
        modelStep: request.modelStep as number,
        endpoint: request.endpoint as string,
        ...(typeof request.contextRequestOrdinal === 'number'
          ? {
            contextRequestOrdinal: request.contextRequestOrdinal,
          }
          : {}),
        ...(typeof metadata.provider === 'string' ? { provider: metadata.provider } : {}),
        ...(typeof metadata.modelId === 'string' ? { modelId: metadata.modelId } : {}),
        ...(typeof metadata.api === 'string' ? { api: metadata.api } : {}),
        ...(typeof metadata.effort === 'string' ? { effort: metadata.effort } : {}),
      });
    } else if (typeof observation?.requestOrdinal === 'number') {
      const ordinal = observation.requestOrdinal;
      const request = requests.get(ordinal);
      if (request === undefined) continue;
      if (observation.kind === 'response_start') {
        const response = observation.response as Record<string, unknown>;
        requests.set(ordinal, { ...request, httpStatus: response.status as number });
      } else if (observation.kind === 'request_failure') {
        const failure = observation.failure as NonNullable<
          RecalledProviderObservationV2['requests'][number]['failure']
        >;
        requests.set(ordinal, {
          ...request,
          failure: { ...request.failure, ...failure },
        });
      } else if (observation.kind === 'parser_transition') {
        const transition = observation.transition as Record<string, unknown>;
        requests.set(ordinal, {
          ...request,
          failure: {
            stage: 'response_parse',
            code: 'response_error',
            ...(request.failure ?? {}),
            ...(typeof transition.reason === 'string' ? { parseReason: transition.reason } : {}),
            ...(typeof transition.field === 'string' ? { field: transition.field } : {}),
            ...(typeof transition.expectedShape === 'string'
              ? {
                expectedShape: transition.expectedShape,
              }
              : {}),
            ...(typeof transition.actualShape === 'string'
              ? {
                actualShape: transition.actualShape,
              }
              : {}),
          },
        });
      }
    }
  }
  if (requests.size === 0) return undefined;
  const ordered = [...requests.values()].sort((left, right) => left.ordinal - right.ordinal);
  return {
    requestCount: ordered.length,
    requests: ordered,
    responseCount: ordered.filter((request) => request.httpStatus !== undefined).length,
  };
};

export const resolveRecalledExecutionContext = async (
  options: ResolveRecalledExecutionContextOptions,
): Promise<RecalledExecutionContext> => {
  let executionRow: StoredExecutionRow | undefined;
  let executionEvents: readonly StoredExecutionEvent[] = [];
  let executionEffects: readonly StoredExecutionEffect[] = [];
  if (options.historyPersistence !== undefined) {
    executionRow = options.historyPersistence.readExecution(
      options.executionId,
    );
    executionEvents = options.historyPersistence.listExecutionEvents(
      options.executionId,
    );
    executionEffects = options.historyPersistence.listExecutionEffects(
      options.executionId,
    );
    if (
      executionRow.canonicalSessionId !== undefined
        ? executionRow.canonicalSessionId !== options.sessionId
        : executionRow.sessionCorrelation !== options.sessionId
    ) throw new RecalledExecutionContextError('recall_session_mismatch');
    if (
      executionRow.lifecycle !== 'settled' ||
      executionRow.adoption === 'canonical' ||
      !['cancelled', 'failed', 'interrupted', 'unknown'].includes(
        executionRow.outcome,
      )
    ) {
      throw new RecalledExecutionContextError(
        'recall_execution_not_uncommitted',
      );
    }
  }
  const artifact = executionRow !== undefined || options.executionArtifactStore === undefined
    ? undefined
    : await options.executionArtifactStore.read(options.executionId);
  if (executionRow === undefined && artifact === undefined) {
    throw new RecalledExecutionContextError('recall_evidence_mismatch');
  }
  if (executionRow === undefined && artifact!.sessionId !== options.sessionId) {
    throw new RecalledExecutionContextError('recall_session_mismatch');
  }
  if (
    artifact !== undefined && (
      artifact.settlement !== 'uncommitted' &&
      artifact.settlement !== 'interrupted' &&
      artifact.settlement !== 'unknown'
    )
  ) {
    throw new RecalledExecutionContextError('recall_execution_not_uncommitted');
  }
  if (artifact?.schemaVersion === 4 || executionRow !== undefined) {
    const normalizedOutcome = executionRow?.outcome ?? (
      artifact?.schemaVersion === 4 ? artifact.normalizedOutcome : 'unknown'
    );
    const outcome = normalizedOutcome === 'cancelled' || normalizedOutcome === 'failed'
      ? normalizedOutcome
      : normalizedOutcome === 'interrupted'
      ? 'interrupted'
      : 'unknown';
    const providerObservation = providerFactsFromJournal(executionEvents);
    const runtimeEvents = runtimeEventsFromJournal(executionEvents);
    return structuredClone({
      schemaVersion: 2,
      sourceExecutionId: executionRow?.executionId ?? artifact!.executionId,
      sessionId: executionRow?.canonicalSessionId ?? artifact?.sessionId ??
        options.sessionId,
      turn: executionRow?.turn ?? artifact!.turn,
      lifecycle: 'settled',
      outcome,
      capture: executionRow !== undefined &&
          executionRow.outcome !== 'interrupted' && executionRow.outcome !== 'unknown'
        ? 'complete' as const
        : 'partial' as const,
      task: executionRow?.task ?? artifact!.command.task,
      ...(executionRow?.outcomeJson?.error === undefined &&
          artifact?.schemaVersion !== 4 && artifact?.schemaVersion !== 5
        ? {}
        : executionRow?.outcomeJson?.error !== undefined
        ? { error: executionRow.outcomeJson.error }
        : (artifact?.schemaVersion === 4 || artifact?.schemaVersion === 5) &&
            artifact.outcome?.error !== undefined
        ? { error: artifact.outcome.error }
        : {}),
      evidence: providerObservation === undefined &&
          runtimeEvents.length === 0
        ? 'unavailable' as const
        : 'available' as const,
      observations: observationsFromRuntimeEvents(runtimeEvents),
      journalObservations: observationsFromJournal(executionEvents),
      ...(providerObservation === undefined ? {} : { providerObservation }),
      journalEventCount: executionEvents.length,
      effectObservations: executionEffects.map((effect) => ({
        callId: effect.callId,
        name: effect.name,
        status: effect.status,
      })),
      effectCommitRelation: 'not_transactional' as const,
      automaticReplay: false as const,
    });
  }
  if (artifact === undefined) {
    throw new RecalledExecutionContextError('recall_evidence_mismatch');
  }
  if (artifact.outcome === undefined) {
    throw new RecalledExecutionContextError('recall_evidence_mismatch');
  }
  const context: RecalledExecutionContextV1 = {
    schemaVersion: 1,
    sourceExecutionId: artifact.executionId,
    sessionId: artifact.sessionId,
    turn: artifact.turn,
    settlement: 'uncommitted',
    stopReason: artifact.outcome.stopReason,
    task: artifact.command.task,
    ...(artifact.outcome.error === undefined ? {} : { error: artifact.outcome.error }),
    evidence: 'unavailable',
    observations: [],
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
  };
  return structuredClone(context);
};

export const recalledExecutionProjectionText = (
  context: RecalledExecutionContext,
): string =>
  '[henji-recalled-execution:v1]\n' +
  'The following JSON is a read-only reference from a stopped earlier execution.\n' +
  'It is not a new tool result. Incomplete observations have unknown outcomes.\n' +
  'Do not automatically rerun a source tool; decide only from the current user task.\n' +
  JSON.stringify(context);

export const projectRecalledExecutionContext = (
  request: {
    readonly systemInstruction?: string;
    readonly transcript: readonly import('../core/contracts.ts').Message[];
    readonly tools: readonly import('../core/contracts.ts').ToolDefinition[];
  },
  context: RecalledExecutionContext,
  currentUserMessageIndex: number,
): typeof request => {
  if (
    !Number.isSafeInteger(currentUserMessageIndex) ||
    currentUserMessageIndex < 0 ||
    currentUserMessageIndex >= request.transcript.length ||
    request.transcript[currentUserMessageIndex]?.role !== 'user'
  ) throw new Error('recalled execution projection boundary is invalid');
  const recalled = {
    role: 'user' as const,
    content: {
      kind: 'text' as const,
      text: recalledExecutionProjectionText(context),
    },
  };
  return {
    ...(request.systemInstruction === undefined
      ? {}
      : { systemInstruction: request.systemInstruction }),
    transcript: structuredClone([
      ...request.transcript.slice(0, currentUserMessageIndex),
      recalled,
      ...request.transcript.slice(currentUserMessageIndex),
    ]),
    tools: structuredClone(request.tools),
  };
};
