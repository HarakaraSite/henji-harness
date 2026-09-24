import type { LoopOutcome, Message, ProviderExactRequestObservation } from '../core/contracts.ts';
import type { AgentEvent } from '../core/events.ts';
import type {
  ProviderEvidenceObservation,
  ProviderEvidenceV3,
  ProviderEvidenceV4,
  ProviderEvidenceV5,
} from '../provider/provider_evidence.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import type {
  DefinitionRevisionRef,
  SessionRecord,
  StoredSessionRecord,
} from '../session/session_store_contract.ts';
import type { RecalledExecutionContext } from '../worker/recalled_execution_context.ts';
import type {
  StoredWorkerExecutionArtifact,
  WorkerExecutionArtifactV4,
  WorkerExecutionArtifactV5,
  WorkerExecutionArtifactV6,
} from '../worker/worker_execution_artifact.ts';
import type {
  WorkerCommitProposalMessage,
  WorkerEffectObservationMessage,
  WorkerErrorMessage,
  WorkerProviderObservationMessage,
  WorkerReadyMessage,
  WorkerRuntimeEventMessage,
  WorkerTurnFailedMessage,
} from '../worker/worker_protocol.ts';
import type {
  ContextModelRequestRecord,
  ExecutionContextManifestV2,
  ExecutionContextRelation,
  WorkerContextSnapshot,
} from './context_attribution.ts';

export type HistoryStoreErrorCode =
  | 'history_busy'
  | 'history_invalid'
  | 'history_io_failure';

export type ExecutionLifecycle = 'active' | 'settled';
export type ExecutionOutcome =
  | 'unknown'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
export type ExecutionAdoption = 'canonical' | 'non_canonical';
export type ExecutionEventDirection = 'host_to_worker' | 'worker_to_host';
export type ExecutionEventSource = 'host' | 'worker';
export type ExecutionEventKind =
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
  | 'runtime_event'
  | 'effect_observation'
  | 'provider_request_start'
  | 'provider_response_start'
  | 'provider_response_bytes'
  | 'provider_sse_event'
  | 'provider_parser_transition'
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
  cancel_requested: { readonly command: 'cancel' };
  cancel_sent: { readonly command: 'cancel' };
  cancel_failed: { readonly command: 'cancel' };
  cancel_received: import('../worker/worker_protocol.ts').WorkerCancelReceivedMessage;
  cancel_escalated: {
    readonly command: 'terminate';
    readonly reason: 'settlement_deadline_exceeded';
  };
  worker_stage_snapshot: import('../worker/worker_stage_probe.ts').WorkerStageHistorySnapshot;
  steer_requested: { readonly text: string };
  steer_sent: { readonly text: string };
  steer_failed: { readonly text: string };
  acknowledgement_requested: { readonly accepted: boolean };
  acknowledgement_sent: { readonly accepted: boolean };
  acknowledgement_failed: { readonly accepted: boolean };
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
  provider_response_bytes: ProviderObservationPayload<'response_bytes'>;
  provider_sse_event: ProviderObservationPayload<'sse_event'>;
  provider_parser_transition: ProviderObservationPayload<'parser_transition'>;
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
      | 'provider_response_bytes'
      | 'provider_sse_event'
      | 'provider_parser_transition'
      | 'context_observation'
      | 'cancel_received' ? { readonly workerSequence: number }
      : { readonly workerSequence?: never });
}[WorkerExecutionEventKind];

/** A discriminated union by event kind and by its host/worker ownership direction. */
export type ExecutionEventInput =
  | HostExecutionEventInput
  | WorkerExecutionEventInput;

export interface StoredExecutionEvent {
  readonly executionId: string;
  readonly ordinal: number;
  readonly observedAt: string;
  readonly direction: ExecutionEventDirection;
  readonly source: ExecutionEventSource;
  readonly kind: ExecutionEventKind;
  readonly workerSequence?: number;
  readonly payload: import('../core/contracts.ts').JsonValue;
}

export type ExecutionEffectStatus =
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
  readonly agent: SessionRecord['agent'];
  readonly model: ModelSelection;
  readonly build: BuildManifestV1;
  readonly definition: DefinitionRevisionRef;
  readonly manifest?: NonNullable<WorkerReadyMessage['manifest']>;
  readonly instanceCorrelation?: string;
  readonly workerGeneration?: string;
  readonly acknowledgement: string;
  readonly generationAvailability: string;
  readonly evidenceCapture: string;
  /** At most one completed evidence capture is linked by the v2 history row. */
  readonly providerEvidenceId?: string;
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
  readonly thinking: readonly Extract<AgentEvent, { readonly kind: 'assistant_thinking' }>[];
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
  readonly artifact?:
    | WorkerExecutionArtifactV4
    | WorkerExecutionArtifactV5
    | WorkerExecutionArtifactV6;
  readonly evidence?: ProviderEvidenceV4 | ProviderEvidenceV5;
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
  readonly canonicalSessionId?: string;
  readonly turn: number;
  readonly task: string;
  readonly baseStateRevision: number;
  readonly agent: SessionRecord['agent'];
  readonly model: ModelSelection;
  readonly build: BuildManifestV1;
  readonly definition: DefinitionRevisionRef;
  readonly manifest?: NonNullable<WorkerReadyMessage['manifest']>;
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

export interface HistoryCaptureInput {
  readonly evidence?:
    | ProviderEvidenceV3
    | ProviderEvidenceV4
    | ProviderEvidenceV5;
  readonly diagnostic?: FailureDiagnosticV1;
}

export interface CanonicalTurnCommitInput extends HistoryExecutionInput, HistoryCaptureInput {
  readonly record: StoredSessionRecord;
  readonly outcome: LoopOutcome;
  readonly artifactForCapture?: (
    capture: HistoryCaptureResult,
  ) => StoredWorkerExecutionArtifact;
}

export interface NonCanonicalExecutionInput extends HistoryExecutionInput, HistoryCaptureInput {
  readonly outcome: LoopOutcome;
  readonly artifactForCapture?: (
    capture: HistoryCaptureResult,
  ) => StoredWorkerExecutionArtifact;
}

export interface HistoryCaptureResult {
  readonly evidenceDurability?: 'yes' | 'failed' | 'unknown';
  readonly evidencePersistenceError?: 'provider_evidence_invalid';
  readonly diagnosticDurability?: 'yes' | 'failed' | 'unknown';
  readonly diagnosticPersistenceError?:
    | 'diagnostic_capacity'
    | 'diagnostic_invalid';
  readonly contextDurability?: 'complete' | 'failed' | 'none' | 'partial';
  readonly contextPersistenceError?: 'context_manifest_invalid';
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
  /** Pure shape/contract check used to reject an invalid fact before it is projected to the Surface. */
  validateExecutionEvent(input: ExecutionEventInput): boolean;
  /** v6 bounds terminal protocol evidence before the Host clones it into the history queue. */
  prepareWorkerObservationForHistory?(
    message: import('../worker/worker_protocol.ts').WorkerToHostMessage,
  ): import('../worker/worker_protocol.ts').WorkerToHostMessage;
  /** v6 exact outbound capture; the bytes are observed at the provider adapter boundary. */
  appendExactRequestObservation?(
    input: Readonly<{
      executionId: string;
      workerSequence: number;
      observation: ProviderExactRequestObservation;
    }>,
  ): void;
  reconcileExecution(input: ReconcileExecutionInput): void;
  listExecutions(): readonly StoredExecutionRow[];
  /** Indexed v6 path used by normal Session recall selection. */
  listExecutionsForSession?(sessionId: string): readonly StoredExecutionRow[];
  readExecution(id: string): StoredExecutionRow;
  listExecutionEvents(id: string): readonly StoredExecutionEvent[];
  listExecutionEffects(id: string): readonly StoredExecutionEffect[];
  commitCanonicalTurn(input: CanonicalTurnCommitInput): HistoryCaptureResult;
  settleNonCanonicalExecution(
    input: NonCanonicalExecutionInput,
  ): HistoryCaptureResult;
  recordPostCommitObservation(artifact: StoredWorkerExecutionArtifact): void;
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
