import type { AgentEvent } from '../core/events.ts';
import type { LoopOutcome, Message } from '../core/contracts.ts';
import { indexSessionHistory } from '../session/session_history.ts';
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
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerErrorMessage,
  WorkerModelSelectedMessage,
  WorkerReadyMessage,
  WorkerToHostMessage,
} from './worker_protocol.ts';
import { isModelSelection } from '../provider/model_catalog.ts';
import {
  type CredentialAvailability,
  modelRouteProfileId,
  type ModelSelection,
  sameModelSelection,
} from '../provider/model_selection.ts';
import {
  type WorkerExecutionArtifactV7,
  workerExecutionOutcome,
} from './worker_execution_artifact.ts';
import {
  type RecalledExecutionContext,
  recalledExecutionProjectionText,
  resolveRecalledExecutionContext,
} from './recalled_execution_context.ts';
import type { WorkerHostSessionOptions } from './worker_host_contract.ts';
import { ExecutionJournal } from './worker_host_journal.ts';
import { SessionAuthority } from './worker_host_authority.ts';
import { ChildRunRegistry } from './worker_host_children.ts';
import { type ActiveWorkerExecution, createJournalFailureSignal } from './worker_host_types.ts';
import { validCredentialAvailability, WorkerSupervisor } from './worker_host_supervisor.ts';
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
import type { HistoryCaptureResult } from '../history/history_store_contract.ts';
import type { ExecutionContextManifestV2 } from '../history/context_attribution.ts';
import {
  attributeProviderEvidenceV5,
  historyCaptureDurability,
} from './worker_history_projection.ts';

const WORKER_SETTLEMENT_GRACE_MS = 5_000;
const AUXILIARY_STAGE_GAP_MS = 1_000;
/** Private provider state belongs only to the current uninterrupted provider segment. */
const privateStateFromTurn = (changes: readonly SessionModelChange[]): number => {
  let boundary = 1;
  for (let index = 1; index < changes.length; index++) {
    if (changes[index - 1].selection.provider !== changes[index].selection.provider) {
      boundary = changes[index].effectiveFromTurn;
    }
  }
  return boundary;
};
const profileIdPattern = /^[^\0]+$/u;
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
export class ExecutionCoordinator {
  private readonly authority: SessionAuthority;
  private readonly supervisor: WorkerSupervisor;
  private readonly journal: ExecutionJournal;
  private readonly children: ChildRunRegistry;
  private runtimeRequestCount = 0;
  private generationRequestBase = 0;
  private active = false;
  private closed = false;
  private activeExecution: ActiveWorkerExecution | undefined;
  private pendingRecall: RecalledExecutionContext | undefined;
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

  private constructor(private readonly options: WorkerHostSessionOptions) {
    const record = options.handle.record;
    if (
      record !== undefined &&
      (record.workspaceRoot !== options.workspaceRoot ||
        record.agent !== options.agent)
    ) {
      throw new Error('session binding does not match the opened session');
    }
    this.authority = new SessionAuthority(options, record);
    this.supervisor = new WorkerSupervisor({
      options,
      handleWorkerMessage: (message) => this.receive(message),
      projection: () => this.supervisorProjection(),
      onGenerationReplaced: () => this.onGenerationReplaced(),
    });
    this.journal = new ExecutionJournal({
      options,
      activeExecution: () => this.activeExecution,
      supervisor: () => this.supervisor,
      lastAuxiliaryContextRequestOrdinal: () => this.lastAuxiliaryContextRequestOrdinal,
      onPreCommitJournalFailure: () => this.markUnavailableForReplacement(),
    });
    this.children = new ChildRunRegistry({
      options,
      catalog: options.asyncAgents ?? [],
      ...(options.resolveAsyncAgentModule === undefined
        ? {}
        : { resolveManagedModule: options.resolveAsyncAgentModule }),
      ...(options.historyPersistence === undefined ? {} : { history: options.historyPersistence }),
    });
  }

  private supervisorProjection(): {
    readonly transcript: readonly Message[];
    readonly nextTurn: number;
    readonly stateRevision: number;
    readonly checkpoint?: SemanticContextCheckpointV1;
    readonly modelSelection: ModelSelection;
    readonly privateStateFromTurn: number;
  } {
    return {
      transcript: this.authority.projection.transcript,
      nextTurn: this.authority.projection.nextTurn,
      stateRevision: this.authority.projection.stateRevision,
      ...(this.authority.projection.checkpoint === undefined
        ? {}
        : { checkpoint: this.authority.projection.checkpoint }),
      modelSelection: this.authority.projection.modelSelection,
      privateStateFromTurn: privateStateFromTurn(this.authority.projection.modelChanges),
    };
  }

  private onGenerationReplaced(): void {
    this.generationRequestBase = this.runtimeRequestCount;
    this.lastAuxiliaryContextRequestOrdinal = undefined;
  }

  private workerResponseTimeoutMs(): number {
    return this.supervisor.workerResponseTimeoutMs();
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
      this.journal.recordWorkerStageSnapshot('auxiliary_gap', contextRequestOrdinal);
    }, this.options.auxiliaryStageGapMs ?? AUXILIARY_STAGE_GAP_MS);
    this.auxiliaryStageWatchdog = {
      executionId,
      contextRequestOrdinal,
      timer,
    };
  }

  private noteWorkerSequenceReceived(message: WorkerToHostMessage): void {
    this.supervisor.noteWorkerSequenceReceived(message);
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
    this.supervisor.markUnavailableForReplacement(() => this.journal.clearBuffer());
  }

  private async ensureGeneration(): Promise<void> {
    if (this.supervisor.generationNeedsReplacement) {
      const cleanup = await this.children.cleanupAll();
      if (cleanup?.runs.some((run) => run.durability === 'failed')) {
        throw new Error('async child cleanup failed before Worker replacement');
      }
    }
    await this.supervisor.ensureGeneration(() => this.journal.clearBuffer());
  }

  private async settleChildren(execution: ActiveWorkerExecution): Promise<void> {
    const cleanup = await this.children.cleanupParent(execution.executionId);
    if (cleanup !== undefined) execution.childCleanup = cleanup;
  }

  private escalateCancellation(executionId: string): void {
    const execution = this.activeExecution;
    if (
      execution === undefined || execution.executionId !== executionId ||
      !this.active
    ) return;
    this.clearCancellationWatchdog(executionId);
    this.journal.recordWorkerStageSnapshot('cancel_escalated');
    this.journal.appendJournal({
      executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'cancel_escalated',
      payload: {
        command: 'terminate',
        reason: 'settlement_deadline_exceeded',
      },
    });
    this.journal.flushObservationBuffer();
    if (execution.committedStateRevision === undefined) {
      this.forcedInterruptionExecutionId = executionId;
    }
    this.markUnavailableForReplacement();
  }

  static async open(
    options: WorkerHostSessionOptions,
  ): Promise<ExecutionCoordinator> {
    const coordinator = new ExecutionCoordinator(options);
    try {
      await coordinator.supervisor.start(() => coordinator.journal.clearBuffer());
      return coordinator;
    } catch (error) {
      await coordinator.close();
      throw error;
    }
  }

  get definition(): DefinitionRevisionRef {
    return structuredClone(this.options.definition);
  }

  get sessionId(): string {
    return this.authority.sessionId;
  }

  modelSelectionSnapshot(): ModelSelection {
    return this.authority.modelSelectionSnapshot();
  }

  startupSnapshot(): NonNullable<WorkerReadyMessage['startupSnapshot']> {
    if (this.supervisor.currentStartupSnapshot === undefined) {
      throw new Error('Worker startup snapshot is unavailable');
    }
    return structuredClone(this.supervisor.currentStartupSnapshot);
  }

  credentialAvailabilitySnapshot(): CredentialAvailability | undefined {
    return this.supervisor.credentialAvailability === undefined
      ? undefined
      : structuredClone(this.supervisor.credentialAvailability);
  }

  private send(
    command: import('./worker_protocol.ts').WorkerHostCommand,
  ): void {
    this.supervisor.send(
      command,
      this.activeExecution?.protocolTrace ?? this.supervisor.bootstrapTrace,
    );
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
      this.journal.appendJournal({
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
        this.journal.appendJournal({
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
        this.journal.appendJournal({
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
    this.supervisor.receiveTrace(
      message,
      this.activeExecution?.protocolTrace ?? this.supervisor.bootstrapTrace,
    );
  }

  private receive(message: WorkerToHostMessage): void {
    if (message.kind === 'async_agent_request') {
      void this.handleAsyncAgentRequest(message);
      return;
    }
    this.noteWorkerSequenceReceived(message);
    try {
      this.receiveTrace(message);
    } catch {
      // A structured-clone payload can still be shape-invalid at runtime. Do not let a
      // malformed Worker envelope reach the Surface; retain the same admission/post-commit
      // distinction used by journal validation before making the generation unavailable.
      if (this.activeExecution !== undefined) {
        if (this.activeExecution.settlement === 'uncommitted') {
          this.journal.handleJournalFailure({ code: 'history_invalid' });
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
    if (!postCommitTerminal && !this.journal.appendWorkerObservation(message)) {
      // A final proposal with a malformed/missing context manifest still needs the dedicated
      // normal contract-failure settlement. The proposal is not projected to the Surface; it is
      // handed to the turn waiter after the failed journal append has poisoned pre-commit state.
      if (
        this.activeExecution?.settlement === 'uncommitted' &&
        (message.kind === 'commit_proposal' || message.kind === 'turn_failed')
      ) {
        this.journal.flushObservationBuffer();
        this.supervisor.messages.publish(message);
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
        this.journal.flushObservationBuffer();
        this.supervisor.messages.publish(message);
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
    if (message.kind === 'provider_observation') {
      this.journal.flushObservationBuffer();
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
    this.journal.flushObservationBuffer();
    this.supervisor.messages.publish(message);
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
    this.supervisor.markUnavailable(() => this.journal.clearBuffer());
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
    return this.authority.consumeAutoCompactionNotice();
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
    // The Worker recorder normally supplies this field. When a legacy/custom Worker omits it
    // while the startup basis is present, keep the malformed V5 shape visible so the history
    // store's strict validator rejects the settlement instead of fabricating a logical link.
    return attributeProviderEvidenceV5({
      evidence,
      outcome,
      sessionId: this.sessionId,
      build: this.authority.build,
      definition: this.options.definition,
      hasContextBasis: this.supervisor.currentStartupSnapshot?.context !== undefined,
    });
  }

  private historyExecutionAttribution() {
    return {
      agent: this.options.agent,
      model: structuredClone(this.authority.projection.modelSelection),
      build: structuredClone(this.authority.build),
      definition: structuredClone(this.options.definition),
      ...(this.supervisor.currentManifest === undefined ? {} : {
        manifest: structuredClone(this.supervisor.currentManifest),
      }),
      instanceCorrelation: this.supervisor.instanceCorrelation,
      workerGeneration: this.supervisor.workerGeneration,
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
      ...historyCaptureDurability(capture),
      ...(evidence === undefined ? {} : { providerEvidenceId: evidence.evidenceId }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
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
      this.supervisor.currentManifest === undefined
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
    if (this.supervisor.currentManifest === undefined) {
      throw new Error('Worker manifest unavailable for execution artifact');
    }
    const canonicalAdoption = (this.options.historyPersistence === undefined ||
      this.options.durableCanonicalHistory === true) &&
      execution.committedStateRevision !== undefined;
    return {
      schemaVersion: 7,
      ...(this.supervisor.currentManifest.tools === undefined ? {} : {
        tools: structuredClone(this.supervisor.currentManifest.tools),
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
      instanceCorrelation: this.supervisor.instanceCorrelation,
      workerGeneration: this.supervisor.workerGeneration,
      build: structuredClone(this.authority.build),
      definition: structuredClone(this.options.definition),
      manifest: structuredClone(this.supervisor.currentManifest),
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
      ...(execution.childCleanup === undefined ? {} : {
        childCleanup: structuredClone(execution.childCleanup),
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
        : outcome.stopReason === 'interrupted'
        ? 'interrupted'
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
    await this.settleChildren(execution);
    const terminalSnapshotDurable = this.journal.recordWorkerStageSnapshot('terminal');
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
            ...(this.supervisor.currentStartupSnapshot?.context === undefined ? {} : {
              contextSnapshot: this.supervisor.currentStartupSnapshot.context,
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
              this.authority.projection.transcript,
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
        this.authority.projection.transcript,
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
    this.deliver(turnEndFromOutcome(this.authority.projection.nextTurn, settled, false));
    return settled;
  }

  private correlation(command: string): WorkerCorrelation {
    return this.supervisor.correlation(command);
  }

  private installCheckpoint(message: WorkerCheckpointProposalMessage): void {
    let accepted = false;
    try {
      if (
        this.supervisor.currentCorrelation === undefined || !this.active ||
        !sameCorrelation(message.correlation, this.supervisor.currentCorrelation) ||
        !validateSemanticContextCheckpoint(message.checkpoint) ||
        this.supervisor.currentManifest === undefined ||
        !profileIdPattern.test(this.supervisor.currentManifest.profileId) ||
        message.checkpoint.sessionId !== this.sessionId ||
        message.checkpoint.sourceProfileId !== this.supervisor.currentManifest.profileId
      ) throw new Error('checkpoint correlation invalid');
      const completedTurns =
        indexSessionHistory(this.authority.projection.transcript)?.turns.length ?? 0;
      if (
        message.checkpoint.coveredThroughTurn < 1 ||
        message.checkpoint.coveredThroughTurn >= completedTurns ||
        message.checkpoint.retainedFromTurn !==
          message.checkpoint.coveredThroughTurn + 1
      ) throw new Error('checkpoint boundary invalid');
      this.options.handle.installCheckpoint(message.checkpoint);
      this.authority.projection.checkpoint = structuredClone(message.checkpoint);
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
        this.authority.recordCheckpointNotice(notice);
      } catch {
        this.authority.clearCheckpointNotice();
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
      this.authority.clearCheckpointNotice();
      this.markUnavailable();
    }
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
    if (this.active || this.supervisor.currentCorrelation !== undefined) return 'busy';
    if (!isModelSelection(selection)) {
      throw new RangeError('invalid model selection');
    }
    if (sameModelSelection(this.authority.projection.modelSelection, selection)) {
      return 'unchanged';
    }
    const changedAt = new Date().toISOString();
    const nextChanges: SessionModelChange[] = [
      ...structuredClone(this.authority.projection.modelChanges),
      {
        effectiveFromTurn: this.authority.projection.nextTurn,
        changedAt,
        selection: structuredClone(selection),
      },
    ];
    const nextRevision = this.authority.projection.stateRevision + 1;
    const persisted: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.authority.createdAt,
      updatedAt: changedAt,
      title: this.authority.projection.title,
      stateRevision: nextRevision,
      nextTurn: this.authority.projection.nextTurn,
      transcript: structuredClone(this.authority.projection.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(selection),
      modelChanges: nextChanges,
      turnModels: structuredClone(this.authority.projection.turnModels),
      turnExecutions: structuredClone(this.authority.projection.turnExecutions),
    };
    if (!validateSessionRecordV6(persisted)) {
      throw new Error('model selection record invalid');
    }
    this.options.handle.commit(persisted);
    const correlation: WorkerCorrelation = {
      ...this.correlation('select-model-' + crypto.randomUUID().toLowerCase()),
      baseStateRevision: nextRevision,
    };
    this.supervisor.setCurrentCorrelation(correlation);
    try {
      const response = this.supervisor.messages.wait(
        (
          value,
        ): value is WorkerModelSelectedMessage | WorkerErrorMessage =>
          (value.kind === 'model_selected' || value.kind === 'worker_error') &&
          (value.kind === 'worker_error' ||
            sameCorrelation(value.correlation, correlation)),
        this.workerResponseTimeoutMs(),
      );
      this.send({
        kind: 'select_model',
        correlation,
        selection,
        privateStateFromTurn: privateStateFromTurn(nextChanges),
      });
      const message = await response;
      if (
        message.kind === 'worker_error' || !message.accepted ||
        message.manifest === undefined ||
        !sameModelSelection(message.manifest.rootModel, selection) ||
        message.manifest.profileId !== modelRouteProfileId(selection) ||
        !validCredentialAvailability(message.credentialAvailability, selection)
      ) throw new Error('Worker rejected model selection');
      this.supervisor.setManifest(message.manifest);
      this.supervisor.setCredentialAvailability(structuredClone(
        message.credentialAvailability,
      ));
      this.authority.projection.modelSelection = structuredClone(selection);
      this.authority.projection.modelChanges = nextChanges;
      this.authority.projection.stateRevision = nextRevision;
      return 'selected';
    } catch (error) {
      this.options.handle.rollback();
      this.markUnavailableForReplacement();
      throw error;
    } finally {
      this.supervisor.setCurrentCorrelation(undefined);
    }
  }

  renameTitle(
    value: string,
  ): 'renamed' | 'unchanged' | 'busy' | 'unavailable' {
    if (this.closed || this.supervisor.isUnavailable) return 'unavailable';
    if (this.active || this.supervisor.currentCorrelation !== undefined) return 'busy';
    const title = normalizeSessionTitle(value);
    if (title.length === 0 || title === this.authority.projection.title) {
      return 'unchanged';
    }
    const changedAt = new Date().toISOString();
    const nextRevision = this.authority.projection.stateRevision + 1;
    const persisted: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.authority.createdAt,
      updatedAt: changedAt,
      title,
      stateRevision: nextRevision,
      nextTurn: this.authority.projection.nextTurn,
      transcript: structuredClone(this.authority.projection.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.authority.projection.modelSelection),
      modelChanges: structuredClone(this.authority.projection.modelChanges),
      turnModels: structuredClone(this.authority.projection.turnModels),
      turnExecutions: structuredClone(this.authority.projection.turnExecutions),
    };
    if (!validateSessionRecordV6(persisted)) {
      throw new Error('session title record invalid');
    }
    this.options.handle.commit(persisted);
    this.authority.projection.title = title;
    this.authority.projection.stateRevision = nextRevision;
    return 'renamed';
  }

  async prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }> {
    if (
      this.closed || this.supervisor.isUnavailable ||
      this.options.executionArtifactStore === undefined &&
        this.options.historyPersistence === undefined
    ) {
      throw new WorkerRecallSelectionError('unavailable');
    }
    if (this.active || this.supervisor.currentCorrelation !== undefined) {
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
    if (this.closed || this.supervisor.isUnavailable) {
      throw new WorkerRecallSelectionError('unavailable');
    }
    if (this.active || this.supervisor.currentCorrelation !== undefined) {
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
    if (this.closed || this.supervisor.isUnavailable) {
      throw new WorkerRecallSelectionError('unavailable');
    }
    if (this.active || this.supervisor.currentCorrelation !== undefined) {
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
      `turn-${this.authority.projection.nextTurn}-${crypto.randomUUID().toLowerCase()}`,
    );
    this.supervisor.setCurrentCorrelation(correlation);
    this.supervisor.beginTurnStageProbeEpoch();
    const execution: ActiveWorkerExecution = {
      taskId: crypto.randomUUID().toLowerCase(),
      executionId: crypto.randomUUID().toLowerCase(),
      createdAt: new Date().toISOString(),
      turn: this.authority.projection.nextTurn,
      command: {
        kind: 'turn',
        correlation: structuredClone(correlation),
        task,
      },
      ...(admittedRecall === undefined ? {} : {
        recalledContext: structuredClone(admittedRecall),
      }),
      baseStateRevision: this.authority.projection.stateRevision,
      stageProbeEpoch: this.supervisor.stageProbeEpoch,
      protocolTrace: [...this.supervisor.bootstrapTrace],
      storeResult: 'not_attempted',
      acknowledgement: 'not_sent',
      settlement: 'uncommitted',
      artifactWritten: false,
      journalFailureSignal: createJournalFailureSignal(),
      stageSnapshotKeys: new Set(),
    };
    this.children.openParent(execution.executionId);
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
            ...(this.authority.admissionSessionRecord() === undefined
              ? {}
              : { sessionRecord: this.authority.admissionSessionRecord() }),
            ...(this.supervisor.currentStartupSnapshot?.context === undefined
              ? {}
              : { contextSnapshot: this.supervisor.currentStartupSnapshot.context }),
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
              this.authority.projection.transcript,
              `durable execution admission failed: ${historyFailure}`,
            ),
            executionAdmissionDurability: 'failed',
            executionAdmissionPersistenceError: historyFailure,
          };
          this.deliver(
            turnEndFromOutcome(this.authority.projection.nextTurn, failed, false),
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
        const dispatchJournaled = this.journal.appendJournal({
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
        this.journal.appendJournal({
          executionId: execution.executionId,
          direction: 'host_to_worker',
          source: 'host',
          kind: 'turn_dispatch_failed',
          payload: { task },
        });
        this.markUnavailable();
        const outcome = failedOutcome(
          task,
          this.authority.projection.transcript,
          'Worker transport unavailable',
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          undefined,
          undefined,
        );
        this.deliver(
          turnEndFromOutcome(this.authority.projection.nextTurn, settled, false),
        );
        return settled;
      }
      const terminal = await Promise.race([
        this.supervisor.messages.wait((
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
          turnEndFromOutcome(this.authority.projection.nextTurn, settled, false),
        );
        return settled;
      }
      if (message.kind === 'worker_error') {
        this.markUnavailable();
        const outcome = failedOutcome(
          task,
          this.authority.projection.transcript,
          message.message,
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          undefined,
          undefined,
        );
        this.deliver(
          turnEndFromOutcome(this.authority.projection.nextTurn, settled, false),
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
      const record = this.authority.proposalRecord(message);
      if (record === undefined) {
        if (!this.sendCommitAcknowledgement(execution, correlation, false)) {
          this.markUnavailable();
        }
        const outcome = failedOutcome(
          task,
          this.authority.projection.transcript,
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
          turnEndFromOutcome(this.authority.projection.nextTurn, settled, false),
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
      await this.settleChildren(execution);
      if (execution.journalFailureCode !== undefined) {
        this.sendCommitAcknowledgement(execution, correlation, false);
        return await this.finishJournalFailure(
          execution,
          task,
          message.providerEvidence,
          diagnostic,
          message.contextManifest,
        );
      }
      const cancellationRequested = this.cancellationRequestedExecutionId === execution.executionId;
      const forcedInterruption = this.forcedInterruptionExecutionId === execution.executionId;
      const proposalStillCurrent = this.activeExecution === execution && this.active &&
        this.supervisor.workerGeneration === message.correlation.workerGeneration &&
        this.supervisor.currentCorrelation !== undefined &&
        sameCorrelation(this.supervisor.currentCorrelation, correlation);
      if (cancellationRequested || forcedInterruption || !proposalStillCurrent) {
        this.sendCommitAcknowledgement(execution, correlation, false);
        const outcome = forcedInterruption || !proposalStillCurrent
          ? interruptedOutcome(
            task,
            this.authority.projection.transcript,
            'Parent execution changed while async children were settling',
          )
          : failedOutcome(
            task,
            this.authority.projection.transcript,
            'Parent execution was cancelled while async children were settling',
            true,
          );
        const settled = await this.settleExecution(
          execution,
          outcome,
          message.providerEvidence,
          diagnostic,
          message.contextManifest,
        );
        this.deliver(
          turnEndFromOutcome(this.authority.projection.nextTurn, settled, false),
        );
        return settled;
      }
      let committed: LoopOutcome;
      try {
        if (
          this.options.historyPersistence !== undefined &&
          this.options.durableCanonicalHistory === true
        ) {
          if (!this.journal.recordWorkerStageSnapshot('terminal')) {
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
            ...(this.supervisor.currentStartupSnapshot?.context === undefined ? {} : {
              contextSnapshot: this.supervisor.currentStartupSnapshot.context,
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
                ...(this.supervisor.currentStartupSnapshot?.context === undefined ? {} : {
                  contextSnapshot: this.supervisor.currentStartupSnapshot.context,
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
          this.authority.projection.transcript,
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
                this.authority.projection.nextTurn,
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
          turnEndFromOutcome(this.authority.projection.nextTurn, settled, false),
        );
        return settled;
      }
      this.authority.projection.transcript = structuredClone(
        record.transcript,
      ) as Message[];
      this.authority.projection.nextTurn = record.nextTurn;
      this.authority.projection.stateRevision = record.stateRevision;
      this.authority.projection.turnModels = structuredClone(
        record.turnModels,
      ) as SessionTurnModelAttribution[];
      this.authority.projection.turnExecutions = structuredClone(
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
          turnEndFromOutcome(this.authority.projection.nextTurn - 1, settled, true),
        );
        return settled;
      }
      let workerError: WorkerErrorMessage | undefined;
      try {
        const settled = await this.supervisor.messages.wait(
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
      execution.settlement = workerError === undefined && !this.supervisor.isUnavailable
        ? 'committed'
        : 'committed_generation_unavailable';
      const settled = await this.persistExecutionArtifact(execution, committed);
      this.deliver(
        turnEndFromOutcome(this.authority.projection.nextTurn - 1, settled, true),
      );
      return settled;
    } catch (error) {
      if (execution.journalFailureCode !== undefined) {
        return await this.finishJournalFailure(execution, task);
      }
      if (this.forcedInterruptionExecutionId === execution.executionId) {
        const outcome = interruptedOutcome(
          task,
          this.authority.projection.transcript,
          'Worker generation was terminated after cancellation did not settle',
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          undefined,
          undefined,
        );
        this.deliver(
          turnEndFromOutcome(this.authority.projection.nextTurn, settled, false),
        );
        return settled;
      }
      const outcome = failedOutcome(
        task,
        this.authority.projection.transcript,
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
        turnEndFromOutcome(this.authority.projection.nextTurn, settled, false),
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
      await this.settleChildren(execution);
      this.children.releaseParent(execution.executionId);
      this.activeExecution = undefined;
      this.active = false;
      this.supervisor.setCurrentCorrelation(undefined);
      this.lastAuxiliaryContextRequestOrdinal = undefined;
    }
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (!this.active || this.supervisor.currentCorrelation === undefined) return 'idle';
    const execution = this.activeExecution;
    if (
      execution !== undefined &&
      this.cancellationRequestedExecutionId === execution.executionId
    ) return 'already_requested';
    if (execution !== undefined) {
      this.cancellationRequestedExecutionId = execution.executionId;
      this.journal.recordWorkerStageSnapshot('cancel_requested');
      const journaled = this.journal.appendJournal({
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
        correlation: this.supervisor.currentCorrelation,
      });
      if (execution !== undefined) {
        this.journal.appendJournal({
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
        this.journal.appendJournal({
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
    if (!this.active || this.supervisor.currentCorrelation === undefined) return 'idle';
    const execution = this.activeExecution;
    if (execution !== undefined) {
      const journaled = this.journal.appendJournal({
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
        correlation: this.supervisor.currentCorrelation,
        text,
      });
      if (execution !== undefined) {
        this.journal.appendJournal({
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
        this.journal.appendJournal({
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
      (!this.supervisor.isUnavailable || this.supervisor.generationNeedsReplacement) &&
      !this.active;
  }

  transcriptSnapshot(): readonly Message[] {
    return this.authority.transcriptSnapshot();
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
      createdAt: this.authority.createdAt,
      ...(this.authority.projection.title === null
        ? {}
        : { title: this.authority.projection.title }),
      agent: this.options.agent,
      committedTurn: this.authority.projection.nextTurn - 1,
      messageCount: this.authority.projection.transcript.length,
      ...(this.authority.projection.checkpoint === undefined ? {} : {
        checkpoint: {
          coveredThroughTurn: this.authority.projection.checkpoint.coveredThroughTurn,
          retainedFromTurn: this.authority.projection.checkpoint.retainedFromTurn,
        },
      }),
    };
  }

  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined {
    return this.authority.checkpointSnapshot();
  }

  private async handleAsyncAgentRequest(
    message: Extract<WorkerToHostMessage, { kind: 'async_agent_request' }>,
  ): Promise<void> {
    const parentExecutionId = this.activeExecution?.executionId;
    let response: import('../tools/async_agents.ts').AsyncAgentResponse;
    try {
      response = await this.children.handle(
        message.request,
        message.callId,
        parentExecutionId,
      );
    } catch (error) {
      response = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      parentExecutionId === undefined ||
      this.activeExecution?.executionId !== parentExecutionId
    ) return;
    try {
      this.send({
        kind: 'async_agent_response',
        correlation: message.correlation,
        requestId: message.requestId,
        response,
      });
    } catch {
      // Parent cleanup owns any child run after its Worker generation becomes unavailable.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let cleanupError: Error | undefined;
    try {
      const activeCleanup = this.activeExecution === undefined
        ? undefined
        : await this.children.cleanupParent(this.activeExecution.executionId);
      const remainingCleanup = await this.children.cleanupAll();
      const failed = [
        ...(activeCleanup?.runs ?? []),
        ...(remainingCleanup?.runs ?? []),
      ].filter((run, index, runs) =>
        run.durability === 'failed' &&
        runs.findIndex((candidate) => candidate.runId === run.runId) === index
      );
      if (failed.length > 0) {
        cleanupError = new Error(
          `async child cleanup failed: ${failed.map((run) => run.runId).join(', ')}`,
        );
      }
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
    this.pendingRecall = undefined;
    this.clearAuxiliaryStageWatchdog();
    this.journal.flushObservationBuffer();
    try {
      if (
        this.supervisor.currentManifest !== undefined && !this.supervisor.isUnavailable &&
        !this.supervisor.generationNeedsReplacement
      ) {
        const correlation = this.correlation('close');
        const closed = this.supervisor.messages.wait((
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
      }
    } catch {
      // The generation is already unavailable.
    } finally {
      this.supervisor.terminate();
      await this.options.handle.close();
    }
    if (cleanupError !== undefined) throw cleanupError;
  }
}
