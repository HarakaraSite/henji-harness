import type { LoopOutcome } from '../core/contracts.ts';
import type { HostActiveSession } from '../worker/worker_tui_session.ts';
import type { ApplicationObservation } from './application_port.ts';
import type { FollowUpRecord, PendingView } from '../../api/contract.ts';

type Completion = Promise<LoopOutcome>;
export interface TaskAdmission {
  readonly executionId: string;
  readonly completion: Completion;
  readonly untilIdle: Completion;
}
export interface TaskExecutionState {
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
export type SteeringAcceptance =
  | { kind: 'accepted' }
  | { kind: 'rejected'; reason: 'idle' | 'alreadyAccepted' | 'invalid' };
export type FollowUpAcceptance =
  | { kind: 'accepted'; queueId: string }
  | { kind: 'rejected'; reason: 'idle' | 'alreadyAccepted' };

/** Owns accepted fixed lanes; Host coordinator remains the sole execution/cleanup owner. */
export class ApplicationTaskService {
  private active: Lane | undefined;
  private preparing = false;
  private closing = false;
  private steering: Lane | undefined;
  private steeringAccepted = false;
  private cancellationRequested = false;
  private queued: MutableFollowUp | undefined;
  private chain: Completion | undefined;
  private readonly records = new Map<string, MutableFollowUp>();
  private readonly executions = new Map<string, TaskExecutionState>();

  constructor(
    private readonly currentSession: () => HostActiveSession,
    private readonly publish: () => void,
  ) {}

  isBusy(): boolean {
    return this.preparing || this.active !== undefined;
  }
  isPreparing(): boolean {
    return this.preparing;
  }
  canSteer(): boolean {
    return this.active !== undefined && !this.steeringAccepted &&
      !this.cancellationRequested;
  }
  canQueueFollowUp(): boolean {
    return this.active !== undefined && this.queued === undefined &&
      !this.cancellationRequested;
  }
  activeExecutionId(): string | undefined {
    return this.active?.executionId;
  }
  executionStates(): ReadonlyMap<string, TaskExecutionState> {
    return this.executions;
  }
  pendingView(sessionId = this.currentSession().sessionId): PendingView {
    const active = this.active?.sessionId === sessionId ? this.active : undefined;
    const steering = this.steering?.sessionId === sessionId ? this.steering : undefined;
    const queued = this.queued?.sessionId === sessionId ? this.queued : undefined;
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
  followUpRead(queueId: string): FollowUpRecord | undefined {
    const record = this.records.get(queueId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async admit(
    text: string,
    commandId: string,
    recalledContext?: Parameters<HostActiveSession['admit']>[1],
  ): Promise<TaskAdmission> {
    if (this.isBusy()) throw new Error('task already active');
    this.preparing = true;
    this.publish();
    return await this.begin(text, commandId, recalledContext);
  }
  async submit(
    text: string,
    recalledContext?: Parameters<HostActiveSession['admit']>[1],
  ): Promise<LoopOutcome> {
    try {
      const admission = await this.admit(
        text,
        crypto.randomUUID(),
        recalledContext,
      );
      return await admission.untilIdle;
    } catch (error) {
      if (
        typeof error === 'object' && error !== null &&
        'code' in error && error.code === 'admission_failed' &&
        'outcome' in error
      ) return error.outcome as LoopOutcome;
      throw error;
    }
  }

  steer(
    executionId: string,
    text: string,
    commandId: string,
  ): SteeringAcceptance {
    const active = this.active;
    if (
      active === undefined || active.executionId !== executionId ||
      this.cancellationRequested
    ) {
      return { kind: 'rejected', reason: 'idle' };
    }
    if (this.steeringAccepted) {
      return { kind: 'rejected', reason: 'alreadyAccepted' };
    }
    let result: ReturnType<HostActiveSession['steerActiveTurn']>;
    try {
      result = this.currentSession().steerActiveTurn(text);
    } catch (error) {
      if (error instanceof RangeError) {
        return { kind: 'rejected', reason: 'invalid' };
      }
      throw error;
    }
    if (result !== 'accepted') {
      return {
        kind: 'rejected',
        reason: result === 'already_accepted' ? 'alreadyAccepted' : 'idle',
      };
    }
    this.steeringAccepted = true;
    this.steering = { ...active, commandId, text };
    this.publish();
    return { kind: 'accepted' };
  }
  queueFollowUp(
    afterExecutionId: string,
    text: string,
    commandId: string,
  ): FollowUpAcceptance {
    const active = this.active;
    if (
      active === undefined || active.executionId !== afterExecutionId ||
      this.cancellationRequested
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
    this.records.set(record.queueId, record);
    this.queued = record;
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
      observation.kind === 'agent_event' &&
      observation.event.kind === 'steering_message' &&
      this.active !== undefined &&
      (observation.executionId === undefined ||
        observation.executionId === this.active.executionId)
    ) {
      this.steering = undefined;
      // The accepted marker stays true until this execution settles.
    }
  }
  async close(closeHost: () => Promise<void>): Promise<void> {
    this.closing = true;
    await closeHost();
    await this.chain?.catch(() => {});
  }

  private async begin(
    text: string,
    commandId: string,
    recalledContext?: Parameters<HostActiveSession['admit']>[1],
    reservation?: MutableFollowUp,
  ): Promise<TaskAdmission> {
    const host = this.currentSession();
    let admission: Awaited<ReturnType<HostActiveSession['admit']>>;
    try {
      admission = await host.admit(text, recalledContext);
    } catch (error) {
      this.preparing = false;
      if (reservation !== undefined) {
        reservation.status = 'startRejected';
        reservation.reason = 'admissionFailed';
        this.queued = undefined;
      }
      this.publish();
      throw error;
    }
    this.active = {
      sessionId: host.sessionId,
      executionId: admission.executionId,
      commandId,
      text,
    };
    this.executions.set(admission.executionId, {
      sessionId: host.sessionId,
      submittedByCommandId: commandId,
      processSettlement: 'running',
    });
    this.preparing = false;
    this.steeringAccepted = false;
    this.cancellationRequested = false;
    this.steering = undefined;
    if (reservation !== undefined) {
      reservation.status = 'started';
      reservation.executionId = admission.executionId;
      this.queued = undefined;
    }
    const untilIdle = this.settle(admission);
    this.chain = untilIdle;
    void untilIdle.catch(() => {});
    this.publish();
    return { ...admission, untilIdle };
  }

  private discard(record: MutableFollowUp, reason: string): void {
    record.status = 'discarded';
    record.reason = reason;
    this.queued = undefined;
  }
  private async settle(
    admission: Awaited<ReturnType<HostActiveSession['admit']>>,
  ): Promise<LoopOutcome> {
    const tracked = this.executions.get(admission.executionId)!;
    let outcome: LoopOutcome;
    try {
      outcome = await admission.completion;
    } catch (error) {
      tracked.processSettlement = 'complete';
      this.active = undefined;
      this.steering = undefined;
      this.steeringAccepted = false;
      if (this.queued !== undefined) this.discard(this.queued, 'failed');
      this.publish();
      throw error;
    }
    tracked.processSettlement = 'complete';
    this.active = undefined;
    this.steering = undefined;
    this.steeringAccepted = false;
    const reservation = this.queued;
    if (reservation !== undefined) {
      if (
        !this.closing && outcome.ok &&
        (outcome.stopReason === 'final' ||
          outcome.stopReason === 'tool_terminal')
      ) {
        // Claim the handoff before any await: ordinary submit and navigation still see busy.
        this.preparing = true;
        this.publish();
        let child: TaskAdmission;
        try {
          child = await this.begin(
            reservation.text,
            reservation.commandId,
            undefined,
            reservation,
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
    this.publish();
    return outcome;
  }
}
