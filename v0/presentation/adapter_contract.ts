import type { LoopOutcome, Message } from '../agent/core/contracts.ts';
import type { ContextMetrics } from '../agent/core/context.ts';
import type {
  ContextRecoveryPreview,
  ContextRecoveryResult,
  NavigationPosition,
} from '../agent/session/session_navigation.ts';
import type {
  SessionHistoryPage,
  SessionHistorySearchResult,
} from '../agent/session/session_history.ts';
import type { HistoryExporter } from '../agent/session/history_export.ts';
import type {
  PresentationContextMetrics,
  PresentationContextPreview,
  PresentationContextResult,
  PresentationHistoryPage,
  PresentationHistorySearchResult,
  PresentationMessage,
  PresentationNavigationListing,
  PresentationOutcome,
  PresentationPosition,
} from './contract.ts';
import type { ModelSelection } from '../agent/provider/openrouter_model_catalog.ts';
import type { CredentialAvailability } from '../agent/provider/model_selection.ts';

export interface AdapterSessionPort {
  submit(text: string): Promise<PresentationOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): PresentationContextMetrics | undefined;
  isAvailable?(): boolean;
  historyPage?(
    page: number,
    turn?: number,
    rows?: number,
  ):
    | Promise<PresentationHistoryPage | undefined>
    | PresentationHistoryPage
    | undefined;
  historySearch?(
    query: string,
    match?: number,
    rows?: number,
  ):
    | Promise<PresentationHistorySearchResult | undefined>
    | PresentationHistorySearchResult
    | undefined;
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

export interface AdapterNavigationPort {
  readonly persistent: boolean;
  list(signal?: AbortSignal): Promise<PresentationNavigationListing>;
  renameCurrent?(title: string): 'renamed' | 'unchanged' | 'busy' | 'unavailable';
  switchTo(id: string, signal?: AbortSignal): Promise<{
    readonly session: AdapterSessionPort;
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

export type CoreSession = {
  submit(text: string): Promise<LoopOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): ContextMetrics | undefined;
  isAvailable?(): boolean;
  transcriptSnapshot?(): readonly Message[];
  historyPage?(
    page: number,
    turn?: number,
    rows?: number,
  ): Promise<SessionHistoryPage | undefined> | SessionHistoryPage | undefined;
  historySearch?(
    query: string,
    match?: number,
    rows?: number,
  ):
    | Promise<SessionHistorySearchResult | undefined>
    | SessionHistorySearchResult
    | undefined;
  currentPosition?(): NavigationPosition;
  contextCompactionPreview?(): ContextRecoveryPreview;
  compactContext?(signal?: AbortSignal): Promise<ContextRecoveryResult>;
  consumeAutoCompactionNotice?(): {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | null;
  modelSelectionSnapshot?(): ModelSelection | undefined;
  credentialAvailabilitySnapshot?(): CredentialAvailability | undefined;
  selectModel?(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'>;
  consumeLegacyModelNotice?(): boolean;
  checkpointSnapshot?(): {
    readonly summary: string;
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
};

export interface TuiPresentationAdapterOptions {
  readonly historyExporter?: HistoryExporter;
  readonly historySessionMode?: 'durable' | 'none';
}
