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

/** Bundled tool Definition module path for one tool identity. */
export const workerBuiltinToolDefinitionModulePath = (toolIdentity: string): string => {
  if (toolIdentity === WEB_SEARCH_TOOL_IDENTITY) {
    return new URL('./worker_builtin_web_search_tool.ts', import.meta.url).pathname;
  }
  throw new Error(`no bundled tool Definition for identity: ${toolIdentity}`);
};

export const builtinWebSearchToolDefinitionRef = async (): Promise<ToolDefinitionRevisionRef> =>
  await builtinToolDefinitionRef(
    'builtin/web-search',
    WEB_SEARCH_TOOL_IDENTITY,
    HENJI_TOOL_DEFINITION_API_CONTRACT,
    buildManifest(),
  );

/** Bundled web_search tool Definition load request for a default parent generation. */
export const builtinWebSearchToolDefinitionLoadRequest = async (): Promise<
  import('./worker_protocol.ts').WorkerToolDefinitionLoadRequest
> => ({
  toolIdentity: WEB_SEARCH_TOOL_IDENTITY,
  ref: await builtinWebSearchToolDefinitionRef(),
  module: await readWorkerModuleRevision(
    workerBuiltinToolDefinitionModulePath(WEB_SEARCH_TOOL_IDENTITY),
  ),
});
