import { throwIfCancelled, TurnCancelledError } from './cancellation.ts';
import type { JsonValue } from './contracts.ts';
import type { ToolExecutionContext } from './execution_context.ts';
import type { CredentialSource } from './openrouter_model.ts';
import { PRODUCTION_PROFILE } from './provider_profile.ts';
import { type Tool, ToolInputError } from './tools.ts';

export const OPENROUTER_SONAR_SEARCH_MODEL = 'perplexity/sonar';

export interface WebSearchSource {
  readonly title: string;
  readonly url: string;
}

export interface WebSearchResult {
  readonly answer: string;
  readonly sources: readonly WebSearchSource[];
}

/** Provider-neutral search seam owned by the Henji tool component. */
export interface WebSearchBackend {
  search(
    query: string,
    context?: ToolExecutionContext,
  ): WebSearchResult | PromiseLike<WebSearchResult>;
}

export interface OpenRouterSonarWebSearchBackendOptions {
  readonly fetcher?: typeof fetch;
  /** Direct-test-only credential. Production supplies the existing credential source. */
  readonly credential?: string;
  readonly credentialSource?: CredentialSource;
  /** Direct-test-only endpoint override. */
  readonly endpoint?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const responseHeaders = (headers: Headers): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  headers.forEach((value, name) => {
    values[name] = value;
  });
  return values;
};

const parseSearchResult = (
  value: unknown,
): WebSearchResult | undefined => {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  const answer = choice.message.content;
  const annotations = choice.message.annotations;
  if (!nonBlank(answer) || !Array.isArray(annotations)) return undefined;
  const sources: WebSearchSource[] = [];
  for (const annotation of annotations) {
    if (!isRecord(annotation) || annotation.type !== 'url_citation') continue;
    const citation = annotation.url_citation;
    if (!isRecord(citation) || !nonBlank(citation.title) || !nonBlank(citation.url)) continue;
    sources.push(Object.freeze({ title: citation.title, url: citation.url }));
  }
  if (sources.length === 0) return undefined;
  return Object.freeze({
    answer,
    sources: Object.freeze(sources),
  });
};

const resolveCredential = async (
  options: OpenRouterSonarWebSearchBackendOptions,
): Promise<string | undefined> => {
  try {
    if (options.credentialSource !== undefined) return await options.credentialSource();
    if (options.credential !== undefined) return options.credential;
    return Deno.env.get(PRODUCTION_PROFILE.secretEnv);
  } catch {
    return undefined;
  }
};

/** One non-streaming OpenRouter Sonar request for one Henji web_search call. */
export class OpenRouterSonarWebSearchBackend implements WebSearchBackend {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenRouterSonarWebSearchBackendOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async search(
    query: string,
    context: ToolExecutionContext = {},
  ): Promise<WebSearchResult> {
    throwIfCancelled(context.signal);
    if (
      context.modelExecution !== undefined &&
      !context.modelExecution.claimModelRequest()
    ) {
      throw new Error('web search model request budget exhausted');
    }
    throwIfCancelled(context.signal);
    const credential = await resolveCredential(this.options);
    if (!credential) throw new Error('host provider credential is not configured');
    throwIfCancelled(context.signal);

    const body = JSON.stringify({
      model: OPENROUTER_SONAR_SEARCH_MODEL,
      messages: [{ role: 'user', content: query }],
      stream: false,
      web_search_options: { search_context_size: 'low' },
    });
    const endpoint = this.options.endpoint ??
      `${PRODUCTION_PROFILE.origin}${PRODUCTION_PROFILE.path}`;
    const evidence = context.modelExecution?.providerEvidence;
    evidence?.startRequest({
      lane: context.modelExecution?.lane === 'child' ? 'planner' : 'parent',
      phase: 'user_turn',
      modelStep: context.modelStep ?? 1,
      endpoint,
      method: 'POST',
      requestBody: body,
      requestMetadata: {
        contentType: 'application/json',
        redirect: 'error',
        responseMode: 'json',
      },
    });

    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        signal: context.signal,
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
        },
        body,
      });
    } catch {
      if (context.signal?.aborted) throw new TurnCancelledError();
      throw new Error('web search provider transport failed');
    }
    evidence?.recordResponse({
      status: response.status,
      headers: responseHeaders(response.headers),
    });

    let rawBytes: Uint8Array;
    try {
      rawBytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      if (context.signal?.aborted) throw new TurnCancelledError();
      throw new Error('web search provider response read failed');
    }
    evidence?.appendResponseBytes(rawBytes);
    throwIfCancelled(context.signal);

    if (!response.ok) {
      evidence?.recordParserTransition({
        kind: 'failure',
        reason: 'http_error',
        field: 'status',
      });
      throw new Error(`web search provider request failed (${response.status})`);
    }

    let rawText: string;
    try {
      rawText = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
    } catch {
      evidence?.recordParserTransition({
        kind: 'failure',
        reason: 'invalid_utf8',
        field: 'response.body',
      });
      throw new Error('web search provider response was not valid UTF-8');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      evidence?.recordParserTransition({
        kind: 'failure',
        reason: 'invalid_json',
        field: 'response.body',
      });
      throw new Error('web search provider response was not valid JSON');
    }
    evidence?.recordParserTransition({
      kind: 'event',
      reason: 'json_response',
      ...(isJsonValue(parsed) ? { detail: parsed } : {}),
    });
    const result = parseSearchResult(parsed);
    if (result === undefined) {
      evidence?.recordParserTransition({
        kind: 'failure',
        reason: 'missing_answer_or_url_citations',
        field: 'choices[0].message',
        ...(isJsonValue(parsed) ? { detail: parsed } : {}),
      });
      throw new Error('web search provider response had no answer with URL citations');
    }
    evidence?.recordParserTransition({
      kind: 'terminal',
      reason: 'answer_with_url_citations',
    });
    evidence?.recordParserTransition({
      kind: 'result',
      reason: 'web_search_result',
    });
    return result;
  }
}

const parseArguments = (value: JsonValue): string => {
  if (!isRecord(value)) throw new ToolInputError('expected object');
  const names = Object.keys(value);
  if (names.length !== 1 || names[0] !== 'query' || !nonBlank(value.query)) {
    throw new ToolInputError('expected one non-empty string field: query');
  }
  return value.query;
};

const formatResult = (result: WebSearchResult): string =>
  `Answer:\n${result.answer}\n\nSources:\n${
    result.sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.url}`).join(
      '\n',
    )
  }`;

/** Model-callable Henji web search tool; provider details remain behind WebSearchBackend. */
export const createWebSearchTool = (backend: WebSearchBackend): Tool => ({
  name: 'web_search',
  description:
    'Search the public web for current or external information and return an answer with ordered source URLs.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  promptGuidelines: [
    'Use web_search when current or external information is needed. Cite the returned source URLs in the final answer.',
  ],
  async execute(argumentsValue, context) {
    return formatResult(await backend.search(parseArguments(argumentsValue), context));
  },
});

/** Network-free backend used by the provider-free Worker composition. */
export const createProviderFreeWebSearchBackend = (): WebSearchBackend => ({
  search: (query) => ({
    answer: `provider-free web search result for: ${query}`,
    sources: [{
      title: 'Provider-free web search source',
      url: 'provider-free://web-search',
    }],
  }),
});
