import type {
  PresentationContextMetrics,
  PresentationContextPreview,
  PresentationContextResult,
  PresentationHistoryPage,
  PresentationIntentDispatcher,
  PresentationMessage,
  PresentationNavigationListing,
  PresentationOutcome,
  PresentationPosition,
} from '../presentation/contract.ts';
import type { TuiEditorHistory } from './input.ts';
import type { PendingInputCore } from './pending_input.ts';
import type { WorkspacePathIndex } from './file_reference.ts';
import type { ModelSelection } from '../agent/provider/openrouter_model_catalog.ts';
import type { CredentialAvailability } from '../agent/provider/model_selection.ts';

export interface TuiSessionLike {
  submit(text: string): Promise<PresentationOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): PresentationContextMetrics | undefined;
  isAvailable?(): boolean;
  historyPage?(
    page: number,
    turn?: number,
    rows?: number,
  ): Promise<PresentationHistoryPage | undefined> | PresentationHistoryPage | undefined;
  currentPosition?(): PresentationPosition | undefined;
  contextCompactionPreview?(): PresentationContextPreview | undefined;
  compactContext?(signal?: AbortSignal): Promise<PresentationContextResult>;
  checkpointSnapshot?(): {
    readonly summary: string;
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
  modelSelectionSnapshot?(): ModelSelection | undefined;
  credentialAvailabilitySnapshot?(): CredentialAvailability | undefined;
  selectModel?(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'>;
  consumeLegacyModelNotice?(): boolean;
}

export interface TuiNavigationLike {
  readonly persistent: boolean;
  list(signal?: AbortSignal): Promise<PresentationNavigationListing>;
  switchTo(id: string, signal?: AbortSignal): Promise<{
    readonly session: TuiSessionLike;
    readonly position: PresentationPosition;
    readonly restored?: {
      readonly messages: readonly PresentationMessage[];
      readonly omitted: number;
    };
  }>;
  historyPage(
    page: number,
    turn?: number,
    rows?: number,
  ): Promise<PresentationHistoryPage | undefined>;
  currentPosition(): PresentationPosition;
}

export type TuiFailureCode = 'input_failure' | 'output_failure' | 'agent_failure';

export class TuiControllerError extends Error {
  constructor(readonly code: TuiFailureCode, message?: string) {
    super(message);
    this.name = 'TuiControllerError';
  }
}

export interface TuiControllerOptions {
  /** Enables the Step 82 fixed-lane/editor behavior when supplied by the TUI runtime. */
  readonly pending?: PendingInputCore;
  readonly history?: TuiEditorHistory;
  readonly pathIndex?: WorkspacePathIndex;
  /** Persistent host-owned picker/resume/history navigation. */
  readonly navigation?: TuiNavigationLike;
  /** Production-only typed intent authority; legacy session calls remain test-seam compatible. */
  readonly intents?: PresentationIntentDispatcher;
}
