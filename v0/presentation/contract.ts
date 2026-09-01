/**
 * The deliberately boring boundary between the agent core and a human-facing presentation.
 *
 * This module is data-only.  It must not import the runtime, provider, session store, terminal,
 * or any TUI implementation.  The adapter is the only place where core values are translated to
 * these bounded values.
 */

export type PresentationLifecycle =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'cancelling'
  | 'compacting'
  | 'recoverable_error'
  | 'fatal';

export type PresentationAgentId = 'default' | 'planner';
export type PresentationOutcomeReason =
  | 'final'
  | 'tool_terminal'
  | 'max_steps'
  | 'contract_failure'
  | 'cancelled';

export type PresentationJsonPrimitive = string | number | boolean | null;
export type PresentationJson =
  | PresentationJsonPrimitive
  | Readonly<{ readonly [key: string]: PresentationJson }>
  | readonly PresentationJson[];

export interface PresentationText {
  readonly kind: 'text';
  readonly text: string;
}

export interface PresentationToolCall {
  readonly kind: 'tool_call';
  readonly callId: string;
  readonly name: string;
  readonly arguments: PresentationJson;
}

export interface PresentationUserMessage {
  readonly role: 'user';
  readonly content: PresentationText;
}

export interface PresentationAssistantMessage {
  readonly role: 'assistant';
  readonly content: PresentationText | readonly PresentationToolCall[];
}

export interface PresentationToolResult {
  readonly kind: 'tool_result';
  readonly callId: string;
  readonly name: string;
  readonly text: string;
  readonly outcome: 'success' | 'error';
  readonly terminal?: 'json_result';
}

export interface PresentationToolMessage {
  readonly role: 'tool';
  readonly content: readonly PresentationToolResult[];
}

export type PresentationMessage =
  | PresentationUserMessage
  | PresentationAssistantMessage
  | PresentationToolMessage;

export interface PresentationOutcome {
  readonly ok: boolean;
  readonly task: string;
  readonly outcome: PresentationOutcomeReason;
  readonly stopReason: PresentationOutcomeReason;
  readonly finalText?: string;
  readonly terminalKind?: 'json_result';
  readonly error?: string;
  readonly steps: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly transcript: readonly PresentationMessage[];
}

export interface PresentationContextMetrics {
  readonly messageEstimatedTokensBefore: number;
  readonly messageEstimatedTokensAfter: number;
  readonly toolEstimatedTokens: number;
  readonly requestEstimatedTokensBefore: number;
  readonly requestEstimatedTokensAfter: number;
  readonly triggerTokens: 65_536;
  readonly targetTokens: 49_152;
  readonly triggered: boolean;
  readonly targetReached: boolean;
  readonly compressedResultCount: number;
  readonly compressedMessageCount: number;
}

export interface PresentationCheckpoint {
  readonly coveredThroughTurn: number;
  readonly retainedFromTurn: number;
  readonly projectedMessagesBytes?: number;
}

export interface PresentationPosition {
  readonly sessionId?: string;
  readonly agent: PresentationAgentId;
  readonly committedTurn: number;
  readonly messageCount: number;
  readonly checkpoint?: PresentationCheckpoint;
}

export interface PresentationNavigationRow {
  readonly id: string;
  readonly agent: PresentationAgentId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly current: boolean;
  readonly resumed: boolean;
  readonly mismatch: boolean;
}

export interface PresentationNavigationListing {
  readonly sessions: readonly PresentationNavigationRow[];
  readonly skippedInvalid: number;
}

export interface PresentationHistoryEntry {
  readonly turn: number;
  readonly role: 'user' | 'steer' | 'assistant' | 'tool>' | 'tool<';
  readonly messageIndex: number;
  readonly text: string;
}

export interface PresentationHistoryPage {
  readonly sessionId?: string;
  readonly agent?: PresentationAgentId;
  readonly turn: number;
  readonly totalTurns: number;
  readonly page: number;
  readonly pageCount: number;
  readonly entries: readonly PresentationHistoryEntry[];
  readonly sourceBytes: number;
  readonly omitted: boolean;
}

export interface PresentationContextPreview {
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

export interface PresentationContextResult {
  readonly kind: 'installed' | 'refused' | 'failed' | 'cancelled';
  readonly coveredThroughTurn?: number;
  readonly retainedFromTurn?: number;
  readonly reason?: string;
}

export type PresentationIntent =
  | Readonly<{ readonly kind: 'ordinary_submit'; readonly text: string }>
  | Readonly<{ readonly kind: 'steering_submit'; readonly text: string }>
  | Readonly<{ readonly kind: 'follow_up_queue'; readonly text: string }>
  | Readonly<{ readonly kind: 'cancel_active' }>
  | Readonly<{ readonly kind: 'exit'; readonly code: 0 | 129 | 143 }>
  | Readonly<{ readonly kind: 'list_sessions' }>
  | Readonly<{ readonly kind: 'resume_session'; readonly id: string }>
  | Readonly<{ readonly kind: 'history_page'; readonly page: number; readonly turn: number }>
  | Readonly<{ readonly kind: 'compaction'; readonly action: 'preview' | 'confirm' | 'cancel' }>
  | Readonly<{ readonly kind: 'dismiss_overlay' }>;

/**
 * The UI can submit only this data-only command channel.  It intentionally contains no live
 * session, navigation, storage, cancellation, or abort objects; the core-side adapter owns all
 * side effects and returns a bounded value result.
 */
export type PresentationIntentResult =
  | Readonly<{ readonly kind: 'accepted' }>
  | Readonly<
    { readonly kind: 'rejected'; readonly reason: 'idle' | 'unavailable' | 'busy' | 'invalid' }
  >
  | Readonly<{ readonly kind: 'outcome'; readonly outcome: PresentationOutcome }>
  | Readonly<{ readonly kind: 'listing'; readonly listing: PresentationNavigationListing }>
  | Readonly<{
    readonly kind: 'binding';
    readonly position: PresentationPosition;
    readonly restored?: {
      readonly messages: readonly PresentationMessage[];
      readonly omitted: number;
    };
  }>
  | Readonly<{ readonly kind: 'history'; readonly page?: PresentationHistoryPage }>
  | Readonly<{ readonly kind: 'context_preview'; readonly preview?: PresentationContextPreview }>
  | Readonly<{ readonly kind: 'context_result'; readonly result: PresentationContextResult }>
  | Readonly<{ readonly kind: 'exit'; readonly code: 0 | 129 | 143 }>;

export interface PresentationIntentDispatcher {
  dispatch(
    intent: PresentationIntent,
  ): PresentationIntentResult | Promise<PresentationIntentResult>;
}

export type PresentationEvent =
  | Readonly<{ readonly kind: 'turn_start'; readonly turn: number }>
  | Readonly<{
    readonly kind: 'user_message';
    readonly turn: number;
    readonly message: PresentationUserMessage;
  }>
  | Readonly<{
    readonly kind: 'assistant_message';
    readonly turn: number;
    readonly message: PresentationAssistantMessage;
  }>
  | Readonly<{ readonly kind: 'assistant_progress'; readonly turn: number; readonly text: string }>
  | Readonly<{
    readonly kind: 'tool_call';
    readonly turn: number;
    readonly call: Omit<PresentationToolCall, 'kind'> & { readonly kind?: 'tool_call' };
  }>
  | Readonly<{
    readonly kind: 'tool_result';
    readonly turn: number;
    readonly result: PresentationToolResult;
  }>
  | Readonly<{
    readonly kind: 'tool_progress';
    readonly turn: number;
    readonly callId: string;
    readonly name: string;
    readonly text: string;
  }>
  | Readonly<{
    readonly kind: 'steering_message';
    readonly turn: number;
    readonly message: PresentationUserMessage;
  }>
  | Readonly<{
    readonly kind: 'turn_end';
    readonly turn: number;
    readonly outcome: PresentationOutcomeReason;
    readonly committed: boolean;
  }>
  | Readonly<{
    readonly kind: 'lifecycle';
    readonly lifecycle: PresentationLifecycle;
    readonly generation: number;
  }>
  | Readonly<{
    readonly kind: 'warning';
    readonly code: 'unsupported_activity' | 'recoverable' | 'fatal';
    readonly text: string;
    readonly generation: number;
  }>
  | Readonly<{
    readonly kind: 'restored_log';
    readonly messages: readonly PresentationMessage[];
    readonly omitted: number;
  }>
  | Readonly<{
    readonly kind: 'session_binding_replaced';
    readonly position: PresentationPosition;
  }>
  | Readonly<{ readonly kind: 'history_page'; readonly page: PresentationHistoryPage }>
  | Readonly<{ readonly kind: 'context_preview'; readonly preview: PresentationContextPreview }>
  | Readonly<{ readonly kind: 'context_result'; readonly result: PresentationContextResult }>;

export type PresentationEventSink = (event: PresentationEvent) => void;

export interface PresentationStartupState {
  readonly workspace: string;
  readonly agentId: PresentationAgentId;
  readonly model: { readonly provider: 'openrouter'; readonly profileId: string };
  readonly sessionMode: { readonly kind: 'new' | 'continue' | 'exact' | 'none' };
  readonly instructions: {
    readonly loaded: boolean;
    readonly source: 'AGENTS.md' | 'AGENTS.MD' | 'none';
  };
  readonly skills: {
    readonly count: number;
    readonly names: readonly string[];
    readonly omitted: number;
  };
  readonly trust: {
    readonly hardSandbox: false;
    readonly osUserTools: readonly ('bash' | 'edit' | 'write')[];
  };
  readonly credentialVerification: 'before_each_provider_request';
}

export interface PresentationProjection {
  readonly lifecycle: PresentationLifecycle;
  readonly agentId: PresentationAgentId;
  readonly sessionId?: string;
  readonly committedTurn: number;
  readonly workspace: string;
  readonly trust: 'trusted_local';
  readonly credentialPolicy: 'before_each_provider_request';
  readonly checkpoint?: PresentationCheckpoint;
  readonly pending: readonly {
    readonly kind: 'editor' | 'active_task' | 'steering' | 'follow_up' | 'recovery';
    readonly lifecycle: 'draft' | 'active' | 'queued' | 'recoverable';
    readonly byteCount: number;
  }[];
  readonly capabilities: Readonly<{
    readonly canNavigate: boolean;
    readonly canHistory: boolean;
    readonly canCompact: boolean;
  }>;
  readonly generation: number;
}

export const PRESENTATION_MAX_TEXT_BYTES = 64 * 1024;
export const PRESENTATION_MAX_EVENT_BYTES = 64 * 1024;

/** Stable error used whenever a presentation sink cannot accept a frame. */
export class PresentationDeliveryError extends Error {
  constructor() {
    super('agent event delivery failed');
    this.name = 'PresentationDeliveryError';
  }
}

export class PresentationNavigationFatalError extends Error {
  constructor(message = 'session navigation transaction failed') {
    super(message);
    this.name = 'NavigationFatalError';
  }
}

export class PresentationNavigationCancelledError extends Error {
  constructor(message = 'session navigation cancelled') {
    super(message);
    this.name = 'NavigationCancelledError';
  }
}

export const isPresentationError = (error: unknown, name: string): boolean =>
  error instanceof Error && error.name === name;

export const movePresentationPickerSelection = (
  count: number,
  selected: number,
  page: number,
  direction: 'up' | 'down' | 'left' | 'right',
): { readonly selected: number; readonly page: number } => {
  const total = Math.max(0, Number.isSafeInteger(count) ? count : 0);
  const pageCount = Math.max(1, Math.ceil(total / 8));
  const boundedPage = Math.max(0, Math.min(pageCount - 1, Number.isSafeInteger(page) ? page : 0));
  if (total === 0) return { selected: 0, page: boundedPage };
  const first = boundedPage * 8;
  const last = Math.min(total - 1, first + 7);
  let nextPage = boundedPage;
  let nextSelected = selected >= first && selected <= last ? selected : first;
  if (direction === 'left') nextPage = Math.max(0, boundedPage - 1);
  if (direction === 'right') nextPage = Math.min(pageCount - 1, boundedPage + 1);
  if (direction === 'left' || direction === 'right') {
    nextSelected = Math.min(total - 1, nextPage * 8);
  } else if (direction === 'up') nextSelected = nextSelected === first ? last : nextSelected - 1;
  else if (direction === 'down') nextSelected = nextSelected === last ? first : nextSelected + 1;
  return { selected: nextSelected, page: nextPage };
};

const encoder = new TextEncoder();

const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

/** Reject mutable/non-plain values at the boundary without leaking their contents. */
export const snapshotPresentation = <T>(value: T): T => {
  try {
    const visiting = new WeakSet<object>();
    const inspect = (current: unknown, depth: number): void => {
      if (
        current === null || typeof current === 'string' || typeof current === 'number' ||
        typeof current === 'boolean' || current === undefined
      ) return;
      if (typeof current !== 'object' || depth > 32) throw new PresentationDeliveryError();
      if (visiting.has(current)) throw new PresentationDeliveryError();
      const prototype = Object.getPrototypeOf(current);
      if (
        Array.isArray(current)
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      ) {
        throw new PresentationDeliveryError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (
        Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
        Object.values(descriptors).some((descriptor) =>
          descriptor.get !== undefined || descriptor.set !== undefined
        )
      ) {
        throw new PresentationDeliveryError();
      }
      if (Array.isArray(current)) {
        const length = current.length;
        for (const key of Reflect.ownKeys(current)) {
          if (key === 'length') continue;
          if (typeof key !== 'string' || !/^\d+$/u.test(key)) {
            throw new PresentationDeliveryError();
          }
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
            throw new PresentationDeliveryError();
          }
        }
        for (let index = 0; index < length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, String(index))) {
            throw new PresentationDeliveryError();
          }
        }
      }
      visiting.add(current);
      for (const child of Object.values(current)) inspect(child, depth + 1);
      visiting.delete(current);
    };
    inspect(value, 0);
    const copy = structuredClone(value);
    const seen = new WeakSet<object>();
    const freeze = (current: unknown): unknown => {
      if (current === null || typeof current !== 'object') return current;
      if (seen.has(current)) return current;
      seen.add(current);
      for (const child of Object.values(current)) freeze(child);
      return Object.freeze(current);
    };
    return freeze(copy) as T;
  } catch {
    throw new PresentationDeliveryError();
  }
};

export const boundedPresentationText = (value: string): string => {
  if (typeof value !== 'string' || !isWellFormed(value) || value.includes('\0')) {
    throw new PresentationDeliveryError();
  }
  if (encoder.encode(value).byteLength <= PRESENTATION_MAX_TEXT_BYTES) return value;
  let result = '';
  let used = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (used + size > PRESENTATION_MAX_TEXT_BYTES) break;
    result += character;
    used += size;
  }
  return result;
};

export const presentationIntent = (intent: PresentationIntent): PresentationIntent => {
  const copy = snapshotPresentation(intent);
  if (copy === null || typeof copy !== 'object' || !('kind' in copy)) {
    throw new PresentationDeliveryError();
  }
  const kind = copy.kind;
  if (
    kind === 'ordinary_submit' || kind === 'steering_submit' || kind === 'follow_up_queue'
  ) {
    boundedPresentationText(copy.text);
  } else if (kind === 'exit') {
    if (copy.code !== 0 && copy.code !== 129 && copy.code !== 143) {
      throw new PresentationDeliveryError();
    }
  } else if (kind === 'resume_session') {
    boundedPresentationText(copy.id);
  } else if (kind === 'history_page') {
    if (!Number.isSafeInteger(copy.page) || copy.page < 0 || !Number.isSafeInteger(copy.turn)) {
      throw new PresentationDeliveryError();
    }
  } else if (
    kind !== 'cancel_active' && kind !== 'list_sessions' && kind !== 'dismiss_overlay' &&
    kind !== 'compaction'
  ) {
    throw new PresentationDeliveryError();
  }
  if (kind === 'compaction' && !['preview', 'confirm', 'cancel'].includes(copy.action)) {
    throw new PresentationDeliveryError();
  }
  return copy;
};
