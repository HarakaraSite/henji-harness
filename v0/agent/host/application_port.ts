import type {
  ApiPosition,
  ContextView,
  EffectiveRuntimeConfig,
  PendingView,
} from '../../api/contract.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import type { RuntimeDisplayState } from '../runtime/startup_orientation.ts';
import type { WorkerReadyMessage } from '../worker/worker_protocol.ts';

/** Host-owned inputs from which an API projection can build a public snapshot. */
interface ApplicationSessionState {
  readonly sessionId: string;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  readonly position: ApiPosition;
  readonly selection: ModelSelection;
  readonly startup: RuntimeDisplayState;
  /** Present only after the current lazy Worker generation has evaluated startup. */
  readonly workerStartup?: NonNullable<WorkerReadyMessage['startupSnapshot']>;
  readonly credentialAvailability?: CredentialAvailability;
  readonly effectiveConfig?: EffectiveRuntimeConfig;
  readonly pendingRecall?: ContextView['pendingRecall'];
  readonly context?: ContextView;
  readonly runtime: Readonly<{
    readonly active: boolean;
    readonly phase:
      | 'idle'
      | 'preparing'
      | 'running'
      | 'cancelling'
      | 'settling'
      | 'unavailable';
  }>;
  readonly pending?: PendingView;
  readonly execution?: import('../../api/contract.ts').ExecutionView;
}

/** Small control query. Full conversation and model data are owned by Data. */
export interface ApplicationQueryPort {
  currentSession(): ApplicationSessionState;
}

export type ApplicationObservation =
  | Readonly<{ kind: 'task_state'; sessionId: string }>
  | Readonly<{ kind: 'steering_applied'; executionId: string }>
  | Readonly<{
    kind: 'runtime_state';
    sessionId: string;
    active: boolean;
    phase: 'idle' | 'running' | 'cancelling' | 'settling' | 'unavailable';
  }>;

export type ApplicationObservationSink = (
  observation: ApplicationObservation,
) => void;
