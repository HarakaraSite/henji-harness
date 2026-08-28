import {
  type AssistantMessage,
  type LoopOutcome,
  type Message,
  type ToolCall,
  type ToolResultContent,
  type UserMessage,
} from './contracts.ts';

/** Completed lifecycle notifications emitted by one provider-neutral agent turn. */
export type AgentEvent =
  | { readonly kind: 'turn_start'; readonly turn: number }
  | {
    readonly kind: 'user_message';
    readonly turn: number;
    readonly message: UserMessage;
  }
  | {
    readonly kind: 'assistant_message';
    readonly turn: number;
    readonly message: AssistantMessage;
  }
  | {
    readonly kind: 'assistant_progress';
    readonly turn: number;
    readonly text: string;
  }
  | {
    readonly kind: 'tool_call';
    readonly turn: number;
    readonly call: ToolCall;
  }
  | {
    readonly kind: 'tool_result';
    readonly turn: number;
    readonly result: ToolResultContent;
  }
  | {
    readonly kind: 'tool_progress';
    readonly turn: number;
    readonly callId: string;
    readonly name: string;
    readonly text: string;
  }
  | {
    readonly kind: 'turn_end';
    readonly turn: number;
    readonly outcome: LoopOutcome['stopReason'];
    readonly committed: boolean;
  };

export type AgentEventSink = (event: AgentEvent) => void;

/** Stable error surfaced when a synchronous event sink rejects delivery. */
export const EVENT_DELIVERY_ERROR = 'agent event delivery failed';

export class EventDeliveryError extends Error {
  constructor() {
    super(EVENT_DELIVERY_ERROR);
    this.name = 'EventDeliveryError';
  }
}

/**
 * Agent values are JSON-shaped. `structuredClone` preserves every valid JsonValue, including
 * `-0`, while giving callers and sinks independent nested arrays/objects.
 */
export const snapshot = <T>(value: T): T => structuredClone(value);

export const snapshotMessages = (messages: readonly Message[]): Message[] =>
  snapshot(messages) as Message[];

export const snapshotEvent = (event: AgentEvent): AgentEvent => snapshot(event);

/** Deliver one event and normalize any sink exception to the stable public error. */
export const deliverEvent = (
  sink: AgentEventSink | undefined,
  event: AgentEvent,
): void => {
  if (sink === undefined) return;
  try {
    sink(snapshotEvent(event));
  } catch {
    throw new EventDeliveryError();
  }
};
