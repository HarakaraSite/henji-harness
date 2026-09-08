import type { DefinitionRevisionRef, SessionRecord } from '../session/session_store.ts';
import { readWorkerModuleRevision, type WorkerModuleRevision } from './worker_capsule.ts';

export interface WorkerDefinitionRevision extends WorkerModuleRevision {
  readonly kind: DefinitionRevisionRef['kind'];
  readonly id?: 'default' | 'planner';
}

export const readDefinitionRevision = async (
  path: string,
  kind: DefinitionRevisionRef['kind'],
  id?: 'default' | 'planner',
): Promise<DefinitionRevisionRef> => {
  const revision = await readWorkerModuleRevision(path);
  if (kind === 'builtin' && id === undefined) {
    throw new Error('built-in Definition id required');
  }
  if (kind === 'external' && id !== undefined) {
    throw new Error('external Definition has no id');
  }
  return kind === 'builtin'
    ? {
      kind,
      id: id!,
      canonicalSpecifier: revision.canonicalSpecifier,
      entrySha256: revision.entrySha256,
      sourceBytes: revision.sourceBytes,
    }
    : {
      kind,
      canonicalSpecifier: revision.canonicalSpecifier,
      entrySha256: revision.entrySha256,
      sourceBytes: revision.sourceBytes,
    };
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
