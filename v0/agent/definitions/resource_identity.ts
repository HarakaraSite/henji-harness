import type { AgentCapabilityDeclaration, ResolvedAgentDefinition } from './agent_definition.ts';
import type { AgentResourceTopologyId } from './agent_identity.ts';

/** A stable, internal name for one selected agent resource. */
export type AgentResourceIdentity = string & {
  readonly __agentResourceIdentity: unique symbol;
};

export interface AgentResourceSelection {
  readonly resources: readonly AgentResourceIdentity[];
  readonly parameters: Readonly<{
    readonly maxSteps: number;
  }>;
}

export type AgentResourceKind =
  | 'model'
  | 'instruction'
  | 'skill'
  | 'tool'
  | 'subagent';

/** Sanitized failure for malformed or incoherent resource declarations. */
export class AgentResourceIdentityError extends Error {
  constructor() {
    super('invalid agent resource selection');
    this.name = 'AgentResourceIdentityError';
  }
}

const component = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const provider = /^[a-z][a-z0-9-]{0,31}$/;
const skillComponent = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ranks: Readonly<Record<AgentResourceKind, number>> = {
  model: 0,
  instruction: 1,
  skill: 2,
  tool: 3,
  subagent: 4,
};

interface ParsedIdentity {
  readonly kind: AgentResourceKind;
  readonly component: string;
  readonly provider?: string;
}

const invalid = (): never => {
  throw new AgentResourceIdentityError();
};

const parse = (value: unknown): ParsedIdentity | undefined => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return undefined;
  }
  const parts = value.split(':');
  if (parts[0] === 'model') {
    if (
      parts.length !== 3 || !provider.test(parts[1]) ||
      !component.test(parts[2])
    ) {
      return undefined;
    }
    return { kind: 'model', provider: parts[1], component: parts[2] };
  }
  if (
    parts.length !== 2 ||
    !['instruction', 'skill', 'tool', 'subagent'].includes(parts[0])
  ) {
    return undefined;
  }
  const kind = parts[0] as Exclude<AgentResourceKind, 'model'>;
  const validComponent = kind === 'skill'
    ? skillComponent.test(parts[1])
    : component.test(parts[1]);
  if (!validComponent) return undefined;
  return { kind, component: parts[1] };
};

/** Construct one validated branded identity from its canonical string form. */
export const createAgentResourceIdentity = (
  value: string,
): AgentResourceIdentity => {
  if (!parse(value)) return invalid();
  return value as AgentResourceIdentity;
};

/** Return the validated kind of an identity without exposing implementation objects. */
export const agentResourceKind = (
  value: AgentResourceIdentity,
): AgentResourceKind => {
  const parsed = parse(value);
  if (!parsed) return invalid();
  return parsed.kind;
};

/** Compare identities by kind rank and then strict ASCII code-unit order. */
export const compareAgentResourceIdentities = (
  left: AgentResourceIdentity,
  right: AgentResourceIdentity,
): number => {
  const parsedLeft = parse(left);
  const parsedRight = parse(right);
  if (!parsedLeft || !parsedRight) return invalid();
  const rankDifference = ranks[parsedLeft.kind] - ranks[parsedRight.kind];
  if (rankDifference !== 0) return rankDifference;
  return left < right ? -1 : left > right ? 1 : 0;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

const hasOnlyDataProperties = (
  value: Record<string, unknown>,
  names: readonly string[],
): boolean => {
  const ownNames = Object.getOwnPropertyNames(value);
  const ownSymbols = Object.getOwnPropertySymbols(value);
  if (ownSymbols.length !== 0 || ownNames.length !== names.length) return false;
  if (ownNames.some((name) => !names.includes(name))) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor &&
      descriptor.enumerable;
  });
};

const validateResourceArray = (
  value: unknown,
): readonly AgentResourceIdentity[] => {
  if (!Array.isArray(value) || !Object.isFrozen(value)) return invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) return invalid();
  const names = Object.getOwnPropertyNames(value);
  if (
    names.some((name) => name !== 'length' && !/^\d+$/.test(name)) ||
    names.filter((name) => name !== 'length').length !== value.length
  ) return invalid();
  const resources: AgentResourceIdentity[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined || !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      return invalid();
    }
    resources.push(createAgentResourceIdentity(descriptor.value as string));
  }
  for (let index = 1; index < resources.length; index += 1) {
    if (
      compareAgentResourceIdentities(resources[index - 1], resources[index]) >=
        0
    ) {
      return invalid();
    }
  }
  return resources;
};

/** Validate and return a frozen data-only selection envelope. */
export const validateAgentResourceSelection = (
  value: unknown,
): AgentResourceSelection => {
  if (!isPlainObject(value) || !Object.isFrozen(value)) return invalid();
  if (!hasOnlyDataProperties(value, ['resources', 'parameters'])) {
    return invalid();
  }
  validateResourceArray(value.resources);
  const parameters = value.parameters;
  if (!isPlainObject(parameters) || !Object.isFrozen(parameters)) {
    return invalid();
  }
  if (!hasOnlyDataProperties(parameters, ['maxSteps'])) return invalid();
  if (
    typeof parameters.maxSteps !== 'number' ||
    !Number.isSafeInteger(parameters.maxSteps) ||
    parameters.maxSteps <= 0
  ) {
    return invalid();
  }
  return value as unknown as AgentResourceSelection;
};

/** Construct the immutable selection used by built-in Definitions and direct-test fixtures. */
export const createAgentResourceSelection = (
  resources: readonly string[],
  maxSteps: number,
): AgentResourceSelection => {
  if (
    !Array.isArray(resources) || !Number.isSafeInteger(maxSteps) ||
    maxSteps <= 0
  ) {
    return invalid();
  }
  const identities = resources.map((resource) => createAgentResourceIdentity(resource));
  for (let index = 1; index < identities.length; index += 1) {
    if (
      compareAgentResourceIdentities(
        identities[index - 1],
        identities[index],
      ) >= 0
    ) {
      return invalid();
    }
  }
  return Object.freeze({
    resources: Object.freeze(identities),
    parameters: Object.freeze({ maxSteps }),
  });
};

/**
 * Validate the built-in capability topology independently of a resolved Definition.
 * This is shared by the Step 76 Definition validator and the Step 77 manifest codec.
 */
export const validateAgentResourceTopology = (
  definitionId: AgentResourceTopologyId,
  resources: readonly AgentResourceIdentity[],
): void => {
  if (definitionId !== 'default' && definitionId !== 'planner') return invalid();
  const parsed = resources.map(parse);
  if (parsed.some((resource) => resource === undefined)) return invalid();
  const model = parsed.find((resource) => resource?.kind === 'model');
  if (model === undefined || parsed.filter((resource) => resource?.kind === 'model').length !== 1) {
    return invalid();
  }
  const names = resources.map((resource) => `${resource}`);
  const has = (name: string): boolean => names.includes(name);
  const skills = resources
    .filter((resource) => parse(resource)?.kind === 'skill')
    .map((resource) => `${resource}`);
  const expected: AgentResourceIdentity[] = [
    createAgentResourceIdentity(`${resources[parsed.indexOf(model)]}`),
    createAgentResourceIdentity(
      definitionId === 'default'
        ? 'instruction:builtin-default-role'
        : 'instruction:builtin-planner-policy',
    ),
    createAgentResourceIdentity('instruction:active-tool-guidelines'),
    createAgentResourceIdentity('instruction:runtime-facts'),
  ];
  if (has('instruction:workspace-agents')) {
    expected.push(createAgentResourceIdentity('instruction:workspace-agents'));
  }
  if (skills.length > 0) {
    expected.push(createAgentResourceIdentity('instruction:project-skill-manifest'));
    for (const skill of skills) expected.push(createAgentResourceIdentity(skill));
  }
  if (definitionId === 'default') {
    expected.push(
      ...[
        'tool:bash',
        'tool:bash_output',
        'tool:delegate_to_planner',
        'tool:edit',
        'tool:read',
        'tool:submit_json_result',
        'tool:web_search',
        'tool:write',
      ].map((name) => createAgentResourceIdentity(name)),
    );
    if (skills.length > 0) expected.push(createAgentResourceIdentity('tool:skill'));
    expected.push(createAgentResourceIdentity('subagent:planner'));
  } else {
    expected.push(createAgentResourceIdentity('tool:read'));
    if (skills.length > 0) expected.push(createAgentResourceIdentity('tool:skill'));
    expected.push(createAgentResourceIdentity('tool:submit_json_result'));
  }
  expected.sort(compareAgentResourceIdentities);
  if (
    expected.length !== resources.length ||
    expected.some((resource, index) => resource !== resources[index])
  ) return invalid();
};

const exactDataProperties = (
  value: Record<string, unknown>,
  names: readonly string[],
): boolean => {
  const ownNames = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  if (ownNames.length !== names.length || ownNames.some((name) => !names.includes(name))) {
    return false;
  }
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

const snapshotIdentityArray = (
  value: unknown,
): readonly AgentResourceIdentity[] => {
  if (!Array.isArray(value) || !Object.isFrozen(value)) return invalid();
  const identities: AgentResourceIdentity[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable
    ) return invalid();
    identities.push(createAgentResourceIdentity(descriptor.value as string));
  }
  return identities;
};

const declaredResources = (
  definition: ResolvedAgentDefinition,
): AgentResourceIdentity[] => {
  if (
    !isPlainObject(definition) || !Object.isFrozen(definition) ||
    !exactDataProperties(definition, [
      'model',
      'agentInstructions',
      'systemInstruction',
      'capabilities',
      'limits',
      'resourceSelection',
    ]) ||
    !isPlainObject(definition.model) || !Object.isFrozen(definition.model) ||
    !exactDataProperties(definition.model, ['provider', 'profile']) ||
    definition.model.provider !== 'openrouter' ||
    !isPlainObject(definition.model.profile) ||
    !Object.isFrozen(definition.model.profile) ||
    typeof definition.model.profile.id !== 'string' ||
    (typeof definition.agentInstructions !== 'undefined' &&
      typeof definition.agentInstructions !== 'string') ||
    (typeof definition.systemInstruction !== 'undefined' &&
      typeof definition.systemInstruction !== 'string') ||
    !isPlainObject(definition.capabilities) || !Object.isFrozen(definition.capabilities) ||
    !exactDataProperties(definition.capabilities, [
      'instructions',
      'skills',
      'tools',
      'subagents',
    ]) ||
    !isPlainObject(definition.limits) || !Object.isFrozen(definition.limits) ||
    !exactDataProperties(definition.limits, ['maxSteps']) ||
    typeof definition.limits.maxSteps !== 'number' ||
    !Number.isSafeInteger(definition.limits.maxSteps) ||
    definition.limits.maxSteps <= 0
  ) return invalid();

  const capabilities = definition.capabilities as AgentCapabilityDeclaration;
  const instructions = snapshotIdentityArray(capabilities.instructions);
  const skills = snapshotIdentityArray(capabilities.skills);
  const tools = snapshotIdentityArray(capabilities.tools);
  const subagents = snapshotIdentityArray(capabilities.subagents);
  const all = [...instructions, ...skills, ...tools, ...subagents];
  const names = new Set<string>();
  for (const resource of all) {
    if (names.has(`${resource}`)) return invalid();
    names.add(`${resource}`);
  }
  const model = createAgentResourceIdentity(
    `model:${definition.model.provider}:${definition.model.profile.id}`,
  );
  if (names.has(`${model}`)) return invalid();
  all.push(model);
  all.sort(compareAgentResourceIdentities);
  return all;
};

/** Validate the shape of a declarative capability topology without assuming a built-in preset. */
export const validateDeclaredAgentResourceTopology = (
  resources: readonly AgentResourceIdentity[],
): void => {
  try {
    if (!Array.isArray(resources) || resources.length === 0) return invalid();
    const modelCount = resources.filter((resource) =>
      agentResourceKind(resource) === 'model'
    ).length;
    if (modelCount !== 1) return invalid();
    const names = new Set<string>();
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index];
      if (names.has(`${resource}`)) return invalid();
      names.add(`${resource}`);
      if (index > 0 && compareAgentResourceIdentities(resources[index - 1], resource) >= 0) {
        return invalid();
      }
    }
  } catch {
    return invalid();
  }
};

/** Validate one resolved Definition against its independent stable resource declaration. */
export const validateResolvedAgentResources = (
  definition: ResolvedAgentDefinition,
  definitionId?: AgentResourceTopologyId,
): AgentResourceSelection => {
  const selection = validateAgentResourceSelection(
    definition?.resourceSelection,
  );
  const expected = declaredResources(definition);
  validateDeclaredAgentResourceTopology(expected);
  if (selection.parameters.maxSteps !== definition.limits.maxSteps) return invalid();
  if (selection.resources.length !== expected.length) return invalid();
  for (let index = 0; index < expected.length; index += 1) {
    if (selection.resources[index] !== expected[index]) return invalid();
  }
  if (definitionId !== undefined) {
    validateAgentResourceTopology(definitionId, selection.resources);
  }
  return selection;
};
