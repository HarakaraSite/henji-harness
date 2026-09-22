import type { AgentEvent } from '../core/events.ts';
import type { LoopOutcome, Message } from '../core/contracts.ts';
import {
  historyPageWindow,
  indexSessionHistory,
  type SessionHistoryPage,
} from '../session/session_history.ts';
import {
  type DefinitionRevisionRef,
  normalizeSessionTitle,
  type SemanticContextCheckpointV1,
  type SessionModelChange,
  type SessionRecord,
  type SessionRecordV6,
  type SessionTurnExecutionAttribution,
  type SessionTurnModelAttribution,
  validateSemanticContextCheckpoint,
  validateSessionRecordV6,
} from '../session/session_store.ts';
import {
  createFailureDiagnostic,
  type FailureDiagnosticV1,
} from '../session/failure_diagnostic.ts';
import type { ProviderEvidenceV1, ProviderEvidenceV5 } from '../provider/provider_evidence.ts';
import { readWorkerModuleRevision, WorkerCapsule } from './worker_capsule.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerDefinitionLoadRequest,
  WorkerErrorMessage,
  WorkerModelSelectedMessage,
  WorkerReadyMessage,
  WorkerToHostMessage,
  WorkerToolDefinitionLoadRequest,
} from './worker_protocol.ts';
import {
  beginWorkerStageProbeEpoch,
  createWorkerStageProbeBuffer,
  readWorkerStageSnapshot,
  type WorkerStageSnapshotTrigger,
} from './worker_stage_probe.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../provider/openrouter_model_catalog.ts';
import { isModelSelection, roleDefaultModelSelection } from '../provider/model_catalog.ts';
import {
  type CredentialAvailability,
  modelRouteProfileId,
  type ModelSelection,
  sameModelSelection,
} from '../provider/model_selection.ts';
import {
  type WorkerExecutionAcknowledgement,
  type WorkerExecutionArtifactV7,
  workerExecutionOutcome,
  type WorkerExecutionSettlement,
  type WorkerExecutionStoreResult,
  type WorkerExecutionTraceEntry,
  type WorkerExecutionTurnCommand,
  workerHostCommandSubtype,
  workerMessageSubtype,
} from './worker_execution_artifact.ts';
import {
  type RecalledExecutionContext,
  recalledExecutionProjectionText,
  resolveRecalledExecutionContext,
} from './recalled_execution_context.ts';
import type { WorkerHostCapsule, WorkerHostSessionOptions } from './worker_host_contract.ts';
import {
  diagnosticPersistenceCodes,
  evidencePersistenceCodes,
  failedOutcome,
  interruptedOutcome,
  persistenceCode,
  proposalOutcome,
  sameCorrelation,
  turnEndFromOutcome,
} from './worker_host_outcome.ts';
import { HostMessageQueue } from './worker_host_queue.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import type { HistoryCaptureResult } from '../history/history_store_contract.ts';
import type {
  ExecutionEventInput,
  ExecutionEventPayloadByKind,
} from '../history/history_store_contract.ts';
import {
  type ExecutionContextManifestV2,
  validateWorkerContextSnapshot,
} from '../history/context_attribution.ts';
import {
  isHenjiInstructionRevisionRef,
  isToolDefinitionRevisionRef,
  type ToolDefinitionRevisionRef,
} from '../definitions/managed_resource_ref.ts';
import type { SelectedHenjiBaseInstruction } from '../instructions/base_instruction.ts';

const workerUrl = new URL('./worker_bootstrap.ts', import.meta.url);
const OBSERVATION_FLUSH_BATCH = 256;
const OBSERVATION_FLUSH_INTERVAL_MS = 25;
const WORKER_SETTLEMENT_GRACE_MS = 5_000;
const WORKER_RESPONSE_TIMEOUT_MS = 5_000;
const AUXILIARY_STAGE_GAP_MS = 1_000;
const profileIdPattern = /^[^\0]+$/u;
type HistoryJournalErrorCode =
  | 'history_busy'
  | 'history_invalid'
  | 'history_io_failure';
type JournalFailureSignal = {
  readonly promise: Promise<HistoryJournalErrorCode>;
  readonly resolve: (code: HistoryJournalErrorCode) => void;
};
const createJournalFailureSignal = (): JournalFailureSignal => {
  let resolve!: (code: HistoryJournalErrorCode) => void;
  const promise = new Promise<HistoryJournalErrorCode>((accepted) => {
    resolve = accepted;
  });
  return { promise, resolve };
};
const validCredentialAvailability = (
  value: CredentialAvailability | undefined,
  selection: ModelSelection,
): value is CredentialAvailability =>
  value !== undefined && value.authProfile === selection.authProfile &&
  (value.status === 'present' || value.status === 'missing' ||
    value.status === 'unknown');
const validStartupSnapshot = (
  value: WorkerReadyMessage['startupSnapshot'],
): value is NonNullable<WorkerReadyMessage['startupSnapshot']> => {
  if (value === undefined || !Array.isArray(value.skillNames)) return false;
  if (
    value.instructionSource !== undefined &&
    value.instructionSource !== 'AGENTS.md' &&
    value.instructionSource !== 'AGENTS.MD'
  ) return false;
  return value.skillNames.every((name) => typeof name === 'string' && name.length > 0) &&
    new Set(value.skillNames).size === value.skillNames.length &&
    (value.context === undefined ||
      validateWorkerContextSnapshot(value.context));
};
const validBaseInstructionManifest = (
  value:
    | NonNullable<
      NonNullable<WorkerReadyMessage['manifest']>['baseInstruction']
    >
    | undefined,
  selected: SelectedHenjiBaseInstruction | undefined,
): boolean => {
  if (selected === undefined) {
    return value === undefined || value.selectionSource === 'built-in';
  }
  if (value === undefined || typeof value !== 'object' || value === null) {
    return false;
  }
  return value.slot === selected.slot &&
    value.selectionSource === selected.selectionSource &&
    value.contentDigest === selected.contentDigest &&
    isHenjiInstructionRevisionRef(value.ref) &&
    JSON.stringify(value.ref) === JSON.stringify(selected.ref);
};

const toolAttributionKey = (
  toolIdentity: string,
  ref: ToolDefinitionRevisionRef,
): string => `${toolIdentity}:${ref.resourceId}@sha256:${ref.revision.digest}`;

const validToolManifest = (
  value: NonNullable<WorkerReadyMessage['manifest']>['tools'],
  requested: readonly WorkerToolDefinitionLoadRequest[] | undefined,
): boolean => {
  const expectedKeys = new Set(
    (requested ?? []).map((tool) => toolAttributionKey(tool.toolIdentity, tool.ref)),
  );
  const actual = value ?? [];
  const actualKeys = actual.map((tool) =>
    isToolDefinitionRevisionRef(tool.ref)
      ? toolAttributionKey(tool.toolIdentity, tool.ref)
      : undefined
  );
  return actualKeys.every((key) => key !== undefined && expectedKeys.has(key)) &&
    new Set(actualKeys).size === actualKeys.length;
};

export type WorkerHostStartupErrorCode =
  | 'module_invalid'
  | 'definition_evaluation_failed'
  | 'role_mismatch'
  | 'manifest_invalid';

export class WorkerHostStartupError extends Error {
  constructor(
    readonly code: WorkerHostStartupErrorCode,
    readonly workerStage: WorkerErrorMessage['stage'],
    message: string,
  ) {
    super(message);
    this.name = 'WorkerHostStartupError';
  }
}

export type WorkerRecallSelectionErrorCode =
  | 'unavailable'
  | 'busy'
  | 'not_found'
  | 'ambiguous'
  | 'failed';

export class WorkerRecallSelectionError extends Error {
  constructor(readonly code: WorkerRecallSelectionErrorCode) {
    super(code);
    this.name = 'WorkerRecallSelectionError';
  }
}
type ActiveWorkerExecution = {
  readonly taskId: string;
  readonly executionId: string;
  readonly createdAt: string;
  readonly turn: number;
  readonly command: WorkerExecutionTurnCommand;
  readonly recalledContext?: RecalledExecutionContext;
  readonly baseStateRevision: number;
  readonly stageProbeEpoch: number;
  readonly protocolTrace: WorkerExecutionTraceEntry[];
  journalFailure?: boolean;
  journalFailureCode?: HistoryJournalErrorCode;
  readonly journalFailureSignal: JournalFailureSignal;
  postCommitObservationFailure?: boolean;
  postCommitObservationError?:
    | 'history_busy'
    | 'history_invalid'
    | 'history_io_failure';
  storeResult: WorkerExecutionStoreResult;
  storeError?: 'session_io_failure' | 'session_invalid' | 'history_busy';
  proposedStateRevision?: number;
  committedStateRevision?: number;
  acknowledgement: WorkerExecutionAcknowledgement;
  settlement: WorkerExecutionSettlement;
  artifactWritten: boolean;
  contextCapture?: 'complete' | 'failed' | 'none';
  readonly stageSnapshotKeys: Set<string>;
};
type ActiveSessionProjection = {
  readonly sessionId: string;
  transcript: Message[];
  nextTurn: number;
  stateRevision: number;
  checkpoint?: SemanticContextCheckpointV1;
  modelSelection: ModelSelection;
  modelChanges: SessionModelChange[];
  turnModels: SessionTurnModelAttribution[];
  turnExecutions: SessionTurnExecutionAttribution[];
  title: string | null;
};
/** Host-owned canonical session around one ephemeral Worker generation. */
export class WorkerHostSession {
  private capsule: WorkerHostCapsule;
  private messages = new HostMessageQueue();
  private unsubscribe: () => void;
  private readonly instanceCorrelation = crypto.randomUUID().toLowerCase();
  private workerGeneration = crypto.randomUUID().toLowerCase();
  private readonly bootstrapTrace: WorkerExecutionTraceEntry[] = [];
  private traceSequence = 0;
  private currentCorrelation: WorkerCorrelation | undefined;
  private currentManifest: WorkerReadyMessage['manifest'];
  private currentStartupSnapshot: WorkerReadyMessage['startupSnapshot'];
  private readonly projection: ActiveSessionProjection;
  private autoCompactionNotice: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
  private runtimeRequestCount = 0;
  private generationRequestBase = 0;
  private active = false;
  private unavailable = false;
  private closed = false;
  private activeExecution: ActiveWorkerExecution | undefined;
  private readonly build = buildManifest();
  private readonly createdAt: string;
  private credentialAvailability: CredentialAvailability | undefined;
  private pendingRecall: RecalledExecutionContext | undefined;
  private readonly observationBuffer: ExecutionEventInput[] = [];
  private observationFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushingObservations = false;
  private stageProbeBuffer = createWorkerStageProbeBuffer();
  private stageProbeEpoch = 0;
  private lastWorkerSequenceReceived = 0;
  private lastWorkerSequenceBuffered = 0;
  private lastWorkerSequenceDurable = 0;
  private lastAuxiliaryContextRequestOrdinal: number | undefined;
  private auxiliaryStageWatchdog: {
    readonly executionId: string;
    readonly contextRequestOrdinal: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | undefined;
  private cancellationWatchdog: {
    readonly executionId: string;
    readonly timer: ReturnType<typeof setTimeout>;
  } | undefined;
  private cancellationRequestedExecutionId: string | undefined;
  private forcedInterruptionExecutionId: string | undefined;
  private generationNeedsReplacement = false;
  private replacement: Promise<void> | undefined;

  private constructor(private readonly options: WorkerHostSessionOptions) {
    this.capsule = options.capsuleFactory?.(workerUrl) ??
      new WorkerCapsule(workerUrl);
    const record = options.handle.record;
    if (
      record !== undefined &&
      (record.workspaceRoot !== options.workspaceRoot ||
        record.agent !== options.agent)
    ) {
      throw new Error('session binding does not match the opened session');
    }
    const nextTurn = record?.nextTurn ?? 1;
    const defaultSelection = options.initialModelSelection ??
      (options.agent === 'planner'
        ? roleDefaultModelSelection('subagent:planner')
        : ROOT_DEFAULT_MODEL_SELECTION);
    const modelSelection = record === undefined
      ? structuredClone(defaultSelection)
      : structuredClone(record.activeModel);
    this.projection = {
      sessionId: options.handle.id,
      transcript: record === undefined ? [] : structuredClone(record.transcript) as Message[],
      nextTurn,
      stateRevision: record?.stateRevision ?? 1,
      modelSelection,
      modelChanges: record === undefined
        ? [{
          effectiveFromTurn: nextTurn,
          changedAt: new Date().toISOString(),
          selection: structuredClone(modelSelection),
        }]
        : structuredClone(record.modelChanges) as SessionModelChange[],
      turnModels: record === undefined
        ? []
        : structuredClone(record.turnModels) as SessionTurnModelAttribution[],
      turnExecutions: record === undefined ? [] : structuredClone(
        record.turnExecutions,
      ) as SessionTurnExecutionAttribution[],
      title: record?.title ?? null,
      ...(options.handle.checkpoint === undefined
        ? {}
        : { checkpoint: structuredClone(options.handle.checkpoint) }),
    };
    this.createdAt = record?.createdAt ?? new Date().toISOString();
    this.unsubscribe = this.capsule.subscribe((message) => this.receive(message));
  }

  private workerResponseTimeoutMs(): number {
    return this.options.workerResponseTimeoutMs ?? WORKER_RESPONSE_TIMEOUT_MS;
  }

  private clearAuxiliaryStageWatchdog(
    executionId?: string,
    contextRequestOrdinal?: number,
  ): void {
    const watchdog = this.auxiliaryStageWatchdog;
    if (
      watchdog === undefined ||
      (executionId !== undefined && watchdog.executionId !== executionId) ||
      (contextRequestOrdinal !== undefined &&
        watchdog.contextRequestOrdinal !== contextRequestOrdinal)
    ) return;
    clearTimeout(watchdog.timer);
    this.auxiliaryStageWatchdog = undefined;
  }

  private recordWorkerStageSnapshot(
    trigger: WorkerStageSnapshotTrigger,
    contextRequestOrdinal = this.lastAuxiliaryContextRequestOrdinal,
  ): boolean {
    const execution = this.activeExecution;
    if (execution === undefined) return true;
    const key = `${trigger}:${contextRequestOrdinal ?? 0}`;
    if (execution.stageSnapshotKeys.has(key)) return true;
    if (!this.flushObservationBuffer()) return false;
    let snapshot: ReturnType<typeof readWorkerStageSnapshot>;
    try {
      snapshot = readWorkerStageSnapshot(this.stageProbeBuffer);
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
        workerGeneration: this.workerGeneration,
        ...(contextRequestOrdinal === undefined ? {} : { contextRequestOrdinal }),
        lastWorkerSequenceReceived: this.lastWorkerSequenceReceived,
        lastWorkerSequenceBuffered: this.lastWorkerSequenceBuffered,
        lastWorkerSequenceDurable: this.lastWorkerSequenceDurable,
      },
    });
  }

  private scheduleAuxiliaryStageWatchdog(contextRequestOrdinal: number): void {
    const execution = this.activeExecution;
    if (execution === undefined) return;
    this.clearAuxiliaryStageWatchdog();
    this.lastAuxiliaryContextRequestOrdinal = contextRequestOrdinal;
    const executionId = execution.executionId;
    const timer = setTimeout(() => {
      const current = this.auxiliaryStageWatchdog;
      if (
        current === undefined || current.executionId !== executionId ||
        current.contextRequestOrdinal !== contextRequestOrdinal
      ) return;
      this.auxiliaryStageWatchdog = undefined;
      this.recordWorkerStageSnapshot('auxiliary_gap', contextRequestOrdinal);
    }, this.options.auxiliaryStageGapMs ?? AUXILIARY_STAGE_GAP_MS);
    this.auxiliaryStageWatchdog = {
      executionId,
      contextRequestOrdinal,
      timer,
    };
  }

  private noteWorkerSequenceReceived(message: WorkerToHostMessage): void {
    if (
      'sequence' in message && Number.isSafeInteger(message.sequence) &&
      Number(message.sequence) > this.lastWorkerSequenceReceived
    ) this.lastWorkerSequenceReceived = Number(message.sequence);
  }

  private clearCancellationWatchdog(executionId?: string): void {
    const watchdog = this.cancellationWatchdog;
    if (
      watchdog === undefined ||
      (executionId !== undefined && watchdog.executionId !== executionId)
    ) return;
    clearTimeout(watchdog.timer);
    this.cancellationWatchdog = undefined;
  }

  private markUnavailableForReplacement(): void {
    this.generationNeedsReplacement = true;
    this.markUnavailable();
  }

  private async replaceGeneration(): Promise<void> {
    if (!this.generationNeedsReplacement) return;
    if (this.closed) throw new Error('session is closed');
    if (this.replacement !== undefined) return await this.replacement;
    this.replacement = (async () => {
      this.clearAuxiliaryStageWatchdog();
      this.unsubscribe();
      this.messages.fail(new Error('Worker generation replaced'));
      try {
        this.capsule.terminate();
      } catch {
        // The old generation is already unavailable.
      }
      this.messages = new HostMessageQueue();
      this.generationRequestBase = this.runtimeRequestCount;
      this.workerGeneration = crypto.randomUUID().toLowerCase();
      this.stageProbeBuffer = createWorkerStageProbeBuffer();
      this.stageProbeEpoch = 0;
      this.lastWorkerSequenceReceived = 0;
      this.lastWorkerSequenceBuffered = 0;
      this.lastWorkerSequenceDurable = 0;
      this.lastAuxiliaryContextRequestOrdinal = undefined;
      this.bootstrapTrace.length = 0;
      this.traceSequence = 0;
      this.currentManifest = undefined;
      this.currentStartupSnapshot = undefined;
      this.credentialAvailability = undefined;
      this.unavailable = false;
      this.capsule = this.options.capsuleFactory?.(workerUrl) ??
        new WorkerCapsule(workerUrl);
      this.unsubscribe = this.capsule.subscribe((message) => this.receive(message));
      try {
        await this.start();
        this.generationNeedsReplacement = false;
      } catch (error) {
        this.markUnavailable();
        throw error;
      }
    })();
    try {
      await this.replacement;
    } finally {
      this.replacement = undefined;
    }
  }

  private async ensureGeneration(): Promise<void> {
    if (this.generationNeedsReplacement) await this.replaceGeneration();
    if (this.unavailable) throw new Error('agent session unavailable');
  }

  private escalateCancellation(executionId: string): void {
    const execution = this.activeExecution;
    if (
      execution === undefined || execution.executionId !== executionId ||
      !this.active
    ) return;
    this.clearCancellationWatchdog(executionId);
    this.recordWorkerStageSnapshot('cancel_escalated');
    this.appendJournal({
      executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'cancel_escalated',
      payload: {
        command: 'terminate',
        reason: 'settlement_deadline_exceeded',
      },
    });
    this.flushObservationBuffer();
    if (execution.committedStateRevision === undefined) {
      this.forcedInterruptionExecutionId = executionId;
      try {
        this.options.historyPersistence?.reconcileExecution({
          executionId,
          settlement: 'interrupted',
        });
      } catch {
        // Keep the active durable prefix for normal restart reconciliation.
      }
    }
    this.markUnavailableForReplacement();
  }

  static async open(
    options: WorkerHostSessionOptions,
  ): Promise<WorkerHostSession> {
    const session = new WorkerHostSession(options);
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  get definition(): DefinitionRevisionRef {
    return structuredClone(this.options.definition);
  }

  get sessionId(): string {
    return this.options.handle.id;
  }

  modelSelectionSnapshot(): ModelSelection {
    return structuredClone(this.projection.modelSelection);
  }

  startupSnapshot(): NonNullable<WorkerReadyMessage['startupSnapshot']> {
    if (this.currentStartupSnapshot === undefined) {
      throw new Error('Worker startup snapshot is unavailable');
    }
    return structuredClone(this.currentStartupSnapshot);
  }

  credentialAvailabilitySnapshot(): CredentialAvailability | undefined {
    return this.credentialAvailability === undefined
      ? undefined
      : structuredClone(this.credentialAvailability);
  }

  private trace(
    direction: WorkerExecutionTraceEntry['direction'],
    kind: WorkerExecutionTraceEntry['kind'],
    semanticSubtype: string,
    correlation: WorkerCorrelation,
    ackAccepted?: boolean,
  ): void {
    if (this.options.historyPersistence?.capturesProtocolTrace?.() === false) return;
    const entry: WorkerExecutionTraceEntry = {
      direction,
      kind,
      semanticSubtype,
      sequence: ++this.traceSequence,
      correlation: structuredClone(correlation),
      ...(ackAccepted === undefined ? {} : { ackAccepted }),
    };
    if (this.activeExecution === undefined) this.bootstrapTrace.push(entry);
    else this.activeExecution.protocolTrace.push(entry);
  }

  private send(
    command: import('./worker_protocol.ts').WorkerHostCommand,
  ): void {
    const subtype = workerHostCommandSubtype(command);
    this.trace(
      'host_to_worker',
      subtype.kind,
      subtype.semanticSubtype,
      command.correlation,
      subtype.ackAccepted,
    );
    this.capsule.send(command);
  }

  private sendCommitAcknowledgement(
    execution: ActiveWorkerExecution,
    correlation: WorkerCorrelation,
    accepted: boolean,
  ): boolean {
    // A successful commit has already installed `execution_settled`, the final fact in the
    // execution ledger. Its acknowledgement attempt/result remains durable in the protocol
    // trace and final execution artifact; it must not be appended behind the terminal fact.
    // Rejections happen before settlement and remain ordinary journal facts.
    const journalAcknowledgement = execution.settlement === 'uncommitted';
    if (journalAcknowledgement) {
      this.appendJournal({
        executionId: execution.executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'acknowledgement_requested',
        payload: { accepted },
      });
    }
    try {
      this.send({ kind: 'commit_acknowledgement', correlation, accepted });
      execution.acknowledgement = accepted ? 'accepted_sent' : 'rejected_sent';
      if (journalAcknowledgement) {
        this.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'acknowledgement_sent',
          payload: { accepted },
        });
      }
      return true;
    } catch {
      execution.acknowledgement = 'delivery_failed';
      if (journalAcknowledgement) {
        this.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'acknowledgement_failed',
          payload: { accepted },
        });
      }
      return false;
    }
  }

  private receiveTrace(message: WorkerToHostMessage): void {
    const subtype = workerMessageSubtype(message);
    const correlation = 'correlation' in message && message.correlation !== undefined
      ? message.correlation
      : this.currentCorrelation ?? this.correlation('worker_error');
    this.trace(
      'worker_to_host',
      subtype.kind,
      subtype.semanticSubtype,
      correlation,
    );
  }

  private receive(message: WorkerToHostMessage): void {
    this.noteWorkerSequenceReceived(message);
    try {
      this.receiveTrace(message);
    } catch {
      // A structured-clone payload can still be shape-invalid at runtime. Do not let a
      // malformed Worker envelope reach the Surface; retain the same admission/post-commit
      // distinction used by journal validation before making the generation unavailable.
      if (this.activeExecution !== undefined) {
        if (this.activeExecution.settlement === 'uncommitted') {
          this.handleJournalFailure({ code: 'history_invalid' });
        } else {
          this.activeExecution.postCommitObservationFailure = true;
          this.activeExecution.postCommitObservationError = 'history_invalid';
        }
      }
      if (this.activeExecution?.settlement !== 'uncommitted') {
        this.markUnavailable();
      }
      return;
    }
    // The acknowledgement response is observed after `execution_settled`, so its terminal
    // runtime event belongs to the post-commit protocol trace/artifact rather than the fenced
    // execution ledger. All provider/tool/context facts still have to cross the journal before
    // settlement and are rejected here if they arrive late.
    const postCommitTerminal = this.activeExecution !== undefined &&
      this.activeExecution.settlement !== 'uncommitted' &&
      (message.kind === 'worker_error' ||
        message.kind === 'runtime_event' &&
          message.event.kind === 'agent_event' &&
          message.event.event.kind === 'turn_end');
    // A malformed Worker fact must never be projected to the Surface after the journal
    // boundary rejected it. `appendJournal` also records whether this was a pre- or
    // post-commit observation failure so the committed outcome remains distinguishable.
    if (!postCommitTerminal && !this.appendWorkerObservation(message)) {
      // A final proposal with a malformed/missing context manifest still needs the dedicated
      // normal contract-failure settlement. The proposal is not projected to the Surface; it is
      // handed to the turn waiter after the failed journal append has poisoned pre-commit state.
      if (
        this.activeExecution?.settlement === 'uncommitted' &&
        (message.kind === 'commit_proposal' || message.kind === 'turn_failed')
      ) {
        this.flushObservationBuffer();
        this.messages.publish(message);
        return;
      }
      this.markUnavailable();
      return;
    }
    if (
      message.kind === 'provider_observation' &&
      message.observation.kind === 'request_start' &&
      message.observation.request.contextRequestOrdinal !== undefined
    ) {
      this.clearAuxiliaryStageWatchdog(
        this.activeExecution?.executionId,
        message.observation.request.contextRequestOrdinal,
      );
    }
    if (message.kind === 'provider_exact_request') return;
    if (message.kind === 'cancel_received') return;
    if (
      message.kind === 'commit_proposal' || message.kind === 'turn_failed' ||
      message.kind === 'worker_error' ||
      message.kind === 'runtime_event' &&
        message.event.kind === 'agent_event' &&
        message.event.event.kind === 'turn_end'
    ) this.clearCancellationWatchdog();
    if (message.kind === 'runtime_event') {
      if (
        message.event.kind === 'agent_event' &&
        message.event.event.kind === 'turn_end'
      ) {
        this.flushObservationBuffer();
        this.messages.publish(message);
      } else if (message.event.kind === 'agent_event') {
        this.deliver(message.event.event);
      }
      return;
    }
    if (message.kind === 'effect_observation') {
      this.deliver(message.effect);
      return;
    }
    if (
      message.kind === 'provider_observation' &&
      message.observation.kind === 'runtime_event'
    ) {
      const event = message.observation.event;
      const turn = message.turn;
      if (event.kind === 'assistant_progress') {
        this.deliver({ kind: 'assistant_progress', turn, text: event.text });
      } else if (event.kind === 'model_result') {
        const result = event.result;
        this.deliver({
          kind: 'assistant_message',
          turn,
          message: result.kind === 'final'
            ? {
              role: 'assistant',
              content: { kind: 'text', text: result.text },
              ...(result.providerState === undefined ? {} : {
                providerState: structuredClone(result.providerState),
              }),
            }
            : {
              role: 'assistant',
              content: result.calls.map((call) => ({
                kind: 'tool_call' as const,
                ...structuredClone(call),
              })),
              ...(result.text === undefined ? {} : { text: result.text }),
              ...(result.providerState === undefined ? {} : {
                providerState: structuredClone(result.providerState),
              }),
            },
        });
      } else if (event.kind === 'tool_call') {
        this.deliver({
          kind: 'tool_call',
          turn,
          call: structuredClone(event.call),
        });
      } else if (event.kind === 'tool_progress') {
        this.deliver({
          kind: 'tool_progress',
          turn,
          callId: event.callId,
          name: event.name,
          text: event.text,
        });
      } else if (event.kind === 'tool_result') {
        this.deliver({
          kind: 'tool_result',
          turn,
          result: structuredClone(event.result),
        });
      }
      return;
    }
    if (message.kind === 'context_observation') {
      const delta = message.observation.delta;
      if (delta.purpose === 'web_search') {
        this.scheduleAuxiliaryStageWatchdog(delta.requestOrdinal);
      }
      return;
    }
    if (message.kind === 'checkpoint_proposal') {
      void this.installCheckpoint(message);
      return;
    }
    this.flushObservationBuffer();
    this.messages.publish(message);
  }

  private appendJournal(input: ExecutionEventInput): boolean {
    const history = this.options.historyPersistence;
    if (history === undefined || this.activeExecution === undefined) {
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

  private handleJournalFailure(error: unknown): false {
    const code: HistoryJournalErrorCode = typeof error === 'object' && error !== null &&
        ((error as { readonly code?: unknown }).code === 'history_busy' ||
          (error as { readonly code?: unknown }).code === 'history_invalid' ||
          (error as { readonly code?: unknown }).code ===
            'history_io_failure')
      ? (error as {
        readonly code:
          | 'history_busy'
          | 'history_invalid'
          | 'history_io_failure';
      }).code
      : 'history_io_failure' as const;
    if (this.activeExecution !== undefined) {
      if (
        this.activeExecution.settlement === 'uncommitted'
      ) {
        if (this.activeExecution.journalFailureCode === undefined) {
          this.activeExecution.journalFailure = true;
          this.activeExecution.journalFailureCode = code;
          // Resolve the per-execution signal before terminating the generation. This remains
          // observable even when the append failed before submit() registered its waiter.
          this.activeExecution.journalFailureSignal.resolve(code);
        }
        this.generationNeedsReplacement = true;
        this.markUnavailable();
      } else {
        // The canonical transaction is already durable. Keep its result and make the
        // acknowledgement loss visible to the Surface without attempting a second settle.
        this.activeExecution.postCommitObservationFailure = true;
        this.activeExecution.postCommitObservationError = code;
      }
    }
    return false;
  }

  /**
   * Buffer one worker observation. The pure contract check runs here so a fact the journal
   * boundary would reject is never projected to the Surface; the durable write is deferred.
   */
  private bufferWorkerObservation(input: ExecutionEventInput): boolean {
    const history = this.options.historyPersistence;
    if (history === undefined || this.activeExecution === undefined) {
      return true;
    }
    if (!history.validateExecutionEvent(input)) {
      return this.handleJournalFailure({ code: 'history_invalid' });
    }
    this.observationBuffer.push(
      input.observedAt === undefined ? { ...input, observedAt: new Date().toISOString() } : input,
    );
    if (
      input.workerSequence !== undefined &&
      input.workerSequence > this.lastWorkerSequenceBuffered
    ) this.lastWorkerSequenceBuffered = input.workerSequence;
    if (this.observationBuffer.length >= OBSERVATION_FLUSH_BATCH) {
      return this.flushObservationBuffer();
    }
    this.scheduleObservationFlush();
    return true;
  }

  private scheduleObservationFlush(): void {
    if (this.observationFlushTimer !== undefined) return;
    this.observationFlushTimer = setTimeout(() => {
      this.observationFlushTimer = undefined;
      this.flushObservationBuffer();
    }, OBSERVATION_FLUSH_INTERVAL_MS);
  }

  private flushObservationBuffer(): boolean {
    if (this.observationFlushTimer !== undefined) {
      clearTimeout(this.observationFlushTimer);
      this.observationFlushTimer = undefined;
    }
    const history = this.options.historyPersistence;
    if (history === undefined || this.activeExecution === undefined) {
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
      for (const input of batch) {
        if (
          input.workerSequence !== undefined &&
          input.workerSequence > this.lastWorkerSequenceDurable
        ) this.lastWorkerSequenceDurable = input.workerSequence;
      }
      return true;
    } catch (error) {
      this.observationBuffer.length = 0;
      return this.handleJournalFailure(error);
    } finally {
      this.flushingObservations = false;
    }
  }

  private appendWorkerObservation(message: WorkerToHostMessage): boolean {
    if (this.activeExecution === undefined) return true;
    if (
      message.kind === 'ready' || message.kind === 'model_selected' ||
      message.kind === 'closed' || message.kind === 'checkpoint_proposal'
    ) return true;
    if (message.kind === 'provider_exact_request') {
      const history = this.options.historyPersistence;
      if (history?.appendExactRequestObservation === undefined) return true;
      if (!this.flushObservationBuffer()) return false;
      try {
        history.appendExactRequestObservation({
          executionId: this.activeExecution.executionId,
          workerSequence: message.sequence,
          observation: message.observation,
        });
        this.lastWorkerSequenceBuffered = Math.max(
          this.lastWorkerSequenceBuffered,
          message.sequence,
        );
        this.lastWorkerSequenceDurable = Math.max(
          this.lastWorkerSequenceDurable,
          message.sequence,
        );
        return true;
      } catch (error) {
        return this.handleJournalFailure(error);
      }
    }
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
        : message.observation.kind === 'response_bytes'
        ? 'provider_response_bytes' as const
        : message.observation.kind === 'sse_event'
        ? 'provider_sse_event' as const
        : message.observation.kind === 'parser_transition'
        ? 'provider_parser_transition' as const
        : 'runtime_event' as const
      : message.kind === 'context_observation'
      ? 'context_observation' as const
      : message.kind === 'cancel_received'
      ? 'cancel_received' as const
      : 'runtime_event' as const;
    const historyMessage = this.options.historyPersistence
      ?.prepareWorkerObservationForHistory?.(message) ?? message;
    return this.bufferWorkerObservation({
      executionId: this.activeExecution.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind,
      ...(workerSequence === undefined ? {} : { workerSequence }),
      payload: structuredClone(
        historyMessage,
      ) as unknown as ExecutionEventPayloadByKind[typeof kind],
    } as ExecutionEventInput);
  }

  private deliver(event: AgentEvent): void {
    if (this.options.eventSink === undefined) return;
    try {
      this.options.eventSink(structuredClone(event));
    } catch {
      // A pre-commit projection failure must stop the generation before it can propose or
      // continue effects. After durable commit, the caller still owns the committed outcome.
      this.markUnavailable();
    }
  }

  private markUnavailable(): void {
    if (this.observationFlushTimer !== undefined) {
      clearTimeout(this.observationFlushTimer);
      this.observationFlushTimer = undefined;
    }
    this.observationBuffer.length = 0;
    if (!this.unavailable) {
      this.unavailable = true;
      this.capsule.terminate();
    }
    this.messages.fail(new Error('Worker transport unavailable'));
  }

  private observeRequestCount(outcome: LoopOutcome): LoopOutcome {
    const count = outcome.runtimeProviderRequestCount;
    if (
      count !== undefined && Number.isSafeInteger(count) && count >= 0
    ) {
      const total = this.generationRequestBase + count;
      if (total >= this.runtimeRequestCount) this.runtimeRequestCount = total;
      return { ...outcome, runtimeProviderRequestCount: total };
    }
    return outcome;
  }

  requestCount(): number {
    return this.runtimeRequestCount;
  }

  consumeAutoCompactionNotice(): {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | null {
    const notice = this.autoCompactionNotice;
    this.autoCompactionNotice = undefined;
    return notice === undefined ? null : structuredClone(notice);
  }

  private async persistArtifacts(
    outcome: LoopOutcome,
    providerEvidence: ProviderEvidenceV1 | undefined,
    diagnostic: FailureDiagnosticV1 | undefined,
  ): Promise<LoopOutcome> {
    const evidenceId = providerEvidence?.evidenceId ??
      outcome.providerEvidenceId;
    let evidenceDurability = providerEvidence === undefined
      ? outcome.providerEvidenceDurability
      : 'unknown' as const;
    let evidenceError = outcome.providerEvidencePersistenceError;
    if (providerEvidence !== undefined) {
      if (this.options.providerEvidenceStore === undefined) {
        evidenceDurability = 'unknown';
      } else {
        try {
          const attributed = this.attributedEvidence(providerEvidence, outcome);
          if (attributed === undefined) {
            throw new Error('provider evidence unavailable');
          }
          await this.options.providerEvidenceStore.write(attributed);
          if (diagnostic?.diagnosticId !== undefined) {
            await this.options.providerEvidenceStore.linkDiagnostic(
              diagnostic.diagnosticId,
              providerEvidence.evidenceId,
            );
          }
          evidenceDurability = 'yes';
          evidenceError = undefined;
        } catch (error) {
          evidenceDurability = 'failed';
          evidenceError = persistenceCode(
            error,
            evidencePersistenceCodes,
            'provider_evidence_io_failure',
          );
        }
      }
    }
    let diagnosticDurability = outcome.diagnosticDurability;
    let diagnosticError = outcome.diagnosticPersistenceError;
    if (diagnostic !== undefined) {
      if (this.options.diagnosticPersistence === undefined) {
        diagnosticDurability = 'unknown';
      } else {
        try {
          await this.options.diagnosticPersistence(diagnostic);
          diagnosticDurability = 'yes';
          diagnosticError = undefined;
        } catch (error) {
          diagnosticDurability = 'failed';
          diagnosticError = persistenceCode(
            error,
            diagnosticPersistenceCodes,
            'diagnostic_io_failure',
          );
        }
      }
    }
    const settled = {
      ...outcome,
      ...(evidenceId === undefined ? {} : { providerEvidenceId: evidenceId }),
      ...(evidenceDurability === undefined ? {} : {
        providerEvidenceDurability: evidenceDurability,
      }),
      ...(evidenceError === undefined ? {} : {
        providerEvidencePersistenceError: evidenceError,
      }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(diagnosticDurability === undefined ? {} : { diagnosticDurability }),
      ...(diagnosticError === undefined ? {} : {
        diagnosticPersistenceError: diagnosticError,
      }),
    };
    return this.observeRequestCount(settled);
  }

  private attributedEvidence(
    evidence: ProviderEvidenceV1 | undefined,
    outcome: LoopOutcome,
  ): ProviderEvidenceV5 | undefined {
    if (evidence === undefined) return undefined;
    const base = {
      ...structuredClone(evidence),
      schemaVersion: 5 as const,
      sessionId: this.sessionId,
      build: structuredClone(this.build),
      definition: structuredClone(this.options.definition),
      capture: 'complete' as const,
      requests: evidence.requests.map((record, index) => ({
        ...structuredClone(record),
        request: {
          ...structuredClone(record.request),
          ...(record.request.contextRequestOrdinal === undefined &&
              this.currentStartupSnapshot?.context === undefined
            ? { contextRequestOrdinal: index + 1 }
            : record.request.contextRequestOrdinal === undefined
            ? {}
            : { contextRequestOrdinal: record.request.contextRequestOrdinal }),
        },
      })),
    };
    // The Worker recorder normally supplies this field. When a legacy/custom Worker omits it
    // while the startup basis is present, keep the malformed V5 shape visible so the history
    // store's strict validator rejects the settlement instead of fabricating a logical link.
    const asEvidence = (value: unknown): ProviderEvidenceV5 => value as ProviderEvidenceV5;
    switch (outcome.stopReason) {
      case 'final':
      case 'tool_terminal':
        return asEvidence({
          ...base,
          normalizedOutcome: 'completed',
          outcome: outcome.stopReason,
        });
      case 'cancelled':
        return asEvidence({
          ...base,
          normalizedOutcome: 'cancelled',
          outcome: 'cancelled',
        });
      case 'max_steps':
      case 'contract_failure':
        return asEvidence({
          ...base,
          normalizedOutcome: 'failed',
          outcome: outcome.stopReason,
        });
    }
  }

  private historyExecutionAttribution() {
    return {
      agent: this.options.agent,
      model: structuredClone(this.projection.modelSelection),
      build: structuredClone(this.build),
      definition: structuredClone(this.options.definition),
      ...(this.currentManifest === undefined ? {} : {
        manifest: structuredClone(this.currentManifest),
      }),
      instanceCorrelation: this.instanceCorrelation,
      workerGeneration: this.workerGeneration,
    };
  }

  private applyHistoryCapture(
    outcome: LoopOutcome,
    evidence: ProviderEvidenceV1 | undefined,
    diagnostic: FailureDiagnosticV1 | undefined,
    capture: HistoryCaptureResult,
  ): LoopOutcome {
    const settled: LoopOutcome = {
      ...outcome,
      ...(evidence === undefined ? {} : { providerEvidenceId: evidence.evidenceId }),
      ...(capture.evidenceDurability === undefined ? {} : {
        providerEvidenceDurability: capture.evidenceDurability,
      }),
      ...(capture.evidencePersistenceError === undefined ? {} : {
        providerEvidencePersistenceError: capture.evidencePersistenceError,
      }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(capture.diagnosticDurability === undefined ? {} : {
        diagnosticDurability: capture.diagnosticDurability,
      }),
      ...(capture.diagnosticPersistenceError === undefined ? {} : {
        diagnosticPersistenceError: capture.diagnosticPersistenceError,
      }),
    };
    return this.observeRequestCount(settled);
  }

  private async persistExecutionArtifact(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
  ): Promise<LoopOutcome> {
    if (execution.artifactWritten) {
      return this.withObservationFailure(execution, outcome);
    }
    execution.artifactWritten = true;
    const store = this.options.executionArtifactStore;
    const history = this.options.historyPersistence;
    if (
      (store === undefined && history === undefined) ||
      this.currentManifest === undefined
    ) {
      return this.withObservationFailure(execution, outcome);
    }
    const artifact = this.executionArtifact(execution, outcome);
    try {
      if (history !== undefined) history.recordPostCommitObservation(artifact);
      else await store!.write(artifact);
      return this.withObservationFailure(execution, {
        ...outcome,
        executionArtifactId: execution.executionId,
        executionArtifactDurability: 'yes',
        executionArtifactPersistenceError: undefined,
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null &&
          (error as { readonly code?: unknown }).code ===
            'worker_execution_artifact_invalid'
        ? 'worker_execution_artifact_invalid' as const
        : 'worker_execution_artifact_io_failure' as const;
      return this.withObservationFailure(execution, {
        ...outcome,
        executionArtifactId: execution.executionId,
        executionArtifactDurability: 'failed',
        executionArtifactPersistenceError: code,
      });
    }
  }

  private withObservationFailure(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
  ): LoopOutcome {
    return execution.postCommitObservationFailure !== true ? outcome : {
      ...outcome,
      executionObservationDurability: 'failed',
      executionObservationPersistenceError: execution.postCommitObservationError ??
        'history_io_failure',
    };
  }

  private executionArtifact(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
  ): WorkerExecutionArtifactV7 {
    if (this.currentManifest === undefined) {
      throw new Error('Worker manifest unavailable for execution artifact');
    }
    const canonicalAdoption = (this.options.historyPersistence === undefined ||
      this.options.durableCanonicalHistory === true) &&
      execution.committedStateRevision !== undefined;
    return {
      schemaVersion: 7,
      ...(this.currentManifest.tools === undefined ? {} : {
        tools: structuredClone(this.currentManifest.tools),
      }),
      contextCapture: execution.journalFailure === true
        ? 'failed'
        : execution.contextCapture ?? 'none',
      executionId: execution.executionId,
      createdAt: execution.createdAt,
      settledAt: new Date().toISOString(),
      sessionId: this.sessionId,
      turn: execution.turn,
      agent: this.options.agent,
      instanceCorrelation: this.instanceCorrelation,
      workerGeneration: this.workerGeneration,
      build: structuredClone(this.build),
      definition: structuredClone(this.options.definition),
      manifest: structuredClone(this.currentManifest),
      command: structuredClone(execution.command),
      ...(execution.recalledContext === undefined ? {} : {
        recall: {
          schemaVersion: 1,
          sourceExecutionId: execution.recalledContext.sourceExecutionId,
          projectedContext: recalledExecutionProjectionText(
            execution.recalledContext,
          ),
        },
      }),
      baseStateRevision: execution.baseStateRevision,
      ...(execution.proposedStateRevision === undefined ? {} : {
        proposedStateRevision: execution.proposedStateRevision,
      }),
      ...(!canonicalAdoption ? {} : {
        committedStateRevision: execution.committedStateRevision,
      }),
      // The bootstrap prefix is shared by generations, while an artifact's sequence is
      // deliberately local to this admitted turn. Preserve the observed order and correlation
      // without leaking the Host-wide trace counter into the durable per-turn contract.
      protocolTrace: execution.protocolTrace.map((entry, index) => ({
        ...structuredClone(entry),
        sequence: index + 1,
      })),
      ...(outcome.providerEvidenceId === undefined ? {} : {
        providerEvidenceId: outcome.providerEvidenceId,
      }),
      ...(outcome.providerEvidenceDurability === undefined ? {} : {
        providerEvidenceDurability: outcome.providerEvidenceDurability,
      }),
      ...(outcome.providerEvidencePersistenceError === undefined ? {} : {
        providerEvidencePersistenceError: outcome.providerEvidencePersistenceError,
      }),
      storeResult: execution.storeResult,
      ...(execution.storeError === undefined ? {} : { storeError: execution.storeError }),
      acknowledgement: execution.acknowledgement,
      settlement: execution.settlement,
      lifecycle: 'settled',
      normalizedOutcome: outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal'
        ? 'completed'
        : outcome.stopReason === 'cancelled'
        ? 'cancelled'
        : 'failed',
      adoption: canonicalAdoption ? 'canonical' : 'non_canonical',
      outcome: workerExecutionOutcome(outcome),
      effectCommitRelation: 'not_transactional',
      automaticReplay: false,
    };
  }

  /**
   * Keep an admitted execution inspectable when normal settlement rejects the Worker manifest.
   * The canonical transaction has not committed in this path, so the row is deliberately
   * settled as failed/non-canonical with a Host-owned contract outcome; no untrusted evidence
   * or malformed final manifest is reused.
   */
  private settleHistoryFailure(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
    diagnostic: FailureDiagnosticV1 | undefined,
    providerEvidence?: ProviderEvidenceV1,
    evidenceOutcome: LoopOutcome = outcome,
  ): LoopOutcome | undefined {
    const history = this.options.historyPersistence;
    if (history === undefined) return undefined;
    execution.journalFailure = true;
    execution.contextCapture = 'failed';
    try {
      let capturedOutcome: LoopOutcome | undefined;
      const capture = history.settleNonCanonicalExecution({
        taskId: execution.taskId,
        executionId: execution.executionId,
        createdAt: execution.createdAt,
        sessionCorrelation: this.sessionId,
        ...(this.options.durableCanonicalHistory === true
          ? { canonicalSessionId: this.sessionId }
          : {}),
        turn: execution.turn,
        task: execution.command.task,
        baseStateRevision: execution.baseStateRevision,
        ...this.historyExecutionAttribution(),
        outcome,
        ...(providerEvidence === undefined ? {} : {
          evidence: this.attributedEvidence(providerEvidence, evidenceOutcome),
        }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
        artifactForCapture: (captured) => {
          capturedOutcome = this.applyHistoryCapture(
            outcome,
            providerEvidence,
            diagnostic,
            captured,
          );
          return this.executionArtifact(execution, capturedOutcome);
        },
      });
      const settled = capturedOutcome ?? this.applyHistoryCapture(
        outcome,
        providerEvidence,
        diagnostic,
        capture,
      );
      execution.artifactWritten = true;
      return {
        ...settled,
        executionArtifactId: execution.executionId,
        executionArtifactDurability: 'yes',
        executionArtifactPersistenceError: undefined,
      };
    } catch {
      return undefined;
    }
  }

  private contextContractDiagnostic(
    execution: ActiveWorkerExecution,
    providerEvidence?: ProviderEvidenceV1,
    outcome?: LoopOutcome,
  ): FailureDiagnosticV1 {
    const providerRequestCount = outcome?.turnProviderRequestCount ??
      providerEvidence?.requests.length ?? this.runtimeRequestCount;
    return createFailureDiagnostic({
      stage: 'session_commit',
      code: 'commit_error',
      lane: this.options.agent === 'planner' ? 'planner' : 'parent',
      providerRequestCount,
      turnNumber: execution.turn,
      modelStep: 0,
      retryCount: 0,
    });
  }

  private async settleExecution(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
    providerEvidence: ProviderEvidenceV1 | undefined,
    diagnostic: FailureDiagnosticV1 | undefined,
    contextManifest?: ExecutionContextManifestV2,
  ): Promise<LoopOutcome> {
    const terminalSnapshotDurable = this.recordWorkerStageSnapshot('terminal');
    const effectiveOutcome = !terminalSnapshotDurable &&
        execution.settlement === 'uncommitted'
      ? this.journalFailureOutcome(execution, outcome.task)
      : outcome;
    if (this.options.historyPersistence !== undefined) {
      try {
        let capturedOutcome: LoopOutcome | undefined;
        const capture = this.options.historyPersistence
          .settleNonCanonicalExecution({
            taskId: execution.taskId,
            executionId: execution.executionId,
            createdAt: execution.createdAt,
            sessionCorrelation: this.sessionId,
            ...(this.options.durableCanonicalHistory === true
              ? { canonicalSessionId: this.sessionId }
              : {}),
            turn: execution.turn,
            task: execution.command.task,
            baseStateRevision: execution.baseStateRevision,
            ...this.historyExecutionAttribution(),
            ...(execution.recalledContext === undefined ? {} : {
              recalledContext: execution.recalledContext,
            }),
            ...(contextManifest === undefined ? {} : { contextManifest }),
            ...(this.currentStartupSnapshot?.context === undefined ? {} : {
              contextSnapshot: this.currentStartupSnapshot.context,
            }),
            outcome: effectiveOutcome,
            ...(providerEvidence === undefined ? {} : {
              evidence: this.attributedEvidence(
                providerEvidence,
                effectiveOutcome,
              ),
            }),
            ...(diagnostic === undefined ? {} : { diagnostic }),
            artifactForCapture: (captured) => {
              capturedOutcome = this.applyHistoryCapture(
                effectiveOutcome,
                providerEvidence,
                diagnostic,
                captured,
              );
              execution.contextCapture = captured.contextDurability === 'partial'
                ? 'failed'
                : captured.contextDurability;
              return this.executionArtifact(execution, capturedOutcome);
            },
          });
        const settled = capturedOutcome ?? this.applyHistoryCapture(
          effectiveOutcome,
          providerEvidence,
          diagnostic,
          capture,
        );
        execution.artifactWritten = true;
        return {
          ...settled,
          executionArtifactId: execution.executionId,
          executionArtifactDurability: 'yes',
          executionArtifactPersistenceError: undefined,
        };
      } catch (error) {
        const busy = typeof error === 'object' && error !== null &&
          (error as { readonly code?: unknown }).code === 'history_busy';
        if (
          typeof error === 'object' && error !== null &&
          (error as { readonly code?: unknown }).code === 'history_invalid'
        ) {
          const failedSettlement = this.settleHistoryFailure(
            execution,
            failedOutcome(
              effectiveOutcome.task,
              this.projection.transcript,
              'durable execution settlement failed',
            ),
            diagnostic ??
              this.contextContractDiagnostic(
                execution,
                providerEvidence,
                effectiveOutcome,
              ),
            providerEvidence,
            effectiveOutcome,
          );
          if (failedSettlement !== undefined) return failedSettlement;
        }
        const failed: LoopOutcome = {
          ...effectiveOutcome,
          ...(providerEvidence === undefined ? {} : {
            providerEvidenceId: providerEvidence.evidenceId,
            providerEvidenceDurability: 'failed',
            providerEvidencePersistenceError: 'provider_evidence_io_failure',
          }),
          ...(diagnostic === undefined ? {} : {
            diagnostic,
            diagnosticDurability: 'failed',
            diagnosticPersistenceError: busy ? 'diagnostic_busy' : 'diagnostic_io_failure',
          }),
        };
        return await this.persistExecutionArtifact(execution, failed);
      }
    }
    const settled = await this.persistArtifacts(
      effectiveOutcome,
      providerEvidence,
      diagnostic,
    );
    return await this.persistExecutionArtifact(execution, settled);
  }

  private journalFailureOutcome(
    execution: ActiveWorkerExecution,
    task: string,
  ): LoopOutcome {
    const code = execution.journalFailureCode ?? 'history_io_failure';
    return {
      ...failedOutcome(
        task,
        this.projection.transcript,
        `durable execution journal failed: ${code}`,
      ),
      executionJournalDurability: 'failed',
      executionJournalPersistenceError: code,
    };
  }

  private async finishJournalFailure(
    execution: ActiveWorkerExecution,
    task: string,
    providerEvidence?: ProviderEvidenceV1,
    diagnostic?: FailureDiagnosticV1,
    contextManifest?: ExecutionContextManifestV2,
  ): Promise<LoopOutcome> {
    const settled = await this.settleExecution(
      execution,
      this.journalFailureOutcome(execution, task),
      providerEvidence,
      diagnostic,
      contextManifest,
    );
    this.deliver(turnEndFromOutcome(this.projection.nextTurn, settled, false));
    return settled;
  }

  private admissionSessionRecord(): SessionRecordV6 | undefined {
    if (this.options.handle.record !== undefined) return undefined;
    if (this.options.durableCanonicalHistory !== true) return undefined;
    const record: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: this.createdAt,
      title: null,
      stateRevision: this.projection.stateRevision,
      nextTurn: this.projection.nextTurn,
      transcript: [],
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.projection.modelSelection),
      modelChanges: structuredClone(this.projection.modelChanges),
      turnModels: [],
      turnExecutions: [],
    };
    if (!validateSessionRecordV6(record)) {
      throw new Error('empty session record invalid');
    }
    return record;
  }

  private correlation(command: string): WorkerCorrelation {
    return {
      session: this.sessionId,
      instanceCorrelation: this.instanceCorrelation,
      workerGeneration: this.workerGeneration,
      baseStateRevision: this.projection.stateRevision,
      command,
    };
  }

  private async start(): Promise<void> {
    const correlation = this.correlation('start');
    const readyPromise = this.messages.wait((
      message,
    ): message is WorkerReadyMessage | WorkerErrorMessage =>
      (message.kind === 'ready' &&
        sameCorrelation(message.correlation, correlation)) ||
      (message.kind === 'worker_error' &&
        (message.correlation === undefined ||
          sameCorrelation(message.correlation, correlation))), 5_000);
    let revision: WorkerDefinitionLoadRequest;
    if (this.options.loadDescriptor !== undefined) {
      revision = this.options.loadDescriptor;
    } else if (this.options.modulePath !== undefined) {
      revision = await readWorkerModuleRevision(this.options.modulePath);
    } else {
      throw new WorkerHostStartupError(
        'module_invalid',
        'module_pre_read',
        'Worker Definition physical descriptor is unavailable',
      );
    }
    this.currentCorrelation = correlation;
    try {
      this.send({
        kind: 'start',
        correlation,
        module: revision,
        ...(this.options.toolDefinitions === undefined
          ? {}
          : { toolDefinitions: this.options.toolDefinitions }),
        workspaceRoot: this.options.workspaceRoot,
        physicalIoMode: this.options.physicalIoMode ?? 'production',
        rootRole: this.options.agent === 'planner' ? 'planner' : 'parent',
        ...(this.options.rootMaxSteps === undefined
          ? {}
          : { rootMaxSteps: this.options.rootMaxSteps }),
        ...(this.options.providerTimeoutMs === undefined
          ? {}
          : { providerTimeoutMs: this.options.providerTimeoutMs }),
        diagnosticStageBuffer: this.stageProbeBuffer,
        initialTranscript: this.projection.transcript,
        nextTurn: this.projection.nextTurn,
        ...(this.projection.checkpoint === undefined
          ? {}
          : { checkpoint: this.projection.checkpoint }),
        modelSelection: this.projection.modelSelection,
        ...(this.options.baseInstruction === undefined
          ? {}
          : { baseInstruction: this.options.baseInstruction }),
        ...(this.options.providerDeclarations === undefined
          ? {}
          : { providerDeclarations: this.options.providerDeclarations }),
      });
    } catch {
      this.markUnavailable();
      throw new Error('Worker transport unavailable');
    }
    try {
      const ready = await readyPromise;
      if (ready.kind === 'worker_error') {
        throw new WorkerHostStartupError(
          ready.stage === 'module_pre_read' ? 'module_invalid' : 'definition_evaluation_failed',
          ready.stage,
          ready.message,
        );
      }
      const expectedRole = this.options.agent === 'planner' ? 'planner' : 'parent';
      if (
        ready.manifest !== undefined && ready.manifest.role !== expectedRole
      ) {
        throw new WorkerHostStartupError(
          'role_mismatch',
          'module_validation',
          'Worker Definition effective role did not match its declared role',
        );
      }
      if (
        ready.manifest === undefined ||
        !sameModelSelection(
          ready.manifest.rootModel,
          this.projection.modelSelection,
        ) ||
        ready.manifest.profileId !==
          modelRouteProfileId(this.projection.modelSelection) ||
        !validBaseInstructionManifest(
          ready.manifest.baseInstruction,
          this.options.baseInstruction,
        ) ||
        !validToolManifest(
          ready.manifest.tools,
          this.options.toolDefinitions,
        ) ||
        (this.options.rootMaxSteps !== undefined &&
          ready.manifest.maxSteps !== this.options.rootMaxSteps) ||
        !validStartupSnapshot(ready.startupSnapshot) ||
        !validCredentialAvailability(
          ready.credentialAvailability,
          this.projection.modelSelection,
        )
      ) {
        throw new WorkerHostStartupError(
          'manifest_invalid',
          'module_validation',
          'Worker manifest did not match Host selection',
        );
      }
      this.currentManifest = ready.manifest;
      this.currentStartupSnapshot = ready.startupSnapshot;
      this.credentialAvailability = structuredClone(
        ready.credentialAvailability,
      );
    } finally {
      this.currentCorrelation = undefined;
    }
  }

  private installCheckpoint(message: WorkerCheckpointProposalMessage): void {
    let accepted = false;
    try {
      if (
        this.currentCorrelation === undefined || !this.active ||
        !sameCorrelation(message.correlation, this.currentCorrelation) ||
        !validateSemanticContextCheckpoint(message.checkpoint) ||
        this.currentManifest === undefined ||
        !profileIdPattern.test(this.currentManifest.profileId) ||
        message.checkpoint.sessionId !== this.sessionId ||
        message.checkpoint.sourceProfileId !== this.currentManifest.profileId
      ) throw new Error('checkpoint correlation invalid');
      const completedTurns = indexSessionHistory(this.projection.transcript)?.turns.length ?? 0;
      if (
        message.checkpoint.coveredThroughTurn < 1 ||
        message.checkpoint.coveredThroughTurn >= completedTurns ||
        message.checkpoint.retainedFromTurn !==
          message.checkpoint.coveredThroughTurn + 1
      ) throw new Error('checkpoint boundary invalid');
      this.options.handle.installCheckpoint(message.checkpoint);
      this.projection.checkpoint = structuredClone(message.checkpoint);
      const notice = {
        coveredThroughTurn: message.checkpoint.coveredThroughTurn,
        retainedFromTurn: message.checkpoint.retainedFromTurn,
      };
      accepted = true;
      try {
        this.send({
          kind: 'checkpoint_acknowledgement',
          correlation: message.correlation,
          accepted,
        });
        // Only an acknowledgement that was delivered to the generation may publish the
        // notice. The held turn has not started when this method returns.
        this.autoCompactionNotice = notice;
      } catch {
        this.autoCompactionNotice = undefined;
        this.markUnavailable();
      }
      return;
    } catch {
      accepted = false;
    }
    try {
      this.send({
        kind: 'checkpoint_acknowledgement',
        correlation: message.correlation,
        accepted,
      });
    } catch {
      this.autoCompactionNotice = undefined;
      this.markUnavailable();
    }
  }

  private proposalRecord(
    proposal: WorkerCommitProposalMessage,
  ): SessionRecordV6 | undefined {
    const committedTurn = proposal.nextTurn - 1;
    const record: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      title: this.projection.title,
      stateRevision: this.projection.stateRevision + 1,
      nextTurn: proposal.nextTurn,
      transcript: structuredClone(proposal.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.projection.modelSelection),
      modelChanges: structuredClone(this.projection.modelChanges),
      turnModels: [
        ...structuredClone(this.projection.turnModels),
        {
          turn: proposal.nextTurn - 1,
          selection: structuredClone(this.projection.modelSelection),
        },
      ],
      turnExecutions: [
        ...structuredClone(this.projection.turnExecutions),
        {
          turn: committedTurn,
          build: structuredClone(this.build),
          definition: structuredClone(this.options.definition),
        },
      ],
    };
    return validateSessionRecordV6(record) ? record : undefined;
  }

  async selectModel(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'> {
    if (this.closed) return 'unavailable';
    try {
      await this.ensureGeneration();
    } catch {
      return 'unavailable';
    }
    if (this.active || this.currentCorrelation !== undefined) return 'busy';
    if (!isModelSelection(selection)) {
      throw new RangeError('invalid model selection');
    }
    if (sameModelSelection(this.projection.modelSelection, selection)) {
      return 'unchanged';
    }
    const changedAt = new Date().toISOString();
    const nextChanges: SessionModelChange[] = [
      ...structuredClone(this.projection.modelChanges),
      {
        effectiveFromTurn: this.projection.nextTurn,
        changedAt,
        selection: structuredClone(selection),
      },
    ];
    const nextRevision = this.projection.stateRevision + 1;
    const persisted: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: changedAt,
      title: this.projection.title,
      stateRevision: nextRevision,
      nextTurn: this.projection.nextTurn,
      transcript: structuredClone(this.projection.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(selection),
      modelChanges: nextChanges,
      turnModels: structuredClone(this.projection.turnModels),
      turnExecutions: structuredClone(this.projection.turnExecutions),
    };
    if (!validateSessionRecordV6(persisted)) {
      throw new Error('model selection record invalid');
    }
    this.options.handle.commit(persisted);
    const correlation: WorkerCorrelation = {
      ...this.correlation('select-model-' + crypto.randomUUID().toLowerCase()),
      baseStateRevision: nextRevision,
    };
    this.currentCorrelation = correlation;
    try {
      const response = this.messages.wait(
        (
          value,
        ): value is WorkerModelSelectedMessage | WorkerErrorMessage =>
          (value.kind === 'model_selected' || value.kind === 'worker_error') &&
          (value.kind === 'worker_error' ||
            sameCorrelation(value.correlation, correlation)),
        this.workerResponseTimeoutMs(),
      );
      this.send({ kind: 'select_model', correlation, selection });
      const message = await response;
      if (
        message.kind === 'worker_error' || !message.accepted ||
        message.manifest === undefined ||
        !sameModelSelection(message.manifest.rootModel, selection) ||
        message.manifest.profileId !== modelRouteProfileId(selection) ||
        !validCredentialAvailability(message.credentialAvailability, selection)
      ) throw new Error('Worker rejected model selection');
      this.currentManifest = message.manifest;
      this.credentialAvailability = structuredClone(
        message.credentialAvailability,
      );
      this.projection.modelSelection = structuredClone(selection);
      this.projection.modelChanges = nextChanges;
      this.projection.stateRevision = nextRevision;
      return 'selected';
    } catch (error) {
      this.options.handle.rollback();
      this.markUnavailableForReplacement();
      throw error;
    } finally {
      this.currentCorrelation = undefined;
    }
  }

  renameTitle(
    value: string,
  ): 'renamed' | 'unchanged' | 'busy' | 'unavailable' {
    if (this.closed || this.unavailable) return 'unavailable';
    if (this.active || this.currentCorrelation !== undefined) return 'busy';
    const title = normalizeSessionTitle(value);
    if (title.length === 0 || title === this.projection.title) {
      return 'unchanged';
    }
    const changedAt = new Date().toISOString();
    const nextRevision = this.projection.stateRevision + 1;
    const persisted: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: changedAt,
      title,
      stateRevision: nextRevision,
      nextTurn: this.projection.nextTurn,
      transcript: structuredClone(this.projection.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.projection.modelSelection),
      modelChanges: structuredClone(this.projection.modelChanges),
      turnModels: structuredClone(this.projection.turnModels),
      turnExecutions: structuredClone(this.projection.turnExecutions),
    };
    if (!validateSessionRecordV6(persisted)) {
      throw new Error('session title record invalid');
    }
    this.options.handle.commit(persisted);
    this.projection.title = title;
    this.projection.stateRevision = nextRevision;
    return 'renamed';
  }

  async prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }> {
    if (
      this.closed || this.unavailable ||
      this.options.executionArtifactStore === undefined &&
        this.options.historyPersistence === undefined
    ) {
      throw new WorkerRecallSelectionError('unavailable');
    }
    if (this.active || this.currentCorrelation !== undefined) {
      throw new WorkerRecallSelectionError('busy');
    }
    let selectedExecutionId: string | undefined;
    try {
      if (this.options.historyPersistence !== undefined) {
        const sourceRows = this.options.historyPersistence.listExecutionsForSession?.(
          this.sessionId,
        ) ?? this.options.historyPersistence.listExecutions();
        const rows = sourceRows.filter((
          row,
        ) =>
          row.lifecycle === 'settled' && row.adoption === 'non_canonical' &&
          ['cancelled', 'failed', 'interrupted', 'unknown'].includes(
            row.outcome,
          ) &&
          (row.canonicalSessionId === this.sessionId ||
            (row.canonicalSessionId === undefined &&
              row.sessionCorrelation === this.sessionId))
        );
        const eligible = [...rows].sort((left, right) => {
          const leftAt = left.settledAt ?? left.createdAt;
          const rightAt = right.settledAt ?? right.createdAt;
          return leftAt === rightAt
            ? left.executionId.localeCompare(right.executionId)
            : leftAt.localeCompare(rightAt);
        });
        if (id === undefined) {
          selectedExecutionId = eligible.at(-1)?.executionId;
        } else {
          const matches = eligible.filter((row) => row.executionId.startsWith(id));
          if (matches.length > 1) {
            throw new WorkerRecallSelectionError('ambiguous');
          }
          selectedExecutionId = matches[0]?.executionId;
        }
      } else {
        const artifacts = await this.options.executionArtifactStore!.list();
        const eligible = artifacts.filter((artifact) =>
          artifact.sessionId === this.sessionId &&
          (artifact.settlement === 'uncommitted' ||
            artifact.settlement === 'interrupted' ||
            artifact.settlement === 'unknown')
        );
        let selected: (typeof eligible)[number] | undefined;
        if (id === undefined) {
          selected = [...eligible].sort((left, right) =>
            left.settledAt === right.settledAt
              ? left.executionId.localeCompare(right.executionId)
              : left.settledAt.localeCompare(right.settledAt)
          ).at(-1);
        } else {
          const matches = eligible.filter((artifact) => artifact.executionId.startsWith(id));
          if (matches.length > 1) {
            throw new WorkerRecallSelectionError('ambiguous');
          }
          selected = matches[0];
        }
        selectedExecutionId = selected?.executionId;
      }
    } catch (error) {
      if (error instanceof WorkerRecallSelectionError) throw error;
      throw new WorkerRecallSelectionError('failed');
    }
    if (this.closed || this.unavailable) {
      throw new WorkerRecallSelectionError('unavailable');
    }
    if (this.active || this.currentCorrelation !== undefined) {
      throw new WorkerRecallSelectionError('busy');
    }
    if (selectedExecutionId === undefined) {
      throw new WorkerRecallSelectionError('not_found');
    }
    let recalled: RecalledExecutionContext;
    try {
      recalled = await resolveRecalledExecutionContext({
        sessionId: this.sessionId,
        executionId: selectedExecutionId,
        ...(this.options.executionArtifactStore === undefined ? {} : {
          executionArtifactStore: this.options.executionArtifactStore,
        }),
        providerEvidenceStore: this.options.providerEvidenceStore,
        ...(this.options.historyPersistence === undefined ? {} : {
          historyPersistence: this.options.historyPersistence,
        }),
      });
    } catch {
      throw new WorkerRecallSelectionError('failed');
    }
    if (this.closed || this.unavailable) {
      throw new WorkerRecallSelectionError('unavailable');
    }
    if (this.active || this.currentCorrelation !== undefined) {
      throw new WorkerRecallSelectionError('busy');
    }
    this.pendingRecall = structuredClone(recalled);
    return {
      sourceExecutionId: recalled.sourceExecutionId,
      evidence: recalled.evidence,
    };
  }

  clearPendingRecall(): boolean {
    const present = this.pendingRecall !== undefined;
    this.pendingRecall = undefined;
    return present;
  }

  async submit(
    task: string,
    recalledContext?: RecalledExecutionContext,
  ): Promise<LoopOutcome> {
    if (this.closed) {
      throw new Error('agent session unavailable');
    }
    await this.ensureGeneration();
    if (this.active) throw new Error('agent session is busy');
    if (typeof task !== 'string' || task.trim().length === 0) {
      throw new RangeError('user text must not be blank');
    }
    const admittedRecall = recalledContext ?? this.pendingRecall;
    if (
      admittedRecall !== undefined &&
      (admittedRecall.sessionId !== this.sessionId ||
        (admittedRecall.schemaVersion === 1
          ? admittedRecall.settlement !== 'uncommitted'
          : admittedRecall.lifecycle !== 'settled'))
    ) {
      throw new RangeError(
        'recalled execution context does not match current Session',
      );
    }
    if (recalledContext === undefined) this.pendingRecall = undefined;
    this.clearAuxiliaryStageWatchdog();
    this.lastAuxiliaryContextRequestOrdinal = undefined;
    this.active = true;
    const correlation = this.correlation(
      `turn-${this.projection.nextTurn}-${crypto.randomUUID().toLowerCase()}`,
    );
    this.currentCorrelation = correlation;
    this.stageProbeEpoch = this.stageProbeEpoch >= 0x7fff_ffff ? 1 : this.stageProbeEpoch + 1;
    try {
      beginWorkerStageProbeEpoch(this.stageProbeBuffer, this.stageProbeEpoch);
    } catch {
      // Diagnostics never narrow or fail turn admission.
    }
    const execution: ActiveWorkerExecution = {
      taskId: crypto.randomUUID().toLowerCase(),
      executionId: crypto.randomUUID().toLowerCase(),
      createdAt: new Date().toISOString(),
      turn: this.projection.nextTurn,
      command: {
        kind: 'turn',
        correlation: structuredClone(correlation),
        task,
      },
      ...(admittedRecall === undefined ? {} : {
        recalledContext: structuredClone(admittedRecall),
      }),
      baseStateRevision: this.projection.stateRevision,
      stageProbeEpoch: this.stageProbeEpoch,
      protocolTrace: [...this.bootstrapTrace],
      storeResult: 'not_attempted',
      acknowledgement: 'not_sent',
      settlement: 'uncommitted',
      artifactWritten: false,
      journalFailureSignal: createJournalFailureSignal(),
      stageSnapshotKeys: new Set(),
    };
    this.activeExecution = execution;
    try {
      if (this.options.historyPersistence !== undefined) {
        try {
          await this.options.historyPersistence.beginExecution({
            taskId: execution.taskId,
            executionId: execution.executionId,
            createdAt: execution.createdAt,
            sessionCorrelation: this.sessionId,
            sessionMode: this.options.durableCanonicalHistory === true
              ? 'persistent'
              : 'no_session',
            ...(this.options.durableCanonicalHistory === true
              ? { canonicalSessionId: this.sessionId }
              : {}),
            turn: execution.turn,
            task,
            baseStateRevision: execution.baseStateRevision,
            ...this.historyExecutionAttribution(),
            ...(this.admissionSessionRecord() === undefined
              ? {}
              : { sessionRecord: this.admissionSessionRecord() }),
            ...(this.currentStartupSnapshot?.context === undefined
              ? {}
              : { contextSnapshot: this.currentStartupSnapshot.context }),
          });
        } catch (error) {
          const historyFailure = typeof error === 'object' && error !== null &&
              ((error as { readonly code?: unknown }).code === 'history_busy' ||
                (error as { readonly code?: unknown }).code ===
                  'history_invalid' ||
                (error as { readonly code?: unknown }).code ===
                  'history_io_failure')
            ? (error as {
              readonly code:
                | 'history_busy'
                | 'history_invalid'
                | 'history_io_failure';
            }).code
            : 'history_io_failure' as const;
          execution.storeResult = 'failed';
          execution.storeError = historyFailure === 'history_busy'
            ? 'history_busy'
            : historyFailure === 'history_invalid'
            ? 'session_invalid'
            : 'session_io_failure';
          const failed: LoopOutcome = {
            ...failedOutcome(
              task,
              this.projection.transcript,
              `durable execution admission failed: ${historyFailure}`,
            ),
            executionAdmissionDurability: 'failed',
            executionAdmissionPersistenceError: historyFailure,
          };
          this.deliver(
            turnEndFromOutcome(this.projection.nextTurn, failed, false),
          );
          return failed;
        }
      }
      try {
        this.send({
          kind: 'turn',
          correlation,
          task,
          ...(admittedRecall === undefined ? {} : {
            recalledContext: structuredClone(admittedRecall),
          }),
        });
        const dispatchJournaled = this.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'turn_dispatch_sent',
          payload: { task },
        });
        if (!dispatchJournaled) {
          return await this.finishJournalFailure(execution, task);
        }
      } catch {
        this.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'turn_dispatch_failed',
          payload: { task },
        });
        this.markUnavailable();
        const outcome = failedOutcome(
          task,
          this.projection.transcript,
          'Worker transport unavailable',
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          undefined,
          undefined,
        );
        this.deliver(
          turnEndFromOutcome(this.projection.nextTurn, settled, false),
        );
        return settled;
      }
      const terminal = await Promise.race([
        this.messages.wait((
          value,
        ): value is
          | WorkerCommitProposalMessage
          | Extract<WorkerToHostMessage, { kind: 'turn_failed' }>
          | WorkerErrorMessage =>
          (value.kind === 'commit_proposal' || value.kind === 'turn_failed' ||
            value.kind === 'worker_error') &&
          (value.kind === 'worker_error' ||
            sameCorrelation(value.correlation, correlation))
        ).then((message) => ({ kind: 'worker' as const, message })),
        execution.journalFailureSignal.promise.then((code) => ({
          kind: 'journal_failure' as const,
          code,
        })),
      ]);
      if (terminal.kind === 'journal_failure') {
        return await this.finishJournalFailure(execution, task);
      }
      const message = terminal.message;
      if (message.kind === 'turn_failed') {
        const diagnostic = message.diagnostic ?? message.outcome.diagnostic;
        const settled = await this.settleExecution(
          execution,
          message.outcome,
          message.providerEvidence,
          diagnostic,
          message.contextManifest,
        );
        if (
          diagnostic?.stage === 'cancellation_cleanup' &&
          diagnostic.code === 'cleanup_error'
        ) this.markUnavailable();
        this.deliver(
          turnEndFromOutcome(this.projection.nextTurn, settled, false),
        );
        return settled;
      }
      if (message.kind === 'worker_error') {
        this.markUnavailable();
        const outcome = failedOutcome(
          task,
          this.projection.transcript,
          message.message,
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          undefined,
          undefined,
        );
        this.deliver(
          turnEndFromOutcome(this.projection.nextTurn, settled, false),
        );
        return settled;
      }
      if (!sameCorrelation(message.correlation, correlation)) {
        throw new Error('commit proposal correlation invalid');
      }
      if (execution.journalFailureCode !== undefined) {
        // A pre-commit observation gap must not be promoted to canonical history.
        this.sendCommitAcknowledgement(execution, correlation, false);
        return await this.finishJournalFailure(
          execution,
          task,
          message.providerEvidence,
          message.diagnostic,
          message.contextManifest,
        );
      }
      const record = this.proposalRecord(message);
      if (record === undefined) {
        if (!this.sendCommitAcknowledgement(execution, correlation, false)) {
          this.markUnavailable();
        }
        const outcome = failedOutcome(
          task,
          this.projection.transcript,
          'commit proposal invalid',
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          message.providerEvidence,
          message.diagnostic,
          message.contextManifest,
        );
        this.deliver(
          turnEndFromOutcome(this.projection.nextTurn, settled, false),
        );
        return settled;
      }
      const proposedOutcome = message.outcome === undefined
        ? proposalOutcome(task, message.transcript, undefined)
        : {
          ...structuredClone(message.outcome),
          task,
          transcript: structuredClone(message.transcript),
        };
      const diagnostic = message.diagnostic ?? proposedOutcome.diagnostic;
      execution.proposedStateRevision = record.stateRevision;
      let committed: LoopOutcome;
      try {
        if (
          this.options.historyPersistence !== undefined &&
          this.options.durableCanonicalHistory === true
        ) {
          if (!this.recordWorkerStageSnapshot('terminal')) {
            return await this.finishJournalFailure(
              execution,
              task,
              message.providerEvidence,
              diagnostic,
              message.contextManifest,
            );
          }
          const capture = this.options.historyPersistence.commitCanonicalTurn({
            taskId: execution.taskId,
            executionId: execution.executionId,
            createdAt: execution.createdAt,
            sessionCorrelation: this.sessionId,
            canonicalSessionId: this.sessionId,
            turn: execution.turn,
            task,
            baseStateRevision: execution.baseStateRevision,
            ...this.historyExecutionAttribution(),
            ...(execution.recalledContext === undefined ? {} : {
              recalledContext: execution.recalledContext,
            }),
            contextManifest: message.contextManifest,
            ...(this.currentStartupSnapshot?.context === undefined ? {} : {
              contextSnapshot: this.currentStartupSnapshot.context,
            }),
            record,
            outcome: proposedOutcome,
            ...(message.providerEvidence === undefined ? {} : {
              evidence: this.attributedEvidence(
                message.providerEvidence,
                proposedOutcome,
              ),
            }),
            ...(diagnostic === undefined ? {} : { diagnostic }),
            artifactForCapture: (captured) => {
              const capturedOutcome = this.applyHistoryCapture(
                proposedOutcome,
                message.providerEvidence,
                diagnostic,
                captured,
              );
              execution.contextCapture = captured.contextDurability === 'partial'
                ? 'failed'
                : captured.contextDurability;
              return this.executionArtifact({
                ...execution,
                contextCapture: captured.contextDurability === 'partial'
                  ? 'failed'
                  : captured.contextDurability,
                committedStateRevision: record.stateRevision,
                storeResult: 'committed',
                acknowledgement: 'not_sent',
                settlement: 'committed_observation_pending',
              }, capturedOutcome);
            },
          });
          if (this.options.handle.acceptCommitted === undefined) {
            throw new Error(
              'SQLite history handle cannot accept an atomic commit',
            );
          }
          this.options.handle.acceptCommitted(record);
          execution.settlement = 'committed_observation_pending';
          committed = this.applyHistoryCapture(
            proposedOutcome,
            message.providerEvidence,
            diagnostic,
            capture,
          );
        } else {
          this.options.handle.commit(record);
          if (this.options.historyPersistence !== undefined) {
            let capturedOutcome: LoopOutcome | undefined;
            const capture = this.options.historyPersistence
              .settleNonCanonicalExecution({
                taskId: execution.taskId,
                executionId: execution.executionId,
                createdAt: execution.createdAt,
                sessionCorrelation: this.sessionId,
                turn: execution.turn,
                task,
                baseStateRevision: execution.baseStateRevision,
                ...this.historyExecutionAttribution(),
                ...(execution.recalledContext === undefined ? {} : {
                  recalledContext: execution.recalledContext,
                }),
                contextManifest: message.contextManifest,
                ...(this.currentStartupSnapshot?.context === undefined ? {} : {
                  contextSnapshot: this.currentStartupSnapshot.context,
                }),
                outcome: proposedOutcome,
                ...(message.providerEvidence === undefined ? {} : {
                  evidence: this.attributedEvidence(
                    message.providerEvidence,
                    proposedOutcome,
                  ),
                }),
                ...(diagnostic === undefined ? {} : { diagnostic }),
                artifactForCapture: (captured) => {
                  capturedOutcome = this.applyHistoryCapture(
                    proposedOutcome,
                    message.providerEvidence,
                    diagnostic,
                    captured,
                  );
                  execution.contextCapture = captured.contextDurability === 'partial'
                    ? 'failed'
                    : captured.contextDurability;
                  return this.executionArtifact(execution, capturedOutcome);
                },
              });
            committed = capturedOutcome ?? this.applyHistoryCapture(
              proposedOutcome,
              message.providerEvidence,
              diagnostic,
              capture,
            );
          } else {
            committed = await this.persistArtifacts(
              proposedOutcome,
              message.providerEvidence,
              diagnostic,
            );
          }
          // Session/evidence settlement is durable before acknowledgement delivery. Any
          // later journal loss is therefore post-commit observation failure, not a rollback.
          execution.settlement = 'committed_observation_pending';
        }
        execution.storeResult = 'committed';
      } catch (error) {
        if (!this.sendCommitAcknowledgement(execution, correlation, false)) {
          this.markUnavailable();
        }
        execution.storeResult = 'failed';
        execution.storeError = typeof error === 'object' && error !== null &&
            (error as { readonly code?: unknown }).code === 'history_busy'
          ? 'history_busy'
          : 'session_io_failure';
        const outcome = failedOutcome(
          task,
          this.projection.transcript,
          'durable session commit failed',
        );
        if (
          typeof error === 'object' && error !== null &&
          (error as { readonly code?: unknown }).code === 'history_invalid'
        ) {
          const failedSettlement = await this.settleHistoryFailure(
            execution,
            outcome,
            diagnostic ?? this.contextContractDiagnostic(
              execution,
              message.providerEvidence,
              proposedOutcome,
            ),
            message.providerEvidence,
            proposedOutcome,
          );
          if (failedSettlement !== undefined) {
            this.deliver(
              turnEndFromOutcome(
                this.projection.nextTurn,
                failedSettlement,
                false,
              ),
            );
            return failedSettlement;
          }
        }
        const settled = await this.settleExecution(
          execution,
          outcome,
          message.providerEvidence,
          diagnostic,
        );
        this.deliver(
          turnEndFromOutcome(this.projection.nextTurn, settled, false),
        );
        return settled;
      }
      this.projection.transcript = structuredClone(
        record.transcript,
      ) as Message[];
      this.projection.nextTurn = record.nextTurn;
      this.projection.stateRevision = record.stateRevision;
      this.projection.turnModels = structuredClone(
        record.turnModels,
      ) as SessionTurnModelAttribution[];
      this.projection.turnExecutions = structuredClone(
        record.turnExecutions,
      ) as SessionTurnExecutionAttribution[];
      if (
        this.options.historyPersistence === undefined ||
        this.options.durableCanonicalHistory === true
      ) {
        execution.committedStateRevision = record.stateRevision;
      }
      const ackSent = this.sendCommitAcknowledgement(
        execution,
        correlation,
        true,
      );
      if (!ackSent) {
        execution.settlement = 'committed_generation_unavailable';
        this.markUnavailableForReplacement();
        const settled = await this.persistExecutionArtifact(
          execution,
          committed,
        );
        this.deliver(
          turnEndFromOutcome(this.projection.nextTurn - 1, settled, true),
        );
        return settled;
      }
      let workerError: WorkerErrorMessage | undefined;
      try {
        const settled = await this.messages.wait(
          (
            value,
          ): value is
            | Extract<WorkerToHostMessage, { kind: 'runtime_event' }>
            | WorkerErrorMessage =>
            (value.kind === 'runtime_event' || value.kind === 'worker_error') &&
            (value.kind === 'worker_error' ||
              sameCorrelation(value.correlation, correlation)),
          this.workerResponseTimeoutMs(),
        );
        if (settled.kind === 'worker_error') workerError = settled;
      } catch {
        this.markUnavailableForReplacement();
      }
      if (workerError !== undefined) {
        this.markUnavailableForReplacement();
      }
      execution.settlement = workerError === undefined && !this.unavailable
        ? 'committed'
        : 'committed_generation_unavailable';
      const settled = await this.persistExecutionArtifact(execution, committed);
      this.deliver(
        turnEndFromOutcome(this.projection.nextTurn - 1, settled, true),
      );
      return settled;
    } catch (error) {
      if (execution.journalFailureCode !== undefined) {
        return await this.finishJournalFailure(execution, task);
      }
      if (this.forcedInterruptionExecutionId === execution.executionId) {
        const outcome = interruptedOutcome(
          task,
          this.projection.transcript,
          'Worker generation was terminated after cancellation did not settle',
        );
        this.deliver(
          turnEndFromOutcome(this.projection.nextTurn, outcome, false),
        );
        return outcome;
      }
      const outcome = failedOutcome(
        task,
        this.projection.transcript,
        error instanceof Error ? error.message : String(error),
      );
      execution.settlement = 'uncommitted';
      const settled = await this.settleExecution(
        execution,
        outcome,
        undefined,
        undefined,
      );
      this.deliver(
        turnEndFromOutcome(this.projection.nextTurn, settled, false),
      );
      return settled;
    } finally {
      this.clearAuxiliaryStageWatchdog(execution.executionId);
      this.clearCancellationWatchdog(execution.executionId);
      if (this.cancellationRequestedExecutionId === execution.executionId) {
        this.cancellationRequestedExecutionId = undefined;
      }
      if (this.forcedInterruptionExecutionId === execution.executionId) {
        this.forcedInterruptionExecutionId = undefined;
      }
      this.activeExecution = undefined;
      this.active = false;
      this.currentCorrelation = undefined;
      this.lastAuxiliaryContextRequestOrdinal = undefined;
    }
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (!this.active || this.currentCorrelation === undefined) return 'idle';
    const execution = this.activeExecution;
    if (
      execution !== undefined &&
      this.cancellationRequestedExecutionId === execution.executionId
    ) return 'already_requested';
    if (execution !== undefined) {
      this.cancellationRequestedExecutionId = execution.executionId;
      this.recordWorkerStageSnapshot('cancel_requested');
      const journaled = this.appendJournal({
        executionId: execution.executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'cancel_requested',
        payload: { command: 'cancel' },
      });
      if (!journaled) return 'requested';
    }
    try {
      this.send({
        kind: 'cancel',
        correlation: this.currentCorrelation,
      });
      if (execution !== undefined) {
        this.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'cancel_sent',
          payload: { command: 'cancel' },
        });
      }
      if (execution !== undefined) {
        const executionId = execution.executionId;
        const timer = setTimeout(
          () => this.escalateCancellation(executionId),
          this.options.cancelSettlementGraceMs ?? WORKER_SETTLEMENT_GRACE_MS,
        );
        this.cancellationWatchdog = { executionId, timer };
      }
      return 'requested';
    } catch {
      if (execution !== undefined) {
        this.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'cancel_failed',
          payload: { command: 'cancel' },
        });
      }
      this.markUnavailableForReplacement();
      return 'requested';
    }
  }

  steerActiveTurn(text: string): 'accepted' | 'already_accepted' | 'idle' {
    if (!this.active || this.currentCorrelation === undefined) return 'idle';
    const execution = this.activeExecution;
    if (execution !== undefined) {
      const journaled = this.appendJournal({
        executionId: execution.executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'steer_requested',
        payload: { text },
      });
      if (!journaled) return 'accepted';
    }
    try {
      this.send({
        kind: 'steer',
        correlation: this.currentCorrelation,
        text,
      });
      if (execution !== undefined) {
        this.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'steer_sent',
          payload: { text },
        });
      }
      return 'accepted';
    } catch {
      if (execution !== undefined) {
        this.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'steer_failed',
          payload: { text },
        });
      }
      this.markUnavailable();
      return 'accepted';
    }
  }

  isAvailable(): boolean {
    return !this.closed &&
      (!this.unavailable || this.generationNeedsReplacement) && !this.active;
  }

  transcriptSnapshot(): readonly Message[] {
    return structuredClone(this.projection.transcript);
  }

  currentPosition(): {
    readonly sessionId: string;
    readonly createdAt: string;
    readonly title?: string;
    readonly agent: SessionRecord['agent'];
    readonly committedTurn: number;
    readonly messageCount: number;
    readonly checkpoint?: Pick<
      SemanticContextCheckpointV1,
      'coveredThroughTurn' | 'retainedFromTurn'
    >;
  } {
    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      ...(this.projection.title === null ? {} : { title: this.projection.title }),
      agent: this.options.agent,
      committedTurn: this.projection.nextTurn - 1,
      messageCount: this.projection.transcript.length,
      ...(this.projection.checkpoint === undefined ? {} : {
        checkpoint: {
          coveredThroughTurn: this.projection.checkpoint.coveredThroughTurn,
          retainedFromTurn: this.projection.checkpoint.retainedFromTurn,
        },
      }),
    };
  }

  historyPage(
    page: number,
    turn = this.projection.nextTurn - 1,
    rows = 16,
  ): SessionHistoryPage | undefined {
    return historyPageWindow(this.projection.transcript, turn, page, {
      sessionId: this.sessionId,
      agent: this.options.agent,
      rows,
    });
  }

  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined {
    return this.projection.checkpoint === undefined
      ? undefined
      : structuredClone(this.projection.checkpoint);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pendingRecall = undefined;
    this.clearAuxiliaryStageWatchdog();
    this.flushObservationBuffer();
    if (
      this.currentManifest === undefined || this.unavailable ||
      this.generationNeedsReplacement
    ) {
      this.unsubscribe();
      this.messages.fail(new Error('Worker host session closed'));
      this.capsule.terminate();
      await this.options.handle.close();
      return;
    }
    const correlation = this.correlation('close');
    try {
      const closed = this.messages.wait((
        value,
      ): value is
        | Extract<WorkerToHostMessage, { kind: 'closed' }>
        | WorkerErrorMessage =>
        (value.kind === 'closed' || value.kind === 'worker_error') &&
        (value.kind === 'worker_error' ||
          sameCorrelation(value.correlation, correlation)), 5_000);
      this.send({ kind: 'close', correlation });
      const settled = await closed;
      if (settled.kind === 'worker_error') throw new Error(settled.message);
    } catch {
      this.capsule.terminate();
    } finally {
      this.unsubscribe();
      this.messages.fail(new Error('Worker host session closed'));
      await this.options.handle.close();
    }
  }
}
