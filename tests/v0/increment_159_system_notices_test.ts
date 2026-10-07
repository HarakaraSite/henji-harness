import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type {
  ConversationEntity,
  ConversationExecutionMetadata,
} from '../../v0/conversation/model.ts';
import { KeyedConversationStore } from '../../v0/tui/keyed_conversation_store.ts';
import { RemoteSystemNotices } from '../../v0/tui/system_notices.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { freezeUiLogEntry, type UiLogEntry } from '../../v0/tui/state.ts';
import { TuiRenderer } from '../../v0/tui/tui_renderer.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { conversationPosition, tuiClientState, tuiSnapshot } from './tui_entity_fixture.ts';
import { TerminalScreen } from './terminal_screen_fixture.ts';

const executionId = 'execution-a';
const executionMetadata = (
  outcome: ConversationExecutionMetadata['outcome'],
  diagnostic?: ConversationExecutionMetadata['diagnostic'],
): ConversationExecutionMetadata => ({
  executionId,
  taskId: 'task-a',
  task: 'test task',
  sessionId: 'tui-entity-session',
  turn: 1,
  createdAt: '2026-09-29T00:00:00Z',
  lifecycle: outcome === 'unknown' ? 'active' : 'settled',
  outcome,
  ...(diagnostic === undefined ? {} : { diagnostic }),
  adoption: 'non_canonical',
  baseRevision: 1,
  agent: 'default',
  model: null,
});
const task: ConversationEntity = {
  kind: 'message',
  id: 'task-a',
  executionId,
  turn: 1,
  version: 0,
  position: conversationPosition(0, -1, -1),
  role: 'user',
  text: 'Inspect the file.',
  complete: true,
};
const tool: ConversationEntity = {
  kind: 'tool',
  id: 'read-one',
  declarationOccurrenceId: 'declaration-one',
  started: true,
  executionId,
  turn: 1,
  requestKey: { executionId, modelStep: 1, requestOrdinal: 1 },
  version: 1,
  position: conversationPosition(0, 1, 2),
  callId: 'read-call',
  name: 'read',
  arguments: { path: 'README.md' },
  result: { text: 'file contents', outcome: 'success' },
};
const thinking: ConversationEntity = {
  kind: 'thinking',
  id: 'thinking-one',
  executionId,
  turn: 1,
  requestKey: { executionId, modelStep: 1, requestOrdinal: 1 },
  thinkingKind: 'summary',
  version: 1,
  position: conversationPosition(0, 1, 1),
  text: 'I will inspect the file.',
  complete: true,
};
const terminalExecution = (
  outcome: ConversationExecutionMetadata['outcome'],
  diagnostic?: ConversationExecutionMetadata['diagnostic'],
): ConversationEntity => ({
  kind: 'execution',
  id: 'execution-row-a',
  executionId,
  version: 1,
  position: conversationPosition(0, -1, -2),
  execution: executionMetadata(outcome, diagnostic),
});
const rows = (store: KeyedConversationStore): readonly UiLogEntry[] => store.window(0, store.size);
const apply = (
  projector: SnapshotConversationProjector,
  notices: RemoteSystemNotices,
  client: ReturnType<typeof tuiClientState>,
  scope = 'core/session-a',
) => {
  const projected = projector.project(client, scope);
  notices.sync(client, projected.store, {
    reset: projected.reset,
    structureChanged: projected.structureChanged,
  });
  return projected;
};

Deno.test('Increment 166 failure and cancellation notices follow their keyed execution rows', () => {
  const projector = new SnapshotConversationProjector();
  const notices = new RemoteSystemNotices();
  const entities = {
    'task-a': task,
    'thinking-one': thinking,
    'read-one': tool,
    'execution-row-a': terminalExecution('cancelled'),
  } satisfies Record<string, ConversationEntity>;
  const cancelled = tuiSnapshot(entities, Object.keys(entities));
  const first = apply(projector, notices, tuiClientState(cancelled));
  deepStrictEqual(rows(first.store).map((item) => item.kind), [
    'user',
    'thinking',
    'tool',
    'system',
  ]);
  strictEqual(rows(first.store).at(-1)?.text, 'CANCELLED');
  const retainedNotice = rows(first.store).at(-1);
  const repeated = apply(projector, notices, tuiClientState(structuredClone(cancelled)));
  strictEqual(rows(repeated.store).at(-1), retainedNotice);

  const assistant: ConversationEntity = {
    kind: 'message',
    id: 'answer-a',
    executionId,
    turn: 1,
    version: 1,
    position: conversationPosition(0, 2, 1),
    role: 'assistant',
    text: 'Partial answer.',
    complete: false,
  };
  const withLateBody = {
    ...cancelled,
    cursor: { ...cancelled.cursor, revision: 2 },
    conversation: {
      ...cancelled.conversation,
      cut: 2,
      storeRevision: 2,
      entities: { ...entities, 'answer-a': assistant },
      order: [...cancelled.conversation.order, 'answer-a'],
    },
  };
  const advanced = apply(
    projector,
    notices,
    tuiClientState(withLateBody, new Set(['answer-a']), true),
  );
  deepStrictEqual(rows(advanced.store).map((item) => item.kind), [
    'user',
    'thinking',
    'tool',
    'assistant',
    'system',
  ]);
  strictEqual(rows(advanced.store).at(-1)?.text, 'CANCELLED');

  const failed = tuiSnapshot({
    'task-a': task,
    'execution-row-a': terminalExecution('failed', { code: 'response_error', stage: 'model' }),
  }, ['execution-row-a', 'task-a']);
  const freshProjector = new SnapshotConversationProjector();
  const freshNotices = new RemoteSystemNotices();
  const failure = apply(freshProjector, freshNotices, tuiClientState(failed));
  strictEqual(rows(failure.store).at(-1)?.text, 'FAILED · provider response invalid · try /recall');
});

Deno.test('Increment 159 local, queue and steering notices remain keyed by receipt and session', () => {
  const projector = new SnapshotConversationProjector();
  const notices = new RemoteSystemNotices();
  const initial = tuiSnapshot({ 'task-a': task }, ['task-a']);
  const first = apply(projector, notices, tuiClientState(initial));
  notices.retain(initial.session.id, 'command-one', 'REJECTED · draft kept · busy', 'REJECTED');
  notices.refresh(initial.session.id, first.store);
  const local = rows(first.store);
  strictEqual(local.at(-1)?.text, 'REJECTED · draft kept · busy');
  strictEqual(local.at(-1)?.kind, 'system');

  const pending = {
    ...initial,
    cursor: { ...initial.cursor, revision: 2 },
    pending: {
      ...initial.pending,
      followUp: {
        queueId: 'queue-one',
        commandId: 'queue-command',
        sessionId: initial.session.id,
        afterExecutionId: executionId,
        text: 'Next task.',
        status: 'queued' as const,
      },
      steering: { executionId, commandId: 'steer-command', text: 'Keep it short.' },
    },
  };
  const queued = apply(
    projector,
    notices,
    tuiClientState(pending, new Set(), false),
  );
  ok(rows(queued.store).some((item) => item.text === 'RESERVED · Next task.'));
  ok(
    rows(queued.store).some((item) =>
      item.text === 'Additional instruction received · Keep it short.'
    ),
  );
  strictEqual(rows(queued.store).filter((item) => item.id.includes('queue:')).length, 1);

  const appliedSteering: ConversationEntity = {
    kind: 'message',
    id: 'steering-applied',
    executionId,
    turn: 1,
    version: 1,
    position: conversationPosition(0, 4, 0),
    role: 'user',
    text: 'Keep it short.',
    complete: true,
  };
  const started = {
    ...pending,
    cursor: { ...pending.cursor, revision: 3 },
    pending: {
      ...pending.pending,
      steering: undefined,
      followUp: {
        ...pending.pending.followUp,
        status: 'started' as const,
        executionId: 'execution-b',
      },
    },
    conversation: {
      ...pending.conversation,
      cut: 2,
      storeRevision: 2,
      entities: { ...pending.conversation.entities, 'steering-applied': appliedSteering },
      order: [...pending.conversation.order, 'steering-applied'],
    },
  };
  const applied = apply(
    projector,
    notices,
    tuiClientState(started, new Set(['steering-applied']), true),
  );
  strictEqual(rows(applied.store).filter((item) => item.id.includes('steering:')).length, 0);
  strictEqual(rows(applied.store).filter((item) => item.id.includes('queue:')).length, 1);
  ok(rows(applied.store).some((item) => item.text === 'STARTED · Next task.'));

  const otherSession = tuiSnapshot({}, [], {
    session: {
      ...initial.session,
      id: 'session-b',
      position: { ...initial.session.position, sessionId: 'session-b' },
    },
    cursor: { ...initial.cursor, sessionId: 'session-b' },
    conversation: { ...initial.conversation, sessionId: 'session-b' },
  });
  const away = apply(projector, notices, tuiClientState(otherSession), 'core/session-b');
  strictEqual(rows(away.store).some((item) => item.text === 'REJECTED · draft kept · busy'), false);
  const back = apply(projector, notices, tuiClientState(initial), 'core/session-a');
  ok(rows(back.store).some((item) => item.text === 'REJECTED · draft kept · busy'));
});

Deno.test('Increment 159 normal system text is neutral and failure color stops after its short word', () => {
  const screen = new TerminalScreen(100, 24);
  const terminal: TerminalPort = {
    stdinIsTerminal: () => true,
    stdoutIsTerminal: () => true,
    consoleSize: () => ({ columns: 100, rows: 24 }),
    setRaw() {},
    read() {
      return Promise.resolve(null);
    },
    async drainAndCloseInput() {},
    write(bytes) {
      screen.write(bytes);
    },
    addSignal() {},
    removeSignal() {},
  };
  const store = new KeyedConversationStore();
  store.set(
    'notice',
    freezeUiLogEntry({
      id: 'notice',
      kind: 'system',
      label: 'system>',
      text: 'RESERVED · next task',
      revision: 0,
      live: false,
    }),
  );
  store.set(
    'failure',
    freezeUiLogEntry({
      id: 'failure',
      kind: 'system',
      label: 'system>',
      text: 'FAILED · provider response invalid · try /recall',
      failureWord: 'FAILED',
      revision: 0,
      live: false,
    }),
  );
  store.replaceSemanticOrder(['notice', 'failure']);
  const renderer = new TuiRenderer(terminal);
  renderer.setKeyedConversationStore(store);
  renderer.flushRender();
  const frame = renderer.renderScreenFrame(100, 24);
  const frameText = frame.rows.join('\n');
  const visibleText = screen.frame().rows.join('\n');
  ok(frameText.includes('system> RESERVED · next task'));
  ok(frameText.includes('\x1b[31msystem> FAILED\x1b[0m · provider response invalid · try /recall'));
  ok(visibleText.includes('system> RESERVED · next task'));
  ok(visibleText.includes('FAILED · provider response invalid · try /recall'));
  renderer.close();
});
