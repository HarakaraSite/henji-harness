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
