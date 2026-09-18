import type {
  FailureDiagnosticDurability,
  FailureDiagnosticPersistenceErrorCode,
  FailureDiagnosticV1,
} from '../session/failure_diagnostic.ts';
import type {
  ProviderEvidenceDurability,
  ProviderEvidencePersistenceErrorCode,
  ProviderEvidencePhase,
  ProviderEvidenceRecorder,
} from '../provider/provider_evidence.ts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface TextContent {
  readonly kind: 'text';
  readonly text: string;
}

/** Provider replay state attached to an assistant message, never rendered as conversation text. */
export interface OpenRouterProviderState {
  readonly provider: 'openrouter-chat';
  readonly reasoningDetails: readonly JsonValue[];
}

/** Ordered Responses output items needed when continuing a Responses tool/model exchange. */
export interface ResponsesProviderState {
  /** Provider id that produced these private items; replay is scoped to it. */
  readonly provider: string;
  readonly replayItems: readonly JsonValue[];
  /** Model id that produced these private items; when present, replay is scoped to it too. */
  readonly model?: string;
}

export type ProviderState = OpenRouterProviderState | ResponsesProviderState;

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonValue;
}

export interface ToolCallContent extends ToolCall {
  readonly kind: 'tool_call';
}

export type ToolResultOutcome = 'success' | 'error';

export interface ContinuingToolResultContent {
  readonly kind: 'tool_result';
  readonly callId: string;
  readonly name: string;
  readonly text: string;
  readonly outcome: ToolResultOutcome;
}

export interface TerminalToolResultContent {
  readonly kind: 'tool_result';
  readonly callId: string;
  readonly name: string;
  readonly text: string;
  readonly outcome: 'success';
  readonly terminal: 'json_result';
}

export type ToolResultContent =
  | ContinuingToolResultContent
  | TerminalToolResultContent;

export type ToolExecutionResult =
  | { readonly kind: 'continue'; readonly text: string }
  | {
    readonly kind: 'terminate';
    readonly text: string;
    readonly finalText: string;
    readonly terminalKind: 'json_result';
  };

export interface UserMessage {
  readonly role: 'user';
  readonly content: TextContent;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: TextContent | readonly ToolCallContent[];
  /** Visible assistant text emitted in the same provider message as tool calls. */
  readonly text?: string;
  readonly providerState?: ProviderState;
}

export interface ToolMessage {
  readonly role: 'tool';
  readonly content: readonly ToolResultContent[];
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

export interface ModelRequest {
  readonly systemInstruction?: string;
  readonly transcript: readonly Message[];
  readonly tools: readonly ToolDefinition[];
}

/** Execution-only callback carrying the complete visible assistant prefix. */
export type AssistantProgressReporter = (snapshot: string) => void;

export interface ModelGenerateOptions {
  readonly signal?: AbortSignal;
  readonly reportAssistantProgress?: AssistantProgressReporter;
  /** Internal turn-scoped recorder; it never contains credential or Authorization values. */
  readonly providerEvidence?: ProviderEvidenceRecorder;
  readonly providerEvidenceLane?: 'parent' | 'planner';
  readonly providerEvidencePhase?: ProviderEvidencePhase;
  readonly modelStep?: number;
}

export type ModelResult =
  | {
    readonly kind: 'final';
    readonly text: string;
    readonly providerState?: ProviderState;
  }
  | {
    readonly kind: 'tool_calls';
    readonly calls: readonly ToolCall[];
    readonly text?: string;
    readonly providerState?: ProviderState;
  };

export interface Model {
  /** Provider-specific wire measurement used by context admission and compaction. */
  readonly measureRequestWire?: (request: ModelRequest) => {
    readonly messagesBytes: number;
    readonly bodyBytes: number;
  };
  generate(
    request: ModelRequest,
    options?: ModelGenerateOptions,
  ): ModelResult | PromiseLike<ModelResult>;
}

export type LoopStopReason =
  | 'final'
  | 'tool_terminal'
  | 'max_steps'
  | 'contract_failure'
  | 'cancelled';

export interface LoopOutcome {
  readonly ok: boolean;
  readonly task: string;
  readonly outcome: LoopStopReason;
  readonly stopReason: LoopStopReason;
  readonly finalText?: string;
  readonly terminalKind?: 'json_result';
  readonly error?: string;
  /** The one immutable sanitized failure record observed during this turn. */
  readonly diagnostic?: FailureDiagnosticV1;
  /** Diagnostic durability is finalized by the session after persistence settles. */
  readonly diagnosticDurability?: FailureDiagnosticDurability;
  readonly diagnosticPersistenceError?: FailureDiagnosticPersistenceErrorCode;
  /** Retained provider exchange identity, when the runtime supplied an evidence recorder. */
  readonly providerEvidenceId?: string;
  readonly providerEvidenceDurability?: ProviderEvidenceDurability;
  readonly providerEvidencePersistenceError?: ProviderEvidencePersistenceErrorCode;
  /** Actual provider fetch starts attributed to this accepted turn, when observed by a host. */
  readonly turnProviderRequestCount?: number;
  /** Cumulative actual provider fetch starts since this runtime process began, when observed. */
  readonly runtimeProviderRequestCount?: number;
  /** Host-owned Worker execution artifact settlement metadata. */
  readonly executionArtifactId?: string;
  readonly executionArtifactDurability?: 'yes' | 'failed' | 'unknown';
  readonly executionArtifactPersistenceError?:
    | 'worker_execution_artifact_io_failure'
    | 'worker_execution_artifact_invalid';
  /** Admission failed before a Worker turn was dispatched. */
  readonly executionAdmissionDurability?: 'failed';
  readonly executionAdmissionPersistenceError?:
    | 'history_busy'
    | 'history_invalid'
    | 'history_io_failure';
  /** Canonical state is committed, but a later Host observation append failed. */
  readonly executionObservationDurability?: 'failed';
  readonly executionObservationPersistenceError?:
    | 'history_busy'
    | 'history_invalid'
    | 'history_io_failure';
  readonly steps: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly transcript: readonly Message[];
}
