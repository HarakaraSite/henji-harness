import type { AgentEvent } from '../agent/core/events.ts';
import type {
  HistoryAppendResult,
  HistoryCommitDelta,
  StoredExecutionEvent,
  StoredExecutionRow,
  StoredSessionConversationExecution,
} from '../agent/history/history_store_contract.ts';
import type { HistoryV7SemanticOccurrence } from '../agent/history/history_v7_model.ts';
import type { ProviderEvidenceRuntimeEvent } from '../agent/provider/provider_evidence.ts';
import {
  applyObservation,
  conversationJson,
  type ConversationNormalizer,
  createConversationNormalizer,
} from './normalizer.ts';
import {
  type ConversationChange,
  type ConversationExecutionMetadata,
  type ConversationObservation,
  type ConversationRequestReference,
  type ConversationState,
  createConversationState,
} from './model.ts';

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringField = (value: unknown, name: string): string | undefined => {
  const field = object(value)?.[name];
  return typeof field === 'string' ? field : undefined;
};

const executionMetadata = (row: StoredExecutionRow): ConversationExecutionMetadata => ({
  executionId: row.executionId,
  taskId: row.taskId,
  task: row.task,
  sessionId: row.sessionCorrelation,
  ...(row.canonicalSessionId === undefined ? {} : { canonicalSessionId: row.canonicalSessionId }),
  ...(row.parentExecutionId === undefined ? {} : { parentExecutionId: row.parentExecutionId }),
  ...(row.spawnCallId === undefined ? {} : { spawnCallId: row.spawnCallId }),
  turn: row.turn,
  createdAt: row.createdAt,
  ...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
  lifecycle: row.lifecycle,
  outcome: row.outcome,
  ...(row.outcomeJson?.stopReason === undefined ? {} : { stopReason: row.outcomeJson.stopReason }),
  ...(row.outcomeJson?.diagnostic === undefined ? {} : {
    diagnostic: {
      code: row.outcomeJson.diagnostic.code,
      stage: row.outcomeJson.diagnostic.stage,
    },
  }),
  adoption: row.adoption,
  baseRevision: row.baseRevision,
  ...(row.committedRevision === undefined ? {} : { committedRevision: row.committedRevision }),
  agent: row.agent,
  model: conversationJson(row.model),
});

const requestReference = (
  value: unknown,
): ConversationRequestReference | undefined => {
  const record = object(value);
  if (record === undefined || typeof record.modelStep !== 'number') return undefined;
  return {
    ...(record.lane === 'parent' || record.lane === 'planner' ? { lane: record.lane } : {}),
    modelStep: record.modelStep,
    ...(typeof record.requestOrdinal !== 'number' ? {} : { requestOrdinal: record.requestOrdinal }),
  };
};

const payloadObject = (event: StoredExecutionEvent): Record<string, unknown> =>
  object(event.payload) ?? {};

const nestedProviderEvent = (event: StoredExecutionEvent):
  | Readonly<{
    readonly event: ProviderEvidenceRuntimeEvent;
    readonly turn: number;
  }>
  | undefined => {
  const payload = payloadObject(event);
  if (payload.kind !== 'provider_observation') return undefined;
  const observation = object(payload.observation);
  if (observation?.kind !== 'runtime_event') return undefined;
  const providerEvent = object(observation.event);
  if (providerEvent === undefined || typeof providerEvent.kind !== 'string') return undefined;
  return {
    event: providerEvent as unknown as ProviderEvidenceRuntimeEvent,
    turn: typeof payload.turn === 'number' ? payload.turn : 0,
  };
};

const agentEvent = (event: StoredExecutionEvent): AgentEvent | undefined => {
  if (event.kind !== 'runtime_event') return undefined;
  const payload = payloadObject(event);
  const workerEvent = object(payload.event);
  if (workerEvent?.kind !== 'agent_event') return undefined;
  const nested = workerEvent.event;
  const item = object(nested);
  if (item === undefined || typeof item.kind !== 'string') return undefined;
  return item as unknown as AgentEvent;
};

const requestFromRuntime = (
  event: ProviderEvidenceRuntimeEvent,
): ConversationRequestReference => ({
  ...(event.kind === 'turn_outcome' || event.lane === undefined ? {} : { lane: event.lane }),
  modelStep: event.kind === 'turn_outcome' ? 0 : event.modelStep,
  ...(event.kind === 'turn_outcome' || event.requestOrdinal === undefined ? {} : {
    requestOrdinal: event.requestOrdinal,
  }),
});

const eventObservation = (
  event: StoredExecutionEvent,
  semanticOccurrenceId?: string,
): readonly ConversationObservation[] => {
  const executionId = event.executionId;
  const payload = payloadObject(event);
  if (event.kind === 'provider_request_start') {
    const observation = object(payload.observation);
    const request = object(observation?.request);
    if (
      request === undefined || typeof request.ordinal !== 'number' ||
      typeof request.modelStep !== 'number'
    ) return [];
    const metadata = object(request.requestMetadata);
    return [{
      kind: 'request_start',
      executionId,
      turn: typeof payload.turn === 'number' ? payload.turn : 0,
      eventOrdinal: event.ordinal,
      request: {
        ...(request.lane === 'parent' || request.lane === 'planner' ? { lane: request.lane } : {}),
        modelStep: request.modelStep,
        requestOrdinal: request.ordinal,
      },
      ...(!metadata ? {} : {
        attribution: {
          ...(typeof metadata.provider === 'string' ? { provider: metadata.provider } : {}),
          ...(typeof metadata.modelId === 'string' ? { modelId: metadata.modelId } : {}),
          ...(typeof metadata.api === 'string' ? { api: metadata.api } : {}),
        },
      }),
    }];
  }

  if (
    event.kind === 'steer_requested' || event.kind === 'steer_sent' ||
    event.kind === 'steer_failed'
  ) {
    return [{
      kind: 'steering_operation',
      executionId,
      eventOrdinal: event.ordinal,
      status: event.kind === 'steer_requested'
        ? 'requested'
        : event.kind === 'steer_sent'
        ? 'sent'
        : 'failed',
      text: typeof payload.text === 'string' ? payload.text : '',
    }];
  }

  if (event.kind === 'execution_settled') {
    const outcome = stringField(payload, 'outcome');
    const adoption = stringField(payload, 'adoption');
    if (
      (outcome === 'unknown' || outcome === 'completed' || outcome === 'cancelled' ||
        outcome === 'failed' || outcome === 'interrupted') &&
      (adoption === 'canonical' || adoption === 'non_canonical')
    ) {
      return [{
        kind: 'execution_settled',
        executionId,
        eventOrdinal: event.ordinal,
        ...(semanticOccurrenceId === undefined ? {} : {
          terminalSemanticOccurrenceId: semanticOccurrenceId,
        }),
        outcome,
        adoption,
      }];
    }
    return [];
  }
  if (event.kind === 'execution_reconciled') {
    const settlement = stringField(payload, 'settlement');
    if (settlement === 'interrupted' || settlement === 'unknown') {
      return [{
        kind: 'execution_settled',
        executionId,
        eventOrdinal: event.ordinal,
        ...(semanticOccurrenceId === undefined ? {} : {
          terminalSemanticOccurrenceId: semanticOccurrenceId,
        }),
        outcome: settlement,
        adoption: 'non_canonical',
      }];
    }
    return [];
  }

  const providerEvent = nestedProviderEvent(event);
  if (providerEvent !== undefined) {
    const input = providerEvent.event;
    const base = {
      executionId,
      turn: providerEvent.turn,
      eventOrdinal: event.ordinal,
      request: requestFromRuntime(input),
    };
    switch (input.kind) {
      case 'assistant_progress':
        return [{
          ...base,
          kind: 'assistant_progress',
          text: input.text,
          ...(event.firstEventOrdinal === undefined
            ? {}
            : { firstEventOrdinal: event.firstEventOrdinal }),
          ...(semanticOccurrenceId === undefined ? {} : { semanticOccurrenceId }),
        }];
      case 'model_result':
        return [{
          ...base,
          kind: 'model_result',
          ...(event.firstEventOrdinal === undefined
            ? {}
            : { firstEventOrdinal: event.firstEventOrdinal }),
          ...(input.result.text === undefined ? {} : { text: input.result.text }),
          ...(input.result.kind !== 'tool_calls' || input.result.calls.length === 0 ? {} : {
            declaredCalls: input.result.calls.map((call) => ({
              callId: call.callId,
              name: call.name,
              arguments: conversationJson(call.arguments),
            })),
          }),
          ...(semanticOccurrenceId === undefined ? {} : { semanticOccurrenceId }),
        }];
      case 'tool_call':
        return semanticOccurrenceId === undefined ? [] : [{
          ...base,
          kind: 'tool_call',
          semanticOccurrenceId,
          ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
          callId: input.call.callId,
          name: input.call.name,
          arguments: conversationJson(input.call.arguments),
        }];
      case 'tool_progress':
        return [{
          ...base,
          kind: 'tool_progress',
          ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
          callId: input.callId,
          text: input.text,
        }];
      case 'tool_result':
        return [{
          ...base,
          kind: 'tool_result',
          ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
          result: {
            callId: input.result.callId,
            name: input.result.name,
            text: input.result.text,
            outcome: input.result.outcome,
            ...(!('terminal' in input.result) ? {} : { terminal: input.result.terminal }),
          },
        }];
      case 'turn_outcome':
        return [];
    }
  }

  const item = agentEvent(event);
  if (item?.kind === 'assistant_thinking') {
    const request = item.requestKey === undefined
      ? { modelStep: item.modelStep }
      : requestReference(item.requestKey);
    if (request === undefined) return [];
    return [{
      kind: 'thinking',
      executionId,
      turn: item.turn,
      eventOrdinal: event.ordinal,
      request,
      thinkingKind: item.thinkingKind,
      text: item.text,
      complete: item.complete,
    }];
  }
  if (
    item?.kind === 'steering_message' &&
    typeof item.message.content.text === 'string' && semanticOccurrenceId !== undefined
  ) {
    return [{
      kind: 'steering_applied',
      executionId,
      turn: item.turn,
      eventOrdinal: event.ordinal,
      semanticOccurrenceId,
      text: item.message.content.text,
    }];
  }
  return [];
};

const occurrenceEvent = (
  occurrence: HistoryV7SemanticOccurrence,
): StoredExecutionEvent | undefined => {
  const event = object(occurrence.payload)?.event;
  if (object(event) === undefined) return undefined;
  return event as StoredExecutionEvent;
};

const orderedStoredEvents = (
  facts: StoredSessionConversationExecution,
): readonly Readonly<{ event: StoredExecutionEvent; semanticOccurrenceId?: string }>[] => {
  const events: {
    event: StoredExecutionEvent;
    semanticOccurrenceId?: string;
    sourceOrdinal: number;
  }[] = facts.occurrences.flatMap((occurrence) => {
    const event = occurrenceEvent(occurrence);
    if (event === undefined) return [];
    return [{
      event,
      semanticOccurrenceId: occurrence.occurrenceId,
      sourceOrdinal: event.firstEventOrdinal ?? event.ordinal,
    }];
  });
  for (const state of facts.assistantTextStates) {
    events.push({
      event: { ...state.event, firstEventOrdinal: state.firstEventOrdinal },
      sourceOrdinal: state.firstEventOrdinal,
    });
  }
  return events.sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal ||
    left.event.ordinal - right.event.ordinal ||
    (left.semanticOccurrenceId ?? '').localeCompare(right.semanticOccurrenceId ?? '')
  );
};

export const observationsFromAppendResults = (
  results: readonly HistoryAppendResult[],
): readonly ConversationObservation[] =>
  results.flatMap(({ event, semanticOccurrenceId }) =>
    eventObservation(event, semanticOccurrenceId)
  );

export const applyHistoryAppendResults = (
  state: ConversationState,
  normalizer: ConversationNormalizer,
  results: readonly HistoryAppendResult[],
): readonly ConversationChange[] => {
  const changes: ConversationChange[] = [];
  for (const observation of observationsFromAppendResults(results)) {
    changes.push(...applyObservation(state, normalizer, observation));
  }
  return changes;
};

const observationsFromCommitDelta = (
  delta: HistoryCommitDelta,
): readonly ConversationObservation[] => {
  const events = delta.occurrences.flatMap((occurrence) => {
    const event = occurrenceEvent(occurrence);
    return event === undefined || event.kind === 'execution_settled' ||
        event.kind === 'execution_reconciled'
      ? []
      : [{ event, semanticOccurrenceId: occurrence.occurrenceId }];
  }).sort((left, right) =>
    (left.event.firstEventOrdinal ?? left.event.ordinal) -
      (right.event.firstEventOrdinal ?? right.event.ordinal) ||
    left.event.ordinal - right.event.ordinal
  );
  return [
    ...events.flatMap(({ event, semanticOccurrenceId }) =>
      eventObservation(event, semanticOccurrenceId)
    ),
    {
      kind: 'execution_settled',
      executionId: delta.executionId,
      eventOrdinal: delta.eventOrdinal,
      settledAt: delta.settledAt,
      terminalSemanticOccurrenceId: delta.terminalSemanticOccurrenceId,
      outcome: delta.outcome,
      ...(delta.stopReason === undefined ? {} : { stopReason: delta.stopReason }),
      ...(delta.diagnostic === undefined ? {} : { diagnostic: delta.diagnostic }),
      adoption: delta.adoption,
      ...(delta.committedRevision === undefined
        ? {}
        : { committedRevision: delta.committedRevision }),
    },
  ];
};

export const applyHistoryCommitDelta = (
  state: ConversationState,
  normalizer: ConversationNormalizer,
  delta: HistoryCommitDelta,
): readonly ConversationChange[] => {
  const changes: ConversationChange[] = [];
  for (const observation of observationsFromCommitDelta(delta)) {
    changes.push(...applyObservation(state, normalizer, observation));
  }
  return changes;
};

export const replaySessionConversation = (
  sessionId: string,
  executions: readonly StoredSessionConversationExecution[],
): Readonly<{ state: ConversationState; normalizer: ConversationNormalizer }> => {
  const state = createConversationState(sessionId);
  const normalizer = createConversationNormalizer();
  for (const [index, facts] of executions.entries()) {
    applyObservation(state, normalizer, {
      kind: 'execution',
      execution: executionMetadata(facts.execution),
      executionOrder: index,
    });
    for (const { event, semanticOccurrenceId } of orderedStoredEvents(facts)) {
      for (const observation of eventObservation(event, semanticOccurrenceId)) {
        applyObservation(state, normalizer, observation);
      }
    }
  }
  return { state, normalizer };
};

export const historyExecutionMetadata = executionMetadata;
