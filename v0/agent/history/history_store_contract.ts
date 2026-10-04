import type { LoopOutcome, Message } from '../core/contracts.ts';
export type {
  HistoryAssistantTextKey,
  HistoryAssistantTextState,
} from './history_semantic_model.ts';
import type { AgentEvent } from '../core/events.ts';
import type { ProviderEvidenceObservation } from '../provider/provider_evidence.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import type { StoredSessionRecord } from '../session/session_store_contract.ts';
import type { RecalledExecutionContext } from '../worker/recalled_execution_context.ts';
import type { WorkerExecutionArtifactV1 } from '../worker/worker_execution_artifact.ts';
import type {
  WorkerCommitProposalMessage,
  WorkerEffectObservationMessage,
  WorkerErrorMessage,
  WorkerProviderObservationMessage,
  WorkerRuntimeEventMessage,
  WorkerTurnFailedMessage,
} from '../worker/worker_protocol.ts';
import type { WorkerConfigurationSnapshot } from '../worker/worker_configuration.ts';
import type {
  ContextModelRequestRecord,
  ExecutionContextManifestV2,
  ExecutionContextRelation,
  WorkerContextSnapshot,
} from './context_attribution.ts';
import type {
  HistoryAssistantTextState,
  HistorySemanticKind,
  HistorySemanticOccurrence,
} from './history_semantic_model.ts';

type HistoryStoreErrorCode =
  | 'history_busy'
  | 'history_invalid'
  | 'history_io_failure';

type ExecutionLifecycle = 'active' | 'settled';
type ExecutionOutcome =
  | 'unknown'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
type ExecutionAdoption = 'canonical' | 'non_canonical';
type ExecutionEventDirection = 'host_to_worker' | 'worker_to_host';
type ExecutionEventSource = 'host' | 'worker';
type ExecutionEventKind =
  | 'execution_admitted'
  | 'turn_dispatch_requested'
  | 'turn_dispatch_sent'
  | 'turn_dispatch_failed'
  | 'cancel_requested'
  | 'cancel_sent'
  | 'cancel_failed'
  | 'cancel_received'
  | 'cancel_escalated'
  | 'worker_stage_snapshot'
  | 'steer_requested'
  | 'steer_sent'
  | 'steer_failed'
  | 'acknowledgement_requested'
  | 'acknowledgement_sent'
  | 'acknowledgement_failed'
  | 'turn_settled'
  | 'post_commit_turn_end'
  | 'process_cleanup_finished'
  | 'runtime_event'
  | 'effect_observation'
  | 'provider_request_start'
  | 'provider_response_start'
  | 'provider_parser_transition'
  | 'provider_request_failure'
  | 'context_observation'
  | 'execution_settled'
  | 'execution_reconciled';

type HostExecutionEventKind =
  | 'execution_admitted'
  | 'turn_dispatch_requested'
  | 'turn_dispatch_sent'
  | 'turn_dispatch_failed'
  | 'cancel_requested'
  | 'cancel_sent'
  | 'cancel_failed'
  | 'cancel_escalated'
  | 'worker_stage_snapshot'
  | 'steer_requested'
  | 'steer_sent'
  | 'steer_failed'
  | 'acknowledgement_requested'
  | 'acknowledgement_sent'
  | 'acknowledgement_failed'
  | 'post_commit_turn_end'
  | 'process_cleanup_finished'
  | 'execution_settled'
  | 'execution_reconciled';

type WorkerExecutionEventKind = Exclude<
  ExecutionEventKind,
  HostExecutionEventKind
>;

type ProviderObservationPayload<
  K extends ProviderEvidenceObservation['kind'],
> = Omit<WorkerProviderObservationMessage, 'observation'> & {
  readonly observation: Extract<
    ProviderEvidenceObservation,
    { readonly kind: K }
  >;
};

type RuntimeCommitProposalPayload =
  & Omit<WorkerCommitProposalMessage, 'kind'>
  & {
    readonly kind: 'commit_proposal';
  };
type RuntimeTurnFailedPayload = Omit<WorkerTurnFailedMessage, 'kind'> & {
  readonly kind: 'turn_failed';
};
type RuntimeWorkerErrorPayload = Omit<WorkerErrorMessage, 'kind'> & {
  readonly kind: 'worker_error';
};

/** Per-kind payloads keep the wire protocol discriminated at the history boundary. */
export type ExecutionEventPayloadByKind = {
  execution_admitted: {
    readonly taskId: string;
    readonly executionId: string;
    readonly sessionCorrelation: string;
    readonly turn: number;
    readonly task: string;
  };
  turn_dispatch_requested: { readonly task: string };
  turn_dispatch_sent: {
    readonly task: string;
    readonly kind?: 'turn';
  };
  turn_dispatch_failed: { readonly task: string };
  cancel_requested: {
    readonly command: 'cancel';
    readonly controlSequence?: number;
  };
  cancel_sent: {
    readonly command: 'cancel';
    readonly controlSequence?: number;
  };
  cancel_failed: {
    readonly command: 'cancel';
    readonly controlSequence?: number;
  };
  cancel_received:
    & import('../worker/worker_protocol.ts').WorkerCancelReceivedMessage
    & {
      readonly controlSequence?: number;
    };
  cancel_escalated: {
    readonly command: 'terminate';
    readonly reason: 'settlement_deadline_exceeded';
    readonly controlSequence?: number;
  };
  worker_stage_snapshot: import('../worker/worker_stage_probe.ts').WorkerStageHistorySnapshot;
  steer_requested: { readonly text: string };
  steer_sent: { readonly text: string };
  steer_failed: { readonly text: string };
  acknowledgement_requested: {
    readonly accepted: boolean;
    readonly controlSequence?: number;
  };
  acknowledgement_sent: {
    readonly accepted: boolean;
    readonly controlSequence?: number;
  };
  acknowledgement_failed: {
    readonly accepted: boolean;
    readonly controlSequence?: number;
  };
  turn_settled: {
    readonly correlation: import('../worker/worker_protocol.ts').WorkerCorrelation;
    readonly controlSequence: number;
  };
  post_commit_turn_end: {
    readonly correlation: import('../worker/worker_protocol.ts').WorkerCorrelation;
    readonly turn: number;
    readonly outcome: import('../core/contracts.ts').LoopOutcome['stopReason'];
    readonly committed: boolean;
    readonly generationUnavailable: boolean;
    readonly controlSequence: number;
  };
  process_cleanup_finished: {
    readonly result: 'complete' | 'failed';
    readonly controlSequence: number;
  };
  runtime_event:
    | WorkerRuntimeEventMessage
    | RuntimeCommitProposalPayload
    | RuntimeTurnFailedPayload
    | RuntimeWorkerErrorPayload
    | WorkerProviderObservationMessage;
  effect_observation: WorkerEffectObservationMessage;
  context_observation: import('../worker/worker_protocol.ts').WorkerContextObservationMessage;
  provider_request_start: ProviderObservationPayload<'request_start'>;
  provider_response_start: ProviderObservationPayload<'response_start'>;
  provider_parser_transition: ProviderObservationPayload<'parser_transition'>;
  provider_request_failure: ProviderObservationPayload<'request_failure'>;
  execution_settled: {
    readonly outcome: ExecutionOutcome;
    readonly adoption: ExecutionAdoption;
  };
  execution_reconciled: {
    readonly settlement: 'interrupted' | 'unknown';
  };
};

interface ExecutionEventInputBase<K extends ExecutionEventKind> {
  readonly executionId: string;
  readonly observedAt?: string;
  readonly payload: ExecutionEventPayloadByKind[K];
}

/** Direction/source and kind are coupled so ownership cannot be mislabeled. */
type HostExecutionEventInput = {
  [K in HostExecutionEventKind]: ExecutionEventInputBase<K> & {
    readonly direction: 'host_to_worker';
    readonly source: 'host';
    readonly kind: K;
    readonly workerSequence?: never;
  };
}[HostExecutionEventKind];

type WorkerExecutionEventInput = {
  [K in WorkerExecutionEventKind]:
    & ExecutionEventInputBase<K>
    & {
      readonly direction: 'worker_to_host';
      readonly source: 'worker';
      readonly kind: K;
    }
    & (K extends
      | 'runtime_event'
      | 'effect_observation'
      | 'provider_request_start'
      | 'provider_response_start'
      | 'provider_parser_transition'
      | 'provider_request_failure'
      | 'context_observation'
      | 'cancel_received' ? { readonly workerSequence: number }
      : { readonly workerSequence?: never });
}[WorkerExecutionEventKind];

/** A discriminated union by event kind and by its host/worker ownership direction. */
export type ExecutionEventInput =
  | HostExecutionEventInput
  | WorkerExecutionEventInput;

export type ExecutionControlEventInput = {
  [
    K in Extract<
      ExecutionEventKind,
      | 'cancel_requested'
      | 'cancel_sent'
      | 'cancel_failed'
      | 'cancel_received'
      | 'cancel_escalated'
      | 'worker_stage_snapshot'
      | 'acknowledgement_requested'
      | 'acknowledgement_sent'
      | 'acknowledgement_failed'
      | 'turn_settled'
      | 'post_commit_turn_end'
      | 'process_cleanup_finished'
    >
  ]: Extract<ExecutionEventInput, { readonly kind: K }>;
}[
  Extract<
    ExecutionEventKind,
    | 'cancel_requested'
    | 'cancel_sent'
    | 'cancel_failed'
    | 'cancel_received'
    | 'cancel_escalated'
    | 'worker_stage_snapshot'
    | 'acknowledgement_requested'
    | 'acknowledgement_sent'
    | 'acknowledgement_failed'
    | 'turn_settled'
    | 'post_commit_turn_end'
    | 'process_cleanup_finished'
  >
];

export interface StoredExecutionEvent {
  readonly executionId: string;
  readonly ordinal: number;
  /** Original start position when only the latest incomplete text snapshot is retained. */
  readonly firstEventOrdinal?: number;
  readonly observedAt: string;
  readonly direction: ExecutionEventDirection;
  readonly source: ExecutionEventSource;
  readonly kind: ExecutionEventKind;
  readonly workerSequence?: number;
  readonly payload: import('../core/contracts.ts').JsonValue;
}

/** The event returned by an append, with the semantic identity assigned in the same transaction. */
export interface HistoryAppendResult {
  readonly event: StoredExecutionEvent;
  readonly semanticOccurrenceId?: string;
}

/** One explicit semantic event that follows the terminal record of an execution. */
export interface HistoryPostSettlementSemanticEventInput {
  readonly semanticKind: HistorySemanticKind;
  readonly event: Omit<StoredExecutionEvent, 'ordinal'>;
}

type ExecutionEffectStatus =
  | 'observed_requested'
  | 'observed_progress'
  | 'completed'
  | 'outcome_unknown';

export interface StoredExecutionEffect {
  readonly executionId: string;
  readonly callId: string;
  readonly name: string;
  readonly requestedEventOrdinal?: number;
  readonly progressEventOrdinal?: number;
  readonly completedEventOrdinal?: number;
  readonly resultOutcome?: 'success' | 'error';
  readonly status: ExecutionEffectStatus;
}

export interface StoredExecutionRow {
  readonly executionId: string;
  readonly taskId: string;
  readonly task: string;
  readonly canonicalSessionId?: string;
  readonly sessionCorrelation: string;
  /** Parent root execution identity for an async child execution. */
  readonly parentExecutionId?: string;
  /** Model tool call that spawned an async child execution. */
  readonly spawnCallId?: string;
  readonly turn: number;
  readonly createdAt: string;
  readonly settledAt?: string;
  readonly lifecycle: ExecutionLifecycle;
  readonly outcome: ExecutionOutcome;
  readonly outcomeJson?: LoopOutcome;
  readonly adoption: ExecutionAdoption;
  readonly baseRevision: number;
  readonly committedRevision?: number;
  readonly agent: string;
  readonly model: ModelSelection;
  readonly build: BuildManifestV1;
  readonly configurationId: string;
  readonly configuration: WorkerConfigurationSnapshot;
  readonly maxSteps: number;
  readonly instanceCorrelation?: string;
  readonly workerGeneration?: string;
  readonly acknowledgement: string;
  readonly generationAvailability: string;
  readonly diagnosticCapture: string;
  /** At most one structured failure diagnostic linked by the v2 history row. */
  readonly diagnosticId?: string;
  readonly artifactCapture: string;
  readonly contextCapture: 'none' | 'partial' | 'complete' | 'failed';
}

/** Human session timeline input from semantic rows, without diagnostic attachments. */
export interface StoredSessionHistoryExecution {
  readonly execution: StoredExecutionRow;
  readonly messages: readonly Message[];
  readonly thinking: readonly Extract<
    AgentEvent,
    { readonly kind: 'assistant_thinking' }
  >[];
}

/** Original rows needed to replay one Session through the shared Conversation engine. */
export interface StoredSessionConversationExecution {
  readonly execution: StoredExecutionRow;
  readonly occurrences: readonly HistorySemanticOccurrence[];
  readonly assistantTextStates: readonly HistoryAssistantTextState[];
}

/** Facts made durable by one terminal COMMIT, returned without a follow-up history read. */
export interface HistoryCommitDelta {
  readonly executionId: string;
  readonly eventOrdinal: number;
  readonly settledAt: string;
  readonly terminalSemanticOccurrenceId: string;
  readonly outcome: ExecutionOutcome;
  readonly stopReason?: string;
  readonly diagnostic?: Readonly<{ code: string; stage: string }>;
  readonly adoption: ExecutionAdoption;
  readonly committedRevision?: number;
  readonly occurrences: readonly HistorySemanticOccurrence[];
}

export interface BeginExecutionInput extends HistoryExecutionInput {
  /** Admission owner boundary is explicit so a persistent Session cannot be mistaken for detached mode. */
  readonly sessionMode: 'persistent' | 'no_session';
  /** Empty Session materialization for the first persistent turn. */
  readonly sessionRecord?: StoredSessionRecord;
}

export interface ReconcileExecutionInput {
  readonly executionId: string;
  readonly settledAt?: string;
  readonly settlement: 'interrupted' | 'unknown';
  readonly artifact?: WorkerExecutionArtifactV1;
}

export class HistoryStoreError extends Error {
  constructor(readonly code: HistoryStoreErrorCode, message = code) {
    super(message);
    this.name = 'HistoryStoreError';
  }
}

export interface HistoryExecutionInput {
  readonly taskId: string;
  readonly executionId: string;
  readonly createdAt: string;
  readonly sessionCorrelation: string;
  /** Worker command correlation for the admitted turn, retained in the semantic admission record. */
  readonly command: string;
  readonly canonicalSessionId?: string;
  readonly turn: number;
  readonly task: string;
  readonly baseStateRevision: number;
  readonly agent: string;
  readonly model: ModelSelection;
  readonly build: BuildManifestV1;
  readonly configurationId: string;
  readonly configuration: WorkerConfigurationSnapshot;
  readonly maxSteps: number;
  readonly instanceCorrelation?: string;
  readonly workerGeneration?: string;
  readonly recalledContext?: RecalledExecutionContext;
  /** Parent root execution identity for an async child execution. */
  readonly parentExecutionId?: string;
  /** Model tool call that spawned an async child execution. */
  readonly spawnCallId?: string;
  /** Worker generation basis copied atomically at execution admission. */
  readonly contextSnapshot?: WorkerContextSnapshot;
  /** Final Worker context descriptor manifest checked against live rows on settlement. */
  readonly contextManifest?: ExecutionContextManifestV2;
}

interface HistoryCaptureInput {
  readonly diagnostic?: FailureDiagnosticV1;
}

export interface CanonicalTurnCommitInput extends HistoryExecutionInput, HistoryCaptureInput {
  readonly record: StoredSessionRecord;
  readonly outcome: LoopOutcome;
  readonly artifactForCapture?: (
    capture: HistoryCaptureResult,
  ) => WorkerExecutionArtifactV1;
}

export interface NonCanonicalExecutionInput extends HistoryExecutionInput, HistoryCaptureInput {
  readonly outcome: LoopOutcome;
  readonly artifactForCapture?: (
    capture: HistoryCaptureResult,
  ) => WorkerExecutionArtifactV1;
}

export interface HistoryCaptureResult {
  readonly diagnosticDurability?: 'yes' | 'failed' | 'unknown';
  readonly diagnosticPersistenceError?:
    | 'diagnostic_capacity'
    | 'diagnostic_invalid';
  readonly contextDurability?: 'complete' | 'failed' | 'none' | 'partial';
  readonly contextPersistenceError?: 'context_manifest_invalid';
  /** Present on successful production terminal writes for immediate shared-state application. */
  readonly commitDelta?: HistoryCommitDelta;
}

export interface HistoryPersistencePort {
  /** Internal protocol sequence is diagnostic detail and may be disabled by the selected store. */
  capturesProtocolTrace?(): boolean;
  beginExecution(input: BeginExecutionInput): void | Promise<void>;
  appendExecutionEvent(input: ExecutionEventInput): StoredExecutionEvent;
  /** Append several worker observations in one connection and one transaction, preserving order. */
  appendExecutionEvents(
    inputs: readonly ExecutionEventInput[],
  ): readonly StoredExecutionEvent[];
  /** Small control facts may be appended after terminal without changing semantic state. */
  appendExecutionControlEvents(
    inputs: readonly ExecutionControlEventInput[],
  ): readonly StoredExecutionEvent[];
  /** Append a purpose-built semantic fact after execution settlement. */
  appendPostSettlementSemanticEvent(
    input: HistoryPostSettlementSemanticEventInput,
  ): HistoryAppendResult;
  /** Append and return any semantic occurrence identity created for each event. */
  appendExecutionEventsWithSemanticIds?(
    inputs: readonly ExecutionEventInput[],
  ): readonly HistoryAppendResult[];
  /** Pure shape/contract check used to reject an invalid fact before it is projected to the Surface. */
  validateExecutionEvent(input: ExecutionEventInput): boolean;
  /** Bound terminal transcript content before Host history projection. */
  prepareWorkerObservationForHistory?(
    message: import('../worker/worker_protocol.ts').WorkerToHostMessage,
  ): import('../worker/worker_protocol.ts').WorkerToHostMessage;
  reconcileExecution(
    input: ReconcileExecutionInput,
  ): HistoryCommitDelta | undefined;
  listExecutions(): readonly StoredExecutionRow[];
  /** Indexed v6 path used by normal Session recall selection. */
  listExecutionsForSession?(sessionId: string): readonly StoredExecutionRow[];
  /** Raw source facts read from one SQLite snapshot, before display projection or aggregation. */
  readSessionConversationFacts?(
    sessionId: string,
  ): readonly StoredSessionConversationExecution[];
  readExecution(id: string): StoredExecutionRow;
  listExecutionEvents(id: string): readonly StoredExecutionEvent[];
  /** Semantic source rows used by the shared read projection. */
  listSemanticOccurrences?(id: string): readonly HistorySemanticOccurrence[];
  /** Latest request text while its provider request is incomplete. */
  listAssistantTextStates?(id: string): readonly HistoryAssistantTextState[];
  listExecutionEffects(id: string): readonly StoredExecutionEffect[];
  commitCanonicalTurn(input: CanonicalTurnCommitInput): HistoryCaptureResult;
  settleNonCanonicalExecution(
    input: NonCanonicalExecutionInput,
  ): HistoryCaptureResult;
  recordPostCommitObservation(artifact: WorkerExecutionArtifactV1): void;
  listExecutionContext(executionId: string): {
    readonly snapshot?: WorkerContextSnapshot;
    readonly relations: readonly ExecutionContextRelation[];
    readonly requests: readonly ContextModelRequestRecord[];
  };
  readExecutionRequest(
    executionId: string,
    requestOrdinal: number,
  ): ContextModelRequestRecord;
}
