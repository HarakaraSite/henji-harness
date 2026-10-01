import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { ExecutionView, SessionSnapshot } from '../../v0/api/contract.ts';
import { RemoteSystemNotices } from '../../v0/tui/system_notices.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { freezeUiLogEntry, type UiLogEntry } from '../../v0/tui/state.ts';
import { TuiRenderer } from '../../v0/tui/tui_renderer.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

const entry = (id: string, text: string, label = 'user>'): UiLogEntry =>
  freezeUiLogEntry({
    id,
    kind: 'user',
    label,
    text,
    revision: 0,
    live: false,
    executionId: 'execution-a',
    turn: 1,
  });
const execution = (outcome: ExecutionView['outcome']): ExecutionView => ({
  executionId: 'execution-a',
  sessionId: 'session-a',
  task: 'test task',
  turn: 1,
  createdAt: '2026-09-29T00:00:00Z',
  lifecycle: 'settled',
  outcome,
  adoption: 'non_canonical',
  processSettlement: 'complete',
  requestCount: 1,
  durability: {
    acknowledgement: 'durable',
    generationAvailability: 'available',
    diagnosticCapture: 'durable',
    artifactCapture: 'none',
    contextCapture: 'none',
  },
});
const snapshot = (sessionId = 'session-a'): SessionSnapshot => ({
  schemaVersion: 1,
  cursor: { coreEpoch: 'core', sessionId, revision: 1 },
  session: {
    id: sessionId,
    canonicalSessionId: sessionId,
    persistence: 'persistent',
    position: {
      sessionId,
      createdAt: '2026-09-29T00:00:00Z',
      agent: 'default',
      committedTurn: 1,
      messageCount: 1,
    },
    selection: { provider: 'test', modelId: 'test/model', effort: 'auto' },
    startup: apiStartupFixture(),
  },
  runtime: {
    active: false,
    activeSessionId: sessionId,
    phase: 'idle',
    execution: null,
    operations: ['task.submit'],
  },
  conversation: { messages: [], tools: [], thinking: [], executions: [], requests: [], omitted: 0 },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'present' },
  context: {},
});
const systemEntries = (entries: readonly UiLogEntry[]) =>
  entries.filter((item) => item.kind === 'system');

const toolConversation = (): SessionSnapshot['conversation'] => ({
  messages: [
    { id: 'user', executionId: 'execution-a', turn: 1, role: 'user', text: 'Inspect the file.' },
    {
      id: 'call',
      executionId: 'execution-a',
      turn: 1,
      role: 'assistant',
      toolOccurrenceIds: ['read-one'],
    },
    {
      id: 'result',
      executionId: 'execution-a',
      turn: 1,
      role: 'tool',
      toolOccurrenceIds: ['read-one'],
    },
  ],
  tools: [{
    toolOccurrenceId: 'read-one',
    executionId: 'execution-a',
    turn: 1,
    name: 'read',
    arguments: { path: 'README.md' },
    result: { text: 'file contents', outcome: 'success' },
  }],
  thinking: [],
  executions: [],
  requests: [],
  omitted: 0,
});

Deno.test('Increment 166 cancellation follows projected tools with or without thinking', () => {
  const first = {
    ...snapshot(),
    runtime: { ...snapshot().runtime, execution: execution('cancelled') },
    conversation: { ...toolConversation(), executions: [execution('cancelled')] },
  };
  const projector = new SnapshotConversationProjector();
  const notices = new RemoteSystemNotices();
  const merged = notices.merge(first, projector.project(first, 'scope').entries);
  deepStrictEqual(merged.map((item) => item.kind), ['user', 'tool', 'system']);
  strictEqual(merged.at(-1)?.text, 'CANCELLED');
  const resynced = structuredClone(first);
  deepStrictEqual(
    notices.merge(resynced, projector.project(resynced, 'scope', { resync: true }).entries),
    merged,
  );

  const withThinking = {
    ...first,
    conversation: {
      ...first.conversation,
      thinking: [{
        requestKey: { executionId: 'execution-a', modelStep: 1, requestOrdinal: 1 },
        turn: 1,
        thinkingKind: 'summary' as const,
        text: 'I will inspect the file.',
        complete: true,
        beforeMessageIndex: 1,
      }],
    },
  };
  const thought = new RemoteSystemNotices().merge(
    withThinking,
    projector.project(withThinking, 'scope').entries,
  );
  deepStrictEqual(thought.map((item) => item.kind), ['user', 'thinking', 'tool', 'system']);
  strictEqual(thought.at(-1)?.text, 'CANCELLED');

  const next = {
    ...first,
    conversation: {
      ...first.conversation,
      messages: [...first.conversation.messages, {
        id: 'next-user',
        executionId: 'execution-b',
        turn: 2,
        role: 'user' as const,
        text: 'Next task.',
      }],
    },
  };
  deepStrictEqual(
    notices.merge(next, projector.project(next, 'scope').entries).map((item) => item.kind),
    ['user', 'tool', 'system', 'user'],
  );
});

Deno.test('Increment 166 failure follows the last assistant or thinking entry of its execution', () => {
  const conversation = toolConversation();
  const first = {
    ...snapshot(),
    runtime: { ...snapshot().runtime, execution: execution('failed') },
    conversation: {
      ...conversation,
      executions: [execution('failed')],
      messages: [...conversation.messages, {
        id: 'answer',
        executionId: 'execution-a',
        turn: 1,
        role: 'assistant' as const,
        text: 'Partial answer.',
      }],
    },
  };
  const projector = new SnapshotConversationProjector();
  const merged = new RemoteSystemNotices().merge(first, projector.project(first, 'scope').entries);
  deepStrictEqual(merged.map((item) => item.kind), ['user', 'tool', 'assistant', 'system']);
  strictEqual(merged.at(-1)?.text, 'FAILED · execution failed');
  const withTrailingThinking = {
    ...first,
    conversation: {
      ...first.conversation,
      thinking: [{
        requestKey: { executionId: 'execution-a', modelStep: 2, requestOrdinal: 2 },
        turn: 1,
        thinkingKind: 'summary' as const,
        text: 'Continuing the investigation.',
        complete: false,
        beforeMessageIndex: first.conversation.messages.length,
      }],
    },
  };
  deepStrictEqual(
    new RemoteSystemNotices().merge(
      withTrailingThinking,
      projector.project(withTrailingThinking, 'scope').entries,
    ).map((item) => item.kind),
    ['user', 'tool', 'assistant', 'thinking', 'system'],
  );
});

Deno.test('Increment 166 command, queue and steering notices anchor after projected work', () => {
  const base = toolConversation();
  const conversation = {
    ...base,
    messages: base.messages.map((message) =>
      message.id === 'call' ? { ...message, text: 'I will inspect it.' } : message
    ),
  };
  const first = { ...snapshot(), conversation };
  const projector = new SnapshotConversationProjector();
  const notices = new RemoteSystemNotices();
  const entries = projector.project(first, 'scope').entries;
  notices.merge(first, entries);
  notices.retain(
    first.session.id,
    'command',
    'REJECTED · execution.cancel',
    'REJECTED',
    'execution-a',
  );
  notices.retain(first.session.id, 'connection', 'DISCONNECTED', 'DISCONNECTED');
  const queued = {
    ...first,
    pending: {
      ...first.pending,
      followUp: {
        queueId: 'queue-one',
        commandId: 'queue-command',
        sessionId: first.session.id,
        afterExecutionId: 'execution-a',
        text: 'Next task.',
        status: 'queued' as const,
      },
      steering: { commandId: 'steer-command', executionId: 'execution-a', text: 'Keep it short.' },
    },
  };
  const merged = notices.merge(queued, entries);
  deepStrictEqual(merged.map((item) => item.kind), [
    'user',
    'assistant',
    'tool',
    'system',
    'system',
    'system',
    'system',
  ]);
  strictEqual(merged[3].text, 'REJECTED · execution.cancel');
  strictEqual(merged[5].text, 'RESERVED · Next task.');
  strictEqual(merged[6].text, 'Additional instruction received · Keep it short.');
  notices.retain(
    first.session.id,
    'command',
    'UNCONFIRMED · execution.cancel',
    'UNCONFIRMED',
    'execution-a',
  );
  const next = {
    ...queued,
    conversation: {
      ...conversation,
      messages: [...conversation.messages, {
        id: 'later-note',
        executionId: 'execution-a',
        turn: 1,
        role: 'assistant' as const,
        text: 'Later work.',
      }],
    },
    pending: {
      ...queued.pending,
      followUp: {
        ...queued.pending.followUp,
        status: 'started' as const,
        executionId: 'execution-b',
      },
    },
  };
  const updated = notices.merge(next, projector.project(next, 'scope').entries);
  strictEqual(updated[3].text, 'UNCONFIRMED · execution.cancel');
  strictEqual(updated[5].text, 'STARTED · Next task.');
  strictEqual(updated.at(-1)?.text, 'Later work.');
});

Deno.test('Increment 159 local system notices survive snapshots and return to their original Session', () => {
  const notices = new RemoteSystemNotices();
  const first = snapshot();
  const user = entry('user-a', 'task');
  notices.merge(first, [user]);
  notices.retain(first.session.id, 'command-one', 'REJECTED · draft kept · busy', 'REJECTED');
  const initial = notices.merge(first, [user]);
  const repeated = notices.merge({ ...first, cursor: { ...first.cursor, revision: 2 } }, [user]);
  strictEqual(systemEntries(repeated).length, 1);
  strictEqual(systemEntries(repeated)[0], systemEntries(initial)[0]);
  deepStrictEqual(notices.merge(snapshot('session-b'), []), []);
  const returned = notices.merge(first, [user, entry('user-b', 'next task')]);
  deepStrictEqual(returned.map((item) => item.id), [
    user.id,
    systemEntries(initial)[0].id,
    'user-b',
  ]);
  notices.retain(first.session.id, 'command-one', 'UNCONFIRMED · draft kept', 'UNCONFIRMED');
  strictEqual(systemEntries(notices.merge(first, [user])).length, 1);
});

Deno.test('Increment 159 derives short failure and updates one queue notice without duplicating steering', () => {
  const notices = new RemoteSystemNotices();
  const first = snapshot();
  const record = {
    queueId: 'queue-one',
    commandId: 'queue-command',
    sessionId: first.session.id,
    afterExecutionId: 'execution-a',
    text: 'next task',
    status: 'queued' as const,
  };
  const running = {
    ...first,
    pending: {
      ...first.pending,
      followUp: record,
      steering: {
        commandId: 'steer-command',
        executionId: 'execution-a',
        text: 'additional instruction',
      },
    },
  };
  const user = entry('user-a', 'task');
  const reserved = notices.merge(running, [user]);
  strictEqual(systemEntries(reserved).length, 2);
  ok(systemEntries(reserved).some((item) => item.text === 'RESERVED · next task'));
  const failed = {
    ...first,
    conversation: {
      ...first.conversation,
      executions: [{
        ...execution('failed'),
        stopReason: 'contract_failure' as const,
        diagnostic: { code: 'http_error', stage: 'http' },
      }],
    },
    runtime: {
      ...first.runtime,
      execution: {
        ...execution('failed'),
        stopReason: 'contract_failure',
        diagnostic: { code: 'http_error', stage: 'http' },
      },
    },
    pending: {
      ...first.pending,
      followUps: [{ ...record, status: 'discarded' as const, reason: 'failed' }],
    },
  };
  const applied = entry('steer-a', 'additional instruction', 'steer>');
  const ended = notices.merge(failed, [user, applied]);
  const notifications = systemEntries(ended);
  strictEqual(notifications.length, 2);
  ok(notifications.some((item) => item.text === 'FAILED · provider request failed'));
  ok(notifications.some((item) => item.text === 'NOT STARTED · next task · failed'));
  deepStrictEqual(notices.merge(failed, [user, applied]), ended);
  const started = {
    ...first,
    pending: {
      ...first.pending,
      followUps: [{ ...record, status: 'started' as const, executionId: 'next-execution' }],
    },
  };
  const updated = notices.merge(started, [user, applied]);
  strictEqual(systemEntries(updated).filter((item) => item.id.includes('queue:')).length, 1);
  ok(systemEntries(updated).some((item) => item.text === 'STARTED · next task'));
  const completed = new RemoteSystemNotices().merge({
    ...first,
    runtime: { ...first.runtime, execution: execution('completed') },
  }, [user]);
  strictEqual(systemEntries(completed).length, 0);
});

Deno.test('Increment 159 normal system text is neutral and failure color stops after its short word', () => {
  const terminal: TerminalPort = {
    stdinIsTerminal: () => true,
    stdoutIsTerminal: () => true,
    consoleSize: () => ({ columns: 100, rows: 24 }),
    setRaw() {},
    read() {
      return Promise.resolve(null);
    },
    async drainAndCloseInput() {},
    write() {},
    writeFrame() {},
    addSignal() {},
    removeSignal() {},
  };
  const renderer = new TuiRenderer(terminal);
  renderer.setConversationEntries([
    freezeUiLogEntry({
      id: 'notice',
      kind: 'system',
      label: 'system>',
      text: 'RESERVED · next task',
      revision: 0,
      live: false,
    }),
    freezeUiLogEntry({
      id: 'failure',
      kind: 'system',
      label: 'system>',
      text: 'FAILED · provider request failed',
      failureWord: 'FAILED',
      revision: 0,
      live: false,
    }),
  ], 0);
  const frame = renderer.renderFrame(100, 24);
  ok(frame.includes('system> RESERVED · next task'));
  ok(frame.includes('\x1b[31msystem> FAILED\x1b[0m · provider request failed'));
  renderer.close();
});

Deno.test('Increment 159 repeated steering text matches only its own execution', () => {
  const notices = new RemoteSystemNotices();
  const previous = entry('old-steer', 'Keep reply short', 'steer>');
  const nextUser = { ...entry('next-user', 'next task'), executionId: 'execution-b', turn: 2 };
  const pending = {
    ...snapshot(),
    pending: {
      ...snapshot().pending,
      steering: { executionId: 'execution-b', commandId: 'new-steer', text: 'Keep reply short' },
    },
  };
  const received = notices.merge(pending, [previous, nextUser]);
  strictEqual(systemEntries(received).length, 1);
  strictEqual(systemEntries(received)[0].executionId, 'execution-b');
  const applied = {
    ...entry('new-steer', 'Keep reply short', 'steer>'),
    executionId: 'execution-b',
    turn: 2,
  };
  strictEqual(systemEntries(notices.merge(pending, [previous, nextUser, applied])).length, 0);
});
