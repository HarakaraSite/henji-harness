import type { AgentEvent } from '../core/events.ts';
import type { LoopOutcome, Message } from '../core/contracts.ts';
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import type { ProviderEvidenceObservation } from '../provider/provider_evidence.ts';
import type { SemanticContextCheckpointV1 } from '../session/session_store.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import type { AgentInstructionSource } from '../definitions/agent_instructions.ts';
import type { RecalledExecutionContext } from './recalled_execution_context.ts';
import type {
  ContextModelRequestDelta,
  ExecutionContextManifestV2,
  WorkerContextSnapshot,
} from '../history/context_attribution.ts';
import type { SelectedHenjiBaseInstruction } from '../instructions/base_instruction.ts';
import type { ProviderDeclarationV1 } from '../provider/provider_declaration.ts';
import type {
  DefinitionRevisionRef,
  HenjiInstructionRevisionRef,
  ToolDefinitionRevisionRef,
} from '../definitions/managed_resource_ref.ts';
import type { AsyncAgentRequest, AsyncAgentResponse } from '../tools/async_agents.ts';

/**
 * Slice 1–3's data-only Worker seam.
 *
 * The seam is deliberately small and data-only while the Host/Worker application wire format is
 * being proven. It is the common boundary for executable Definition composition and Worker-local
 * generation semantics; it does not imply a resident Worker or a broader routing protocol.
 */

export const WORKER_PROTOCOL_VERSION = 'slice1-data-only-v2';

/** One declared async child agent: catalog name plus its exact Definition revision. */
export interface WorkerAsyncAgentCatalogEntry {
  readonly name: string;
  readonly ref: DefinitionRevisionRef;
}

/** One Host/Worker-resolved tool Definition: exact ref plus its process-local load descriptor. */
export interface WorkerToolDefinitionLoadRequest {
  readonly toolIdentity: string;
  readonly ref: ToolDefinitionRevisionRef;
  readonly module: WorkerDefinitionLoadRequest;
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

export interface WorkerModuleRevisionRequest {
  readonly canonicalSpecifier: string;
  readonly entrySha256: string;
  readonly sourceBytes: number;
}

export interface WorkerManagedClosureFileRequest {
  readonly relativePath: string;
  readonly canonicalSpecifier: string;
  readonly sha256: string;
  readonly sourceBytes: number;
}

/** Process-local physical input. Logical Definition identity remains a separate Host concern. */
export type WorkerDefinitionLoadRequest =
  | WorkerModuleRevisionRequest
  | {
    readonly kind: 'managed';
    readonly entry: WorkerModuleRevisionRequest;
    readonly files: readonly WorkerManagedClosureFileRequest[];
  };

export type WorkerHostCommand =
  | {
    readonly kind: 'start';
    readonly correlation: WorkerCorrelation;
    readonly module?: WorkerDefinitionLoadRequest;
    readonly asyncAgents?: readonly WorkerAsyncAgentCatalogEntry[];
    readonly toolDefinitions?: readonly WorkerToolDefinitionLoadRequest[];
    readonly workspaceRoot?: string;
    readonly physicalIoMode?: 'provider-free' | 'production';
    readonly rootRole?: 'parent' | 'planner';
    readonly rootMaxSteps?: number;
    readonly providerTimeoutMs?: number;
    /** Process-local fixed-size diagnostic latch; contains no request or credential data. */
    readonly diagnosticStageBuffer?: SharedArrayBuffer;
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
    readonly correlation: WorkerCorrelation;
    readonly task: string;
    readonly recalledContext?: RecalledExecutionContext;
  }
  | {
    readonly kind: 'steer';
    readonly correlation: WorkerCorrelation;
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
  | {
    readonly kind: 'module_pre_read';
    readonly sourceBytes: number;
    readonly entrySha256: string;
  }
  | { readonly kind: 'module_closure_verified'; readonly fileCount: number }
  | { readonly kind: 'module_import_start'; readonly specifier: string }
  | { readonly kind: 'module_imported'; readonly specifier: string }
  | { readonly kind: 'worker_error_observed'; readonly message: string };

export type WorkerEffectObservation = Extract<
  AgentEvent,
  { readonly kind: 'tool_call' | 'tool_result' | 'tool_progress' }
>;

export interface WorkerReadyMessage {
  readonly kind: 'ready';
  readonly correlation: WorkerCorrelation;
  readonly module?: {
    readonly canonicalSpecifier: string;
    readonly entrySha256: string;
    readonly sourceBytes: number;
    readonly defaultExport: 'function';
    readonly probe?: string;
  };
  readonly manifest?: {
    readonly role: 'parent' | 'planner';
    readonly maxSteps: number;
    readonly profileId: string;
    readonly resources: readonly string[];
    readonly rootModel: ModelSelection;
    /** Exact tool Definition revisions composed into the root composition. */
    readonly tools?: readonly {
      readonly toolIdentity: string;
      readonly ref: ToolDefinitionRevisionRef;
    }[];
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

export interface WorkerContextObservation {
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

export type WorkerErrorStage =
  | 'module_pre_read'
  | 'module_import'
  | 'module_validation'
  | 'composition'
  | 'turn'
  | 'worker_command'
  | 'uncaught';

export interface WorkerErrorMessage {
  readonly kind: 'worker_error';
  readonly correlation?: WorkerCorrelation;
  readonly stage: WorkerErrorStage;
  readonly message: string;
}

/** One data-only async child agent request from the Worker to the Host. */
export interface WorkerAsyncAgentRequestMessage {
  readonly kind: 'async_agent_request';
  readonly correlation: WorkerCorrelation;
  readonly requestId: string;
  readonly request: AsyncAgentRequest;
  /** The model tool call that issued this request, when it is a spawn. */
  readonly callId?: string;
}

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerModelSelectedMessage
  | WorkerRuntimeEventMessage
  | WorkerEffectObservationMessage
  | WorkerProviderObservationMessage
  | WorkerContextObservationMessage
  | WorkerCommitProposalMessage
  | WorkerCheckpointProposalMessage
  | WorkerTurnFailedMessage
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
    case 'async_agent_response':
      return value as WorkerHostCommand;
    default:
      return undefined;
  }
};
