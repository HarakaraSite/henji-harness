import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { WorkerConfigurationSnapshot } from '../worker/worker_configuration.ts';
import {
  createFailureDiagnostic,
  type FailureDiagnosticV1,
} from '../session/failure_diagnostic.ts';
import { captureFailureDetails } from '../core/failure_details.ts';
import type { ContextView, ExecutionView } from '../../api/contract.ts';
import type { JsonValue, LoopOutcome } from '../core/contracts.ts';
import type {
  AgentAfterTurnContextUpdate,
  AgentPostSettlementHookUpdate,
} from './agent_data_contract.ts';
import type { ProviderEvidenceObservation } from '../provider/provider_evidence.ts';
import type {
  BeginExecutionInput,
  ExecutionControlEventInput,
  HistoryCaptureResult,
  HistoryExecutionInput,
  HistoryPostSettlementSemanticEventInput,
} from '../history/history_store_contract.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import { indexSessionHistory } from '../session/session_history.ts';
import {
  type SemanticContextCheckpointV1,
  type SessionRecord,
  SessionStoreError,
  type StoredSessionRecord,
  validateSemanticContextCheckpoint,
  type WorkerSessionHandle,
} from '../session/session_store.ts';
import {
  isStoredModelSelection,
  type ModelSelection,
  sameModelSelection,
} from '../provider/model_selection.ts';
import type { WorkerContextSnapshot } from '../history/context_attribution.ts';
import type { RecalledExecutionContext } from '../worker/recalled_execution_context.ts';
import {
  recalledExecutionProjectionText,
  resolveRecalledExecutionContext,
} from '../worker/recalled_execution_context.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerProviderObservationMessage,
  WorkerRuntimeEventMessage,
  WorkerTurnFailedMessage,
} from '../worker/worker_protocol.ts';
import type { AgentGenerationContextBasis } from './agent_data_contract.ts';
import {
  ConversationWriter,
  type ConversationWriterDelta,
  type ConversationWriterSnapshot,
  type ConversationWriterWatch,
} from './conversation_writer.ts';
import { type ExecutionDataInput, ExecutionDataJournal } from './execution_data_journal.ts';
import {
  failedOutcome,
  interruptedOutcome,
  proposalOutcome,
  sameCorrelation,
} from '../worker/worker_host_outcome.ts';
import { SessionAuthority } from './session_authority.ts';
import {
  type StoredWorkerExecutionArtifact,
  type WorkerExecutionAcknowledgement,
  type WorkerExecutionArtifactV1,
  workerExecutionOutcome,
  type WorkerExecutionSettlement,
  type WorkerExecutionStoreResult,
  type WorkerExecutionTraceEntry,
} from '../worker/worker_execution_artifact.ts';
import { WorkerExecutionArtifactStoreError } from '../worker/worker_execution_artifact_store.ts';
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
      outcome: LoopOutcome['stopReason'];
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

type MemoryWorkerHandle = WorkerSessionHandle & {
  readonly record: StoredSessionRecord | undefined;
  readonly checkpoint: SemanticContextCheckpointV1 | undefined;
};

/** A Session handle for detached runs whose accepted turns live only for this owner lifetime. */
class DetachedSessionHandle implements MemoryWorkerHandle {
  #record: StoredSessionRecord | undefined;
  #checkpoint: SemanticContextCheckpointV1 | undefined;

  constructor(readonly id: string) {}

  get record(): StoredSessionRecord | undefined {
    return this.#record === undefined ? undefined : structuredClone(this.#record);
  }

  get checkpoint(): SemanticContextCheckpointV1 | undefined {
    return this.#checkpoint === undefined ? undefined : structuredClone(this.#checkpoint);
  }

  commit(record: StoredSessionRecord): void {
    this.#record = structuredClone(record);
  }

  rollback(): void {
    this.#record = undefined;
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
  /** One per-Session watch, owned for this Session's lifetime. */
  readonly onConversationDelta?: (delta: ConversationWriterDelta) => void;
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
  readonly outcome: Omit<LoopOutcome, 'transcript'>;
  readonly capture?: Omit<HistoryCaptureResult, 'commitDelta'>;
}

type DataSessionDeltaListener = (delta: ConversationWriterDelta) => void;

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
  readonly control: {
    acknowledgement?: WorkerExecutionAcknowledgement;
    turnSettled?: boolean;
    turnEnd?: Readonly<{
      committed: boolean;
      generationUnavailable: boolean;
    }>;
    processCleanup?: 'complete' | 'failed';
  };
  artifact: DataArtifactState;
  terminal?: DataSessionTerminalResult;
  terminalError?: Error;
  authorization?: boolean;
  sealed?: boolean;
}

interface PreparedProposal {
  readonly token: DataProposalToken;
  readonly message: WorkerCommitProposalMessage;
  readonly record: StoredSessionRecord;
  readonly outcome: LoopOutcome;
}

const privateStateFromTurn = (
  changes: readonly {
    readonly effectiveFromTurn: number;
    readonly selection: ModelSelection;
  }[],
): number => {
  let boundary = 1;
  for (let index = 1; index < changes.length; index += 1) {
    if (
      changes[index - 1].selection.provider !==
        changes[index].selection.provider ||
      changes[index - 1].selection.modelId !== changes[index].selection.modelId
    ) boundary = changes[index].effectiveFromTurn;
  }
  return boundary;
};

const emptyOutcomeTranscript = (
  outcome: LoopOutcome,
): Omit<LoopOutcome, 'transcript'> => {
  const { transcript: _transcript, ...small } = outcome;
  return small;
};

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
          correlation: structuredClone(input.correlation),
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
          correlation: structuredClone(input.correlation),
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
          correlation: structuredClone(input.correlation),
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

const normalizeOutcome = (
  outcome: LoopOutcome,
): 'completed' | 'cancelled' | 'failed' | 'interrupted' =>
  outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal'
    ? 'completed'
    : outcome.stopReason === 'cancelled'
    ? 'cancelled'
    : outcome.stopReason === 'interrupted'
    ? 'interrupted'
    : 'failed';

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
  readonly #listeners = new Set<DataSessionDeltaListener>();
  readonly #store: SqliteHistoryStore;
  readonly #writer: ConversationWriter;
  #pendingRecall: RecalledExecutionContext | undefined;
  #latestRequest: ContextView['latestRequest'];
  #latestExecutionValue: ExecutionView | undefined;
  #writerWatch: ConversationWriterWatch | undefined;
  #closed = false;

  private constructor(
    private readonly options: DataSessionOwnerOpenInput,
    handle: WorkerSessionHandle,
  ) {
    this.handle = handle;
    this.persistence = options.persistence;
    this.durableCanonicalHistory = options.persistence !== 'none';
    this.#store = options.store;
    this.#writer = options.writer;
    if (this.#writer.store !== options.store) {
      throw new Error('ConversationWriter must use the Data Session store');
    }
    const record = handle.record;
    if (
      record !== undefined &&
      (record.workspaceRoot !== options.workspaceRoot ||
        record.agent !== options.agent)
    ) throw new Error('session binding does not match the opened session');
    this.authority = new SessionAuthority({
      handle,
      workspaceRoot: options.workspaceRoot,
      agent: options.agent,
      agentChoice: options.agentChoice,
      ...(options.initialModelSelection === undefined
        ? {}
        : { initialModelSelection: options.initialModelSelection }),
      durableCanonicalHistory: this.durableCanonicalHistory,
    }, record);
    this.#latestRequest = this.#readLatestRequest();
    this.#latestExecutionValue = this.#readLatestExecution();
    if (record === undefined) this.#writer.initializeEmptySession(handle.id);
    if (options.onConversationDelta !== undefined) {
      this.#listeners.add(options.onConversationDelta);
      this.#ensureWriterWatch();
    }
  }

  static async open(
    input: DataSessionOwnerOpenInput,
  ): Promise<DataSessionOwner> {
    await input.store.initialize();
    let handle: WorkerSessionHandle;
    if (input.persistence === 'none') {
      handle = new DetachedSessionHandle(
        input.sessionId ?? crypto.randomUUID().toLowerCase(),
      );
    } else if (input.persistence === 'new') {
      handle = await input.store.allocateWorker(input.agent, input.agentChoice);
    } else if (input.persistence === 'session') {
      if (input.sessionId === undefined) throw new Error('session id required');
      handle = await input.store.openExistingWorker(input.sessionId);
    } else {
      const candidate = (await input.store.listWorker()).sessions.find((
        session,
      ) => session.agent === input.agent);
      if (candidate === undefined) {
        throw new SessionStoreError('session_not_found');
      }
      handle = await input.store.openExistingWorker(candidate.id);
    }
    try {
      return new DataSessionOwner(input, handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  get sessionId(): string {
    return this.authority.sessionId;
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
      privateStateFromTurn: privateStateFromTurn(
        this.authority.projection.modelChanges,
      ),
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
      initialTranscript: this.authority.transcriptSnapshot(),
      nextTurn: this.authority.projection.nextTurn,
      stateRevision: this.authority.projection.stateRevision,
      ...(this.authority.checkpointSnapshot() === undefined
        ? {}
        : { checkpoint: this.authority.checkpointSnapshot()! }),
      modelSelection: this.authority.modelSelectionSnapshot(),
      privateStateFromTurn: privateStateFromTurn(
        this.authority.projection.modelChanges,
      ),
      ...(admitted?.input.recalledContext === undefined
        ? {}
        : { recalledContext: structuredClone(admitted.input.recalledContext) }),
    };
  }

  snapshot(): ConversationWriterSnapshot {
    this.#assertOpen();
    return this.#writer.snapshotSession(this.sessionId);
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
    const changes = [
      ...structuredClone(this.authority.projection.modelChanges),
      {
        effectiveFromTurn: this.authority.projection.nextTurn,
        changedAt,
        selection: structuredClone(selection),
      },
    ];
    const revision = this.authority.projection.stateRevision + 1;
    const record = this.authority.modelSelectionRecord(
      selection,
      changes,
      revision,
      changedAt,
    );
    this.handle.commit(record);
    this.authority.applyModelSelection(selection, changes, revision);
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
    const record = this.authority.titleRecord(title, revision, changedAt);
    this.handle.commit(record);
    this.authority.applyTitle(title, revision);
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

  async recordExecutionControl(
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
    await this.#updatePostCommitArtifact(state);
    return this.descriptor();
  }

  #acceptExecutionControl(
    state: DataExecutionState,
    input: DataExecutionControlInput,
  ): void {
    if (input.kind === 'acknowledgement_sent') {
      state.control.acknowledgement = input.accepted ? 'accepted_sent' : 'rejected_sent';
    } else if (input.kind === 'acknowledgement_failed') {
      state.control.acknowledgement = 'delivery_failed';
    } else if (input.kind === 'turn_settled') {
      state.control.turnSettled = true;
    } else if (input.kind === 'post_commit_turn_end') {
      state.control.turnEnd = {
        committed: input.committed,
        generationUnavailable: input.generationUnavailable,
      };
    } else if (input.kind === 'process_cleanup_finished') {
      state.control.processCleanup = input.result;
    }

    if (this.#latestExecutionValue?.executionId !== state.history.executionId) {
      return;
    }
    const acknowledgement = state.control.acknowledgement;
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

  async #updatePostCommitArtifact(state: DataExecutionState): Promise<void> {
    if (
      state.terminal === undefined ||
      state.control.acknowledgement === undefined &&
        state.control.turnSettled !== true &&
        state.control.turnEnd === undefined &&
        state.control.processCleanup === undefined
    ) return;
    let artifact: StoredWorkerExecutionArtifact;
    try {
      artifact = await this.#store.executionArtifacts.read(
        state.history.executionId,
      );
    } catch (error) {
      if (
        error instanceof WorkerExecutionArtifactStoreError &&
        error.code === 'worker_execution_artifact_not_found'
      ) return;
      throw error;
    }
    if (artifact.schemaVersion !== 1 || artifact.outcome === undefined) return;
    let settlement: WorkerExecutionArtifactV1['settlement'] = artifact.settlement;
    if (settlement === 'committed_observation_pending') {
      if (
        state.control.acknowledgement === 'delivery_failed' ||
        state.control.processCleanup === 'failed' ||
        state.control.turnEnd?.generationUnavailable === true
      ) settlement = 'committed_generation_unavailable';
      else if (
        state.control.acknowledgement === 'accepted_sent' &&
        state.control.turnSettled === true &&
        state.control.processCleanup === 'complete' &&
        state.control.turnEnd?.committed === true
      ) settlement = 'committed';
    }
    const updated: WorkerExecutionArtifactV1 = {
      ...artifact,
      ...(state.control.acknowledgement === undefined ? {} : {
        acknowledgement: state.control.acknowledgement,
      }),
      settlement,
    };
    this.#store.recordPostCommitObservation(updated);
  }

  watch(listener: DataSessionDeltaListener): ConversationWriterWatch {
    this.#assertOpen();
    const snapshot = this.#writer.snapshotSession(this.sessionId);
    this.#listeners.add(listener);
    this.#ensureWriterWatch();
    let active = true;
    return {
      snapshot,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.#listeners.delete(listener);
      },
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
    const sessionRecord = this.authority.admissionSessionRecord();
    const begin: BeginExecutionInput = {
      ...history,
      sessionMode: this.durableCanonicalHistory ? 'persistent' : 'no_session',
      ...(sessionRecord === undefined ? {} : { sessionRecord }),
    };
    if (
      sessionRecord !== undefined && this.handle.acceptCommitted === undefined
    ) {
      throw new Error(
        'persistent Session handle cannot accept its admitted record',
      );
    }
    const artifact: DataArtifactState = {};
    const state: DataExecutionState = {
      input: {
        ...input,
        createdAt,
        ...(admittedRecall === undefined ? {} : { recalledContext: admittedRecall }),
      },
      history,
      prepared: new Map(),
      control: {},
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
    if (sessionRecord !== undefined) {
      this.handle.acceptCommitted!(sessionRecord);
    }
    this.#executions.set(input.executionId, state);
    this.#latestExecutionValue = this.#executionView(
      this.#store.readExecutionMetadata(input.executionId),
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
    const record = this.authority.proposalRecord(input.message, {
      executionId: state.history.executionId,
      configurationId: state.history.configurationId,
    });
    if (record === undefined) throw new Error('commit proposal invalid');
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
      : {
        ...structuredClone(input.message.outcome),
        task: state.history.task,
        transcript: structuredClone(input.message.transcript),
      };
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
      message: structuredClone(input.message),
      record,
      outcome,
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
      const artifactForCapture = this.#artifactCapture(state, outcome, {
        proposedStateRevision: prepared.record.stateRevision,
        canonical: false,
        diagnostic: prepared.message.diagnostic ?? outcome.diagnostic,

        storeResult: 'not_attempted',
        acknowledgement: 'not_sent',
        settlement: 'uncommitted',
      });
      const capture = this.#writer.settleNonCanonicalExecution({
        ...state.history,
        outcome,
        ...(prepared.message.contextManifest === undefined
          ? {}
          : { contextManifest: prepared.message.contextManifest }),
        ...(prepared.message.diagnostic === undefined
          ? {}
          : { diagnostic: prepared.message.diagnostic }),
        ...(artifactForCapture === undefined ? {} : { artifactForCapture }),
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
    const outcome = {
      ...structuredClone(input.message.outcome),
      task: state.history.task,
      ...(input.message.outcome.diagnostic === undefined &&
          input.message.diagnostic !== undefined
        ? { diagnostic: structuredClone(input.message.diagnostic) }
        : {}),
    };
    state.authorization = false;
    const artifactForCapture = this.#artifactCapture(state, outcome, {
      canonical: false,
      diagnostic: input.message.diagnostic ?? outcome.diagnostic,

      storeResult: 'not_attempted',
      acknowledgement: 'not_sent',
      settlement: 'uncommitted',
    });
    const capture = this.#writer.settleNonCanonicalExecution({
      ...state.history,
      outcome,
      ...(input.message.contextManifest === undefined
        ? {}
        : { contextManifest: input.message.contextManifest }),
      ...(input.message.diagnostic === undefined ? {} : { diagnostic: input.message.diagnostic }),
      ...(artifactForCapture === undefined ? {} : { artifactForCapture }),
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
        this.authority.transcriptSnapshot(),
        input.reason,
        true,
      )
      : interruptedOutcome(
        state.history.task,
        this.authority.transcriptSnapshot(),
        input.reason,
      );
    const outcome = input.diagnostic === undefined
      ? baseOutcome
      : { ...baseOutcome, diagnostic: input.diagnostic };
    const artifactForCapture = this.#artifactCapture(state, outcome, {
      canonical: false,

      storeResult: 'not_attempted',
      acknowledgement: 'not_sent',
      settlement: 'uncommitted',
    });
    const capture = this.#writer.settleNonCanonicalExecution({
      ...state.history,
      outcome,
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
      ...(this.#latestContextManifest(state) === undefined
        ? {}
        : { contextManifest: this.#latestContextManifest(state)! }),
      ...(artifactForCapture === undefined ? {} : { artifactForCapture }),
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
      const completedTurns = indexSessionHistory(this.authority.transcriptSnapshot())?.turns
        .length ?? 0;
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
      update.effect.settlement.terminalOutcome.outcome !== terminal.outcome.outcome ||
      update.effect.settlement.terminalOutcome.stopReason !== terminal.outcome.stopReason ||
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
          payload: structuredClone(message) as unknown as import('../core/contracts.ts').JsonValue,
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
      update.settlement.terminalOutcome.stopReason !== terminal.outcome.stopReason ||
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
    this.#writerWatch?.unsubscribe();
    this.#writerWatch = undefined;
    this.#listeners.clear();
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
  }

  #commitPrepared(
    state: DataExecutionState,
    prepared: PreparedProposal,
  ): DataSessionTerminalResult {
    if (
      this.durableCanonicalHistory && this.handle.acceptCommitted === undefined
    ) {
      throw new Error(
        'persistent Session handle cannot accept an atomic commit',
      );
    }
    const outcome = prepared.outcome.diagnostic === undefined &&
        prepared.message.diagnostic !== undefined
      ? {
        ...prepared.outcome,
        diagnostic: structuredClone(prepared.message.diagnostic),
      }
      : prepared.outcome;
    const artifactForCapture = this.#artifactCapture(state, outcome, {
      committedStateRevision: this.durableCanonicalHistory
        ? prepared.record.stateRevision
        : undefined,
      proposedStateRevision: prepared.record.stateRevision,
      canonical: this.durableCanonicalHistory,
      diagnostic: prepared.message.diagnostic ?? outcome.diagnostic,
    });
    const capture = this.durableCanonicalHistory
      ? this.#writer.commitCanonicalTurn({
        ...state.history,
        canonicalSessionId: this.sessionId,
        contextManifest: prepared.message.contextManifest,
        record: prepared.record,
        outcome,
        ...(prepared.message.diagnostic === undefined
          ? outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }
          : { diagnostic: prepared.message.diagnostic }),
        ...(artifactForCapture === undefined ? {} : { artifactForCapture }),
      }).result
      : this.#writer.settleNonCanonicalExecution({
        ...state.history,
        contextManifest: prepared.message.contextManifest,
        outcome,
        ...(prepared.message.diagnostic === undefined
          ? outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }
          : { diagnostic: prepared.message.diagnostic }),
        ...(artifactForCapture === undefined ? {} : { artifactForCapture }),
      }).result;

    // The memory projection advances only after its SQLite evidence transaction committed.
    if (this.durableCanonicalHistory) {
      this.handle.acceptCommitted!(prepared.record);
    } else this.handle.commit(prepared.record);
    this.authority.applyCommitted(
      prepared.record as import('../session/session_store.ts').SessionRecordV1,
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

  #artifactCapture(
    state: DataExecutionState,
    outcome: LoopOutcome,
    fields: {
      readonly committedStateRevision?: number;
      readonly proposedStateRevision?: number;
      readonly canonical: boolean;
      readonly diagnostic?: LoopOutcome['diagnostic'];
      readonly storeResult?: WorkerExecutionStoreResult;
      readonly acknowledgement?: WorkerExecutionAcknowledgement;
      readonly settlement?: WorkerExecutionSettlement;
    },
  ):
    | ((capture: HistoryCaptureResult) => WorkerExecutionArtifactV1)
    | undefined {
    return (capture) => {
      const capturedOutcome = {
        ...outcome,
        ...(capture.diagnosticDurability === undefined
          ? {}
          : { diagnosticDurability: capture.diagnosticDurability }),
        ...(capture.diagnosticPersistenceError === undefined
          ? {}
          : { diagnosticPersistenceError: capture.diagnosticPersistenceError }),
        ...(fields.diagnostic === undefined ? {} : { diagnostic: fields.diagnostic }),
      };
      const contextCapture = capture.contextDurability === 'partial'
        ? 'failed'
        : capture.contextDurability ?? 'none';
      const eventOutcome = workerExecutionOutcome(capturedOutcome);
      const artifact: WorkerExecutionArtifactV1 = {
        schemaVersion: 1,
        contextCapture,
        executionId: state.history.executionId,
        createdAt: state.history.createdAt,
        settledAt: new Date().toISOString(),
        sessionId: this.sessionId,
        turn: state.history.turn,
        agent: state.history.agent,
        instanceCorrelation: state.history.instanceCorrelation ??
          state.input.correlation.instanceCorrelation,
        workerGeneration: state.history.workerGeneration ??
          state.input.correlation.workerGeneration,
        build: state.history.build,
        configurationId: state.history.configurationId,
        configuration: state.history.configuration,
        model: state.history.model,
        maxSteps: state.history.maxSteps,
        command: {
          kind: 'turn',
          correlation: state.input.correlation,
          task: state.history.task,
        },
        baseStateRevision: state.history.baseStateRevision,
        ...(fields.proposedStateRevision === undefined
          ? {}
          : { proposedStateRevision: fields.proposedStateRevision }),
        ...(fields.committedStateRevision === undefined
          ? {}
          : { committedStateRevision: fields.committedStateRevision }),
        ...(state.input.recalledContext === undefined ? {} : {
          recall: {
            schemaVersion: 1,
            sourceExecutionId: state.input.recalledContext.sourceExecutionId,
            projectedContext: recalledExecutionProjectionText(
              state.input.recalledContext,
            ),
          },
        }),
        protocolTrace: (state.artifact.protocolTrace ?? []).map((
          entry,
          index,
        ) => ({
          ...structuredClone(entry),
          sequence: index + 1,
        })),
        ...(state.artifact.childCleanup === undefined
          ? {}
          : { childCleanup: structuredClone(state.artifact.childCleanup) }),
        storeResult: fields.storeResult ?? 'committed',
        ...(state.artifact.storeError === undefined
          ? {}
          : { storeError: state.artifact.storeError }),
        acknowledgement: fields.acknowledgement ?? 'not_sent',
        settlement: fields.settlement ?? 'committed_observation_pending',
        lifecycle: 'settled',
        normalizedOutcome: normalizeOutcome(capturedOutcome),
        adoption: fields.canonical ? 'canonical' : 'non_canonical',
        outcome: eventOutcome,
        effectCommitRelation: 'not_transactional',
        automaticReplay: false,
      };
      return artifact;
    };
  }

  #rejectionOutcome(
    state: DataExecutionState,
    decision: Extract<DataCommitDecision, { accepted: false }>,
  ): LoopOutcome {
    const transcript = this.authority.transcriptSnapshot();
    if (decision.settlement === 'cancelled') {
      return failedOutcome(
        state.history.task,
        transcript,
        decision.reason,
        true,
      );
    }
    if (decision.settlement === 'interrupted') {
      return interruptedOutcome(
        state.history.task,
        transcript,
        decision.reason,
      );
    }
    return failedOutcome(state.history.task, transcript, decision.reason);
  }

  #terminalResult(
    state: DataExecutionState,
    outcome: LoopOutcome,
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
      this.#store.readExecutionMetadata(state.history.executionId),
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
      outcome: emptyOutcomeTranscript({
        ...outcome,
        ...(capture.diagnosticDurability === undefined
          ? {}
          : { diagnosticDurability: capture.diagnosticDurability }),
        ...(capture.diagnosticPersistenceError === undefined
          ? {}
          : { diagnosticPersistenceError: capture.diagnosticPersistenceError }),
      }),
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

  #ensureWriterWatch(): void {
    if (this.#writerWatch !== undefined) return;
    this.#writerWatch = this.#writer.watchSession(this.sessionId, (delta) => {
      for (const listener of this.#listeners) listener(delta);
    });
  }

  #hasUnsettledExecution(): boolean {
    return [...this.#executions.values()].some((state) =>
      state.terminal === undefined && state.authorization === undefined
    );
  }

  #readLatestExecution(): ExecutionView | undefined {
    const latest = [...this.#store.listExecutionsForSession(this.sessionId)].sort((
      left,
      right,
    ) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.executionId.localeCompare(left.executionId)
    )[0];
    if (latest === undefined) return undefined;
    return this.#executionView(latest);
  }

  #executionView(
    latest: ReturnType<SqliteHistoryStore['readExecutionMetadata']>,
  ): ExecutionView {
    return {
      executionId: latest.executionId,
      sessionId: latest.sessionCorrelation,
      task: latest.task,
      turn: latest.turn,
      createdAt: latest.createdAt,
      lifecycle: latest.lifecycle,
      outcome: latest.outcome,
      ...(latest.outcomeJson?.stopReason === undefined
        ? {}
        : { stopReason: latest.outcomeJson.stopReason }),
      ...(latest.outcomeJson?.diagnostic === undefined ? {} : {
        diagnostic: {
          code: latest.outcomeJson.diagnostic.code,
          stage: latest.outcomeJson.diagnostic.stage,
        },
      }),
      adoption: latest.adoption,
      ...(latest.committedRevision === undefined
        ? {}
        : { committedRevision: latest.committedRevision }),
      processSettlement: 'unknown',
      requestCount: this.#store.readExecutionRequestCount(latest.executionId),
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
    const executions = [...this.#store.listExecutionsForSession(this.sessionId)]
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.executionId.localeCompare(left.executionId)
      );
    for (const execution of executions) {
      let latest: ContextView['latestRequest'];
      for (
        const occurrence of this.#store.listModelRequestOccurrences(
          execution.executionId,
        )
      ) {
        const value = occurrence.payload as {
          readonly event?: {
            readonly kind?: unknown;
            readonly payload?: {
              readonly observation?: {
                readonly kind?: unknown;
                readonly delta?: unknown;
              };
            };
          };
        };
        const delta = value.event?.payload?.observation?.delta as
          | Record<string, unknown>
          | undefined;
        if (
          value.event?.kind !== 'context_observation' ||
          value.event.payload?.observation?.kind !== 'model_request_delta' ||
          delta === undefined || typeof delta.requestOrdinal !== 'number' ||
          (delta.lane !== 'parent' && delta.lane !== 'planner') ||
          typeof delta.purpose !== 'string' ||
          typeof delta.modelStep !== 'number' ||
          typeof delta.resultItemCount !== 'number'
        ) continue;
        if (
          latest === undefined || delta.requestOrdinal > latest.requestOrdinal
        ) {
          latest = {
            executionId: execution.executionId,
            requestOrdinal: delta.requestOrdinal,
            lane: delta.lane,
            purpose: delta.purpose,
            modelStep: delta.modelStep,
            itemCount: delta.resultItemCount,
          };
        }
      }
      if (latest !== undefined) return latest;
    }
    return undefined;
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
