import {
  type AssistantMessage,
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
import type {
  ProviderEvidenceDurability,
  ProviderEvidencePersistenceErrorCode,
} from '../provider/provider_evidence.ts';
import { PresentationDeliveryError as EventDeliveryError } from '../../presentation/contract.ts';

// Compatibility export: core delivery and the presentation boundary intentionally share one
// stable error identity, while the neutral contract remains free of core/UI imports.
export { PresentationDeliveryError as EventDeliveryError } from '../../presentation/contract.ts';

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
    readonly kind: 'steering_message';
    readonly turn: number;
    readonly message: UserMessage;
  }
  | {
    readonly kind: 'turn_end';
    readonly turn: number;
    readonly outcome: LoopOutcome['stopReason'];
    readonly committed: boolean;
    readonly turnProviderRequestCount?: number;
    readonly runtimeProviderRequestCount?: number;
    readonly providerEvidenceId?: string;
    readonly providerEvidenceDurability?: ProviderEvidenceDurability;
    readonly providerEvidencePersistenceError?: ProviderEvidencePersistenceErrorCode;
    readonly executionArtifactId?: string;
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
