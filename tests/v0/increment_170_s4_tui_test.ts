import { equal, strictEqual } from 'node:assert/strict';
import type { ConversationEntity } from '../../v0/conversation/model.ts';
import { EntryLayoutCache } from '../../v0/tui/entry_layout_cache.ts';
import { plainTextAssistantRenderer } from '../../v0/tui/conversation_renderer.ts';
import { cancelTargetExecutionId, presentationLifecycle } from '../../v0/tui/remote_session.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { TuiRenderer } from '../../v0/tui/tui_renderer.ts';
import type { ScreenFrame, TerminalPort } from '../../v0/tui/terminal.ts';
import { conversationPosition, tuiClientState, tuiSnapshot } from './tui_entity_fixture.ts';

const assistantEntity = (
  text: string,
  version: number,
): ConversationEntity => ({
  kind: 'message',
  id: 'answer',
  executionId: 'execution-a',
  turn: 1,
  version,
  position: conversationPosition(0, 1, 1),
  role: 'assistant',
  text,
  complete: false,
});

Deno.test('Increment 170 S4 applies each body revision synchronously and coalesces only the draw', () => {
  const initialEntities: Record<string, ConversationEntity> = {
    task: {
      kind: 'message',
      id: 'task',
      executionId: 'execution-a',
      turn: 1,
      version: 0,
      position: conversationPosition(0, -1, -1),
      role: 'user',
      text: 'Question',
      complete: true,
    },
    answer: assistantEntity('first', 0),
  };
  const projector = new SnapshotConversationProjector();
  const first = projector.project(
    tuiClientState(tuiSnapshot(initialEntities, ['task', 'answer'])),
    'core/session-a',
  );
  const frames: ScreenFrame[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let scheduled = 0;
  const terminal: TerminalPort = {
    stdinIsTerminal: () => true,
    stdoutIsTerminal: () => true,
    consoleSize: () => ({ columns: 90, rows: 28 }),
    setRaw() {},
    read: () => Promise.resolve(null),
    async drainAndCloseInput() {},
    write() {},
    writeFrame: (frame) => frames.push(frame),
    addSignal() {},
    removeSignal() {},
  };
  const renderer = new TuiRenderer(terminal, {
    setTimeout: (callback) => {
      const id = ++timerId;
      scheduled += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
  });
  renderer.setKeyedConversationStore(first.store, true, true);
  renderer.setEditorSnapshot({ text: 'draft', cursorScalar: 5, byteLength: 5 });
  renderer.renderReadOnlyHelp(['help']);

  const next = (text: string, version: number) => {
    const snapshot = tuiSnapshot({ ...initialEntities, answer: assistantEntity(text, version) }, [
      'task',
      'answer',
    ], {
      cursor: { coreEpoch: 'tui-core', sessionId: 'tui-entity-session', revision: version + 1 },
      conversation: {
        schemaVersion: 2,
        sessionId: 'tui-entity-session',
        cut: version + 1,
        storeRevision: version + 1,
        entities: { ...initialEntities, answer: assistantEntity(text, version) },
        order: ['task', 'answer'],
      },
    });
    return projector.project(
      tuiClientState(snapshot, new Set(['answer']), false),
      'core/session-a',
    );
  };

  const second = next('second', 1);
  renderer.setKeyedConversationStore(second.store, false, false);
  strictEqual(
    renderer.stateSnapshot().keyedConversation?.get('conversation:answer')?.text,
    'second',
  );
  const third = next('third', 2);
  renderer.setKeyedConversationStore(third.store, false, false);
  strictEqual(
    renderer.stateSnapshot().keyedConversation?.get('conversation:answer')?.text,
    'third',
  );
  equal(scheduled, 1);
  equal(frames.length, 0);
  strictEqual(renderer.stateSnapshot().scroll.kind, 'followLatest');
  equal(renderer.stateSnapshot().editor.text, 'draft');
  equal(renderer.stateSnapshot().overlay.kind, 'readOnlyHelp');

  renderer.flushRender();
  equal(frames.length, 1);
  equal(timers.size, 0);
  renderer.close();
});

Deno.test('Increment 170 S4 body changes invalidate only their row layout cache', () => {
  const projector = new SnapshotConversationProjector();
  const first = projector.project(
    tuiClientState(tuiSnapshot({
      first: assistantEntity('first answer', 0),
      second: { ...assistantEntity('second answer', 0), id: 'second' },
    }, ['first', 'second'])),
    'core/cache',
  );
  const cache = new EntryLayoutCache();
  let builds = 0;
  const build = () => {
    builds += 1;
    return { rows: [], sourceBytes: 0 };
  };
  const one = first.store.get('conversation:first')!;
  const two = first.store.get('conversation:second')!;
  cache.get(one, 80, plainTextAssistantRenderer, true, build);
  cache.get(two, 80, plainTextAssistantRenderer, true, build);
  const updated = projector.project(
    tuiClientState(
      tuiSnapshot(
        {
          first: { ...assistantEntity('updated answer', 1), id: 'first' },
          second: { ...assistantEntity('second answer', 0), id: 'second' },
        },
        ['first', 'second'],
        {
          cursor: { coreEpoch: 'tui-core', sessionId: 'tui-entity-session', revision: 2 },
          conversation: {
            schemaVersion: 2,
            sessionId: 'tui-entity-session',
            cut: 2,
            storeRevision: 2,
            entities: {
              first: { ...assistantEntity('updated answer', 1), id: 'first' },
              second: { ...assistantEntity('second answer', 0), id: 'second' },
            },
            order: ['first', 'second'],
          },
        },
      ),
      new Set(['first']),
      false,
    ),
    'core/cache',
  );
  cache.get(updated.store.get('conversation:first')!, 80, plainTextAssistantRenderer, true, build);
  cache.get(updated.store.get('conversation:second')!, 80, plainTextAssistantRenderer, true, build);
  equal(builds, 3);
});

Deno.test('Increment 170 S4 reserves cancellation identity through a late admission receipt', () => {
  const preparing = tuiSnapshot({}, [], {
    runtime: {
      active: true,
      activeSessionId: 'tui-entity-session',
      phase: 'preparing',
      execution: null,
      reservation: {
        executionId: 'reserved-execution',
        commandId: 'task-command',
        phase: 'preparing',
      },
      operations: ['task.submit', 'execution.cancel'],
    },
    pending: {
      kind: 'core-owned',
      activeTask: {
        executionId: 'reserved-execution',
        commandId: 'task-command',
        text: 'Answer this',
      },
      followUps: [],
    },
  });
  equal(cancelTargetExecutionId(preparing), 'reserved-execution');
  equal(presentationLifecycle(preparing, 'reserved-execution'), 'cancelling');

  const lateReceipt = {
    ...preparing,
    runtime: {
      ...preparing.runtime,
      execution: {
        executionId: 'reserved-execution',
        sessionId: 'tui-entity-session',
        task: 'Answer this',
        turn: 1,
        createdAt: '2026-09-29T00:00:00Z',
        submittedByCommandId: 'task-command',
        lifecycle: 'active' as const,
        outcome: 'unknown' as const,
        adoption: 'canonical' as const,
        processSettlement: 'running' as const,
        requestCount: 0,
        durability: {
          acknowledgement: 'not_sent',
          generationAvailability: 'available',
          diagnosticCapture: 'none',
          artifactCapture: 'none',
          contextCapture: 'none' as const,
        },
      },
      reservation: undefined,
    },
  };
  equal(cancelTargetExecutionId(lateReceipt), 'reserved-execution');
  equal(presentationLifecycle(lateReceipt, 'reserved-execution'), 'cancelling');
  const settled = {
    ...lateReceipt,
    runtime: {
      ...lateReceipt.runtime,
      active: false,
      phase: 'idle' as const,
    },
  };
  equal(cancelTargetExecutionId(settled), undefined);
  equal(presentationLifecycle(settled), 'idle');
});
