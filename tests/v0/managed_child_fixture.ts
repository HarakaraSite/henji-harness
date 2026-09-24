import type { DefinitionRevisionRef } from '../../v0/agent/session/session_store.ts';
import { readWorkerModuleRevision } from '../../v0/agent/worker/worker_capsule.ts';
import { workerBuiltinModulePath } from '../../v0/agent/worker/worker_definition_revision.ts';
import { ManagedDefinitionStore } from '../../v0/agent/definitions/managed_definition_store.ts';

/** Synthetic external ref used to exercise the managed child Worker path without installation. */
export const managedChildRef = (): DefinitionRevisionRef => ({
  schemaVersion: 1,
  resourceKind: 'agent-definition',
  resourceId: 'test/probe-child',
  revision: { algorithm: 'sha256', digest: 'c'.repeat(64) },
});

export const managedChildModule = () =>
  readWorkerModuleRevision(workerBuiltinModulePath('default'));

/** Install and bind a real managed child for provider-free parent Worker integration tests. */
export const installManagedProbeChild = async (
  dataRoot: string,
  configRoot: string,
): Promise<DefinitionRevisionRef> => {
  const source = new URL('./fixtures/managed_child_definition.ts', import.meta.url).pathname;
  const installed = await new ManagedDefinitionStore({ dataRoot }).install({
    entryPath: source,
    resourceId: 'test/probe-child',
    declaredRole: 'parent',
  });
  const ref = installed.manifest.logicalRef;
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/agents.json`,
    JSON.stringify({
      schemaVersion: 1,
      bindings: {
        'agent:probe-child': `${ref.resourceId}@sha256:${ref.revision.digest}`,
      },
    }),
  );
  return ref;
};
