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
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import type { ProviderEvidenceV1, ProviderEvidenceV2 } from '../provider/provider_evidence.ts';
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
} from './worker_protocol.ts';
import {
  PLANNER_DEFAULT_MODEL_SELECTION,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../provider/openrouter_model_catalog.ts';
import { isModelSelection } from '../provider/model_catalog.ts';
import {
  type CredentialAvailability,
  modelRouteProfileId,
  type ModelSelection,
  sameModelSelection,
} from '../provider/model_selection.ts';
import {
  type WorkerExecutionAcknowledgement,
  type WorkerExecutionArtifactV2,
  workerExecutionOutcome,
  type WorkerExecutionSettlement,
  type WorkerExecutionStoreResult,
  type WorkerExecutionTraceEntry,
  type WorkerExecutionTurnCommand,
  workerHostCommandSubtype,
  workerMessageSubtype,
} from './worker_execution_artifact.ts';
import type { WorkerHostCapsule, WorkerHostSessionOptions } from './worker_host_contract.ts';
import {
  diagnosticPersistenceCodes,
  evidencePersistenceCodes,
  failedOutcome,
  persistenceCode,
  proposalOutcome,
  sameCorrelation,
  sameRef,
  turnEndFromOutcome,
} from './worker_host_outcome.ts';
import { HostMessageQueue } from './worker_host_queue.ts';
import { buildManifest } from '../runtime/build_manifest.ts';

const workerUrl = new URL('./worker_bootstrap.ts', import.meta.url);
const profileIdPattern = /^[^\0]+$/u;
const validCredentialAvailability = (
  value: CredentialAvailability | undefined,
  selection: ModelSelection,
): value is CredentialAvailability =>
  value !== undefined && value.authProfile === selection.authProfile &&
  (value.status === 'present' || value.status === 'missing' || value.status === 'unknown');
const validStartupSnapshot = (
  value: WorkerReadyMessage['startupSnapshot'],
): value is NonNullable<WorkerReadyMessage['startupSnapshot']> => {
  if (value === undefined || !Array.isArray(value.skillNames)) return false;
  if (
    value.instructionSource !== undefined && value.instructionSource !== 'AGENTS.md' &&
    value.instructionSource !== 'AGENTS.MD'
  ) return false;
  return value.skillNames.every((name) => typeof name === 'string' && name.length > 0) &&
    new Set(value.skillNames).size === value.skillNames.length;
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
type ActiveWorkerExecution = {
  readonly executionId: string;
  readonly createdAt: string;
  readonly turn: number;
  readonly command: WorkerExecutionTurnCommand;
  readonly baseStateRevision: number;
  readonly protocolTrace: WorkerExecutionTraceEntry[];
  storeResult: WorkerExecutionStoreResult;
  storeError?: 'session_io_failure' | 'session_invalid';
  proposedStateRevision?: number;
  committedStateRevision?: number;
  acknowledgement: WorkerExecutionAcknowledgement;
  settlement: WorkerExecutionSettlement;
  artifactWritten: boolean;
};
/** Host-owned canonical session around one ephemeral Worker generation. */
export class WorkerHostSession {
  private readonly capsule: WorkerHostCapsule;
  private readonly messages = new HostMessageQueue();
  private readonly unsubscribe: () => void;
  private readonly instanceCorrelation = crypto.randomUUID().toLowerCase();
  private readonly workerGeneration = crypto.randomUUID().toLowerCase();
  private readonly bootstrapTrace: WorkerExecutionTraceEntry[] = [];
  private traceSequence = 0;
  private currentCorrelation: WorkerCorrelation | undefined;
  private currentManifest: WorkerReadyMessage['manifest'];
  private currentStartupSnapshot: WorkerReadyMessage['startupSnapshot'];
  private transcript: Message[];
  private nextTurn: number;
  private stateRevision: number;
  private checkpoint: SemanticContextCheckpointV1 | undefined;
  private autoCompactionNotice: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
  private runtimeRequestCount = 0;
  private active = false;
  private unavailable = false;
  private closed = false;
  private activeExecution: ActiveWorkerExecution | undefined;
  private modelSelection: ModelSelection;
  private modelChanges: SessionModelChange[];
  private turnModels: SessionTurnModelAttribution[];
  private turnExecutions: SessionTurnExecutionAttribution[];
  private readonly build = buildManifest();
  private readonly createdAt: string;
  private title: string | null;
  private legacyModelNotice = false;
  private credentialAvailability: CredentialAvailability | undefined;

  private constructor(private readonly options: WorkerHostSessionOptions) {
    this.capsule = options.capsuleFactory?.(workerUrl) ??
      new WorkerCapsule(workerUrl);
    const record = options.handle.record;
    if (
      record !== undefined &&
      (record.workspaceRoot !== options.workspaceRoot ||
        record.agent !== options.agent ||
        !sameRef(record.definition, options.definition))
    ) {
      throw new Error(
        'session Definition revision does not match the selected binding',
      );
    }
    this.transcript = record === undefined ? [] : structuredClone(record.transcript) as Message[];
    this.nextTurn = record?.nextTurn ?? 1;
    this.stateRevision = record?.stateRevision ?? 1;
    const defaultSelection = options.initialModelSelection ??
      (options.agent === 'planner'
        ? PLANNER_DEFAULT_MODEL_SELECTION
        : ROOT_DEFAULT_MODEL_SELECTION);
    this.modelSelection = record === undefined
      ? structuredClone(defaultSelection)
      : structuredClone(record.activeModel);
    this.modelChanges = record === undefined
      ? [{
        effectiveFromTurn: this.nextTurn,
        changedAt: new Date().toISOString(),
        selection: structuredClone(this.modelSelection),
      }]
      : structuredClone(record.modelChanges) as SessionModelChange[];
    this.turnModels = record === undefined
      ? []
      : structuredClone(record.turnModels) as SessionTurnModelAttribution[];
    this.turnExecutions = record === undefined
      ? []
      : structuredClone(record.turnExecutions) as SessionTurnExecutionAttribution[];
    this.createdAt = record?.createdAt ?? new Date().toISOString();
    this.title = record?.title ?? null;
    this.legacyModelNotice = false;
    this.checkpoint = options.handle.checkpoint === undefined
      ? undefined
      : structuredClone(options.handle.checkpoint);
    this.unsubscribe = this.capsule.subscribe((message) => this.receive(message));
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
    return structuredClone(this.modelSelection);
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

  consumeLegacyModelNotice(): boolean {
    const notice = this.legacyModelNotice;
    this.legacyModelNotice = false;
    return notice;
  }

  private trace(
    direction: WorkerExecutionTraceEntry['direction'],
    kind: WorkerExecutionTraceEntry['kind'],
    semanticSubtype: string,
    correlation: WorkerCorrelation,
    ackAccepted?: boolean,
  ): void {
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

  private send(command: import('./worker_protocol.ts').WorkerHostCommand): void {
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

  private receiveTrace(message: WorkerToHostMessage): void {
    const subtype = workerMessageSubtype(message);
    const correlation = 'correlation' in message && message.correlation !== undefined
      ? message.correlation
      : this.currentCorrelation ?? this.correlation('worker_error');
    this.trace('worker_to_host', subtype.kind, subtype.semanticSubtype, correlation);
  }

  private receive(message: WorkerToHostMessage): void {
    this.receiveTrace(message);
    if (message.kind === 'runtime_event') {
      if (
        message.event.kind === 'agent_event' &&
        message.event.event.kind === 'turn_end'
      ) {
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
    if (message.kind === 'checkpoint_proposal') {
      void this.installCheckpoint(message);
      return;
    }
    this.messages.publish(message);
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
    if (!this.unavailable) {
      this.unavailable = true;
      this.capsule.terminate();
    }
    this.messages.fail(new Error('Worker transport unavailable'));
  }

  private observeRequestCount(outcome: LoopOutcome): void {
    const count = outcome.runtimeProviderRequestCount;
    if (count !== undefined && Number.isSafeInteger(count) && count >= this.runtimeRequestCount) {
      this.runtimeRequestCount = count;
    }
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
    const evidenceId = providerEvidence?.evidenceId ?? outcome.providerEvidenceId;
    let evidenceDurability = providerEvidence === undefined
      ? outcome.providerEvidenceDurability
      : 'unknown' as const;
    let evidenceError = outcome.providerEvidencePersistenceError;
    if (providerEvidence !== undefined) {
      if (this.options.providerEvidenceStore === undefined) {
        evidenceDurability = 'unknown';
      } else {
        try {
          const attributed: ProviderEvidenceV2 = {
            ...structuredClone(providerEvidence),
            schemaVersion: 2,
            sessionId: this.sessionId,
            build: structuredClone(this.build),
            definition: structuredClone(this.options.definition),
          };
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
    this.observeRequestCount(settled);
    return settled;
  }

  private async persistExecutionArtifact(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
  ): Promise<LoopOutcome> {
    if (execution.artifactWritten) return outcome;
    execution.artifactWritten = true;
    const store = this.options.executionArtifactStore;
    if (store === undefined || this.currentManifest === undefined) return outcome;
    const artifact: WorkerExecutionArtifactV2 = {
      schemaVersion: 2,
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
      baseStateRevision: execution.baseStateRevision,
      ...(execution.proposedStateRevision === undefined ? {} : {
        proposedStateRevision: execution.proposedStateRevision,
      }),
      ...(execution.committedStateRevision === undefined ? {} : {
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
      outcome: workerExecutionOutcome(outcome),
      effectCommitRelation: 'not_transactional',
      automaticReplay: false,
    };
    try {
      await store.write(artifact);
      return {
        ...outcome,
        executionArtifactId: execution.executionId,
        executionArtifactDurability: 'yes',
        executionArtifactPersistenceError: undefined,
      };
    } catch (error) {
      const code = typeof error === 'object' && error !== null &&
          (error as { readonly code?: unknown }).code === 'worker_execution_artifact_invalid'
        ? 'worker_execution_artifact_invalid' as const
        : 'worker_execution_artifact_io_failure' as const;
      return {
        ...outcome,
        executionArtifactId: execution.executionId,
        executionArtifactDurability: 'failed',
        executionArtifactPersistenceError: code,
      };
    }
  }

  private async settleExecution(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
    providerEvidence: ProviderEvidenceV1 | undefined,
    diagnostic: FailureDiagnosticV1 | undefined,
  ): Promise<LoopOutcome> {
    const settled = await this.persistArtifacts(outcome, providerEvidence, diagnostic);
    return await this.persistExecutionArtifact(execution, settled);
  }

  private correlation(command: string): WorkerCorrelation {
    return {
      session: this.sessionId,
      instanceCorrelation: this.instanceCorrelation,
      workerGeneration: this.workerGeneration,
      baseStateRevision: this.stateRevision,
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
        workspaceRoot: this.options.workspaceRoot,
        physicalIoMode: this.options.physicalIoMode ?? 'production',
        rootRole: this.options.agent === 'planner' ? 'planner' : 'parent',
        ...(this.options.rootMaxSteps === undefined
          ? {}
          : { rootMaxSteps: this.options.rootMaxSteps }),
        ...(this.options.providerTimeoutMs === undefined
          ? {}
          : { providerTimeoutMs: this.options.providerTimeoutMs }),
        initialTranscript: this.transcript,
        nextTurn: this.nextTurn,
        ...(this.checkpoint === undefined ? {} : { checkpoint: this.checkpoint }),
        modelSelection: this.modelSelection,
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
      if (ready.manifest !== undefined && ready.manifest.role !== expectedRole) {
        throw new WorkerHostStartupError(
          'role_mismatch',
          'module_validation',
          'Worker Definition effective role did not match its declared role',
        );
      }
      if (
        ready.manifest === undefined ||
        !sameModelSelection(ready.manifest.rootModel, this.modelSelection) ||
        !sameModelSelection(ready.manifest.plannerModel, PLANNER_DEFAULT_MODEL_SELECTION) ||
        ready.manifest.profileId !== modelRouteProfileId(this.modelSelection) ||
        (this.options.rootMaxSteps !== undefined &&
          ready.manifest.maxSteps !== this.options.rootMaxSteps) ||
        !validStartupSnapshot(ready.startupSnapshot) ||
        !validCredentialAvailability(ready.credentialAvailability, this.modelSelection)
      ) {
        throw new WorkerHostStartupError(
          'manifest_invalid',
          'module_validation',
          'Worker manifest did not match Host selection',
        );
      }
      this.currentManifest = ready.manifest;
      this.currentStartupSnapshot = ready.startupSnapshot;
      this.credentialAvailability = structuredClone(ready.credentialAvailability);
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
      const completedTurns = indexSessionHistory(this.transcript)?.turns.length ?? 0;
      if (
        message.checkpoint.coveredThroughTurn < 1 ||
        message.checkpoint.coveredThroughTurn >= completedTurns ||
        message.checkpoint.retainedFromTurn !==
          message.checkpoint.coveredThroughTurn + 1
      ) throw new Error('checkpoint boundary invalid');
      this.options.handle.installCheckpoint(message.checkpoint);
      this.checkpoint = structuredClone(message.checkpoint);
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
      title: this.title,
      stateRevision: this.stateRevision + 1,
      nextTurn: proposal.nextTurn,
      transcript: structuredClone(proposal.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.modelSelection),
      modelChanges: structuredClone(this.modelChanges),
      turnModels: [
        ...structuredClone(this.turnModels),
        {
          turn: proposal.nextTurn - 1,
          selection: structuredClone(this.modelSelection),
        },
      ],
      turnExecutions: [
        ...structuredClone(this.turnExecutions),
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
    if (this.closed || this.unavailable) return 'unavailable';
    if (this.active || this.currentCorrelation !== undefined) return 'busy';
    if (!isModelSelection(selection)) throw new RangeError('invalid model selection');
    if (sameModelSelection(this.modelSelection, selection)) return 'unchanged';
    const changedAt = new Date().toISOString();
    const nextChanges: SessionModelChange[] = [
      ...structuredClone(this.modelChanges),
      {
        effectiveFromTurn: this.nextTurn,
        changedAt,
        selection: structuredClone(selection),
      },
    ];
    const nextRevision = this.stateRevision + 1;
    const persisted: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: changedAt,
      title: this.title,
      stateRevision: nextRevision,
      nextTurn: this.nextTurn,
      transcript: structuredClone(this.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(selection),
      modelChanges: nextChanges,
      turnModels: structuredClone(this.turnModels),
      turnExecutions: structuredClone(this.turnExecutions),
    };
    if (!validateSessionRecordV6(persisted)) throw new Error('model selection record invalid');
    this.options.handle.commit(persisted);
    const correlation: WorkerCorrelation = {
      ...this.correlation('select-model-' + crypto.randomUUID().toLowerCase()),
      baseStateRevision: nextRevision,
    };
    this.currentCorrelation = correlation;
    try {
      const response = this.messages.wait((
        value,
      ): value is WorkerModelSelectedMessage | WorkerErrorMessage =>
        (value.kind === 'model_selected' || value.kind === 'worker_error') &&
        (value.kind === 'worker_error' ||
          sameCorrelation(value.correlation, correlation))
      );
      this.send({ kind: 'select_model', correlation, selection });
      const message = await response;
      if (
        message.kind === 'worker_error' || !message.accepted ||
        message.manifest === undefined ||
        !sameModelSelection(message.manifest.rootModel, selection) ||
        !sameModelSelection(message.manifest.plannerModel, PLANNER_DEFAULT_MODEL_SELECTION) ||
        message.manifest.profileId !== modelRouteProfileId(selection) ||
        !validCredentialAvailability(message.credentialAvailability, selection)
      ) throw new Error('Worker rejected model selection');
      this.currentManifest = message.manifest;
      this.credentialAvailability = structuredClone(message.credentialAvailability);
      this.modelSelection = structuredClone(selection);
      this.modelChanges = nextChanges;
      this.stateRevision = nextRevision;
      this.legacyModelNotice = false;
      return 'selected';
    } catch (error) {
      this.options.handle.rollback();
      this.markUnavailable();
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
    if (title.length === 0 || title === this.title) return 'unchanged';
    const changedAt = new Date().toISOString();
    const nextRevision = this.stateRevision + 1;
    const persisted: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: changedAt,
      title,
      stateRevision: nextRevision,
      nextTurn: this.nextTurn,
      transcript: structuredClone(this.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.modelSelection),
      modelChanges: structuredClone(this.modelChanges),
      turnModels: structuredClone(this.turnModels),
      turnExecutions: structuredClone(this.turnExecutions),
    };
    if (!validateSessionRecordV6(persisted)) throw new Error('session title record invalid');
    this.options.handle.commit(persisted);
    this.title = title;
    this.stateRevision = nextRevision;
    return 'renamed';
  }

  async submit(task: string): Promise<LoopOutcome> {
    if (this.closed || this.unavailable) {
      throw new Error('agent session unavailable');
    }
    if (this.active) throw new Error('agent session is busy');
    if (typeof task !== 'string' || task.trim().length === 0) {
      throw new RangeError('user text must not be blank');
    }
    this.active = true;
    const correlation = this.correlation(
      `turn-${this.nextTurn}-${crypto.randomUUID().toLowerCase()}`,
    );
    this.currentCorrelation = correlation;
    const execution: ActiveWorkerExecution = {
      executionId: crypto.randomUUID().toLowerCase(),
      createdAt: new Date().toISOString(),
      turn: this.nextTurn,
      command: { kind: 'turn', correlation: structuredClone(correlation), task },
      baseStateRevision: this.stateRevision,
      protocolTrace: [...this.bootstrapTrace],
      storeResult: 'not_attempted',
      acknowledgement: 'not_sent',
      settlement: 'uncommitted',
      artifactWritten: false,
    };
    this.activeExecution = execution;
    try {
      try {
        this.send({ kind: 'turn', correlation, task });
      } catch {
        this.markUnavailable();
        const outcome = failedOutcome(task, this.transcript, 'Worker transport unavailable');
        const settled = await this.settleExecution(execution, outcome, undefined, undefined);
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      const message = await this.messages.wait((
        value,
      ): value is
        | WorkerCommitProposalMessage
        | Extract<WorkerToHostMessage, { kind: 'turn_failed' }>
        | WorkerErrorMessage =>
        (value.kind === 'commit_proposal' || value.kind === 'turn_failed' ||
          value.kind === 'worker_error') &&
        (value.kind === 'worker_error' ||
          sameCorrelation(value.correlation, correlation))
      );
      if (message.kind === 'turn_failed') {
        const diagnostic = message.diagnostic ?? message.outcome.diagnostic;
        const settled = await this.settleExecution(
          execution,
          message.outcome,
          message.providerEvidence,
          diagnostic,
        );
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      if (message.kind === 'worker_error') {
        this.markUnavailable();
        const outcome = failedOutcome(task, this.transcript, message.message);
        const settled = await this.settleExecution(execution, outcome, undefined, undefined);
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      if (!sameCorrelation(message.correlation, correlation)) {
        throw new Error('commit proposal correlation invalid');
      }
      const record = this.proposalRecord(message);
      if (record === undefined) {
        try {
          this.send({
            kind: 'commit_acknowledgement',
            correlation,
            accepted: false,
          });
          execution.acknowledgement = 'rejected_sent';
        } catch {
          execution.acknowledgement = 'delivery_failed';
          this.markUnavailable();
        }
        const outcome = failedOutcome(
          task,
          this.transcript,
          'commit proposal invalid',
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          message.providerEvidence,
          message.diagnostic,
        );
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
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
      try {
        this.options.handle.commit(record);
        execution.storeResult = 'committed';
      } catch {
        try {
          this.send({
            kind: 'commit_acknowledgement',
            correlation,
            accepted: false,
          });
          execution.acknowledgement = 'rejected_sent';
        } catch {
          execution.acknowledgement = 'delivery_failed';
          this.markUnavailable();
        }
        execution.storeResult = 'failed';
        execution.storeError = 'session_io_failure';
        const outcome = failedOutcome(
          task,
          this.transcript,
          'durable session commit failed',
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          message.providerEvidence,
          diagnostic,
        );
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      this.transcript = structuredClone(record.transcript) as Message[];
      this.nextTurn = record.nextTurn;
      this.stateRevision = record.stateRevision;
      this.turnModels = structuredClone(record.turnModels) as SessionTurnModelAttribution[];
      this.turnExecutions = structuredClone(
        record.turnExecutions,
      ) as SessionTurnExecutionAttribution[];
      execution.committedStateRevision = record.stateRevision;
      const committed = await this.persistArtifacts(
        proposedOutcome,
        message.providerEvidence,
        diagnostic,
      );
      const ackSent = (() => {
        try {
          this.send({
            kind: 'commit_acknowledgement',
            correlation,
            accepted: true,
          });
          execution.acknowledgement = 'accepted_sent';
          return true;
        } catch {
          execution.acknowledgement = 'delivery_failed';
          return false;
        }
      })();
      if (!ackSent) {
        execution.settlement = 'committed_generation_unavailable';
        this.markUnavailable();
        const settled = await this.persistExecutionArtifact(execution, committed);
        this.deliver(turnEndFromOutcome(this.nextTurn - 1, settled, true));
        return settled;
      }
      let workerError: WorkerErrorMessage | undefined;
      try {
        const settled = await this.messages.wait((
          value,
        ): value is Extract<WorkerToHostMessage, { kind: 'runtime_event' }> | WorkerErrorMessage =>
          (value.kind === 'runtime_event' || value.kind === 'worker_error') &&
          (value.kind === 'worker_error' || sameCorrelation(value.correlation, correlation))
        );
        if (settled.kind === 'worker_error') workerError = settled;
      } catch {
        this.markUnavailable();
      }
      if (workerError !== undefined) {
        this.markUnavailable();
      }
      execution.settlement = workerError === undefined && !this.unavailable
        ? 'committed'
        : 'committed_generation_unavailable';
      const settled = await this.persistExecutionArtifact(execution, committed);
      this.deliver(turnEndFromOutcome(this.nextTurn - 1, settled, true));
      return settled;
    } catch (error) {
      const outcome = failedOutcome(
        task,
        this.transcript,
        error instanceof Error ? error.message : String(error),
      );
      execution.settlement = 'uncommitted';
      const settled = await this.settleExecution(execution, outcome, undefined, undefined);
      this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
      return settled;
    } finally {
      this.activeExecution = undefined;
      this.active = false;
      this.currentCorrelation = undefined;
    }
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (!this.active || this.currentCorrelation === undefined) return 'idle';
    try {
      this.send({
        kind: 'cancel',
        correlation: this.currentCorrelation,
      });
      return 'requested';
    } catch {
      this.markUnavailable();
      return 'requested';
    }
  }

  steerActiveTurn(text: string): 'accepted' | 'already_accepted' | 'idle' {
    if (!this.active || this.currentCorrelation === undefined) return 'idle';
    try {
      this.send({
        kind: 'steer',
        correlation: this.currentCorrelation,
        text,
      });
      return 'accepted';
    } catch {
      this.markUnavailable();
      return 'accepted';
    }
  }

  isAvailable(): boolean {
    return !this.closed && !this.unavailable && !this.active;
  }

  transcriptSnapshot(): readonly Message[] {
    return structuredClone(this.transcript);
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
      ...(this.title === null ? {} : { title: this.title }),
      agent: this.options.agent,
      committedTurn: this.nextTurn - 1,
      messageCount: this.transcript.length,
      ...(this.checkpoint === undefined ? {} : {
        checkpoint: {
          coveredThroughTurn: this.checkpoint.coveredThroughTurn,
          retainedFromTurn: this.checkpoint.retainedFromTurn,
        },
      }),
    };
  }

  historyPage(
    page: number,
    turn = this.nextTurn - 1,
    rows = 16,
  ): SessionHistoryPage | undefined {
    return historyPageWindow(this.transcript, turn, page, {
      sessionId: this.sessionId,
      agent: this.options.agent,
      rows,
    });
  }

  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined {
    return this.checkpoint === undefined ? undefined : structuredClone(this.checkpoint);
  }

  /** Persist a newly allocated, turn-zero Session before it becomes the active TUI binding. */
  materializeEmptySession(): void {
    if (this.options.handle.record !== undefined) return;
    if (
      this.closed || this.unavailable || this.active || this.currentCorrelation !== undefined ||
      this.nextTurn !== 1 || this.transcript.length !== 0 || this.checkpoint !== undefined ||
      this.title !== null
    ) throw new Error('only a new idle Session can be materialized empty');
    const record: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: this.createdAt,
      title: null,
      stateRevision: this.stateRevision,
      nextTurn: 1,
      transcript: [],
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.modelSelection),
      modelChanges: structuredClone(this.modelChanges),
      turnModels: [],
      turnExecutions: [],
    };
    if (!validateSessionRecordV6(record)) throw new Error('empty session record invalid');
    this.options.handle.commit(record);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.currentManifest === undefined) {
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
      ): value is Extract<WorkerToHostMessage, { kind: 'closed' }> | WorkerErrorMessage =>
        (value.kind === 'closed' || value.kind === 'worker_error') &&
        (value.kind === 'worker_error' || sameCorrelation(value.correlation, correlation)), 5_000);
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
