import type { AgentEvent } from './events.ts';
import type { LoopOutcome, Message } from './contracts.ts';
import type { FailureDiagnosticV1 } from './failure_diagnostic.ts';
import type { ProviderEvidenceV1 } from './provider_evidence.ts';
import type { SemanticContextCheckpointV1 } from './session_store.ts';

/**
 * Slice 1–3's data-only Worker seam.
 *
 * The seam is deliberately small and data-only while the Host/Worker application wire format is
 * being proven. It is the common boundary for executable Definition composition and Worker-local
 * generation semantics; it does not imply a resident Worker or a broader routing protocol.
 */

export const WORKER_PROTOCOL_VERSION = 'slice1-data-only-v1';

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

export type WorkerHostCommand =
  | {
    readonly kind: 'start';
    readonly correlation: WorkerCorrelation;
    readonly module?: WorkerModuleRevisionRequest;
    readonly workspaceRoot?: string;
    readonly physicalIoMode?: 'provider-free' | 'production';
    readonly initialTranscript?: readonly Message[];
    readonly nextTurn?: number;
    readonly checkpoint?: SemanticContextCheckpointV1;
  }
  | {
    readonly kind: 'turn';
    readonly correlation: WorkerCorrelation;
    readonly task: string;
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
  };
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

export interface WorkerEffectObservationMessage {
  readonly kind: 'effect_observation';
  readonly correlation: WorkerCorrelation;
  readonly sequence: number;
  readonly effect: WorkerEffectObservation;
}

export interface WorkerCommitProposalMessage {
  readonly kind: 'commit_proposal';
  readonly correlation: WorkerCorrelation;
  readonly transcript: readonly Message[];
  readonly nextTurn: number;
  /** The exact Worker-local settlement metadata for Host projection. */
  readonly outcome?: LoopOutcome;
  /** Credential-free evidence captured inside Worker; Host owns persistence. */
  readonly providerEvidence?: ProviderEvidenceV1;
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
  /** Credential-free evidence captured inside Worker; Host owns persistence. */
  readonly providerEvidence?: ProviderEvidenceV1;
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

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerRuntimeEventMessage
  | WorkerEffectObservationMessage
  | WorkerCommitProposalMessage
  | WorkerCheckpointProposalMessage
  | WorkerTurnFailedMessage
  | WorkerClosedMessage
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
      return value as WorkerHostCommand;
    default:
      return undefined;
  }
};
