import {
  type AgentCapabilityDeclaration,
  type AgentDefinition,
  type AgentDefinitionInput,
  DEFAULT_AGENT_MAX_STEPS,
  defaultAgentDefinition,
  type ResolvedAgentDefinition,
} from './agent_definition.ts';
import {
  createAgentResourceSelection,
  validateAgentResourceSelection,
  validateAgentResourceTopology,
  validateResolvedAgentResources,
} from './resource_identity.ts';
import {
  type AgentResolvedManifestV1,
  createAgentResolvedManifest,
  resolveManifestDefinitionContract,
  validateAgentResolvedManifest,
} from './resolved_manifest.ts';
import {
  type AgentResourceTopologyId,
  type BuiltinAgentId,
  COMPARISON_VARIANT_IDS,
  type ComparisonVariantId,
} from './agent_identity.ts';

/** Sanitized failure for malformed or incoherent comparison material. */
export class AgentComparisonVariantError extends Error {
  constructor() {
    super('invalid agent comparison variant');
    this.name = 'AgentComparisonVariantError';
  }
}

const invalid = (): never => {
  throw new AgentComparisonVariantError();
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

const exactDataProperties = (
  value: Record<string, unknown>,
  names: readonly string[],
): boolean => {
  const ownNames = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  if (
    ownNames.length !== names.length ||
    ownNames.some((name, index) => name !== names[index])
  ) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

const exactArray = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    length === undefined || !('value' in length) || length.enumerable ||
    length.value !== value.length
  ) return false;
  if (
    names.length !== value.length + 1 ||
    names.some((name, index) => index === value.length ? name !== 'length' : name !== String(index))
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable
    ) return false;
  }
  return true;
};

export interface ComparisonVariantEntry {
  readonly id: ComparisonVariantId;
  readonly parentId: BuiltinAgentId;
  readonly topologyId: AgentResourceTopologyId;
  readonly changedAxis: 'maxSteps';
  readonly parentMaxSteps: 64;
  readonly variantMaxSteps: 4;
}

export interface ComparisonVariantEvaluation {
  readonly entry: ComparisonVariantEntry;
  readonly parent: ResolvedAgentDefinition;
  readonly variant: ResolvedAgentDefinition;
  readonly parentManifest: AgentResolvedManifestV1;
  readonly variantManifest: AgentResolvedManifestV1;
}

type RawComparisonVariant = {
  readonly id: ComparisonVariantId;
  readonly parentId: BuiltinAgentId;
  readonly changedAxis: 'maxSteps';
  readonly parentMaxSteps: 64;
  readonly variantMaxSteps: 4;
};

const RAW_COMPARISON_VARIANTS: readonly RawComparisonVariant[] = Object.freeze([
  Object.freeze({
    id: 'default-max-steps-4',
    parentId: 'default',
    changedAxis: 'maxSteps' as const,
    parentMaxSteps: 64 as const,
    variantMaxSteps: 4 as const,
  }),
]);

const validateRawEntry = (value: unknown): ComparisonVariantEntry => {
  if (
    !isPlainObject(value) ||
    !exactDataProperties(value, [
      'id',
      'parentId',
      'changedAxis',
      'parentMaxSteps',
      'variantMaxSteps',
    ])
  ) return invalid();
  if (
    value.id !== 'default-max-steps-4' || value.parentId !== 'default' ||
    value.changedAxis !== 'maxSteps' || value.parentMaxSteps !== 64 ||
    value.variantMaxSteps !== 4
  ) return invalid();
  const topologyId = resolveManifestDefinitionContract(value.parentId).topologyId;
  return Object.freeze({
    id: value.id,
    parentId: value.parentId,
    topologyId,
    changedAxis: value.changedAxis,
    parentMaxSteps: value.parentMaxSteps,
    variantMaxSteps: value.variantMaxSteps,
  });
};

/** Validate and snapshot the exact one-entry internal comparison catalog. */
export const validateComparisonVariantCatalog = (
  value: unknown,
): readonly ComparisonVariantEntry[] => {
  if (!exactArray(value) || value.length !== COMPARISON_VARIANT_IDS.length) return invalid();
  const entries = value.map(validateRawEntry);
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== COMPARISON_VARIANT_IDS.length || entries[0]?.id !== COMPARISON_VARIANT_IDS[0]) {
    return invalid();
  }
  return Object.freeze(entries);
};

const COMPARISON_VARIANTS = validateComparisonVariantCatalog(RAW_COMPARISON_VARIANTS);

/** Resolve the only internal comparison variant without evaluating a Definition. */
export const resolveComparisonVariant = (
  value: unknown,
): ComparisonVariantEntry => {
  if (value !== COMPARISON_VARIANT_IDS[0]) return invalid();
  return COMPARISON_VARIANTS[0];
};

const freezeParentDefinition = (
  definition: ResolvedAgentDefinition,
): ResolvedAgentDefinition => {
  if (
    !isPlainObject(definition) ||
    !exactDataProperties(definition, [
      'model',
      'agentInstructions',
      'systemInstruction',
      'capabilities',
      'limits',
      'resourceSelection',
    ]) ||
    !isPlainObject(definition.model) ||
    !exactDataProperties(definition.model, ['provider', 'profile']) ||
    definition.model.provider !== 'openrouter' ||
    !isPlainObject(definition.capabilities) ||
    !Object.isFrozen(definition.capabilities) ||
    !isPlainObject(definition.limits) ||
    !Object.isFrozen(definition.limits) ||
    definition.limits.maxSteps !== DEFAULT_AGENT_MAX_STEPS
  ) return invalid();
  const model = Object.freeze({
    provider: definition.model.provider,
    profile: definition.model.profile,
  });
  const capabilities = definition.capabilities as AgentCapabilityDeclaration;
  const limits = Object.freeze({ maxSteps: definition.limits.maxSteps });
  return Object.freeze({
    model,
    agentInstructions: definition.agentInstructions,
    systemInstruction: definition.systemInstruction,
    capabilities,
    limits,
    resourceSelection: definition.resourceSelection,
  });
};

const validateResolvedEntry = (value: unknown): ComparisonVariantEntry => {
  if (
    !isPlainObject(value) || !Object.isFrozen(value) ||
    !exactDataProperties(value, [
      'id',
      'parentId',
      'topologyId',
      'changedAxis',
      'parentMaxSteps',
      'variantMaxSteps',
    ])
  ) return invalid();
  if (
    value.id !== 'default-max-steps-4' || value.parentId !== 'default' ||
    value.topologyId !== 'default' || value.changedAxis !== 'maxSteps' ||
    value.parentMaxSteps !== 64 || value.variantMaxSteps !== 4
  ) return invalid();
  return value as unknown as ComparisonVariantEntry;
};

/**
 * Check the relationship between parent and variant without serializing opaque host objects.
 * Exactly one semantic axis may differ: the fresh selection's maxSteps 64 -> 4.
 */
export const validateComparisonVariantRelationship = (
  entry: ComparisonVariantEntry,
  parent: ResolvedAgentDefinition,
  variant: ResolvedAgentDefinition,
): void => {
  try {
    validateResolvedEntry(entry);
    if (
      !Object.isFrozen(parent) || !Object.isFrozen(variant) || parent === variant ||
      !isPlainObject(parent) || !isPlainObject(variant) ||
      !exactDataProperties(parent, [
        'model',
        'agentInstructions',
        'systemInstruction',
        'capabilities',
        'limits',
        'resourceSelection',
      ]) ||
      !exactDataProperties(variant, [
        'model',
        'agentInstructions',
        'systemInstruction',
        'capabilities',
        'limits',
        'resourceSelection',
      ])
    ) return invalid();
    if (
      !isPlainObject(parent.model) || !Object.isFrozen(parent.model) ||
      !isPlainObject(variant.model) || !Object.isFrozen(variant.model) ||
      !exactDataProperties(parent.model, ['provider', 'profile']) ||
      !exactDataProperties(variant.model, ['provider', 'profile']) ||
      parent.model !== variant.model || parent.model.provider !== 'openrouter' ||
      parent.model.profile !== variant.model.profile
    ) return invalid();
    if (
      !isPlainObject(parent.capabilities) || !Object.isFrozen(parent.capabilities) ||
      !isPlainObject(variant.capabilities) || !Object.isFrozen(variant.capabilities) ||
      parent.capabilities !== variant.capabilities ||
      !isPlainObject(parent.limits) || !Object.isFrozen(parent.limits) ||
      !isPlainObject(variant.limits) || !Object.isFrozen(variant.limits) ||
      parent.limits.maxSteps !== 64 || variant.limits.maxSteps !== 4 ||
      parent.agentInstructions !== variant.agentInstructions ||
      parent.systemInstruction !== variant.systemInstruction
    ) return invalid();

    if (
      parent.resourceSelection === variant.resourceSelection ||
      !Object.isFrozen(parent.resourceSelection) ||
      !Object.isFrozen(variant.resourceSelection)
    ) return invalid();
    const parentSelection = validateAgentResourceSelection(parent.resourceSelection);
    const variantSelection = validateAgentResourceSelection(variant.resourceSelection);
    validateAgentResourceTopology('default', parentSelection.resources);
    validateAgentResourceTopology('default', variantSelection.resources);
    if (
      parentSelection.resources === variantSelection.resources ||
      parentSelection.parameters === variantSelection.parameters ||
      parentSelection.parameters.maxSteps !== 64 ||
      variantSelection.parameters.maxSteps !== 4 ||
      parentSelection.resources.length !== variantSelection.resources.length ||
      parentSelection.resources.some((resource, index) =>
        resource !== variantSelection.resources[index]
      )
    ) return invalid();
  } catch (error) {
    if (error instanceof AgentComparisonVariantError) throw error;
    return invalid();
  }
};

const evaluateComparisonVariantWithDefinition = async (
  input: AgentDefinitionInput,
  definitionEvaluator: AgentDefinition,
): Promise<ComparisonVariantEvaluation> => {
  const entry = resolveComparisonVariant('default-max-steps-4');
  const evaluatedParent = definitionEvaluator(input);
  const parent = freezeParentDefinition(evaluatedParent);
  const parentSelection = validateResolvedAgentResources(parent, 'default');
  if (
    DEFAULT_AGENT_MAX_STEPS !== 64 ||
    parentSelection.parameters.maxSteps !== entry.parentMaxSteps
  ) return invalid();
  const variantSelection = createAgentResourceSelection(
    parentSelection.resources.map((resource) => `${resource}`),
    entry.variantMaxSteps,
  );
  const variant = Object.freeze({
    ...parent,
    limits: Object.freeze({ maxSteps: entry.variantMaxSteps }),
    resourceSelection: variantSelection,
  });
  validateResolvedAgentResources(variant, 'default');
  validateComparisonVariantRelationship(entry, parent, variant);
  const parentManifest = await validateAgentResolvedManifest(
    await createAgentResolvedManifest('default', parentSelection),
  );
  const variantManifest = await validateAgentResolvedManifest(
    await createAgentResolvedManifest(entry.id, variantSelection),
  );
  return Object.freeze({ entry, parent, variant, parentManifest, variantManifest });
};

/**
 * Direct-test-only evaluator seam. Production callers must use the fixed wrapper below;
 * runtime, CLI, and TUI do not import this comparison module.
 */
export const evaluateComparisonVariantForTest = (
  input: AgentDefinitionInput,
  definitionEvaluator: AgentDefinition,
): Promise<ComparisonVariantEvaluation> =>
  evaluateComparisonVariantWithDefinition(input, definitionEvaluator);

/** Evaluate the fixed parent once and derive one fresh maxSteps-only comparison result. */
export const evaluateComparisonVariant = (
  input: AgentDefinitionInput,
): Promise<ComparisonVariantEvaluation> =>
  evaluateComparisonVariantWithDefinition(input, defaultAgentDefinition);

/** Test-only type guard helper for the finite internal ID set. */
export const isComparisonVariantId = (value: unknown): value is ComparisonVariantId =>
  value === COMPARISON_VARIANT_IDS[0];
