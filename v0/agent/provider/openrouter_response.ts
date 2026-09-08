import type { JsonValue, ModelResult } from '../core/contracts.ts';
import type { ParseReason } from '../session/failure_diagnostic.ts';
import {
  MAX_ASSISTANT_TEXT_BYTES,
  MAX_RESPONSE_BYTES,
  OpenRouterAgentError,
} from './openrouter_contract.ts';
import { bytes, isJsonValue, nonBlank } from './openrouter_value.ts';

interface WireResponseToolCall {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly function?: unknown;
}

export type ResponseBodyResult =
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
export const readResponseBody = async (
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

export const cancelResponseBody = async (response: Response): Promise<boolean> => {
  if (!response.body) return true;
  try {
    await response.body.cancel();
    return true;
  } catch {
    return false;
  }
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

export const decodeResponse = (payload: unknown): ModelResult => {
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

export const sseResponseError = (
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
export const withResponseStatus = (
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

export const sseTransportError = (): OpenRouterAgentError =>
  new OpenRouterAgentError(
    'transport_error',
    'provider response stream failed',
    1,
    undefined,
    { stage: 'transport', code: 'transport_error' },
  );

export const responseStreamError = (httpStatus: number): OpenRouterAgentError =>
  sseResponseError(
    'provider response stream failed',
    'response_stream_failed',
    httpStatus,
  );

export const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const responseHeaders = (headers: Headers): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
};
