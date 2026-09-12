import type { LoopOutcome } from '../core/contracts.ts';
import type { ProviderEvidenceV3 } from '../provider/provider_evidence.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import type {
  DefinitionRevisionRef,
  SessionRecord,
  StoredSessionRecord,
} from '../session/session_store_contract.ts';
import type { RecalledExecutionContextV1 } from '../worker/recalled_execution_context.ts';
import type { StoredWorkerExecutionArtifact } from '../worker/worker_execution_artifact.ts';
import type { WorkerReadyMessage } from '../worker/worker_protocol.ts';

export type HistoryStoreErrorCode =
  | 'history_busy'
  | 'history_invalid'
  | 'history_io_failure';

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
  readonly recalledContext?: RecalledExecutionContextV1;
}

export interface HistoryCaptureInput {
  readonly evidence?: ProviderEvidenceV3;
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
}

export interface HistoryPersistencePort {
  commitCanonicalTurn(input: CanonicalTurnCommitInput): HistoryCaptureResult;
  settleNonCanonicalExecution(
    input: NonCanonicalExecutionInput,
  ): HistoryCaptureResult;
  recordPostCommitObservation(artifact: StoredWorkerExecutionArtifact): void;
}
