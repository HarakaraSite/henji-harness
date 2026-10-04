import type { AgentEventSink } from '../core/events.ts';
import type { DataService } from '../data/data_contract.ts';
import type { DataSessionDescriptor } from '../data/session_data_owner.ts';
import type {
  WorkerHostCommand,
  WorkerRuntimeIdentityInput,
  WorkerStartupPreparedMessage,
  WorkerToHostMessage,
} from './worker_protocol.ts';
import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { SelectedHenjiBaseInstruction } from '../instructions/base_instruction.ts';
import type { ProviderDeclarationV1 } from '../provider/provider_declaration.ts';
import type { ApplicationObservationSink } from '../host/application_port.ts';
import type { SessionActivation } from '../../api/contract.ts';

export interface WorkerHostSessionOptions {
  readonly data: DataService;
  readonly descriptor: DataSessionDescriptor;
  readonly workspaceRoot: string;
  /** User config root used for provider credentials and current Agent/tool JSON files. */
  readonly configRoot: string;
  /** JSON Agent choice resolved afresh inside every Worker generation. */
  readonly agentChoice: AgentConfigurationChoice;
  /** Root is implicit for ordinary sessions; child registries set this explicitly. */
  readonly runtimeIdentity?: WorkerRuntimeIdentityInput;
  /** Child-spawn account snapshot carried through this run, independent of its provider. */
  readonly chatgptRegistrationId?: string | null;
  /** Spawn-time tool filter (bare tool names) narrowing this generation's declared tools. */
  readonly toolFilter?: readonly string[];
  /** Child Workers do not expose recursive async child operations. */
  readonly enableAsyncAgents?: boolean;
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  /** Data-only activation values used by the Host query projection. */
  readonly activation?: SessionActivation;
  /** Focused-test seam; production uses the fixed five-second cancellation settlement grace. */
  readonly cancelSettlementGraceMs?: number;
  /** Explicit cancellation for a lazy root startup waiting on Worker readiness. */
  readonly startupAbortSignal?: AbortSignal;
  /** Actual composition snapshot emitted by the Worker before startup hooks run. */
  readonly onStartupPrepared?: (message: WorkerStartupPreparedMessage) => void;
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
