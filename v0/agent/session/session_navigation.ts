import { type LoopOutcome, type Message } from '../core/contracts.ts';
import { type SessionMetadata, type SessionRecord } from './session_store.ts';
import { type ContextMetrics } from '../core/context.ts';
import type { ModelSelection } from '../provider/openrouter_model_catalog.ts';

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
}

export interface NavigationPosition {
  readonly sessionId?: string;
  readonly createdAt: string;
  readonly title?: string;
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
  readonly restored?: RestoredConversation;
}

export interface RestoredThinking {
  /** Insert before this zero-based canonical transcript message. */
  readonly beforeMessageIndex: number;
  readonly turn: number;
  readonly modelStep: number;
  readonly thinkingKind: 'text' | 'summary';
  readonly text: string;
  readonly complete: boolean;
}

export interface RestoredConversation {
  readonly messages: readonly Message[];
  /** Canonical turn for each message, including steering messages within a turn. */
  readonly messageTurns?: readonly number[];
  readonly omitted: number;
  readonly thinking: readonly RestoredThinking[];
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
  renameCurrent(title: string): Promise<'renamed' | 'unchanged' | 'busy' | 'unavailable'>;
  createNew?(signal?: AbortSignal): Promise<NavigationBinding>;
  switchTo(id: string, signal?: AbortSignal): Promise<NavigationBinding>;
  currentPosition(): NavigationPosition;
}
