import type { ConversationObservation } from '../../../v0/conversation/model.ts';
import {
  createConversationState,
  orderedConversationEntities,
} from '../../../v0/conversation/model.ts';
import {
  applyObservation,
  createConversationNormalizer,
} from '../../../v0/conversation/normalizer.ts';
import { initialSessionClientState } from '../../../v0/api/reducer.ts';
import { SnapshotConversationProjector } from '../../../v0/tui/snapshot_presentation.ts';
import { sessionSnapshotFixture } from '../session_snapshot_fixture.ts';

export const fixtureExecutionId = 'fixture-execution';
const sessionId = '14600000-0000-4000-8000-000000000001';

/** Explicit source observations use the same common engine and entity mapper as production. */
const conversationFixture = (
  task: string,
  observations: readonly ConversationObservation[],
) => {
  const state = createConversationState(sessionId);
  const normalizer = createConversationNormalizer();
  applyObservation(state, normalizer, {
    kind: 'execution',
    executionOrder: 0,
    execution: {
      executionId: fixtureExecutionId,
      taskId: 'fixture-task',
      task,
      sessionId,
      turn: 1,
      createdAt: '2026-10-03T00:00:00.000Z',
      lifecycle: 'active',
      outcome: 'unknown',
      adoption: 'non_canonical',
      baseRevision: 1,
      agent: 'default',
      model: {},
    },
  });
  for (const observation of observations) applyObservation(state, normalizer, observation);
  return {
    schemaVersion: 3 as const,
    sessionId,
    cut: 0,
    storeRevision: 0,
    page: { direction: 'latest' as const, hasOlder: false, hasNewer: false },
    entities: Object.fromEntries(state.entities),
    order: orderedConversationEntities(state).map((entity) => entity.id),
  };
};

export const conversationFixtureRows = (
  task: string,
  observations: readonly ConversationObservation[],
) => {
  const snapshot = sessionSnapshotFixture(conversationFixture(task, observations));
  const update = new SnapshotConversationProjector().project(
    initialSessionClientState(snapshot),
    'fixture',
  );
  return update.store.window(0, update.store.size);
};
