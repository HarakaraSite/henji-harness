/**
 * The deliberately boring boundary between the agent core and a human-facing presentation.
 *
 * This module is data-only.  It must not import the runtime, provider, session store, terminal,
 * or any TUI implementation.  The adapter is the only place where core values are translated to
 * these bounded values.
 */

import { MAX_CONVERSATION_TEXT_BYTES } from '../resource_limits.ts';

export type PresentationLifecycle =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'cancelling'
  | 'compacting'
  | 'recoverable_error'
  | 'fatal';

export type PresentationAgentId = 'default' | 'planner';
export interface PresentationModelSelection {
  readonly provider: 'openrouter' | 'openai';
  readonly modelId: string;
  readonly effort: string;
}
export type PresentationOutcomeReason =
  | 'final'
  | 'tool_terminal'
  | 'max_steps'
  | 'contract_failure'
  | 'cancelled';

export type PresentationFailureStage =
  | 'credential_resolution'
  | 'request_build'
  | 'request_admission'
  | 'transport'
  | 'http'
  | 'response_parse'
  | 'model_result_validation'
  | 'session_commit'
  | 'cancellation_cleanup'
  | 'turn_control'
  | 'unknown_stage';

export type PresentationFailureCode =
  | 'missing_credential'
  | 'invalid_input'
  | 'request_budget_exhausted'
  | 'provider_timeout'
  | 'transport_error'
  | 'http_error'
  | 'response_error'
  | 'limit_exceeded'
  | 'invalid_model_result'
  | 'commit_error'
  | 'cleanup_error'
  | 'turn_cancelled'
  | 'model_step_limit'
  | 'unknown_code';

export type PresentationParseReason =
  | 'unsupported_media_type'
  | 'response_body_missing'
  | 'response_body_too_large'
  | 'response_stream_failed'
  | 'invalid_utf8'
  | 'invalid_sse_framing'
  | 'invalid_sse_json'
  | 'provider_reported_error'
  | 'invalid_completion_identity'
  | 'unsupported_choice_shape'
  | 'unsupported_finish_reason'
  | 'unsupported_delta_shape'
  | 'mixed_text_and_tool_calls'
  | 'invalid_tool_arguments'
  | 'incomplete_tool_call'
  | 'invalid_usage_frame'
  | 'data_after_terminal'
  | 'empty_terminal_result'
  | 'stream_ended_before_done'
  | 'unsupported_response_shape';

export interface PresentationFailureDiagnostic {
  readonly schemaVersion: 1;
  readonly diagnosticId: string;
  readonly stage: PresentationFailureStage;
  readonly code: PresentationFailureCode;
  readonly lane: 'parent' | 'planner';
  readonly providerRequestCount: number;
  readonly httpStatus?: number;
  readonly parseReason?: PresentationParseReason;
  readonly occurredAt: string;
  readonly turnNumber: number;
  readonly modelStep: number;
  readonly retryCount: number;
}

export type PresentationDiagnosticDurability = 'yes' | 'failed' | 'unknown';
export type PresentationDiagnosticPersistenceError =
  | 'diagnostic_not_found'
  | 'diagnostic_busy'
  | 'diagnostic_invalid'
  | 'diagnostic_capacity'
  | 'diagnostic_io_failure';

export type PresentationProviderEvidenceDurability = 'yes' | 'failed' | 'unknown';
export type PresentationProviderEvidencePersistenceError =
  | 'provider_evidence_not_found'
  | 'provider_evidence_invalid'
  | 'provider_evidence_io_failure';

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
  readonly text?: string;
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
  readonly diagnostic?: PresentationFailureDiagnostic;
  readonly diagnosticDurability?: PresentationDiagnosticDurability;
  readonly diagnosticPersistenceError?: PresentationDiagnosticPersistenceError;
  readonly providerEvidenceId?: string;
  readonly providerEvidenceDurability?: PresentationProviderEvidenceDurability;
  readonly providerEvidencePersistenceError?: PresentationProviderEvidencePersistenceError;
  readonly turnProviderRequestCount?: number;
  readonly runtimeProviderRequestCount?: number;
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
  readonly createdAt: string;
  readonly title?: string;
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
  readonly title?: string;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly current: boolean;
  readonly resumed: boolean;
  readonly mismatch: boolean;
  readonly modelSelection?: PresentationModelSelection;
}

export interface PresentationNavigationListing {
  readonly sessions: readonly PresentationNavigationRow[];
  readonly skippedInvalid: number;
}

export interface PresentationHistoryEntry {
  readonly turn: number;
  readonly role: 'user' | 'steer' | 'assistant' | 'tool>';
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

export interface PresentationHumanHistoryEntry {
  readonly id: string;
  readonly executionId: string;
  readonly turn: number;
  readonly attempt: number;
  readonly kind:
    | 'execution'
    | 'task'
    | 'user'
    | 'steer'
    | 'assistant'
    | 'tool'
    | 'projection'
    | 'context'
    | 'request'
    | 'evidence'
    | 'diagnostic'
    | 'artifact';
  readonly label: string;
  readonly text: string;
  readonly detailId: string;
}

export interface PresentationHumanHistoryPage {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly entries: readonly PresentationHumanHistoryEntry[];
  readonly executionCount: number;
  readonly olderCursor?: string;
  readonly newerCursor?: string;
  readonly atOldest: boolean;
  readonly atNewest: boolean;
}

export interface PresentationHumanHistoryDetail {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly detailId: string;
  readonly title: string;
  readonly text: string;
  readonly scalarOffset: number;
  readonly scalarLength: number;
  readonly totalScalars: number;
  readonly previousOffset?: number;
  readonly nextOffset?: number;
}

export interface PresentationHumanHistorySearchHit {
  readonly query: string;
  readonly entryId: string;
  readonly detailId: string;
  readonly sourceScalarOffset: number;
  readonly detail?: PresentationHumanHistoryDetail;
  readonly detailMatchScalarOffset?: number;
  readonly wrapped: boolean;
  readonly page: PresentationHumanHistoryPage;
}

export interface PresentationContextPreview {
  readonly useful: boolean;
  readonly currentTurn: number;
  readonly currentCheckpoint?: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  };
  readonly proposed?: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  };
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
  | Readonly<{ readonly kind: 'rename_session'; readonly title: string }>
  | Readonly<{ readonly kind: 'new_session' }>
  | Readonly<{ readonly kind: 'resume_session'; readonly id: string }>
  | Readonly<{ readonly kind: 'recall_execution'; readonly id?: string }>
  | Readonly<{ readonly kind: 'clear_recall' }>
  | Readonly<{
    readonly kind: 'select_provider';
    readonly provider: 'openrouter' | 'openai';
  }>
  | Readonly<{
    readonly kind: 'select_model';
    readonly provider: 'openrouter' | 'openai';
    readonly modelId: string;
    readonly effort: string;
  }>
  | Readonly<
    {
      readonly kind: 'history_page';
      readonly page: number;
      readonly turn: number;
    }
  >
  | Readonly<{ readonly kind: 'history_export' }>
  | Readonly<{ readonly kind: 'human_history_open' }>
  | Readonly<{
    readonly kind: 'human_history_page';
    readonly direction: 'oldest' | 'older' | 'newer' | 'latest';
    readonly cursor?: string;
  }>
  | Readonly<{
    readonly kind: 'human_history_detail';
    readonly detailId: string;
    readonly scalarOffset?: number;
  }>
  | Readonly<{
    readonly kind: 'human_history_search';
    readonly query: string;
    readonly direction: 'next' | 'previous';
    readonly fromEntryId?: string;
    readonly fromSourceScalarOffset?: number;
  }>
  | Readonly<{ readonly kind: 'history_export_all' }>
  | Readonly<
    {
      readonly kind: 'compaction';
      readonly action: 'preview' | 'confirm' | 'cancel';
    }
  >
  | Readonly<{ readonly kind: 'dismiss_overlay' }>;

/**
 * The UI can submit only this data-only command channel.  It intentionally contains no live
 * session, navigation, storage, cancellation, or abort objects; the core-side adapter owns all
 * side effects and returns a bounded value result.
 */
export type PresentationIntentResult =
  | Readonly<{ readonly kind: 'accepted' }>
  | Readonly<
    {
      readonly kind: 'rejected';
      readonly reason:
        | 'idle'
        | 'unavailable'
        | 'busy'
        | 'invalid'
        | 'not_found'
        | 'ambiguous'
        | 'failed';
    }
  >
  | Readonly<
    { readonly kind: 'outcome'; readonly outcome: PresentationOutcome }
  >
  | Readonly<
    {
      readonly kind: 'listing';
      readonly listing: PresentationNavigationListing;
    }
  >
  | Readonly<{
    readonly kind: 'binding';
    readonly position: PresentationPosition;
    readonly restored?: {
      readonly messages: readonly PresentationMessage[];
      readonly omitted: number;
    };
  }>
  | Readonly<{
    readonly kind: 'model_selection';
    readonly status: 'selected' | 'unchanged';
    readonly selection: PresentationModelSelection;
  }>
  | Readonly<{
    readonly kind: 'session_title';
    readonly status: 'renamed' | 'unchanged';
    readonly title: string;
  }>
  | Readonly<{
    readonly kind: 'recall';
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }>
  | Readonly<
    { readonly kind: 'history'; readonly page?: PresentationHistoryPage }
  >
  | Readonly<{
    readonly kind: 'human_history_page';
    readonly page: PresentationHumanHistoryPage;
  }>
  | Readonly<{
    readonly kind: 'human_history_detail';
    readonly detail: PresentationHumanHistoryDetail;
  }>
  | Readonly<{
    readonly kind: 'human_history_search';
    readonly hit?: PresentationHumanHistorySearchHit;
  }>
  | Readonly<
    {
      readonly kind: 'history_export';
      readonly path: string;
      readonly throughTurn: number;
    }
  >
  | Readonly<{
    readonly kind: 'history_export_all';
    readonly path: string;
    readonly sessionId: string;
    readonly stateRevision: number;
    readonly tailExecutionId?: string;
    readonly executionCount: number;
    readonly byteLength: number;
    readonly sha256: string;
  }>
  | Readonly<
    {
      readonly kind: 'context_preview';
      readonly preview?: PresentationContextPreview;
    }
  >
  | Readonly<
    {
      readonly kind: 'context_result';
      readonly result: PresentationContextResult;
    }
  >
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
  | Readonly<
    {
      readonly kind: 'assistant_progress';
      readonly turn: number;
      readonly text: string;
    }
  >
  | Readonly<{
    readonly kind: 'tool_call';
    readonly turn: number;
    readonly call: Omit<PresentationToolCall, 'kind'> & {
      readonly kind?: 'tool_call';
    };
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
    readonly turnProviderRequestCount?: number;
    readonly runtimeProviderRequestCount?: number;
    readonly providerEvidenceId?: string;
    readonly providerEvidenceDurability?: PresentationProviderEvidenceDurability;
    readonly providerEvidencePersistenceError?: PresentationProviderEvidencePersistenceError;
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
    readonly kind: 'notice';
    readonly generation: number;
    readonly text: string;
  }>
  | Readonly<{
    readonly kind: 'restored_log';
    readonly messages: readonly PresentationMessage[];
    readonly omitted: number;
  }>
  | Readonly<{
    readonly kind: 'session_binding_replaced';
    readonly position: PresentationPosition;
    readonly modelSelection?: PresentationModelSelection;
  }>
  | Readonly<{
    readonly kind: 'model_selection_changed';
    readonly selection: PresentationModelSelection;
  }>
  | Readonly<
    { readonly kind: 'history_page'; readonly page: PresentationHistoryPage }
  >
  | Readonly<
    {
      readonly kind: 'context_preview';
      readonly preview: PresentationContextPreview;
    }
  >
  | Readonly<
    {
      readonly kind: 'context_result';
      readonly result: PresentationContextResult;
    }
  >
  | Readonly<{
    readonly kind: 'failure_diagnostic';
    readonly turn: number;
    readonly diagnostic: PresentationFailureDiagnostic;
    readonly durable: PresentationDiagnosticDurability;
    readonly persistenceError?: PresentationDiagnosticPersistenceError;
  }>;

export type PresentationEventSink = (event: PresentationEvent) => void;

export interface PresentationStartupState {
  readonly productVersion: string;
  readonly workspace: string;
  readonly agentId: PresentationAgentId;
  readonly model: {
    readonly provider: 'openrouter' | 'openai';
    readonly profileId: string;
    readonly modelId: string;
    readonly effort: string;
  };
  readonly sessionMode: {
    readonly kind: 'new' | 'continue' | 'exact' | 'none';
  };
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
  readonly model?: PresentationModelSelection;
  readonly trust: 'trusted_local';
  readonly credentialPolicy: 'before_each_provider_request';
  readonly checkpoint?: PresentationCheckpoint;
  readonly pending: readonly {
    readonly kind:
      | 'editor'
      | 'active_task'
      | 'steering'
      | 'follow_up'
      | 'recovery';
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

export const PRESENTATION_MAX_TEXT_BYTES = MAX_CONVERSATION_TEXT_BYTES;
export const PRESENTATION_MAX_EVENT_BYTES = 2 * 1024 * 1024;
