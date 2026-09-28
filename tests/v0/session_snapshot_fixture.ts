import type { SessionSnapshot } from '../../v0/api/contract.ts';

const sessionId = '14600000-0000-4000-8000-000000000001';

/** Minimal shared Core snapshot fixture for presentation tests. */
export const sessionSnapshotFixture = (
  conversation: SessionSnapshot['conversation'],
): SessionSnapshot => ({
  schemaVersion: 1,
  cursor: { coreEpoch: 'presentation-test', sessionId, revision: 1 },
  session: {
    id: sessionId,
    canonicalSessionId: sessionId,
    persistence: 'persistent',
    position: {
      sessionId,
      createdAt: '2026-09-28T00:00:00.000Z',
      agent: 'default',
      committedTurn: 0,
      messageCount: conversation.messages.length,
    },
    selection: { provider: 'openrouter-chat', modelId: 'test-model', effort: 'medium' },
    startup: { status: 'ready' },
  },
  runtime: {
    active: false,
    activeSessionId: sessionId,
    phase: 'idle',
    execution: null,
    operations: [],
  },
  conversation,
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'unknown' },
  context: {},
});
