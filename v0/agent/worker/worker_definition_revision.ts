import type { DefinitionRevisionRef, SessionRecord } from '../session/session_store.ts';
import {
  builtinDefinitionRef,
  builtinToolDefinitionRef,
  type ToolDefinitionRevisionRef,
} from '../definitions/managed_resource_ref.ts';
import { buildManifest, HENJI_TOOL_DEFINITION_API_CONTRACT } from '../runtime/build_manifest.ts';
import type { WorkerModuleRevision } from './worker_capsule.ts';
import { readWorkerModuleRevision } from './worker_capsule.ts';

export interface WorkerDefinitionRevision extends WorkerModuleRevision {
  readonly ref: DefinitionRevisionRef;
}

export const readDefinitionRevision = async (
  path: string,
  kind: 'builtin' | 'external',
  id?: 'default' | 'planner',
): Promise<DefinitionRevisionRef> => {
  void path;
  if (kind !== 'builtin' || id === undefined) {
    throw new Error('external Definition install is not available until Increment 33');
  }
  return await builtinDefinitionRef(id, buildManifest());
};

export const workerBuiltinModulePath = (
  agent: SessionRecord['agent'],
): string =>
  new URL(
    agent === 'planner'
      ? './worker_builtin_planner_definition.ts'
      : './worker_builtin_definition.ts',
    import.meta.url,
  ).pathname;

export const WEB_SEARCH_TOOL_IDENTITY = 'tool:web_search' as const;
export const WEB_FETCH_TOOL_IDENTITY = 'tool:web_fetch' as const;

interface BundledToolDefinitionEntry {
  readonly identity: string;
  readonly resourceId: string;
  readonly modulePath: string;
}

const BUNDLED_TOOL_DEFINITIONS: readonly BundledToolDefinitionEntry[] = Object.freeze([
  {
    identity: WEB_SEARCH_TOOL_IDENTITY,
    resourceId: 'builtin/web-search',
    modulePath: new URL('./worker_builtin_web_search_tool.ts', import.meta.url).pathname,
  },
  {
    identity: WEB_FETCH_TOOL_IDENTITY,
    resourceId: 'builtin/web-fetch',
    modulePath: new URL('./worker_builtin_web_fetch_tool.ts', import.meta.url).pathname,
  },
]);

/** Bundled tool Definition identities the Host can resolve without an external binding. */
export const BUNDLED_TOOL_DEFINITION_IDENTITIES: readonly string[] = Object.freeze(
  BUNDLED_TOOL_DEFINITIONS.map((entry) => entry.identity),
);

const bundledToolDefinitionFor = (identity: string): BundledToolDefinitionEntry | undefined =>
  BUNDLED_TOOL_DEFINITIONS.find((entry) => entry.identity === identity);

/** Bundled tool Definition module path for one tool identity. */
export const workerBuiltinToolDefinitionModulePath = (toolIdentity: string): string => {
  const bundled = bundledToolDefinitionFor(toolIdentity);
  if (bundled === undefined) {
    throw new Error(`no bundled tool Definition for identity: ${toolIdentity}`);
  }
  return bundled.modulePath;
};

export const builtinToolDefinitionRefFor = async (
  identity: string,
): Promise<ToolDefinitionRevisionRef> => {
  const bundled = bundledToolDefinitionFor(identity);
  if (bundled === undefined) {
    throw new Error(`no bundled tool Definition for identity: ${identity}`);
  }
  return await builtinToolDefinitionRef(
    bundled.resourceId,
    identity,
    HENJI_TOOL_DEFINITION_API_CONTRACT,
    buildManifest(),
  );
};

export const builtinWebSearchToolDefinitionRef = async (): Promise<ToolDefinitionRevisionRef> =>
  await builtinToolDefinitionRefFor(WEB_SEARCH_TOOL_IDENTITY);

/** Bundled tool Definition load request for one identity. */
export const bundledToolDefinitionLoadRequest = async (
  identity: string,
): Promise<import('./worker_protocol.ts').WorkerToolDefinitionLoadRequest> => ({
  toolIdentity: identity,
  ref: await builtinToolDefinitionRefFor(identity),
  module: await readWorkerModuleRevision(workerBuiltinToolDefinitionModulePath(identity)),
});

/** Bundled web_search tool Definition load request for a default parent generation. */
export const builtinWebSearchToolDefinitionLoadRequest = async (): Promise<
  import('./worker_protocol.ts').WorkerToolDefinitionLoadRequest
> => await bundledToolDefinitionLoadRequest(WEB_SEARCH_TOOL_IDENTITY);
