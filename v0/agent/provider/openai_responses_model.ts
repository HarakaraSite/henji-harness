import OpenAI from '@openai/openai';
import type {
  JsonValue,
  Message,
  Model,
  ModelGenerateOptions,
  ModelRequest,
  ModelResult,
  ProviderState,
  ToolCall,
} from '../core/contracts.ts';
import { throwIfCancelled, TurnCancelledError } from '../core/cancellation.ts';
import { readableThinkingFromState } from '../core/readable_thinking.ts';
import {
  type CredentialSource,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  OpenRouterAgentError,
} from './openrouter_contract.ts';
import type {
  DeclaredProviderModelSelection,
  ModelSelection,
  OpenAIModelSelection,
  OpenRouterResponsesModelSelection,
} from './model_selection.ts';
import { substituteRequestHeaders } from './provider_request_headers.ts';

export interface OpenAIResponsesModelOptions {
  readonly selection: OpenAIModelSelection;
  readonly credentialSource: CredentialSource;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const jsonValue = (value: unknown): JsonValue | undefined => {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const replayItemsFor = (
  state: ProviderState | undefined,
  providerId: string,
  modelId: string,
): readonly JsonValue[] | undefined => {
  if (state === undefined || state.provider !== providerId) return undefined;
  const responses = state as {
    readonly replayItems?: readonly JsonValue[];
    readonly model?: string;
  };
  if (!Array.isArray(responses.replayItems)) return undefined;
  if (responses.model !== undefined && responses.model !== modelId) return undefined;
  return responses.replayItems;
};

const requestInput = (
  transcript: readonly Message[],
  providerId: string,
  modelId: string,
): unknown[] => {
  const input: unknown[] = [];
  for (const message of transcript) {
    if (message.role === 'user') {
      input.push({ role: 'user', content: message.content.text });
      continue;
    }
    if (message.role === 'assistant') {
      const replayItems = replayItemsFor(message.providerState, providerId, modelId);
      if (replayItems !== undefined) {
        input.push(...replayItems);
        continue;
      }
      if (!Array.isArray(message.content)) {
        input.push({
          role: 'assistant',
          content: (message.content as { readonly text: string }).text,
        });
        continue;
      }
      if (message.text !== undefined) {
        input.push({ role: 'assistant', content: message.text });
      }
      for (const call of message.content) {
        input.push({
          type: 'function_call',
          call_id: call.callId,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }
    for (const result of message.content) {
      input.push({
        type: 'function_call_output',
        call_id: result.callId,
        output: result.text,
      });
    }
  }
  return input;
};

const evidenceOrigin = (
  options: ModelGenerateOptions,
): 'root_model' | 'planner_model' | 'context_compaction' =>
  options.providerEvidencePhase === 'compaction'
    ? 'context_compaction'
    : options.providerEvidenceLane === 'planner'
    ? 'planner_model'
    : 'root_model';

const evidenceFetch = (
  fetcher: typeof fetch,
  selection: ModelSelection,
  options: ModelGenerateOptions,
): typeof fetch =>
async (input, init) => {
  const endpoint = input instanceof Request ? input.url : String(input);
  const evidence = options.providerEvidence;
  const lane = options.providerEvidenceLane ?? 'parent';
  const phase = options.providerEvidencePhase ?? 'user_turn';
  const modelStep = options.modelStep ?? 1;
  const requestMetadata = {
    contentType: 'application/json',
    redirect: 'error',
    responseMode: 'sse',
    origin: evidenceOrigin(options),
    provider: selection.provider,
    api: selection.api,
    modelId: selection.modelId,
    effort: selection.effort,
    authProfile: selection.authProfile,
    protocol: 'sse',
  } as const;
  const evidenceRequest = {
    lane,
    phase,
    modelStep,
    endpoint,
    method: 'POST',
    requestMetadata,
  } as const;
  evidence?.startRequestMetadata(evidenceRequest);
  const response = await fetcher(input, init);
  evidence?.recordResponse({ status: response.status });
  return response;
};

const providerError = (
  code:
    | 'missing_credential'
    | 'provider_timeout'
    | 'transport_error'
    | 'http_error'
    | 'response_error',
  message: string,
  requestCount: 0 | 1,
  status?: number,
): OpenRouterAgentError =>
  new OpenRouterAgentError(code, message, requestCount, status, {
    stage: code === 'missing_credential'
      ? 'credential_resolution'
      : code === 'provider_timeout' || code === 'transport_error'
      ? 'transport'
      : code === 'http_error'
      ? 'http'
      : 'response_parse',
    code,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(code === 'response_error' ? { parseReason: 'unsupported_response_shape' } : {}),
  });

const toolCalls = (output: readonly unknown[]): readonly ToolCall[] | undefined => {
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'function_call') continue;
    if (
      typeof item.call_id !== 'string' || item.call_id.length === 0 ||
      typeof item.name !== 'string' || item.name.length === 0 ||
      typeof item.arguments !== 'string'
    ) return undefined;
    let args: unknown;
    try {
      args = JSON.parse(item.arguments);
    } catch {
      return undefined;
    }
    if (!isJsonValue(args)) return undefined;
    calls.push(Object.freeze({ callId: item.call_id, name: item.name, arguments: args }));
  }
  return Object.freeze(calls);
};

export interface ResponsesApiModelOptions {
  readonly selection: ModelSelection;
  readonly credentialSource: CredentialSource;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  /** Non-secret declared request headers; `{sessionId}` resolves at request build time. */
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly sessionId?: string;
}

interface ResponsesApiModelConfig {
  readonly baseURL: string;
  readonly providerLabel: string;
  /** Producer identity recorded on client-owned replay state. */
  readonly stateProvider: string;
  readonly includeStore: boolean;
}

/** Shared Responses-API adapter; Henji retains the tool loop and durable transcript. */
class ResponsesApiModel implements Model {
  constructor(
    private readonly options: ResponsesApiModelOptions,
    private readonly config: ResponsesApiModelConfig,
  ) {}

  readonly measureRequestWire = (request: ModelRequest): {
    readonly messagesBytes: number;
    readonly bodyBytes: number;
  } => {
    const input = requestInput(
      request.transcript,
      this.options.selection.provider,
      this.options.selection.modelId,
    );
    const body = JSON.stringify({
      model: this.options.selection.modelId,
      instructions: request.systemInstruction,
      input,
      tools: request.tools,
      stream: true,
      ...(this.config.includeStore ? { store: false } : {}),
    });
    const encoder = new TextEncoder();
    return {
      messagesBytes: encoder.encode(JSON.stringify(input)).byteLength,
      bodyBytes: encoder.encode(body).byteLength,
    };
  };

  async generate(
    request: ModelRequest,
    generateOptions: ModelGenerateOptions = {},
  ): Promise<ModelResult> {
    const signal = generateOptions.signal;
    const label = this.config.providerLabel;
    throwIfCancelled(signal);
    let credential: string | undefined;
    try {
      credential = await this.options.credentialSource();
    } catch {
      credential = undefined;
    }
    if (!credential) {
      throw providerError('missing_credential', 'host provider credential is not configured', 0);
    }
    throwIfCancelled(signal);

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const abortFromTurn = () => {
      cancelled = true;
      controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', abortFromTurn, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('provider deadline exceeded');
    }, timeoutMs);
    const fetcher = evidenceFetch(
      this.options.fetcher ?? fetch,
      this.options.selection,
      generateOptions,
    );
    const defaultHeaders: Record<string, string> = {
      Authorization: `Bearer ${credential}`,
      ...substituteRequestHeaders(this.options.requestHeaders, {
        credential,
        sessionId: this.options.sessionId,
      }),
    };
    const client = new OpenAI({
      apiKey: credential,
      baseURL: this.config.baseURL,
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      logLevel: 'off',
      // The SDK also reads OPENAI_CUSTOM_HEADERS. Keep the resolved auth profile
      // authoritative when that ambient variable contains an Authorization header.
      defaultHeaders,
      fetch: fetcher,
      maxRetries: 0,
      timeout: timeoutMs,
    });
    try {
      const stream = await client.responses.create({
        model: this.options.selection.modelId,
        instructions: request.systemInstruction,
        input: requestInput(
          request.transcript,
          this.options.selection.provider,
          this.options.selection.modelId,
        ) as never,
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as Record<string, unknown>,
          strict: false,
        })),
        include: ['reasoning.encrypted_content'],
        // `auto` is a Henji catalog value, not a Responses reasoning effort; omit it so the
        // provider applies its own default. Explicit efforts are sent verbatim.
        ...(this.options.selection.effort === 'auto'
          ? {}
          : { reasoning: { effort: this.options.selection.effort as never } }),
        stream: true,
        ...(this.config.includeStore ? { store: false } : {}),
      }, {
        signal: controller.signal,
        maxRetries: 0,
        timeout: timeoutMs,
      });
      let completed: Record<string, unknown> | undefined;
      let progress = '';
      let reasoningTextDeltaSeen = false;
      let reasoningSummaryDeltaSeen = false;
      const reasoningEncrypted = new Map<string, string>();
      for await (const event of stream) {
        // A continuous stream keeps this loop in microtasks, which starves the macrotask timer
        // above. Check the deadline here too so the request cannot outlive `timeoutMs`.
        if (Date.now() - startedAt >= timeoutMs) {
          timedOut = true;
          controller.abort('provider deadline exceeded');
          throw providerError('provider_timeout', 'provider deadline exceeded', 1);
        }
        if (event.type === 'response.output_text.delta') {
          progress += event.delta;
          generateOptions.reportAssistantProgress?.(progress);
        } else if (event.type === 'response.reasoning_text.delta') {
          const delta = (event as { readonly delta?: unknown }).delta;
          if (typeof delta === 'string' && delta.length > 0) {
            reasoningTextDeltaSeen = true;
            generateOptions.reportThinkingDelta?.({ kind: 'text', text: delta });
          }
        } else if (event.type === 'response.reasoning_summary_text.delta') {
          const delta = (event as { readonly delta?: unknown }).delta;
          if (typeof delta === 'string' && delta.length > 0) {
            reasoningSummaryDeltaSeen = true;
            generateOptions.reportThinkingDelta?.({ kind: 'summary', text: delta });
          }
        } else if (event.type === 'response.output_item.done') {
          const item = (event as { readonly item?: unknown }).item;
          if (!reasoningTextDeltaSeen || !reasoningSummaryDeltaSeen) {
            const jsonItem = jsonValue(item);
            if (jsonItem !== undefined) {
              const readable = readableThinkingFromState({
                provider: this.config.stateProvider,
                replayItems: [jsonItem],
                model: this.options.selection.modelId,
              });
              if (
                readable !== undefined &&
                (readable.kind === 'text' ? !reasoningTextDeltaSeen : !reasoningSummaryDeltaSeen)
              ) {
                generateOptions.reportThinkingDelta?.(readable);
              }
            }
          }
          if (
            isRecord(item) && item.type === 'reasoning' && typeof item.id === 'string' &&
            typeof item.encrypted_content === 'string'
          ) {
            reasoningEncrypted.set(item.id, item.encrypted_content);
          }
        } else if (event.type === 'response.completed') {
          completed = event.response as unknown as Record<string, unknown>;
        } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          throw providerError('response_error', `${label} response did not complete`, 1);
        }
      }
      if (completed === undefined || !Array.isArray(completed.output)) {
        generateOptions.providerEvidence?.recordParserTransition({
          kind: 'failure',
          reason: 'unsupported_response_shape',
          field: 'response.output',
          expectedShape: 'array',
          ...(completed === undefined ? { actualShape: 'absent' } : {
            actualShape: completed.output === null ? 'null' : typeof completed.output,
          }),
        });
        throw providerError('response_error', `${label} response shape was unsupported`, 1);
      }
      const withDoneReasoning = (item: unknown): unknown => {
        if (
          isRecord(item) && item.type === 'reasoning' && typeof item.id === 'string' &&
          typeof item.encrypted_content !== 'string'
        ) {
          const fallback = reasoningEncrypted.get(item.id);
          if (fallback !== undefined) return { ...item, encrypted_content: fallback };
        }
        return item;
      };
      const replayItems = completed.output.map((item) => jsonValue(withDoneReasoning(item)));
      if (replayItems.some((item) => item === undefined)) {
        throw providerError('response_error', `${label} response items were not JSON values`, 1);
      }
      const state = Object.freeze({
        provider: this.config.stateProvider,
        replayItems: Object.freeze(replayItems as JsonValue[]),
        model: this.options.selection.modelId,
      });
      const calls = toolCalls(completed.output);
      if (calls === undefined) {
        generateOptions.providerEvidence?.recordParserTransition({
          kind: 'failure',
          reason: 'unsupported_response_shape',
          field: 'response.output.function_call',
          expectedShape: 'function call with call_id, name, arguments',
          actualShape: 'unsupported item',
        });
        throw providerError('response_error', `${label} function call shape was unsupported`, 1);
      }
      if (calls.length > 0) {
        return {
          kind: 'tool_calls',
          calls,
          providerState: state,
        };
      }
      const text = typeof completed.output_text === 'string' ? completed.output_text : progress;
      if (text.length === 0) {
        throw providerError('response_error', `${label} response had no assistant text`, 1);
      }
      return { kind: 'final', text, providerState: state };
    } catch (error) {
      if (cancelled) throw new TurnCancelledError();
      const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
      const settled = timedOut
        ? providerError('provider_timeout', 'provider deadline exceeded', 1)
        : error instanceof OpenRouterAgentError
        ? error
        : status === undefined
        ? providerError('transport_error', `${label} provider transport failed`, 1)
        : providerError('http_error', `${label} provider request failed`, 1, status);
      generateOptions.providerEvidence?.recordRequestFailure({
        stage: settled.failureFact.stage,
        code: settled.failureFact.code,
        ...(settled.failureFact.httpStatus === undefined ? {} : {
          httpStatus: settled.failureFact.httpStatus,
        }),
        ...(settled.failureFact.parseReason === undefined ? {} : {
          parseReason: settled.failureFact.parseReason,
        }),
      }, generateOptions.modelStep ?? 1);
      throw settled;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromTurn);
    }
  }
}

/** Official-SDK OpenAI Responses adapter (stateful replay items retained). */
export class OpenAIResponsesModel extends ResponsesApiModel {
  constructor(options: OpenAIResponsesModelOptions) {
    super(options, {
      baseURL: 'https://api.openai.com/v1',
      providerLabel: 'OpenAI',
      stateProvider: options.selection.provider,
      includeStore: true,
    });
  }
}

export interface OpenRouterResponsesModelOptions {
  readonly selection: OpenRouterResponsesModelSelection;
  readonly credentialSource: CredentialSource;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  /** Declared endpoint override; defaults to the built-in OpenRouter API base. */
  readonly baseURL?: string;
}

/** OpenRouter Responses adapter with client-side replay of returned output items. */
export class OpenRouterResponsesModel extends ResponsesApiModel {
  constructor(options: OpenRouterResponsesModelOptions) {
    super(options, {
      baseURL: options.baseURL ?? 'https://openrouter.ai/api/v1',
      providerLabel: 'OpenRouter',
      stateProvider: options.selection.provider,
      includeStore: false,
    });
  }
}

export interface DeclaredResponsesModelOptions {
  readonly selection: DeclaredProviderModelSelection;
  readonly credentialSource: CredentialSource;
  /** Declared endpoint base URL from the provider declaration. */
  readonly baseURL: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  /** Non-secret declared request headers; `{sessionId}` resolves at request build time. */
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly sessionId?: string;
}

/** Responses adapter for a Host-resolved declared provider (stateless request, replay-scoped state). */
export class DeclaredResponsesModel extends ResponsesApiModel {
  constructor(options: DeclaredResponsesModelOptions) {
    super(options, {
      baseURL: options.baseURL,
      providerLabel: options.selection.provider,
      stateProvider: options.selection.provider,
      includeStore: false,
    });
  }
}
