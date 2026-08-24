import { type Failure, failure, type Plan } from './domain.ts';
import { parsePlan } from './domain.ts';

export const PROFILE = {
  id: 'openrouter-google-gemini-3.7-flash-vertex-v0',
  model: 'google/gemini-3.7-flash',
  origin: 'https://openrouter.ai',
  path: '/api/v1/chat/completions',
  method: 'POST',
  secretEnv: 'HENJI_OPENROUTER_API_KEY',
  maxCompletionTokens: 1024,
  stream: false,
  requestLimit: 1,
  retry: 0,
  maxUsd: 0.064,
  // 76 KiB of serialized messages (77,824 input tokens as a conservative
  // upper bound) plus 1,024 completion tokens at the current default price ceiling.
  worstCaseUsd: 0.062208,
} as const;

export interface ModelMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
}
export type ModelGenerate = (
  request: ModelRequest,
  signal?: AbortSignal,
) => Promise<{ text: string; profile: string } | Failure>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const validateProfileBudget = (approvedMaxUsd: number): Failure | undefined => {
  if (
    !Number.isFinite(approvedMaxUsd) || approvedMaxUsd < PROFILE.worstCaseUsd ||
    approvedMaxUsd > PROFILE.maxUsd
  ) {
    return failure(
      'limit_exceeded',
      `authorized budget is below the profile worst-case bound (${PROFILE.worstCaseUsd})`,
    );
  }
  return undefined;
};

export const validateModelRequest = (request: ModelRequest): Failure | undefined => {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return failure('invalid_input', 'model messages are required');
  }
  const bytes = encoder.encode(JSON.stringify(request.messages)).byteLength;
  if (bytes > 76 * 1024) {
    return failure('limit_exceeded', 'serialized model messages exceed 76 KiB');
  }
  for (const message of request.messages) {
    if (
      (message.role !== 'system' && message.role !== 'user') || typeof message.content !== 'string'
    ) return failure('invalid_input', 'model message is invalid');
  }
  return undefined;
};

export const fixtureModel = (revision = 'fixture'): ModelGenerate => (request) => {
  const invalid = validateModelRequest(request);
  if (invalid) return Promise.resolve(invalid);
  const task = request.messages.find((message) => message.role === 'user')?.content.slice(0, 256) ??
    'task';
  const plan: Plan = {
    title: `Plan for ${task}`,
    summary: 'Fixture model response for offline validation.',
    steps: [{ id: 'step-1', description: 'Review the task and constraints.' }, {
      id: 'step-2',
      description: 'Perform the smallest reversible next action.',
    }],
    risks: ['Fixture output is not a provider observation.'],
  };
  return Promise.resolve({ text: JSON.stringify(plan), profile: `fixture-${revision}` });
};

const safeProviderFailure = (status: number, code = 'provider_error'): Failure =>
  failure('model_error', `provider request failed (${status})`, { providerCode: code, status });

const withRequestCount = (result: Failure, requestCount: 0 | 1): Failure =>
  failure(result.code, result.message, { ...(result.details ?? {}), requestCount });

interface ProviderRequestOptions {
  readonly approvedMaxUsd?: number;
  readonly fetcher: typeof fetch;
  readonly endpoint: string;
  readonly credential?: string;
  readonly parentSignal?: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * The current direct provider transport. Both legacy acceptance and basic use
 * this primitive so their request, credential, and finite-limit behavior stays
 * identical; only the legacy budget preflight is optional.
 */
const requestCurrentProvider = async (
  request: ModelRequest,
  options: ProviderRequestOptions,
): Promise<{ text: string; profile: string } | Failure> => {
  const invalid = validateModelRequest(request);
  if (invalid) return withRequestCount(invalid, 0);
  if (options.approvedMaxUsd !== undefined) {
    const budgetFailure = validateProfileBudget(options.approvedMaxUsd);
    if (budgetFailure) return withRequestCount(budgetFailure, 0);
  }
  // The composition root supplies no credential for fixture runs. Production
  // acceptance leaves this argument unset so only the host reads the exact
  // allowlisted environment name; tests can inject a non-secret dummy value.
  const key = options.credential ?? Deno.env.get(PROFILE.secretEnv);
  if (!key) {
    return withRequestCount(
      failure('model_error', 'host provider credential is not configured'),
      0,
    );
  }
  const body = JSON.stringify({
    model: PROFILE.model,
    messages: request.messages,
    stream: false,
    max_completion_tokens: 1024,
  });
  if (encoder.encode(body).byteLength > 256 * 1024) {
    return withRequestCount(
      failure('limit_exceeded', 'provider request exceeds 256 KiB'),
      0,
    );
  }
  if (options.parentSignal?.aborted) {
    return withRequestCount(failure('model_error', 'provider transport failed'), 0);
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.parentSignal?.reason);
  options.parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort('provider deadline exceeded'), options.timeoutMs);
  let requestStarted = false;
  const counted = (result: Failure): Failure => withRequestCount(result, requestStarted ? 1 : 0);
  try {
    let response: Response;
    try {
      requestStarted = true;
      response = await options.fetcher(options.endpoint, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body,
      });
    } catch {
      return counted(failure('model_error', 'provider transport failed'));
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch { /* best effort drain */ }
      return counted(safeProviderFailure(response.status));
    }
    let payload: unknown;
    try {
      const text = await readBoundedResponse(response);
      if (typeof text !== 'string') return counted(text);
      payload = JSON.parse(text);
    } catch {
      return counted(failure('model_error', 'provider response was invalid'));
    }
    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices
      ?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      return counted(failure('model_error', 'provider response had no text'));
    }
    return { text: content, profile: PROFILE.id };
  } finally {
    // The deadline remains armed through headers and bounded body read. It is
    // cleared only after all response processing and reader cleanup completes.
    clearTimeout(timer);
    options.parentSignal?.removeEventListener('abort', abortFromParent);
  }
};

export const openRouterModel = (
  request: ModelRequest,
  approvedMaxUsd: number = PROFILE.maxUsd,
  fetcher: typeof fetch = fetch,
  endpoint = `${PROFILE.origin}${PROFILE.path}`,
  credential?: string,
  parentSignal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<{ text: string; profile: string } | Failure> =>
  requestCurrentProvider(request, {
    approvedMaxUsd,
    fetcher,
    endpoint,
    credential,
    parentSignal,
    timeoutMs,
  });

/** Basic one-request provider entry with no budget, attempt, or state input. */
export const basicOpenRouterModel = (
  request: ModelRequest,
  fetcher: typeof fetch = fetch,
  endpoint = `${PROFILE.origin}${PROFILE.path}`,
  credential?: string,
  parentSignal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<{ text: string; profile: string } | Failure> =>
  requestCurrentProvider(request, { fetcher, endpoint, credential, parentSignal, timeoutMs });

/** Main's narrow seam: no caller-controlled provider, credential, or budget. */
export const basicModel: ModelGenerate = (request, signal) =>
  basicOpenRouterModel(request, fetch, undefined, undefined, signal);

/** Read at most the configured response bound and cancel the stream on overflow. */
export const readBoundedResponse = async (
  response: Response,
  limit = 1024 * 1024,
): Promise<string | Failure> => {
  if (!response.body) return failure('model_error', 'provider response had no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) {
        try {
          await reader.cancel('response limit exceeded');
        } catch { /* best effort cancellation */ }
        return failure('limit_exceeded', 'provider response exceeds 1 MiB');
      }
      chunks.push(item.value);
    }
  } catch {
    return failure('model_error', 'provider response stream failed');
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(body);
};

export const parseModelPlan = (text: string): Plan | Failure => {
  if (encoder.encode(text).byteLength > 64 * 1024) {
    return failure('limit_exceeded', 'model output exceeds Plan limit');
  }
  try {
    return parsePlan(JSON.parse(text));
  } catch {
    return failure('invalid_input', 'model output was not valid Plan JSON');
  }
};
