import type { AgentEventSink } from '../core/events.ts';
import type {
  DefinitionRevisionRef,
  SessionRecord,
  WorkerSessionHandle,
} from '../session/session_store.ts';
import type { FailureDiagnosticPersister } from '../session/failure_diagnostic.ts';
import type { ProviderEvidenceStore } from '../provider/provider_evidence.ts';
import type { WorkerExecutionArtifactStore } from './worker_execution_artifact_store.ts';
import type {
  WorkerDefinitionLoadRequest,
  WorkerHostCommand,
  WorkerSubagentLoadRequest,
  WorkerToHostMessage,
  WorkerToolDefinitionLoadRequest,
} from './worker_protocol.ts';
import type { ModelSelection } from '../provider/openrouter_model_catalog.ts';
import type { HistoryPersistencePort } from '../history/history_store_contract.ts';
import type { SelectedHenjiBaseInstruction } from '../instructions/managed_instruction.ts';
import type { ProviderDeclarationV1 } from '../provider/provider_declaration.ts';

export interface WorkerHostSessionOptions {
  readonly handle: WorkerSessionHandle;
  readonly workspaceRoot: string;
  readonly agent: SessionRecord['agent'];
  readonly definition: DefinitionRevisionRef;
  readonly modulePath?: string;
  readonly loadDescriptor?: WorkerDefinitionLoadRequest;
  /** Host-resolved delegated subagent slots; the Worker composes them via the root Definition. */
  readonly subagentDefinitions?: readonly WorkerSubagentLoadRequest[];
  /** Host-resolved tool Definition slots for declared tool identities. */
  readonly toolDefinitions?: readonly WorkerToolDefinitionLoadRequest[];
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  /** Focused-test seam; production uses the fixed five-second cancellation settlement grace. */
  readonly cancelSettlementGraceMs?: number;
  /** Focused-test seam for short Host/Worker command settlement waits. */
  readonly workerResponseTimeoutMs?: number;
  /** Focused-test seam; production records an auxiliary start gap after one second. */
  readonly auxiliaryStageGapMs?: number;
  readonly eventSink?: AgentEventSink;
  readonly diagnosticPersistence?: FailureDiagnosticPersister;
  readonly providerEvidenceStore?: ProviderEvidenceStore;
  readonly executionArtifactStore?: WorkerExecutionArtifactStore;
  readonly historyPersistence?: HistoryPersistencePort;
  readonly durableCanonicalHistory?: boolean;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
  readonly initialModelSelection?: ModelSelection;
  readonly baseInstruction?: SelectedHenjiBaseInstruction;
  /** Host-validated data-only provider declarations; never contains credential values. */
  readonly providerDeclarations?: readonly ProviderDeclarationV1[];
}

export interface WorkerHostCapsule {
  send(command: WorkerHostCommand): void;
  subscribe(listener: (message: WorkerToHostMessage) => void): () => void;
  terminate(): void;
}
