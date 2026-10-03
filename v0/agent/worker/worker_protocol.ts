import type { FailureDetails } from '../core/failure_details.ts';
import type { WorkerProcessReply, WorkerProcessRequest } from './worker_process_protocol.ts';
import type { AgentEvent } from '../core/events.ts';
import type { LoopOutcome, Message } from '../core/contracts.ts';
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import type { ProviderEvidenceObservation } from '../provider/provider_evidence.ts';
import type { SemanticContextCheckpointV1 } from '../session/session_store.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import type { AgentInstructionSource } from '../definitions/agent_instructions.ts';
import type {
  ContextModelRequestDelta,
  ExecutionContextManifestV2,
  WorkerContextSnapshot,
} from '../history/context_attribution.ts';
import type { SelectedHenjiBaseInstruction } from '../instructions/base_instruction.ts';
import type { ConfigurationRejection } from '../configuration/agent_configuration.ts';
import type { ProviderDeclarationV1 } from '../provider/provider_declaration.ts';
import type { WorkerConfigurationSnapshot } from './worker_configuration.ts';
import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { HenjiInstructionRevisionRef } from '../definitions/managed_resource_ref.ts';
import type {
  AsyncAgentProgress,
  AsyncAgentRequest,
  AsyncAgentResponse,
} from '../tools/async_agents.ts';

/**
 * Slice 1–3's data-only Worker seam.
 *
 * The seam is deliberately small and data-only while the Host/Worker application wire format is
 * being proven. It is the common boundary for executable Definition composition and Worker-local
 * generation semantics; it does not imply a resident Worker or a broader routing protocol.
 */

export const WORKER_PROTOCOL_VERSION = 'slice1-data-only-v2';

/** One declared async child agent: catalog name plus the choice resolved by a new Worker. */
export interface WorkerAsyncAgentCatalogEntry {
  readonly name: string;
  readonly choice: AgentConfigurationChoice;
}

export type DataValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: DataValue }
  | readonly DataValue[];

export interface WorkerCorrelation {
  readonly session: string;
  readonly instanceCorrelation: string;
  readonly workerGeneration: string;
  readonly baseStateRevision: number;
  readonly command: string;
}

export type WorkerHostCommand =
  | WorkerProcessReply
  | {
    readonly kind: 'start';
    readonly correlation: WorkerCorrelation;
    /** Direct Agent-to-Data port transferred by the Core control owner. */
    readonly dataPort?: MessagePort;
    readonly agentChoice: AgentConfigurationChoice;
    /** User config root shared by the Host and Worker credential resolvers. */
    readonly configRoot: string;
    /** Defaults to true for root Workers; child Workers disable recursive child tools. */
    readonly enableAsyncAgents?: boolean;
    /** Spawn-time tool filter (bare tool names) narrowing this generation's declared tools. */
    readonly toolFilter?: readonly string[];
    readonly workspaceRoot?: string;
    readonly physicalIoMode?: 'provider-free' | 'production';
    readonly rootMaxSteps?: number;
    readonly providerTimeoutMs?: number;
    /** Process-local fixed-size diagnostic latch; contains no request or credential data. */
    readonly diagnosticStageBuffer?: SharedArrayBuffer;
    /** Focused-test seam; Data uses the production 1000 ms gap when omitted. */
    readonly auxiliaryStageGapMs?: number;
    readonly initialTranscript?: readonly Message[];
    readonly nextTurn?: number;
    readonly checkpoint?: SemanticContextCheckpointV1;
    readonly modelSelection?: ModelSelection;
    readonly privateStateFromTurn?: number;
    readonly baseInstruction?: SelectedHenjiBaseInstruction;
    readonly providerDeclarations?: readonly ProviderDeclarationV1[];
  }
  | {
    readonly kind: 'select_model';
    readonly correlation: WorkerCorrelation;
    readonly selection: ModelSelection;
    readonly privateStateFromTurn: number;
  }
  | {
    readonly kind: 'turn';
    readonly executionId?: string;
    readonly correlation: WorkerCorrelation;
    readonly task: string;
    /** Captured ChatGPT account registration for this turn; null freezes no selected account. */
    readonly chatgptRegistrationId?: string | null;
  }
  | {
    readonly kind: 'steer';
    readonly correlation: WorkerCorrelation;
    readonly requestId: string;
    readonly text: string;
  }
  | {
    readonly kind: 'cancel';
    readonly correlation: WorkerCorrelation;
  }
  | {
    readonly kind: 'ordered';
    readonly correlation: WorkerCorrelation;
    readonly sequence: number;
  }
  | {
    readonly kind: 'echo';
    readonly correlation: WorkerCorrelation;
    readonly payload: DataValue;
  }
  | {
    readonly kind: 'large_transfer';
    readonly correlation: WorkerCorrelation;
    readonly payload: string;
  }
  | {
    readonly kind: 'permission';
    readonly correlation: WorkerCorrelation;
    readonly readSpecifier: string;
    readonly envKey: string;
  }
  | {
    readonly kind: 'worker_error';
    readonly correlation: WorkerCorrelation;
  }
  | {
    readonly kind: 'uncaught_error';
    readonly correlation: WorkerCorrelation;
  }
  | {
    readonly kind: 'commit_acknowledgement';
    readonly correlation: WorkerCorrelation;
    readonly accepted: boolean;
  }
  | {
    readonly kind: 'checkpoint_acknowledgement';
    readonly correlation: WorkerCorrelation;
    readonly accepted: boolean;
  }
  | {
    readonly kind: 'close';
    readonly correlation: WorkerCorrelation;
  }
  | {
    readonly kind: 'async_agent_response';
    readonly correlation: WorkerCorrelation;
    readonly requestId: string;
    readonly response: AsyncAgentResponse;
  };

export type WorkerRuntimeEvent =
  | { readonly kind: 'agent_event'; readonly event: AgentEvent }
  | { readonly kind: 'ordered'; readonly sequence: number }
  | { readonly kind: 'echo'; readonly payload: DataValue }
  | {
    readonly kind: 'large_transfer';
    readonly byteLength: number;
    readonly payload: string;
  }
  | {
    readonly kind: 'permission';
    readonly read: 'allowed' | 'denied';
    readonly environment: 'allowed' | 'denied';
  }
  | { readonly kind: 'worker_error_observed'; readonly message: string };

export type WorkerEffectObservation = Extract<
  AgentEvent,
  { readonly kind: 'tool_call' | 'tool_result' | 'tool_progress' }
>;

export interface WorkerReadyMessage {
  readonly kind: 'ready';
  readonly correlation: WorkerCorrelation;
  readonly configuration?: WorkerConfigurationSnapshot;
  readonly manifest?: {
    readonly role: 'parent';
    readonly maxSteps: number;
    readonly profileId: string;
    readonly resources: readonly string[];
    readonly rootModel: ModelSelection;
    readonly baseInstruction?: {
      readonly slot: 'instruction:henji-base';
      readonly selectionSource: 'built-in' | 'external';
      readonly ref: HenjiInstructionRevisionRef;
      readonly contentDigest: string;
    };
  };
  readonly startupSnapshot?: {
    readonly instructionSource?: AgentInstructionSource;
    readonly skillNames: readonly string[];
    /** Exact generation basis retained by the Worker and copied by Host admission. */
    readonly context?: WorkerContextSnapshot;
  };
  readonly credentialAvailability?: CredentialAvailability;
}

interface WorkerContextObservation {
  readonly kind: 'model_request_delta';
  readonly delta: ContextModelRequestDelta;
}

export interface WorkerContextObservationMessage {
  readonly kind: 'context_observation';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  readonly observation: WorkerContextObservation;
}

export interface WorkerModelSelectedMessage {
  readonly kind: 'model_selected';
  readonly correlation: WorkerCorrelation;
  readonly accepted: boolean;
  readonly manifest?: WorkerReadyMessage['manifest'];
  readonly credentialAvailability?: CredentialAvailability;
}

export interface WorkerRuntimeEventMessage {
  readonly kind: 'runtime_event';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  readonly event: WorkerRuntimeEvent;
}

export interface WorkerClosedMessage {
  readonly kind: 'closed';
  readonly correlation: WorkerCorrelation;
}

export interface WorkerCancelReceivedMessage {
  readonly kind: 'cancel_received';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  /** Agent receipt time, independent of the later Data control-fact write. */
  readonly observedAt: string;
  readonly result: 'requested' | 'already_requested' | 'idle';
}

export interface WorkerEffectObservationMessage {
  readonly kind: 'effect_observation';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  readonly effect: WorkerEffectObservation;
}

export interface WorkerProviderObservationMessage {
  readonly kind: 'provider_observation';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  readonly turn: number;
  readonly observation: ProviderEvidenceObservation;
}

export interface WorkerCommitProposalMessage {
  readonly kind: 'commit_proposal';
  readonly correlation: WorkerCorrelation;
  readonly transcript: readonly Message[];
  readonly nextTurn: number;
  /** The exact Worker-local settlement metadata for Host projection. */
  readonly outcome?: LoopOutcome;
  /** Final ordered context descriptor manifest for normal settlement validation. */
  readonly contextManifest?: ExecutionContextManifestV2;
  readonly diagnostic?: FailureDiagnosticV1;
}

export interface WorkerCheckpointProposalMessage {
  readonly kind: 'checkpoint_proposal';
  readonly correlation: WorkerCorrelation;
  readonly checkpoint: SemanticContextCheckpointV1;
  readonly heldUserText: string;
}

export interface WorkerTurnFailedMessage {
  readonly kind: 'turn_failed';
  readonly correlation: WorkerCorrelation;
  readonly outcome: LoopOutcome;
  /** Final ordered context descriptor manifest for normal settlement validation. */
  readonly contextManifest?: ExecutionContextManifestV2;
  readonly diagnostic?: FailureDiagnosticV1;
}

/** Small control-channel barrier; the full proposal lives on the Agent Data port. */
export interface WorkerProposalReadyMessage {
  readonly kind: 'proposal_ready';
  readonly proposalId: string;
  readonly correlation: WorkerCorrelation;
  readonly finalDataSequence: number;
}

/** Small control-channel barrier; the full failure outcome lives on the Agent Data port. */
export interface WorkerFailureReadyMessage {
  readonly kind: 'failure_ready';
  readonly executionId: string;
  readonly correlation: WorkerCorrelation;
  readonly finalDataSequence: number;
}

/** Provider request totals needed by Core without forwarding the full Agent outcome. */
export interface WorkerRequestCountMessage {
  readonly kind: 'request_count';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  readonly executionId?: string;
  readonly turnProviderRequestCount?: number;
  readonly runtimeProviderRequestCount?: number;
}

/** Compact progress emitted when a provider request starts; the request body stays on Data. */
export interface WorkerRequestStartedMessage {
  readonly kind: 'request_started';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  readonly requestOrdinal: number;
  readonly modelStep: number;
}

/** Small child-only progress update; full effect observations stay on the Agent Data port. */
export interface WorkerChildProgressMessage {
  readonly kind: 'child_progress';
  readonly correlation: WorkerCorrelation;
  readonly progress: Omit<AsyncAgentProgress, 'updatedAt' | 'phase'> & {
    readonly phase: 'model' | 'tool' | 'between_steps';
  };
}

/** Steering is stored as a Data observation; Core receives this small receipt to clear pending UI. */
interface WorkerSteeringAppliedMessage {
  readonly kind: 'steering_applied';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  readonly text: string;
}

/** Receipt of a correlated steering request by the turn's actual input owner. */
export interface WorkerSteeringReceivedMessage {
  readonly kind: 'steering_received';
  readonly correlation: WorkerCorrelation;
  readonly requestId: string;
  readonly result: 'accepted' | 'already_accepted' | 'idle';
}

/** Emitted after runtime turn cleanup has cleared its active execution state. */
export interface WorkerTurnSettledMessage {
  readonly kind: 'turn_settled';
  readonly correlation: WorkerCorrelation;
}

type WorkerErrorStage =
  | 'composition'
  | 'configuration'
  | 'turn'
  | 'worker_command'
  | 'uncaught';

export interface WorkerErrorMessage {
  readonly kind: 'worker_error';
  readonly correlation?: WorkerCorrelation;
  readonly stage: WorkerErrorStage;
  readonly message: string;
  readonly configurationRejections?: readonly ConfigurationRejection[];
  readonly details?: FailureDetails;
}

/** One data-only async child agent request from the Worker to the Host. */
interface WorkerAsyncAgentRequestMessage {
  readonly kind: 'async_agent_request';
  readonly correlation: WorkerCorrelation;
  readonly requestId: string;
  readonly request: AsyncAgentRequest;
  /** The model tool call that issued this request, when it is a spawn. */
  readonly callId?: string;
}

export type WorkerToHostMessage =
  | WorkerProcessRequest
  | WorkerReadyMessage
  | WorkerModelSelectedMessage
  | WorkerRuntimeEventMessage
  | WorkerEffectObservationMessage
  | WorkerProviderObservationMessage
  | WorkerContextObservationMessage
  | WorkerCommitProposalMessage
  | WorkerProposalReadyMessage
  | WorkerCheckpointProposalMessage
  | WorkerTurnFailedMessage
  | WorkerFailureReadyMessage
  | WorkerRequestCountMessage
  | WorkerRequestStartedMessage
  | WorkerChildProgressMessage
  | WorkerSteeringAppliedMessage
  | WorkerSteeringReceivedMessage
  | WorkerTurnSettledMessage
  | WorkerCancelReceivedMessage
  | WorkerClosedMessage
  | WorkerAsyncAgentRequestMessage
  | WorkerErrorMessage;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Decode only the top-level kind; detailed validation belongs to the owning command. */
export const parseWorkerHostCommand = (
  value: unknown,
): WorkerHostCommand | undefined => {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
  switch (value.kind) {
    case 'start':
    case 'select_model':
    case 'turn':
    case 'steer':
    case 'cancel':
    case 'ordered':
    case 'echo':
    case 'large_transfer':
    case 'permission':
    case 'worker_error':
    case 'uncaught_error':
    case 'commit_acknowledgement':
    case 'checkpoint_acknowledgement':
    case 'close':
    case 'process_response':
    case 'process_event':
    case 'async_agent_response':
      return value as WorkerHostCommand;
    default:
      return undefined;
  }
};
