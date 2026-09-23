import type { LoopOutcome, Message } from '../agent/core/contracts.ts';
import {
  type FailureDiagnosticV1,
  validateFailureDiagnostic,
} from '../agent/session/failure_diagnostic.ts';
import type {
  ContextRecoveryPreview,
  ContextRecoveryResult,
  NavigationListing,
  NavigationPosition,
} from '../agent/session/session_navigation.ts';
import {
  boundedPresentationText,
  type PresentationAssistantMessage,
  type PresentationContextPreview,
  type PresentationContextResult,
  PresentationDeliveryError,
  type PresentationDiagnosticDurability,
  type PresentationDiagnosticPersistenceError,
  type PresentationFailureDiagnostic,
  type PresentationJson,
  type PresentationMessage,
  type PresentationNavigationListing,
  type PresentationOutcome,
  type PresentationOutcomeReason,
  type PresentationPosition,
  type PresentationToolCall,
  type PresentationToolResult,
  type PresentationUserMessage,
} from './contract.ts';
import { MAX_CONVERSATION_TEXT_BYTES } from '../resource_limits.ts';

export const MAX_GENERATION_TEXT = MAX_CONVERSATION_TEXT_BYTES;
export const encoder = new TextEncoder();
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const bounded = (value: string): string => {
  const text = boundedPresentationText(value);
  if (encoder.encode(text).byteLength > MAX_GENERATION_TEXT) {
    throw new PresentationDeliveryError();
  }
  return text;
};

export const json = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): PresentationJson => {
  if (value === null) return null;
  if (depth > 8) throw new PresentationDeliveryError();
  switch (typeof value) {
    case 'string':
      return bounded(value);
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'object': {
      if (seen.has(value)) throw new PresentationDeliveryError();
      seen.add(value);
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (
          value.length > 256 ||
          Object.getPrototypeOf(value) !== Array.prototype ||
          Object.values(descriptors).some((descriptor) =>
            descriptor.get !== undefined || descriptor.set !== undefined
          ) || Reflect.ownKeys(value).some((key) => {
            if (key === 'length') return false;
            if (typeof key !== 'string' || !/^\d+$/u.test(key)) return true;
            const index = Number(key);
            return !Number.isSafeInteger(index) || index < 0 ||
              index >= value.length;
          }) || [...Array(Math.min(value.length, 256)).keys()].some((index) =>
            !Object.hasOwn(value, String(index))
          )
        ) {
          throw new PresentationDeliveryError();
        }
        const result = Object.freeze(
          value.slice(0, 256).map((item) =>
            json(item, depth + 1, seen)
          ),
        );
        seen.delete(value);
        return result;
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      ) {
        throw new PresentationDeliveryError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Reflect.ownKeys(descriptors).length > 256 ||
        Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
        Object.values(descriptors).some((descriptor) =>
          descriptor.get !== undefined || descriptor.set !== undefined
        )
      ) {
        throw new PresentationDeliveryError();
      }
      const result = Object.freeze(
        Object.fromEntries(
          Object.entries(value).slice(0, 256).map((
            [key, item],
          ) => [bounded(key), json(item, depth + 1, seen)]),
        ),
      ) as PresentationJson;
      seen.delete(value);
      return result;
    }
    default:
      throw new PresentationDeliveryError();
  }
};

export const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new PresentationDeliveryError();
  return bounded(value);
};
export const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PresentationDeliveryError();
  }
  return value as number;
};
export const optionalBoundedCount = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  return count(value);
};
export const fixedCount = <T extends number>(value: unknown, expected: T): T => {
  if (value !== expected) throw new PresentationDeliveryError();
  return expected;
};
export const outcomeReason = (value: unknown): PresentationOutcomeReason => {
  if (
    value !== 'final' && value !== 'tool_terminal' && value !== 'max_steps' &&
    value !== 'contract_failure' && value !== 'cancelled' && value !== 'interrupted'
  ) throw new PresentationDeliveryError();
  return value;
};
export const agentId = (value: unknown): 'default' | 'planner' => {
  if (value !== 'default' && value !== 'planner') {
    throw new PresentationDeliveryError();
  }
  return value;
};
export const contextResultKind = (
  value: unknown,
): PresentationContextResult['kind'] => {
  if (
    value !== 'installed' && value !== 'refused' && value !== 'failed' &&
    value !== 'cancelled'
  ) {
    throw new PresentationDeliveryError();
  }
  return value;
};
export const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new PresentationDeliveryError();
  return value;
};
export const diagnosticDurability = (value: unknown): PresentationDiagnosticDurability => {
  if (value !== 'yes' && value !== 'failed' && value !== 'unknown') {
    throw new PresentationDeliveryError();
  }
  return value;
};
export const diagnosticPersistenceError = (
  value: unknown,
): PresentationDiagnosticPersistenceError => {
  if (
    value !== 'diagnostic_not_found' && value !== 'diagnostic_busy' &&
    value !== 'diagnostic_invalid' && value !== 'diagnostic_capacity' &&
    value !== 'diagnostic_io_failure'
  ) throw new PresentationDeliveryError();
  return value;
};
export const providerEvidenceId = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new PresentationDeliveryError();
  return value;
};
export const providerEvidenceDurability = (value: unknown): 'yes' | 'failed' | 'unknown' => {
  if (value !== 'yes' && value !== 'failed' && value !== 'unknown') {
    throw new PresentationDeliveryError();
  }
  return value;
};
export const providerEvidencePersistenceError = (
  value: unknown,
): 'provider_evidence_not_found' | 'provider_evidence_invalid' | 'provider_evidence_io_failure' => {
  if (
    value !== 'provider_evidence_not_found' && value !== 'provider_evidence_invalid' &&
    value !== 'provider_evidence_io_failure'
  ) throw new PresentationDeliveryError();
  return value;
};

export const userMessage = (message: Message): PresentationUserMessage => {
  if (message.role !== 'user' || message.content.kind !== 'text') {
    throw new PresentationDeliveryError();
  }
  return Object.freeze({
    role: 'user',
    content: Object.freeze({ kind: 'text', text: text(message.content.text) }),
  });
};

export const callMessage = (
  call: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
  },
  callId: string,
): PresentationToolCall =>
  Object.freeze({
    kind: 'tool_call',
    callId,
    name: text(call.name),
    arguments: json(call.arguments),
  });

export const assistantMessage = (
  message: Message,
  callIds: Map<string, string>,
  nextCallId: () => string,
): PresentationAssistantMessage => {
  if (message.role !== 'assistant') throw new PresentationDeliveryError();
  if (!Array.isArray(message.content) && 'text' in message.content) {
    return Object.freeze({
      role: 'assistant',
      content: Object.freeze({
        kind: 'text',
        text: text(message.content.text),
      }),
    });
  }
  const calls = message.content.map((call) => {
    const id = callIds.get(call.callId) ?? nextCallId();
    callIds.set(call.callId, id);
    return callMessage(call, id);
  });
  return Object.freeze({
    role: 'assistant',
    content: Object.freeze(calls),
    ...(message.text === undefined ? {} : { text: text(message.text) }),
  });
};

export const result = (
  value: {
    readonly callId: string;
    readonly name: string;
    readonly text: string;
    readonly outcome: 'success' | 'error';
    readonly terminal?: 'json_result';
  },
  callId: string,
): PresentationToolResult =>
  (value.outcome !== 'success' && value.outcome !== 'error') ||
    (value.terminal !== undefined && value.terminal !== 'json_result')
    ? (() => {
      throw new PresentationDeliveryError();
    })()
    : Object.freeze({
      kind: 'tool_result',
      callId,
      name: text(value.name),
      text: text(value.text),
      outcome: value.outcome,
      ...(value.terminal === undefined ? {} : { terminal: 'json_result' as const }),
    });

export const position = (value: NavigationPosition): PresentationPosition =>
  Object.freeze({
    ...(value.sessionId === undefined ? {} : { sessionId: text(value.sessionId) }),
    createdAt: text(value.createdAt),
    ...(value.title === undefined ? {} : { title: text(value.title) }),
    agent: agentId(value.agent),
    committedTurn: count(value.committedTurn),
    messageCount: count(value.messageCount),
    ...(value.checkpoint === undefined ? {} : {
      checkpoint: Object.freeze({
        coveredThroughTurn: count(value.checkpoint.coveredThroughTurn),
        retainedFromTurn: count(value.checkpoint.retainedFromTurn),
        ...(value.checkpoint.projectedMessagesBytes === undefined ? {} : {
          projectedMessagesBytes: count(
            value.checkpoint.projectedMessagesBytes,
          ),
        }),
      }),
    }),
  });

export const listing = (value: NavigationListing): PresentationNavigationListing =>
  Object.freeze({
    sessions: Object.freeze(value.sessions.map((row) =>
      Object.freeze({
        id: text(row.id),
        agent: agentId(row.agent),
        createdAt: text(row.createdAt),
        updatedAt: text(row.updatedAt),
        ...(row.title === undefined ? {} : { title: text(row.title) }),
        turnCount: count(row.turnCount),
        messageCount: count(row.messageCount),
        current: boolean(row.current),
        resumed: boolean(row.resumed),
        mismatch: boolean(row.mismatch),
        ...(row.modelSelection === undefined ? {} : {
          modelSelection: Object.freeze({
            provider: row.modelSelection.provider,
            modelId: text(row.modelSelection.modelId),
            effort: text(row.modelSelection.effort),
          }),
        }),
      })
    )),
    skippedInvalid: count(value.skippedInvalid),
  });

export const preview = (value: ContextRecoveryPreview): PresentationContextPreview =>
  Object.freeze({
    useful: boolean(value.useful),
    currentTurn: count(value.currentTurn),
    ...(value.currentCheckpoint === undefined ? {} : {
      currentCheckpoint: Object.freeze({
        coveredThroughTurn: count(value.currentCheckpoint.coveredThroughTurn),
        retainedFromTurn: count(value.currentCheckpoint.retainedFromTurn),
      }),
    }),
    ...(value.proposed === undefined ? {} : {
      proposed: Object.freeze({
        coveredThroughTurn: count(value.proposed.coveredThroughTurn),
        retainedFromTurn: count(value.proposed.retainedFromTurn),
      }),
    }),
    ...(value.baselineMessagesBytes === undefined
      ? {}
      : { baselineMessagesBytes: count(value.baselineMessagesBytes) }),
    ...(value.projectedMessagesBytes === undefined
      ? {}
      : { projectedMessagesBytes: count(value.projectedMessagesBytes) }),
  });

export const contextResult = (
  value: ContextRecoveryResult,
): PresentationContextResult =>
  Object.freeze({
    kind: contextResultKind(value.kind),
    ...(value.coveredThroughTurn === undefined
      ? {}
      : { coveredThroughTurn: count(value.coveredThroughTurn) }),
    ...(value.retainedFromTurn === undefined
      ? {}
      : { retainedFromTurn: count(value.retainedFromTurn) }),
    reason: value.reason === undefined ? undefined : text(value.reason),
  });

export const failureDiagnostic = (
  value: FailureDiagnosticV1,
): PresentationFailureDiagnostic => {
  if (!validateFailureDiagnostic(value)) throw new PresentationDeliveryError();
  return Object.freeze({
    schemaVersion: 1,
    diagnosticId: value.diagnosticId,
    stage: value.stage,
    code: value.code,
    lane: value.lane,
    providerRequestCount: count(value.providerRequestCount),
    ...(value.httpStatus === undefined ? {} : { httpStatus: count(value.httpStatus) }),
    ...(value.parseReason === undefined ? {} : { parseReason: value.parseReason }),
    occurredAt: text(value.occurredAt),
    turnNumber: count(value.turnNumber),
    modelStep: count(value.modelStep),
    retryCount: count(value.retryCount),
  });
};

export const outcome = (value: LoopOutcome): PresentationOutcome => {
  const callIds = new Map<string, string>();
  let ordinal = 0;
  const opaque = (raw: string): string => {
    const existing = callIds.get(raw);
    if (existing !== undefined) return existing;
    const next = `call-${++ordinal}`;
    callIds.set(raw, next);
    return next;
  };
  return Object.freeze({
    ok: boolean(value.ok),
    task: text(value.task),
    outcome: outcomeReason(value.outcome),
    stopReason: outcomeReason(value.stopReason),
    finalText: value.finalText === undefined ? undefined : text(value.finalText),
    ...(value.terminalKind === undefined ? {} : { terminalKind: 'json_result' as const }),
    ...(value.diagnostic === undefined ? {} : { diagnostic: failureDiagnostic(value.diagnostic) }),
    ...(value.diagnostic === undefined || value.diagnosticDurability === undefined
      ? {}
      : { diagnosticDurability: diagnosticDurability(value.diagnosticDurability) }),
    ...(value.diagnostic === undefined || value.diagnosticPersistenceError === undefined ? {} : {
      diagnosticPersistenceError: diagnosticPersistenceError(
        value.diagnosticPersistenceError,
      ),
    }),
    ...(value.providerEvidenceId === undefined ? {} : {
      providerEvidenceId: providerEvidenceId(value.providerEvidenceId),
    }),
    ...(value.providerEvidenceId === undefined || value.providerEvidenceDurability === undefined
      ? {}
      : {
        providerEvidenceDurability: providerEvidenceDurability(value.providerEvidenceDurability),
      }),
    ...(value.providerEvidenceId === undefined ||
        value.providerEvidencePersistenceError === undefined
      ? {}
      : {
        providerEvidencePersistenceError: providerEvidencePersistenceError(
          value.providerEvidencePersistenceError,
        ),
      }),
    ...(value.turnProviderRequestCount === undefined ? {} : {
      turnProviderRequestCount: optionalBoundedCount(value.turnProviderRequestCount),
    }),
    ...(value.runtimeProviderRequestCount === undefined ? {} : {
      runtimeProviderRequestCount: optionalBoundedCount(value.runtimeProviderRequestCount),
    }),
    steps: count(value.steps),
    toolCallCount: count(value.toolCallCount),
    toolResultCount: count(value.toolResultCount),
    transcript: Object.freeze(value.transcript.map((message) => {
      if (message.role === 'user') return userMessage(message);
      if (message.role === 'assistant') {
        return assistantMessage(message, callIds, () => `call-${++ordinal}`);
      }
      return Object.freeze({
        role: 'tool' as const,
        content: Object.freeze(
          message.content.map((item) => result(item, opaque(item.callId))),
        ),
      });
    })) as readonly PresentationMessage[],
  });
};

export const restoredPresentationMessages = (
  messages: readonly Message[],
): readonly PresentationMessage[] => {
  const callIds = new Map<string, string>();
  let ordinal = 0;
  const opaque = (raw: string): string => {
    const existing = callIds.get(raw);
    if (existing !== undefined) return existing;
    const next = `call-${++ordinal}`;
    callIds.set(raw, next);
    return next;
  };
  return Object.freeze(messages.map((message) => {
    if (message.role === 'user') return userMessage(message);
    if (message.role === 'assistant') {
      return assistantMessage(message, callIds, () => `call-${++ordinal}`);
    }
    return Object.freeze({
      role: 'tool' as const,
      content: Object.freeze(
        message.content.map((item) => result(item, opaque(item.callId))),
      ),
    });
  }));
};
