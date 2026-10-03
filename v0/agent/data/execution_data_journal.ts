import type {
  ExecutionControlEventInput,
  ExecutionEventInput,
  HistoryPersistencePort,
} from '../history/history_store_contract.ts';
import type { WorkerCorrelation, WorkerToHostMessage } from '../worker/worker_protocol.ts';
import {
  readWorkerStageSnapshot,
  type WorkerStageHistorySnapshot,
  type WorkerStageSnapshotTrigger,
} from '../worker/worker_stage_probe.ts';
import { ConversationWriter } from './conversation_writer.ts';
import { workerObservationInput } from './worker_history_input.ts';

/** The dedicated data sequence is local to one execution, independently of control messages. */
export interface ExecutionDataInput {
  readonly executionId: string;
  readonly sequence: number;
  readonly message: WorkerToHostMessage;
}

type CutWaiter = {
  sequence: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

const sameGeneration = (
  left: WorkerCorrelation,
  right: WorkerCorrelation,
): boolean =>
  left.session === right.session &&
  left.instanceCorrelation === right.instanceCorrelation &&
  left.workerGeneration === right.workerGeneration &&
  left.baseStateRevision === right.baseStateRevision &&
  left.command === right.command;

/** Data-local buffering and terminal barrier; Core never waits here before sending control. */
export class ExecutionDataJournal {
  private readonly buffer: ExecutionEventInput[] = [];
  private readonly waiters = new Set<CutWaiter>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Contiguous Agent Data port sequence used by prepare/flush terminal barriers. */
  private received = 0;
  private buffered = 0;
  private durable = 0;
  /** Worker sequence maxima from semantic observations, used only in stage snapshots. */
  private receivedWorkerSequence = 0;
  private bufferedWorkerSequence = 0;
  private durableWorkerSequence = 0;
  private stageProbeBuffer: SharedArrayBuffer | undefined;
  private auxiliaryGapMs = 1_000;
  private readonly gapTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly capturedGapOrdinals = new Set<number>();
  private readonly pendingStageSnapshots: {
    readonly trigger: WorkerStageSnapshotTrigger;
    readonly contextRequestOrdinal?: number;
  }[] = [];
  private sealed = false;
  private failure: Error | undefined;

  constructor(
    private readonly input: {
      readonly executionId: string;
      readonly correlation: WorkerCorrelation;
      readonly writer: ConversationWriter;
      readonly history: Pick<
        HistoryPersistencePort,
        'prepareWorkerObservationForHistory'
      >;
      readonly onFailure: (error: Error) => void;
    },
  ) {}

  get receivedSequence(): number {
    return this.received;
  }

  get durableSequence(): number {
    return this.durable;
  }

  get bufferedSequence(): number {
    return this.buffered;
  }

  attachStageProbe(
    correlation: WorkerCorrelation,
    buffer: SharedArrayBuffer | undefined,
    auxiliaryGapMs?: number,
  ): void {
    if (buffer === undefined) return;
    if (!sameGeneration(correlation, this.input.correlation)) {
      throw new Error('Worker stage probe correlation mismatch');
    }
    this.stageProbeBuffer = buffer;
    this.auxiliaryGapMs = auxiliaryGapMs ?? 1_000;
    for (const pending of this.pendingStageSnapshots.splice(0)) {
      this.captureStageSnapshot(
        pending.trigger,
        pending.contextRequestOrdinal,
      );
    }
  }

  receive(input: ExecutionDataInput): 'accepted' | 'sealed' {
    if (this.sealed) return 'sealed';
    if (this.failure !== undefined) throw this.failure;
    if (
      input.executionId !== this.input.executionId ||
      !('correlation' in input.message) ||
      input.message.correlation === undefined ||
      !sameGeneration(input.message.correlation, this.input.correlation) ||
      input.sequence !== this.received + 1
    ) {
      const error = new Error(
        'execution data correlation or sequence mismatch',
      );
      this.fail(error);
      throw error;
    }
    const workerSequence = this.workerSequence(input.message);
    if (workerSequence !== undefined) {
      this.receivedWorkerSequence = Math.max(
        this.receivedWorkerSequence,
        workerSequence,
      );
    }
    const fact = workerObservationInput(
      this.input.executionId,
      input.message,
      this.input.history,
    );
    this.received = input.sequence;
    if (fact !== undefined) this.buffer.push(fact);
    this.buffered = input.sequence;
    if (fact?.workerSequence !== undefined) {
      this.bufferedWorkerSequence = Math.max(
        this.bufferedWorkerSequence,
        fact.workerSequence,
      );
    }
    this.observeStageMessage(input.message);
    if (this.buffer.length >= 256) this.flush();
    else if (this.timer === undefined && this.buffer.length > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          this.flush();
        } catch {
          // fail() reports the persistence failure and rejects every terminal barrier.
        }
      }, 25);
    }
    for (const waiter of this.waiters) {
      if (waiter.sequence <= this.received) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
    }
    return 'accepted';
  }

  appendControl(input: ExecutionControlEventInput): void {
    // Preserve the order of earlier accepted Agent facts before appending this small control fact.
    // A failed semantic flush must not suppress a later cancel/ACK/process observation.
    if (this.failure === undefined) {
      try {
        this.flush();
      } catch {
        // The terminal cut and control fact have separate durable paths.
      }
    }
    this.input.writer.appendExecutionControlEvents([input]);
  }

  captureStageSnapshot(
    trigger: WorkerStageSnapshotTrigger,
    contextRequestOrdinal?: number,
  ): void {
    if (this.stageProbeBuffer === undefined) {
      this.pendingStageSnapshots.push({
        trigger,
        ...(contextRequestOrdinal === undefined ? {} : { contextRequestOrdinal }),
      });
      return;
    }
    try {
      // Make the cursor reflect SQLite's actual durable prefix at the snapshot cut.
      try {
        this.flush();
      } catch {
        // The snapshot can still record the last successful durable cursor.
      }
      const stage = readWorkerStageSnapshot(this.stageProbeBuffer);
      const snapshot: WorkerStageHistorySnapshot = {
        ...stage,
        trigger,
        workerGeneration: this.input.correlation.workerGeneration,
        ...(contextRequestOrdinal === undefined ? {} : { contextRequestOrdinal }),
        lastWorkerSequenceReceived: this.receivedWorkerSequence,
        lastWorkerSequenceBuffered: this.bufferedWorkerSequence,
        lastWorkerSequenceDurable: this.durableWorkerSequence,
      };
      this.appendControl({
        executionId: this.input.executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'worker_stage_snapshot',
        observedAt: new Date().toISOString(),
        payload: snapshot,
      });
    } catch {
      // Stage snapshots are diagnostic; their persistence must not change execution settlement.
    }
  }

  closeStageProbe(): void {
    for (const timer of this.gapTimers.values()) clearTimeout(timer);
    this.gapTimers.clear();
  }

  flush(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      if (this.buffer.length > 0) {
        const batchWorkerSequence = this.buffer.reduce(
          (latest, event) =>
            event.workerSequence === undefined ? latest : Math.max(latest, event.workerSequence),
          this.durableWorkerSequence,
        );
        this.input.writer.appendExecutionEvents(this.buffer);
        this.durableWorkerSequence = batchWorkerSequence;
      }
      this.buffer.length = 0;
      this.durable = this.buffered;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.fail(error);
      throw error;
    }
  }

  async flushThrough(sequence: number): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    if (sequence > this.received) {
      if (this.sealed) {
        throw new Error(
          'execution data cut was sealed before terminal sequence',
        );
      }
      await new Promise<void>((resolve, reject) => {
        this.waiters.add({ sequence, resolve, reject });
      });
    }
    this.flush();
  }

  /** Seal the received contiguous prefix before flush; in-flight messages are not claimed saved. */
  seal(): Readonly<{ receivedSequence: number; durableSequence: number }> {
    this.closeStageProbe();
    this.sealed = true;
    this.flush();
    for (const waiter of this.waiters) {
      waiter.reject(
        new Error('execution data cut was sealed before terminal sequence'),
      );
    }
    this.waiters.clear();
    return { receivedSequence: this.received, durableSequence: this.durable };
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    this.input.onFailure(error);
  }

  private observeStageMessage(message: WorkerToHostMessage): void {
    if (
      message.kind === 'context_observation' &&
      message.observation.kind === 'model_request_delta' &&
      message.observation.delta.purpose === 'web_search'
    ) {
      const ordinal = message.observation.delta.requestOrdinal;
      if (this.capturedGapOrdinals.has(ordinal) || this.gapTimers.has(ordinal)) return;
      const timer = setTimeout(() => {
        this.gapTimers.delete(ordinal);
        this.capturedGapOrdinals.add(ordinal);
        this.captureStageSnapshot('auxiliary_gap', ordinal);
      }, this.auxiliaryGapMs);
      this.gapTimers.set(ordinal, timer);
      return;
    }
    if (
      message.kind === 'provider_observation' &&
      message.observation.kind === 'request_start'
    ) {
      const ordinal = message.observation.request.contextRequestOrdinal;
      if (ordinal === undefined) return;
      const timer = this.gapTimers.get(ordinal);
      if (timer === undefined) return;
      clearTimeout(timer);
      this.gapTimers.delete(ordinal);
      this.capturedGapOrdinals.add(ordinal);
    }
  }

  private workerSequence(message: WorkerToHostMessage): number | undefined {
    if (
      'sequence' in message && Number.isSafeInteger(message.sequence) &&
      Number(message.sequence) > 0
    ) return Number(message.sequence);
    return undefined;
  }
}
