export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface TextContent {
  readonly kind: 'text';
  readonly text: string;
}

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonValue;
}

export interface ToolCallContent extends ToolCall {
  readonly kind: 'tool_call';
}

export type ToolResultOutcome = 'success' | 'error';

export interface ToolResultContent {
  readonly kind: 'tool_result';
  readonly callId: string;
  readonly name: string;
  readonly text: string;
  readonly outcome: ToolResultOutcome;
}

export interface UserMessage {
  readonly role: 'user';
  readonly content: TextContent;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: TextContent | readonly ToolCallContent[];
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
  readonly transcript: readonly Message[];
  readonly tools: readonly ToolDefinition[];
}

export type ModelResult =
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'tool_calls'; readonly calls: readonly ToolCall[] };

export interface Model {
  generate(request: ModelRequest): ModelResult | PromiseLike<ModelResult>;
}

export type LoopStopReason = 'final' | 'max_steps' | 'contract_failure';

export interface LoopOutcome {
  readonly ok: boolean;
  readonly task: string;
  readonly outcome: LoopStopReason;
  readonly stopReason: LoopStopReason;
  readonly finalText?: string;
  readonly error?: string;
  readonly steps: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly transcript: readonly Message[];
}
