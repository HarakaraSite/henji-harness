import { PRODUCTION_PROFILE } from './provider_profile.ts';
import type { Model, ModelGenerateOptions, ModelRequest, ModelResult } from '../core/contracts.ts';
import {
  CancellationCleanupError,
  throwIfCancelled,
  TurnCancelledError,
} from '../core/cancellation.ts';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  OpenRouterAgentError,
  type OpenRouterAgentModelOptions,
  type OpenRouterAgentProfile,
} from './openrouter_contract.ts';
import {
  encodeRequest,
  invalidRequestError,
  measureModelRequestWire,
} from './openrouter_request.ts';
import {
  cancelResponseBody,
  decodeResponse,
  providerTimeoutError,
  readResponseBody,
  responseStreamError,
  sseResponseError,
  withResponseStatus,
} from './openrouter_response.ts';
import { readSseResponse } from './openrouter_sse.ts';
import { bytes, safeJson } from './openrouter_value.ts';
import { substituteRequestHeaders, usesCredentialHeader } from './provider_request_headers.ts';

const valueShape = (value: unknown): string =>
  value === undefined
    ? 'absent'
    : value === null
    ? 'null'
    : Array.isArray(value)
    ? `array(length=${value.length})`
    : typeof value === 'string'
    ? `string(length=${value.length})`
    : typeof value;

const responseShapeFailure = (payload: unknown): {
  readonly field: string;
  readonly expectedShape: string;
  readonly actualShape: string;
} => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { field: 'response', expectedShape: 'object', actualShape: valueShape(payload) };
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    return {
      field: 'response.choices',
      expectedShape: 'array(length=1)',
      actualShape: valueShape(choices),
    };
  }
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
    return {
      field: 'response.choices[0]',
      expectedShape: 'object',
      actualShape: valueShape(choice),
    };
  }
  const message = (choice as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return {
      field: 'response.choices[0].message',
      expectedShape: 'object',
      actualShape: valueShape(message),
    };
  }
  const role = (message as Record<string, unknown>).role;
  if (role !== 'assistant') {
    return {
      field: 'response.choices[0].message.role',
      expectedShape: 'assistant',
      actualShape: valueShape(role),
    };
  }
  const content = (message as Record<string, unknown>).content;
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  if (toolCalls !== undefined && toolCalls !== null) {
    const base = 'response.choices[0].message.tool_calls';
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return { field: base, expectedShape: 'nonempty array', actualShape: valueShape(toolCalls) };
    }
    for (let index = 0; index < toolCalls.length; index++) {
      const call = toolCalls[index];
      const path = `${base}[${index}]`;
      if (typeof call !== 'object' || call === null || Array.isArray(call)) {
        return { field: path, expectedShape: 'object', actualShape: valueShape(call) };
      }
      const item = call as Record<string, unknown>;
      if (typeof item.id !== 'string' || item.id.trim().length === 0) {
        return {
          field: `${path}.id`,
          expectedShape: 'nonempty string',
          actualShape: valueShape(item.id),
        };
      }
      if (item.type !== 'function') {
        return {
          field: `${path}.type`,
          expectedShape: 'function',
          actualShape: valueShape(item.type),
        };
      }
      if (
        typeof item.function !== 'object' || item.function === null || Array.isArray(item.function)
      ) {
        return {
          field: `${path}.function`,
          expectedShape: 'object',
          actualShape: valueShape(item.function),
        };
      }
      const functionItem = item.function as Record<string, unknown>;
      if (typeof functionItem.name !== 'string' || functionItem.name.trim().length === 0) {
        return {
          field: `${path}.function.name`,
          expectedShape: 'nonempty string',
          actualShape: valueShape(functionItem.name),
        };
      }
      if (typeof functionItem.arguments !== 'string') {
        return {
          field: `${path}.function.arguments`,
          expectedShape: 'JSON string',
          actualShape: valueShape(functionItem.arguments),
        };
      }
      try {
        JSON.parse(functionItem.arguments);
      } catch {
        return {
          field: `${path}.function.arguments`,
          expectedShape: 'valid JSON string',
          actualShape: `string(length=${functionItem.arguments.length},invalid_json)`,
        };
      }
    }
    return {
      field: base,
      expectedShape: 'supported tool call array',
      actualShape: valueShape(toolCalls),
    };
  }
  return {
    field: 'response.choices[0].message.content',
    expectedShape: 'nonempty string',
    actualShape: valueShape(content),
  };
};

/** Merge adapter-owned base headers with non-secret declared headers. */
const buildChatHeaders = (
  profile: OpenRouterAgentProfile,
  credential: string,
  sessionId: string | undefined,
): Readonly<Record<string, string>> => {
  const declared = profile.requestHeaders;
  const base: Record<string, string> = { 'content-type': 'application/json' };
  if (!usesCredentialHeader(declared)) base.authorization = `Bearer ${credential}`;
  return { ...base, ...substituteRequestHeaders(declared, { credential, sessionId }) };
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

const OPENROUTER_HTTP_5XX_RETRY_DELAYS_MS = [500, 750] as const;

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const withRequestCount = (
  error: OpenRouterAgentError,
  requestCount: number,
): OpenRouterAgentError => {
  const fact = error.failureFact;
  return new OpenRouterAgentError(
    error.code,
    error.message,
    requestCount,
    error.status,
    {
      stage: fact.stage,
      code: fact.code,
      retryCount: Math.max(0, requestCount - 1),
      ...(fact.httpStatus === undefined ? {} : { httpStatus: fact.httpStatus }),
      ...(fact.parseReason === undefined ? {} : { parseReason: fact.parseReason }),
      ...(fact.field === undefined ? {} : { field: fact.field }),
      ...(fact.expectedShape === undefined ? {} : { expectedShape: fact.expectedShape }),
      ...(fact.actualShape === undefined ? {} : { actualShape: fact.actualShape }),
    },
  );
};

/** Additive offline-composable adapter for the existing provider-neutral Model contract. */
export class OpenRouterAgentModel implements Model {
  readonly measureRequestWire: Model['measureRequestWire'];
  private readonly fetcher: typeof fetch;
  private readonly options: OpenRouterAgentModelOptions;
  private readonly profile: OpenRouterAgentProfile;

  constructor(options: OpenRouterAgentModelOptions = {}) {
    this.options = options;
    this.fetcher = options.fetcher ?? fetch;
    this.profile = options.profile ?? PRODUCTION_PROFILE;
    this.measureRequestWire = (request) =>
      measureModelRequestWire(
        request,
        this.profile,
        this.options.responseMode ?? 'sse',
        this.options.evidenceIdentity?.provider ?? 'openrouter-chat',
      );
  }

  async generate(
    request: ModelRequest,
    generateOptions: ModelGenerateOptions = {},
  ): Promise<ModelResult> {
    const encoded = encodeRequest(
      request,
      true,
      this.options.evidenceIdentity?.provider ?? 'openrouter-chat',
      this.profile.model,
    );
    const body = safeJson({
      model: this.profile.model,
      messages: encoded.messages,
      tools: encoded.tools,
      stream: this.options.responseMode === 'sse' ? true : this.profile.stream,
      max_completion_tokens: this.profile.maxCompletionTokens,
      ...(this.profile.reasoningEffort === undefined
        ? {}
        : this.profile.reasoningEffortField === 'reasoning_effort'
        ? { reasoning_effort: this.profile.reasoningEffort }
        : { reasoning: { effort: this.profile.reasoningEffort } }),
    });
    if (body === undefined) {
      throw invalidRequestError('provider request is not JSON serializable');
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
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    const startedAt = Date.now();
    // A continuous stream keeps the reader in microtasks, which starves this macrotask timer.
    // Both the timer and the stream reader use the same abort path.
    const abortDeadline = (): void => {
      if (timedOut) return;
      timedOut = true;
      controller.abort('provider deadline exceeded');
    };
    const deadlineExceeded = (): boolean => {
      if (Date.now() - startedAt >= timeoutMs) abortDeadline();
      return timedOut;
    };
    const timer = setTimeout(abortDeadline, timeoutMs);
    const endpoint = this.options.endpoint ??
      `${this.profile.origin}${this.profile.path}`;
    const evidence = generateOptions.providerEvidence;
    const lane = generateOptions.providerEvidenceLane ?? 'parent';
    const phase = generateOptions.providerEvidencePhase ?? 'user_turn';
    const modelStep = generateOptions.modelStep ?? 1;
    const requestMetadata = {
      contentType: 'application/json',
      redirect: 'error',
      responseMode: this.options.responseMode ?? 'json',
      origin: generateOptions.providerEvidencePhase === 'compaction'
        ? 'context_compaction'
        : generateOptions.providerEvidenceLane === 'planner'
        ? 'planner_model'
        : 'root_model',
      provider: this.options.evidenceIdentity?.provider ?? 'openrouter-chat',
      api: this.options.evidenceIdentity?.api ?? 'openrouter-chat-completions',
      modelId: this.profile.model,
      effort: this.profile.reasoningEffort ?? 'auto',
      authProfile: this.options.evidenceIdentity?.authProfile ?? 'openrouter-api-key',
      protocol: this.options.responseMode === 'sse' ? 'sse' : 'json',
    } as const;
    // Resolve declared headers before the request loop so a missing session id is a request-build
    // failure, not a transport failure.
    const requestHeaders = buildChatHeaders(this.profile, credential, this.options.sessionId);
    let requestCount = 0;
    try {
      let response: Response;
      while (true) {
        if (turnCancelled) throw new TurnCancelledError();
        if (timedOut) throw providerTimeoutError();
        const evidenceRequest = {
          lane,
          phase,
          modelStep,
          endpoint,
          method: this.profile.method,
          requestMetadata,
        } as const;
        evidence?.startRequestMetadata(evidenceRequest);
        requestCount += 1;
        try {
          response = await this.fetcher(endpoint, {
            method: this.profile.method,
            signal: controller.signal,
            redirect: 'error',
            headers: requestHeaders,
            body,
          });
        } catch {
          if (turnCancelled) throw new TurnCancelledError();
          if (timedOut) throw providerTimeoutError();
          throw new OpenRouterAgentError(
            'transport_error',
            'provider transport failed',
            requestCount,
            undefined,
            { stage: 'transport', code: 'transport_error' },
          );
        }
        evidence?.recordResponse({ status: response.status });
        // A response owns a body as soon as fetch resolves. Even when cancellation or timeout won
        // during fetch, settle that body before classifying the request outcome.
        if (turnCancelled || timedOut || controller.signal.aborted) {
          const settled = await cancelResponseBody(response);
          if (!settled && turnCancelled) {
            throw new CancellationCleanupError();
          }
          if (turnCancelled) throw new TurnCancelledError();
          if (timedOut) throw providerTimeoutError();
          throw new OpenRouterAgentError(
            'transport_error',
            'provider transport failed',
            requestCount,
            undefined,
            { stage: 'transport', code: 'transport_error' },
          );
        }
        if (response.ok) break;

        const bounded = await readResponseBody(response);
        if (bounded.cleanupFailed) {
          if (turnCancelled) throw new CancellationCleanupError();
          if (timedOut) throw providerTimeoutError();
          throw new OpenRouterAgentError(
            'transport_error',
            'provider transport failed',
            requestCount,
            undefined,
            { stage: 'transport', code: 'transport_error' },
          );
        }
        if (turnCancelled) throw new TurnCancelledError();
        if (timedOut) {
          throw providerTimeoutError();
        }
        const retryDelay = OPENROUTER_HTTP_5XX_RETRY_DELAYS_MS[requestCount - 1];
        if (response.status >= 500 && response.status <= 599 && retryDelay !== undefined) {
          try {
            await waitForRetry(retryDelay, controller.signal);
          } catch {
            if (turnCancelled) throw new TurnCancelledError();
            if (timedOut) throw providerTimeoutError();
            throw new OpenRouterAgentError(
              'transport_error',
              'provider transport failed',
              requestCount,
              undefined,
              { stage: 'transport', code: 'transport_error' },
            );
          }
          continue;
        }
        throw new OpenRouterAgentError(
          'http_error',
          `provider request failed (${response.status})`,
          requestCount,
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
          const bounded = await readResponseBody(response);
          if (bounded.cleanupFailed) {
            if (turnCancelled) throw new CancellationCleanupError();
            if (timedOut) throw providerTimeoutError();
            throw responseStreamError(response.status);
          }
          if (turnCancelled) throw new TurnCancelledError();
          if (timedOut) throw providerTimeoutError();
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
          deadlineExceeded,
          this.options.testTextAccountingObserver,
          evidence,
          this.options.evidenceIdentity?.provider ?? 'openrouter-chat',
          this.profile.model,
          generateOptions.reportThinkingDelta,
        );
        if (turnCancelled) throw new TurnCancelledError();
        if (timedOut || controller.signal.aborted) {
          if (timedOut) throw providerTimeoutError();
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
      const bounded = await readResponseBody(response);
      if (bounded.cleanupFailed) {
        if (turnCancelled) throw new CancellationCleanupError();
        if (timedOut) throw providerTimeoutError();
        throw responseStreamError(response.status);
      }
      if (turnCancelled) throw new TurnCancelledError();
      if (timedOut) {
        throw providerTimeoutError();
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
        const decoded = decodeResponse(
          payload,
          this.options.evidenceIdentity?.provider ?? 'openrouter-chat',
          this.profile.model,
        );
        return decoded;
      } catch (error) {
        if (error instanceof OpenRouterAgentError) {
          evidence?.recordParserTransition({
            kind: 'failure',
            reason: error.failureFact.parseReason ?? error.code,
            ...responseShapeFailure(payload),
          });
        }
        if (error instanceof OpenRouterAgentError) {
          throw withResponseStatus(error, response.status);
        }
        throw error;
      }
    } catch (error) {
      const settled = error instanceof OpenRouterAgentError && requestCount > 0 &&
          (error.requestCount !== requestCount ||
            error.failureFact.retryCount !== Math.max(0, requestCount - 1))
        ? withRequestCount(error, requestCount)
        : error;
      if (settled instanceof OpenRouterAgentError && requestCount > 0) {
        evidence?.recordRequestFailure({
          stage: settled.failureFact.stage,
          code: settled.failureFact.code,
          ...(settled.failureFact.httpStatus === undefined ? {} : {
            httpStatus: settled.failureFact.httpStatus,
          }),
          ...(settled.failureFact.parseReason === undefined ? {} : {
            parseReason: settled.failureFact.parseReason,
          }),
        }, modelStep);
      }
      throw settled;
    } finally {
      clearTimeout(timer);
      turnSignal?.removeEventListener('abort', abortFromTurn);
    }
  }
}

export const createOpenRouterAgentModel = (
  options: OpenRouterAgentModelOptions = {},
): Model => new OpenRouterAgentModel(options);
