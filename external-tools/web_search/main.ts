import {
  type JsonValue,
  type ProviderRequestFn,
  throwIfCancelled,
  type Tool,
  type ToolContext,
  type ToolFactoryInput,
  ToolInputError,
} from '@henji/tool';
import { EXA_SEARCH_INPUT_SCHEMA } from './exa_search_schema.ts';

/** Search options follow the Exa Search request contract. */
type WebSearchRequest = { readonly [key: string]: JsonValue; readonly query: string };
type WebSearchSource = { readonly [key: string]: JsonValue };
type WebSearchResult = {
  readonly [key: string]: JsonValue;
  readonly results: readonly WebSearchSource[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const parseArguments = (value: JsonValue): WebSearchRequest => {
  if (!isRecord(value) || !nonBlank(value.query)) {
    throw new ToolInputError('expected object with a non-empty query string');
  }
  return value as WebSearchRequest;
};

const createWebSearchTool = (requestProvider: ProviderRequestFn): Tool => ({
  name: 'web_search',
  description:
    'Search the public web with Exa. Return ordered source URLs, titles, page text or highlights, metadata, and optional synthesized output. Defaults to auto search with highlights.',
  inputSchema: EXA_SEARCH_INPUT_SCHEMA,
  promptGuidelines: [
    'Choose the task source before exploring. If the user explicitly identifies the current repository, a local file, or a canonical URL or API, use that source first and do not add web search unless it leaves a current or external question unresolved. If current or external information is requested and the target identity or canonical source is not already established, use web_search as the first source-discovery tool; do not inspect the workspace, sibling repositories, handoff files, or try guessed endpoints with bash or curl merely because a software workspace exists. When external sources alone can answer the task, stay on that route. After discovery, obtain fast-changing lists or precise current values from the direct canonical source with web_fetch and disclose retrieval time or conflicts with search results. Put independent read-only retrievals in distinct tool calls in the same model step when their targets are already known; perform result-dependent retrievals sequentially. Give a specific query describing the information needed. Treat results[].text and results[].highlights as source material; summary and output are synthesized material. Cite direct source URLs near supported claims, do not copy provider-local citation numbers, and do not add facts unsupported by the returned material. Say when sources do not answer the question and label inference.',
    'Choose type and contents for the task. Use contents.text for full page text, highlights for relevant excerpts, and outputSchema for synthesized text or structured output. AdditionalQueries apply to deep search modes. Category accepts custom hints; company and people do not support published-date filters or excludeDomains. Dates use ISO 8601 and userLocation is a two-letter country code. Tool results are complete JSON; transport streaming is disabled. Dynamic highlights and verbosity automatically enable the documented Exa beta header.',
  ],
  async execute(argumentsValue: JsonValue, context?: ToolContext): Promise<string> {
    const request = parseArguments(argumentsValue);
    throwIfCancelled(context?.signal);
    const modelExecution = context === undefined
      ? undefined
      : 'modelExecution' in context
      ? context.modelExecution
      : 'claimModelRequest' in context
      ? context
      : undefined;
    const evidence = modelExecution?.providerEvidence;
    // Search arguments/results belong to tool history, not the parent model's wire context.
    evidence?.setContextRequestOrdinal(undefined);
    const highlights = isRecord(request.contents) ? request.contents.highlights : undefined;
    const dynamicHighlights = isRecord(highlights) &&
      (highlights.dynamic !== undefined || highlights.verbosity !== undefined);
    const response = await requestProvider({
      authProfile: 'exa-api-key',
      endpoint: 'https://api.exa.ai/search',
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
      ...(modelExecution === undefined ? {} : {
        evidence: {
          execution: modelExecution,
          phase: 'user_turn',
          modelStep: context && 'modelStep' in context ? context.modelStep ?? 1 : 1,
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
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    });
    throwIfCancelled(context?.signal);
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
    return JSON.stringify(parsed as WebSearchResult);
  },
});

/** Build one Worker-local search Tool using the shared credential-aware request dispatcher. */
export default (input: ToolFactoryInput): Tool => {
  if (input.requestProvider === undefined) {
    throw new Error('web search request seam is unavailable');
  }
  return createWebSearchTool(input.requestProvider);
};
