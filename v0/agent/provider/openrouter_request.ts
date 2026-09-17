import { PRODUCTION_PROFILE } from './provider_profile.ts';
import type {
  JsonValue,
  Message,
  ModelRequest,
  ToolCallContent,
  ToolDefinition,
  ToolResultContent,
} from '../core/contracts.ts';
import {
  MAX_MESSAGE_BYTES,
  OpenRouterAgentError,
  type OpenRouterAgentProfile,
  type OpenRouterResponseMode,
} from './openrouter_contract.ts';
import {
  bytes,
  isJsonValue,
  nonBlank,
  safeJson,
  validSystemInstruction,
} from './openrouter_value.ts';

interface WireUserMessage {
  readonly role: 'user';
  readonly content: string;
}

interface WireSystemMessage {
  readonly role: 'system';
  readonly content: string;
}

interface WireAssistantTextMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly reasoning_details?: readonly JsonValue[];
}

interface WireAssistantToolMessage {
  readonly role: 'assistant';
  readonly content: string | null;
  readonly tool_calls: readonly WireToolCall[];
  readonly reasoning_details?: readonly JsonValue[];
}

interface WireToolMessage {
  readonly role: 'tool';
  readonly tool_call_id: string;
  readonly content: string;
}

type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantTextMessage
  | WireAssistantToolMessage
  | WireToolMessage;

interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

interface WireFunctionTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonValue;
  };
}

export const invalidRequestError = (message: string): OpenRouterAgentError =>
  new OpenRouterAgentError('invalid_input', message, 0, undefined, {
    stage: 'request_build',
    code: 'invalid_input',
  });

const toolCallWire = (call: ToolCallContent): WireToolCall | undefined => {
  if (
    typeof call !== 'object' || call === null || call.kind !== 'tool_call' ||
    !nonBlank(call.callId) || !nonBlank(call.name) ||
    !isJsonValue(call.arguments)
  ) return undefined;
  const args = safeJson(call.arguments);
  if (args === undefined) return undefined;
  return {
    id: call.callId,
    type: 'function',
    function: { name: call.name, arguments: args },
  };
};

const toolResultWire = (
  result: ToolResultContent,
): WireToolMessage | undefined => {
  if (
    typeof result !== 'object' || result === null ||
    result.kind !== 'tool_result' ||
    !nonBlank(result.callId) || !nonBlank(result.name) ||
    typeof result.text !== 'string' ||
    (result.outcome !== 'success' && result.outcome !== 'error')
  ) return undefined;
  return { role: 'tool', tool_call_id: result.callId, content: result.text };
};

const encodeMessage = (message: Message): WireMessage[] | undefined => {
  if (typeof message !== 'object' || message === null) return undefined;
  if (message.role === 'user') {
    const content = message.content;
    return typeof content === 'object' && content !== null &&
        content.kind === 'text' &&
        typeof content.text === 'string'
      ? [{ role: 'user', content: content.text }]
      : undefined;
  }
  if (message.role === 'assistant') {
    const state = message.providerState;
    const reasoningDetails = state !== undefined && 'reasoningDetails' in state &&
        Array.isArray(state.reasoningDetails) &&
        state.reasoningDetails.length > 0 &&
        state.reasoningDetails.every(isJsonValue)
      ? state.reasoningDetails
      : undefined;
    if (state !== undefined && 'reasoningDetails' in state && reasoningDetails === undefined) {
      return undefined;
    }
    const content = message.content;
    if (
      !Array.isArray(content) && typeof content === 'object' &&
      content !== null &&
      'kind' in content && content.kind === 'text' &&
      typeof content.text === 'string' && message.text === undefined
    ) {
      return [{
        role: 'assistant',
        content: content.text,
        ...(reasoningDetails === undefined ? {} : { reasoning_details: reasoningDetails }),
      }];
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      return undefined;
    }
    if (
      message.text !== undefined &&
      (typeof message.text !== 'string' || message.text.length === 0)
    ) return undefined;
    const calls = message.content.map(toolCallWire);
    return calls.every((call): call is WireToolCall => call !== undefined)
      ? [{
        role: 'assistant',
        content: message.text ?? null,
        tool_calls: calls,
        ...(reasoningDetails === undefined ? {} : { reasoning_details: reasoningDetails }),
      }]
      : undefined;
  }
  if (message.role === 'tool') {
    if (!Array.isArray(message.content) || message.content.length === 0) {
      return undefined;
    }
    const results = message.content.map(toolResultWire);
    return results.every((result): result is WireToolMessage => result !== undefined)
      ? results
      : undefined;
  }
  return undefined;
};

const encodeTool = (tool: ToolDefinition): WireFunctionTool | undefined => {
  if (
    typeof tool !== 'object' || tool === null || !nonBlank(tool.name) ||
    typeof tool.description !== 'string' || !isJsonValue(tool.inputSchema)
  ) return undefined;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
};

export const encodeRequest = (
  request: ModelRequest,
  enforceMessageLimit = true,
): { messages: WireMessage[]; tools: WireFunctionTool[] } => {
  if (
    typeof request !== 'object' || request === null ||
    !Array.isArray(request.transcript)
  ) {
    throw invalidRequestError('model transcript is required');
  }
  if (request.transcript.length === 0) {
    throw invalidRequestError('model transcript is required');
  }
  if (!Array.isArray(request.tools)) throw invalidRequestError('model tools are invalid');

  const messages: WireMessage[] = [];
  if (request.systemInstruction !== undefined) {
    if (!validSystemInstruction(request.systemInstruction)) {
      throw invalidRequestError('model system instruction is invalid');
    }
    messages.push({ role: 'system', content: request.systemInstruction });
  }
  for (const message of request.transcript) {
    const encoded = encodeMessage(message);
    if (!encoded) throw invalidRequestError('model transcript message is invalid');
    messages.push(...encoded);
  }
  const tools = request.tools.map(encodeTool);
  if (!tools.every((tool): tool is WireFunctionTool => tool !== undefined)) {
    throw invalidRequestError('model tool definition is invalid');
  }
  const messageBody = safeJson(messages);
  if (messageBody === undefined) {
    throw invalidRequestError('model transcript is not JSON serializable');
  }
  if (enforceMessageLimit && bytes(messageBody) > MAX_MESSAGE_BYTES) {
    throw new OpenRouterAgentError(
      'limit_exceeded',
      'serialized model messages exceed 5 MiB',
      0,
      undefined,
      { stage: 'request_build', code: 'limit_exceeded' },
    );
  }
  return { messages, tools };
};

/** Stable provider-wire measurement shared by context admission and the adapter itself. */
export const measureModelRequestWire = (
  request: ModelRequest,
  profile: OpenRouterAgentProfile = PRODUCTION_PROFILE,
  responseMode: OpenRouterResponseMode = 'sse',
): {
  readonly messages: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly messagesBytes: number;
  readonly bodyBytes: number;
} => {
  const encoded = encodeRequest(request, false);
  const body = safeJson({
    model: profile.model,
    messages: encoded.messages,
    tools: encoded.tools,
    stream: responseMode === 'sse' ? true : profile.stream,
    max_completion_tokens: profile.maxCompletionTokens,
    ...(profile.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: profile.reasoningEffort } }),
  });
  if (body === undefined) throw invalidRequestError('provider request is not JSON serializable');
  return {
    messages: encoded.messages,
    tools: encoded.tools,
    messagesBytes: bytes(JSON.stringify(encoded.messages)),
    bodyBytes: bytes(body),
  };
};
