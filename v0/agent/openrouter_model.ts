import { PRODUCTION_PROFILE } from './provider_profile.ts';
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
import { EventDeliveryError } from './events.ts';
import { CancellationCleanupError, throwIfCancelled, TurnCancelledError } from './cancellation.ts';
import { type FailureCode, type FailureStage, type ParseReason } from './failure_diagnostic.ts';
import type { ProviderEvidenceRecorder } from './provider_evidence.ts';

const encoder = new TextEncoder();

export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_SSE_DATA_EVENTS = 4_096;
export const MAX_ASSISTANT_TEXT_BYTES = 1024 * 1024;
export const MAX_ASSISTANT_PROGRESS_TEXT_BYTES = MAX_ASSISTANT_TEXT_BYTES;

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

export type OpenRouterResponseMode = 'json' | 'sse';

export type AgentTransportErrorCode =
  | 'invalid_input'
  | 'missing_credential'
  | 'transport_error'
  | 'http_error'
  | 'response_error'
  | 'limit_exceeded';

/** Typed, sanitized facts projected at the provider boundary. */
export interface OpenRouterFailureFact {
  readonly stage: FailureStage;
  readonly code: FailureCode;
  /** Number of fetch calls made by this generate invocation (0 or 1). */
  readonly requestCount: 0 | 1;
  readonly httpStatus?: number;
  readonly parseReason?: ParseReason;
}

/** A failure surface that deliberately retains no credential or provider body. */
export class OpenRouterAgentError extends Error {
  readonly code: AgentTransportErrorCode;
  readonly requestCount: 0 | 1;
  readonly status?: number;
  readonly failureFact: OpenRouterFailureFact;

  constructor(
    code: AgentTransportErrorCode,
    message: string,
    requestCount: 0 | 1,
    status?: number,
    failureFact?: Omit<OpenRouterFailureFact, 'requestCount'>,
  ) {
    super(message);
    this.name = 'OpenRouterAgentError';
    this.code = code;
    this.requestCount = requestCount;
    this.status = status;
    const defaultStage: FailureStage = code === 'missing_credential'
      ? 'credential_resolution'
      : code === 'transport_error'
      ? 'transport'
      : code === 'http_error'
      ? 'http'
      : code === 'response_error' || code === 'limit_exceeded' && requestCount === 1
      ? 'response_parse'
      : 'request_build';
    this.failureFact = Object.freeze({
      stage: failureFact?.stage ?? defaultStage,
      code: failureFact?.code ?? code,
      requestCount,
      ...(status === undefined && failureFact?.httpStatus === undefined
        ? {}
        : { httpStatus: failureFact?.httpStatus ?? status }),
      ...(failureFact?.parseReason === undefined ? {} : { parseReason: failureFact.parseReason }),
    });
  }
}

type ResponseBodyResult =
  | {
    readonly kind: 'text';
    readonly text: string;
    readonly cleanupFailed: boolean;
  }
  | { readonly kind: 'limit_exceeded'; readonly cleanupFailed: boolean }
  | { readonly kind: 'stream_error'; readonly cleanupFailed: boolean }
  | { readonly kind: 'invalid_utf8'; readonly cleanupFailed: boolean }
  | { readonly kind: 'missing'; readonly cleanupFailed: false };

/** Read one bounded response while retaining proof that the body reader was settled. */
const readResponseBody = async (
  response: Response,
  onBytes?: (bytes: Uint8Array) => void,
): Promise<ResponseBodyResult> => {
  if (!response.body) return { kind: 'missing', cleanupFailed: false };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return { kind: 'stream_error', cleanupFailed: true };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let result: ResponseBodyResult = {
    kind: 'stream_error',
    cleanupFailed: true,
  };
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
        try {
          result = {
            kind: 'text',
            text: new TextDecoder('utf-8', { fatal: true }).decode(body),
            cleanupFailed: false,
          };
        } catch {
          result = { kind: 'invalid_utf8', cleanupFailed: false };
        }
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
      onBytes?.(item.value);
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

/** A host-owned source is consulted afresh for every provider request. */
export type CredentialSource = () =>
  | string
  | undefined
  | Promise<string | undefined>;

/** Direct-test-only observation of bounded stream text accounting work. */
export interface StreamTextAccountingObserver {
  readonly onFragmentBytes?: (bytes: number) => void;
  readonly onProgressCodePoint?: () => void;
}

export interface OpenRouterAgentModelOptions {
  /** Tests inject this; production defaults to the host-owned global fetch. */
  readonly fetcher?: typeof fetch;
  /** A test-only dummy credential. It is never serialized into a request body. */
  readonly credential?: string;
  /** A host-owned source, useful for testing the missing-credential boundary. */
  readonly credentialSource?: CredentialSource;
  /** Tests may use a local endpoint; callers cannot select it through ModelRequest. */
  readonly endpoint?: string;
  /** Internal composition input; omitted callers retain the canonical production profile. */
  readonly profile?: OpenRouterAgentProfile;
  readonly timeoutMs?: number;
  readonly parentSignal?: AbortSignal;
  /** Internal runtime composition; omitted callers retain the canonical JSON response mode. */
  readonly responseMode?: OpenRouterResponseMode;
  /** Direct-test-only work observation; production callers omit this field. */
  readonly testTextAccountingObserver?: StreamTextAccountingObserver;
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
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
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
    const content = message.content;
    if (
      !Array.isArray(content) && typeof content === 'object' &&
      content !== null &&
      'kind' in content && content.kind === 'text' &&
      typeof content.text === 'string'
    ) {
      return [{ role: 'assistant', content: content.text }];
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      return undefined;
    }
    const calls = message.content.map(toolCallWire);
    return calls.every((call): call is WireToolCall => call !== undefined)
      ? [{ role: 'assistant', content: null, tool_calls: calls }]
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
    throw invalid('model transcript is required');
  }
  if (request.transcript.length === 0) {
    throw invalid('model transcript is required');
  }
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
  if (messageBody === undefined) {
    throw invalid('model transcript is not JSON serializable');
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
  });
  if (body === undefined) throw invalid('provider request is not JSON serializable');
  return {
    messages: encoded.messages,
    tools: encoded.tools,
    messagesBytes: bytes(JSON.stringify(encoded.messages)),
    bodyBytes: bytes(body),
  };
};

const responseError = (
  message: string,
  parseReason: ParseReason,
): OpenRouterAgentError =>
  new OpenRouterAgentError(
    'response_error',
    message,
    1,
    undefined,
    { stage: 'response_parse', code: 'response_error', parseReason },
  );

const decodeToolCalls = (value: unknown): ModelResult | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const calls = value.map((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const call = raw as WireResponseToolCall;
    if (call.type !== 'function' || !nonBlank(call.id)) return undefined;
    if (typeof call.function !== 'object' || call.function === null) {
      return undefined;
    }
    const fn = call.function as { name?: unknown; arguments?: unknown };
    if (!nonBlank(fn.name) || typeof fn.arguments !== 'string') {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fn.arguments);
    } catch {
      return undefined;
    }
    if (!isJsonValue(parsed)) return undefined;
    return { callId: call.id, name: fn.name, arguments: parsed };
  });
  return calls.every((
      call,
    ): call is { callId: string; name: string; arguments: JsonValue } => call !== undefined
    )
    ? { kind: 'tool_calls', calls }
    : undefined;
};

const decodeResponse = (payload: unknown): ModelResult => {
  if (typeof payload !== 'object' || payload === null) {
    throw responseError('provider response shape was unsupported', 'unsupported_response_shape');
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw responseError('provider response shape was unsupported', 'unsupported_response_shape');
  }
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null) {
    throw responseError('provider response shape was unsupported', 'unsupported_response_shape');
  }
  const message = (choice as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    throw responseError('provider response shape was unsupported', 'unsupported_response_shape');
  }
  if ((message as { role?: unknown }).role !== 'assistant') {
    throw responseError('provider response shape was unsupported', 'unsupported_response_shape');
  }
  const content = (message as { content?: unknown }).content;
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (
    typeof content === 'string' && content.length > 0 &&
    (toolCalls === undefined || toolCalls === null)
  ) {
    if (bytes(content) > MAX_ASSISTANT_TEXT_BYTES) {
      throw new OpenRouterAgentError(
        'limit_exceeded',
        'assistant response exceeds 1 MiB',
        1,
        undefined,
        {
          stage: 'response_parse',
          code: 'limit_exceeded',
          parseReason: 'response_body_too_large',
        },
      );
    }
    return { kind: 'final', text: content };
  }
  if (
    (content === null || content === undefined || content === '') &&
    toolCalls !== undefined
  ) {
    const result = decodeToolCalls(toolCalls);
    if (result) return result;
  }
  throw responseError(
    'provider response contained no supported result',
    'unsupported_response_shape',
  );
};

const sseResponseError = (
  message: string,
  parseReason: ParseReason,
  httpStatus?: number,
): OpenRouterAgentError =>
  new OpenRouterAgentError(
    'response_error',
    message,
    1,
    httpStatus,
    {
      stage: 'response_parse',
      code: 'response_error',
      parseReason,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  );

/** Attach the successful response status to parser facts at the response boundary. */
const withResponseStatus = (
  error: OpenRouterAgentError,
  httpStatus: number,
): OpenRouterAgentError => {
  const fact = error.failureFact;
  if (fact.stage !== 'response_parse' || fact.httpStatus !== undefined) return error;
  if (fact.parseReason === undefined) {
    return new OpenRouterAgentError(
      'response_error',
      error.message,
      error.requestCount,
      httpStatus,
      {
        stage: 'response_parse',
        code: 'response_error',
        httpStatus,
        parseReason: 'unsupported_response_shape',
      },
    );
  }
  return new OpenRouterAgentError(
    error.code,
    error.message,
    error.requestCount,
    httpStatus,
    {
      stage: fact.stage,
      code: fact.code,
      httpStatus,
      parseReason: fact.parseReason,
    },
  );
};

const sseTransportError = (): OpenRouterAgentError =>
  new OpenRouterAgentError(
    'transport_error',
    'provider response stream failed',
    1,
    undefined,
    { stage: 'transport', code: 'transport_error' },
  );

const responseStreamError = (httpStatus: number): OpenRouterAgentError =>
  sseResponseError(
    'provider response stream failed',
    'response_stream_failed',
    httpStatus,
  );

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const responseHeaders = (headers: Headers): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
};

type SsePayloadHandler = (payload: string, rawFrame: string) => void;

/**
 * Dependency-free SSE framer for the documented Chat Completions subset. It deliberately keeps
 * no raw frame after dispatch; callers receive one decoded data payload at a time.
 */
class SseFramer {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private pendingCr = false;
  private dataLines: string[] = [];
  private eventLines: string[] = [];
  private bomHandled = false;
  private _done = false;
  private dataEvents = 0;

  constructor(private readonly onPayload: SsePayloadHandler) {}

  get done(): boolean {
    return this._done;
  }

  get eventCount(): number {
    return this.dataEvents;
  }

  push(bytes: Uint8Array): void {
    if (this._done) return;
    let decoded: string;
    try {
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw sseResponseError('provider response contained invalid UTF-8', 'invalid_utf8');
    }
    this.consume(decoded);
  }

  finish(): void {
    if (this._done) return;
    let decoded: string;
    try {
      decoded = this.decoder.decode();
    } catch {
      throw sseResponseError('provider response contained invalid UTF-8', 'invalid_utf8');
    }
    this.consume(decoded);
    if (this._done) return;
    if (this.pendingCr) {
      this.pendingCr = false;
      this.finishLine();
    }
    // A final nonblank line or a data field without a separator is an incomplete event. Even
    // when the semantic result is already present, `[DONE]` must have a complete SSE frame.
    if (this.line.length > 0 || this.dataLines.length > 0) {
      throw sseResponseError(
        'provider response stream ended with an incomplete event',
        'invalid_sse_framing',
      );
    }
    throw sseResponseError(
      'provider response stream ended before [DONE]',
      'stream_ended_before_done',
    );
  }

  private consume(decoded: string): void {
    for (const character of decoded) {
      if (this._done) return;
      if (!this.bomHandled) {
        this.bomHandled = true;
        if (character === '\ufeff') continue;
      }
      if (this.pendingCr) {
        this.pendingCr = false;
        if (character === '\n') continue;
      }
      if (character === '\r') {
        this.pendingCr = true;
        this.finishLine();
      } else if (character === '\n') {
        this.finishLine();
      } else {
        this.line += character;
      }
    }
  }

  private finishLine(): void {
    const line = this.line;
    this.line = '';
    this.eventLines.push(line);
    if (line.length === 0) {
      this.dispatchEvent();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== 'data') return;
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.dataLines.push(value);
  }

  private dispatchEvent(): void {
    if (this.dataLines.length === 0) {
      this.eventLines = [];
      return;
    }
    const payload = this.dataLines.join('\n');
    const rawFrame = `${this.eventLines.join('\n')}\n`;
    this.dataLines = [];
    this.eventLines = [];
    if (payload.length === 0) {
      throw sseResponseError('provider response contained empty data', 'empty_terminal_result');
    }
    this.dataEvents += 1;
    if (this.dataEvents > MAX_SSE_DATA_EVENTS) {
      throw new OpenRouterAgentError(
        'limit_exceeded',
        'provider response has too many events',
        1,
        undefined,
        {
          stage: 'response_parse',
          code: 'limit_exceeded',
          parseReason: 'response_stream_failed',
        },
      );
    }
    this.onPayload(payload, rawFrame);
    if (payload === '[DONE]') this._done = true;
  }
}

interface StreamToolAssembly {
  readonly index: number;
  id?: string;
  type?: 'function';
  name?: string;
  arguments: string;
}

interface StreamAssembly {
  completionId?: string;
  textParts: string[];
  /** UTF-8 accounting is accumulated per delta; never re-encode the growing text. */
  textBytes: number;
  sawText: boolean;
  sawTools: boolean;
  tools: Map<number, StreamToolAssembly>;
  liveFrozen: boolean;
  progressText: string;
  progressBytes: number;
  lastReported?: string;
  terminal?: 'stop' | 'tool_calls';
  usageSeen: boolean;
  result?: ModelResult;
}

const STREAM_USAGE_REQUIRED_KEYS = ['completion_tokens', 'prompt_tokens', 'total_tokens'] as const;

const isStreamUsage = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  // Providers may append accounting metadata (for example `cost` or token-detail objects). Only
  // the documented completion counters are required, and usage is never exposed in ModelResult.
  return STREAM_USAGE_REQUIRED_KEYS.every((key) =>
    typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && usage[key] >= 0
  );
};

const safeIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const updateStreamTool = (
  assembly: StreamAssembly,
  raw: unknown,
): void => {
  if (typeof raw !== 'object' || raw === null) {
    throw sseResponseError('provider tool call shape was unsupported', 'unsupported_delta_shape');
  }
  const fragment = raw as {
    index?: unknown;
    id?: unknown;
    type?: unknown;
    function?: unknown;
  };
  if (!safeIndex(fragment.index)) {
    throw sseResponseError('provider tool-call index was invalid', 'incomplete_tool_call');
  }
  const index = fragment.index;
  let target = assembly.tools.get(index);
  if (target === undefined) {
    target = { index, arguments: '' };
    assembly.tools.set(index, target);
  }
  if (hasOwn(fragment, 'id')) {
    if (!nonBlank(fragment.id)) {
      throw sseResponseError('provider tool-call id was invalid', 'incomplete_tool_call');
    }
    if (target.id !== undefined && target.id !== fragment.id) {
      throw sseResponseError('provider tool-call metadata conflicted', 'incomplete_tool_call');
    }
    target.id = fragment.id;
  }
  if (hasOwn(fragment, 'type')) {
    if (fragment.type !== 'function') {
      throw sseResponseError('provider tool-call type was invalid', 'incomplete_tool_call');
    }
    if (target.type !== undefined && target.type !== fragment.type) {
      throw sseResponseError('provider tool-call metadata conflicted', 'incomplete_tool_call');
    }
    target.type = 'function';
  }
  if (hasOwn(fragment, 'function')) {
    if (typeof fragment.function !== 'object' || fragment.function === null) {
      throw sseResponseError('provider tool-call function was invalid', 'incomplete_tool_call');
    }
    const fn = fragment.function as { name?: unknown; arguments?: unknown };
    if (hasOwn(fn, 'name')) {
      if (!nonBlank(fn.name)) {
        throw sseResponseError('provider tool-call name was invalid', 'incomplete_tool_call');
      }
      if (target.name !== undefined && target.name !== fn.name) {
        throw sseResponseError('provider tool-call metadata conflicted', 'incomplete_tool_call');
      }
      target.name = fn.name;
    }
    if (hasOwn(fn, 'arguments')) {
      if (typeof fn.arguments !== 'string') {
        throw sseResponseError(
          'provider tool-call arguments were invalid',
          'invalid_tool_arguments',
        );
      }
      target.arguments += fn.arguments;
    }
  }
};

const completeStreamTools = (assembly: StreamAssembly): ModelResult => {
  const indices = [...assembly.tools.keys()].sort((left, right) => left - right);
  if (
    indices.length === 0 ||
    indices.some((index, position) => index !== position)
  ) {
    throw sseResponseError(
      'provider tool-call indices were not contiguous',
      'incomplete_tool_call',
    );
  }
  const calls = indices.map((index) => {
    const tool = assembly.tools.get(index)!;
    if (
      !nonBlank(tool.id) || tool.type !== 'function' || !nonBlank(tool.name)
    ) {
      throw sseResponseError('provider tool-call metadata was incomplete', 'incomplete_tool_call');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tool.arguments);
    } catch {
      throw sseResponseError('provider tool-call arguments were invalid', 'invalid_tool_arguments');
    }
    if (!isJsonValue(parsed)) {
      throw sseResponseError('provider tool-call arguments were invalid', 'invalid_tool_arguments');
    }
    return { callId: tool.id, name: tool.name, arguments: parsed };
  });
  return { kind: 'tool_calls', calls };
};

const processSsePayload = (
  assembly: StreamAssembly,
  payload: string,
  report: ModelGenerateOptions['reportAssistantProgress'],
  observer?: StreamTextAccountingObserver,
): void => {
  if (payload === '[DONE]') {
    if (assembly.terminal === undefined || assembly.result === undefined) {
      throw sseResponseError(
        'provider stream ended before a terminal result',
        'stream_ended_before_done',
      );
    }
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw sseResponseError('provider response contained invalid JSON', 'invalid_sse_json');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw sseResponseError('provider response shape was unsupported', 'unsupported_response_shape');
  }
  const object = raw as Record<string, unknown>;
  if (
    hasOwn(object, 'error') && object.error !== undefined &&
    object.error !== null
  ) {
    throw sseResponseError('provider response reported an error', 'provider_reported_error');
  }
  const hasUsage = hasOwn(object, 'usage');
  if (!nonBlank(object.id)) {
    throw sseResponseError('provider completion id was invalid', 'invalid_completion_identity');
  }
  if (assembly.completionId === undefined) assembly.completionId = object.id;
  else if (assembly.completionId !== object.id) {
    throw sseResponseError('provider completion id changed', 'invalid_completion_identity');
  }
  const choices = object.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw sseResponseError(
      'provider response choice shape was unsupported',
      'unsupported_choice_shape',
    );
  }
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
    throw sseResponseError(
      'provider response choice shape was unsupported',
      'unsupported_choice_shape',
    );
  }
  const choiceObject = choice as Record<string, unknown>;
  if (choiceObject.index !== 0) {
    throw sseResponseError(
      'provider response choice index was invalid',
      'unsupported_choice_shape',
    );
  }
  const finishReason = choiceObject.finish_reason;
  if (
    finishReason !== undefined && finishReason !== null &&
    finishReason !== 'stop' && finishReason !== 'tool_calls'
  ) {
    throw sseResponseError(
      'provider response finish reason was unsupported',
      'unsupported_finish_reason',
    );
  }
  const delta = choiceObject.delta;
  if (
    delta !== undefined &&
    (typeof delta !== 'object' || delta === null || Array.isArray(delta))
  ) {
    throw sseResponseError(
      'provider response delta shape was unsupported',
      'unsupported_delta_shape',
    );
  }
  const deltaObject = (delta ?? {}) as Record<string, unknown>;
  const contentPresent = hasOwn(deltaObject, 'content');
  const content = deltaObject.content;
  const hasContent = typeof content === 'string' && content.length > 0;
  if (
    contentPresent && content !== null && content !== '' &&
    typeof content !== 'string'
  ) {
    throw sseResponseError('provider response content was unsupported', 'unsupported_delta_shape');
  }
  if (hasOwn(deltaObject, 'role') && deltaObject.role !== 'assistant') {
    throw sseResponseError('provider response role was invalid', 'unsupported_delta_shape');
  }
  const toolCalls = deltaObject.tool_calls;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (
    hasOwn(deltaObject, 'tool_calls') && toolCalls !== null &&
    !Array.isArray(toolCalls)
  ) {
    throw sseResponseError(
      'provider response tool calls were unsupported',
      'unsupported_delta_shape',
    );
  }

  if (assembly.terminal !== undefined) {
    // Only one content-free post-terminal usage frame is accepted. It has no effect on the
    // authoritative result and cannot consume assistant progress bounds.
    if (
      assembly.usageSeen || !hasUsage || !isStreamUsage(object.usage) ||
      finishReason !== assembly.terminal || hasContent || hasToolCalls ||
      hasOwn(deltaObject, 'content') && content !== '' ||
      hasOwn(deltaObject, 'role') && deltaObject.role !== 'assistant'
    ) {
      throw sseResponseError(
        'provider response contained data after terminal',
        'data_after_terminal',
      );
    }
    assembly.usageSeen = true;
    return;
  }

  if (hasUsage) {
    throw sseResponseError('provider usage frame arrived before terminal', 'invalid_usage_frame');
  }

  if ((hasContent && assembly.sawTools) || (hasToolCalls && assembly.sawText)) {
    throw sseResponseError(
      'provider response mixed text and tool calls',
      'mixed_text_and_tool_calls',
    );
  }
  if (hasContent) {
    assembly.sawText = true;
    // Keep fragments until the terminal result. Repeatedly concatenating an ever-growing
    // provider string can force quadratic copying on runtimes that flatten ropes eagerly.
    assembly.textParts.push(content);
    const contentBytes = bytes(content);
    observer?.onFragmentBytes?.(contentBytes);
    assembly.textBytes += contentBytes;
    if (assembly.textBytes > MAX_ASSISTANT_TEXT_BYTES) {
      throw new OpenRouterAgentError(
        'limit_exceeded',
        'assistant response exceeds 1 MiB',
        1,
        undefined,
        {
          stage: 'response_parse',
          code: 'limit_exceeded',
          parseReason: 'response_body_too_large',
        },
      );
    }
    if (report && !assembly.liveFrozen) {
      for (const character of content) {
        observer?.onProgressCodePoint?.();
        const size = encoder.encode(character).byteLength;
        if (assembly.progressBytes + size > MAX_ASSISTANT_PROGRESS_TEXT_BYTES) {
          assembly.liveFrozen = true;
          break;
        }
        assembly.progressText += character;
        assembly.progressBytes += size;
      }
      if (
        assembly.progressText.length > 0 && assembly.progressText !== assembly.lastReported
      ) {
        report(assembly.progressText);
        assembly.lastReported = assembly.progressText;
      }
      if (assembly.textBytes > MAX_ASSISTANT_PROGRESS_TEXT_BYTES) {
        assembly.liveFrozen = true;
      }
    }
  }
  if (hasToolCalls) {
    assembly.sawTools = true;
    for (const fragment of toolCalls!) updateStreamTool(assembly, fragment);
  }
  if (finishReason === undefined || finishReason === null) return;
  if (finishReason === 'stop') {
    if (!assembly.sawText || assembly.sawTools || assembly.textBytes === 0) {
      throw sseResponseError(
        'provider stop result was empty or unsupported',
        'empty_terminal_result',
      );
    }
    assembly.terminal = 'stop';
    assembly.result = { kind: 'final', text: assembly.textParts.join('') };
  } else {
    if (!assembly.sawTools || assembly.sawText) {
      throw sseResponseError(
        'provider tool result was empty or unsupported',
        'empty_terminal_result',
      );
    }
    assembly.terminal = 'tool_calls';
    assembly.result = completeStreamTools(assembly);
  }
};

const readSseResponse = async (
  response: Response,
  report: ModelGenerateOptions['reportAssistantProgress'],
  isTurnCancelled: () => boolean,
  isTimedOut: () => boolean,
  observer?: StreamTextAccountingObserver,
  evidence?: ProviderEvidenceRecorder,
): Promise<ModelResult> => {
  if (!response.body) {
    throw sseResponseError(
      'provider response had no body',
      'response_body_missing',
      response.status,
    );
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw responseStreamError(response.status);
  }
  const assembly: StreamAssembly = {
    textParts: [],
    textBytes: 0,
    sawText: false,
    sawTools: false,
    tools: new Map(),
    liveFrozen: false,
    progressText: '',
    progressBytes: 0,
    usageSeen: false,
  };
  const framer = new SseFramer((payload, rawFrame) => {
    let parsed: unknown;
    if (payload === '[DONE]') parsed = '[DONE]';
    else {
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = undefined;
      }
    }
    const eventOrdinal = evidence?.recordSseEvent({
      data: payload,
      rawFrame,
      ...(parsed === '[DONE]' || parsed !== undefined && isJsonValue(parsed) ? { parsed } : {}),
    });
    evidence?.recordParserTransition({
      kind: 'event',
      ...(eventOrdinal === undefined ? {} : { reason: `sse_event_${eventOrdinal}` }),
      ...(parsed !== undefined && isJsonValue(parsed) ? { detail: parsed } : {}),
    });
    try {
      const terminalBefore = assembly.terminal;
      processSsePayload(assembly, payload, report, observer);
      if (terminalBefore === undefined && assembly.terminal !== undefined) {
        evidence?.recordParserTransition({ kind: 'terminal', reason: assembly.terminal });
      }
      if (payload === '[DONE]') {
        evidence?.recordParserTransition({ kind: 'result', reason: 'done' });
      }
    } catch (error) {
      if (error instanceof OpenRouterAgentError) {
        const parseReason = error.failureFact.parseReason;
        let field = 'provider response';
        if (
          parseReason === 'data_after_terminal' && typeof parsed === 'object' && parsed !== null
        ) {
          const choice = (parsed as Record<string, unknown>).choices;
          const delta = Array.isArray(choice) && choice[0] !== null && typeof choice[0] === 'object'
            ? (choice[0] as Record<string, unknown>).delta
            : undefined;
          if (typeof delta === 'object' && delta !== null) {
            const deltaObject = delta as Record<string, unknown>;
            field = Object.hasOwn(deltaObject, 'content')
              ? 'choices[0].delta.content'
              : Object.hasOwn(deltaObject, 'tool_calls')
              ? 'choices[0].delta.tool_calls'
              : Object.hasOwn(deltaObject, 'role')
              ? 'choices[0].delta.role'
              : 'choices[0].delta';
          }
        }
        evidence?.recordParserTransition({
          kind: 'failure',
          reason: parseReason ?? error.code,
          field,
          ...(parsed !== undefined && isJsonValue(parsed) ? { detail: parsed } : {}),
        });
      }
      throw error;
    }
  });
  const settleFailure = async (error: unknown): Promise<never> => {
    let settled = true;
    try {
      await reader.cancel('provider response stream failed');
    } catch {
      settled = false;
    }
    if (!settled) {
      if (error instanceof EventDeliveryError || isTurnCancelled()) {
        throw new CancellationCleanupError();
      }
      throw responseStreamError(response.status);
    }
    if (error instanceof EventDeliveryError) throw error;
    if (isTurnCancelled()) throw new TurnCancelledError();
    if (isTimedOut()) throw sseTransportError();
    if (error instanceof OpenRouterAgentError) throw withResponseStatus(error, response.status);
    throw responseStreamError(response.status);
  };
  let failure: unknown;
  let result: ModelResult | undefined;
  let rawBytes = 0;
  try {
    for (;;) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch (error) {
        failure = await settleFailure(error);
        break;
      }
      if (item.done) {
        try {
          framer.finish();
        } catch (error) {
          failure = await settleFailure(error);
        }
        break;
      }
      if (item.value.byteLength > MAX_RESPONSE_BYTES) {
        failure = await settleFailure(
          new OpenRouterAgentError(
            'limit_exceeded',
            'provider response exceeds 1 MiB',
            1,
            undefined,
            {
              stage: 'response_parse',
              code: 'limit_exceeded',
              parseReason: 'response_body_too_large',
            },
          ),
        );
        break;
      }
      // Count all bytes, including comments, ignored fields, and separators. The body is bounded
      // before decoding so an oversized UTF-8 scalar sequence cannot be accepted.
      rawBytes += item.value.byteLength;
      if (rawBytes > MAX_RESPONSE_BYTES) {
        failure = await settleFailure(
          new OpenRouterAgentError(
            'limit_exceeded',
            'provider response exceeds 1 MiB',
            1,
            undefined,
            {
              stage: 'response_parse',
              code: 'limit_exceeded',
              parseReason: 'response_body_too_large',
            },
          ),
        );
        break;
      }
      evidence?.appendResponseBytes(item.value);
      try {
        framer.push(item.value);
      } catch (error) {
        failure = await settleFailure(error);
        break;
      }
      if (framer.done) {
        try {
          await reader.cancel('provider stream complete');
        } catch (_error) {
          failure = isTurnCancelled()
            ? new CancellationCleanupError()
            : responseStreamError(response.status);
          break;
        }
        result = assembly.result;
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      failure = failure instanceof EventDeliveryError ||
          failure instanceof CancellationCleanupError ||
          isTurnCancelled()
        ? new CancellationCleanupError()
        : responseStreamError(response.status);
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw responseStreamError(response.status);
  return result;
};

const resolveCredential = async (
  options: OpenRouterAgentModelOptions,
  profile: OpenRouterAgentProfile,
): Promise<string | undefined> => {
  try {
    if (options.credentialSource) return await options.credentialSource();
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
    this.profile = options.profile ?? PRODUCTION_PROFILE;
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
      stream: this.options.responseMode === 'sse' ? true : this.profile.stream,
      max_completion_tokens: this.profile.maxCompletionTokens,
    });
    if (body === undefined) {
      throw invalid('provider request is not JSON serializable');
    }
    if (bytes(body) > MAX_REQUEST_BYTES) {
      throw new OpenRouterAgentError(
        'limit_exceeded',
        'provider request exceeds 6 MiB',
        0,
        undefined,
        { stage: 'request_build', code: 'limit_exceeded' },
      );
    }
    const turnSignal = generateOptions.signal ?? this.options.parentSignal;
    throwIfCancelled(turnSignal);
    const credential = await resolveCredential(this.options, this.profile);
    if (!credential) {
      throw new OpenRouterAgentError(
        'missing_credential',
        'host provider credential is not configured',
        0,
        undefined,
        { stage: 'credential_resolution', code: 'missing_credential' },
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
    const endpoint = this.options.endpoint ??
      `${this.profile.origin}${this.profile.path}`;
    const evidence = generateOptions.providerEvidence;
    evidence?.startRequest({
      lane: generateOptions.providerEvidenceLane ?? 'parent',
      phase: generateOptions.providerEvidencePhase ?? 'user_turn',
      modelStep: generateOptions.modelStep ?? 1,
      endpoint,
      method: this.profile.method,
      requestBody: body,
      requestMetadata: {
        contentType: 'application/json',
        redirect: 'error',
        responseMode: this.options.responseMode ?? 'json',
      },
    });
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
        throw new OpenRouterAgentError(
          'transport_error',
          'provider transport failed',
          1,
          undefined,
          { stage: 'transport', code: 'transport_error' },
        );
      }
      evidence?.recordResponse({
        status: response.status,
        headers: responseHeaders(response.headers),
      });
      // A response owns a body as soon as fetch resolves. Even when cancellation or timeout won
      // during fetch, settle that body before classifying the request outcome.
      if (turnCancelled || timedOut || controller.signal.aborted) {
        const settled = await cancelResponseBody(response);
        if (!settled && turnCancelled) {
          throw new CancellationCleanupError();
        }
        if (turnCancelled) throw new TurnCancelledError();
        throw new OpenRouterAgentError(
          'transport_error',
          'provider transport failed',
          1,
          undefined,
          { stage: 'transport', code: 'transport_error' },
        );
      }
      if (!response.ok) {
        const bounded = await readResponseBody(
          response,
          (value) => evidence?.appendResponseBytes(value),
        );
        if (bounded.cleanupFailed) {
          if (turnCancelled) throw new CancellationCleanupError();
          throw new OpenRouterAgentError(
            'transport_error',
            'provider transport failed',
            1,
            undefined,
            { stage: 'transport', code: 'transport_error' },
          );
        }
        if (turnCancelled) throw new TurnCancelledError();
        if (timedOut) {
          throw new OpenRouterAgentError(
            'transport_error',
            'provider transport failed',
            1,
            undefined,
            { stage: 'transport', code: 'transport_error' },
          );
        }
        throw new OpenRouterAgentError(
          'http_error',
          `provider request failed (${response.status})`,
          1,
          response.status,
          { stage: 'http', code: 'http_error', httpStatus: response.status },
        );
      }
      if (this.options.responseMode === 'sse') {
        const contentType = response.headers.get('content-type')?.split(
          ';',
          1,
        )[0].trim()
          .toLowerCase();
        if (!response.body || contentType !== 'text/event-stream') {
          const bounded = await readResponseBody(
            response,
            (value) => evidence?.appendResponseBytes(value),
          );
          if (bounded.cleanupFailed) {
            if (turnCancelled) throw new CancellationCleanupError();
            throw responseStreamError(response.status);
          }
          if (turnCancelled) throw new TurnCancelledError();
          if (!response.body) {
            throw sseResponseError(
              'provider response had no body',
              'response_body_missing',
              response.status,
            );
          }
          throw sseResponseError(
            'provider response media type was unsupported',
            'unsupported_media_type',
            response.status,
          );
        }
        const reportAssistantProgress = generateOptions.reportAssistantProgress === undefined
          ? undefined
          : (snapshot: string): void => {
            if (!controller.signal.aborted) {
              generateOptions.reportAssistantProgress!(snapshot);
            }
          };
        const streamed = await readSseResponse(
          response,
          reportAssistantProgress,
          () => turnCancelled,
          () => timedOut,
          this.options.testTextAccountingObserver,
          evidence,
        );
        if (turnCancelled) throw new TurnCancelledError();
        if (timedOut || controller.signal.aborted) {
          throw new OpenRouterAgentError(
            'transport_error',
            'provider transport failed',
            1,
            undefined,
            { stage: 'transport', code: 'transport_error' },
          );
        }
        return streamed;
      }
      const bounded = await readResponseBody(
        response,
        (value) => evidence?.appendResponseBytes(value),
      );
      if (bounded.cleanupFailed) {
        if (turnCancelled) throw new CancellationCleanupError();
        throw responseStreamError(response.status);
      }
      if (turnCancelled) throw new TurnCancelledError();
      if (timedOut) {
        throw new OpenRouterAgentError(
          'transport_error',
          'provider transport failed',
          1,
          undefined,
          { stage: 'transport', code: 'transport_error' },
        );
      }
      if (controller.signal.aborted) {
        throw new OpenRouterAgentError(
          'transport_error',
          'provider transport failed',
          1,
          undefined,
          { stage: 'transport', code: 'transport_error' },
        );
      }
      if (bounded.kind === 'limit_exceeded') {
        throw new OpenRouterAgentError(
          'limit_exceeded',
          'provider response exceeds 1 MiB',
          1,
          response.status,
          {
            stage: 'response_parse',
            code: 'limit_exceeded',
            httpStatus: response.status,
            parseReason: 'response_body_too_large',
          },
        );
      }
      if (bounded.kind === 'missing') {
        throw new OpenRouterAgentError(
          'response_error',
          'provider response had no body',
          1,
          response.status,
          {
            stage: 'response_parse',
            code: 'response_error',
            httpStatus: response.status,
            parseReason: 'response_body_missing',
          },
        );
      }
      if (bounded.kind !== 'text') {
        if (bounded.kind === 'invalid_utf8') {
          throw new OpenRouterAgentError(
            'response_error',
            'provider response contained invalid UTF-8',
            1,
            response.status,
            {
              stage: 'response_parse',
              code: 'response_error',
              httpStatus: response.status,
              parseReason: 'invalid_utf8',
            },
          );
        }
        throw responseStreamError(response.status);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(bounded.text);
      } catch {
        throw new OpenRouterAgentError(
          'response_error',
          'provider response was invalid',
          1,
          response.status,
          {
            stage: 'response_parse',
            code: 'response_error',
            httpStatus: response.status,
            parseReason: 'invalid_sse_json',
          },
        );
      }
      try {
        const decoded = decodeResponse(payload);
        evidence?.recordParserTransition({ kind: 'result', reason: 'json_result' });
        return decoded;
      } catch (error) {
        if (error instanceof OpenRouterAgentError) {
          evidence?.recordParserTransition({
            kind: 'failure',
            reason: error.failureFact.parseReason ?? error.code,
            field: 'response',
            ...(isJsonValue(payload) ? { detail: payload } : {}),
          });
        }
        if (error instanceof OpenRouterAgentError) {
          throw withResponseStatus(error, response.status);
        }
        throw error;
      }
    } finally {
      clearTimeout(timer);
      turnSignal?.removeEventListener('abort', abortFromTurn);
    }
  }
}

export const createOpenRouterAgentModel = (
  options: OpenRouterAgentModelOptions = {},
): Model => new OpenRouterAgentModel(options);
