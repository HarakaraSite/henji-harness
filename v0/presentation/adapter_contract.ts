import type { LoopOutcome, Message } from '../agent/core/contracts.ts';
import type { ContextMetrics } from '../agent/core/context.ts';
import type {
  ContextRecoveryPreview,
  ContextRecoveryResult,
  NavigationPosition,
} from '../agent/session/session_navigation.ts';
import type {
  PresentationContextMetrics,
  PresentationContextPreview,
  PresentationContextResult,
  PresentationNavigationListing,
  PresentationOutcome,
  PresentationPosition,
  PresentationRestoredConversation,
  PresentationStartupState,
} from './contract.ts';
import type { ModelSelection } from '../agent/provider/openrouter_model_catalog.ts';
import type { CredentialAvailability } from '../agent/provider/model_selection.ts';

export interface AdapterSessionPort {
  submit(text: string): Promise<PresentationOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): PresentationContextMetrics | undefined;
  isAvailable?(): boolean;
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
  /** Presence-only credential display refresh; never carries credential material. */
  refreshCredentialAvailability?():
    | CredentialAvailability
    | undefined
    | Promise<CredentialAvailability | undefined>;
  selectModel?(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'>;
}

export interface AdapterNavigationPort {
  readonly persistent: boolean;
  list(signal?: AbortSignal): Promise<PresentationNavigationListing>;
  renameCurrent?(title: string): Promise<'renamed' | 'unchanged' | 'busy' | 'unavailable'>;
  createNew?(signal?: AbortSignal): Promise<{
    readonly session: AdapterSessionPort;
    readonly position: PresentationPosition;
    readonly restored?: PresentationRestoredConversation;
  }>;
  switchTo(id: string, signal?: AbortSignal): Promise<{
    readonly session: AdapterSessionPort;
    readonly position: PresentationPosition;
    readonly restored?: PresentationRestoredConversation;
  }>;
  currentPosition(): PresentationPosition;
}

export type CoreSession = {
  submit(text: string): Promise<LoopOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): ContextMetrics | undefined;
  isAvailable?(): boolean;
  transcriptSnapshot?(): readonly Message[];
  currentPosition?(): NavigationPosition;
  contextCompactionPreview?(): ContextRecoveryPreview;
  compactContext?(signal?: AbortSignal): Promise<ContextRecoveryResult>;
  consumeAutoCompactionNotice?(): {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | null;
  modelSelectionSnapshot?(): ModelSelection | undefined;
  credentialAvailabilitySnapshot?(): CredentialAvailability | undefined;
  refreshCredentialAvailability?():
    | CredentialAvailability
    | undefined
    | Promise<CredentialAvailability | undefined>;
  selectModel?(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'>;
  prepareRecall?(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }>;
  clearPendingRecall?(): boolean;
  checkpointSnapshot?(): {
    readonly summary: string;
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
};

export interface TuiPresentationAdapterOptions {
  /** Persist the accepted selection as the Host default for new sessions. */
  readonly persistDefaultSelection?: (selection: ModelSelection) => void | PromiseLike<void>;
  readonly startupState?: PresentationStartupState;
}
