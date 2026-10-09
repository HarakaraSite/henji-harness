import type { AgentEvent } from '../agent/core/events.ts';
import type {
  HistoryAppendResult,
  HistoryCommitDelta,
  StoredExecutionEvent,
  StoredExecutionRow,
  StoredSessionConversationExecution,
} from '../agent/history/history_store_contract.ts';
import type { HistorySemanticOccurrence } from '../agent/history/history_semantic_model.ts';
import { canonicalJsonBytes } from '../agent/history/context_attribution.ts';
import type { ProviderEvidenceRuntimeEvent } from '../agent/provider/provider_evidence.ts';
import { exactByteDigest } from '../agent/history/exact_byte_plan.ts';
import {
  applyObservation,
  conversationJson,
  type ConversationNormalizer,
  createConversationNormalizer,
} from './normalizer.ts';
import {
  type ConversationChange,
  type ConversationContentReference,
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

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CONVERSATION_PREVIEW_BYTES = 2_048;

const utf8Prefix = (bytes: Uint8Array, limit: number): string => {
  let end = Math.min(bytes.byteLength, limit);
  while (
    end > 0 && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80
  ) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
};

const contentReference = (
  sessionId: string,
  executionId: string,
  field: ConversationContentReference['field'],
  version: number,
  cut: number,
  text: string,
  sourceEventOrdinal?: number,
  sourceIndex?: number,
): ConversationContentReference => {
  const bytes = encoder.encode(text);
  return {
    sessionId,
    executionId,
    field,
    digest: exactByteDigest(bytes),
    version,
    cut,
    totalBytes: bytes.byteLength,
    ...(sourceEventOrdinal === undefined ? {} : { sourceEventOrdinal }),
    ...(sourceIndex === undefined ? {} : { sourceIndex }),
  };
};

const boundedText = (
  text: string,
  details: ConversationContentReference,
  includeFullText = false,
): Readonly<
  { text: string; details?: readonly ConversationContentReference[] }
> => {
  const bytes = encoder.encode(text);
  if (includeFullText || bytes.byteLength <= CONVERSATION_PREVIEW_BYTES) return { text };
  return {
    text: `${
      utf8Prefix(bytes, CONVERSATION_PREVIEW_BYTES)
    }… [${bytes.byteLength} bytes; open detail]`,
    details: [details],
  };
};

const boundedValue = (
  value: unknown,
  budget = CONVERSATION_PREVIEW_BYTES,
): import('./model.ts').ConversationValue => {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined || encoder.encode(serialized).byteLength <= budget
  ) {
    return conversationJson(value);
  }
  if (typeof value === 'string') {
    const bytes = encoder.encode(value);
    return `${utf8Prefix(bytes, budget)}…`;
  }
  if (Array.isArray(value)) {
    const preview: import('./model.ts').ConversationValue[] = [];
    for (const item of value) {
      const candidate = [
        ...preview,
        boundedValue(item, Math.max(32, budget - 64)),
      ];
      if (encoder.encode(JSON.stringify(candidate)).byteLength > budget) break;
      preview.push(candidate.at(-1)!);
    }
    if (preview.length < value.length) {
      preview.push(`… ${value.length - preview.length} more`);
    }
    return preview;
  }
  const record = object(value);
  if (record === undefined) return null;
  const preview: Record<string, import('./model.ts').ConversationValue> = {};
  for (const [key, item] of Object.entries(record)) {
    const candidate = {
      ...preview,
      [key]: boundedValue(item, Math.max(32, budget - 96)),
    };
    if (encoder.encode(JSON.stringify(candidate)).byteLength > budget) break;
    preview[key] = candidate[key];
  }
  if (Object.keys(preview).length < Object.keys(record).length) {
    preview['…'] = `${Object.keys(record).length - Object.keys(preview).length} more fields`;
  }
  return preview;
};

const executionMetadata = (
  row: StoredExecutionRow,
  task = row.task,
): ConversationExecutionMetadata => ({
  executionId: row.executionId,
  taskId: row.taskId,
  task,
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
  if (record === undefined || typeof record.modelStep !== 'number') {
    return undefined;
  }
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
  if (providerEvent === undefined || typeof providerEvent.kind !== 'string') {
    return undefined;
  }
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
  sessionId = '',
  cut = 0,
  includeFullText = false,
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
    const text = typeof payload.text === 'string' ? payload.text : '';
    const detail = boundedText(
      text,
      contentReference(
        sessionId,
        executionId,
        'steering',
        event.ordinal,
        cut,
        text,
        event.ordinal,
      ),
      includeFullText,
    );
    return [{
      kind: 'steering_operation',
      executionId,
      eventOrdinal: event.ordinal,
      status: event.kind === 'steer_requested'
        ? 'requested'
        : event.kind === 'steer_sent'
        ? 'sent'
        : 'failed',
      text: detail.text,
      ...(detail.details === undefined ? {} : { details: detail.details }),
    }];
  }

  if (event.kind === 'execution_settled') {
    const outcome = stringField(payload, 'outcome');
    const adoption = stringField(payload, 'adoption');
    if (
      (outcome === 'unknown' || outcome === 'completed' ||
        outcome === 'cancelled' ||
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
      case 'assistant_progress': {
        const progressDetail = boundedText(
          input.text,
          contentReference(
            sessionId,
            executionId,
            'message',
            event.ordinal,
            cut,
            input.text,
            event.ordinal,
          ),
          includeFullText,
        );
        return [{
          ...base,
          kind: 'assistant_progress',
          text: progressDetail.text,
          ...(progressDetail.details === undefined ? {} : {
            details: progressDetail.details,
          }),
          ...(event.firstEventOrdinal === undefined
            ? {}
            : { firstEventOrdinal: event.firstEventOrdinal }),
          ...(semanticOccurrenceId === undefined ? {} : { semanticOccurrenceId }),
        }];
      }
      case 'model_result': {
        const resultText = input.result.text;
        const resultDetail = resultText === undefined ? undefined : boundedText(
          resultText,
          contentReference(
            sessionId,
            executionId,
            'message',
            event.ordinal,
            cut,
            resultText,
            event.ordinal,
          ),
          includeFullText,
        );
        return [{
          ...base,
          kind: 'model_result',
          ...(event.firstEventOrdinal === undefined
            ? {}
            : { firstEventOrdinal: event.firstEventOrdinal }),
          ...(resultDetail === undefined ? {} : {
            text: resultDetail.text,
            ...(resultDetail.details === undefined ? {} : { details: resultDetail.details }),
          }),
          ...(input.result.kind !== 'tool_calls' ||
              input.result.calls.length === 0
            ? {}
            : {
              declaredCalls: input.result.calls.map((call, index) => {
                const text = decoder.decode(canonicalJsonBytes(call.arguments));
                const detail = boundedText(
                  text,
                  contentReference(
                    sessionId,
                    executionId,
                    'tool_arguments',
                    event.ordinal,
                    cut,
                    text,
                    event.ordinal,
                    index,
                  ),
                  includeFullText,
                );
                return {
                  callId: call.callId,
                  name: call.name,
                  arguments: detail.details === undefined
                    ? conversationJson(call.arguments)
                    : boundedValue(call.arguments),
                  ...(detail.details === undefined ? {} : { details: detail.details }),
                };
              }),
            }),
          ...(semanticOccurrenceId === undefined ? {} : { semanticOccurrenceId }),
        }];
      }
      case 'tool_call': {
        const callJson = decoder.decode(
          canonicalJsonBytes(input.call.arguments),
        );
        const callDetail = boundedText(
          callJson,
          contentReference(
            sessionId,
            executionId,
            'tool_arguments',
            event.ordinal,
            cut,
            callJson,
            event.ordinal,
            input.callIndex ?? 0,
          ),
          includeFullText,
        );
        return semanticOccurrenceId === undefined ? [] : [{
          ...base,
          kind: 'tool_call',
          semanticOccurrenceId,
          ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
          callId: input.call.callId,
          name: input.call.name,
          arguments: callDetail.details === undefined
            ? conversationJson(input.call.arguments)
            : boundedValue(input.call.arguments),
          ...(callDetail.details === undefined ? {} : { details: callDetail.details }),
        }];
      }
      case 'tool_progress': {
        const progressText = input.text;
        const toolProgressDetail = boundedText(
          progressText,
          contentReference(
            sessionId,
            executionId,
            'tool_progress',
            event.ordinal,
            cut,
            progressText,
            event.ordinal,
          ),
          includeFullText,
        );
        return [{
          ...base,
          kind: 'tool_progress',
          ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
          callId: input.callId,
          text: toolProgressDetail.text,
          ...(toolProgressDetail.details === undefined ? {} : {
            details: toolProgressDetail.details,
          }),
        }];
      }
      case 'tool_result': {
        const toolResultDetail = boundedText(
          input.result.text,
          contentReference(
            sessionId,
            executionId,
            'tool_result',
            event.ordinal,
            cut,
            input.result.text,
            event.ordinal,
          ),
          includeFullText,
        );
        return [{
          ...base,
          kind: 'tool_result',
          ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
          result: {
            callId: input.result.callId,
            name: input.result.name,
            text: toolResultDetail.text,
            outcome: input.result.outcome,
            ...(!('terminal' in input.result) ? {} : { terminal: input.result.terminal }),
          },
          ...(toolResultDetail.details === undefined ? {} : {
            details: toolResultDetail.details,
          }),
        }];
      }
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
    const detail = boundedText(
      item.text,
      contentReference(
        sessionId,
        executionId,
        'thinking',
        event.ordinal,
        cut,
        item.text,
        event.ordinal,
      ),
      includeFullText,
    );
    return [{
      kind: 'thinking',
      executionId,
      turn: item.turn,
      eventOrdinal: event.ordinal,
      request,
      thinkingKind: item.thinkingKind,
      text: detail.text,
      complete: item.complete,
      ...(detail.details === undefined ? {} : { details: detail.details }),
    }];
  }
  if (
    item?.kind === 'steering_message' &&
    typeof item.message.content.text === 'string' &&
    semanticOccurrenceId !== undefined
  ) {
    const text = item.message.content.text;
    const detail = boundedText(
      text,
      contentReference(
        sessionId,
        executionId,
        'message',
        event.ordinal,
        cut,
        text,
        event.ordinal,
      ),
      includeFullText,
    );
    return [{
      kind: 'steering_applied',
      executionId,
      turn: item.turn,
      eventOrdinal: event.ordinal,
      semanticOccurrenceId,
      text: detail.text,
      ...(detail.details === undefined ? {} : { details: detail.details }),
    }];
  }
  return [];
};

const occurrenceEvent = (
  occurrence: HistorySemanticOccurrence,
): StoredExecutionEvent | undefined => {
  const event = object(occurrence.payload)?.event;
  if (object(event) === undefined) return undefined;
  return event as StoredExecutionEvent;
};

export const observationsFromAppendResults = (
  results: readonly HistoryAppendResult[],
  sessionId = '',
  cut = 0,
): readonly ConversationObservation[] =>
  results.flatMap(({ event, semanticOccurrenceId }) =>
    eventObservation(event, semanticOccurrenceId, sessionId, cut)
  );

export const applyHistoryAppendResults = (
  state: ConversationState,
  normalizer: ConversationNormalizer,
  results: readonly HistoryAppendResult[],
  cut = 0,
): readonly ConversationChange[] => {
  const changes: ConversationChange[] = [];
  for (
    const observation of observationsFromAppendResults(
      results,
      state.sessionId,
      cut,
    )
  ) {
    changes.push(...applyObservation(state, normalizer, observation));
  }
  return changes;
};

const observationsFromCommitDelta = (
  delta: HistoryCommitDelta,
  sessionId: string,
  cut: number,
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
      eventObservation(event, semanticOccurrenceId, sessionId, cut)
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
  cut = 0,
): readonly ConversationChange[] => {
  const changes: ConversationChange[] = [];
  for (
    const observation of observationsFromCommitDelta(
      delta,
      state.sessionId,
      cut,
    )
  ) {
    changes.push(...applyObservation(state, normalizer, observation));
  }
  return changes;
};

export const replaySessionConversation = (
  sessionId: string,
  executions: Iterable<StoredSessionConversationExecution>,
  cut = 0,
  options: Readonly<{ includeFullText?: boolean }> = {},
): Readonly<
  { state: ConversationState; normalizer: ConversationNormalizer }
> => {
  const state = createConversationState(sessionId);
  const normalizer = createConversationNormalizer();
  let fallbackExecutionOrder = 0;
  for (const facts of executions) {
    const executionOrder = facts.executionOrder ?? fallbackExecutionOrder;
    fallbackExecutionOrder = Math.max(
      fallbackExecutionOrder,
      executionOrder + 1,
    );
    const task = boundedText(
      facts.execution.task,
      contentReference(
        sessionId,
        facts.execution.executionId,
        'task',
        0,
        cut,
        facts.execution.task,
      ),
      options.includeFullText === true,
    );
    applyObservation(state, normalizer, {
      kind: 'execution',
      execution: executionMetadata(facts.execution, task.text),
      executionOrder,
      ...(task.details === undefined ? {} : {
        taskDetails: task.details,
      }),
    });
    for (const { event, semanticOccurrenceId } of facts.events) {
      for (
        const observation of eventObservation(
          event,
          semanticOccurrenceId,
          sessionId,
          cut,
          options.includeFullText === true,
        )
      ) {
        applyObservation(state, normalizer, observation);
      }
    }
  }
  return { state, normalizer };
};

export const historyExecutionMetadata = executionMetadata;
