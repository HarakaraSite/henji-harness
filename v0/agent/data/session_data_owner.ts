import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { WorkerConfigurationSnapshot } from '../worker/worker_configuration.ts';
import {
  createFailureDiagnostic,
  type FailureDiagnosticV1,
} from '../session/failure_diagnostic.ts';
import { captureFailureDetails } from '../core/failure_details.ts';
import type { ContextView, ExecutionView } from '../../api/contract.ts';
import type { JsonValue, LoopOutcomeMetadata, Message } from '../core/contracts.ts';
import type {
  AgentAfterTurnContextUpdate,
  AgentPostSettlementHookUpdate,
} from './agent_data_contract.ts';
import type { ProviderEvidenceObservation } from '../provider/provider_evidence.ts';
import type {
  BeginExecutionInput,
  DataExecutionCompletionControl,
  ExecutionControlEventInput,
  HistoryCaptureResult,
  HistoryExecutionInput,
  HistoryPostSettlementSemanticEventInput,
  StoredExecutionDescriptorSummary,
} from '../history/history_store_contract.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import {
  type SemanticContextCheckpointV1,
  type SessionRecord,
  SessionStoreError,
  validateSemanticContextCheckpoint,
  type WorkerSessionHandle,
  type WorkerSessionMetadataWrite,
  type WorkerSessionOwnerState,
} from '../session/session_store.ts';
import {
  isStoredModelSelection,
  type ModelSelection,
  sameModelSelection,
} from '../provider/model_selection.ts';
import type { WorkerContextSnapshot } from '../history/context_attribution.ts';
import type { RecalledExecutionContext } from '../worker/recalled_execution_context.ts';
import { resolveRecalledExecutionContext } from '../worker/recalled_execution_context.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerProviderObservationMessage,
  WorkerRuntimeEventMessage,
  WorkerTurnFailedMessage,
} from '../worker/worker_protocol.ts';
import type { AgentGenerationContextBasis, ContextTurnRead } from './agent_data_contract.ts';
import { ConversationWriter } from './conversation_writer.ts';
import { type ExecutionDataInput, ExecutionDataJournal } from './execution_data_journal.ts';
import {
  failedOutcome,
  interruptedOutcome,
  proposalOutcome,
  sameCorrelation,
} from '../worker/worker_host_outcome.ts';
import { SessionAuthority } from './session_authority.ts';
import {
  type WorkerExecutionArtifactMetadata,
  type WorkerExecutionStoreResult,
  type WorkerExecutionTraceEntry,
} from '../worker/worker_execution_artifact.ts';
import type { ChildCleanupObservationV1 } from '../worker/worker_child_contract.ts';

export type DataSessionPersistence = 'new' | 'continue' | 'session' | 'none';

/** Small correlated Core/Worker control facts persisted after the direct control action. */
export type DataExecutionControlInput =
  & (
    | Readonly<{
      controlSequence: number;
      kind:
        | 'cancel_requested'
        | 'cancel_sent'
        | 'cancel_failed'
        | 'cancel_escalated';
    }>
    | Readonly<{
      controlSequence: number;
      kind: 'cancel_received';
      correlation: WorkerCorrelation;
      workerSequence: number;
      result: 'requested' | 'already_requested' | 'idle';
    }>
    | Readonly<{
      controlSequence: number;
      kind:
        | 'acknowledgement_requested'
        | 'acknowledgement_sent'
        | 'acknowledgement_failed';
      accepted: boolean;
    }>
    | Readonly<{
      controlSequence: number;
      kind: 'turn_settled';
      correlation: WorkerCorrelation;
    }>
    | Readonly<{
      controlSequence: number;
      kind: 'post_commit_turn_end';
      correlation: WorkerCorrelation;
      turn: number;
      outcome: LoopOutcomeMetadata['stopReason'];
      committed: boolean;
      generationUnavailable: boolean;
    }>
    | Readonly<{
      controlSequence: number;
      kind: 'process_cleanup_finished';
      result: 'complete' | 'failed';
    }>
  )
  & Readonly<{ observedAt?: string }>;

type DataRecallSelectionErrorCode =
  | 'unavailable'
  | 'busy'
  | 'ambiguous'
  | 'failed'
  | 'not_found';

export class DataRecallSelectionError extends Error {
  constructor(readonly code: DataRecallSelectionErrorCode) {
    super(code);
    this.name = 'DataRecallSelectionError';
  }
}

type MemoryWorkerHandle = WorkerSessionHandle;

/** A Session handle for detached runs whose accepted turns live only for this owner lifetime. */
class DetachedSessionHandle implements MemoryWorkerHandle {
  #checkpoint: SemanticContextCheckpointV1 | undefined;

  constructor(readonly id: string) {}

  get checkpoint(): SemanticContextCheckpointV1 | undefined {
    return this.#checkpoint === undefined ? undefined : structuredClone(this.#checkpoint);
  }

  saveMetadata(_update: WorkerSessionMetadataWrite): void {
    // Detached Sessions keep their canonical metadata in SessionAuthority.
  }

  installCheckpoint(checkpoint: SemanticContextCheckpointV1): void {
    this.#checkpoint = structuredClone(checkpoint);
  }

  rollbackCheckpoint(): void {
    this.#checkpoint = undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface DataSessionOwnerOpenInput {
  readonly store: SqliteHistoryStore;
  /** The Data service owns this shared writer and closes it with the store. */
  readonly writer: ConversationWriter;
  readonly workspaceRoot: string;
  readonly persistence: DataSessionPersistence;
  readonly agent: SessionRecord['agent'];
  readonly agentChoice: AgentConfigurationChoice;
  readonly sessionId?: string;
  readonly initialModelSelection?: ModelSelection;
}

export interface DataSessionDescriptor {
  readonly id: string;
  readonly persistence: 'persistent' | 'none';
  readonly agent: SessionRecord['agent'];
  readonly agentChoice: AgentConfigurationChoice;
  readonly modelSelection: ModelSelection;
  readonly stateRevision: number;
  readonly nextTurn: number;
  readonly privateStateFromTurn: number;
  readonly currentPosition: ReturnType<SessionAuthority['currentPosition']>;
  readonly latestExecution?: ExecutionView;
  readonly context: ContextView;
  readonly checkpoint?: Pick<
    SemanticContextCheckpointV1,
    'coveredThroughTurn' | 'retainedFromTurn'
  >;
}

interface DataExecutionAdmissionInput {
  readonly executionId: string;
  readonly taskId: string;
  readonly task: string;
  readonly correlation: WorkerCorrelation;
  readonly createdAt?: string;
  readonly configuration: WorkerConfigurationSnapshot;
  readonly maxSteps: number;
  readonly contextSnapshot?: WorkerContextSnapshot;
  readonly recalledContext?: RecalledExecutionContext;
  readonly parentExecutionId?: string;
  readonly spawnCallId?: string;
}

export interface DataExecutionArtifactMetadataInput {
  readonly protocolTrace?: readonly WorkerExecutionTraceEntry[];
  readonly childCleanup?: ChildCleanupObservationV1;
  readonly storeError?: DataArtifactState['storeError'];
}

export interface DataExecutionAdmissionResult {
  readonly executionId: string;
  readonly descriptor: DataSessionDescriptor;
}

export type DataSessionMutationResult<T extends string> = Readonly<{
  result: T;
  descriptor: DataSessionDescriptor;
}>;

export interface DataProposalToken {
  readonly proposalId: string;
  readonly executionId: string;
  readonly correlation: WorkerCorrelation;
  readonly baseStateRevision: number;
  readonly finalDataSequence: number;
}

export type DataCommitDecision =
  | Readonly<{ accepted: true }>
  | Readonly<{
    accepted: false;
    settlement: 'cancelled' | 'rejected' | 'interrupted';
    reason: string;
  }>;

export interface DataSessionTerminalResult {
  readonly executionId: string;
  readonly sessionId: string;
  readonly durable: boolean;
  readonly canonical: boolean;
  readonly accepted: boolean;
  readonly stateRevision: number;
  readonly nextTurn: number;
  readonly currentPosition: ReturnType<SessionAuthority['currentPosition']>;
  readonly descriptor: DataSessionDescriptor;
  readonly receivedSequence: number;
  readonly durableSequence: number;
  /** The transcript remains Data-owned; Core receives only outcome metadata. */
  readonly outcome: LoopOutcomeMetadata;
  readonly capture?: Omit<HistoryCaptureResult, 'commitDelta'>;
}

interface DataArtifactState {
  readonly protocolTrace?: readonly WorkerExecutionTraceEntry[];
  readonly childCleanup?: ChildCleanupObservationV1;
  readonly storeError?:
    | 'session_io_failure'
    | 'session_invalid'
    | 'history_busy';
}

interface DataExecutionState {
  input: DataExecutionAdmissionInput;
  history: HistoryExecutionInput;
  readonly journal: ExecutionDataJournal;
  readonly prepared: Map<string, PreparedProposal>;
  artifact: DataArtifactState;
  terminal?: DataSessionTerminalResult;
  terminalError?: Error;
  authorization?: boolean;
  sealed?: boolean;
}

interface PreparedProposal {
  readonly token: DataProposalToken;
  readonly message: Pick<
    WorkerCommitProposalMessage,
    'contextManifest' | 'diagnostic'
  >;
  readonly messageSuffix: readonly Message[];
  readonly outcome: LoopOutcomeMetadata;
  readonly nextTurn: number;
  readonly updatedAt: string;
}

const sameToken = (
  left: DataProposalToken,
  right: DataProposalToken,
): boolean =>
  left.proposalId === right.proposalId &&
  left.executionId === right.executionId &&
  left.baseStateRevision === right.baseStateRevision &&
  left.finalDataSequence === right.finalDataSequence &&
  sameCorrelation(left.correlation, right.correlation);

const executionControlEvent = (
  executionId: string,
  input: DataExecutionControlInput,
): ExecutionControlEventInput => {
  const controlSequence = input.controlSequence;
  const eventBase = {
    executionId,
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
  };
  switch (input.kind) {
    case 'cancel_requested':
    case 'cancel_sent':
    case 'cancel_failed':
      return {
        ...eventBase,
        direction: 'host_to_worker',
        source: 'host',
        kind: input.kind,
        payload: { command: 'cancel', controlSequence },
      };
    case 'cancel_received':
      return {
        ...eventBase,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'cancel_received',
        workerSequence: input.workerSequence,
        payload: {
          kind: 'cancel_received',
          correlation: input.correlation,
          sequence: input.workerSequence,
          result: input.result,
          observedAt: input.observedAt ?? new Date().toISOString(),
          controlSequence,
        },
      };
    case 'cancel_escalated':
      return {
        ...eventBase,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'cancel_escalated',
        payload: {
          command: 'terminate',
          reason: 'settlement_deadline_exceeded',
          controlSequence,
        },
      };
    case 'acknowledgement_requested':
    case 'acknowledgement_sent':
    case 'acknowledgement_failed':
      return {
        ...eventBase,
        direction: 'host_to_worker',
        source: 'host',
        kind: input.kind,
        payload: { accepted: input.accepted, controlSequence },
      };
    case 'turn_settled':
      return {
        ...eventBase,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'turn_settled',
        payload: {
          correlation: input.correlation,
          controlSequence,
        },
      };
    case 'post_commit_turn_end':
      return {
        ...eventBase,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'post_commit_turn_end',
        payload: {
          correlation: input.correlation,
          turn: input.turn,
          outcome: input.outcome,
          committed: input.committed,
          generationUnavailable: input.generationUnavailable,
          controlSequence,
        },
      };
    case 'process_cleanup_finished':
      return {
        ...eventBase,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'process_cleanup_finished',
        payload: { result: input.result, controlSequence },
      };
  }
};

/**
 * Data-local owner for one active model Session. It owns the real session handle and canonical
 * authority while sharing the Data service's single ConversationWriter.
 */
export class DataSessionOwner {
  readonly authority: SessionAuthority;
  readonly handle: WorkerSessionHandle;
  readonly persistence: DataSessionPersistence;
  readonly durableCanonicalHistory: boolean;
  readonly #executions = new Map<string, DataExecutionState>();
  readonly #store: SqliteHistoryStore;
  readonly #writer: ConversationWriter;
  #pendingRecall: RecalledExecutionContext | undefined;
  #latestRequest: ContextView['latestRequest'];
  #latestExecutionValue: ExecutionView | undefined;
  #closed = false;

  private constructor(
    private readonly options: DataSessionOwnerOpenInput,
    handle: WorkerSessionHandle,
    state?: WorkerSessionOwnerState,
  ) {
    this.handle = handle;
    this.persistence = options.persistence;
    this.durableCanonicalHistory = options.persistence !== 'none';
    this.#store = options.store;
    this.#writer = options.writer;
    if (this.#writer.store !== options.store) {
      throw new Error('ConversationWriter must use the Data Session store');
    }
    if (
      state !== undefined &&
      (state.workspaceRoot !== options.workspaceRoot ||
        state.agent !== options.agent)
    ) throw new Error('session binding does not match the opened session');
    this.authority = new SessionAuthority({
      sessionId: handle.id,
      workspaceRoot: options.workspaceRoot,
      agent: options.agent,
      agentChoice: options.agentChoice,
      ...(handle.checkpoint === undefined ? {} : { checkpoint: handle.checkpoint }),
      ...(options.initialModelSelection === undefined
        ? {}
        : { initialModelSelection: options.initialModelSelection }),
    }, state);
    this.#latestRequest = this.#readLatestRequest();
    this.#latestExecutionValue = this.#readLatestExecution();
    this.#writer.openSession(handle.id);
  }

  static async open(
    input: DataSessionOwnerOpenInput,
  ): Promise<DataSessionOwner> {
    await input.store.initialize();
    let handle: WorkerSessionHandle;
    let state: WorkerSessionOwnerState | undefined;
    if (input.persistence === 'none') {
      handle = new DetachedSessionHandle(
        input.sessionId ?? crypto.randomUUID().toLowerCase(),
      );
    } else if (input.persistence === 'new') {
      handle = await input.store.allocateWorker(input.agent, input.agentChoice);
    } else if (input.persistence === 'session') {
      if (input.sessionId === undefined) throw new Error('session id required');
      const opened = await input.store.openExistingWorker(input.sessionId);
      handle = opened.handle;
      state = opened.state;
    } else {
      const candidate = (await input.store.listWorker()).sessions.find((
        session,
      ) => session.agent === input.agent);
      if (candidate === undefined) {
        throw new SessionStoreError('session_not_found');
      }
      const opened = await input.store.openExistingWorker(candidate.id);
      handle = opened.handle;
      state = opened.state;
    }
    try {
      return new DataSessionOwner(input, handle, state);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  get sessionId(): string {
    return this.authority.sessionId;
  }

  hasRetainedExecution(executionId: string): boolean {
    return this.#executions.has(executionId);
  }

  descriptor(): DataSessionDescriptor {
    this.#assertOpen();
    const position = this.authority.currentPosition();
    return {
      id: this.sessionId,
      persistence: this.durableCanonicalHistory ? 'persistent' : 'none',
      agent: position.agent,
      agentChoice: this.authority.agentChoice(),
      modelSelection: this.authority.modelSelectionSnapshot(),
      stateRevision: this.authority.projection.stateRevision,
      nextTurn: this.authority.projection.nextTurn,
      privateStateFromTurn: this.authority.privateStateFromTurn(),
      currentPosition: position,
      ...(this.#latestExecutionValue === undefined
        ? {}
        : { latestExecution: structuredClone(this.#latestExecutionValue) }),
      context: {
        ...(position.checkpoint === undefined ? {} : { checkpoint: position.checkpoint }),
        ...(this.#pendingRecall === undefined ? {} : {
          pendingRecall: {
            sourceExecutionId: this.#pendingRecall.sourceExecutionId,
            evidence: this.#pendingRecall.evidence,
          },
        }),
        ...(this.#latestRequest === undefined
          ? {}
          : { latestRequest: structuredClone(this.#latestRequest) }),
      },
      ...(position.checkpoint === undefined ? {} : { checkpoint: position.checkpoint }),
    };
  }

  generationContext(
    correlation: WorkerCorrelation,
  ): AgentGenerationContextBasis {
    this.#assertOpen();
    if (correlation.session !== this.sessionId) {
      throw new Error('session generation correlation mismatch');
    }
    const admitted = [...this.#executions.values()].find((state) =>
      sameCorrelation(state.input.correlation, correlation)
    );
    if (admitted === undefined) {
      if (
        correlation.baseStateRevision !==
          this.authority.projection.stateRevision
      ) {
        throw new Error('session generation correlation mismatch');
      }
    } else if (
      correlation.baseStateRevision !== admitted.history.baseStateRevision
    ) throw new Error('session generation correlation mismatch');
    return {
      initialTranscript: [],
      nextTurn: this.authority.projection.nextTurn,
      stateRevision: this.authority.projection.stateRevision,
      canonicalMessageCount: this.authority.projection.canonicalMessageCount,
      historySource: this.durableCanonicalHistory ? 'canonical' : 'runtime',
      ...(this.authority.checkpointSnapshot() === undefined
        ? {}
        : { checkpoint: this.authority.checkpointSnapshot()! }),
      modelSelection: this.authority.modelSelectionSnapshot(),
      privateStateFromTurn: this.authority.privateStateFromTurn(),
      ...(admitted?.input.recalledContext === undefined
        ? {}
        : { recalledContext: structuredClone(admitted.input.recalledContext) }),
    };
  }

  async readContextTurn(
    correlation: WorkerCorrelation,
    beforeTurn: number,
  ): Promise<ContextTurnRead | null> {
    this.#assertOpen();
    if (correlation.session !== this.sessionId) {
      throw new Error('session generation correlation mismatch');
    }
    if (beforeTurn === 1) return null;
    return await this.#store.readContextTurn(
      this.sessionId,
      beforeTurn,
      this.durableCanonicalHistory ? 'canonical' : 'runtime',
    );
  }

  async prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }> {
    this.#assertOpen();
    if (this.#hasUnsettledExecution()) {
      throw new DataRecallSelectionError('busy');
    }
    const rows = this.#store.listExecutionsForSession(this.sessionId).filter((
      row,
    ) =>
      row.lifecycle === 'settled' && row.adoption === 'non_canonical' &&
      ['cancelled', 'failed', 'interrupted', 'unknown'].includes(row.outcome) &&
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
    let selectedExecutionId: string | undefined;
    if (id === undefined) selectedExecutionId = eligible.at(-1)?.executionId;
    else {
      const matches = eligible.filter((row) => row.executionId.startsWith(id));
      if (matches.length > 1) throw new DataRecallSelectionError('ambiguous');
      selectedExecutionId = matches[0]?.executionId;
    }
    if (selectedExecutionId === undefined) {
      throw new DataRecallSelectionError('not_found');
    }
    try {
      this.#pendingRecall = await resolveRecalledExecutionContext({
        sessionId: this.sessionId,
        executionId: selectedExecutionId,
        historyPersistence: this.#store,
      });
    } catch {
      throw new DataRecallSelectionError('failed');
    }
    return {
      sourceExecutionId: this.#pendingRecall.sourceExecutionId,
      evidence: this.#pendingRecall.evidence,
    };
  }

  clearPendingRecall(): boolean {
    this.#assertOpen();
    const present = this.#pendingRecall !== undefined;
    this.#pendingRecall = undefined;
    return present;
  }

  updateModelSelection(
    selection: ModelSelection,
  ): DataSessionMutationResult<'selected' | 'unchanged'> {
    this.#assertOpen();
    if (this.#hasUnsettledExecution()) throw new Error('session is busy');
    if (!isStoredModelSelection(selection)) {
      throw new RangeError('invalid model selection');
    }
    if (
      sameModelSelection(this.authority.projection.modelSelection, selection)
    ) {
      return { result: 'unchanged', descriptor: this.descriptor() };
    }
    const changedAt = new Date().toISOString();
    const revision = this.authority.projection.stateRevision + 1;
    const change = this.authority.modelChange(selection, changedAt);
    this.handle.saveMetadata(this.authority.metadataWrite({
      updatedAt: changedAt,
      stateRevision: revision,
      modelSelection: selection,
      modelChange: change,
    }));
    this.authority.applyModelSelection(selection, change, revision);
    this.authority.metadataWriteCommitted();
    return { result: 'selected', descriptor: this.descriptor() };
  }

  updateTitle(
    value: string,
  ): DataSessionMutationResult<'renamed' | 'unchanged'> {
    this.#assertOpen();
    if (this.#hasUnsettledExecution()) throw new Error('session is busy');
    const title = this.authority.normalizeTitle(value);
    if (title.length === 0 || title === this.authority.projection.title) {
      return { result: 'unchanged', descriptor: this.descriptor() };
    }
    const changedAt = new Date().toISOString();
    const revision = this.authority.projection.stateRevision + 1;
    this.handle.saveMetadata(this.authority.metadataWrite({
      updatedAt: changedAt,
      stateRevision: revision,
      title,
    }));
    this.authority.applyTitle(title, revision);
    this.authority.metadataWriteCommitted();
    return { result: 'renamed', descriptor: this.descriptor() };
  }

  updateExecutionArtifactMetadata(
    executionId: string,
    metadata: DataExecutionArtifactMetadataInput,
  ): void {
    this.#assertOpen();
    const state = this.#execution(executionId);
    if (state.terminal !== undefined) return;
    state.artifact = {
      ...state.artifact,
      ...(metadata.protocolTrace === undefined
        ? {}
        : { protocolTrace: structuredClone(metadata.protocolTrace) }),
      ...(metadata.childCleanup === undefined
        ? {}
        : { childCleanup: structuredClone(metadata.childCleanup) }),
      ...(metadata.storeError === undefined ? {} : { storeError: metadata.storeError }),
    };
  }

  recordExecutionControl(
    executionId: string,
    input: DataExecutionControlInput,
  ): Promise<DataSessionDescriptor> {
    this.#assertOpen();
    const state = this.#execution(executionId);
    if (
      'correlation' in input &&
      !sameCorrelation(input.correlation, state.input.correlation)
    ) throw new Error('execution control correlation mismatch');
    const recorded = {
      ...input,
      observedAt: input.observedAt ?? new Date().toISOString(),
    } as DataExecutionControlInput;
    if (recorded.kind === 'cancel_requested') {
      state.journal.captureStageSnapshot('cancel_requested');
    } else if (recorded.kind === 'cancel_escalated') {
      state.journal.captureStageSnapshot('cancel_escalated');
    }
    state.journal.appendControl(executionControlEvent(executionId, recorded));
    this.#acceptExecutionControl(state, recorded);
    return Promise.resolve(this.descriptor());
  }

  applyExecutionCompletionControl(
    control: DataExecutionCompletionControl,
  ): boolean {
    this.#assertOpen();
    if (control.sessionId !== this.sessionId) {
      throw new Error('execution completion control Session mismatch');
    }
    if (this.#latestExecutionValue?.executionId !== control.executionId) {
      return false;
    }
    this.#latestExecutionValue = {
      ...this.#latestExecutionValue,
      submittedByCommandId: control.submittedByCommandId,
      processSettlement: control.processSettlement,
    };
    return true;
  }

  #acceptExecutionControl(
    state: DataExecutionState,
    input: DataExecutionControlInput,
  ): void {
    if (this.#latestExecutionValue?.executionId !== state.history.executionId) {
      return;
    }
    const acknowledgement = input.kind === 'acknowledgement_sent'
      ? input.accepted ? 'accepted_sent' : 'rejected_sent'
      : input.kind === 'acknowledgement_failed'
      ? 'delivery_failed'
      : this.#latestExecutionValue.durability.acknowledgement;
    this.#latestExecutionValue = {
      ...this.#latestExecutionValue,
      ...(acknowledgement === undefined ? {} : {
        durability: {
          ...this.#latestExecutionValue.durability,
          acknowledgement,
        },
      }),
      ...(input.kind === 'process_cleanup_finished' &&
          input.result === 'complete'
        ? { processSettlement: 'complete' as const }
        : {}),
    };
  }

  async admit(
    input: DataExecutionAdmissionInput,
  ): Promise<DataExecutionAdmissionResult> {
    this.#assertOpen();
    if (this.#executions.has(input.executionId)) {
      throw new Error('execution already admitted');
    }
    this.#assertSessionCorrelation(input.correlation);
    if (
      input.correlation.baseStateRevision !==
        this.authority.projection.stateRevision
    ) {
      throw new Error('execution base revision is not current');
    }
    this.authority.setConfiguredAgent(input.configuration.agent.name);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const admittedRecall = input.recalledContext ?? this.#pendingRecall;
    const history: HistoryExecutionInput = {
      command: input.correlation.command,
      taskId: input.taskId,
      executionId: input.executionId,
      createdAt,
      sessionCorrelation: this.sessionId,
      ...(this.durableCanonicalHistory ? { canonicalSessionId: this.sessionId } : {}),
      turn: this.authority.projection.nextTurn,
      task: input.task,
      baseStateRevision: input.correlation.baseStateRevision,
      agent: input.configuration.agent.name,
      model: this.authority.modelSelectionSnapshot(),
      build: this.authority.build,
      configurationId: input.configuration.configurationId,
      configuration: input.configuration,
      maxSteps: input.maxSteps,
      instanceCorrelation: input.correlation.instanceCorrelation,
      workerGeneration: input.correlation.workerGeneration,
      ...(admittedRecall === undefined ? {} : { recalledContext: admittedRecall }),
      ...(input.parentExecutionId === undefined
        ? {}
        : { parentExecutionId: input.parentExecutionId }),
      ...(input.spawnCallId === undefined ? {} : { spawnCallId: input.spawnCallId }),
      ...(input.contextSnapshot === undefined ? {} : { contextSnapshot: input.contextSnapshot }),
    };
    const initialSession = this.durableCanonicalHistory
      ? this.authority.initialMetadataWrite()
      : undefined;
    const begin: BeginExecutionInput = {
      ...history,
      sessionMode: this.durableCanonicalHistory ? 'persistent' : 'no_session',
      runtimeMessageStart: this.authority.projection.canonicalMessageCount,
      ...(initialSession === undefined ? {} : { initialSession }),
    };
    const artifact: DataArtifactState = {};
    const state: DataExecutionState = {
      input: {
        ...input,
        createdAt,
        ...(admittedRecall === undefined ? {} : { recalledContext: admittedRecall }),
      },
      history,
      prepared: new Map(),
      artifact,
      journal: new ExecutionDataJournal({
        executionId: input.executionId,
        correlation: input.correlation,
        writer: this.#writer,
        history: this.#store,
        onFailure: (error) => {
          state.terminalError ??= error;
        },
      }),
    };
    await this.#writer.beginExecution(begin);
    if (initialSession !== undefined) this.authority.metadataWriteCommitted();
    this.#executions.set(input.executionId, state);
    this.#latestExecutionValue = this.#executionView(
      this.#store.readLatestExecutionForSession(this.sessionId)!,
    );
    if (input.recalledContext === undefined) this.#pendingRecall = undefined;
    return { executionId: input.executionId, descriptor: this.descriptor() };
  }

  getJournal(executionId: string): ExecutionDataJournal {
    this.#assertOpen();
    const state = this.#execution(executionId);
    return state.journal;
  }

  attachExecutionStageProbe(
    executionId: string,
    correlation: WorkerCorrelation,
    buffer: SharedArrayBuffer | undefined,
    auxiliaryGapMs?: number,
  ): void {
    this.#assertOpen();
    const state = this.#execution(executionId);
    if (!sameCorrelation(correlation, state.input.correlation)) {
      throw new Error('execution stage probe correlation mismatch');
    }
    state.journal.attachStageProbe(correlation, buffer, auxiliaryGapMs);
  }

  receiveData(input: ExecutionDataInput): 'accepted' | 'sealed' {
    this.#assertOpen();
    const accepted = this.#execution(input.executionId).journal.receive(input);
    if (accepted === 'accepted') this.#captureLatestRequest(input);
    if (
      accepted === 'accepted' &&
      this.#latestExecutionValue?.executionId === input.executionId &&
      input.message.kind === 'provider_observation' &&
      input.message.observation.kind === 'request_start'
    ) {
      this.#latestExecutionValue = {
        ...this.#latestExecutionValue,
        requestCount: this.#latestExecutionValue.requestCount + 1,
      };
    }
    return accepted;
  }

  async prepareProposal(input: {
    readonly proposalId?: string;
    readonly executionId: string;
    readonly finalDataSequence: number;
    readonly message: WorkerCommitProposalMessage;
  }): Promise<DataProposalToken> {
    this.#assertOpen();
    const state = this.#execution(input.executionId);
    if (state.terminal !== undefined || state.authorization !== undefined) {
      throw new Error('execution is already settling');
    }
    if (!sameCorrelation(state.input.correlation, input.message.correlation)) {
      throw new Error('commit proposal correlation invalid');
    }
    await state.journal.flushThrough(input.finalDataSequence);
    if (
      state.terminal !== undefined || state.authorization !== undefined ||
      state.sealed === true
    ) throw new Error('execution is already settling');
    const messageSuffix = this.authority.proposalSuffix(input.message);
    if (messageSuffix === undefined) throw new Error('commit proposal invalid');
    const proposalId = input.proposalId ?? crypto.randomUUID().toLowerCase();
    const token: DataProposalToken = {
      proposalId,
      executionId: input.executionId,
      correlation: state.input.correlation,
      baseStateRevision: state.history.baseStateRevision,
      finalDataSequence: input.finalDataSequence,
    };
    if (state.prepared.has(proposalId)) {
      throw new Error('proposal id already prepared');
    }
    const baseOutcome = input.message.outcome === undefined
      ? proposalOutcome(state.history.task, input.message.transcript, undefined)
      : (() => {
        const { transcript: _transcript, ...metadata } = input.message.outcome!;
        return { ...structuredClone(metadata), task: state.history.task };
      })();
    const outcome = baseOutcome.diagnostic === undefined &&
        input.message.diagnostic !== undefined
      ? {
        ...baseOutcome,
        diagnostic: structuredClone(input.message.diagnostic),
      }
      : baseOutcome;
    state.journal.seal();
    state.sealed = true;
    state.prepared.set(proposalId, {
      token,
      message: {
        ...(input.message.contextManifest === undefined ? {} : {
          contextManifest: structuredClone(input.message.contextManifest),
        }),
        ...(input.message.diagnostic === undefined
          ? {}
          : { diagnostic: structuredClone(input.message.diagnostic) }),
      },
      messageSuffix,
      outcome,
      nextTurn: input.message.nextTurn,
      updatedAt: new Date().toISOString(),
    });
    return token;
  }

  authorizeCommit(
    token: DataProposalToken,
    decision: DataCommitDecision,
  ): DataSessionTerminalResult {
    this.#assertOpen();
    const state = this.#execution(token.executionId);
    if (state.terminal !== undefined) return state.terminal;
    if (state.authorization !== undefined) {
      if (state.terminalError !== undefined) throw state.terminalError;
      throw new Error('execution authorization already received');
    }
    const prepared = state.prepared.get(token.proposalId);
    if (prepared === undefined || !sameToken(prepared.token, token)) {
      throw new Error('proposal token mismatch');
    }
    state.authorization = decision.accepted;
    if (decision.accepted) {
      try {
        const result = this.#commitPrepared(state, prepared);
        this.#recordTerminal(state, result);
        return result;
      } catch (error) {
        const caught = error instanceof Error ? error : new Error(String(error));
        this.#captureCommitFailure(state, caught);
        state.terminalError = caught;
        throw caught;
      }
    }
    try {
      state.journal.seal();
      const baseOutcome = this.#rejectionOutcome(state, decision);
      const outcome = baseOutcome.diagnostic === undefined &&
          prepared.message.diagnostic !== undefined
        ? {
          ...baseOutcome,
          diagnostic: structuredClone(prepared.message.diagnostic),
        }
        : baseOutcome;
      const capture = this.#writer.settleNonCanonicalExecution({
        ...state.history,
        messageSuffix: [],
        outcome,
        ...(prepared.message.contextManifest === undefined
          ? {}
          : { contextManifest: prepared.message.contextManifest }),
        ...(prepared.message.diagnostic === undefined
          ? {}
          : { diagnostic: prepared.message.diagnostic }),
        executionMetadata: this.#executionMetadata(state, 'not_attempted'),
      }).result;
      const terminal = this.#terminalResult(
        state,
        outcome,
        capture,
        false,
        true,
      );
      this.#recordTerminal(state, terminal);
      return terminal;
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      this.#captureCommitFailure(state, caught);
      state.terminalError = caught;
      throw caught;
    }
  }

  async settleFailure(input: {
    readonly executionId: string;
    readonly finalDataSequence: number;
    readonly message: WorkerTurnFailedMessage;
  }): Promise<DataSessionTerminalResult> {
    this.#assertOpen();
    const state = this.#execution(input.executionId);
    if (state.terminal !== undefined) return state.terminal;
    if (state.authorization !== undefined) {
      throw new Error('execution authorization already received');
    }
    await state.journal.flushThrough(input.finalDataSequence);
    if (
      state.terminal !== undefined || state.authorization !== undefined ||
      state.sealed === true
    ) throw new Error('execution is already settling');
    if (!sameCorrelation(state.input.correlation, input.message.correlation)) {
      throw new Error('failed turn correlation invalid');
    }
    state.journal.seal();
    state.sealed = true;
    const { transcript: failedTranscript, ...failureMetadata } = input.message.outcome;
    const outcome = {
      ...structuredClone(failureMetadata),
      task: state.history.task,
      ...(input.message.outcome.diagnostic === undefined &&
          input.message.diagnostic !== undefined
        ? { diagnostic: structuredClone(input.message.diagnostic) }
        : {}),
    };
    const messageSuffix = this.authority.messageSuffix(failedTranscript);
    state.authorization = false;
    const capture = this.#writer.settleNonCanonicalExecution({
      ...state.history,
      messageSuffix,
      outcome,
      ...(input.message.contextManifest === undefined
        ? {}
        : { contextManifest: input.message.contextManifest }),
      ...(input.message.diagnostic === undefined ? {} : { diagnostic: input.message.diagnostic }),
      executionMetadata: this.#executionMetadata(state, 'not_attempted'),
    }).result;
    const terminal = this.#terminalResult(state, outcome, capture, false, true);
    this.#recordTerminal(state, terminal);
    return terminal;
  }

  sealGeneration(input: {
    readonly executionId: string;
    readonly decision: 'cancelled' | 'interrupted';
    readonly reason: string;
    readonly diagnostic?: FailureDiagnosticV1;
  }): DataSessionTerminalResult {
    this.#assertOpen();
    const state = this.#execution(input.executionId);
    if (state.terminal !== undefined) return state.terminal;
    if (state.authorization !== undefined) {
      if (state.terminalError !== undefined) throw state.terminalError;
      throw new Error('authorized execution has no terminal result');
    }
    const cut = state.journal.seal();
    state.authorization = false;
    state.sealed = true;
    const baseOutcome = input.decision === 'cancelled'
      ? failedOutcome(
        state.history.task,
        input.reason,
        true,
      )
      : interruptedOutcome(
        state.history.task,
        input.reason,
      );
    const outcome = input.diagnostic === undefined
      ? baseOutcome
      : { ...baseOutcome, diagnostic: input.diagnostic };
    const capture = this.#writer.settleNonCanonicalExecution({
      ...state.history,
      messageSuffix: [],
      outcome,
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
      ...(this.#latestContextManifest(state) === undefined
        ? {}
        : { contextManifest: this.#latestContextManifest(state)! }),
      executionMetadata: this.#executionMetadata(state, 'not_attempted'),
    }).result;
    const terminal = this.#terminalResult(
      state,
      outcome,
      capture,
      false,
      true,
      cut,
    );
    this.#recordTerminal(state, terminal);
    return terminal;
  }

  #captureCommitFailure(state: DataExecutionState, error: Error): void {
    try {
      const diagnostic = createFailureDiagnostic({
        stage: 'session_commit',
        code: 'commit_error',
        providerRequestCount: this.#latestExecutionValue?.requestCount ?? 0,
        turnNumber: state.history.turn,
        modelStep: 0,
        details: captureFailureDetails(error, {
          operation: 'data_authorize_commit',
        }),
      });
      this.#store.recordExecutionFailureDiagnostic(
        state.input.executionId,
        diagnostic,
      );
    } catch {
      // A failed diagnostic save cannot replace the original commit error or adopt the turn.
    }
  }

  installCheckpoint(message: WorkerCheckpointProposalMessage): boolean {
    this.#assertOpen();
    try {
      this.#assertSessionCorrelation(message.correlation);
      if (
        message.correlation.baseStateRevision !==
          this.authority.projection.stateRevision ||
        !validateSemanticContextCheckpoint(message.checkpoint)
      ) return false;
      const completedTurns = this.authority.projection.nextTurn - 1;
      if (
        message.checkpoint.coveredThroughTurn < 1 ||
        message.checkpoint.coveredThroughTurn >= completedTurns ||
        message.checkpoint.retainedFromTurn !==
          message.checkpoint.coveredThroughTurn + 1
      ) return false;
      this.handle.installCheckpoint(message.checkpoint);
      this.authority.applyCheckpoint(message.checkpoint);
      this.authority.recordCheckpointNotice({
        coveredThroughTurn: message.checkpoint.coveredThroughTurn,
        retainedFromTurn: message.checkpoint.retainedFromTurn,
      });
      return true;
    } catch {
      this.authority.clearCheckpointNotice();
      return false;
    }
  }

  installAfterTurnContext(
    update: AgentAfterTurnContextUpdate,
    sequence: number,
  ): boolean {
    this.#assertOpen();
    const state = this.#executions.get(update.executionId);
    const terminal = state?.terminal;
    if (
      state === undefined || terminal === undefined ||
      !sameCorrelation(state.input.correlation, update.correlation) ||
      update.correlation.session !== this.sessionId ||
      state.history.turn !== update.turn ||
      !Number.isSafeInteger(sequence) || sequence < 1 ||
      !terminal.durable ||
      update.effect.settlement.accepted !== terminal.accepted ||
      update.effect.settlement.adopted !== terminal.canonical ||
      update.effect.settlement.durable !== terminal.durable ||
      update.effect.settlement.stateRevision !== terminal.stateRevision ||
      update.effect.settlement.terminalOutcome.ok !== terminal.outcome.ok ||
      update.effect.settlement.terminalOutcome.outcome !==
        terminal.outcome.outcome ||
      update.effect.settlement.terminalOutcome.stopReason !==
        terminal.outcome.stopReason ||
      update.effect.settlement.terminalOutcome.error !== terminal.outcome.error
    ) return false;

    const candidate = update.effect.checkpoint as
      | SemanticContextCheckpointV1
      | undefined;
    if (
      candidate !== undefined &&
      (!terminal.accepted || candidate.sessionId !== this.sessionId ||
        !validateSemanticContextCheckpoint(candidate) ||
        candidate.coveredThroughTurn < 1 ||
        candidate.coveredThroughTurn >= state.history.turn ||
        candidate.retainedFromTurn !== candidate.coveredThroughTurn + 1)
    ) return false;

    const previousCheckpoint = this.authority.checkpointSnapshot();
    if (candidate !== undefined) this.handle.installCheckpoint(candidate);
    try {
      this.#appendPostSettlementProviderObservations(
        update.executionId,
        update.correlation,
        update.turn,
        update.providerObservations ?? [],
        sequence,
      );
      const message: WorkerRuntimeEventMessage = {
        kind: 'runtime_event',
        correlation: update.correlation,
        sequence,
        event: {
          kind: 'agent_event',
          event: {
            kind: 'hook_context_update',
            turn: update.turn,
            effect: structuredClone(update.effect),
          },
        },
      };
      const historyInput: HistoryPostSettlementSemanticEventInput = {
        semanticKind: 'context_update',
        event: {
          executionId: update.executionId,
          observedAt: new Date().toISOString(),
          direction: 'worker_to_host',
          source: 'worker',
          kind: 'runtime_event',
          workerSequence: sequence,
          payload: structuredClone(
            message,
          ) as unknown as import('../core/contracts.ts').JsonValue,
        },
      };
      this.#writer.appendPostSettlementSemanticEvent(historyInput);
    } catch (error) {
      if (candidate !== undefined) {
        if (previousCheckpoint === undefined) this.handle.rollbackCheckpoint();
        else this.handle.installCheckpoint(previousCheckpoint);
      }
      throw error;
    }
    if (candidate !== undefined) {
      this.authority.applyCheckpoint(candidate);
      this.authority.recordCheckpointNotice({
        coveredThroughTurn: candidate.coveredThroughTurn,
        retainedFromTurn: candidate.retainedFromTurn,
      });
    }
    return true;
  }

  installPostSettlementHook(
    update: AgentPostSettlementHookUpdate,
    sequence: number,
  ): boolean {
    this.#assertOpen();
    const state = this.#executions.get(update.executionId);
    const terminal = state?.terminal;
    if (
      state === undefined || terminal === undefined ||
      !sameCorrelation(state.input.correlation, update.correlation) ||
      update.correlation.session !== this.sessionId ||
      state.history.turn !== update.turn ||
      !Number.isSafeInteger(sequence) || sequence < 1 ||
      !terminal.durable ||
      update.settlement.accepted !== terminal.accepted ||
      update.settlement.adopted !== terminal.canonical ||
      update.settlement.durable !== terminal.durable ||
      update.settlement.stateRevision !== terminal.stateRevision ||
      update.settlement.terminalOutcome.ok !== terminal.outcome.ok ||
      update.settlement.terminalOutcome.outcome !== terminal.outcome.outcome ||
      update.settlement.terminalOutcome.stopReason !==
        terminal.outcome.stopReason ||
      update.settlement.terminalOutcome.error !== terminal.outcome.error
    ) return false;

    this.#appendPostSettlementProviderObservations(
      update.executionId,
      update.correlation,
      update.turn,
      update.providerObservations ?? [],
      sequence,
    );
    const message: WorkerRuntimeEventMessage = {
      kind: 'runtime_event',
      correlation: update.correlation,
      sequence,
      event: {
        kind: 'agent_event',
        event: {
          kind: 'hook_lifecycle_update',
          turn: update.turn,
          effect: structuredClone(update.effect),
        },
      },
    };
    this.#writer.appendPostSettlementSemanticEvent({
      semanticKind: 'context_update',
      event: {
        executionId: update.executionId,
        observedAt: new Date().toISOString(),
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: sequence,
        payload: structuredClone(message) as unknown as JsonValue,
      },
    });
    return true;
  }

  #appendPostSettlementProviderObservations(
    executionId: string,
    correlation: WorkerCorrelation,
    turn: number,
    observations: readonly ProviderEvidenceObservation[],
    sequence: number,
  ): void {
    for (const [index, observation] of observations.entries()) {
      const workerSequence = sequence + index + 1;
      const message: WorkerProviderObservationMessage = {
        kind: 'provider_observation',
        correlation,
        sequence: workerSequence,
        turn,
        observation: structuredClone(observation),
      };
      this.#writer.appendPostSettlementSemanticEvent({
        semanticKind: 'model_request',
        event: {
          executionId,
          observedAt: new Date().toISOString(),
          direction: 'worker_to_host',
          source: 'worker',
          // The post-settlement port accepts only semantic runtime_event envelopes;
          // the nested ProviderEvidenceObservation carries the physical fact kind.
          kind: 'runtime_event',
          workerSequence,
          payload: structuredClone(message) as unknown as JsonValue,
        },
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const state of this.#executions.values()) {
      try {
        if (state.terminal === undefined && state.authorization === undefined) {
          state.journal.seal();
        }
      } catch {
        // Data service close owns DB cleanup; an uncommitted prefix remains unclaimed.
      }
    }
    this.#executions.clear();
    await this.handle.close();
    this.#writer.closeSession(this.sessionId);
  }

  #commitPrepared(
    state: DataExecutionState,
    prepared: PreparedProposal,
  ): DataSessionTerminalResult {
    const outcome = prepared.outcome.diagnostic === undefined &&
        prepared.message.diagnostic !== undefined
      ? {
        ...prepared.outcome,
        diagnostic: structuredClone(prepared.message.diagnostic),
      }
      : prepared.outcome;
    const metadata = this.#executionMetadata(state, 'committed');
    const common = {
      ...state.history,
      messageSuffix: prepared.messageSuffix,
      outcome,
      executionMetadata: metadata,
      ...(prepared.message.contextManifest === undefined
        ? {}
        : { contextManifest: prepared.message.contextManifest }),
      ...(prepared.message.diagnostic === undefined
        ? outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }
        : { diagnostic: prepared.message.diagnostic }),
    };
    const capture = this.durableCanonicalHistory
      ? this.#writer.commitCanonicalTurn({
        ...common,
        canonicalSessionId: this.sessionId,
        updatedAt: prepared.updatedAt,
      }).result
      : this.#writer.settleNonCanonicalExecution({
        ...common,
      }).result;

    // The memory projection advances only after its SQLite evidence transaction committed.
    this.authority.applyCommitted(
      prepared.messageSuffix,
      prepared.nextTurn,
      prepared.token.baseStateRevision + 1,
    );
    return this.#terminalResult(
      state,
      outcome,
      capture,
      this.durableCanonicalHistory,
      true,
      undefined,
      true,
    );
  }

  #executionMetadata(
    state: DataExecutionState,
    storeResult: WorkerExecutionStoreResult,
  ): WorkerExecutionArtifactMetadata {
    return {
      storeResult,
      protocolTrace: (state.artifact.protocolTrace ?? []).map((
        entry,
        index,
      ) => ({
        ...entry,
        sequence: index + 1,
      })),
      ...(state.artifact.storeError === undefined ? {} : { storeError: state.artifact.storeError }),
      ...(state.artifact.childCleanup === undefined
        ? {}
        : { childCleanup: state.artifact.childCleanup }),
    };
  }

  #rejectionOutcome(
    state: DataExecutionState,
    decision: Extract<DataCommitDecision, { accepted: false }>,
  ): LoopOutcomeMetadata {
    if (decision.settlement === 'cancelled') {
      return failedOutcome(
        state.history.task,
        decision.reason,
        true,
      );
    }
    if (decision.settlement === 'interrupted') {
      return interruptedOutcome(
        state.history.task,
        decision.reason,
      );
    }
    return failedOutcome(state.history.task, decision.reason);
  }

  #terminalResult(
    state: DataExecutionState,
    outcome: LoopOutcomeMetadata,
    capture: HistoryCaptureResult,
    canonical: boolean,
    durable: boolean,
    cut?: {
      readonly receivedSequence: number;
      readonly durableSequence: number;
    },
    accepted = false,
  ): DataSessionTerminalResult {
    this.#latestExecutionValue = this.#executionView(
      this.#store.readLatestExecutionForSession(this.sessionId)!,
    );
    return {
      executionId: state.history.executionId,
      sessionId: this.sessionId,
      durable,
      canonical,
      accepted,
      stateRevision: this.authority.projection.stateRevision,
      nextTurn: this.authority.projection.nextTurn,
      currentPosition: this.authority.currentPosition(),
      descriptor: this.descriptor(),
      receivedSequence: cut?.receivedSequence ?? state.journal.receivedSequence,
      durableSequence: cut?.durableSequence ?? state.journal.durableSequence,
      outcome: {
        ...outcome,
        ...(capture.diagnosticDurability === undefined
          ? {}
          : { diagnosticDurability: capture.diagnosticDurability }),
        ...(capture.diagnosticPersistenceError === undefined
          ? {}
          : { diagnosticPersistenceError: capture.diagnosticPersistenceError }),
      },
      capture: {
        ...(capture.diagnosticDurability === undefined
          ? {}
          : { diagnosticDurability: capture.diagnosticDurability }),
        ...(capture.diagnosticPersistenceError === undefined
          ? {}
          : { diagnosticPersistenceError: capture.diagnosticPersistenceError }),
        ...(capture.contextDurability === undefined
          ? {}
          : { contextDurability: capture.contextDurability }),
        ...(capture.contextPersistenceError === undefined
          ? {}
          : { contextPersistenceError: capture.contextPersistenceError }),
      },
    };
  }

  #latestContextManifest(state: DataExecutionState) {
    const prepared = [...state.prepared.values()].at(-1);
    return prepared?.message.contextManifest;
  }

  #hasUnsettledExecution(): boolean {
    return [...this.#executions.values()].some((state) =>
      state.terminal === undefined && state.authorization === undefined
    );
  }

  #readLatestExecution(): ExecutionView | undefined {
    const latest = this.#store.readLatestExecutionForSession(this.sessionId);
    if (latest === undefined) return undefined;
    return this.#executionView(latest);
  }

  #executionView(
    latest: StoredExecutionDescriptorSummary,
  ): ExecutionView {
    const completionControl = this.#store.readExecutionCompletionControl(
      latest.executionId,
    );
    return {
      executionId: latest.executionId,
      sessionId: latest.sessionCorrelation,
      task: latest.task,
      turn: latest.turn,
      createdAt: latest.createdAt,
      ...(completionControl === null ? {} : {
        submittedByCommandId: completionControl.submittedByCommandId,
      }),
      lifecycle: latest.lifecycle,
      outcome: latest.outcome,
      ...(latest.stopReason === undefined ? {} : { stopReason: latest.stopReason }),
      ...(latest.diagnostic === undefined ? {} : {
        diagnostic: {
          code: latest.diagnostic.code,
          stage: latest.diagnostic.stage,
        },
      }),
      adoption: latest.adoption,
      ...(latest.committedRevision === undefined
        ? {}
        : { committedRevision: latest.committedRevision }),
      processSettlement: completionControl?.processSettlement ?? 'unknown',
      requestCount: latest.requestCount,
      durability: {
        acknowledgement: latest.acknowledgement,
        generationAvailability: latest.generationAvailability,
        diagnosticCapture: latest.diagnosticCapture,
        artifactCapture: latest.artifactCapture,
        contextCapture: latest.contextCapture,
      },
      ...(latest.diagnosticId === undefined ? {} : { diagnosticId: latest.diagnosticId }),
    };
  }

  #recordTerminal(
    state: DataExecutionState,
    terminal: DataSessionTerminalResult,
  ): void {
    state.journal.captureStageSnapshot('terminal');
    state.journal.closeStageProbe();
    state.terminal = terminal;
    // Keep only the newest settled execution for runtime_stop and current control reads.
    // Older semantic history remains in SQLite and can be queried by its stable locator.
    for (const [executionId, prior] of this.#executions) {
      if (executionId !== state.history.executionId && prior.terminal !== undefined) {
        this.#executions.delete(executionId);
        this.#writer.releaseExecution(executionId);
      }
    }
    state.prepared.clear();
    const {
      contextSnapshot: _contextSnapshot,
      recalledContext: _recalledContext,
      ...smallInput
    } = state.input;
    state.input = smallInput;
    const {
      contextSnapshot: _historyContextSnapshot,
      recalledContext: _historyRecalledContext,
      ...smallHistory
    } = state.history;
    state.history = smallHistory;
    state.artifact = {};
  }

  #captureLatestRequest(input: ExecutionDataInput): void {
    const message = input.message;
    if (
      message.kind !== 'context_observation' ||
      message.observation.kind !== 'model_request_delta'
    ) return;
    const delta = message.observation.delta;
    this.#latestRequest = {
      executionId: input.executionId,
      requestOrdinal: delta.requestOrdinal,
      lane: delta.lane,
      purpose: delta.purpose,
      modelStep: delta.modelStep,
      itemCount: delta.resultItemCount,
    };
  }

  #readLatestRequest(): ContextView['latestRequest'] {
    return this.#store.readLatestRequestForSession(this.sessionId);
  }

  #execution(executionId: string): DataExecutionState {
    const state = this.#executions.get(executionId);
    if (state === undefined) throw new Error('execution not admitted');
    return state;
  }

  #assertSessionCorrelation(correlation: WorkerCorrelation): void {
    if (
      correlation.session !== this.sessionId ||
      correlation.baseStateRevision !== this.authority.projection.stateRevision
    ) throw new Error('session generation correlation mismatch');
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Data Session owner closed');
  }
}
