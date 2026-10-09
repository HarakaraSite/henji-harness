import type { FailureDetails } from '../core/failure_details.ts';
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import type {
  ContextView,
  ExecutionReadResult,
  HistoryReadInput,
  SessionsListResult,
} from '../../api/contract.ts';
import type {
  DataCommandReceipt,
  DataExecutionCompletionControl,
  DataFollowUpCursor,
  DataFollowUpPage,
  DataFollowUpReceipt,
} from '../history/history_store_contract.ts';
import type {
  ConversationContentChunk,
  ConversationContentLocator,
  ConversationPageMetadata,
} from '../../conversation/model.ts';
import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { LiveModelCatalogFact } from '../provider/live_model_catalog.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { WorkerContextSnapshot } from '../history/context_attribution.ts';
import type { WorkerConfigurationSnapshot } from '../worker/worker_configuration.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCorrelation,
} from '../worker/worker_protocol.ts';
import type {
  DataCommitDecision,
  DataExecutionAdmissionResult,
  DataExecutionArtifactMetadataInput,
  DataExecutionControlInput,
  DataProposalToken,
  DataSessionDescriptor,
  DataSessionMutationResult,
  DataSessionPersistence,
  DataSessionTerminalResult,
} from './session_data_owner.ts';

export type {
  DataCommitDecision,
  DataExecutionAdmissionResult,
  DataExecutionArtifactMetadataInput,
  DataExecutionControlInput,
  DataProposalToken,
  DataSessionDescriptor,
  DataSessionMutationResult,
  DataSessionPersistence,
  DataSessionTerminalResult,
} from './session_data_owner.ts';
export type {
  DataCommandReceipt,
  DataExecutionCompletionControl,
  DataFollowUpCursor,
  DataFollowUpPage,
  DataFollowUpReceipt,
} from '../history/history_store_contract.ts';

export interface EncodedDataReply {
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export type DataHistoryStreamOpenResult = Readonly<{
  streamId: string;
  sessionId: string | null;
  view: HistoryReadInput['view'];
}>;

export type DataHistoryStreamChunk = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  done: boolean;
}>;

export interface DataConversationSnapshot {
  readonly sessionId: string;
  readonly cut: number;
  readonly storeRevision: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface DataConversationUpdate extends DataConversationSnapshot {
  readonly descriptor: DataSessionDescriptor;
  /** Per-watch port order; each update is released after the receiver ACKs it. */
  readonly deliverySequence: number;
  /** The bytes contain a complete finite snapshot rather than a delta. */
  readonly snapshot?: true;
}

/** Descriptor-only revision, independent of the conversation save cut. */
export interface DataSessionDescriptorUpdate {
  readonly sequence: number;
  readonly descriptor: DataSessionDescriptor;
}

export type DataConversationDeltaListener = (
  update: DataConversationUpdate,
) => void | Promise<void>;
export type DataSessionDescriptorListener = (
  update: DataSessionDescriptorUpdate,
) => void;
export type DataAgentEventListener = (
  sessionId: string,
  eventBytes: Uint8Array<ArrayBuffer>,
) => void;

export type DataSessionOpenInput = Readonly<{
  persistence: DataSessionPersistence;
  agent: string;
  agentChoice: AgentConfigurationChoice;
  sessionId?: string;
  initialModelSelection?: ModelSelection;
}>;

export type DataExecutionAdmitRequest = Readonly<{
  executionId: string;
  taskId: string;
  task: string;
  correlation: WorkerCorrelation;
  createdAt?: string;
  parentExecutionId?: string;
  spawnCallId?: string;
}>;

/** Admission using the real Worker composition sent before startup hooks run. */
export type DataExecutionStartupAdmitRequest =
  & DataExecutionAdmitRequest
  & Readonly<{
    configuration: WorkerConfigurationSnapshot;
    maxSteps: number;
    contextSnapshot?: WorkerContextSnapshot;
  }>;

export type DataPrepareProposalRequest = Readonly<{
  proposalId: string;
  executionId: string;
  finalDataSequence: number;
}>;

export type DataSettleFailureRequest = Readonly<{
  executionId: string;
  finalDataSequence: number;
}>;

export type DataSealGenerationRequest = Readonly<{
  executionId: string;
  decision: 'cancelled' | 'interrupted';
  reason: string;
  diagnostic?: FailureDiagnosticV1;
}>;

export type DataSettleChildExecutionRequest = Readonly<{
  executionId: string;
  proposalId?: string;
  finalDataSequence: number;
  decision?: DataCommitDecision;
  artifactMetadata?: DataExecutionArtifactMetadataInput;
}>;

export interface DataService {
  historyRead(input: HistoryReadInput): Promise<EncodedDataReply>;
  historyStreamOpen(input: HistoryReadInput): Promise<DataHistoryStreamOpenResult>;
  historyStreamRead(streamId: string): Promise<DataHistoryStreamChunk>;
  historyStreamClose(streamId: string): Promise<void>;
  contextRead(
    sessionId: string,
    pendingRecall?: ContextView['pendingRecall'],
    activeSession?: boolean,
  ): Promise<EncodedDataReply>;
  executionRead(executionId: string): Promise<ExecutionReadResult>;
  commandReceiptRead(
    coreEpoch: string,
    commandId: string,
  ): Promise<DataCommandReceipt | null>;
  commandReceiptSave(receipt: DataCommandReceipt): Promise<void>;
  coreSessionCursorRead(
    coreEpoch: string,
    sessionId: string,
  ): Promise<number | null>;
  coreSessionCursorSave(
    coreEpoch: string,
    sessionId: string,
    revision: number,
  ): Promise<void>;
  saveExecutionCompletionControl(
    control: DataExecutionCompletionControl,
  ): Promise<void>;

  openSession(input: DataSessionOpenInput): Promise<DataSessionDescriptor>;
  closeSession(sessionId: string): Promise<void>;
  sessionDescriptor(sessionId: string): Promise<DataSessionDescriptor>;
  sessionsList(): Promise<SessionsListResult>;
  deleteSession(sessionId: string): Promise<void>;
  conversationSnapshot(sessionId: string): Promise<DataConversationSnapshot>;
  conversationPageRead(
    sessionId: string,
    cursor?: number,
    direction?: ConversationPageMetadata['direction'],
  ): Promise<EncodedDataReply>;
  conversationContentRead(
    locator: ConversationContentLocator,
    offset: number,
    length: number,
  ): Promise<ConversationContentChunk>;
  followUpSave(
    coreEpoch: string,
    sessionId: string,
    followUp: import('../../api/contract.ts').FollowUpRecord,
  ): Promise<void>;
  followUpRead(queueId: string): Promise<DataFollowUpReceipt | null>;
  followUpPageRead(
    sessionId: string,
    cursor?: DataFollowUpCursor,
  ): Promise<DataFollowUpPage>;
  watchConversation(
    sessionId: string,
    listener: DataConversationDeltaListener,
  ): Promise<
    {
      readonly snapshot: DataConversationSnapshot;
      readonly unsubscribe: () => void;
    }
  >;
  watchSessionDescriptor(
    sessionId: string,
    listener: DataSessionDescriptorListener,
  ): Promise<
    {
      readonly snapshot: DataSessionDescriptorUpdate;
      readonly unsubscribe: () => void;
    }
  >;

  attachGeneration(
    sessionId: string,
    correlation: WorkerCorrelation,
  ): Promise<MessagePort>;
  executionAdmit(
    sessionId: string,
    input: DataExecutionAdmitRequest,
  ): Promise<DataExecutionAdmissionResult>;
  executionAdmitStartup(
    sessionId: string,
    input: DataExecutionStartupAdmitRequest,
  ): Promise<DataExecutionAdmissionResult>;
  recordExecutionControl(
    sessionId: string,
    executionId: string,
    input: DataExecutionControlInput,
  ): Promise<DataSessionDescriptor>;
  prepareProposal(
    sessionId: string,
    input: DataPrepareProposalRequest,
  ): Promise<DataProposalToken>;
  authorizeCommit(
    sessionId: string,
    token: DataProposalToken,
    decision: DataCommitDecision,
  ): Promise<DataSessionTerminalResult>;
  settleFailure(
    sessionId: string,
    input: DataSettleFailureRequest,
  ): Promise<DataSessionTerminalResult>;
  sealGeneration(
    sessionId: string,
    input: DataSealGenerationRequest,
  ): Promise<DataSessionTerminalResult>;
  settleChildExecution(
    sessionId: string,
    input: DataSettleChildExecutionRequest,
  ): Promise<DataSessionTerminalResult>;
  updateExecutionArtifactMetadata(
    sessionId: string,
    executionId: string,
    metadata: DataExecutionArtifactMetadataInput,
  ): Promise<void>;
  installCheckpoint(
    sessionId: string,
    message: WorkerCheckpointProposalMessage,
  ): Promise<boolean>;
  updateModelSelection(
    sessionId: string,
    selection: ModelSelection,
  ): Promise<DataSessionMutationResult<'selected' | 'unchanged'>>;
  updateTitle(
    sessionId: string,
    title: string,
  ): Promise<DataSessionMutationResult<'renamed' | 'unchanged'>>;
  prepareRecall(
    sessionId: string,
    executionIdPrefix?: string,
  ): Promise<
    {
      readonly sourceExecutionId: string;
      readonly evidence: 'available' | 'unavailable';
    }
  >;
  clearPendingRecall(sessionId: string): Promise<boolean>;
  consumeAutoCompactionNotice(sessionId: string): Promise<
    {
      readonly coveredThroughTurn: number;
      readonly retainedFromTurn: number;
    } | null
  >;
  subscribeAgentEvents(listener: DataAgentEventListener): () => void;
  persistCatalogFacts(facts: readonly LiveModelCatalogFact[]): Promise<void>;

  close(): Promise<void>;
}

export class DataServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
    readonly failureDetails?: FailureDetails,
  ) {
    super(message);
    this.name = 'DataServiceError';
  }
}

export type DataWorkerRequest =
  | Readonly<
    {
      id: number;
      kind: 'initialize';
      stateRoot: string;
      workspaceRoot: string;
      build: BuildManifestV1;
    }
  >
  | Readonly<{ id: number; kind: 'history_read'; input: HistoryReadInput }>
  | Readonly<{ id: number; kind: 'history_stream_open'; input: HistoryReadInput }>
  | Readonly<{ id: number; kind: 'history_stream_read'; streamId: string }>
  | Readonly<{ id: number; kind: 'history_stream_close'; streamId: string }>
  | Readonly<{
    id: number;
    kind: 'context_read';
    sessionId: string;
    pendingRecall?: ContextView['pendingRecall'];
    activeSession: boolean;
  }>
  | Readonly<{ id: number; kind: 'execution_read'; executionId: string }>
  | Readonly<{
    id: number;
    kind: 'command_receipt_read';
    coreEpoch: string;
    commandId: string;
  }>
  | Readonly<{
    id: number;
    kind: 'command_receipt_save';
    receipt: DataCommandReceipt;
  }>
  | Readonly<{
    id: number;
    kind: 'core_session_cursor_read';
    coreEpoch: string;
    sessionId: string;
  }>
  | Readonly<{
    id: number;
    kind: 'core_session_cursor_save';
    coreEpoch: string;
    sessionId: string;
    revision: number;
  }>
  | Readonly<{
    id: number;
    kind: 'execution_completion_control_save';
    control: DataExecutionCompletionControl;
  }>
  | Readonly<{ id: number; kind: 'session_open'; input: DataSessionOpenInput }>
  | Readonly<{ id: number; kind: 'session_close'; sessionId: string }>
  | Readonly<{ id: number; kind: 'session_descriptor'; sessionId: string }>
  | Readonly<{ id: number; kind: 'sessions_list' }>
  | Readonly<{ id: number; kind: 'session_delete'; sessionId: string }>
  | Readonly<{ id: number; kind: 'conversation_snapshot'; sessionId: string }>
  | Readonly<{
    id: number;
    kind: 'conversation_delta_ack';
    sessionId: string;
    deliverySequence: number;
  }>
  | Readonly<{
    id: number;
    kind: 'conversation_page_read';
    sessionId: string;
    cursor?: number;
    direction: ConversationPageMetadata['direction'];
  }>
  | Readonly<{
    id: number;
    kind: 'conversation_content_read';
    locator: ConversationContentLocator;
    offset: number;
    length: number;
  }>
  | Readonly<{
    id: number;
    kind: 'follow_up_save';
    receipt: DataFollowUpReceipt;
  }>
  | Readonly<{
    id: number;
    kind: 'follow_up_read';
    queueId: string;
  }>
  | Readonly<{
    id: number;
    kind: 'follow_up_page_read';
    sessionId: string;
    cursor?: DataFollowUpCursor;
  }>
  | Readonly<{ id: number; kind: 'watch_conversation'; sessionId: string }>
  | Readonly<{ id: number; kind: 'unwatch_conversation'; sessionId: string }>
  | Readonly<
    { id: number; kind: 'watch_session_descriptor'; sessionId: string }
  >
  | Readonly<
    { id: number; kind: 'unwatch_session_descriptor'; sessionId: string }
  >
  | Readonly<
    {
      id: number;
      kind: 'attach_generation';
      sessionId: string;
      correlation: WorkerCorrelation;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'execution_admit';
      sessionId: string;
      input: DataExecutionAdmitRequest;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'execution_admit_startup';
      sessionId: string;
      input: DataExecutionStartupAdmitRequest;
    }
  >
  | Readonly<{
    id: number;
    kind: 'execution_control';
    sessionId: string;
    executionId: string;
    input: DataExecutionControlInput;
  }>
  | Readonly<
    {
      id: number;
      kind: 'prepare_proposal';
      sessionId: string;
      input: DataPrepareProposalRequest;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'authorize_commit';
      sessionId: string;
      token: DataProposalToken;
      decision: DataCommitDecision;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'settle_failure';
      sessionId: string;
      input: DataSettleFailureRequest;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'seal_generation';
      sessionId: string;
      input: DataSealGenerationRequest;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'settle_child';
      sessionId: string;
      input: DataSettleChildExecutionRequest;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'execution_artifact_metadata';
      sessionId: string;
      executionId: string;
      metadata: DataExecutionArtifactMetadataInput;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'install_checkpoint';
      sessionId: string;
      message: WorkerCheckpointProposalMessage;
    }
  >
  | Readonly<
    {
      id: number;
      kind: 'update_model_selection';
      sessionId: string;
      selection: ModelSelection;
    }
  >
  | Readonly<
    { id: number; kind: 'update_title'; sessionId: string; title: string }
  >
  | Readonly<
    {
      id: number;
      kind: 'prepare_recall';
      sessionId: string;
      executionIdPrefix?: string;
    }
  >
  | Readonly<{ id: number; kind: 'clear_recall'; sessionId: string }>
  | Readonly<
    { id: number; kind: 'consume_compaction_notice'; sessionId: string }
  >
  | Readonly<{ id: number; kind: 'agent_events_enabled'; enabled: boolean }>
  | Readonly<{
    id: number;
    kind: 'persist_catalog_facts';
    facts: readonly LiveModelCatalogFact[];
  }>
  | Readonly<{ id: number; kind: 'close' }>;

export type DataWorkerResponse =
  | Readonly<{ id: number; kind: 'initialized' }>
  | Readonly<{ id: number; kind: 'encoded'; bytes: Uint8Array<ArrayBuffer> }>
  | Readonly<{ id: number; kind: 'execution'; result: ExecutionReadResult }>
  | Readonly<{ id: number; kind: 'value'; value: unknown }>
  | Readonly<{ id: number; kind: 'attached_generation'; port: MessagePort }>
  | Readonly<{ id: number; kind: 'closed' }>
  | Readonly<{
    id: number;
    kind: 'error';
    error: Readonly<
      {
        status: number;
        code: string;
        message: string;
        details?: FailureDetails;
      }
    >;
  }>
  | Readonly<{
    kind: 'conversation_delta';
    update: DataConversationUpdate;
  }>
  | Readonly<{
    kind: 'session_descriptor_delta';
    update: DataSessionDescriptorUpdate;
  }>
  | Readonly<{
    kind: 'agent_event';
    sessionId: string;
    eventBytes: Uint8Array<ArrayBuffer>;
  }>;
