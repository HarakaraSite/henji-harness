import { captureFailureDetails, type FailureDetails } from '../core/failure_details.ts';
import OpenAI from '@openai/openai';
import type {
  JsonValue,
  Model,
  ModelGenerateOptions,
  ModelRequest,
  ModelResult,
  ToolCall,
} from '../core/contracts.ts';
import { throwIfCancelled, TurnCancelledError } from '../core/cancellation.ts';
import { readableThinkingFromState } from '../core/readable_thinking.ts';
import {
  type CredentialSource,
  type CredentialSourceContext,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  OpenRouterAgentError,
} from './openrouter_contract.ts';
import type {
  ChatGPTModelSelection,
  DeclaredProviderModelSelection,
  ModelSelection,
  OpenAIModelSelection,
  OpenRouterResponsesModelSelection,
} from './model_selection.ts';
import {
  measureResponsesRequestWire,
  responsesRequestInput,
  responsesRequestTools,
  type ResponsesWireConfig,
} from './openai_responses_request.ts';
import { substituteRequestHeaders } from './provider_request_headers.ts';

interface OpenAIResponsesModelOptions {
  readonly selection: OpenAIModelSelection;
  readonly credentialSource: CredentialSource;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
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
  observedResponse: (response: Response) => void,
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
  observedResponse(response);
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

const toolCalls = (
  output: readonly unknown[],
): readonly ToolCall[] | undefined => {
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
    calls.push(
      Object.freeze({ callId: item.call_id, name: item.name, arguments: args }),
    );
  }
  return Object.freeze(calls);
};

interface ResponsesApiModelOptions {
  readonly selection: ModelSelection;
  readonly credentialSource: CredentialSource;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  /** Non-secret declared request headers; `{sessionId}` resolves at request build time. */
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly sessionId?: string;
}

interface ResponsesApiModelConfig extends ResponsesWireConfig {
  readonly baseURL: string;
  readonly providerLabel: string;
}

/** Shared Responses-API adapter; Henji retains the tool loop and durable transcript. */
class ResponsesApiModel implements Model {
  constructor(
    private readonly options: ResponsesApiModelOptions,
    private readonly config: ResponsesApiModelConfig,
  ) {}

  readonly measureRequestWire = (request: ModelRequest) =>
    measureResponsesRequestWire(request, this.options.selection.modelId, this.config);

  async generate(
    request: ModelRequest,
    generateOptions: ModelGenerateOptions = {},
  ): Promise<ModelResult> {
    const signal = generateOptions.signal;
    const label = this.config.providerLabel;
    throwIfCancelled(signal);
    let credential: string | undefined;
    try {
      const credentialContext: CredentialSourceContext | undefined =
        this.config.namespaceTools === true
          ? {
            modelId: this.options.selection.modelId,
            modelStep: generateOptions.modelStep ?? 1,
            ...(this.options.sessionId === undefined ? {} : {
              sessionId: this.options.sessionId,
            }),
          }
          : undefined;
      credential = await this.options.credentialSource(credentialContext);
    } catch (error) {
      if (this.config.namespaceTools === true) throw error;
      credential = undefined;
    }
    if (!credential) {
      throw providerError(
        'missing_credential',
        'host provider credential is not configured',
        0,
      );
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
    let responseStatus: number | undefined;
    let requestId: string | undefined;
    let responseId: string | undefined;
    let streamEventCount = 0;
    let lastStreamEvent: string | undefined;
    let completedReceived = false;
    let operation = 'response_request';
    let reportedError: unknown;
    let shapeFailure: FailureDetails | undefined;
    const fetcher = evidenceFetch(
      this.options.fetcher ?? fetch,
      this.options.selection,
      generateOptions,
      (response) => {
        responseStatus = response.status;
        requestId = response.headers.get('x-request-id') ?? undefined;
      },
    );
    const defaultHeaders: Record<string, string> = {
      Authorization: `Bearer ${credential}`,
      ...substituteRequestHeaders(this.options.requestHeaders, {
        credential,
        sessionId: this.options.sessionId,
      }),
    };
    const requestTools = responsesRequestTools(request, this.config.namespaceTools);
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
        input: responsesRequestInput(
          request.transcript,
          this.config.stateProvider,
          this.options.selection.modelId,
        ) as never,
        ...(requestTools === undefined ? {} : {
          tools: requestTools as never,
        }),
        include: ['reasoning.encrypted_content'],
        reasoning: {
          summary: 'auto',
          // Henji's effort `auto` leaves the thinking amount to the provider. It is separate
          // from summary `auto`, which requests a readable summary of that thinking.
          ...(this.options.selection.effort === 'auto'
            ? {}
            : { effort: this.options.selection.effort as never }),
        },
        stream: true,
        ...(this.config.includeStore ? { store: false } : {}),
      }, {
        signal: controller.signal,
        maxRetries: 0,
        timeout: timeoutMs,
      });
      operation = 'response_stream';
      let completed: Record<string, unknown> | undefined;
      const completedItems = new Map<number, unknown>();
      let progress = '';
      let reasoningTextDeltaSeen = false;
      let reasoningSummaryDeltaSeen = false;
      const reasoningEncrypted = new Map<string, string>();
      for await (const event of stream) {
        streamEventCount += 1;
        lastStreamEvent = event.type;
        const eventResponse = (event as { response?: { id?: string } }).response;
        if (typeof eventResponse?.id === 'string') responseId = eventResponse.id;
        // A continuous stream keeps this loop in microtasks, which starves the macrotask timer
        // above. Check the deadline here too so the request cannot outlive `timeoutMs`.
        if (Date.now() - startedAt >= timeoutMs) {
          timedOut = true;
          controller.abort('provider deadline exceeded');
          throw providerError(
            'provider_timeout',
            'provider deadline exceeded',
            1,
          );
        }
        if (event.type === 'response.output_text.delta') {
          progress += event.delta;
          generateOptions.reportAssistantProgress?.(progress);
        } else if (event.type === 'response.reasoning_text.delta') {
          const delta = (event as { readonly delta?: unknown }).delta;
          if (typeof delta === 'string' && delta.length > 0) {
            reasoningTextDeltaSeen = true;
            generateOptions.reportThinkingDelta?.({
              kind: 'text',
              text: delta,
            });
          }
        } else if (event.type === 'response.reasoning_summary_text.delta') {
          const delta = (event as { readonly delta?: unknown }).delta;
          if (typeof delta === 'string' && delta.length > 0) {
            reasoningSummaryDeltaSeen = true;
            generateOptions.reportThinkingDelta?.({
              kind: 'summary',
              text: delta,
            });
          }
        } else if (event.type === 'response.output_item.done') {
          const item = (event as { readonly item?: unknown }).item;
          const outputIndex = (event as { readonly output_index?: unknown }).output_index;
          if (typeof outputIndex === 'number') {
            completedItems.set(outputIndex, item);
          }
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
            isRecord(item) && item.type === 'reasoning' &&
            typeof item.id === 'string' &&
            typeof item.encrypted_content === 'string'
          ) {
            reasoningEncrypted.set(item.id, item.encrypted_content);
          }
        } else if (event.type === 'response.completed') {
          completedReceived = true;
          completed = event.response as unknown as Record<string, unknown>;
        } else if (
          event.type === 'response.failed' ||
          event.type === 'response.incomplete'
        ) {
          const failure = (event as { response?: { error?: unknown } }).response?.error;
          if (isRecord(failure)) {
            reportedError = {
              name: 'ProviderResponseError',
              message: failure.message,
              code: failure.code,
              type: failure.type,
              param: failure.param,
            };
          }
          throw providerError(
            'response_error',
            `${label} response did not complete`,
            1,
          );
        }
      }
      operation = 'response_parse';
      if (completed === undefined || !Array.isArray(completed.output)) {
        shapeFailure = {
          field: 'response.output',
          expectedShape: 'array',
          actualShape: completed === undefined
            ? 'absent'
            : completed.output === null
            ? 'null'
            : typeof completed.output,
        };
        generateOptions.providerEvidence?.recordParserTransition({
          kind: 'failure',
          reason: 'unsupported_response_shape',
          field: 'response.output',
          expectedShape: 'array',
          ...(completed === undefined ? { actualShape: 'absent' } : {
            actualShape: completed.output === null ? 'null' : typeof completed.output,
          }),
        });
        throw providerError(
          'response_error',
          `${label} response shape was unsupported`,
          1,
        );
      }
      const output = completed.output.length === 0 && completedItems.size > 0
        ? [...completedItems.entries()].sort(([left], [right]) => left - right)
          .map(([, item]) => item)
        : completed.output;
      const withDoneReasoning = (item: unknown): unknown => {
        if (
          isRecord(item) && item.type === 'reasoning' &&
          typeof item.id === 'string' &&
          typeof item.encrypted_content !== 'string'
        ) {
          const fallback = reasoningEncrypted.get(item.id);
          if (fallback !== undefined) {
            return { ...item, encrypted_content: fallback };
          }
        }
        return item;
      };
      const replayItems = output.map((item) => jsonValue(withDoneReasoning(item)));
      if (replayItems.some((item) => item === undefined)) {
        throw providerError(
          'response_error',
          `${label} response items were not JSON values`,
          1,
        );
      }
      const state = Object.freeze({
        provider: this.config.stateProvider,
        replayItems: Object.freeze(replayItems as JsonValue[]),
        model: this.options.selection.modelId,
      });
      const calls = toolCalls(output);
      if (calls === undefined) {
        shapeFailure = {
          field: 'response.output.function_call',
          expectedShape: 'function call with call_id, name, arguments',
          actualShape: 'unsupported item',
        };
        generateOptions.providerEvidence?.recordParserTransition({
          kind: 'failure',
          reason: 'unsupported_response_shape',
          field: 'response.output.function_call',
          expectedShape: 'function call with call_id, name, arguments',
          actualShape: 'unsupported item',
        });
        throw providerError(
          'response_error',
          `${label} function call shape was unsupported`,
          1,
        );
      }
      const itemText = output.flatMap((item) => {
        if (
          !isRecord(item) || item.type !== 'message' ||
          !Array.isArray(item.content)
        ) {
          return [];
        }
        return item.content.flatMap((part) =>
          isRecord(part) && part.type === 'output_text' &&
            typeof part.text === 'string'
            ? [part.text]
            : []
        );
      }).join('');
      const text = typeof completed.output_text === 'string' &&
          completed.output_text.length > 0
        ? completed.output_text
        : progress.length > 0
        ? progress
        : itemText;
      if (calls.length > 0) {
        return {
          kind: 'tool_calls',
          calls,
          ...(text.length === 0 ? {} : { text }),
          providerState: state,
        };
      }
      if (text.length === 0) {
        throw providerError(
          'response_error',
          `${label} response had no assistant text`,
          1,
        );
      }
      return { kind: 'final', text, providerState: state };
    } catch (error) {
      if (cancelled) throw new TurnCancelledError();
      const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
      const providerApiError = reportedError !== undefined ||
        error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIConnectionError);
      const parseError = error instanceof SyntaxError && responseStatus !== undefined;
      const classified = timedOut || error instanceof OpenAI.APIConnectionTimeoutError
        ? providerError('provider_timeout', 'provider deadline exceeded', 1)
        : providerApiError
        ? new OpenRouterAgentError(
          'response_error',
          `${label} provider reported an API error`,
          1,
          status ?? responseStatus,
          {
            stage: status === undefined ? 'response_parse' : 'http',
            code: status === undefined ? 'response_error' : 'http_error',
            ...(status === undefined ? { parseReason: 'provider_reported_error' as const } : {}),
            ...((status ?? responseStatus) === undefined
              ? {}
              : { httpStatus: status ?? responseStatus }),
          },
        )
        : error instanceof OpenRouterAgentError
        ? error
        : parseError
        ? new OpenRouterAgentError(
          'response_error',
          `${label} response was invalid JSON`,
          1,
          responseStatus,
          {
            stage: 'response_parse',
            code: 'response_error',
            httpStatus: responseStatus,
            parseReason: 'invalid_sse_json',
          },
        )
        : status === undefined
        ? providerError('transport_error', `${label} provider transport failed`, 1)
        : providerError('http_error', `${label} provider request failed`, 1, status);
      const details = captureFailureDetails(reportedError ?? error, {
        operation,
        secrets: [credential, defaultHeaders.Authorization],
        facts: {
          ...(requestId === undefined ? {} : { requestId }),
          ...(responseId === undefined ? {} : { responseId }),
          streamEventCount,
          completedReceived,
          ...(lastStreamEvent === undefined ? {} : { lastStreamEvent }),
          ...shapeFailure,
        },
      });
      const settled = new OpenRouterAgentError(
        // An HTTP API rejection keeps the existing HTTP-facing code.
        classified.failureFact.code === 'http_error' ? 'http_error' : classified.code,
        classified.message,
        classified.requestCount,
        classified.status,
        {
          ...classified.failureFact,
          ...(classified.failureFact.stage === 'response_parse' &&
              classified.failureFact.httpStatus === undefined && responseStatus !== undefined
            ? { httpStatus: responseStatus }
            : {}),
          details,
        },
      );
      generateOptions.providerEvidence?.recordRequestFailure({
        stage: settled.failureFact.stage,
        code: settled.failureFact.code,
        details,
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

interface ChatGPTResponsesModelOptions {
  readonly selection: ChatGPTModelSelection;
  readonly credentialSource: CredentialSource;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
}

/** ChatGPT route differences on the shared Responses API adapter. */
export class ChatGPTResponsesModel extends ResponsesApiModel {
  constructor(options: ChatGPTResponsesModelOptions) {
    super(options, {
      baseURL: 'https://api.openai.com/v1',
      providerLabel: 'ChatGPT',
      stateProvider: options.selection.registrationId === undefined
        ? options.selection.provider
        : `${options.selection.provider}@${options.selection.registrationId ?? 'unselected'}`,
      includeStore: true,
      namespaceTools: true,
    });
  }
}

interface OpenRouterResponsesModelOptions {
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

interface DeclaredResponsesModelOptions {
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
