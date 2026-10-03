import { deepEqual, equal, strictEqual } from 'node:assert/strict';
import type { ConversationEntity } from '../../v0/conversation/model.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { createUiState, reduceUiAction } from '../../v0/tui/state.ts';
import { conversationPosition, tuiClientState, tuiSnapshot } from './tui_entity_fixture.ts';

const executionId = 'execution-1';
const entities: Record<string, ConversationEntity> = {
  'message-user': {
    kind: 'message',
    id: 'message-user',
    executionId,
    turn: 1,
    version: 0,
    position: conversationPosition(0, -1, -1),
    role: 'user',
    text: 'Inspect the file.',
    complete: true,
  },
  'message-assistant': {
    kind: 'message',
    id: 'message-assistant',
    executionId,
    turn: 1,
    version: 0,
    position: conversationPosition(0, 1, 1),
    role: 'assistant',
    text: 'I will inspect it.',
    complete: true,
    toolIds: ['tool-1'],
  },
  'tool-1': {
    kind: 'tool',
    id: 'tool-1',
    declarationOccurrenceId: 'decl-1',
    started: true,
    executionId,
    turn: 1,
    requestKey: { executionId, modelStep: 1, requestOrdinal: 1 },
    version: 0,
    position: conversationPosition(0, 1, 2),
    callId: 'read-call',
    name: 'read',
    arguments: { path: 'README.md' },
    result: { text: 'file contents', outcome: 'success' },
  },
  'thinking-1': {
    kind: 'thinking',
    id: 'thinking-1',
    executionId,
    turn: 1,
    requestKey: { executionId, modelStep: 1, requestOrdinal: 1 },
    thinkingKind: 'text',
    version: 0,
    position: conversationPosition(0, 1, 3),
    text: 'Checking the result.',
    complete: true,
  },
};
const base = tuiSnapshot(entities, Object.keys(entities));

Deno.test('Increment 154 maps shared entities through one keyed dirty-row projection', () => {
  const projector = new SnapshotConversationProjector();
  const first = projector.project(tuiClientState(base), 'core-a/session-a');
  deepEqual(
    first.store.window(0, first.store.size).map((entry) => [entry.kind, entry.label, entry.text]),
    [
      ['user', 'user>', 'Inspect the file.'],
      ['assistant', 'assistant note>', 'I will inspect it.'],
      ['tool', 'tool>', 'read README.md ✓'],
      ['thinking', 'thinking>', 'Checking the result.'],
    ],
  );
  equal(first.structureChanged, true);
  const unchangedUser = first.store.get('conversation:message-user');
  const unchangedThinking = first.store.get('conversation:thinking-1');

  const changedEntities = {
    ...entities,
    'message-assistant': {
      ...entities['message-assistant'] as Extract<ConversationEntity, { kind: 'message' }>,
      version: 1,
      text: 'I checked it.',
    },
  } satisfies Record<string, ConversationEntity>;
  const updatedState = tuiClientState(
    tuiSnapshot(changedEntities, Object.keys(changedEntities), {
      cursor: { ...base.cursor, revision: 2 },
      conversation: {
        ...base.conversation,
        entities: changedEntities,
        cut: 2,
        storeRevision: 2,
      },
    }),
    new Set(['message-assistant']),
    false,
  );
  const updated = projector.project(updatedState, 'core-a/session-a');
  equal(updated.revision, 2);
  deepEqual([...updated.changedIds], ['conversation:message-assistant']);
  strictEqual(updated.store.get('conversation:message-user'), unchangedUser);
  strictEqual(updated.store.get('conversation:thinking-1'), unchangedThinking);
  equal(updated.store.get('conversation:message-assistant')?.text, 'I checked it.');
  equal(updated.store.get('conversation:message-assistant')?.revision, 1);

  const changedTool = {
    ...changedEntities,
    'tool-1': {
      ...entities['tool-1'] as Extract<ConversationEntity, { kind: 'tool' }>,
      version: 2,
      result: { text: 'permission denied', outcome: 'error' as const },
    },
  } satisfies Record<string, ConversationEntity>;
  const toolUpdate = projector.project(
    tuiClientState(
      tuiSnapshot(changedTool, Object.keys(changedTool), {
        cursor: { ...base.cursor, revision: 3 },
        conversation: {
          ...base.conversation,
          entities: changedTool,
          cut: 3,
          storeRevision: 3,
        },
      }),
      new Set(['tool-1']),
      false,
    ),
    'core-a/session-a',
  );
  equal(toolUpdate.store.get('conversation:tool-1')?.text, 'read README.md ✗');
  strictEqual(toolUpdate.store.get('conversation:message-user'), unchangedUser);
});

Deno.test('Increment 154 reused source ids remain distinct across turns and reset by Session scope', () => {
  const projector = new SnapshotConversationProjector();
  const sameIds: Record<string, ConversationEntity> = {};
  for (const turn of [1, 2]) {
    const task: ConversationEntity = {
      kind: 'message',
      id: `saved-session:message:0:${turn}`,
      executionId: 'saved-session',
      turn,
      version: 0,
      position: conversationPosition(turn - 1, -1, -1),
      role: 'user',
      text: `question ${turn}`,
      complete: true,
    };
    const answer: ConversationEntity = {
      kind: 'message',
      id: `saved-session:message:1:${turn}`,
      executionId: 'saved-session',
      turn,
      version: 0,
      position: conversationPosition(turn - 1, 1, 1),
      role: 'assistant',
      text: `answer ${turn}`,
      complete: true,
    };
    sameIds[task.id] = task;
    sameIds[answer.id] = answer;
  }
  const snapshot = tuiSnapshot(sameIds, Object.keys(sameIds));
  const first = projector.project(tuiClientState(snapshot), 'core/saved-session');
  const firstUser = first.store.get('conversation:saved-session:message:0:1');
  deepEqual(first.store.window(0, first.store.size).map((entry) => entry.text), [
    'question 1',
    'answer 1',
    'question 2',
    'answer 2',
  ]);
  equal(new Set(first.store.ids()).size, 4);
  const nextSession = projector.project(
    tuiClientState(tuiSnapshot(sameIds, Object.keys(sameIds), {
      session: { ...snapshot.session, id: 'saved-session-2' },
      cursor: { ...snapshot.cursor, sessionId: 'saved-session-2' },
      conversation: { ...snapshot.conversation, sessionId: 'saved-session-2' },
    })),
    'core/saved-session-2',
  );
  equal(nextSession.reset, true);
  strictEqual(
    nextSession.store.get('conversation:saved-session:message:0:1') === firstUser,
    false,
  );
});

Deno.test('Increment 154 keyed conversation action preserves editor, modal and scroll anchor', () => {
  const projector = new SnapshotConversationProjector();
  const projected = projector.project(tuiClientState(base), 'core-a/session-a');
  let state = reduceUiAction(createUiState(), {
    kind: 'keyed_conversation',
    store: projected.store,
    resetScroll: true,
    structureChanged: projected.structureChanged,
  });
  state = reduceUiAction(state, {
    kind: 'editor',
    snapshot: { text: 'draft', cursorScalar: 3, byteLength: 5 },
  });
  state = reduceUiAction(state, {
    kind: 'overlay',
    overlay: { kind: 'readOnlyHelp', lines: ['help'] },
  });
  const anchor = state.keyedConversation!.entryAt(0)!;
  state = reduceUiAction(state, {
    kind: 'scroll',
    mode: { kind: 'anchored', entryId: anchor.id, sourceScalarOffset: 4 },
  });
  const updated = projector.project(
    tuiClientState(
      tuiSnapshot(
        {
          ...entities,
          'message-assistant': {
            ...entities['message-assistant'] as Extract<ConversationEntity, { kind: 'message' }>,
            version: 1,
            text: 'Updated answer.',
          },
        },
        Object.keys(entities),
        {
          cursor: { ...base.cursor, revision: 2 },
          conversation: {
            ...base.conversation,
            entities: {
              ...entities,
              'message-assistant': {
                ...entities['message-assistant'] as Extract<
                  ConversationEntity,
                  { kind: 'message' }
                >,
                version: 1,
                text: 'Updated answer.',
              },
            },
            cut: 2,
            storeRevision: 2,
          },
        },
      ),
      new Set(['message-assistant']),
      false,
    ),
    'core-a/session-a',
  );
  state = reduceUiAction(state, {
    kind: 'keyed_conversation',
    store: updated.store,
    structureChanged: updated.structureChanged,
  });
  deepEqual(state.scroll, { kind: 'anchored', entryId: anchor.id, sourceScalarOffset: 4 });
  deepEqual(state.overlay, { kind: 'readOnlyHelp', lines: ['help'] });
  equal(state.editor.text, 'draft');
});

Deno.test('Increment 154 deleted scroll anchors move to the nearest surviving row', () => {
  const projector = new SnapshotConversationProjector();
  const initial: Record<string, ConversationEntity> = {};
  for (const [index, id] of ['first', 'anchor', 'last'].entries()) {
    initial[id] = {
      kind: 'message',
      id,
      executionId: `execution-${id}`,
      turn: index + 1,
      version: 0,
      position: conversationPosition(index, -1, -1),
      role: 'user',
      text: id,
      complete: true,
    };
  }
  const first = projector.project(
    tuiClientState(tuiSnapshot(initial, ['first', 'anchor', 'last'])),
    'core/anchor',
  );
  let state = reduceUiAction(createUiState(), {
    kind: 'keyed_conversation',
    store: first.store,
    resetScroll: true,
    structureChanged: true,
  });
  state = reduceUiAction(state, {
    kind: 'scroll',
    mode: { kind: 'anchored', entryId: 'conversation:anchor', sourceScalarOffset: 7 },
  });

  const remaining = { first: initial.first!, last: initial.last! };
  const updated = projector.project(
    tuiClientState(
      tuiSnapshot(remaining, ['first', 'last'], {
        cursor: { coreEpoch: 'tui-core', sessionId: 'tui-entity-session', revision: 2 },
        conversation: {
          schemaVersion: 2,
          sessionId: 'tui-entity-session',
          cut: 2,
          storeRevision: 2,
          entities: remaining,
          order: ['first', 'last'],
        },
      }),
      new Set(['anchor']),
      true,
    ),
    'core/anchor',
  );
  state = reduceUiAction(state, {
    kind: 'keyed_conversation',
    store: updated.store,
    structureChanged: true,
    previousIds: updated.previousIds,
  });
  deepEqual(state.scroll, {
    kind: 'anchored',
    entryId: 'conversation:last',
    sourceScalarOffset: 0,
  });
});
