import { throwIfCancelled } from '../core/cancellation.ts';
import type { JsonObject, JsonValue } from '../core/contracts.ts';
import type { ToolExecutionContext } from '../core/execution_context.ts';
import type { CredentialSource } from '../provider/openrouter_model.ts';
import {
  createProviderRequestDispatcher,
  type ProviderRequestFn,
} from '../provider/auxiliary_request.ts';
import { createCredentialResolver } from '../provider/credential_resolver.ts';
import { EXA_SEARCH_INPUT_SCHEMA } from './exa_search_schema.ts';
import { type Tool, ToolInputError } from './tools.ts';

/** Search options follow the Exa Search request contract. */
export type WebSearchRequest = JsonObject & { readonly query: string };
export type WebSearchSource = JsonObject;
/** Preserve per-page content, metadata, and optional synthesized output independently. */
export type WebSearchResult = JsonObject & { readonly results: readonly WebSearchSource[] };

export interface WebSearchBackend {
  search(
    request: WebSearchRequest,
    context?: ToolExecutionContext,
  ): WebSearchResult | PromiseLike<WebSearchResult>;
}

export interface ExaWebSearchBackendOptions {
  readonly fetcher?: typeof fetch;
  /** Direct-test-only credential; production resolves the exa-api-key profile. */
  readonly credential?: string;
  readonly credentialSource?: CredentialSource;
  /** Direct-test-only endpoint override. */
  readonly endpoint?: string;
  /** Worker-local credential-resolving request seam used by tool Definitions. */
  readonly requestProvider?: ProviderRequestFn;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** One JSON Exa Search request for one Henji web_search call. */
export class ExaWebSearchBackend implements WebSearchBackend {
  private readonly requestProvider: ProviderRequestFn;

  constructor(private readonly options: ExaWebSearchBackendOptions = {}) {
    const credentials = createCredentialResolver();
    this.requestProvider = options.requestProvider ?? createProviderRequestDispatcher({
      resolveCredential: (profile) =>
        options.credentialSource !== undefined
          ? options.credentialSource()
          : options.credential ?? credentials.resolve(profile),
      fetcher: options.fetcher,
    });
  }

  async search(
    request: WebSearchRequest,
    context: ToolExecutionContext = {},
  ): Promise<WebSearchResult> {
    throwIfCancelled(context.signal);
    const evidence = context.modelExecution?.providerEvidence;
    // Search arguments/results belong to tool history, not the parent model's wire context.
    evidence?.setContextRequestOrdinal(undefined);
    const highlights = isRecord(request.contents) ? request.contents.highlights : undefined;
    const dynamicHighlights = isRecord(highlights) &&
      (highlights.dynamic !== undefined || highlights.verbosity !== undefined);
    const response = await this.requestProvider({
      authProfile: 'exa-api-key',
      endpoint: this.options.endpoint ?? 'https://api.exa.ai/search',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(dynamicHighlights ? { 'Exa-Beta': 'dynamic-highlights-2026-08-28' } : {}),
      },
      body: new TextEncoder().encode(JSON.stringify({
        type: 'auto',
        contents: { highlights: true },
        ...request,
        stream: false,
      })),
      ...(context.modelExecution === undefined ? {} : {
        evidence: {
          execution: context.modelExecution,
          phase: 'user_turn',
          modelStep: context.modelStep ?? 1,
          requestMetadata: {
            contentType: 'application/json',
            redirect: 'error',
            responseMode: 'json',
            origin: 'web_search',
            provider: 'exa',
            api: 'exa-search',
            authProfile: 'exa-api-key',
            protocol: 'json',
          },
        },
      }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    throwIfCancelled(context.signal);
    if (response.status < 200 || response.status >= 300) {
      evidence?.recordParserTransition({ kind: 'failure', reason: 'http_error', field: 'status' });
      throw new Error(`web search provider request failed (${response.status})`);
    }
    let rawText: string;
    try {
      rawText = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
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
    if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
      evidence?.recordParserTransition({
        kind: 'failure',
        reason: 'missing_results',
        field: 'results',
        expectedShape: 'array',
        actualShape: isRecord(parsed) ? typeof parsed.results : typeof parsed,
      });
      throw new Error('web search provider response had no results array');
    }
    return parsed as WebSearchResult;
  }
}

const parseArguments = (value: JsonValue): WebSearchRequest => {
  if (!isRecord(value) || !nonBlank(value.query)) {
    throw new ToolInputError('expected object with a non-empty query string');
  }
  return value as WebSearchRequest;
};

export const createWebSearchTool = (backend: WebSearchBackend): Tool => ({
  name: 'web_search',
  description:
    'Search the public web with Exa. Return ordered source URLs, titles, page text or highlights, metadata, and optional synthesized output. Defaults to auto search with highlights.',
  inputSchema: EXA_SEARCH_INPUT_SCHEMA,
  promptGuidelines: [
    'Choose the task source before exploring. If the user explicitly identifies the current repository, a local file, or a canonical URL or API, use that source first and do not add web search unless it leaves a current or external question unresolved. If current or external information is requested and the target identity or canonical source is not already established, use web_search as the first source-discovery tool; do not inspect the workspace, sibling repositories, handoff files, or try guessed endpoints with bash or curl merely because a software workspace exists. When external sources alone can answer the task, stay on that route. After discovery, obtain fast-changing lists or precise current values from the direct canonical source with web_fetch and disclose retrieval time or conflicts with search results. Put independent read-only retrievals in distinct tool calls in the same model step when their targets are already known; perform result-dependent retrievals sequentially. Give a specific query describing the information needed. Treat results[].text and results[].highlights as source material; summary and output are synthesized material. Cite direct source URLs near supported claims, do not copy provider-local citation numbers, and do not add facts unsupported by the returned material. Say when sources do not answer the question and label inference.',
    'Choose type and contents for the task. Use contents.text for full page text, highlights for relevant excerpts, and outputSchema for synthesized text or structured output. AdditionalQueries apply to deep search modes. Category accepts custom hints; company and people do not support published-date filters or excludeDomains. Dates use ISO 8601 and userLocation is a two-letter country code. Tool results are complete JSON; transport streaming is disabled. Dynamic highlights and verbosity automatically enable the documented Exa beta header.',
  ],
  async execute(argumentsValue, context) {
    return JSON.stringify(await backend.search(parseArguments(argumentsValue), context));
  },
});

export const createProviderFreeWebSearchBackend = (): WebSearchBackend => ({
  search: ({ query }) => ({
    results: [{
      title: 'Provider-free web search source',
      url: 'provider-free://web-search',
      highlights: [`provider-free web search result for: ${query}`],
    }],
  }),
});
