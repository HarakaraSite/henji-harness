import { assert, assertEquals } from './test_helpers.ts';
import { TuiEditor } from '../../v0/tui/input.ts';
import { PendingInputCore } from '../../v0/tui/pending_input.ts';

Deno.test('fixed pending lanes retain kinds and expose only metadata', () => {
  const core = new PendingInputCore();
  assert(core.admitTask('task'));
  assertEquals(core.reserveSteering('steer'), 'reserved');
  assert(core.commitSteeringReservation());
  assert(core.queueFollowUp('follow'));
  const editor = new TuiEditor();
  editor.append('draft');
  const snapshot = core.snapshot(editor.snapshot());
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.lanes));
  assertEquals(snapshot.lanes.length, 7);
  assertEquals(
    snapshot.lanes.slice(0, 4).map((
      lane,
    ) => [lane.kind, lane.lifecycle, lane.present, lane.byteCount]),
    [
      ['editor', 'draft', true, 5],
      ['active_task', 'active_uncommitted', true, 4],
      ['steering', 'admitted_unconsumed', true, 5],
      ['follow_up', 'queued_unsubmitted', true, 6],
    ],
  );
  assert(!JSON.stringify(snapshot).includes('"text"'));
  assert(core.recoverAfterSettlement());
  assertEquals(core.popRecovery(), { kind: 'active_task', text: 'task' });
  assertEquals(core.popRecovery(), { kind: 'steering', text: 'steer' });
  assertEquals(core.popRecovery(), { kind: 'follow_up', text: 'follow' });
  assertEquals(core.popRecovery(), null);
});

Deno.test('fixed lanes refuse same-kind replacement and retain side-effect recovery warning', () => {
  const core = new PendingInputCore();
  assert(core.admitTask('first'));
  assertEquals(core.admitTask('second'), false);
  assert(core.recoverAfterSettlement(1));
  assert(core.hasSideEffectWarning);
  assertEquals(core.admitTask('replacement'), false);
  const recovered = core.popRecovery();
  assertEquals(recovered, { kind: 'active_task', text: 'first' });
  assert(core.admitTask('replacement'));
  assert(core.commitTask());
  core.clearSideEffectWarning();
  assert(!core.hasSideEffectWarning);
  core.clearAll();
  assertEquals(core.snapshot().recoveryCount, 0);
});

Deno.test('steering reservation rolls back and consumed steering cannot recover', () => {
  const core = new PendingInputCore();
  assertEquals(core.reserveSteering('steer'), 'reserved');
  assert(core.rollbackSteeringReservation());
  assertEquals(core.markSteeringConsumed(), false);
  assertEquals(core.reserveSteering('steer'), 'reserved');
  assert(core.commitSteeringReservation());
  assert(core.markSteeringConsumed());
  assertEquals(core.recoverSteering(), false);
});
