import type { RequestKey, SessionSnapshot, SessionStreamFrame } from './contract.ts';
import { compareConversationPositions, type ConversationEntity } from '../conversation/model.ts';

export type SessionClientState = Readonly<{
  snapshot: SessionSnapshot;
  dirtyEntityIds: ReadonlySet<string>;
  structureChanged: boolean;
}>;

export const requestKeyIdentity = (key: RequestKey): string =>
  JSON.stringify([key.executionId, key.lane ?? null, key.modelStep, key.requestOrdinal ?? null]);

export const initialSessionClientState = (snapshot: SessionSnapshot): SessionClientState => ({
  snapshot: {
    ...snapshot,
    conversation: {
      ...snapshot.conversation,
      entities: { ...snapshot.conversation.entities },
      order: [...snapshot.conversation.order],
    },
  },
  dirtyEntityIds: new Set(Object.keys(snapshot.conversation.entities)),
  structureChanged: true,
});

/** A client owns its keyed entities. Text updates replace one value, never rebuild old arrays. */
export const reduceSessionStreamFrame = (
  state: SessionClientState | undefined,
  frame: SessionStreamFrame,
): SessionClientState => {
  if (frame.kind === 'session.snapshot') {
    const next = initialSessionClientState(frame.snapshot);
    return {
      ...next,
      dirtyEntityIds: new Set([
        ...Object.keys(state?.snapshot.conversation.entities ?? {}),
        ...next.dirtyEntityIds,
      ]),
    };
  }
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
    }
  }
  const dirty = new Set<string>();
  let structureChanged = false;
  const delta = frame.conversationDelta;
  if (delta !== undefined) {
    const conversation = snapshot.conversation;
    if (delta.sessionId !== snapshot.session.id || delta.cut !== conversation.cut + 1) {
      throw new Error('conversation cut gap; reconnect from a snapshot');
    }
    const entities = conversation.entities as Record<string, ConversationEntity>;
    const order = conversation.order as string[];
    for (const change of delta.changes) {
      if (change.kind === 'upsert') {
        entities[change.entity.id] = change.entity;
        dirty.add(change.entity.id);
      } else if (change.kind === 'remove') {
        delete entities[change.id];
        dirty.add(change.id);
      } else if (change.action === 'remove') {
        const index = order.indexOf(change.id);
        if (index >= 0) order.splice(index, 1);
        structureChanged = true;
      } else if (!order.includes(change.id)) {
        const position = change.position ?? entities[change.id]?.position;
        if (position === undefined) throw new Error('conversation order has no position');
        let low = 0;
        let high = order.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          const candidate = entities[order[mid]];
          const compared = candidate === undefined
            ? -1
            : compareConversationPositions(candidate.position, position) ||
              candidate.id.localeCompare(change.id);
          if (compared < 0) low = mid + 1;
          else high = mid;
        }
        order.splice(low, 0, change.id);
        structureChanged = true;
      }
    }
    snapshot = {
      ...snapshot,
      conversation: {
        ...conversation,
        cut: delta.cut,
        storeRevision: delta.storeRevision,
        ...(delta.page === undefined ? {} : { page: delta.page }),
      },
    };
  }
  return {
    snapshot: { ...snapshot, cursor: frame.cursor },
    dirtyEntityIds: dirty,
    structureChanged,
  };
};
