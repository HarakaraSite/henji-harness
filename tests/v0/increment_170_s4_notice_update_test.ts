import { deepEqual, equal, strictEqual } from 'node:assert/strict';
import type { ConversationEntity } from '../../v0/conversation/model.ts';
import { KeyedConversationStore } from '../../v0/tui/keyed_conversation_store.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { RemoteSystemNotices } from '../../v0/tui/system_notices.ts';
import { freezeUiLogEntry } from '../../v0/tui/state.ts';
import {
  conversationPosition,
  taskEntity,
  tuiClientState,
  tuiSnapshot,
} from './tui_entity_fixture.ts';

const sessionId = 'tui-entity-session';

Deno.test('Increment 170 notice body updates keep keyed order identity and only replace the notice row', () => {
  const projector = new SnapshotConversationProjector();
  const notices = new RemoteSystemNotices();
  const task = taskEntity('execution-a', 'Inspect the source.', 1, 0);
  const initial = tuiSnapshot({ task }, [task.id]);
  const projected = projector.project(tuiClientState(initial), 'core/session-a');
  notices.sync(tuiClientState(initial), projected.store, {
    reset: projected.reset,
    structureChanged: projected.structureChanged,
  });

  notices.retain(sessionId, 'local-receipt', 'REJECTED · first reason', 'REJECTED');
  const inserted = notices.refresh(sessionId, projected.store);
  equal(inserted.structureChanged, true);
  const order = projected.store.ids();
  const semanticOrder = projected.store.semanticIds();
  const taskRow = projected.store.get(`conversation:${task.id}`);
  const noticeId = `system:${sessionId}:local-receipt`;

  notices.retain(sessionId, 'local-receipt', 'REJECTED · updated reason', 'REJECTED');
  const updated = notices.refresh(sessionId, projected.store);
  deepEqual([...updated.changedIds], [noticeId]);
  equal(updated.structureChanged, false);
  equal(updated.previousIds, undefined);
  strictEqual(projected.store.ids(), order);
  strictEqual(projected.store.semanticIds(), semanticOrder);
  strictEqual(projected.store.get(`conversation:${task.id}`), taskRow);
  equal(projected.store.get(noticeId)?.text, 'REJECTED · updated reason');
});

Deno.test('Increment 170 keyed notice reanchor splices before its target and updates suffix indices', () => {
  const store = new KeyedConversationStore();
  const semanticIds = ['first', 'middle', 'last'];
  for (const id of semanticIds) {
    store.set(
      id,
      freezeUiLogEntry({
        id,
        kind: 'assistant',
        label: 'assistant>',
        text: id,
        revision: 0,
        live: false,
      }),
    );
  }
  store.replaceSemanticOrder(semanticIds);
  const noticeId = 'system:receipt';
  const firstEntry = freezeUiLogEntry({
    id: noticeId,
    kind: 'system',
    label: 'system>',
    text: 'first',
    revision: 0,
    live: false,
  });
  store.upsertNotice({ entry: firstEntry, anchor: 'last' });
  const beforeReanchor = [...store.ids()];

  const movedEntry = freezeUiLogEntry({ ...firstEntry, text: 'moved' });
  const moved = store.upsertNotice({ entry: movedEntry, anchor: 'first' });
  equal(moved.structureChanged, true);
  deepEqual(moved.previousIds, beforeReanchor);
  deepEqual(store.ids(), ['first', noticeId, 'middle', 'last']);
  equal(store.indexOf(noticeId), 1);
  equal(store.indexOf('middle'), 2);
  equal(store.indexOf('last'), 3);

  const stableOrder = store.ids();
  const beforeRemoval = [...stableOrder];
  const bodyOnly = store.upsertNotice({
    entry: freezeUiLogEntry({ ...movedEntry, text: 'body only' }),
    anchor: 'first',
  });
  equal(bodyOnly.structureChanged, false);
  equal(bodyOnly.previousIds, undefined);
  strictEqual(store.ids(), stableOrder);
  equal(store.get(noticeId)?.text, 'body only');

  const removed = store.removeNotice(noticeId);
  equal(removed.structureChanged, true);
  deepEqual(removed.previousIds, beforeRemoval);
  deepEqual(store.ids(), semanticIds);
});

Deno.test('Increment 170 pending steering lookup uses the session dirty-entity index', () => {
  const executionId = 'execution-steering';
  const task = taskEntity(executionId, 'Work on this.', 1, 0);
  const steering: ConversationEntity = {
    kind: 'message',
    id: 'applied-steering',
    executionId,
    turn: 1,
    version: 0,
    position: conversationPosition(0, 1, 0),
    role: 'user',
    text: 'Keep the summary concise.',
    complete: true,
  };
  const pendingSteering = {
    executionId,
    commandId: 'steering-command',
    text: steering.text,
  };
  const initial = tuiSnapshot(
    { [task.id]: task, [steering.id]: steering },
    [task.id, steering.id],
    {
      pending: {
        kind: 'core-owned',
        followUps: [],
        steering: pendingSteering,
      },
    },
  );
  const projector = new SnapshotConversationProjector();
  const notices = new RemoteSystemNotices();
  const initialClient = tuiClientState(initial);
  const first = projector.project(initialClient, 'core/session-steering');
  notices.sync(initialClient, first.store, {
    reset: first.reset,
    structureChanged: first.structureChanged,
  });
  equal(first.store.window(0, first.store.size).some((entry) => entry.kind === 'system'), false);

  const order = new Proxy([...initial.conversation.order], {
    get(target, property, receiver) {
      if (property === 'some') {
        throw new Error('pending update scanned the full conversation order');
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const next = {
    ...initial,
    cursor: { ...initial.cursor, revision: 2 },
    pending: {
      ...initial.pending,
      followUps: [{
        queueId: 'queue-next',
        commandId: 'queue-command',
        sessionId,
        afterExecutionId: executionId,
        text: 'Then continue.',
        status: 'queued' as const,
      }],
    },
    conversation: { ...initial.conversation, order },
  };
  const nextClient = tuiClientState(next, new Set(), false);
  const nextProjection = projector.project(nextClient, 'core/session-steering');
  const update = notices.sync(nextClient, nextProjection.store);
  equal(update.changedIds.size, 1);
  equal(update.structureChanged, true);
  equal(
    nextProjection.store.window(0, nextProjection.store.size).filter((entry) =>
      entry.kind === 'system'
    )
      .length,
    1,
  );
});
