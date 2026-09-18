import { type BuiltinAgentSelection, resolveBuiltinAgent } from './agent_catalog.ts';
import {
  builtinDefinitionRef,
  type DefinitionRevisionRef,
  isExternalDefinitionResourceId,
  sameDefinitionRevisionRef,
} from './managed_resource_ref.ts';
import {
  type ManagedDefinitionRevision,
  ManagedDefinitionStore,
} from './managed_definition_store.ts';
import { ManagedDefinitionError } from './managed_definition_importer.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const REVISION_MARKER = '@sha256:';
const SHA256 = /^[0-9a-f]{64}$/u;

export type DefinitionStartupErrorCode =
  | 'definition_not_found'
  | 'definition_invalid'
  | 'definition_api_unsupported'
  | 'definition_role_mismatch'
  | 'definition_execution_unavailable'
  | 'definition_evaluation_failed';

export type DefinitionStartupStage =
  | 'resolution'
  | 'session_binding'
  | 'worker_start';

export class DefinitionSelectorError extends Error {
  constructor() {
    super('invalid Definition selector');
    this.name = 'DefinitionSelectorError';
  }
}

export class DefinitionStartupError extends Error {
  constructor(
    readonly code: DefinitionStartupErrorCode,
    readonly stage: DefinitionStartupStage,
    readonly reason: string,
    readonly definition?: DefinitionRevisionRef,
  ) {
    super(reason);
    this.name = 'DefinitionStartupError';
  }
}

export interface BuiltinHostDefinitionSelection extends BuiltinAgentSelection {
  readonly kind: 'builtin';
  readonly ref: DefinitionRevisionRef;
}

export interface ManagedHostDefinitionSelection {
  readonly kind: 'managed';
  readonly id: 'default' | 'planner';
  readonly ref: DefinitionRevisionRef;
  readonly revision: ManagedDefinitionRevision;
}

export type HostDefinitionSelection =
  | BuiltinHostDefinitionSelection
  | ManagedHostDefinitionSelection;

export const parseDefinitionRevisionSelector = (value: string): DefinitionRevisionRef => {
  const marker = value.lastIndexOf(REVISION_MARKER);
  const resourceId = marker < 0 ? '' : value.slice(0, marker);
  const digest = marker < 0 ? '' : value.slice(marker + REVISION_MARKER.length);
  if (!isExternalDefinitionResourceId(resourceId) || !SHA256.test(digest)) {
    throw new DefinitionSelectorError();
  }
  return {
    schemaVersion: 1,
    resourceKind: 'agent-definition',
    resourceId,
    revision: { algorithm: 'sha256', digest },
  };
};

const builtinSelection = async (
  rawAgentName?: string,
): Promise<BuiltinHostDefinitionSelection> => {
  const selected = resolveBuiltinAgent(rawAgentName);
  return Object.freeze({
    ...selected,
    kind: 'builtin' as const,
    ref: await builtinDefinitionRef(selected.id, buildManifest()),
  });
};

const startupFromStore = (
  error: ManagedDefinitionError,
  ref: DefinitionRevisionRef,
): DefinitionStartupError => {
  const code: DefinitionStartupErrorCode = error.code === 'module_not_found'
    ? 'definition_not_found'
    : error.code === 'module_api_unsupported'
    ? 'definition_api_unsupported'
    : 'definition_invalid';
  return new DefinitionStartupError(code, 'resolution', error.message, ref);
};

export const resolveDefinitionRef = async (
  ref: DefinitionRevisionRef,
  dataRoot?: string,
): Promise<HostDefinitionSelection> => {
  if (ref.resourceId === 'builtin/default' || ref.resourceId === 'builtin/planner') {
    const selected = await builtinSelection(
      ref.resourceId === 'builtin/planner' ? 'planner' : 'default',
    );
    if (!sameDefinitionRevisionRef(selected.ref, ref)) {
      throw new DefinitionStartupError(
        'definition_not_found',
        'resolution',
        'The exact built-in Definition revision is not present in this build',
        ref,
      );
    }
    return selected;
  }
  try {
    const revision = await new ManagedDefinitionStore({
      dataRoot: dataRoot ?? resolveRuntimePaths().dataRoot,
    }).resolve(ref);
    if (revision.manifest.declaredRole !== 'parent') {
      throw new DefinitionStartupError(
        'definition_role_mismatch',
        'resolution',
        'The root Definition slot accepts only a parent-role Definition',
        ref,
      );
    }
    return Object.freeze({
      kind: 'managed' as const,
      id: 'default' as const,
      ref: structuredClone(ref),
      revision,
    });
  } catch (error) {
    if (error instanceof DefinitionStartupError) throw error;
    if (error instanceof ManagedDefinitionError) throw startupFromStore(error, ref);
    throw error;
  }
};

export const resolveRequestedDefinition = async (
  rawAgentName: string | undefined,
  rawDefinitionRevision: string | undefined,
  dataRoot?: string,
): Promise<HostDefinitionSelection> => {
  if (rawAgentName !== undefined && rawDefinitionRevision !== undefined) {
    throw new DefinitionSelectorError();
  }
  if (rawDefinitionRevision === undefined) return await builtinSelection(rawAgentName);
  return await resolveDefinitionRef(
    parseDefinitionRevisionSelector(rawDefinitionRevision),
    dataRoot,
  );
};

export const definitionStartupErrorValue = (error: DefinitionStartupError) => ({
  code: error.code,
  message: 'Definition startup failed',
  stage: error.stage,
  reason: error.reason,
  ...(error.definition === undefined ? {} : { definition: structuredClone(error.definition) }),
});
