import type { WorkerToHostMessage } from './worker_protocol.ts';
import { readWorkerStageSnapshot, type WorkerStageSnapshotTrigger } from './worker_stage_probe.ts';
import type {
  ExecutionEventInput,
  ExecutionEventPayloadByKind,
} from '../history/history_store_contract.ts';
import type { WorkerHostSessionOptions } from './worker_host_contract.ts';
import type { WorkerSupervisor } from './worker_host_supervisor.ts';
import type { ActiveWorkerExecution, HistoryJournalErrorCode } from './worker_host_types.ts';

const OBSERVATION_FLUSH_BATCH = 256;
const OBSERVATION_FLUSH_INTERVAL_MS = 25;

export interface ExecutionJournalHost {
  readonly options: WorkerHostSessionOptions;
  activeExecution(): ActiveWorkerExecution | undefined;
  supervisor(): WorkerSupervisor;
  lastAuxiliaryContextRequestOrdinal(): number | undefined;
  /** Called when a pre-commit journal failure must make the generation unavailable. */
  onPreCommitJournalFailure(): void;
}

/**
 * Owns the durable execution journal: admission observation buffering, batched appends, journal
 * failure latching, and worker stage snapshots. It owns no canonical Session state.
 */
export class ExecutionJournal {
  private readonly observationBuffer: ExecutionEventInput[] = [];
  private observationFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushingObservations = false;

  constructor(private readonly host: ExecutionJournalHost) {}

  clearBuffer(): void {
    if (this.observationFlushTimer !== undefined) {
      clearTimeout(this.observationFlushTimer);
      this.observationFlushTimer = undefined;
    }
    this.observationBuffer.length = 0;
  }

  appendJournal(input: ExecutionEventInput): boolean {
    const history = this.host.options.historyPersistence;
    const execution = this.host.activeExecution();
    if (history === undefined || execution === undefined) {
      return true;
    }
    if (!this.flushObservationBuffer()) return false;
    try {
      history.appendExecutionEvent(input);
      return true;
    } catch (error) {
      return this.handleJournalFailure(error);
    }
  }

  handleJournalFailure(error: unknown): false {
    const code: HistoryJournalErrorCode = typeof error === 'object' && error !== null &&
        ((error as { readonly code?: unknown }).code === 'history_busy' ||
          (error as { readonly code?: unknown }).code === 'history_invalid' ||
          (error as { readonly code?: unknown }).code === 'history_io_failure')
      ? (error as { readonly code: HistoryJournalErrorCode }).code
      : 'history_io_failure' as const;
    const execution = this.host.activeExecution();
    if (execution !== undefined) {
      if (execution.settlement === 'uncommitted') {
        if (execution.journalFailureCode === undefined) {
          execution.journalFailure = true;
          execution.journalFailureCode = code;
          // Resolve the per-execution signal before terminating the generation. This remains
          // observable even when the append failed before submit() registered its waiter.
          execution.journalFailureSignal.resolve(code);
        }
        this.host.onPreCommitJournalFailure();
      } else {
        // The canonical transaction is already durable. Keep its result and make the
        // acknowledgement loss visible to the Surface without attempting a second settle.
        execution.postCommitObservationFailure = true;
        execution.postCommitObservationError = code;
      }
    }
    return false;
  }

  /**
   * Buffer one worker observation. The pure contract check runs here so a fact the journal
   * boundary would reject is never projected to the Surface; the durable write is deferred.
   */
  bufferWorkerObservation(input: ExecutionEventInput): boolean {
    const history = this.host.options.historyPersistence;
    const execution = this.host.activeExecution();
    if (history === undefined || execution === undefined) {
      return true;
    }
    if (!history.validateExecutionEvent(input)) {
      return this.handleJournalFailure({ code: 'history_invalid' });
    }
    this.observationBuffer.push(
      input.observedAt === undefined ? { ...input, observedAt: new Date().toISOString() } : input,
    );
    const supervisor = this.host.supervisor();
    if (
      input.workerSequence !== undefined &&
      input.workerSequence > supervisor.lastWorkerSequenceBuffered
    ) supervisor.lastWorkerSequenceBuffered = input.workerSequence;
    if (this.observationBuffer.length >= OBSERVATION_FLUSH_BATCH) {
      return this.flushObservationBuffer();
    }
    this.scheduleObservationFlush();
    return true;
  }

  scheduleObservationFlush(): void {
    if (this.observationFlushTimer !== undefined) return;
    this.observationFlushTimer = setTimeout(() => {
      this.observationFlushTimer = undefined;
      this.flushObservationBuffer();
    }, OBSERVATION_FLUSH_INTERVAL_MS);
  }

  flushObservationBuffer(): boolean {
    if (this.observationFlushTimer !== undefined) {
      clearTimeout(this.observationFlushTimer);
      this.observationFlushTimer = undefined;
    }
    const history = this.host.options.historyPersistence;
    const execution = this.host.activeExecution();
    if (history === undefined || execution === undefined) {
      this.observationBuffer.length = 0;
      return true;
    }
    if (this.observationBuffer.length === 0 || this.flushingObservations) {
      return true;
    }
    const batch = this.observationBuffer.splice(
      0,
      this.observationBuffer.length,
    );
    this.flushingObservations = true;
    try {
      history.appendExecutionEvents(batch);
      const supervisor = this.host.supervisor();
      for (const input of batch) {
        if (
          input.workerSequence !== undefined &&
          input.workerSequence > supervisor.lastWorkerSequenceDurable
        ) supervisor.lastWorkerSequenceDurable = input.workerSequence;
      }
      return true;
    } catch (error) {
      this.observationBuffer.length = 0;
      return this.handleJournalFailure(error);
    } finally {
      this.flushingObservations = false;
    }
  }

  appendWorkerObservation(message: WorkerToHostMessage): boolean {
    const execution = this.host.activeExecution();
    if (execution === undefined) return true;
    if (
      message.kind === 'ready' || message.kind === 'model_selected' ||
      message.kind === 'closed' || message.kind === 'checkpoint_proposal' ||
      message.kind === 'async_agent_request'
    ) return true;
    const workerSequence = message.kind === 'runtime_event' ||
        message.kind === 'effect_observation' ||
        message.kind === 'provider_observation' ||
        message.kind === 'context_observation' ||
        message.kind === 'cancel_received'
      ? message.sequence
      : undefined;
    const kind = message.kind === 'runtime_event'
      ? 'runtime_event'
      : message.kind === 'effect_observation'
      ? 'effect_observation'
      : message.kind === 'provider_observation'
      ? message.observation.kind === 'request_start'
        ? 'provider_request_start' as const
        : message.observation.kind === 'response_start'
        ? 'provider_response_start' as const
        : message.observation.kind === 'parser_transition'
        ? 'provider_parser_transition' as const
        : message.observation.kind === 'request_failure'
        ? 'provider_request_failure' as const
        : 'runtime_event' as const
      : message.kind === 'context_observation'
      ? 'context_observation' as const
      : message.kind === 'cancel_received'
      ? 'cancel_received' as const
      : 'runtime_event' as const;
    const historyMessage = this.host.options.historyPersistence
      ?.prepareWorkerObservationForHistory?.(message) ?? message;
    return this.bufferWorkerObservation({
      executionId: execution.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind,
      ...(workerSequence === undefined ? {} : { workerSequence }),
      payload: structuredClone(
        historyMessage,
      ) as unknown as ExecutionEventPayloadByKind[typeof kind],
    } as ExecutionEventInput);
  }

  recordWorkerStageSnapshot(
    trigger: WorkerStageSnapshotTrigger,
    contextRequestOrdinal: number | undefined = this.host.lastAuxiliaryContextRequestOrdinal(),
  ): boolean {
    const execution = this.host.activeExecution();
    if (execution === undefined) return true;
    const key = `${trigger}:${contextRequestOrdinal ?? 0}`;
    if (execution.stageSnapshotKeys.has(key)) return true;
    if (!this.flushObservationBuffer()) return false;
    const supervisor = this.host.supervisor();
    let snapshot: ReturnType<typeof readWorkerStageSnapshot>;
    try {
      snapshot = readWorkerStageSnapshot(supervisor.stageProbeBuffer);
    } catch {
      return true;
    }
    if (snapshot.epoch !== execution.stageProbeEpoch) return true;
    execution.stageSnapshotKeys.add(key);
    return this.appendJournal({
      executionId: execution.executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'worker_stage_snapshot',
      payload: {
        ...snapshot,
        trigger,
        workerGeneration: supervisor.workerGeneration,
        ...(contextRequestOrdinal === undefined ? {} : { contextRequestOrdinal }),
        lastWorkerSequenceReceived: supervisor.lastWorkerSequenceReceived,
        lastWorkerSequenceBuffered: supervisor.lastWorkerSequenceBuffered,
        lastWorkerSequenceDurable: supervisor.lastWorkerSequenceDurable,
      },
    });
  }
}
