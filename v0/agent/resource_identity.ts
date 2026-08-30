import type { ResolvedAgentDefinition } from './agent_definition.ts';

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

export type AgentResourceKind = 'model' | 'instruction' | 'skill' | 'tool' | 'subagent';

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
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return undefined;
  const parts = value.split(':');
  if (parts[0] === 'model') {
    if (parts.length !== 3 || !provider.test(parts[1]) || !component.test(parts[2])) {
      return undefined;
    }
    return { kind: 'model', provider: parts[1], component: parts[2] };
  }
  if (parts.length !== 2 || !['instruction', 'skill', 'tool', 'subagent'].includes(parts[0])) {
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
export const createAgentResourceIdentity = (value: string): AgentResourceIdentity => {
  if (!parse(value)) return invalid();
  return value as AgentResourceIdentity;
};

/** Return the validated kind of an identity without exposing implementation objects. */
export const agentResourceKind = (value: AgentResourceIdentity): AgentResourceKind => {
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
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

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
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

const validateResourceArray = (value: unknown): readonly AgentResourceIdentity[] => {
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
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      return invalid();
    }
    resources.push(createAgentResourceIdentity(descriptor.value as string));
  }
  for (let index = 1; index < resources.length; index += 1) {
    if (compareAgentResourceIdentities(resources[index - 1], resources[index]) >= 0) {
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
  if (!hasOnlyDataProperties(value, ['resources', 'parameters'])) return invalid();
  validateResourceArray(value.resources);
  const parameters = value.parameters;
  if (!isPlainObject(parameters) || !Object.isFrozen(parameters)) return invalid();
  if (!hasOnlyDataProperties(parameters, ['maxSteps'])) return invalid();
  if (
    typeof parameters.maxSteps !== 'number' || !Number.isSafeInteger(parameters.maxSteps) ||
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
  if (!Array.isArray(resources) || !Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    return invalid();
  }
  const identities = resources.map((resource) => createAgentResourceIdentity(resource));
  for (let index = 1; index < identities.length; index += 1) {
    if (compareAgentResourceIdentities(identities[index - 1], identities[index]) >= 0) {
      return invalid();
    }
  }
  return Object.freeze({
    resources: Object.freeze(identities),
    parameters: Object.freeze({ maxSteps }),
  });
};

const expectedResources = (definition: ResolvedAgentDefinition): AgentResourceIdentity[] => {
  if (typeof definition !== 'object' || definition === null) return invalid();
  if (
    typeof definition.model !== 'object' || definition.model === null ||
    definition.model.provider !== 'openrouter' ||
    typeof definition.model.profile !== 'object' || definition.model.profile === null ||
    typeof definition.model.profile.id !== 'string'
  ) return invalid();
  if (
    typeof definition.agentInstructions !== 'undefined' &&
    typeof definition.agentInstructions !== 'string'
  ) {
    return invalid();
  }
  const catalog = definition.skillCatalog;
  if (
    typeof catalog !== 'object' || catalog === null || !Array.isArray(catalog.skills) ||
    (typeof catalog.manifest !== 'undefined' && typeof catalog.manifest !== 'string') ||
    (catalog.skills.length > 0) !== (typeof catalog.manifest !== 'undefined')
  ) return invalid();
  if (
    typeof definition.registry !== 'object' || definition.registry === null ||
    definition.registry.skillCatalog !== catalog
  ) return invalid();

  const resources: AgentResourceIdentity[] = [
    createAgentResourceIdentity(
      `model:${definition.model.provider}:${definition.model.profile.id}`,
    ),
  ];
  if (definition.agentInstructions !== undefined) {
    resources.push(createAgentResourceIdentity('instruction:workspace-agents'));
  }
  if (catalog.manifest !== undefined) {
    resources.push(createAgentResourceIdentity('instruction:project-skill-manifest'));
  }
  for (const skill of catalog.skills) {
    if (typeof skill !== 'object' || skill === null || typeof skill.name !== 'string') {
      return invalid();
    }
    resources.push(createAgentResourceIdentity(`skill:${skill.name}`));
  }

  if (definition.registry.kind === 'production') {
    if (definition.registry.plannerDelegation !== true) return invalid();
    for (
      const name of ['bash', 'delegate_to_planner', 'edit', 'read', 'submit_json_result', 'write']
    ) {
      resources.push(createAgentResourceIdentity(`tool:${name}`));
    }
    if (catalog.skills.length > 0) resources.push(createAgentResourceIdentity('tool:skill'));
    resources.push(createAgentResourceIdentity('subagent:planner'));
  } else if (definition.registry.kind === 'planner') {
    if (Object.prototype.hasOwnProperty.call(definition.registry, 'plannerDelegation')) {
      return invalid();
    }
    resources.push(createAgentResourceIdentity('instruction:builtin-planner-policy'));
    resources.push(createAgentResourceIdentity('tool:read'));
    if (catalog.skills.length > 0) resources.push(createAgentResourceIdentity('tool:skill'));
    resources.push(createAgentResourceIdentity('tool:submit_json_result'));
  } else {
    return invalid();
  }
  resources.sort(compareAgentResourceIdentities);
  return resources;
};

/** Validate one resolved Definition against its independent stable resource declaration. */
export const validateResolvedAgentResources = (
  definition: ResolvedAgentDefinition,
): AgentResourceSelection => {
  const selection = validateAgentResourceSelection(definition?.resourceSelection);
  const expected = expectedResources(definition);
  if (selection.parameters.maxSteps <= 0 || selection.resources.length !== expected.length) {
    return invalid();
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (selection.resources[index] !== expected[index]) return invalid();
  }
  return selection;
};
