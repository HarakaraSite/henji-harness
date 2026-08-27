import { PROFILE } from '../model.ts';
import {
  type JsonValue,
  type Message,
  type Model,
  type ModelGenerateOptions,
  type ModelRequest,
  type ModelResult,
  type ToolCallContent,
  type ToolDefinition,
  type ToolResultContent,
} from './contracts.ts';
import { CancellationCleanupError, throwIfCancelled, TurnCancelledError } from './cancellation.ts';

const encoder = new TextEncoder();

const MAX_MESSAGE_BYTES = 76 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Structural provider profile consumed by the normal OpenRouter adapter. */
export interface OpenRouterAgentProfile {
  readonly id: string;
  readonly model: string;
  readonly origin: string;
  readonly path: string;
  readonly method: 'POST';
  readonly secretEnv: string;
  readonly maxCompletionTokens: number;
  readonly stream: false;
}

export type AgentTransportErrorCode =
  | 'invalid_input'
  | 'missing_credential'
  | 'transport_error'
  | 'http_error'
  | 'response_error'
  | 'limit_exceeded';

/** A failure surface that deliberately retains no credential or provider body. */
export class OpenRouterAgentError extends Error {
  readonly code: AgentTransportErrorCode;
  readonly requestCount: 0 | 1;
  readonly status?: number;

  constructor(
    code: AgentTransportErrorCode,
    message: string,
    requestCount: 0 | 1,
    status?: number,
  ) {
    super(message);
    this.name = 'OpenRouterAgentError';
    this.code = code;
    this.requestCount = requestCount;
    this.status = status;
  }
}

type ResponseBodyResult =
  | { readonly kind: 'text'; readonly text: string; readonly cleanupFailed: boolean }
  | { readonly kind: 'limit_exceeded'; readonly cleanupFailed: boolean }
  | { readonly kind: 'stream_error'; readonly cleanupFailed: boolean }
  | { readonly kind: 'missing'; readonly cleanupFailed: false };

/** Read one bounded response while retaining proof that the body reader was settled. */
const readResponseBody = async (response: Response): Promise<ResponseBodyResult> => {
  if (!response.body) return { kind: 'missing', cleanupFailed: false };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return { kind: 'stream_error', cleanupFailed: true };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let result: ResponseBodyResult = { kind: 'stream_error', cleanupFailed: true };
  try {
    for (;;) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch {
        let cleanupFailed = true;
        try {
          await reader.cancel('provider response stream failed');
          cleanupFailed = false;
        } catch {
          // The body is not proven settled when cancellation itself fails.
        }
        result = { kind: 'stream_error', cleanupFailed };
        break;
      }
      if (item.done) {
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        result = {
          kind: 'text',
          text: new TextDecoder().decode(body),
          cleanupFailed: false,
        };
        break;
      }
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        let cleanupFailed = true;
        try {
          await reader.cancel('response limit exceeded');
          cleanupFailed = false;
        } catch {
          // The body is not proven settled when cancellation itself fails.
        }
        result = { kind: 'limit_exceeded', cleanupFailed };
        break;
      }
      chunks.push(item.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      result = { ...result, cleanupFailed: true };
    }
  }
  return result;
};

const cancelResponseBody = async (response: Response): Promise<boolean> => {
  if (!response.body) return true;
  try {
    await response.body.cancel();
    return true;
  } catch {
    return false;
  }
};

export type CredentialSource = () => string | undefined;

export interface OpenRouterAgentModelOptions {
  /** Tests inject this; production defaults to the host-owned global fetch. */
  readonly fetcher?: typeof fetch;
  /** A test-only dummy credential. It is never serialized into a request body. */
  readonly credential?: string;
  /** A host-owned source, useful for testing the missing-credential boundary. */
  readonly credentialSource?: CredentialSource;
  /** Tests may use a local endpoint; callers cannot select it through ModelRequest. */
  readonly endpoint?: string;
  /** Internal composition input; omitted callers retain the canonical PROFILE. */
  readonly profile?: OpenRouterAgentProfile;
  readonly timeoutMs?: number;
  readonly parentSignal?: AbortSignal;
}

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
}

interface WireAssistantToolMessage {
  readonly role: 'assistant';
  readonly content: null;
  readonly tool_calls: readonly WireToolCall[];
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

interface WireResponseToolCall {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly function?: unknown;
}

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const validSystemInstruction = (value: unknown): value is string =>
  nonBlank(value) && !value.includes('\0') && hasWellFormedUnicode(value);

const safeJson = (value: unknown): string | undefined => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : encoded;
  } catch {
    return undefined;
  }
};

const bytes = (value: string): number => encoder.encode(value).byteLength;

const invalid = (message: string): OpenRouterAgentError =>
  new OpenRouterAgentError('invalid_input', message, 0);

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

const toolResultWire = (result: ToolResultContent): WireToolMessage | undefined => {
  if (
    typeof result !== 'object' || result === null || result.kind !== 'tool_result' ||
    !nonBlank(result.callId) || !nonBlank(result.name) ||
    typeof result.text !== 'string' || (result.outcome !== 'success' && result.outcome !== 'error')
  ) return undefined;
  return { role: 'tool', tool_call_id: result.callId, content: result.text };
};

const encodeMessage = (message: Message): WireMessage[] | undefined => {
  if (typeof message !== 'object' || message === null) return undefined;
  if (message.role === 'user') {
    const content = message.content;
    return typeof content === 'object' && content !== null && content.kind === 'text' &&
        typeof content.text === 'string'
      ? [{ role: 'user', content: content.text }]
      : undefined;
  }
  if (message.role === 'assistant') {
    const content = message.content;
    if (
      !Array.isArray(content) && typeof content === 'object' && content !== null &&
      'kind' in content && content.kind === 'text' && typeof content.text === 'string'
    ) {
      return [{ role: 'assistant', content: content.text }];
    }
    if (!Array.isArray(message.content) || message.content.length === 0) return undefined;
    const calls = message.content.map(toolCallWire);
    return calls.every((call): call is WireToolCall => call !== undefined)
      ? [{ role: 'assistant', content: null, tool_calls: calls }]
      : undefined;
  }
  if (message.role === 'tool') {
    if (!Array.isArray(message.content) || message.content.length === 0) return undefined;
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

const encodeRequest = (
  request: ModelRequest,
): { messages: WireMessage[]; tools: WireFunctionTool[] } => {
  if (typeof request !== 'object' || request === null || !Array.isArray(request.transcript)) {
    throw invalid('model transcript is required');
  }
  if (request.transcript.length === 0) throw invalid('model transcript is required');
  if (!Array.isArray(request.tools)) throw invalid('model tools are invalid');

  const messages: WireMessage[] = [];
  if (request.systemInstruction !== undefined) {
    if (!validSystemInstruction(request.systemInstruction)) {
      throw invalid('model system instruction is invalid');
    }
    messages.push({ role: 'system', content: request.systemInstruction });
  }
  for (const message of request.transcript) {
    const encoded = encodeMessage(message);
    if (!encoded) throw invalid('model transcript message is invalid');
    messages.push(...encoded);
  }
  const tools = request.tools.map(encodeTool);
  if (!tools.every((tool): tool is WireFunctionTool => tool !== undefined)) {
    throw invalid('model tool definition is invalid');
  }
  const messageBody = safeJson(messages);
  if (messageBody === undefined) throw invalid('model transcript is not JSON serializable');
  if (bytes(messageBody) > MAX_MESSAGE_BYTES) {
    throw new OpenRouterAgentError(
      'limit_exceeded',
      'serialized model messages exceed 76 KiB',
      0,
    );
  }
  return { messages, tools };
};

const responseError = (message: string, requestCount: 0 | 1 = 1): OpenRouterAgentError =>
  new OpenRouterAgentError('response_error', message, requestCount);

const decodeToolCalls = (value: unknown): ModelResult | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const calls = value.map((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const call = raw as WireResponseToolCall;
    if (call.type !== 'function' || !nonBlank(call.id)) return undefined;
    if (typeof call.function !== 'object' || call.function === null) return undefined;
    const fn = call.function as { name?: unknown; arguments?: unknown };
    if (!nonBlank(fn.name) || typeof fn.arguments !== 'string') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fn.arguments);
    } catch {
      return undefined;
    }
    if (!isJsonValue(parsed)) return undefined;
    return { callId: call.id, name: fn.name, arguments: parsed };
  });
  return calls.every((call): call is { callId: string; name: string; arguments: JsonValue } =>
      call !== undefined
    )
    ? { kind: 'tool_calls', calls }
    : undefined;
};

const decodeResponse = (payload: unknown): ModelResult => {
  if (typeof payload !== 'object' || payload === null) {
    throw responseError('provider response shape was unsupported');
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw responseError('provider response shape was unsupported');
  }
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null) {
    throw responseError('provider response shape was unsupported');
  }
  const message = (choice as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    throw responseError('provider response shape was unsupported');
  }
  if ((message as { role?: unknown }).role !== 'assistant') {
    throw responseError('provider response shape was unsupported');
  }
  const content = (message as { content?: unknown }).content;
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (
    typeof content === 'string' && content.length > 0 &&
    (toolCalls === undefined || toolCalls === null)
  ) {
    return { kind: 'final', text: content };
  }
  if ((content === null || content === undefined || content === '') && toolCalls !== undefined) {
    const result = decodeToolCalls(toolCalls);
    if (result) return result;
  }
  throw responseError('provider response contained no supported result');
};

const resolveCredential = (
  options: OpenRouterAgentModelOptions,
  profile: OpenRouterAgentProfile,
): string | undefined => {
  try {
    if (options.credentialSource) return options.credentialSource();
    if (options.credential !== undefined) return options.credential;
    return Deno.env.get(profile.secretEnv);
  } catch {
    return undefined;
  }
};

/** Additive offline-composable adapter for the existing provider-neutral Model contract. */
export class OpenRouterAgentModel implements Model {
  private readonly fetcher: typeof fetch;
  private readonly options: OpenRouterAgentModelOptions;
  private readonly profile: OpenRouterAgentProfile;

  constructor(options: OpenRouterAgentModelOptions = {}) {
    this.options = options;
    this.fetcher = options.fetcher ?? fetch;
    this.profile = options.profile ?? PROFILE;
  }

  async generate(
    request: ModelRequest,
    generateOptions: ModelGenerateOptions = {},
  ): Promise<ModelResult> {
    const encoded = encodeRequest(request);
    const body = safeJson({
      model: this.profile.model,
      messages: encoded.messages,
      tools: encoded.tools,
      stream: this.profile.stream,
      max_completion_tokens: this.profile.maxCompletionTokens,
    });
    if (body === undefined) throw invalid('provider request is not JSON serializable');
    if (bytes(body) > MAX_REQUEST_BYTES) {
      throw new OpenRouterAgentError('limit_exceeded', 'provider request exceeds 256 KiB', 0);
    }
    const turnSignal = generateOptions.signal ?? this.options.parentSignal;
    throwIfCancelled(turnSignal);
    const credential = resolveCredential(this.options, this.profile);
    if (!credential) {
      throw new OpenRouterAgentError(
        'missing_credential',
        'host provider credential is not configured',
        0,
      );
    }
    // Credential resolution may itself cross a host-controlled boundary. Do not start a fetch
    // when cancellation won while that boundary was settling.
    throwIfCancelled(turnSignal);

    const controller = new AbortController();
    let turnCancelled = false;
    let timedOut = false;
    const abortFromTurn = () => {
      turnCancelled = true;
      controller.abort(turnSignal?.reason);
    };
    turnSignal?.addEventListener('abort', abortFromTurn, { once: true });
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('provider deadline exceeded');
    }, timeoutMs);
    const endpoint = this.options.endpoint ?? `${this.profile.origin}${this.profile.path}`;
    try {
      let response: Response;
      try {
        response = await this.fetcher(endpoint, {
          method: this.profile.method,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${credential}`,
          },
          body,
        });
      } catch {
        if (turnCancelled) throw new TurnCancelledError();
        throw new OpenRouterAgentError('transport_error', 'provider transport failed', 1);
      }
      // A response owns a body as soon as fetch resolves. Even when cancellation or timeout won
      // during fetch, settle that body before classifying the request outcome.
      if (turnCancelled || timedOut || controller.signal.aborted) {
        const settled = await cancelResponseBody(response);
        if (!settled && turnCancelled) {
          throw new CancellationCleanupError();
        }
        if (turnCancelled) throw new TurnCancelledError();
        throw new OpenRouterAgentError('transport_error', 'provider transport failed', 1);
      }
      if (!response.ok) {
        const settled = await cancelResponseBody(response);
        if (!settled) {
          if (turnCancelled) throw new CancellationCleanupError();
          throw new OpenRouterAgentError('transport_error', 'provider transport failed', 1);
        }
        if (turnCancelled) throw new TurnCancelledError();
        if (timedOut) {
          throw new OpenRouterAgentError('transport_error', 'provider transport failed', 1);
        }
        throw new OpenRouterAgentError(
          'http_error',
          `provider request failed (${response.status})`,
          1,
          response.status,
        );
      }
      const bounded = await readResponseBody(response);
      if (bounded.cleanupFailed) {
        if (turnCancelled) throw new CancellationCleanupError();
        throw new OpenRouterAgentError('transport_error', 'provider response stream failed', 1);
      }
      if (turnCancelled) throw new TurnCancelledError();
      if (timedOut) {
        throw new OpenRouterAgentError('transport_error', 'provider transport failed', 1);
      }
      if (controller.signal.aborted) {
        throw new OpenRouterAgentError('transport_error', 'provider transport failed', 1);
      }
      if (bounded.kind === 'limit_exceeded') {
        throw new OpenRouterAgentError('limit_exceeded', 'provider response exceeds 1 MiB', 1);
      }
      if (bounded.kind !== 'text') {
        throw new OpenRouterAgentError('transport_error', 'provider response stream failed', 1);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(bounded.text);
      } catch {
        throw responseError('provider response was invalid');
      }
      return decodeResponse(payload);
    } finally {
      clearTimeout(timer);
      turnSignal?.removeEventListener('abort', abortFromTurn);
    }
  }
}

export const createOpenRouterAgentModel = (
  options: OpenRouterAgentModelOptions = {},
): Model => new OpenRouterAgentModel(options);
