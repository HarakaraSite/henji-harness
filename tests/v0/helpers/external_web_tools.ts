import {
  type JsonValue,
  type ProviderRequestFn,
  type Tool,
  type ToolContext,
  type ToolFactoryInput,
} from '@henji/tool';
import { createProviderRequestDispatcher } from '../../../v0/agent/provider/auxiliary_request.ts';
import { ParentTurnExecutionContext } from '../../../v0/agent/core/execution_context.ts';
import type { ProviderEvidenceRecorder } from '../../../v0/agent/provider/provider_evidence.ts';
import type { WorkerStageName } from '../../../v0/agent/worker/worker_stage_probe.ts';
import webSearchFactory from '../../../external-tools/web_search/main.ts';
import { createWebFetchTool, MAX_WEB_FETCH_BYTES } from '../../../external-tools/web_fetch/main.ts';

export type WebSearchRequest = { readonly [key: string]: JsonValue; readonly query: string };
export type WebSearchSource = { readonly [key: string]: JsonValue };
export type WebSearchResult = {
  readonly [key: string]: JsonValue;
  readonly results: readonly WebSearchSource[];
};

export interface WebSearchBackend {
  search(
    request: WebSearchRequest,
    context?: ToolContext,
  ): WebSearchResult | PromiseLike<WebSearchResult>;
}

export const createProviderFreeWebSearchBackend = (): WebSearchBackend => ({
  search: ({ query }) => ({
    results: [{
      title: 'test source',
      url: 'provider-free://web-search',
      highlights: [`search result for ${query}`],
    }],
  }),
});

export const createWebSearchToolWithProvider = (requestProvider: ProviderRequestFn): Tool =>
  webSearchFactory({ requestProvider } as unknown as ToolFactoryInput);

/** Adapter for focused tests that want a deterministic result without HTTP dispatch. */
export const createWebSearchTool = (backend: WebSearchBackend): Tool =>
  createWebSearchToolWithProvider(async (request) => {
    const argumentsValue = JSON.parse(new TextDecoder().decode(request.body)) as WebSearchRequest;
    const evidence = request.evidence as {
      readonly providerEvidence: ProviderEvidenceRecorder;
      readonly modelStep: number;
      readonly reportAuxiliaryStage?: (stage: WorkerStageName) => void;
    } | undefined;
    const modelExecution = evidence === undefined ? undefined : new ParentTurnExecutionContext(
      1,
      undefined,
      request.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      evidence.providerEvidence,
      undefined,
      undefined,
      undefined,
      evidence.reportAuxiliaryStage,
    );
    const context: ToolContext = {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(evidence === undefined ? {} : {
        modelExecution,
        modelStep: evidence.modelStep,
      }),
    };
    const result = await backend.search(argumentsValue, context);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bytes: new TextEncoder().encode(JSON.stringify(result)),
    };
  });

/** Credential dispatch hooks belong to tests; production tools receive requestProvider from Worker. */
export const createExaTestRequestProvider = (options: {
  readonly fetcher?: typeof fetch;
  readonly credential?: string;
  readonly credentialSource?: () => string | undefined | PromiseLike<string | undefined>;
  readonly endpoint?: string;
} = {}): ProviderRequestFn => {
  const dispatch = createProviderRequestDispatcher({
    resolveCredential: (profile) =>
      profile === 'exa-api-key'
        ? options.credentialSource?.() ?? options.credential ?? 'test-exa-credential'
        : undefined,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  return (request) =>
    dispatch({
      ...request,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    });
};

export { createWebFetchTool, MAX_WEB_FETCH_BYTES };

/** Bind repository external folders in isolated config roots while preserving other tool entries. */
export const activateRepositoryExternalToolBindings = async (
  configRoot: string,
): Promise<void> => {
  const bindingsFile = `${configRoot}/tools.json`;
  let tools: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await Deno.readTextFile(bindingsFile));
    if (
      typeof value === 'object' && value !== null && !Array.isArray(value) &&
      'tools' in value && typeof value.tools === 'object' && value.tools !== null &&
      !Array.isArray(value.tools)
    ) {
      tools = { ...(value.tools as Record<string, unknown>) };
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  for (const name of ['search', 'web_search', 'web_fetch']) {
    const folder = decodeURIComponent(
      new URL(`../../../external-tools/${name}`, import.meta.url).pathname,
    );
    tools[name] = folder;
  }
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(bindingsFile, JSON.stringify({ schemaVersion: 1, tools }, null, 2));
};
