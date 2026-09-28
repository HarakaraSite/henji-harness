import type {
  ApiMessage,
  ApiRequestText,
  ApiThinking,
  ApiToolOccurrence,
  RequestKey,
  SessionChange,
  SessionReadEvent,
  SessionSnapshot,
  SessionStreamFrame,
} from './contract.ts';

export type SessionClientState = Readonly<{
  snapshot: SessionSnapshot;
}>;

export const requestKeyIdentity = (key: RequestKey): string =>
  JSON.stringify([
    key.executionId,
    key.lane ?? null,
    key.modelStep,
    key.requestOrdinal ?? null,
  ]);

const upsertBy = <T>(
  values: readonly T[],
  value: T,
  identity: (item: T) => string,
  key: string,
): readonly T[] => {
  const index = values.findIndex((item) => identity(item) === key);
  if (index < 0) return [...values, value];
  return values.map((item, current) => current === index ? value : item);
};

const withoutRequest = (
  values: readonly ApiRequestText[],
  key: RequestKey,
): readonly ApiRequestText[] =>
  values.filter((item) => requestKeyIdentity(item.requestKey) !== requestKeyIdentity(key));

const messageIdentity = (message: ApiMessage): string => message.id;
const toolIdentity = (tool: ApiToolOccurrence): string => tool.toolOccurrenceId;
const thinkingIdentity = (thinking: ApiThinking): string =>
  `${requestKeyIdentity(thinking.requestKey)}:${thinking.thinkingKind}`;

export const initialSessionClientState = (snapshot: SessionSnapshot): SessionClientState =>
  Object.freeze({ snapshot });

/** Apply ordered state updates. Repeated request keys and semantic tool IDs replace in place. */
export const reduceSessionReadEvent = (
  state: SessionClientState,
  event: SessionReadEvent,
): SessionClientState => {
  if (event.kind === 'snapshot') return initialSessionClientState(event.snapshot);
  const snapshot = state.snapshot;
  const conversation = snapshot.conversation;
  switch (event.kind) {
    case 'runtime_state': {
      if (event.sessionId !== snapshot.session.id) return state;
      return Object.freeze({
        snapshot: {
          ...snapshot,
          runtime: {
            ...snapshot.runtime,
            active: event.active,
            activeSessionId: event.sessionId,
            phase: event.phase,
          },
        },
      });
    }
    case 'user_message': {
      const item: ApiMessage = {
        id: event.id,
        executionId: event.executionId,
        turn: event.turn,
        role: 'user',
        text: event.text,
      };
      return Object.freeze({
        snapshot: {
          ...snapshot,
          conversation: {
            ...conversation,
            messages: upsertBy(conversation.messages, item, messageIdentity, event.id),
          },
        },
      });
    }
    case 'assistant_text': {
      const item: ApiRequestText = {
        requestKey: event.requestKey,
        turn: event.turn,
        text: event.text,
      };
      return Object.freeze({
        snapshot: {
          ...snapshot,
          conversation: {
            ...conversation,
            requests: upsertBy(
              conversation.requests,
              item,
              (candidate) => requestKeyIdentity(candidate.requestKey),
              requestKeyIdentity(event.requestKey),
            ),
          },
        },
      });
    }
    case 'assistant_message': {
      const item: ApiMessage = {
        id: event.id,
        executionId: event.executionId,
        turn: event.turn,
        role: 'assistant',
        ...(event.text === undefined ? {} : { text: event.text }),
        requestKey: event.requestKey,
        ...(event.toolOccurrenceIds === undefined ? {} : {
          toolOccurrenceIds: [...event.toolOccurrenceIds],
        }),
      };
      return Object.freeze({
        snapshot: {
          ...snapshot,
          conversation: {
            ...conversation,
            messages: upsertBy(conversation.messages, item, messageIdentity, event.id),
            requests: withoutRequest(conversation.requests, event.requestKey),
          },
        },
      });
    }
    case 'assistant_thinking': {
      const item: ApiThinking = {
        requestKey: event.requestKey,
        turn: event.turn,
        thinkingKind: event.thinkingKind,
        text: event.text,
        complete: event.complete,
      };
      return Object.freeze({
        snapshot: {
          ...snapshot,
          conversation: {
            ...conversation,
            thinking: upsertBy(
              conversation.thinking,
              item,
              thinkingIdentity,
              `${requestKeyIdentity(event.requestKey)}:${event.thinkingKind}`,
            ),
          },
        },
      });
    }
    case 'tool_call': {
      const requestKey = event.requestKey;
      const item: ApiToolOccurrence = {
        toolOccurrenceId: event.toolOccurrenceId,
        executionId: event.executionId,
        turn: event.turn,
        ...(event.requestKey === undefined ? {} : { requestKey: event.requestKey }),
        name: event.name,
        arguments: event.arguments,
      };
      return Object.freeze({
        snapshot: {
          ...snapshot,
          conversation: {
            ...conversation,
            tools: upsertBy(
              conversation.tools,
              item,
              toolIdentity,
              event.toolOccurrenceId,
            ),
            messages: requestKey === undefined
              ? conversation.messages
              : conversation.messages.map((message) => {
                if (
                  message.role !== 'assistant' || message.requestKey === undefined ||
                  requestKeyIdentity(message.requestKey) !== requestKeyIdentity(requestKey)
                ) return message;
                const toolOccurrenceIds = message.toolOccurrenceIds ?? [];
                return toolOccurrenceIds.includes(event.toolOccurrenceId) ? message : {
                  ...message,
                  toolOccurrenceIds: [...toolOccurrenceIds, event.toolOccurrenceId],
                };
              }),
          },
        },
      });
    }
    case 'tool_progress':
    case 'tool_result': {
      const current = conversation.tools.find((item) =>
        item.toolOccurrenceId === event.toolOccurrenceId
      );
      if (current === undefined) return state;
      const item: ApiToolOccurrence = event.kind === 'tool_progress'
        ? { ...current, progress: event.text }
        : { ...current, result: event.result };
      return Object.freeze({
        snapshot: {
          ...snapshot,
          conversation: {
            ...conversation,
            tools: upsertBy(
              conversation.tools,
              item,
              toolIdentity,
              event.toolOccurrenceId,
            ),
          },
        },
      });
    }
  }
};

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const upsertChange = <T>(
  before: readonly T[],
  after: readonly T[],
  identity: (item: T) => string,
  upsert: (value: T) => SessionChange,
  remove: (value: T) => SessionChange,
): SessionChange[] => {
  const changes: SessionChange[] = [];
  const beforeById = new Map(before.map((item) => [identity(item), item] as const));
  const afterById = new Map(after.map((item) => [identity(item), item] as const));
  for (const [key, item] of beforeById) {
    if (!afterById.has(key)) changes.push(remove(item));
  }
  for (const [key, item] of afterById) {
    const previous = beforeById.get(key);
    if (previous === undefined || !sameValue(previous, item)) changes.push(upsert(item));
  }
  return changes;
};

/** Project two snapshots into the finite, identity-keyed update vocabulary used by SSE. */
export const diffSessionSnapshots = (
  before: SessionSnapshot,
  after: SessionSnapshot,
): readonly SessionChange[] => {
  const changes: SessionChange[] = [];
  if (!sameValue(before.session, after.session)) {
    changes.push({ kind: 'session.replace', session: after.session });
  }
  if (!sameValue(before.runtime, after.runtime)) {
    changes.push({ kind: 'runtime.replace', runtime: after.runtime });
  }
  if (!sameValue(before.pending, after.pending)) {
    changes.push({ kind: 'pending.replace', pending: after.pending });
  }
  if (!sameValue(before.credentialAvailability, after.credentialAvailability)) {
    changes.push({
      kind: 'credentialAvailability.replace',
      credentialAvailability: after.credentialAvailability,
    });
  }
  if (!sameValue(before.context, after.context)) {
    changes.push({ kind: 'context.replace', context: after.context });
  }
  changes.push(...upsertChange(
    before.conversation.messages,
    after.conversation.messages,
    (item) => item.id,
    (message) => ({ kind: 'message.upsert', message }),
    (message) => ({ kind: 'message.remove', id: message.id }),
  ));
  changes.push(...upsertChange(
    before.conversation.tools,
    after.conversation.tools,
    (item) => item.toolOccurrenceId,
    (tool) => ({ kind: 'tool.upsert', tool }),
    (tool) => ({ kind: 'tool.remove', toolOccurrenceId: tool.toolOccurrenceId }),
  ));
  changes.push(...upsertChange(
    before.conversation.thinking,
    after.conversation.thinking,
    (item) => `${requestKeyIdentity(item.requestKey)}:${item.thinkingKind}`,
    (thinking) => ({ kind: 'thinking.upsert', thinking }),
    (thinking) => ({
      kind: 'thinking.remove',
      requestKey: thinking.requestKey,
      thinkingKind: thinking.thinkingKind,
    }),
  ));
  changes.push(...upsertChange(
    before.conversation.requests,
    after.conversation.requests,
    (item) => requestKeyIdentity(item.requestKey),
    (request) => ({ kind: 'request.upsert', request }),
    (request) => ({ kind: 'request.remove', requestKey: request.requestKey }),
  ));
  if (before.conversation.omitted !== after.conversation.omitted) {
    changes.push({
      kind: 'conversation.omitted.replace',
      omitted: after.conversation.omitted,
    });
  }
  return changes;
};

/** Apply a complete snapshot or one ordered revision from the shared HTTP/SSE stream. */
export const reduceSessionStreamFrame = (
  state: SessionClientState | undefined,
  frame: SessionStreamFrame,
): SessionClientState => {
  if (frame.kind === 'session.snapshot') return initialSessionClientState(frame.snapshot);
  if (state === undefined) throw new Error('session stream update arrived before snapshot');
  const previous = state.snapshot;
  if (
    frame.cursor.coreEpoch !== previous.cursor.coreEpoch ||
    frame.cursor.sessionId !== previous.cursor.sessionId
  ) throw new Error('session stream cursor target mismatch');
  if (frame.cursor.revision <= previous.cursor.revision) return state;
  if (
    frame.previousRevision !== previous.cursor.revision ||
    frame.cursor.revision !== frame.previousRevision + 1
  ) throw new Error('session stream revision gap; reconnect from a snapshot');
  let snapshot = previous;
  for (const change of frame.changes) {
    const conversation = snapshot.conversation;
    switch (change.kind) {
      case 'session.replace':
        snapshot = { ...snapshot, session: change.session };
        break;
      case 'runtime.replace':
        snapshot = { ...snapshot, runtime: change.runtime };
        break;
      case 'pending.replace':
        snapshot = { ...snapshot, pending: change.pending };
        break;
      case 'credentialAvailability.replace':
        snapshot = { ...snapshot, credentialAvailability: change.credentialAvailability };
        break;
      case 'context.replace':
        snapshot = { ...snapshot, context: change.context };
        break;
      case 'message.upsert':
        snapshot = {
          ...snapshot,
          conversation: {
            ...conversation,
            messages: upsertBy(
              conversation.messages,
              change.message,
              messageIdentity,
              change.message.id,
            ),
          },
        };
        break;
      case 'message.remove':
        snapshot = {
          ...snapshot,
          conversation: {
            ...conversation,
            messages: conversation.messages.filter((item) => item.id !== change.id),
          },
        };
        break;
      case 'tool.upsert':
        snapshot = {
          ...snapshot,
          conversation: {
            ...conversation,
            tools: upsertBy(
              conversation.tools,
              change.tool,
              toolIdentity,
              change.tool.toolOccurrenceId,
            ),
          },
        };
        break;
      case 'tool.remove':
        snapshot = {
          ...snapshot,
          conversation: {
            ...conversation,
            tools: conversation.tools.filter((item) =>
              item.toolOccurrenceId !== change.toolOccurrenceId
            ),
          },
        };
        break;
      case 'thinking.upsert':
        snapshot = {
          ...snapshot,
          conversation: {
            ...conversation,
            thinking: upsertBy(
              conversation.thinking,
              change.thinking,
              thinkingIdentity,
              `${requestKeyIdentity(change.thinking.requestKey)}:${change.thinking.thinkingKind}`,
            ),
          },
        };
        break;
      case 'thinking.remove': {
        const identity = `${requestKeyIdentity(change.requestKey)}:${change.thinkingKind}`;
        snapshot = {
          ...snapshot,
          conversation: {
            ...conversation,
            thinking: conversation.thinking.filter((item) => thinkingIdentity(item) !== identity),
          },
        };
        break;
      }
      case 'request.upsert':
        snapshot = {
          ...snapshot,
          conversation: {
            ...conversation,
            requests: upsertBy(
              conversation.requests,
              change.request,
              (item) => requestKeyIdentity(item.requestKey),
              requestKeyIdentity(change.request.requestKey),
            ),
          },
        };
        break;
      case 'request.remove':
        snapshot = {
          ...snapshot,
          conversation: {
            ...conversation,
            requests: withoutRequest(conversation.requests, change.requestKey),
          },
        };
        break;
      case 'conversation.omitted.replace':
        snapshot = {
          ...snapshot,
          conversation: { ...conversation, omitted: change.omitted },
        };
        break;
    }
  }
  return initialSessionClientState({ ...snapshot, cursor: frame.cursor });
};
