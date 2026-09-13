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
  responseHeaders,
  responseStreamError,
  sseResponseError,
  withResponseStatus,
} from './openrouter_response.ts';
import { readSseResponse } from './openrouter_sse.ts';
import { bytes, isJsonValue, safeJson } from './openrouter_value.ts';

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
    },
  );
};

/** Additive offline-composable adapter for the existing provider-neutral Model contract. */
export class OpenRouterAgentModel implements Model {
  readonly measureRequestWire = measureModelRequestWire;
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
      ...(this.profile.reasoningEffort === undefined
        ? {}
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
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('provider deadline exceeded');
    }, timeoutMs);
    const endpoint = this.options.endpoint ??
      `${this.profile.origin}${this.profile.path}`;
    const evidence = generateOptions.providerEvidence;
    let requestCount = 0;
    try {
      let response: Response;
      while (true) {
        if (turnCancelled) throw new TurnCancelledError();
        if (timedOut) throw providerTimeoutError();
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
            origin: generateOptions.providerEvidencePhase === 'compaction'
              ? 'context_compaction'
              : generateOptions.providerEvidenceLane === 'planner'
              ? 'planner_model'
              : 'root_model',
            provider: 'openrouter',
            api: 'openrouter-chat-completions',
            modelId: this.profile.model,
            effort: this.profile.reasoningEffort ?? 'auto',
            authProfile: 'openrouter-api-key',
            protocol: this.options.responseMode === 'sse' ? 'sse' : 'json',
          },
        });
        requestCount += 1;
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
          if (timedOut) throw providerTimeoutError();
          throw new OpenRouterAgentError(
            'transport_error',
            'provider transport failed',
            requestCount,
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

        const bounded = await readResponseBody(
          response,
          (value) => evidence?.appendResponseBytes(value),
        );
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
          const bounded = await readResponseBody(
            response,
            (value) => evidence?.appendResponseBytes(value),
          );
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
          () => timedOut,
          this.options.testTextAccountingObserver,
          evidence,
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
      const bounded = await readResponseBody(
        response,
        (value) => evidence?.appendResponseBytes(value),
      );
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
    } catch (error) {
      if (
        error instanceof OpenRouterAgentError && requestCount > 0 &&
        (error.requestCount !== requestCount ||
          error.failureFact.retryCount !== Math.max(0, requestCount - 1))
      ) {
        throw withRequestCount(error, requestCount);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      turnSignal?.removeEventListener('abort', abortFromTurn);
    }
  }
}

export const createOpenRouterAgentModel = (
  options: OpenRouterAgentModelOptions = {},
): Model => new OpenRouterAgentModel(options);
