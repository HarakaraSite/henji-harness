import type { SessionRecord } from '../session/session_store.ts';
import {
  builtinToolDefinitionRef,
  type ToolDefinitionRevisionRef,
} from '../definitions/managed_resource_ref.ts';
import { buildManifest, HENJI_TOOL_DEFINITION_API_CONTRACT } from '../runtime/build_manifest.ts';

import { readWorkerModuleRevision } from './worker_capsule.ts';

export const workerBuiltinModulePath = (
  agent: SessionRecord['agent'] | 'generic',
): string => {
  if (agent === 'generic') {
    return new URL('./worker_builtin_generic_definition.ts', import.meta.url).pathname;
  }
  if (agent !== 'default') throw new Error('no bundled Definition for agent');
  return new URL('./worker_builtin_definition.ts', import.meta.url).pathname;
};

const bundledToolModule = (name: string): string =>
  new URL(`./worker_builtin_${name}_tool.ts`, import.meta.url).pathname;

interface BundledToolDefinitionEntry {
  readonly identity: string;
  readonly resourceId: string;
  readonly modulePath: string;
}

const BUNDLED_TOOL_DEFINITIONS: readonly BundledToolDefinitionEntry[] = Object
  .freeze(
    [
      ['bash', 'bash'],
      ['bash_output', 'bash-output'],
      ['edit', 'edit'],
      ['read', 'read'],
      ['write', 'write'],
      ['web_fetch', 'web-fetch'],
      ['web_search', 'web-search'],
    ].map(([name, slug]) =>
      Object.freeze({
        identity: `tool:${name}`,
        resourceId: `builtin/${slug}`,
        modulePath: bundledToolModule(name),
      })
    ),
  );

/** Bundled tool Definition identities the Host can resolve without an external binding. */
export const BUNDLED_TOOL_DEFINITION_IDENTITIES: readonly string[] = Object
  .freeze(
    BUNDLED_TOOL_DEFINITIONS.map((entry) => entry.identity),
  );

const bundledToolDefinitionFor = (
  identity: string,
): BundledToolDefinitionEntry | undefined =>
  BUNDLED_TOOL_DEFINITIONS.find((entry) => entry.identity === identity);

/** Bundled tool Definition module path for one tool identity. */
const workerBuiltinToolDefinitionModulePath = (
  toolIdentity: string,
): string => {
  const bundled = bundledToolDefinitionFor(toolIdentity);
  if (bundled === undefined) {
    throw new Error(`no bundled tool Definition for identity: ${toolIdentity}`);
  }
  return bundled.modulePath;
};

const builtinToolDefinitionRefFor = async (
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

/** Bundled tool Definition load request for one identity. */
export const bundledToolDefinitionLoadRequest = async (
  identity: string,
): Promise<import('./worker_protocol.ts').WorkerToolDefinitionLoadRequest> => ({
  toolIdentity: identity,
  ref: await builtinToolDefinitionRefFor(identity),
  module: await readWorkerModuleRevision(
    workerBuiltinToolDefinitionModulePath(identity),
  ),
});

/** Every bundled tool Definition load request, for direct Worker start commands. */
export const bundledToolDefinitionLoadRequests = async (): Promise<
  readonly import('./worker_protocol.ts').WorkerToolDefinitionLoadRequest[]
> => {
  const requests: import('./worker_protocol.ts').WorkerToolDefinitionLoadRequest[] = [];
  for (const identity of BUNDLED_TOOL_DEFINITION_IDENTITIES) {
    requests.push(await bundledToolDefinitionLoadRequest(identity));
  }
  return requests;
};
