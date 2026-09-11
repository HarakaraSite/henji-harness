import type { DefinitionRevisionRef, SessionRecord } from '../session/session_store.ts';
import { builtinDefinitionRef } from '../definitions/managed_resource_ref.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import type { WorkerModuleRevision } from './worker_capsule.ts';

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
