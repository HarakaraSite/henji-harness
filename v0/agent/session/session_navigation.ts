import { type LoopOutcome, type Message } from '../core/contracts.ts';
import { type SessionHistoryPage } from './session_history.ts';
import { type SessionMetadata, type SessionRecord } from './session_store.ts';
import { type ContextMetrics } from '../core/context.ts';
import type { ModelSelection } from '../provider/openrouter_model_catalog.ts';

export const SESSION_PICKER_PAGE_SIZE = 8;

export interface PickerSelection {
  readonly selected: number;
  readonly page: number;
}

/** Keep picker selection inside the page that is currently rendered. */
export const movePickerSelection = (
  count: number,
  selected: number,
  page: number,
  direction: 'up' | 'down' | 'left' | 'right',
): PickerSelection => {
  const total = Math.max(0, Number.isSafeInteger(count) ? count : 0);
  const pageCount = Math.max(1, Math.ceil(total / SESSION_PICKER_PAGE_SIZE));
  const boundedPage = Math.max(0, Math.min(pageCount - 1, page));
  if (total === 0) return { selected: 0, page: boundedPage };
  const first = boundedPage * SESSION_PICKER_PAGE_SIZE;
  const last = Math.min(total - 1, first + SESSION_PICKER_PAGE_SIZE - 1);
  let nextPage = boundedPage;
  let nextSelected = selected >= first && selected <= last ? selected : first;
  if (direction === 'left') nextPage = Math.max(0, boundedPage - 1);
  if (direction === 'right') nextPage = Math.min(pageCount - 1, boundedPage + 1);
  if (direction === 'left' || direction === 'right') {
    nextSelected = Math.min(total - 1, nextPage * SESSION_PICKER_PAGE_SIZE);
  } else if (direction === 'up') {
    nextSelected = nextSelected === first ? last : nextSelected - 1;
  } else if (direction === 'down') {
    nextSelected = nextSelected === last ? first : nextSelected + 1;
  }
  return { selected: nextSelected, page: nextPage };
};

export interface NavigationSessionLike {
  submit(text: string): Promise<LoopOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): ContextMetrics | undefined;
  isAvailable?(): boolean;
  modelSelectionSnapshot?(): ModelSelection | undefined;
  selectModel?(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'>;
  consumeLegacyModelNotice?(): boolean;
}

export interface NavigationPosition {
  readonly sessionId?: string;
  readonly agent: SessionRecord['agent'];
  readonly committedTurn: number;
  readonly messageCount: number;
  readonly checkpoint?: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
    readonly projectedMessagesBytes?: number;
  };
}

export interface NavigationRow extends SessionMetadata {
  readonly current: boolean;
  readonly resumed: boolean;
  readonly mismatch: boolean;
}

export interface NavigationListing {
  readonly sessions: readonly NavigationRow[];
  readonly skippedInvalid: number;
}

export interface NavigationBinding {
  readonly session: NavigationSessionLike;
  readonly position: NavigationPosition;
  readonly restored?: { readonly messages: readonly Message[]; readonly omitted: number };
}

/** A switch crossed a binding/cleanup boundary and cannot safely return to the old session. */
export class NavigationFatalError extends Error {
  constructor(message = 'session navigation transaction failed') {
    super(message);
    this.name = 'NavigationFatalError';
  }
}

/** A dismissed navigation operation must finish cleanup without changing the active binding. */
export class NavigationCancelledError extends Error {
  constructor(message = 'session navigation cancelled') {
    super(message);
    this.name = 'NavigationCancelledError';
  }
}

export interface ContextRecoveryPreview {
  readonly useful: boolean;
  readonly currentTurn: number;
  readonly currentCheckpoint?: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  };
  readonly proposed?: { readonly coveredThroughTurn: number; readonly retainedFromTurn: number };
  readonly baselineMessagesBytes?: number;
  readonly projectedMessagesBytes?: number;
}

export interface ContextRecoveryResult {
  readonly kind: 'installed' | 'refused' | 'failed' | 'cancelled';
  readonly coveredThroughTurn?: number;
  readonly retainedFromTurn?: number;
  readonly reason?: string;
}

/** Host-owned navigation port. It never accepts a task or exposes a provider/model operation. */
export interface SessionNavigationHost {
  readonly persistent: boolean;
  list(signal?: AbortSignal): Promise<NavigationListing>;
  renameCurrent(title: string): 'renamed' | 'unchanged' | 'busy' | 'unavailable';
  switchTo(id: string, signal?: AbortSignal): Promise<NavigationBinding>;
  historyPage(page: number, turn?: number, rows?: number): Promise<SessionHistoryPage | undefined>;
  currentPosition(): NavigationPosition;
}
