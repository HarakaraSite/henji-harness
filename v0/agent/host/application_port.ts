import type { ContextView, EffectiveRuntimeConfig, PendingView } from '../../api/contract.ts';
import type { AgentEvent } from '../core/events.ts';
import type { Message } from '../core/contracts.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import type { RuntimeDisplayState } from '../runtime/startup_orientation.ts';
import type { NavigationPosition } from '../session/session_navigation.ts';
import type { RestoredConversation } from '../session/session_navigation.ts';
import type {
  HistoryV7AssistantTextState,
  HistoryV7SemanticOccurrence,
} from '../history/history_v7_model.ts';
import type {
  HistoryAppendResult,
  HistoryPersistencePort,
  StoredExecutionEvent,
  StoredExecutionRow,
  StoredSessionHistoryExecution,
} from '../history/history_store_contract.ts';
import type { ProviderEvidenceRuntimeEvent } from '../provider/provider_evidence.ts';
import type { WorkerReadyMessage } from '../worker/worker_protocol.ts';

/** Host-owned inputs from which an API projection can build a public snapshot. */
export interface ApplicationSessionState {
  readonly sessionId: string;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  readonly position: NavigationPosition;
  readonly selection: ModelSelection;
  readonly startup: RuntimeDisplayState;
  /** Present only after the current lazy Worker generation has evaluated startup. */
  readonly workerStartup?: NonNullable<WorkerReadyMessage['startupSnapshot']>;
  readonly credentialAvailability?: CredentialAvailability;
  readonly effectiveConfig?: EffectiveRuntimeConfig;
  readonly pendingRecall?: ContextView['pendingRecall'];
  readonly checkpoint?: {
    readonly summary: string;
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  };
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
  readonly transcript: readonly Message[];
  readonly restored?: RestoredConversation;
}

/** Query port over the existing Host and history owner; it creates no parallel storage. */
export interface ApplicationQueryPort {
  currentSession(): ApplicationSessionState;
  sessionHistory(): readonly StoredSessionHistoryExecution[];
  executions(): readonly StoredExecutionRow[];
  executionEvents(executionId: string): readonly StoredExecutionEvent[];
  semanticOccurrences(
    executionId: string,
  ): readonly HistoryV7SemanticOccurrence[];
  assistantTextStates(
    executionId: string,
  ): readonly HistoryV7AssistantTextState[];
  executionContext?(
    executionId: string,
  ): ReturnType<HistoryPersistencePort['listExecutionContext']>;
}

export type ApplicationObservation =
  | Readonly<{ kind: 'task_state'; sessionId: string }>
  | Readonly<{
    kind: 'agent_event';
    executionId?: string;
    event: AgentEvent;
  }>
  | Readonly<{
    kind: 'runtime_state';
    sessionId: string;
    active: boolean;
    phase: 'idle' | 'running' | 'cancelling' | 'settling' | 'unavailable';
  }>
  | Readonly<{
    kind: 'provider_runtime_event';
    executionId: string;
    turn: number;
    workerSequence: number;
    event: ProviderEvidenceRuntimeEvent;
  }>
  | Readonly<{
    kind: 'history_appended';
    result: HistoryAppendResult;
  }>;

export type ApplicationObservationSink = (
  observation: ApplicationObservation,
) => void;
