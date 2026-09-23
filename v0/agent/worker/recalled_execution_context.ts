import type {
  AssistantMessage,
  LoopStopReason,
  ToolCall,
  ToolResultContent,
  UserMessage,
} from '../core/contracts.ts';
import { sameDefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';
import type {
  ProviderEvidenceLane,
  ProviderEvidencePhase,
  ProviderEvidenceRuntimeEvent,
  ProviderEvidenceStore,
  StoredProviderEvidence,
} from '../provider/provider_evidence.ts';
import type {
  StoredWorkerExecutionArtifact,
  WorkerExecutionSettlement,
} from './worker_execution_artifact.ts';
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
  }[];
  readonly responseCount: number;
  readonly receivedResponseBytes: number;
  readonly sseEventCount: number;
  readonly lastSseEventOrdinal?: number;
  readonly parserTransitionCount: number;
  readonly lastParserState?: string;
  readonly terminalObserved: boolean;
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
  readonly providerEvidenceStore?: ProviderEvidenceStore;
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

const observationsFromEvidence = (
  evidence: StoredProviderEvidence,
): readonly RecalledExecutionObservationV1[] => {
  const observations: RecalledExecutionObservationV1[] = [];
  const usedToolResults = new Set<number>();
  for (
    let eventIndex = 0;
    eventIndex < evidence.runtimeEvents.length;
    eventIndex += 1
  ) {
    const event = evidence.runtimeEvents[eventIndex];
    if (event.kind === 'assistant_progress') {
      if (!matchingModelResult(evidence.runtimeEvents, event, eventIndex)) {
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
      evidence.runtimeEvents,
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
      evidence.runtimeEvents,
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

const evidenceNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null &&
  (error as { readonly code?: unknown }).code === 'provider_evidence_not_found';

const readCorrelatedEvidence = async (
  reference: Pick<
    StoredWorkerExecutionArtifact,
    'providerEvidenceId' | 'sessionId' | 'turn' | 'build' | 'definition'
  >,
  store: ProviderEvidenceStore | undefined,
): Promise<StoredProviderEvidence | undefined> => {
  if (reference.providerEvidenceId === undefined || store === undefined) {
    return undefined;
  }
  let evidence: StoredProviderEvidence;
  try {
    evidence = await store.read(reference.providerEvidenceId);
  } catch (error) {
    if (evidenceNotFound(error)) return undefined;
    throw error;
  }
  if (
    evidence.evidenceId !== reference.providerEvidenceId ||
    evidence.sessionId !== reference.sessionId ||
    evidence.turnNumber !== reference.turn ||
    evidence.build.buildId !== reference.build.buildId ||
    !sameDefinitionRevisionRef(evidence.definition, reference.definition)
  ) throw new RecalledExecutionContextError('recall_evidence_mismatch');
  return evidence;
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
    if (!Number.isSafeInteger(eventObject.turn) || (eventObject.turn as number) < 1) continue;
    const turn = eventObject.turn as number;
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
  const evidenceReference = artifact ?? {
    providerEvidenceId: executionRow!.providerEvidenceId,
    sessionId: executionRow!.canonicalSessionId ??
      executionRow!.sessionCorrelation,
    turn: executionRow!.turn,
    build: executionRow!.build,
    definition: executionRow!.definition,
  };
  const evidence = await readCorrelatedEvidence(
    evidenceReference,
    options.providerEvidenceStore,
  );
  if (artifact?.schemaVersion === 4 || executionRow !== undefined) {
    const normalizedOutcome = executionRow?.outcome ?? (
      artifact?.schemaVersion === 4 ? artifact.normalizedOutcome : 'unknown'
    );
    const outcome = normalizedOutcome === 'cancelled' || normalizedOutcome === 'failed'
      ? normalizedOutcome
      : normalizedOutcome === 'interrupted'
      ? 'interrupted'
      : 'unknown';
    const providerObservation = evidence === undefined ? undefined : {
      requestCount: evidence.requests.length,
      requests: evidence.requests.map((record) => ({
        ordinal: record.request.ordinal,
        lane: record.request.lane,
        ...(record.request.phase === undefined ? {} : { phase: record.request.phase }),
        modelStep: record.request.modelStep,
        endpoint: record.request.endpoint,
        ...(record.request.requestMetadata.provider === undefined
          ? {}
          : { provider: record.request.requestMetadata.provider }),
        ...(record.request.requestMetadata.modelId === undefined
          ? {}
          : { modelId: record.request.requestMetadata.modelId }),
        ...(record.request.requestMetadata.effort === undefined
          ? {}
          : { effort: record.request.requestMetadata.effort }),
      })),
      responseCount: evidence.requests.filter((record) => record.response !== undefined).length,
      receivedResponseBytes: evidence.requests.reduce(
        (sum, record) => sum + (record.response?.rawBodyBytes ?? 0),
        0,
      ),
      sseEventCount: evidence.requests.reduce(
        (sum, record) => sum + record.sseEvents.length,
        0,
      ),
      ...(evidence.requests.at(-1)?.sseEvents.at(-1) === undefined ? {} : {
        lastSseEventOrdinal: evidence.requests.at(-1)!.sseEvents.at(-1)!.ordinal,
      }),
      parserTransitionCount: evidence.requests.reduce(
        (sum, record) => sum + record.parserTransitions.length,
        0,
      ),
      ...(evidence.requests.at(-1)?.parserTransitions.at(-1) === undefined ? {} : {
        lastParserState: evidence.requests.at(-1)!.parserTransitions.at(-1)!.kind,
      }),
      terminalObserved: evidence.requests.some((record) =>
        record.parserTransitions.some((transition) =>
          transition.kind === 'terminal' || transition.kind === 'result'
        )
      ),
    } satisfies RecalledProviderObservationV2;
    return structuredClone({
      schemaVersion: 2,
      sourceExecutionId: executionRow?.executionId ?? artifact!.executionId,
      sessionId: executionRow?.canonicalSessionId ?? artifact?.sessionId ??
        options.sessionId,
      turn: executionRow?.turn ?? artifact!.turn,
      lifecycle: 'settled',
      outcome,
      capture: (evidence?.schemaVersion === 4 || evidence?.schemaVersion === 5) &&
          evidence.capture === 'complete'
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
      evidence: evidence === undefined ? 'unavailable' as const : 'available' as const,
      observations: evidence === undefined ? [] : observationsFromEvidence(evidence),
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
    evidence: evidence === undefined ? 'unavailable' : 'available',
    observations: evidence === undefined ? [] : observationsFromEvidence(evidence),
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
