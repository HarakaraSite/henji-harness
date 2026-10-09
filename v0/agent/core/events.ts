import {
  type AssistantMessage,
  type JsonValue,
  type LoopOutcome,
  type Message,
  type ToolCall,
  type ToolResultContent,
  type UserMessage,
} from './contracts.ts';
import type {
  FailureDiagnosticDurability,
  FailureDiagnosticPersistenceErrorCode,
  FailureDiagnosticV1,
} from '../session/failure_diagnostic.ts';
import type { AfterTurnHookEffect, RuntimeStopHookEffect, ToolHookEffect } from './hook_effect.ts';
import { PresentationDeliveryError as EventDeliveryError } from '../../presentation/contract.ts';

// Compatibility export: core delivery and the presentation boundary intentionally share one
// stable error identity, while the neutral contract remains free of core/UI imports.
export { PresentationDeliveryError as EventDeliveryError } from '../../presentation/contract.ts';

export type AgentRequestKey = Readonly<{
  executionId: string;
  lane?: 'parent' | 'planner';
  modelStep: number;
  requestOrdinal?: number;
}>;

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
    readonly requestKey?: AgentRequestKey;
  }
  | {
    readonly kind: 'assistant_progress';
    readonly turn: number;
    readonly text: string;
    readonly requestKey?: AgentRequestKey;
  }
  | {
    readonly kind: 'assistant_thinking';
    readonly turn: number;
    readonly modelStep: number;
    readonly thinkingKind: 'text' | 'summary';
    readonly text: string;
    readonly complete: boolean;
    readonly requestKey?: AgentRequestKey;
  }
  | {
    readonly kind: 'tool_call';
    readonly turn: number;
    readonly call: ToolCall;
    readonly hookEffect?: ToolHookEffect;
    readonly executionId?: string;
    readonly workerSequence?: number;
    readonly requestKey?: AgentRequestKey;
  }
  | {
    readonly kind: 'tool_result';
    readonly turn: number;
    readonly result: ToolResultContent;
    readonly hookEffect?: ToolHookEffect;
    readonly executionId?: string;
    readonly workerSequence?: number;
    readonly requestKey?: AgentRequestKey;
  }
  | {
    readonly kind: 'tool_progress';
    readonly turn: number;
    readonly callId: string;
    readonly name: string;
    readonly text: string;
    readonly executionId?: string;
    readonly workerSequence?: number;
    readonly requestKey?: AgentRequestKey;
  }
  | {
    /** Data-owned semantic sidecar appended after successful turn settlement. */
    readonly kind: 'hook_context_update';
    readonly turn: number;
    readonly effect: AfterTurnHookEffect;
  }
  | {
    /** Ordered runtime_stop outcomes retained after an execution settles. */
    readonly kind: 'hook_lifecycle_update';
    readonly turn: number;
    readonly effect: RuntimeStopHookEffect;
  }
  | {
    readonly kind: 'steering_message';
    readonly turn: number;
    readonly message: UserMessage;
  }
  | {
    readonly kind: 'context_notice';
    readonly turn: number;
    readonly notice:
      | 'trimmed'
      | 'history_partial'
      | 'history_omitted'
      | 'exceeded';
    readonly text: string;
    readonly budget?: Readonly<Record<string, JsonValue>>;
  }
  | {
    readonly kind: 'turn_end';
    readonly turn: number;
    readonly outcome: LoopOutcome['stopReason'];
    readonly committed: boolean;
    readonly turnProviderRequestCount?: number;
    readonly runtimeProviderRequestCount?: number;
    readonly executionArtifactId?: string;
    readonly recallableExecutionId?: string;
    readonly executionArtifactDurability?: 'yes' | 'failed' | 'unknown';
    readonly executionArtifactPersistenceError?:
      | 'worker_execution_artifact_io_failure'
      | 'worker_execution_artifact_invalid';
    readonly executionAdmissionDurability?: 'failed';
    readonly executionAdmissionPersistenceError?:
      | 'history_busy'
      | 'history_invalid'
      | 'history_io_failure';
    readonly executionJournalDurability?: 'failed';
    readonly executionJournalPersistenceError?:
      | 'history_busy'
      | 'history_invalid'
      | 'history_io_failure';
    readonly executionObservationDurability?: 'failed';
    readonly executionObservationPersistenceError?:
      | 'history_busy'
      | 'history_invalid'
      | 'history_io_failure';
    readonly diagnostic?: FailureDiagnosticV1;
    readonly diagnosticDurability?: FailureDiagnosticDurability;
    readonly diagnosticPersistenceError?: FailureDiagnosticPersistenceErrorCode;
  };

export type AgentEventSink = (event: AgentEvent) => void;

/** Stable error surfaced when a synchronous event sink rejects delivery. */

/**
 * Agent values are JSON-shaped. `structuredClone` preserves every valid JsonValue, including
 * `-0`, while giving callers and sinks independent nested arrays/objects.
 */
export const snapshot = <T>(value: T): T => structuredClone(value);

export const snapshotMessages = (messages: readonly Message[]): Message[] =>
  snapshot(messages) as Message[];

const snapshotEvent = (event: AgentEvent): AgentEvent => snapshot(event);

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
