import { strictEqual } from 'node:assert';
import { reduceSessionStreamFrame } from '../../v0/api/reducer.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { conversationPosition, tuiSnapshot } from './tui_entity_fixture.ts';
import type { ConversationEntity } from '../../v0/conversation/model.ts';

const message = (id: string, executionOrder: number): ConversationEntity => ({
  kind: 'message',
  id,
  executionId: `execution-${id}`,
  version: 1,
  position: conversationPosition(executionOrder, 0, 0),
  turn: executionOrder + 1,
  role: 'assistant',
  text: id,
  complete: true,
});

Deno.test('Increment 218 same Session snapshot replacement removes rows outside the new page', () => {
  const projector = new SnapshotConversationProjector();
  const old = tuiSnapshot({ first: message('first', 0), shared: message('shared', 1) }, [
    'first',
    'shared',
  ]);
  const state = reduceSessionStreamFrame(undefined, { kind: 'session.snapshot', snapshot: old });
  const before = projector.project(state, 'core/session');
  strictEqual(before.store.size, 2);
  const next = tuiSnapshot({ shared: message('shared', 1), last: message('last', 2) }, [
    'shared',
    'last',
  ]);
  const replaced = reduceSessionStreamFrame(state, { kind: 'session.snapshot', snapshot: next });
  const after = projector.project(replaced, 'core/session');
  strictEqual(after.reset, false);
  strictEqual(after.store.size, 2);
  strictEqual(after.store.get('conversation:first'), undefined);
  strictEqual(after.store.get('conversation:last')?.text, 'last');
});
