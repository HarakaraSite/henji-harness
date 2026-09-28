import type { Message } from '../core/contracts.ts';
import type { SessionRecord } from './session_store.ts';

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
