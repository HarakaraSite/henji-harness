import type { LoopOutcome } from '../core/contracts.ts';
import type { HostActiveSession } from '../worker/worker_tui_session.ts';
import type { ApplicationObservation, ExecutionTrackingChange } from './application_port.ts';
import type { FollowUpRecord, PendingView } from '../../api/contract.ts';

type Completion = Promise<Omit<LoopOutcome, 'transcript'>>;
interface TaskAdmission {
  readonly executionId: string;
  readonly completion: Completion;
  readonly untilIdle: Completion;
}
interface TaskExecutionState {
  readonly executionId: string;
  readonly sessionId: string;
  readonly submittedByCommandId: string;
  processSettlement: 'running' | 'complete';
}
type Lane = {
  executionId: string;
  commandId: string;
  text: string;
  sessionId: string;
};
type MutableFollowUp = {
  -readonly [K in keyof FollowUpRecord]: FollowUpRecord[K];
};
type SteeringAcceptance =
  | { kind: 'accepted' }
  | { kind: 'rejected'; reason: 'idle' | 'alreadyAccepted' | 'invalid' };
type FollowUpAcceptance =
  | { kind: 'accepted'; queueId: string }
  | { kind: 'rejected'; reason: 'idle' | 'alreadyAccepted' };

/** Owns accepted fixed lanes; Host coordinator remains the sole execution/cleanup owner. */
export class ApplicationTaskService {
  private active: Lane | undefined;
  private preparing = false;
  private handoffPending = false;
  private closing = false;
  private steering: Lane | undefined;
  private steeringAccepted = false;
  private steeringApplied = false;
  private cancellationRequested = false;
  private queued: MutableFollowUp | undefined;
  private chain: Completion | undefined;
  private followUpWrites: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, MutableFollowUp>();

  constructor(
    private readonly currentSession: () => HostActiveSession,
    private readonly publish: (
      executionChanges?: readonly ExecutionTrackingChange[],
    ) => void,
    private readonly persistCompletion: (
      execution: TaskExecutionState,
    ) => Promise<void> = () => Promise.resolve(),
    private readonly persistFollowUp: (
      record: FollowUpRecord,
    ) => Promise<void> = () => Promise.resolve(),
  ) {}

  isBusy(): boolean {
    return this.preparing || this.handoffPending || this.active !== undefined;
  }
  isPreparing(): boolean {
    return this.preparing;
  }
  canSteer(): boolean {
    return this.active !== undefined && !this.preparing &&
      !this.steeringAccepted &&
      !this.cancellationRequested;
  }
  canQueueFollowUp(): boolean {
    return this.active !== undefined && !this.preparing &&
      this.queued === undefined &&
      !this.cancellationRequested;
  }
  activeExecutionId(): string | undefined {
    return this.active?.executionId;
  }
  pendingView(sessionId = this.currentSession().sessionId): PendingView {
    const active = this.active?.sessionId === sessionId ? this.active : undefined;
    const steering = this.steering?.sessionId === sessionId ? this.steering : undefined;
    const queued = this.queued?.sessionId === sessionId
      ? this.records.get(this.queued.queueId)
      : undefined;
    return {
      kind: 'core-owned',
      ...(active === undefined ? {} : {
        activeTask: {
          executionId: active.executionId,
          commandId: active.commandId,
          text: active.text,
        },
      }),
      ...(steering === undefined ? {} : {
        steering: {
          executionId: steering.executionId,
          commandId: steering.commandId,
          text: steering.text,
        },
      }),
      ...(queued === undefined ? {} : { followUp: structuredClone(queued) }),
      followUps: [...this.records.values()]
        .filter((record) => record.sessionId === sessionId && record.status !== 'queued')
        .map((record) => structuredClone(record)),
    };
  }

  async admit(
    text: string,
    commandId: string,
  ): Promise<TaskAdmission> {
    if (this.isBusy()) throw new Error('task already active');
    return await this.begin(text, commandId);
  }
  async submit(
    text: string,
  ): Promise<Omit<LoopOutcome, 'transcript'>> {
    try {
      const admission = await this.admit(text, crypto.randomUUID());
      return await admission.untilIdle;
    } catch (error) {
      if (
        typeof error === 'object' && error !== null &&
        'code' in error && error.code === 'admission_failed' &&
        'outcome' in error
      ) return error.outcome as Omit<LoopOutcome, 'transcript'>;
      throw error;
    }
  }

  async steer(
    executionId: string,
    text: string,
    commandId: string,
  ): Promise<SteeringAcceptance> {
    const active = this.active;
    if (
      active === undefined || active.executionId !== executionId ||
      this.preparing || this.cancellationRequested
    ) {
      return { kind: 'rejected', reason: 'idle' };
    }
    if (this.steeringAccepted) {
      return { kind: 'rejected', reason: 'alreadyAccepted' };
    }
    this.steeringAccepted = true;
    this.publish();
    let result: Awaited<ReturnType<HostActiveSession['steerActiveTurn']>>;
    try {
      result = await this.currentSession().steerActiveTurn(text);
    } catch (error) {
      if (this.active === active) {
        this.steeringAccepted = false;
        this.publish();
      }
      if (error instanceof RangeError) {
        return { kind: 'rejected', reason: 'invalid' };
      }
      throw error;
    }
    if (result !== 'accepted') {
      if (this.active === active) {
        this.steeringAccepted = result === 'already_accepted';
        this.publish();
      }
      return {
        kind: 'rejected',
        reason: result === 'already_accepted' ? 'alreadyAccepted' : 'idle',
      };
    }
    if (this.active === active && !this.steeringApplied) {
      this.steering = { ...active, commandId, text };
      this.publish();
    }
    return { kind: 'accepted' };
  }
  async queueFollowUp(
    afterExecutionId: string,
    text: string,
    commandId: string,
  ): Promise<FollowUpAcceptance> {
    const active = this.active;
    if (
      active === undefined || active.executionId !== afterExecutionId ||
      this.preparing || this.cancellationRequested
    ) {
      return { kind: 'rejected', reason: 'idle' };
    }
    if (this.queued !== undefined) {
      return { kind: 'rejected', reason: 'alreadyAccepted' };
    }
    const record: MutableFollowUp = {
      queueId: crypto.randomUUID(),
      commandId,
      sessionId: active.sessionId,
      afterExecutionId,
      text,
      status: 'queued',
    };
    this.queued = record;
    await this.saveFollowUp(record);
    this.publish();
    return { kind: 'accepted', queueId: record.queueId };
  }
  cancel(executionId: string): 'requested' | 'already_requested' | 'idle' {
    if (this.active?.executionId !== executionId) return 'idle';
    const result = this.currentSession().cancelActiveTurn();
    if (result !== 'idle') {
      this.cancellationRequested = true;
      if (this.queued !== undefined) this.discard(this.queued, 'cancelled');
      this.publish();
    }
    return result;
  }
  observe(observation: ApplicationObservation): void {
    if (
      observation.kind === 'steering_applied' &&
      this.active !== undefined &&
      observation.executionId === this.active.executionId
    ) {
      this.steeringApplied = true;
      this.steering = undefined;
      // The accepted marker stays true until this execution settles.
    }
  }
  async close(closeHost: () => Promise<void>): Promise<void> {
    this.closing = true;
    await closeHost();
    await this.chain?.catch(() => {});
    await this.flushFollowUps();
  }

  private async begin(
    text: string,
    commandId: string,
    reservation?: MutableFollowUp,
    precedingChanges: readonly ExecutionTrackingChange[] = [],
  ): Promise<TaskAdmission> {
    const host = this.currentSession();
    const executionId = crypto.randomUUID();
    const tracked: TaskExecutionState = {
      executionId,
      sessionId: host.sessionId,
      submittedByCommandId: commandId,
      processSettlement: 'running',
    };
    this.active = { sessionId: host.sessionId, executionId, commandId, text };
    this.preparing = true;
    this.handoffPending = false;
    this.cancellationRequested = false;
    this.steeringAccepted = false;
    this.steeringApplied = false;
    this.steering = undefined;
    this.publish([
      ...precedingChanges,
      this.executionChange(tracked),
    ]);

    let admission: Awaited<ReturnType<HostActiveSession['admit']>>;
    try {
      admission = await host.admit(text, executionId);
    } catch (error) {
      if (this.active?.executionId === executionId) this.active = undefined;
      this.preparing = false;
      if (reservation !== undefined) {
        if (this.cancellationRequested) {
          this.discard(reservation, 'cancelled');
        } else if (reservation.status === 'queued') {
          reservation.status = 'startRejected';
          reservation.reason = 'admissionFailed';
          await this.saveFollowUp(reservation);
          if (this.queued === reservation) this.queued = undefined;
        }
      }
      this.cancellationRequested = false;
      this.publish([{ kind: 'remove', executionId }]);
      throw error;
    }

    this.preparing = false;
    if (reservation !== undefined) {
      reservation.executionId = admission.executionId;
      if (reservation.status === 'queued') {
        reservation.status = 'started';
      }
      await this.saveFollowUp(reservation);
      if (this.queued === reservation) this.queued = undefined;
    }
    const accepted = { ...admission, executionId };
    const untilIdle = this.settle(accepted, tracked);
    this.chain = untilIdle;
    void untilIdle.catch(() => {});
    this.publish();
    return { ...accepted, untilIdle };
  }

  private discard(record: MutableFollowUp, reason: string): void {
    record.status = 'discarded';
    record.reason = reason;
    this.queued = undefined;
    void this.saveFollowUp(record).then(() => this.publish());
  }
  async flushFollowUps(): Promise<void> {
    for (;;) {
      const pending = this.followUpWrites;
      await pending;
      if (pending === this.followUpWrites) return;
    }
  }
  private saveFollowUp(record: FollowUpRecord): Promise<void> {
    const saved = structuredClone(record);
    const write = this.followUpWrites.then(async () => {
      await this.persistFollowUp(saved);
      if (saved.status === 'queued') this.records.set(saved.queueId, saved);
      else this.records.delete(saved.queueId);
    });
    this.followUpWrites = write;
    return write;
  }
  private executionChange(
    execution: TaskExecutionState,
  ): ExecutionTrackingChange {
    return {
      kind: 'upsert',
      executionId: execution.executionId,
      sessionId: execution.sessionId,
      submittedByCommandId: execution.submittedByCommandId,
      processSettlement: execution.processSettlement,
    };
  }
  private async settle(
    admission: Awaited<ReturnType<HostActiveSession['admit']>>,
    tracked: TaskExecutionState,
  ): Promise<Omit<LoopOutcome, 'transcript'>> {
    let outcome: Omit<LoopOutcome, 'transcript'>;
    try {
      outcome = await admission.completion;
    } catch (error) {
      tracked.processSettlement = 'complete';
      await this.persistCompletion(tracked);
      this.handoffPending = true;
      this.active = undefined;
      this.steering = undefined;
      this.steeringAccepted = false;
      this.steeringApplied = false;
      this.cancellationRequested = false;
      if (this.queued !== undefined) this.discard(this.queued, 'failed');
      await this.flushFollowUps();
      this.handoffPending = false;
      this.publish([this.executionChange(tracked)]);
      this.publish([{ kind: 'remove', executionId: tracked.executionId }]);
      throw error;
    }
    tracked.processSettlement = 'complete';
    await this.persistCompletion(tracked);
    this.handoffPending = true;
    this.active = undefined;
    this.steering = undefined;
    this.steeringAccepted = false;
    this.steeringApplied = false;
    this.cancellationRequested = false;
    this.publish([this.executionChange(tracked)]);
    this.publish([{ kind: 'remove', executionId: tracked.executionId }]);
    await this.flushFollowUps();
    const reservation = this.queued;
    if (reservation !== undefined) {
      if (
        !this.closing && outcome.ok &&
        (outcome.stopReason === 'final' ||
          outcome.stopReason === 'tool_terminal')
      ) {
        // begin publishes the child reservation before its first admission await.
        let child: TaskAdmission;
        try {
          child = await this.begin(
            reservation.text,
            reservation.commandId,
            reservation,
            [],
          );
        } catch {
          // Failed durable admission is retained as startRejected by begin().
          return outcome;
        }
        return await child.untilIdle;
      }
      this.discard(
        reservation,
        this.closing ? 'core_closed' : outcome.stopReason,
      );
    }
    await this.flushFollowUps();
    this.handoffPending = false;
    this.publish();
    return outcome;
  }
}
