import { ok, strictEqual } from 'node:assert';
import type { SessionStreamFrame } from '../../v0/api/contract.ts';
import { decodeSessionSnapshotJson, decodeSessionStreamFrame } from '../../v0/api/codec.ts';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type { WorkerToHostMessage } from '../../v0/agent/worker/worker_protocol.ts';

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

Deno.test('Increment 180 reflects parent completion before follow-up settles', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i180-follow-up-tracking-',
  });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot, { recursive: true });

  const held: Array<() => void> = [];
  const frames: SessionStreamFrame[] = [];
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    core = await createCoreService({
      workspaceRoot,
      stateRoot: `${root}/state`,
      configRoot: `${root}/config`,
      physicalIoMode: 'provider-free',
      initialSession: { kind: 'new' },
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        return {
          send: (command, transfer) => capsule.send(command, transfer),
          subscribe: (listener) =>
            capsule.subscribe((message: WorkerToHostMessage) => {
              if (message.kind === 'turn_settled') {
                held.push(() => listener(message));
                return;
              }
              listener(message);
            }),
          terminate: () => capsule.terminate(),
        };
      },
    });
    const sessionId = core.coreRead().activeSessionId!;
    const readSnapshot = async () =>
      decodeSessionSnapshotJson(
        new TextDecoder().decode((await core!.sessionRead(sessionId)).bytes),
      );
    const subscription = await core.subscribeSession(sessionId, (frame) => {
      if (frame !== undefined) {
        frames.push(
          decodeSessionStreamFrame(JSON.parse(new TextDecoder().decode(frame))),
        );
      }
    });
    unsubscribe = subscription.unsubscribe;

    const submitted = await core.taskSubmit(sessionId, {
      commandId: 'i180-parent-command',
      text: 'parent task',
    });
    strictEqual(submitted.kind, 'accepted', JSON.stringify(submitted));
    if (submitted.kind !== 'accepted') {
      throw new Error('parent task was not accepted');
    }
    const parentExecutionId = submitted.value.executionId;
    const queued = await core.followUpQueue(sessionId, {
      commandId: 'i180-follow-up-command',
      afterExecutionId: parentExecutionId,
      text: 'follow-up task',
    });
    strictEqual(queued.kind, 'accepted', JSON.stringify(queued));
    if (queued.kind !== 'accepted') throw new Error('follow-up was not accepted');

    await waitFor(
      () => held.length >= 1,
      'parent Worker cleanup signal was not held',
    );
    await waitFor(
      async () =>
        (await core!.executionRead(parentExecutionId)).execution.lifecycle ===
          'settled',
      'parent Data settlement was not visible before Worker cleanup',
    );
    strictEqual(
      (await core.executionRead(parentExecutionId)).execution.processSettlement,
      'settling',
    );
    strictEqual(
      (await readSnapshot()).runtime.execution?.processSettlement,
      'settling',
    );

    const frameCountAtParentRelease = frames.length;
    held[0]();
    await waitFor(
      () => held.length >= 2,
      'follow-up Worker cleanup signal was not held',
    );
    const parent = (await core.executionRead(parentExecutionId)).execution;
    strictEqual(parent.processSettlement, 'complete');
    strictEqual(parent.submittedByCommandId, 'i180-parent-command');

    const session = await readSnapshot();
    const childExecutionId = session.pending.activeTask?.executionId;
    ok(childExecutionId);
    strictEqual(
      session.pending.activeTask?.commandId,
      'i180-follow-up-command',
    );
    strictEqual(session.runtime.execution?.processSettlement, 'settling');
    strictEqual(
      (await core.executionRead(childExecutionId)).execution.processSettlement,
      'settling',
    );
    const parentQueue = await core.followUpRead(
      sessionId,
      queued.value.queueId,
    );
    strictEqual(parentQueue.followUp.status, 'started');
    strictEqual(parentQueue.followUp.executionId, childExecutionId);

    const updates = frames.filter((frame) => frame.kind === 'session.update');
    const childPreparing = updates.findIndex((frame) =>
      frame.changes.some((change) =>
        change.kind === 'pending.replace' &&
        change.pending.activeTask?.executionId === childExecutionId
      )
    );
    ok(childPreparing >= 0, 'follow-up reservation is published');
    const idleBetweenParentAndChild = frames.slice(frameCountAtParentRelease)
      .filter((frame) => frame.kind === 'session.update')
      .some((frame) =>
        frame.changes.some((change) =>
          change.kind === 'runtime.replace' && !change.runtime.active &&
          change.runtime.phase === 'idle'
        )
      );
    strictEqual(idleBetweenParentAndChild, false);

    held[1]();
    await waitFor(
      async () =>
        (await core!.executionRead(childExecutionId)).execution
          .processSettlement === 'complete',
      'follow-up did not complete after its Worker cleanup signal',
    );
  } finally {
    for (const release of held) release();
    unsubscribe?.();
    await core?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 180 removes a failed unadmitted reservation from Core tracking', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i180-admission-removal-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let unsubscribe: (() => void) | undefined;
  const frames: SessionStreamFrame[] = [];
  try {
    core = await createCoreService({
      workspaceRoot,
      stateRoot: `${root}/state`,
      configRoot: `${root}/config`,
      physicalIoMode: 'provider-free',
      initialSession: { kind: 'new' },
    });
    const sessionId = core.coreRead().activeSessionId!;
    const subscription = await core.subscribeSession(sessionId, (frame) => {
      if (frame !== undefined) {
        frames.push(
          decodeSessionStreamFrame(JSON.parse(new TextDecoder().decode(frame))),
        );
      }
    });
    unsubscribe = subscription.unsubscribe;

    const failed = await core.taskSubmit(sessionId, {
      commandId: 'i180-admission-fails',
      text: '',
    });
    strictEqual(failed.kind, 'rejected');
    if (failed.kind !== 'rejected') throw new Error('blank task admission must fail');
    strictEqual(failed.reason, 'admissionFailed');

    const failedReservationId = frames.flatMap((frame) =>
      frame.kind === 'session.update'
        ? frame.changes.flatMap((change) =>
          change.kind === 'runtime.replace' &&
            change.runtime.reservation !== undefined
            ? [change.runtime.reservation.executionId]
            : []
        )
        : []
    ).at(-1);
    ok(failedReservationId, 'preparing reservation was visible before admission failed');
    const staleFollowUp = await core.followUpQueue(sessionId, {
      commandId: 'i180-failed-reservation-follow-up',
      afterExecutionId: failedReservationId,
      text: 'failed reservation must be absent',
    });
    strictEqual(staleFollowUp.kind, 'rejected');
    if (staleFollowUp.kind === 'rejected') {
      strictEqual(staleFollowUp.reason, 'notFound');
    }
  } finally {
    unsubscribe?.();
    await core?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 180 uses Data ownership lookup for an execution from a reopened Session', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i180-owner-reopen-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  try {
    core = await createCoreService({
      workspaceRoot,
      stateRoot: `${root}/state`,
      configRoot: `${root}/config`,
      physicalIoMode: 'provider-free',
      initialSession: { kind: 'new' },
    });
    const sessionA = core.coreRead().activeSessionId!;
    const submitted = await core.taskSubmit(sessionA, {
      commandId: 'i180-owner-task',
      text: 'owner lookup task',
    });
    strictEqual(submitted.kind, 'accepted', JSON.stringify(submitted));
    if (submitted.kind !== 'accepted') throw new Error('task was not accepted');
    const executionId = submitted.value.executionId;
    await waitFor(
      async () =>
        (await core!.executionRead(executionId)).execution.processSettlement ===
          'complete',
      'owner lookup execution did not complete',
    );

    const createdB = await core.sessionOpen({
      commandId: 'i180-open-b',
      selection: { kind: 'new' },
    });
    strictEqual(createdB.kind, 'accepted', JSON.stringify(createdB));
    if (createdB.kind !== 'accepted') {
      throw new Error('Session B was not opened');
    }
    const sessionB = createdB.value.sessionId;
    const submittedB = await core.taskSubmit(sessionB, {
      commandId: 'i180-owner-task-b',
      text: 'persist Session B before reopening it',
    });
    strictEqual(submittedB.kind, 'accepted', JSON.stringify(submittedB));
    if (submittedB.kind !== 'accepted') throw new Error('Session B task was not accepted');
    await waitFor(
      async () =>
        (await core!.executionRead(submittedB.value.executionId)).execution.processSettlement ===
          'complete',
      'Session B task did not complete',
    );

    const reopenedA = await core.sessionOpen({
      commandId: 'i180-reopen-a',
      selection: { kind: 'exact', sessionId: sessionA },
    });
    strictEqual(reopenedA.kind, 'accepted', JSON.stringify(reopenedA));
    const returnedToB = await core.sessionOpen({
      commandId: 'i180-return-b',
      selection: { kind: 'exact', sessionId: sessionB },
    });
    strictEqual(returnedToB.kind, 'accepted', JSON.stringify(returnedToB));

    const deleted = await core.sessionDelete(sessionA, {
      commandId: 'i180-delete-a',
    });
    strictEqual(deleted.kind, 'accepted', JSON.stringify(deleted));
    const steering = await core.steeringSubmit(sessionA, executionId, {
      commandId: 'i180-stale-steering',
      text: 'must use the existing Data lookup',
    });
    strictEqual(steering.kind, 'rejected');
    if (steering.kind === 'rejected') strictEqual(steering.reason, 'notFound');
    const followUp = await core.followUpQueue(sessionA, {
      commandId: 'i180-stale-follow-up',
      afterExecutionId: executionId,
      text: 'must use the existing Data lookup',
    });
    strictEqual(followUp.kind, 'rejected');
    if (followUp.kind === 'rejected') strictEqual(followUp.reason, 'notFound');
  } finally {
    await core?.close();
    await Deno.remove(root, { recursive: true });
  }
});
