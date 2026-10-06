import type { LoopOutcome, LoopOutcomeMetadata } from '../core/contracts.ts';
import type {
  WorkerCorrelation,
  WorkerHostCommand,
  WorkerToHostMessage,
} from './worker_protocol.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import { isStoredModelSelection } from '../provider/model_selection.ts';
import { type BuildManifestV1, isBuildManifest } from '../runtime/build_manifest.ts';
import type { ChildCleanupObservationV1 } from './worker_child_contract.ts';
import type { WorkerConfigurationSnapshot } from './worker_configuration.ts';

/** Current derived execution view. Source settings are data, never executable revision refs. */
export interface WorkerExecutionArtifactV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly createdAt: string;
  readonly settledAt: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly agent: string;
  readonly instanceCorrelation: string;
  readonly workerGeneration: string;
  readonly build: BuildManifestV1;
  readonly configurationId: string;
  readonly configuration: WorkerConfigurationSnapshot;
  readonly model: ModelSelection;
  readonly maxSteps: number;
  readonly command: WorkerExecutionTurnCommand;
  readonly baseStateRevision: number;
  readonly proposedStateRevision?: number;
  readonly committedStateRevision?: number;
  readonly protocolTrace: readonly WorkerExecutionTraceEntry[];
  readonly storeResult: WorkerExecutionStoreResult;
  readonly storeError?: 'session_io_failure' | 'session_invalid' | 'history_busy';
  readonly acknowledgement: WorkerExecutionAcknowledgement;
  readonly settlement: WorkerExecutionSettlement | 'interrupted' | 'unknown';
  readonly lifecycle: 'settled';
  readonly normalizedOutcome: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'unknown';
  readonly adoption: 'canonical' | 'non_canonical';
  readonly outcome?: WorkerExecutionOutcome;
  readonly contextCapture: 'complete' | 'failed' | 'none' | 'partial';
  readonly recall?: WorkerExecutionRecallAttributionV1;
  readonly childCleanup?: ChildCleanupObservationV1;
  readonly effectCommitRelation: 'not_transactional';
  readonly automaticReplay: false;
}

export type WorkerExecutionArtifactMetadata = Pick<
  WorkerExecutionArtifactV1,
  'storeResult' | 'protocolTrace' | 'storeError' | 'childCleanup'
>;

export type WorkerExecutionStoreResult =
  | 'not_attempted'
  | 'failed'
  | 'committed';
export type WorkerExecutionAcknowledgement =
  | 'not_sent'
  | 'rejected_sent'
  | 'accepted_sent'
  | 'delivery_failed';
export type WorkerExecutionSettlement =
  | 'uncommitted'
  | 'committed_observation_pending'
  | 'committed'
  | 'committed_generation_unavailable';

type WorkerExecutionTraceDirection = 'host_to_worker' | 'worker_to_host';

export interface WorkerExecutionTraceEntry {
  readonly direction: WorkerExecutionTraceDirection;
  /** The top-level data-only protocol envelope kind. */
  readonly kind: WorkerHostCommand['kind'] | WorkerToHostMessage['kind'];
  /** Semantic subtype retained without duplicating the protocol payload. */
  readonly semanticSubtype: string;
  readonly sequence: number;
  readonly correlation: WorkerCorrelation;
  readonly ackAccepted?: boolean;
}

interface WorkerExecutionTurnCommand {
  readonly kind: 'turn';
  readonly correlation: WorkerCorrelation;
  readonly task: string;
}

interface WorkerExecutionOutcome {
  readonly ok: boolean;
  readonly outcome: LoopOutcome['outcome'];
  readonly stopReason: LoopOutcome['stopReason'];
  readonly finalText?: string;
  readonly terminalKind?: 'json_result';
  readonly error?: string;
  readonly steps: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly turnProviderRequestCount?: number;
  readonly runtimeProviderRequestCount?: number;
  readonly executionJournalDurability?: 'failed';
  readonly executionJournalPersistenceError?:
    | 'history_busy'
    | 'history_invalid'
    | 'history_io_failure';
}

interface WorkerExecutionRecallAttributionV1 {
  readonly schemaVersion: 1;
  readonly sourceExecutionId: string;
  /** Exact user-context text projected into every model request for this turn. */
  readonly projectedContext: string;
}

export type StoredWorkerExecutionArtifact = WorkerExecutionArtifactV1;

/** Validate the one current derived read format. No historical format conversion. */
export const validateWorkerExecutionArtifact = (
  value: unknown,
): value is StoredWorkerExecutionArtifact => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  const configuration = artifact.configuration as WorkerConfigurationSnapshot | undefined;
  const outcome = artifact.outcome as WorkerExecutionOutcome | undefined;
  return artifact.schemaVersion === 1 && typeof artifact.executionId === 'string' &&
    typeof artifact.agent === 'string' && typeof artifact.configurationId === 'string' &&
    configuration?.schemaVersion === 1 &&
    configuration.configurationId === artifact.configurationId &&
    isBuildManifest(artifact.build) && isStoredModelSelection(artifact.model) &&
    typeof artifact.maxSteps === 'number' && artifact.lifecycle === 'settled' &&
    (artifact.adoption === 'canonical' || artifact.adoption === 'non_canonical') &&
    (outcome === undefined || typeof outcome.ok === 'boolean' && typeof outcome.steps === 'number');
};

export const workerExecutionOutcome = (
  outcome: LoopOutcomeMetadata,
): WorkerExecutionOutcome => {
  const result: WorkerExecutionOutcome = {
    ok: outcome.ok,
    outcome: outcome.outcome,
    stopReason: outcome.stopReason,
    ...(outcome.finalText === undefined ? {} : { finalText: outcome.finalText }),
    ...(outcome.terminalKind === undefined ? {} : { terminalKind: outcome.terminalKind }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    steps: outcome.steps,
    toolCallCount: outcome.toolCallCount,
    toolResultCount: outcome.toolResultCount,
    ...(outcome.turnProviderRequestCount === undefined ? {} : {
      turnProviderRequestCount: outcome.turnProviderRequestCount,
    }),
    ...(outcome.runtimeProviderRequestCount === undefined ? {} : {
      runtimeProviderRequestCount: outcome.runtimeProviderRequestCount,
    }),
    ...(outcome.executionJournalDurability === undefined ? {} : {
      executionJournalDurability: outcome.executionJournalDurability,
    }),
    ...(outcome.executionJournalPersistenceError === undefined ? {} : {
      executionJournalPersistenceError: outcome.executionJournalPersistenceError,
    }),
  };
  return result;
};

export const workerHostCommandSubtype = (
  command: WorkerHostCommand,
): {
  readonly kind: WorkerHostCommand['kind'];
  readonly semanticSubtype: string;
  readonly ackAccepted?: boolean;
} => ({
  kind: command.kind,
  semanticSubtype: command.kind,
  ...(command.kind === 'commit_acknowledgement' ||
      command.kind === 'checkpoint_acknowledgement'
    ? { ackAccepted: command.accepted }
    : {}),
});

export const workerMessageSubtype = (
  message: WorkerToHostMessage,
): {
  readonly kind: WorkerToHostMessage['kind'];
  readonly semanticSubtype: string;
} => {
  if (message.kind === 'runtime_event') {
    return {
      kind: message.kind,
      semanticSubtype: message.event.kind === 'agent_event'
        ? message.event.event.kind
        : message.event.kind,
    };
  }
  if (message.kind === 'effect_observation') {
    return { kind: message.kind, semanticSubtype: message.effect.kind };
  }
  if (message.kind === 'provider_observation') {
    return { kind: message.kind, semanticSubtype: message.observation.kind };
  }
  if (message.kind === 'worker_error') {
    return { kind: message.kind, semanticSubtype: message.stage };
  }
  return { kind: message.kind, semanticSubtype: message.kind };
};
