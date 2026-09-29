import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { ExecutionView, SessionSnapshot } from '../../v0/api/contract.ts';
import { RemoteSystemNotices } from '../../v0/tui/system_notices.ts';
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
  conversation: { messages: [], tools: [], thinking: [], requests: [], omitted: 0 },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'present' },
  context: {},
});
const systemEntries = (entries: readonly UiLogEntry[]) =>
  entries.filter((item) => item.kind === 'system');

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
