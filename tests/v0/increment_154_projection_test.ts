import { deepEqual, equal, strictEqual } from 'node:assert/strict';
import type { SessionSnapshot } from '../../v0/api/contract.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { createUiState, reduceUiAction } from '../../v0/tui/state.ts';
import { sessionSnapshotFixture } from './session_snapshot_fixture.ts';

const baseSnapshot = sessionSnapshotFixture({
  messages: [],
  tools: [],
  thinking: [],
  requests: [],
  omitted: 0,
});

const withConversation = (
  conversation: SessionSnapshot['conversation'],
  revision = 1,
): SessionSnapshot => ({
  ...baseSnapshot,
  cursor: { ...baseSnapshot.cursor, revision },
  conversation,
});

const initialConversation: SessionSnapshot['conversation'] = {
  messages: [
    {
      id: 'message-user',
      executionId: 'execution-1',
      turn: 1,
      role: 'user',
      text: 'Inspect the file.',
    },
    {
      id: 'message-assistant',
      executionId: 'execution-1',
      turn: 1,
      role: 'assistant',
      text: 'I will inspect it.',
      toolOccurrenceIds: ['tool-1'],
    },
    {
      id: 'message-tool',
      executionId: 'execution-1',
      turn: 1,
      role: 'tool',
      text: 'file contents',
      toolOccurrenceIds: ['tool-1'],
    },
  ],
  tools: [{
    toolOccurrenceId: 'tool-1',
    executionId: 'execution-1',
    turn: 1,
    name: 'read',
    arguments: { path: 'README.md' },
    result: { text: 'file contents', outcome: 'success' },
  }],
  thinking: [{
    requestKey: { executionId: 'execution-1', modelStep: 1, requestOrdinal: 1 },
    turn: 1,
    thinkingKind: 'text',
    text: 'Checking the result.',
    complete: true,
    beforeMessageIndex: 2,
  }],
  requests: [],
  omitted: 2,
};

Deno.test('Increment 154 projection reuses unchanged entries across resync and updates stable identities', () => {
  const projector = new SnapshotConversationProjector();
  const first = projector.project(withConversation(initialConversation), 'core-a/session-a');
  deepEqual(first.entries.map((entry) => [entry.kind, entry.label, entry.text]), [
    ['user', 'user>', 'Inspect the file.'],
    ['assistant', 'assistant note>', 'I will inspect it.'],
    ['tool', 'tool>', 'read README.md ✓'],
    ['thinking', 'thinking>', 'Checking the result.'],
  ]);
  equal(first.omitted, 2);

  const resynced = projector.project(
    structuredClone(withConversation(initialConversation, 2)),
    'core-a/session-a',
    { resync: true },
  );
  strictEqual(resynced.entries.length, first.entries.length);
  for (let index = 0; index < first.entries.length; index += 1) {
    strictEqual(resynced.entries[index], first.entries[index]);
  }

  const changedMessage = {
    ...initialConversation,
    messages: initialConversation.messages.map((message) =>
      message.id === 'message-assistant' ? { ...message, text: 'I checked it.' } : message
    ),
  };
  const updated = projector.project(withConversation(changedMessage, 3), 'core-a/session-a', {
    messageIds: ['message-assistant'],
  });
  strictEqual(updated.entries[0], first.entries[0]);
  equal(updated.entries[1]?.text, 'I checked it.');
  equal(updated.entries[1]?.revision, 1);
  strictEqual(updated.entries[2], first.entries[2]);
  strictEqual(updated.entries[3], first.entries[3]);

  const changedTool = {
    ...changedMessage,
    tools: changedMessage.tools.map((tool) => ({
      ...tool,
      result: { ...tool.result!, outcome: 'error' as const },
    })),
  };
  const toolUpdated = projector.project(withConversation(changedTool, 4), 'core-a/session-a', {
    toolOccurrenceIds: ['tool-1'],
  });
  strictEqual(toolUpdated.entries[0], first.entries[0]);
  strictEqual(toolUpdated.entries[1], updated.entries[1]);
  equal(toolUpdated.entries[2]?.id, first.entries[2]?.id);
  equal(toolUpdated.entries[2]?.text, 'read README.md ✗');
  equal(toolUpdated.entries[2]?.revision, 1);
  strictEqual(toolUpdated.entries[3], first.entries[3]);
});

Deno.test('Increment 154 projection preserves thinking placement and source scope identity', () => {
  const projector = new SnapshotConversationProjector();
  const first = projector.project(withConversation(initialConversation), 'core-a/session-a');
  const movedThinking = {
    ...initialConversation,
    thinking: initialConversation.thinking.map((item) => ({
      ...item,
      beforeMessageIndex: 1,
    })),
  };
  const moved = projector.project(withConversation(movedThinking, 2), 'core-a/session-a', {
    thinkingIds: ['["execution-1",null,1,1]:text'],
  });
  deepEqual(moved.entries.map((entry) => entry.kind), [
    'user',
    'thinking',
    'assistant',
    'tool',
  ]);
  strictEqual(moved.entries.find((entry) => entry.kind === 'thinking'), first.entries[3]);

  const otherSession = projector.project(
    withConversation(initialConversation, 1),
    'core-a/session-b',
  );
  equal(otherSession.entries[0]?.id, first.entries[0]?.id);
  equal(otherSession.entries[0]?.revision, 0);
  equal(otherSession.entries[0] === first.entries[0], false);
});

Deno.test('Increment 154 conversation action preserves UI state while applying deferred scroll reset', () => {
  const projector = new SnapshotConversationProjector();
  const projected = projector.project(withConversation(initialConversation), 'core-a/session-a');
  const entriesAction = {
    kind: 'conversation_projection' as const,
    entries: projected.entries,
    omitted: projected.omitted,
    resetScroll: true,
  };
  let state = reduceUiAction(createUiState(), entriesAction);
  const warning = state.log.entries.at(-1);
  equal(warning?.text, '2 messages omitted');
  equal(
    state.log.entries[0]?.textByteLength,
    new TextEncoder().encode('Inspect the file.').byteLength,
  );

  state = reduceUiAction(state, {
    kind: 'editor',
    snapshot: { text: 'draft', cursorScalar: 3, byteLength: 5 },
  });
  state = reduceUiAction(state, {
    kind: 'overlay',
    overlay: { kind: 'readOnlyHelp', lines: ['help'] },
  });
  const anchor = state.log.entries[0]!;
  state = reduceUiAction(state, {
    kind: 'scroll',
    mode: { kind: 'anchored', entryId: anchor.id, sourceScalarOffset: 4 },
  });
  state = reduceUiAction(state, {
    ...entriesAction,
    resetScroll: false,
  });
  deepEqual(state.scroll, { kind: 'anchored', entryId: anchor.id, sourceScalarOffset: 4 });
  deepEqual(state.overlay, { kind: 'readOnlyHelp', lines: ['help'] });
  equal(state.editor.text, 'draft');
  strictEqual(state.log.entries.at(-1), warning);

  state = reduceUiAction(state, entriesAction);
  deepEqual(state.scroll, { kind: 'followLatest' });
  deepEqual(state.overlay, { kind: 'readOnlyHelp', lines: ['help'] });
});

Deno.test('Increment 154 saved API message IDs reused across turns retain every entry', () => {
  const conversation = {
    ...initialConversation,
    tools: [],
    thinking: [],
    omitted: 0,
    messages: [1, 2].flatMap((turn) => [{
      id: 'saved-session:message:0',
      executionId: 'saved-session',
      turn,
      role: 'user' as const,
      text: `question ${turn}`,
    }, {
      id: 'saved-session:message:1',
      executionId: 'saved-session',
      turn,
      role: 'assistant' as const,
      text: `answer ${turn}`,
    }]),
  };
  const projector = new SnapshotConversationProjector();
  const first = projector.project(withConversation(conversation), 'core/saved-session');
  deepEqual(first.entries.map((entry) => entry.text), [
    'question 1',
    'answer 1',
    'question 2',
    'answer 2',
  ]);
  equal(new Set(first.entries.map((entry) => entry.id)).size, 4);
  const resync = projector.project(
    structuredClone(withConversation(conversation, 2)),
    'core/saved-session',
    { resync: true },
  );
  resync.entries.forEach((entry, index) => strictEqual(entry, first.entries[index]));
});
