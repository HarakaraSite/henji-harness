import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { LoopOutcome } from '../../v0/agent/core/contracts.ts';
import type { ExecutionTrackingChange } from '../../v0/agent/host/application_port.ts';
import { ApplicationTaskService } from '../../v0/agent/host/task_service.ts';
import type { HostActiveSession } from '../../v0/agent/worker/worker_tui_session.ts';

type HostAdmission = Awaited<ReturnType<HostActiveSession['admit']>>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

type AdmissionCall = {
  text: string;
  executionId: string;
  receipt: Deferred<HostAdmission>;
};

class ControlledHost {
  readonly sessionId = 'session-i170-s3';
  readonly calls: AdmissionCall[] = [];
  cancelCalls = 0;
  steerCalls = 0;
  private readonly callWaiters = new Map<number, Deferred<AdmissionCall>>();

  admit(
    text: string,
    executionId?: string,
  ): Promise<HostAdmission> {
    if (executionId === undefined) {
      throw new Error('reserved execution id is required');
    }
    const call = { text, executionId, receipt: deferred<HostAdmission>() };
    const index = this.calls.push(call) - 1;
    this.callWaiters.get(index)?.resolve(call);
    return call.receipt.promise;
  }

  waitForCall(index: number): Promise<AdmissionCall> {
    const present = this.calls[index];
    if (present !== undefined) return Promise.resolve(present);
    const waiter = deferred<AdmissionCall>();
    this.callWaiters.set(index, waiter);
    return waiter.promise;
  }

  cancelActiveTurn(): 'requested' {
    this.cancelCalls++;
    return 'requested';
  }

  steerActiveTurn(): 'accepted' {
    this.steerCalls++;
    return 'accepted';
  }
}

const persistedFollowUps = new WeakMap<
  ApplicationTaskService,
  Map<string, import('../../v0/api/contract.ts').FollowUpRecord>
>();
const makeTasks = (
  host: ControlledHost,
  notifications: ExecutionTrackingChange[][],
): ApplicationTaskService => {
  const records = new Map<string, import('../../v0/api/contract.ts').FollowUpRecord>();
  const tasks = new ApplicationTaskService(
    () => host as unknown as HostActiveSession,
    (changes = []) => notifications.push([...changes]),
    undefined,
    (record) => {
      records.set(record.queueId, structuredClone(record));
      return Promise.resolve();
    },
  );
  persistedFollowUps.set(tasks, records);
  return tasks;
};
const savedFollowUps = (
  tasks: ApplicationTaskService,
) => [...persistedFollowUps.get(tasks)!.values()];

const upsertFor = (
  notifications: readonly (readonly ExecutionTrackingChange[])[],
  executionId: string,
): Extract<ExecutionTrackingChange, { kind: 'upsert' }> | undefined => {
  for (const changes of [...notifications].reverse()) {
    const change = changes.find((item) =>
      item.kind === 'upsert' && item.executionId === executionId
    );
    if (change?.kind === 'upsert') return change;
  }
  return undefined;
};

const outcome = (task: string): LoopOutcome => ({
  ok: true,
  task,
  outcome: 'final',
  stopReason: 'final',
  finalText: 'done',
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

Deno.test('Increment 170 S3 publishes task reservation before admission receipt', async () => {
  const host = new ControlledHost();
  const notifications: ExecutionTrackingChange[][] = [];
  const tasks = makeTasks(host, notifications);
  const submitted = tasks.admit('first task', 'command-first');
  const call = host.calls[0];
  ok(call);

  const reservation = tasks.pendingView(host.sessionId).activeTask;
  ok(reservation);
  strictEqual(reservation.commandId, 'command-first');
  strictEqual(reservation.text, 'first task');
  strictEqual(reservation.executionId, call.executionId);
  strictEqual(tasks.activeExecutionId(), reservation.executionId);
  strictEqual(tasks.isPreparing(), true);
  strictEqual(tasks.canSteer(), false);
  strictEqual(tasks.canQueueFollowUp(), false);
  strictEqual(
    (await tasks.steer(
      reservation.executionId,
      'steer before receipt',
      'command-steer',
    )).kind,
    'rejected',
  );
  deepStrictEqual(
    await tasks.queueFollowUp(
      reservation.executionId,
      'follow up before receipt',
      'command-follow-up',
    ),
    { kind: 'rejected', reason: 'idle' },
  );
  strictEqual(host.steerCalls, 0);
  strictEqual(tasks.pendingView(host.sessionId).followUp, undefined);
  strictEqual(
    upsertFor(notifications, reservation.executionId)?.processSettlement,
    'running',
  );

  const completion = deferred<LoopOutcome>();
  call.receipt.resolve({
    executionId: reservation.executionId,
    completion: completion.promise,
  });
  const admission = await submitted;
  strictEqual(admission.executionId, reservation.executionId);
  strictEqual(tasks.isPreparing(), false);
  completion.resolve(outcome('first task'));
  await admission.untilIdle;
});

Deno.test('Increment 170 S3 cancellation during preparation survives a late admission receipt', async () => {
  const host = new ControlledHost();
  const notifications: ExecutionTrackingChange[][] = [];
  const tasks = makeTasks(host, notifications);
  const submitted = tasks.admit('cancel while preparing', 'command-cancel');
  const call = host.calls[0];
  ok(call);
  const executionId = tasks.activeExecutionId();
  ok(executionId);

  strictEqual(tasks.cancel(executionId), 'requested');
  strictEqual(host.cancelCalls, 1);
  strictEqual(tasks.canSteer(), false);
  strictEqual(tasks.canQueueFollowUp(), false);

  const completion = deferred<LoopOutcome>();
  call.receipt.resolve({ executionId, completion: completion.promise });
  const admission = await submitted;
  strictEqual(admission.executionId, executionId);
  strictEqual(
    tasks.pendingView(host.sessionId).activeTask?.executionId,
    executionId,
  );
  strictEqual(
    upsertFor(notifications, executionId)?.processSettlement,
    'running',
  );
  strictEqual(
    (await tasks.steer(executionId, 'steer after cancel', 'command-steer'))
      .kind,
    'rejected',
  );
  strictEqual(host.steerCalls, 0);
  deepStrictEqual(
    await tasks.queueFollowUp(
      executionId,
      'follow up after cancel',
      'command-follow-up',
    ),
    { kind: 'rejected', reason: 'idle' },
  );
  strictEqual(tasks.pendingView(host.sessionId).followUp, undefined);

  completion.resolve({
    ok: false,
    task: 'cancel while preparing',
    outcome: 'cancelled',
    stopReason: 'cancelled',
    steps: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    transcript: [],
  });
  await admission.untilIdle;
  strictEqual(
    upsertFor(notifications, executionId)?.processSettlement,
    'complete',
  );
});

Deno.test('Increment 170 S3 failed admission removes its reservation without an execution state', async () => {
  const host = new ControlledHost();
  const notifications: ExecutionTrackingChange[][] = [];
  const tasks = makeTasks(host, notifications);
  const submitted = tasks.admit('admission fails', 'command-failure');
  const call = host.calls[0];
  ok(call);
  const executionId = tasks.activeExecutionId();
  ok(executionId);
  strictEqual(
    tasks.pendingView(host.sessionId).activeTask?.executionId,
    executionId,
  );

  call.receipt.reject(new Error('admission failed'));
  let rejected = false;
  try {
    await submitted;
  } catch {
    rejected = true;
  }
  strictEqual(rejected, true);
  strictEqual(tasks.pendingView(host.sessionId).activeTask, undefined);
  strictEqual(tasks.isPreparing(), false);
  deepStrictEqual(notifications.at(-1), [{ kind: 'remove', executionId }]);
});

Deno.test('Increment 170 S3 queued handoff publishes its child reservation before admission', async () => {
  const host = new ControlledHost();
  const notifications: ExecutionTrackingChange[][] = [];
  const tasks = makeTasks(host, notifications);
  const parentSubmission = tasks.admit('parent task', 'command-parent');
  const parentCall = host.calls[0];
  ok(parentCall);
  const parentId = tasks.activeExecutionId();
  ok(parentId);
  const parentCompletion = deferred<LoopOutcome>();
  parentCall.receipt.resolve({
    executionId: parentId,
    completion: parentCompletion.promise,
  });
  const parentAdmission = await parentSubmission;

  strictEqual(
    (await tasks.queueFollowUp(parentId, 'queued child', 'command-child')).kind,
    'accepted',
  );
  parentCompletion.resolve(outcome('parent task'));

  const childCall = await host.waitForCall(1);
  const childReservation = tasks.pendingView(host.sessionId).activeTask;
  ok(childReservation);
  strictEqual(childReservation.commandId, 'command-child');
  strictEqual(childReservation.text, 'queued child');
  strictEqual(childReservation.executionId, childCall.executionId);
  strictEqual(tasks.activeExecutionId(), childReservation.executionId);
  strictEqual(tasks.isPreparing(), true);
  strictEqual(tasks.canSteer(), false);
  strictEqual(tasks.canQueueFollowUp(), false);
  strictEqual(
    upsertFor(notifications, childReservation.executionId)?.processSettlement,
    'running',
  );
  const parentCompleteIndex = notifications.findIndex((changes) =>
    changes.some((change) =>
      change.kind === 'upsert' && change.executionId === parentId &&
      change.processSettlement === 'complete'
    )
  );
  const parentRemoveIndex = notifications.findIndex((changes) =>
    changes.some((change) => change.kind === 'remove' && change.executionId === parentId)
  );
  const childStartIndex = notifications.findIndex((changes) =>
    changes.some((change) =>
      change.kind === 'upsert' && change.executionId === childReservation.executionId
    )
  );
  ok(
    parentCompleteIndex >= 0 && parentCompleteIndex < parentRemoveIndex &&
      parentRemoveIndex < childStartIndex,
    'durable parent completion is published and released before the child reservation',
  );

  const childCompletion = deferred<LoopOutcome>();
  childCall.receipt.resolve({
    executionId: childReservation.executionId,
    completion: childCompletion.promise,
  });
  await Promise.resolve();
  childCompletion.resolve(outcome('queued child'));
  strictEqual((await parentAdmission.untilIdle).stopReason, 'final');
  strictEqual(tasks.pendingView(host.sessionId).activeTask, undefined);
  strictEqual(
    savedFollowUps(tasks)[0]?.status,
    'started',
  );
});

Deno.test('Increment 170 S3 canceled queued admission is discarded without an execution row', async () => {
  const host = new ControlledHost();
  const notifications: ExecutionTrackingChange[][] = [];
  const tasks = makeTasks(host, notifications);
  const parentSubmission = tasks.admit('parent task', 'command-parent');
  const parentCall = host.calls[0];
  ok(parentCall);
  const parentId = tasks.activeExecutionId();
  ok(parentId);
  const parentCompletion = deferred<LoopOutcome>();
  parentCall.receipt.resolve({
    executionId: parentId,
    completion: parentCompletion.promise,
  });
  const parentAdmission = await parentSubmission;

  strictEqual(
    (await tasks.queueFollowUp(parentId, 'queued child', 'command-child')).kind,
    'accepted',
  );
  parentCompletion.resolve(outcome('parent task'));

  const childCall = await host.waitForCall(1);
  const childId = tasks.activeExecutionId();
  ok(childId);
  strictEqual(childId, childCall.executionId);
  strictEqual(tasks.cancel(childId), 'requested');
  childCall.receipt.reject(new Error('admission canceled'));

  strictEqual((await parentAdmission.untilIdle).stopReason, 'final');
  strictEqual(tasks.pendingView(host.sessionId).activeTask, undefined);
  ok(
    notifications.some((changes) =>
      changes.some((change) => change.kind === 'remove' && change.executionId === childId)
    ),
  );
  strictEqual(
    savedFollowUps(tasks)[0]?.status,
    'discarded',
  );
  strictEqual(
    savedFollowUps(tasks)[0]?.reason,
    'cancelled',
  );
});

Deno.test('Increment 170 S3 canceled queued admission retains a late successful execution id', async () => {
  const host = new ControlledHost();
  const notifications: ExecutionTrackingChange[][] = [];
  const tasks = makeTasks(host, notifications);
  const parentSubmission = tasks.admit('parent task', 'command-parent');
  const parentCall = host.calls[0];
  ok(parentCall);
  const parentId = tasks.activeExecutionId();
  ok(parentId);
  const parentCompletion = deferred<LoopOutcome>();
  parentCall.receipt.resolve({
    executionId: parentId,
    completion: parentCompletion.promise,
  });
  const parentAdmission = await parentSubmission;

  const queued = await tasks.queueFollowUp(parentId, 'queued child', 'command-child');
  strictEqual(queued.kind, 'accepted');
  if (queued.kind !== 'accepted') throw new Error('follow-up was not queued');
  parentCompletion.resolve(outcome('parent task'));

  const childCall = await host.waitForCall(1);
  const childId = tasks.activeExecutionId();
  ok(childId);
  strictEqual(childId, childCall.executionId);
  strictEqual(tasks.cancel(childId), 'requested');

  const childCompletion = deferred<LoopOutcome>();
  childCall.receipt.resolve({
    executionId: childId,
    completion: childCompletion.promise,
  });
  await Promise.resolve();

  await tasks.flushFollowUps();
  const followUp = persistedFollowUps.get(tasks)!.get(queued.queueId);
  ok(followUp);
  strictEqual(followUp.status, 'discarded');
  strictEqual(followUp.reason, 'cancelled');
  strictEqual(followUp.executionId, childId);
  strictEqual(upsertFor(notifications, childId)?.processSettlement, 'running');

  childCompletion.resolve({
    ok: false,
    task: 'queued child',
    outcome: 'cancelled',
    stopReason: 'cancelled',
    steps: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    transcript: [],
  });
  await parentAdmission.untilIdle;
});

Deno.test('Increment 218 queued save acknowledgement keeps the handoff slot reserved', async () => {
  const host = new ControlledHost();
  const save = deferred<void>();
  const completion = deferred<LoopOutcome>();
  const tasks = new ApplicationTaskService(
    () => host as unknown as HostActiveSession,
    () => {},
    undefined,
    (record) => record.status === 'queued' ? save.promise : Promise.resolve(),
  );
  const submitted = tasks.admit('parent', 'parent-command');
  const parent = host.calls[0];
  parent.receipt.resolve({ executionId: parent.executionId, completion: completion.promise });
  const admitted = await submitted;
  const queued = tasks.queueFollowUp(parent.executionId, 'reserved next', 'queue-command');
  completion.resolve(outcome('parent'));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  strictEqual(tasks.isBusy(), true);
  let rejected = false;
  try {
    await tasks.admit('manual interloper', 'manual-command');
  } catch {
    rejected = true;
  }
  strictEqual(rejected, true);
  strictEqual(host.calls.length, 1);
  save.resolve();
  strictEqual((await queued).kind, 'accepted');
  const next = await host.waitForCall(1);
  strictEqual(next.text, 'reserved next');
  next.receipt.resolve({
    executionId: next.executionId,
    completion: Promise.resolve(outcome('reserved next')),
  });
  await admitted.untilIdle;
  strictEqual(tasks.isBusy(), false);
});
