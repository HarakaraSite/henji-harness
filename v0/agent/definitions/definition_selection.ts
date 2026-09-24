import { type BuiltinAgentSelection, resolveBuiltinAgent } from './agent_catalog.ts';
import {
  builtinDefinitionRef,
  type DefinitionRevisionRef,
  sameDefinitionRevisionRef,
} from './managed_resource_ref.ts';
import {
  type ManagedDefinitionRevision,
  ManagedDefinitionStore,
} from './managed_definition_store.ts';
import { ManagedDefinitionError } from './managed_definition_importer.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import { AgentBindingError, resolveRootAgentSlotBinding } from './agent_slot_binding.ts';
import { DefinitionSelectorError, parseDefinitionRevisionSelector } from './definition_selector.ts';

export { DefinitionSelectorError, parseDefinitionRevisionSelector } from './definition_selector.ts';

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
  readonly id: 'default';
  readonly ref: DefinitionRevisionRef;
  readonly revision: ManagedDefinitionRevision;
}

export type HostDefinitionSelection =
  | BuiltinHostDefinitionSelection
  | ManagedHostDefinitionSelection;

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
  if (ref.resourceId === 'builtin/planner') {
    throw new DefinitionStartupError(
      'definition_not_found',
      'resolution',
      'The bundled planner Definition is no longer available',
      ref,
    );
  }
  if (ref.resourceId === 'builtin/default') {
    const selected = await builtinSelection('default');
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
    if (error instanceof ManagedDefinitionError) {
      throw startupFromStore(error, ref);
    }
    throw error;
  }
};

const bindingStartupCode = (
  code: AgentBindingError['code'],
): DefinitionStartupErrorCode => {
  switch (code) {
    case 'binding_definition_not_found':
      return 'definition_not_found';
    case 'binding_role_mismatch':
      return 'definition_role_mismatch';
    default:
      return 'definition_invalid';
  }
};

/**
 * Resolve the root `agent:default` activation binding as the default root Definition for a new
 * generation. A bound root must be a managed parent-role revision; failures stay typed and never
 * fall back to the bundled default.
 */
const rootBindingSelection = async (
  configRoot: string,
  dataRoot?: string,
): Promise<ManagedHostDefinitionSelection | undefined> => {
  let bound;
  try {
    bound = await resolveRootAgentSlotBinding(
      configRoot,
      dataRoot ?? resolveRuntimePaths().dataRoot,
    );
  } catch (error) {
    if (error instanceof AgentBindingError) {
      throw new DefinitionStartupError(
        bindingStartupCode(error.code),
        'resolution',
        error.message,
        error.definition,
      );
    }
    throw error;
  }
  if (bound === undefined) return undefined;
  return Object.freeze({
    kind: 'managed' as const,
    id: 'default' as const,
    ref: bound.ref,
    revision: bound.revision,
  });
};

/**
 * Resolve the root Definition for a new generation.
 *
 * An explicit selector wins. With no explicit selector, the `agent:default` activation binding is
 * used when configured, then the bundled default.
 */
export const resolveRequestedDefinition = async (
  rawAgentName: string | undefined,
  rawDefinitionRevision: string | undefined,
  dataRoot?: string,
  configRoot?: string,
): Promise<HostDefinitionSelection> => {
  if (rawAgentName !== undefined && rawDefinitionRevision !== undefined) {
    throw new DefinitionSelectorError();
  }
  if (rawDefinitionRevision !== undefined) {
    return await resolveDefinitionRef(
      parseDefinitionRevisionSelector(rawDefinitionRevision),
      dataRoot,
    );
  }
  if (rawAgentName !== undefined) return await builtinSelection(rawAgentName);
  if (configRoot !== undefined) {
    const bound = await rootBindingSelection(configRoot, dataRoot);
    if (bound !== undefined) return bound;
  }
  return await builtinSelection(undefined);
};

export const definitionStartupErrorValue = (error: DefinitionStartupError) => ({
  code: error.code,
  message: 'Definition startup failed',
  stage: error.stage,
  reason: error.reason,
  ...(error.definition === undefined ? {} : { definition: structuredClone(error.definition) }),
});
