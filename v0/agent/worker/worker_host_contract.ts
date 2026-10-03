import type { AgentEventSink } from '../core/events.ts';
import type { DataService } from '../data/data_contract.ts';
import type { DataSessionDescriptor } from '../data/session_data_owner.ts';
import type {
  WorkerAsyncAgentCatalogEntry,
  WorkerDefinitionLoadRequest,
  WorkerHostCommand,
  WorkerToHostMessage,
  WorkerToolDefinitionLoadRequest,
} from './worker_protocol.ts';
import type { SelectedHenjiBaseInstruction } from '../instructions/base_instruction.ts';
import type { ProviderDeclarationV1 } from '../provider/provider_declaration.ts';
import type { ApplicationObservationSink } from '../host/application_port.ts';
import type { SessionActivation } from '../../api/contract.ts';

export interface WorkerHostSessionOptions {
  readonly data: DataService;
  readonly descriptor: DataSessionDescriptor;
  readonly workspaceRoot: string;
  /** User config root propagated to Workers for the shared credential store. */
  readonly configRoot?: string;
  /** Child-spawn account snapshot carried through this run, independent of its provider. */
  readonly chatgptRegistrationId?: string | null;
  readonly modulePath?: string;
  readonly loadDescriptor?: WorkerDefinitionLoadRequest;
  /** Host-resolved async child agent catalog (`agent:<name>` -> exact ref). */
  readonly asyncAgents?: readonly WorkerAsyncAgentCatalogEntry[];
  /** Spawn-time tool filter (bare tool names) narrowing this generation's declared tools. */
  readonly toolFilter?: readonly string[];
  /** Resolve a managed async agent ref to a process-local load descriptor. */
  readonly resolveAsyncAgentModule?: (
    ref: DataSessionDescriptor['definition'],
  ) => Promise<WorkerDefinitionLoadRequest>;
  /** Host-resolved tool Definition slots for declared tool identities. */
  readonly toolDefinitions?: readonly WorkerToolDefinitionLoadRequest[];
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  /** Data-only activation values used by the Host query projection. */
  readonly activation?: SessionActivation;
  /** Focused-test seam; production uses the fixed five-second cancellation settlement grace. */
  readonly cancelSettlementGraceMs?: number;
  /** Focused-test seam for short Host/Worker command settlement waits. */
  readonly workerResponseTimeoutMs?: number;
  /** Focused-test seam; production records an auxiliary start gap after one second. */
  readonly auxiliaryStageGapMs?: number;
  readonly eventSink?: AgentEventSink;
  readonly applicationObservationSink?: ApplicationObservationSink;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
  readonly baseInstruction?: SelectedHenjiBaseInstruction;
  /** Host-validated data-only provider declarations; never contains credential values. */
  readonly providerDeclarations?: readonly ProviderDeclarationV1[];
}

export interface WorkerHostCapsule {
  send(command: WorkerHostCommand, transfer?: Transferable[]): void;
  subscribe(listener: (message: WorkerToHostMessage) => void): () => void;
  terminate(): void;
}
