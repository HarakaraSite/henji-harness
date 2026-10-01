import type { Message } from '../core/contracts.ts';
import { indexSessionHistoryPrefix } from '../session/session_history.ts';
import { CORE_OPERATION_NAMES } from '../../api/contract.ts';
import type {
  ApiCheckpoint,
  ApiMessage,
  ApiRequestText,
  ApiSelection,
  ApiThinking,
  ApiToolOccurrence,
  ContextView,
  ExecutionView,
  PendingView,
  RequestKey,
  SessionSnapshot,
} from '../../api/contract.ts';
import { requestKeyIdentity } from '../../api/reducer.ts';
import type { ProviderEvidenceRuntimeEvent } from '../provider/provider_evidence.ts';
import type {
  StoredExecutionEvent,
  StoredExecutionRow,
  StoredSessionHistoryExecution,
} from '../history/history_store_contract.ts';
import type { HistoryV7SemanticOccurrence } from '../history/history_v7_model.ts';
import type { AgentEvent } from '../core/events.ts';
import type { ApplicationQueryPort, ApplicationSessionState } from './application_port.ts';

export type ApiProjectionCursor = Readonly<
  { coreEpoch: string; revision: number }
>;

export type ApiExecutionProjectionState = Readonly<{
  readonly submittedByCommandId?: string;
  readonly processSettlement?: ExecutionView['processSettlement'];
}>;

type RuntimeToolEvent = Extract<ProviderEvidenceRuntimeEvent, {
  kind: 'tool_call' | 'tool_progress' | 'tool_result';
}>;

type OccurrenceEvent = Readonly<{
  occurrence: HistoryV7SemanticOccurrence;
  event: StoredExecutionEvent;
  runtimeEvent: ProviderEvidenceRuntimeEvent;
}>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const runtimeEventFromStoredEvent = (
  event: StoredExecutionEvent,
): ProviderEvidenceRuntimeEvent | undefined => {
  if (!isObject(event.payload) || !isObject(event.payload.observation)) {
    return undefined;
  }
  const observation = event.payload.observation;
  if (observation.kind !== 'runtime_event' || !isObject(observation.event)) {
    return undefined;
  }
  return observation.event as unknown as ProviderEvidenceRuntimeEvent;
};

const storedExecutionEventFromOccurrence = (
  occurrence: HistoryV7SemanticOccurrence,
): StoredExecutionEvent | undefined => {
  if (!isObject(occurrence.payload) || !isObject(occurrence.payload.event)) {
    return undefined;
  }
  return occurrence.payload.event as unknown as StoredExecutionEvent;
};

const eventFromOccurrence = (
  occurrence: HistoryV7SemanticOccurrence,
): OccurrenceEvent | undefined => {
  const event = storedExecutionEventFromOccurrence(occurrence);
  if (event === undefined) return undefined;
  const runtimeEvent = runtimeEventFromStoredEvent(event);
  if (runtimeEvent === undefined) return undefined;
  return {
    occurrence,
    event,
    runtimeEvent,
  };
};

const agentEventFromStoredEvent = (event: StoredExecutionEvent): AgentEvent | undefined => {
  if (event.kind !== 'runtime_event' || !isObject(event.payload)) return undefined;
  const payload = event.payload;
  if (
    payload.kind !== 'runtime_event' || !isObject(payload.event) ||
    payload.event.kind !== 'agent_event' || !isObject(payload.event.event)
  ) return undefined;
  return payload.event.event as unknown as AgentEvent;
};

const requestKey = (
  executionId: string,
  event: ProviderEvidenceRuntimeEvent,
): RequestKey | undefined => {
  if (event.kind === 'turn_outcome') return undefined;
  return {
    executionId,
    ...(event.lane === undefined ? {} : { lane: event.lane }),
    modelStep: event.modelStep,
    ...(event.requestOrdinal === undefined ? {} : { requestOrdinal: event.requestOrdinal }),
  };
};

const requestKeyFromStartEvent = (
  event: StoredExecutionEvent,
): RequestKey | undefined => {
  if (!isObject(event.payload) || !isObject(event.payload.observation)) {
    return undefined;
  }
  const observation = event.payload.observation;
  if (observation.kind !== 'request_start' || !isObject(observation.request)) {
    return undefined;
  }
  const request = observation.request;
  if (
    typeof request.ordinal !== 'number' ||
    typeof request.modelStep !== 'number' ||
    (request.lane !== 'parent' && request.lane !== 'planner')
  ) return undefined;
  return {
    executionId: event.executionId,
    lane: request.lane,
    modelStep: request.modelStep,
    requestOrdinal: request.ordinal,
  };
};

const requestKeyForThinking = (
  events: readonly StoredExecutionEvent[],
  thinkingEvent: StoredExecutionEvent,
  executionId: string,
  modelStep: number,
  eventRequestKey: RequestKey | undefined,
): RequestKey => {
  const precedingRequest = events.filter((event) =>
    event.kind === 'provider_request_start' &&
    (event.workerSequence !== undefined &&
        thinkingEvent.workerSequence !== undefined
      ? event.workerSequence < thinkingEvent.workerSequence
      : event.ordinal < thinkingEvent.ordinal)
  ).map((event) => ({ event, key: requestKeyFromStartEvent(event) })).filter((
    item,
  ) => item.key?.modelStep === modelStep).sort((left, right) =>
    (left.event.workerSequence ?? left.event.ordinal) -
    (right.event.workerSequence ?? right.event.ordinal)
  ).at(-1)?.key;
  if (eventRequestKey === undefined) {
    return precedingRequest ?? { executionId, modelStep };
  }
  if (precedingRequest === undefined) return eventRequestKey;
  return {
    ...eventRequestKey,
    ...(eventRequestKey.lane === undefined ? { lane: precedingRequest.lane } : {}),
    ...(eventRequestKey.requestOrdinal === undefined
      ? { requestOrdinal: precedingRequest.requestOrdinal }
      : {}),
  };
};

const callIdOf = (event: RuntimeToolEvent): string =>
  event.kind === 'tool_call'
    ? event.call.callId
    : event.kind === 'tool_result'
    ? event.result.callId
    : event.callId;

const sessionMessages = (
  sessionId: string,
  restored: NonNullable<ApplicationSessionState['restored']>,
  history: readonly StoredSessionHistoryExecution[],
  calls: ReadonlyMap<string, readonly string[]>,
  results: ReadonlyMap<string, readonly string[]>,
): readonly ApiMessage[] => {
  const messages: ApiMessage[] = [];
  const callUse = new Map<string, number>();
  const resultUse = new Map<string, number>();
  const canonical = new Map(
    history.filter(({ execution }) =>
      execution.adoption === 'canonical' &&
      execution.parentExecutionId === undefined
    ).map((item) => [item.execution.turn, item] as const),
  );
  const ordinalsByTurn = new Map<number, number>();
  restored.messages.forEach((message, index) => {
    const turn = restored.messageTurns?.[index] ?? 0;
    const execution = canonical.get(turn)?.execution;
    const executionId = execution?.executionId ?? sessionId;
    const ordinal = ordinalsByTurn.get(turn) ?? 0;
    ordinalsByTurn.set(turn, ordinal + 1);
    const assistantCalls = message.role === 'assistant' &&
      Array.isArray(message.content);
    let text: string | undefined;
    if (message.role === 'user') text = message.content.text;
    else if (message.role === 'assistant') {
      text = 'text' in message.content ? message.content.text : message.text;
    }
    let rawCallIds: readonly string[] = [];
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      rawCallIds = message.content.map((call) => call.callId);
    } else if (message.role === 'tool') {
      rawCallIds = message.content.map((result) => result.callId);
    }
    const toolOccurrenceIds = rawCallIds.flatMap((rawCallId) => {
      const key = `${executionId}:${rawCallId}`;
      const source = assistantCalls ? calls : results;
      const used = assistantCalls ? callUse : resultUse;
      const candidate = (source.get(key) ?? [])[used.get(key) ?? 0];
      if (candidate === undefined) return [];
      used.set(key, (used.get(key) ?? 0) + 1);
      return [candidate];
    });
    messages.push({
      id: `${executionId}:message:${ordinal}`,
      executionId,
      turn,
      role: message.role,
      ...(text === undefined ? {} : { text }),
      ...(toolOccurrenceIds.length === 0 ? {} : { toolOccurrenceIds }),
    });
  });
  return messages;
};

const latestRootExecution = (
  executions: readonly StoredExecutionRow[],
): StoredExecutionRow | undefined =>
  [...executions].filter((execution) => execution.parentExecutionId === undefined).sort(
    (left, right) => left.turn - right.turn || left.createdAt.localeCompare(right.createdAt),
  ).at(-1);

/** Display history includes every attempt; model context is owned by the canonical transcript. */
const visibleExecutionIds = (
  executions: readonly StoredExecutionRow[],
): ReadonlySet<string> => new Set(executions.map((execution) => execution.executionId));

const transcriptMessages = (
  messages: readonly Message[],
  sessionId: string,
  messageTurns?: readonly number[],
  executions: readonly StoredExecutionRow[] = [],
  calls: ReadonlyMap<string, readonly string[]> = new Map(),
  results: ReadonlyMap<string, readonly string[]> = new Map(),
): readonly ApiMessage[] => {
  const executionByTurn = new Map(
    executions.map((execution) => [execution.turn, execution]),
  );
  const callUse = new Map<string, number>();
  const resultUse = new Map<string, number>();
  const ordinalsByTurn = new Map<number, number>();
  const indexed = indexSessionHistoryPrefix(messages);
  return messages.map((message, index) => {
    const turn = messageTurns?.[index] ??
      indexed?.turns.find((range) => index >= range.start && index < range.end)
        ?.turn ??
      0;
    const executionId = executionByTurn.get(turn)?.executionId ?? sessionId;
    const ordinal = ordinalsByTurn.get(turn) ?? 0;
    ordinalsByTurn.set(turn, ordinal + 1);
    let text: string | undefined;
    if (message.role === 'user') text = message.content.text;
    else if (message.role === 'assistant') {
      text = 'text' in message.content ? message.content.text : message.text;
    }
    let rawCallIds: readonly string[] = [];
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      rawCallIds = message.content.map((call) => call.callId);
    } else if (message.role === 'tool') {
      rawCallIds = message.content.map((result) => result.callId);
    }
    const toolOccurrenceIds = rawCallIds.flatMap((rawCallId) => {
      const key = `${executionId}:${rawCallId}`;
      const source = message.role === 'tool' ? results : calls;
      const used = message.role === 'tool' ? resultUse : callUse;
      const candidate = (source.get(key) ?? [])[used.get(key) ?? 0];
      if (candidate === undefined) return [];
      used.set(key, (used.get(key) ?? 0) + 1);
      return [candidate];
    });
    return {
      id: `${executionId}:message:${ordinal}`,
      executionId,
      turn,
      role: message.role,
      ...(text === undefined ? {} : { text }),
      ...(toolOccurrenceIds.length === 0 ? {} : { toolOccurrenceIds }),
    };
  });
};

const buildToolOccurrences = (
  query: ApplicationQueryPort,
  executions: readonly StoredExecutionRow[],
  visible: ReadonlySet<string>,
): {
  readonly tools: readonly ApiToolOccurrence[];
  readonly idsByExecutionAndCall: ReadonlyMap<string, readonly string[]>;
  readonly resultsByExecutionAndCall: ReadonlyMap<string, readonly string[]>;
} => {
  const tools = new Map<string, ApiToolOccurrence>();
  const callIds = new Map<string, string[]>();
  const resultIds = new Map<string, string[]>();
  for (
    const execution of executions.filter((item) =>
      item.adoption === 'canonical' || visible.has(item.executionId)
    )
  ) {
    const occurrences = query.semanticOccurrences(execution.executionId);
    const opened = new Map<string, string[]>();
    const openedByRawId = new Map<string, string[]>();
    for (const occurrence of occurrences) {
      const source = eventFromOccurrence(occurrence);
      if (source === undefined) continue;
      const runtimeEvent = source.runtimeEvent;
      if (
        runtimeEvent.kind !== 'tool_call' &&
        runtimeEvent.kind !== 'tool_progress' &&
        runtimeEvent.kind !== 'tool_result'
      ) continue;
      const runtimeToolEvent = runtimeEvent as RuntimeToolEvent;
      const request = requestKey(execution.executionId, runtimeEvent);
      const requestId = request === undefined ? '' : requestKeyIdentity(request);
      const rawCallId = callIdOf(runtimeToolEvent);
      const association = `${execution.executionId}:${requestId}:${rawCallId}`;
      if (runtimeToolEvent.kind === 'tool_call') {
        tools.set(occurrence.occurrenceId, {
          toolOccurrenceId: occurrence.occurrenceId,
          executionId: execution.executionId,
          turn: execution.turn,
          ...(request === undefined ? {} : { requestKey: request }),
          name: runtimeToolEvent.call.name,
          arguments: runtimeToolEvent.call.arguments,
        });
        const requestCalls = opened.get(association) ?? [];
        requestCalls.push(occurrence.occurrenceId);
        opened.set(association, requestCalls);
        const rawCalls = openedByRawId.get(`${execution.executionId}:${rawCallId}`) ?? [];
        rawCalls.push(occurrence.occurrenceId);
        openedByRawId.set(`${execution.executionId}:${rawCallId}`, rawCalls);
        const callRefs = callIds.get(`${execution.executionId}:${rawCallId}`) ??
          [];
        callRefs.push(occurrence.occurrenceId);
        callIds.set(`${execution.executionId}:${rawCallId}`, callRefs);
      } else {
        const requestCalls = opened.get(association) ??
          openedByRawId.get(`${execution.executionId}:${rawCallId}`) ?? [];
        const toolOccurrenceId = requestCalls.at(-1);
        if (toolOccurrenceId === undefined) continue;
        const current = tools.get(toolOccurrenceId);
        if (current === undefined) continue;
        if (runtimeToolEvent.kind === 'tool_progress') {
          tools.set(toolOccurrenceId, {
            ...current,
            progress: runtimeToolEvent.text,
          });
        } else {
          tools.set(toolOccurrenceId, {
            ...current,
            result: {
              text: runtimeToolEvent.result.text,
              outcome: runtimeToolEvent.result.outcome,
              ...(!('terminal' in runtimeToolEvent.result) ? {} : {
                terminal: runtimeToolEvent.result.terminal,
              }),
            },
          });
          requestCalls.pop();
          const rawCalls = openedByRawId.get(`${execution.executionId}:${rawCallId}`) ?? [];
          const rawIndex = rawCalls.lastIndexOf(toolOccurrenceId);
          if (rawIndex >= 0) rawCalls.splice(rawIndex, 1);
          openedByRawId.set(`${execution.executionId}:${rawCallId}`, rawCalls);
          const resultRefs = resultIds.get(`${execution.executionId}:${rawCallId}`) ?? [];
          resultRefs.push(toolOccurrenceId);
          resultIds.set(`${execution.executionId}:${rawCallId}`, resultRefs);
        }
        opened.set(association, requestCalls);
      }
    }
  }
  return {
    tools: [...tools.values()],
    idsByExecutionAndCall: callIds,
    resultsByExecutionAndCall: resultIds,
  };
};

const thinkingFromHistory = (
  history: readonly StoredSessionHistoryExecution[],
): readonly ApiThinking[] =>
  history.filter(({ execution }) =>
    execution.adoption === 'canonical' &&
    execution.parentExecutionId === undefined
  ).flatMap(({ execution, thinking }) =>
    thinking.map((item) => ({
      requestKey: {
        executionId: execution.executionId,
        modelStep: item.modelStep,
      },
      turn: item.turn,
      thinkingKind: item.thinkingKind,
      text: item.text,
      complete: item.complete,
    }))
  );

const requestTextsFromHistory = (
  query: ApplicationQueryPort,
  executions: readonly StoredExecutionRow[],
  visibleExecutions: ReadonlySet<string>,
): readonly ApiRequestText[] => {
  const texts = new Map<string, ApiRequestText>();
  const completedRequests = new Set<string>();
  for (const execution of executions) {
    if (!visibleExecutions.has(execution.executionId)) continue;
    for (const occurrence of query.semanticOccurrences(execution.executionId)) {
      const event = eventFromOccurrence(occurrence)?.runtimeEvent;
      if (
        event?.kind !== 'assistant_progress' && event?.kind !== 'model_result'
      ) {
        continue;
      }
      const key = requestKey(execution.executionId, event);
      if (key === undefined) continue;
      const identity = requestKeyIdentity(key);
      if (event.kind === 'model_result') {
        completedRequests.add(identity);
      } else {
        texts.set(identity, {
          requestKey: key,
          turn: execution.turn,
          text: event.text,
        });
      }
    }
    for (const state of query.assistantTextStates(execution.executionId)) {
      const event = runtimeEventFromStoredEvent(state.event);
      if (event?.kind !== 'assistant_progress') continue;
      const key: RequestKey = {
        executionId: execution.executionId,
        ...(state.key.lane === undefined ? {} : { lane: state.key.lane }),
        modelStep: state.key.modelStep,
        ...(state.key.requestOrdinal === undefined ? {} : {
          requestOrdinal: state.key.requestOrdinal,
        }),
      };
      texts.set(requestKeyIdentity(key), {
        requestKey: key,
        turn: execution.turn,
        text: event.text,
      });
    }
  }
  return [...texts.entries()].flatMap(([identity, text]) =>
    completedRequests.has(identity) ? [] : [text]
  );
};

const executionMessages = (
  query: ApplicationQueryPort,
  executions: readonly StoredExecutionRow[],
  messages: readonly ApiMessage[],
  requests: readonly ApiRequestText[],
  tools: readonly ApiToolOccurrence[],
  visibleExecutions: ReadonlySet<string>,
): readonly ApiMessage[] => {
  const additions: ApiMessage[] = [];
  const requestOrder = new Map<string, number>();
  const messageOrder = new Map<string, number>();
  for (const execution of executions) {
    if (!visibleExecutions.has(execution.executionId)) continue;
    for (const event of query.executionEvents(execution.executionId)) {
      const key = requestKeyFromStartEvent(event);
      if (key !== undefined) requestOrder.set(requestKeyIdentity(key), event.ordinal);
    }
    if (
      execution.parentExecutionId === undefined
    ) {
      const id = `${execution.executionId}:message:0`;
      if (!messages.some((message) => message.id === id)) {
        additions.push({
          id,
          executionId: execution.executionId,
          turn: execution.turn,
          role: 'user',
          text: execution.task,
        });
      }
    }
    for (const occurrence of query.semanticOccurrences(execution.executionId)) {
      const source = eventFromOccurrence(occurrence);
      const event = source?.runtimeEvent;
      if (event?.kind === 'model_result' && typeof event.result.text === 'string') {
        const key = requestKey(execution.executionId, event)!;
        const id = `${requestKeyIdentity(key)}:assistant`;
        if (!messages.some((message) => message.id === id)) {
          additions.push({
            id,
            executionId: execution.executionId,
            turn: execution.turn,
            role: 'assistant',
            text: event.result.text,
            requestKey: key,
          });
        }
        continue;
      }
      const stored = storedExecutionEventFromOccurrence(occurrence);
      if (stored === undefined) continue;
      const agentEvent = agentEventFromStoredEvent(stored);
      if (
        agentEvent?.kind !== 'steering_message' ||
        typeof agentEvent.message.content.text !== 'string'
      ) continue;
      const id = occurrence.occurrenceId;
      if (messages.some((message) => message.id === id)) continue;
      additions.push({
        id,
        executionId: execution.executionId,
        turn: agentEvent.turn,
        role: 'user',
        text: agentEvent.message.content.text,
      });
      const storedOrdinal = stored.ordinal;
      if (typeof storedOrdinal === 'number') messageOrder.set(id, storedOrdinal);
    }
  }
  for (const request of requests) {
    const id = `${requestKeyIdentity(request.requestKey)}:assistant`;
    if (messages.some((message) => message.id === id)) continue;
    additions.push({
      id,
      executionId: request.requestKey.executionId,
      turn: request.turn,
      role: 'assistant',
      text: request.text,
      requestKey: request.requestKey,
    });
  }
  const projected = [...messages, ...additions];
  for (const tool of tools) {
    if (!visibleExecutions.has(tool.executionId)) continue;
    const assistantAlreadyReferencesTool = projected.some((message) =>
      message.role === 'assistant' &&
      message.toolOccurrenceIds?.includes(tool.toolOccurrenceId)
    );
    const assistantIndex = tool.requestKey === undefined
      ? -1
      : projected.findIndex((message) =>
        message.role === 'assistant' && message.requestKey !== undefined &&
        requestKeyIdentity(message.requestKey) ===
          requestKeyIdentity(tool.requestKey!)
      );
    if (!assistantAlreadyReferencesTool && assistantIndex >= 0) {
      const message = projected[assistantIndex];
      const ids = message.toolOccurrenceIds ?? [];
      if (!ids.includes(tool.toolOccurrenceId)) {
        projected[assistantIndex] = {
          ...message,
          toolOccurrenceIds: [...ids, tool.toolOccurrenceId],
        };
      }
    } else if (!assistantAlreadyReferencesTool) {
      const id = `${tool.toolOccurrenceId}:call`;
      if (!projected.some((message) => message.id === id)) {
        projected.push({
          id,
          executionId: tool.executionId,
          turn: tool.turn,
          role: 'assistant',
          ...(tool.requestKey === undefined ? {} : { requestKey: tool.requestKey }),
          toolOccurrenceIds: [tool.toolOccurrenceId],
        });
      }
    }
    if (tool.result !== undefined) {
      const id = `${tool.toolOccurrenceId}:result`;
      const toolAlreadyReferencesResult = projected.some((message) =>
        message.role === 'tool' &&
        message.toolOccurrenceIds?.includes(tool.toolOccurrenceId)
      );
      if (
        !toolAlreadyReferencesResult &&
        !projected.some((message) => message.id === id)
      ) {
        projected.push({
          id,
          executionId: tool.executionId,
          turn: tool.turn,
          role: 'tool',
          ...(tool.requestKey === undefined ? {} : { requestKey: tool.requestKey }),
          toolOccurrenceIds: [tool.toolOccurrenceId],
        });
      }
    }
  }
  const executionOrder = new Map(
    executions.map((execution, index) => [execution.executionId, index]),
  );
  const requestOrdinal = (message: ApiMessage): number => {
    const semanticOrdinal = messageOrder.get(message.id);
    if (semanticOrdinal !== undefined) return semanticOrdinal;
    if (message.role === 'user') return -1;
    const key = message.requestKey;
    return key === undefined
      ? Infinity
      : requestOrder.get(requestKeyIdentity(key)) ?? key.modelStep;
  };
  const current = projected.sort((left, right) =>
    ((executionOrder.get(left.executionId) ?? -1) -
      (executionOrder.get(right.executionId) ?? -1)) ||
    (requestOrdinal(left) - requestOrdinal(right)) ||
    (Number(left.role === 'tool') - Number(right.role === 'tool'))
  );
  return current;
};

const thinkingForVisibleExecutions = (
  query: ApplicationQueryPort,
  executions: readonly StoredExecutionRow[],
  visibleExecutions: ReadonlySet<string>,
): readonly ApiThinking[] => {
  const thinking: ApiThinking[] = [];
  for (const execution of executions) {
    if (!visibleExecutions.has(execution.executionId)) continue;
    const events = query.executionEvents(execution.executionId);
    for (const event of events) {
      const payload = event.payload as unknown as {
        readonly kind?: unknown;
        readonly event?: {
          readonly kind?: unknown;
          readonly event?: {
            readonly kind?: unknown;
            readonly turn?: unknown;
            readonly modelStep?: unknown;
            readonly thinkingKind?: unknown;
            readonly text?: unknown;
            readonly complete?: unknown;
            readonly requestKey?: RequestKey;
            readonly beforeMessageIndex?: unknown;
          };
        };
      };
      const item = payload.kind === 'runtime_event' &&
          payload.event?.kind === 'agent_event'
        ? payload.event.event
        : undefined;
      if (
        item?.kind !== 'assistant_thinking' || typeof item.turn !== 'number' ||
        typeof item.modelStep !== 'number' ||
        (item.thinkingKind !== 'text' && item.thinkingKind !== 'summary') ||
        typeof item.text !== 'string' || typeof item.complete !== 'boolean'
      ) continue;
      thinking.push({
        requestKey: requestKeyForThinking(
          events,
          event,
          execution.executionId,
          item.modelStep,
          item.requestKey,
        ),
        turn: item.turn,
        thinkingKind: item.thinkingKind,
        text: item.text,
        complete: item.complete,
      });
    }
  }
  const byIdentity = new Map<string, ApiThinking>();
  for (const item of thinking) {
    byIdentity.set(
      `${requestKeyIdentity(item.requestKey)}:${item.thinkingKind}`,
      item,
    );
  }
  return [...byIdentity.values()];
};

export const projectExecutionView = (
  execution: StoredExecutionRow | undefined,
  runtime: ApplicationSessionState['runtime'],
  state: ApiExecutionProjectionState | undefined,
  events: readonly StoredExecutionEvent[],
): ExecutionView | null => {
  if (execution === undefined) return null;
  let processSettlement = state?.processSettlement;
  if (processSettlement === undefined) processSettlement = 'unknown';
  else if (
    processSettlement === 'running' && runtime.active &&
    runtime.phase === 'settling'
  ) {
    processSettlement = 'settling';
  }
  const requestCount = events.filter((event) => event.kind === 'provider_request_start').length;
  return {
    executionId: execution.executionId,
    sessionId: execution.sessionCorrelation,
    task: execution.task,
    turn: execution.turn,
    createdAt: execution.createdAt,
    ...(state?.submittedByCommandId === undefined ? {} : {
      submittedByCommandId: state.submittedByCommandId,
    }),
    lifecycle: execution.lifecycle,
    outcome: execution.outcome,
    ...(execution.outcomeJson === undefined ? {} : {
      stopReason: execution.outcomeJson.stopReason,
    }),
    ...(execution.outcomeJson?.diagnostic === undefined ? {} : {
      diagnostic: {
        code: execution.outcomeJson.diagnostic.code,
        stage: execution.outcomeJson.diagnostic.stage,
      },
    }),
    adoption: execution.adoption,
    ...(execution.committedRevision === undefined ? {} : {
      committedRevision: execution.committedRevision,
    }),
    processSettlement,
    requestCount,
    durability: {
      acknowledgement: execution.acknowledgement,
      generationAvailability: execution.generationAvailability,
      diagnosticCapture: execution.diagnosticCapture,
      artifactCapture: execution.artifactCapture,
      contextCapture: execution.contextCapture,
    },
    ...(execution.diagnosticId === undefined ? {} : { diagnosticId: execution.diagnosticId }),
  };
};

const startupView = (
  current: ApplicationSessionState,
): SessionSnapshot['session']['startup'] => {
  const worker = current.workerStartup;
  if (worker === undefined) {
    return { ...structuredClone(current.startup), status: 'unevaluated' };
  }
  const source = worker.instructionSource ?? 'none';
  return {
    ...structuredClone(current.startup),
    status: 'evaluated',
    instructions: { loaded: source !== 'none', source },
    skills: {
      count: worker.skillNames.length,
      names: [...worker.skillNames],
      omitted: 0,
    },
  };
};

const selection = (value: ApplicationSessionState): ApiSelection => ({
  provider: value.selection.provider,
  modelId: value.selection.modelId,
  effort: value.selection.effort,
});

const latestRequestContext = (
  query: ApplicationQueryPort,
  sessionId: string,
  executions: readonly StoredExecutionRow[],
): ContextView['latestRequest'] => {
  if (query.executionContext === undefined) return undefined;
  const candidates = executions.filter((execution) => execution.sessionCorrelation === sessionId)
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.executionId.localeCompare(left.executionId)
    );
  for (const execution of candidates) {
    const requests = query.executionContext(execution.executionId).requests;
    const latest = requests.reduce<typeof requests[number] | undefined>(
      (current, request) =>
        current === undefined ||
          request.requestOrdinal > current.requestOrdinal
          ? request
          : current,
      undefined,
    );
    if (latest === undefined) continue;
    return {
      executionId: execution.executionId,
      requestOrdinal: latest.requestOrdinal,
      lane: latest.lane,
      purpose: latest.purpose,
      modelStep: latest.modelStep,
      itemCount: latest.items.length,
    };
  }
  return undefined;
};

export const projectApplicationSession = (
  query: ApplicationQueryPort,
  cursor: ApiProjectionCursor,
  executionStates: ReadonlyMap<string, ApiExecutionProjectionState> = new Map(),
): SessionSnapshot => {
  const current = query.currentSession();
  const history = query.sessionHistory();
  const restored = current.restored;
  const executions = [...query.executions()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
  const visible = visibleExecutionIds(executions);
  const toolProjection = buildToolOccurrences(query, executions, visible);
  const canonicalMessages = restored === undefined
    ? transcriptMessages(
      current.transcript,
      current.sessionId,
      undefined,
      executions,
      toolProjection.idsByExecutionAndCall,
      toolProjection.resultsByExecutionAndCall,
    )
    : history.length === 0
    ? transcriptMessages(
      restored.messages,
      current.sessionId,
      restored.messageTurns,
    )
    : sessionMessages(
      current.sessionId,
      restored,
      history,
      toolProjection.idsByExecutionAndCall,
      toolProjection.resultsByExecutionAndCall,
    );
  const restoredThinking = restored?.thinking === undefined
    ? thinkingFromHistory(history)
    : restored.thinking.map((item) => {
      const executionId = history.find((entry) =>
        entry.execution.turn === item.turn &&
        entry.execution.adoption === 'canonical' &&
        entry.execution.parentExecutionId === undefined
      )?.execution
        .executionId ?? current.sessionId;
      return {
        requestKey: { executionId, modelStep: item.modelStep },
        turn: item.turn,
        thinkingKind: item.thinkingKind,
        text: item.text,
        complete: item.complete,
        beforeMessageIndex: item.beforeMessageIndex,
      };
    });
  const requests = requestTextsFromHistory(query, executions, visible);
  const tools = toolProjection.tools;
  const currentThinking = thinkingForVisibleExecutions(
    query,
    executions,
    visible,
  );
  const messages = executionMessages(
    query,
    executions,
    canonicalMessages.filter((message) => !visible.has(message.executionId)),
    requests,
    tools,
    visible,
  );
  const thinking = [
    ...restoredThinking.filter((item) => !visible.has(item.requestKey.executionId)),
    ...currentThinking.map((item) => {
      const messageIndex = messages.findIndex((message) =>
        message.role === 'assistant' && message.requestKey !== undefined &&
        requestKeyIdentity(message.requestKey) ===
          requestKeyIdentity(item.requestKey)
      );
      const assistantMessageIndices = item.requestKey.lane === 'planner'
        ? []
        : messages.flatMap((message, index) =>
          message.role === 'assistant' &&
            message.executionId === item.requestKey.executionId &&
            message.turn === item.turn
            ? [index]
            : []
        );
      const stepMessageIndex = assistantMessageIndices[item.requestKey.modelStep - 1];
      return {
        ...item,
        beforeMessageIndex: messageIndex >= 0 ? messageIndex : stepMessageIndex ?? (() => {
          // A stopped request can have thinking without any assistant message. Its boundary
          // belongs to that attempt, even when later attempts have already been appended.
          const last = messages.findLastIndex((message) =>
            message.executionId === item.requestKey.executionId
          );
          if (last >= 0) return last + 1;
          const order = executions.findIndex((execution) =>
            execution.executionId === item.requestKey.executionId
          );
          const next = messages.findIndex((message) =>
            executions.findIndex((execution) => execution.executionId === message.executionId) >
              order
          );
          return next < 0 ? messages.length : next;
        })(),
      };
    }),
  ];
  const positionCheckpoint: ApiCheckpoint | undefined = current.position.checkpoint === undefined
    ? undefined
    : {
      ...(current.checkpoint === undefined ? {} : { summary: current.checkpoint.summary }),
      coveredThroughTurn: current.position.checkpoint.coveredThroughTurn,
      retainedFromTurn: current.position.checkpoint.retainedFromTurn,
    };
  const latestRequest = latestRequestContext(query, current.sessionId, executions);
  return {
    schemaVersion: 1,
    cursor: {
      coreEpoch: cursor.coreEpoch,
      sessionId: current.sessionId,
      revision: cursor.revision,
    },
    session: {
      id: current.sessionId,
      canonicalSessionId: current.persistence === 'none' ? null : current.sessionId,
      persistence: current.persistence === 'none' ? 'none' : 'persistent',
      position: {
        sessionId: current.sessionId,
        createdAt: current.position.createdAt,
        ...(current.position.title === undefined ? {} : { title: current.position.title }),
        agent: current.position.agent,
        committedTurn: current.position.committedTurn,
        messageCount: current.position.messageCount,
        ...(positionCheckpoint === undefined ? {} : { checkpoint: positionCheckpoint }),
      },
      selection: selection(current),
      startup: startupView(current),
    },
    runtime: {
      active: current.runtime.active,
      activeSessionId: current.sessionId,
      phase: current.runtime.phase,
      execution: projectExecutionView(
        latestRootExecution(executions),
        current.runtime,
        latestRootExecution(executions) === undefined
          ? undefined
          : executionStates.get(latestRootExecution(executions)!.executionId),
        latestRootExecution(executions) === undefined
          ? []
          : query.executionEvents(latestRootExecution(executions)!.executionId),
      ),
      operations: CORE_OPERATION_NAMES,
      ...(current.effectiveConfig === undefined ? {} : {
        effectiveConfig: structuredClone(current.effectiveConfig),
      }),
    },
    conversation: {
      executions: executions.filter((execution) => execution.parentExecutionId === undefined)
        .map((execution) =>
          projectExecutionView(
            execution,
            current.runtime,
            executionStates.get(execution.executionId),
            query.executionEvents(execution.executionId),
          )!
        ),
      messages,
      tools,
      thinking,
      requests,
      omitted: restored?.omitted ?? 0,
    },
    pending: current.pending ?? { kind: 'core-owned', followUps: [] } satisfies PendingView,
    credentialAvailability: {
      status: current.credentialAvailability?.status ?? 'unknown',
    },
    context: {
      ...(positionCheckpoint === undefined ? {} : { checkpoint: positionCheckpoint }),
      ...(current.pendingRecall === undefined ? {} : {
        pendingRecall: structuredClone(current.pendingRecall),
      }),
      ...(latestRequest === undefined ? {} : { latestRequest }),
    },
  };
};
