import type { SessionSnapshot } from '../../v0/api/contract.ts';

const sessionId = '14600000-0000-4000-8000-000000000001';

/** Minimal shared Core snapshot fixture for presentation tests. */
export const sessionSnapshotFixture = (
  conversation: SessionSnapshot['conversation'],
): SessionSnapshot => ({
  schemaVersion: 3,
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
      messageCount:
        Object.values(conversation.entities).filter((entity) => entity.kind === 'message').length,
    },
    selection: { provider: 'openrouter-chat', modelId: 'test-model', effort: 'medium' },
    startup: {
      status: 'evaluated',
      productVersion: '0.7.0',
      workspace: '/tmp/workspace',
      agentId: 'default',
      model: {
        provider: 'openrouter-chat',
        profileId: 'openrouter-api-key',
        modelId: 'test-model',
        effort: 'medium',
      },
      sessionMode: { kind: 'new' },
      instructions: { loaded: false, source: 'none' },
      skills: { count: 0, names: [], omitted: 0 },
      trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
      credentialVerification: 'before_each_provider_request',
    },
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
