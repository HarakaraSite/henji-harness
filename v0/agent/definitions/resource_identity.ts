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

type AgentResourceKind =
  | 'model'
  | 'instruction'
  | 'skill'
  | 'tool'
  | 'subagent'
  | 'agent';

/** Sanitized failure for malformed or incoherent resource declarations. */
class AgentResourceIdentityError extends Error {
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
  agent: 4,
  subagent: 5,
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
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  // JSON configuration names are data, independent of old lowercase Definition selectors.
  for (const kind of ['agent', 'tool'] as const) {
    const prefix = `${kind}:`;
    if (value.startsWith(prefix)) {
      const name = value.slice(prefix.length);
      return name.trim().length === 0 ? undefined : { kind, component: name };
    }
  }
  if (value.includes('\0')) return undefined;
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
    !['instruction', 'skill', 'tool', 'subagent', 'agent'].includes(parts[0])
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

/** Construct an immutable resource selection for one Worker configuration. */
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
