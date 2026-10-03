import type { SessionSnapshot } from '../../v0/api/contract.ts';
import type { ConversationEntity, ConversationPosition } from '../../v0/conversation/model.ts';
import type { SessionClientState } from '../../v0/api/reducer.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

export const tuiSessionId = 'tui-entity-session';

export const conversationPosition = (
  executionOrder: number,
  requestOrder: number,
  phase: number,
  eventOrdinal = 0,
  itemOrdinal = 0,
): ConversationPosition => ({
  executionOrder,
  requestOrder,
  phase,
  eventOrdinal,
  itemOrdinal,
});

export const tuiSnapshot = (
  entities: Readonly<Record<string, ConversationEntity>> = {},
  order: readonly string[] = [],
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot => {
  const sessionId = overrides.session?.id ?? tuiSessionId;
  return {
    schemaVersion: 2,
    cursor: overrides.cursor ?? { coreEpoch: 'tui-core', sessionId, revision: 1 },
    session: {
      id: sessionId,
      canonicalSessionId: sessionId,
      persistence: 'persistent',
      position: {
        sessionId,
        createdAt: '2026-09-29T00:00:00.000Z',
        agent: 'default',
        committedTurn: 0,
        messageCount: 0,
      },
      selection: { provider: 'test-provider', modelId: 'test-model', effort: 'auto' },
      startup: apiStartupFixture(),
      ...overrides.session,
    },
    runtime: {
      active: false,
      activeSessionId: sessionId,
      phase: 'idle',
      execution: null,
      operations: ['task.submit'],
      ...overrides.runtime,
    },
    conversation: {
      schemaVersion: 2,
      sessionId,
      cut: 1,
      storeRevision: 1,
      entities,
      order,
      ...overrides.conversation,
    },
    pending: { kind: 'core-owned', followUps: [], ...overrides.pending },
    credentialAvailability: { status: 'present', ...overrides.credentialAvailability },
    context: { ...overrides.context },
  };
};

export const tuiClientState = (
  snapshot: SessionSnapshot,
  dirtyEntityIds: ReadonlySet<string> = new Set(Object.keys(snapshot.conversation.entities)),
  structureChanged = true,
): SessionClientState => ({ snapshot, dirtyEntityIds, structureChanged });

export const taskEntity = (
  executionId: string,
  task: string,
  turn: number,
  executionOrder: number,
  version = 0,
): ConversationEntity => ({
  kind: 'message',
  id: `task/${executionId}`,
  executionId,
  turn,
  version,
  position: conversationPosition(executionOrder, -1, -1),
  role: 'user',
  text: task,
  complete: true,
});
