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
  WorkerToHostMessage,
} from './worker_protocol.ts';
import type { ModelSelection } from '../provider/openrouter_model_catalog.ts';

export interface WorkerHostSessionOptions {
  readonly handle: WorkerSessionHandle;
  readonly workspaceRoot: string;
  readonly agent: SessionRecord['agent'];
  readonly definition: DefinitionRevisionRef;
  readonly modulePath?: string;
  readonly loadDescriptor?: WorkerDefinitionLoadRequest;
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  readonly eventSink?: AgentEventSink;
  readonly diagnosticPersistence?: FailureDiagnosticPersister;
  readonly providerEvidenceStore?: ProviderEvidenceStore;
  readonly executionArtifactStore?: WorkerExecutionArtifactStore;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
  readonly initialModelSelection?: ModelSelection;
}

export interface WorkerHostCapsule {
  send(command: WorkerHostCommand): void;
  subscribe(listener: (message: WorkerToHostMessage) => void): () => void;
  terminate(): void;
}
