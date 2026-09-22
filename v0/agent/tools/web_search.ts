import { throwIfCancelled } from '../core/cancellation.ts';
import type { JsonValue } from '../core/contracts.ts';
import type { ToolExecutionContext } from '../core/execution_context.ts';
import type { CredentialSource } from '../provider/openrouter_model.ts';
import {
  createProviderRequestDispatcher,
  type ProviderRequestFn,
} from '../provider/auxiliary_request.ts';
import type { OpenRouterModelSelection } from '../provider/model_selection.ts';
import { PRODUCTION_PROFILE } from '../provider/provider_profile.ts';
import { type Tool, ToolInputError } from './tools.ts';

export const OPENROUTER_SONAR_SEARCH_MODEL = 'perplexity/sonar';

/** Sonar is a fixed auxiliary route, independent of the parent or planner selection. */
const SONAR_MODEL_SELECTION: OpenRouterModelSelection = Object.freeze({
  provider: 'openrouter-chat',
  api: 'openrouter-chat-completions',
  authProfile: 'openrouter-api-key',
  modelId: OPENROUTER_SONAR_SEARCH_MODEL,
  effort: 'auto',
});

const SONAR_GROUNDING_SYSTEM_MESSAGE =
  'Only answer using facts supported by the search results. If the results do not contain the answer, say so explicitly rather than guessing. If the results are related but do not match the question, state the mismatch before answering. Clearly distinguish verified facts from inference.';

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
  /** Worker-local credential-resolving request seam used by tool Definitions. */
  readonly requestProvider?: ProviderRequestFn;
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

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

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
    if (
      !isRecord(citation) || !nonBlank(citation.title) ||
      !nonBlank(citation.url)
    ) continue;
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
    if (options.credentialSource !== undefined) {
      return await options.credentialSource();
    }
    if (options.credential !== undefined) return options.credential;
    return Deno.env.get(PRODUCTION_PROFILE.secretEnv);
  } catch {
    return undefined;
  }
};

/** One non-streaming OpenRouter Sonar request for one Henji web_search call. */
export class OpenRouterSonarWebSearchBackend implements WebSearchBackend {
  private readonly requestProvider: ProviderRequestFn;

  constructor(
    private readonly options: OpenRouterSonarWebSearchBackendOptions = {},
  ) {
    this.requestProvider = options.requestProvider ??
      createProviderRequestDispatcher({
        resolveCredential: () => resolveCredential(options),
        fetcher: options.fetcher,
      });
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
    const body = JSON.stringify({
      model: OPENROUTER_SONAR_SEARCH_MODEL,
      messages: [
        { role: 'system', content: SONAR_GROUNDING_SYSTEM_MESSAGE },
        { role: 'user', content: query },
      ],
      stream: false,
      web_search_options: { search_context_size: 'medium' },
    });
    const contextRequestOrdinal = await context.modelExecution
      ?.observeAuxiliaryRequest?.({
        purpose: 'web_search',
        body,
        callId: context.callId ??
          (context.modelStep === undefined ? 'web-search' : `web-search-${context.modelStep}`),
        modelStep: context.modelStep ?? 1,
        modelSelection: SONAR_MODEL_SELECTION,
      });
    const endpoint = this.options.endpoint ??
      `${PRODUCTION_PROFILE.origin}${PRODUCTION_PROFILE.path}`;
    const evidence = context.modelExecution?.providerEvidence;
    evidence?.setContextRequestOrdinal(contextRequestOrdinal);
    try {
      const bodyBytes = new TextEncoder().encode(body);
      const requestMetadata = {
        contentType: 'application/json',
        redirect: 'error',
        responseMode: 'json',
        origin: 'web_search',
        provider: 'openrouter-chat',
        api: 'openrouter-chat-completions',
        modelId: OPENROUTER_SONAR_SEARCH_MODEL,
        effort: 'auto',
        authProfile: 'openrouter-api-key',
        protocol: 'json',
      } as const;
      const response = await this.requestProvider({
        authProfile: 'openrouter-api-key',
        endpoint,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyBytes,
        ...(context.modelExecution === undefined ? {} : {
          evidence: {
            execution: context.modelExecution,
            phase: 'user_turn',
            modelStep: context.modelStep ?? 1,
            requestMetadata,
            captureBoundary: 'openrouter-chat:auxiliary-http-body-v1',
            serializerVersion: 'json-stringify-utf8-v1',
          },
        }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const responseStatus = response.status;
      const responseHeaderMap = response.headers;
      const rawBytes = response.bytes;
      evidence?.recordResponse({
        status: responseStatus,
        headers: responseHeaderMap,
      });
      evidence?.appendResponseBytes(rawBytes);
      throwIfCancelled(context.signal);

      if (responseStatus < 200 || responseStatus >= 300) {
        evidence?.recordParserTransition({
          kind: 'failure',
          reason: 'http_error',
          field: 'status',
        });
        throw new Error(
          `web search provider request failed (${responseStatus})`,
        );
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
        throw new Error(
          'web search provider response had no answer with URL citations',
        );
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
    } finally {
      evidence?.setContextRequestOrdinal(undefined);
    }
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

const markdownSourceLink = (source: WebSearchSource): string =>
  `[${
    source.title.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(
      ']',
      '\\]',
    )
  }](<${source.url}>)`;

const inlineSourceLinks = (
  answer: string,
  sources: readonly WebSearchSource[],
): string =>
  answer.replace(/[ \t]*(?:\[\d+\])+/gu, (group, offset: number) => {
    const links = [...group.matchAll(/\[(\d+)\]/gu)].map((match) => {
      const source = sources[Number(match[1]) - 1];
      return source === undefined ? match[0] : markdownSourceLink(source);
    });
    return `${offset === 0 ? '' : ' '}${links.join(' ')}`;
  });

const formatResult = (result: WebSearchResult): string =>
  `Answer:\n${inlineSourceLinks(result.answer, result.sources)}\n\nSources:\n${
    result.sources.map((source) => `- ${markdownSourceLink(source)}`).join(
      '\n',
    )
  }`;

/** Model-callable Henji web search tool; provider details remain behind WebSearchBackend. */
export const createWebSearchTool = (backend: WebSearchBackend): Tool => ({
  name: 'web_search',
  description:
    'Search the public web for current or external information and return an answer with direct inline source links and an ordered source list.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  promptGuidelines: [
    'Choose the task source before exploring. If the user explicitly identifies the current repository, a local file, or a canonical URL or API, use that source first and do not add web search unless it leaves a current or external question unresolved. If current or external information is requested and the target identity or canonical source is not already established, use web_search as the first source-discovery tool; do not inspect the workspace, sibling repositories, handoff files, or try guessed endpoints with bash or curl merely because a software workspace exists. When external sources alone can answer the task, stay on that route. After discovery, obtain fast-changing lists or precise current values from the direct canonical source and disclose retrieval time or conflicts with search results. Put independent read-only retrievals in distinct tool calls in the same model step when their targets are already known; perform result-dependent retrievals and fallbacks sequentially. Pass a complete, specific research question that states the information needed; prefer this over a bare keyword or Boolean query. Treat the returned answer as sourced material: use its inline source links near supported claims in the final answer, never copy provider-local citation markers such as [1], and do not add factual details that the returned material does not support. Say explicitly when the sources do not answer the question, and label inference instead of presenting it as verified fact.',
  ],
  async execute(argumentsValue, context) {
    return formatResult(
      await backend.search(parseArguments(argumentsValue), context),
    );
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
