import type { AgentManifestDefinitionId, BuiltinAgentId } from './agent_identity.ts';
import { canonicalDomainSeparatedDigest } from './canonical_identity.ts';
import {
  type AgentResourceIdentity,
  type AgentResourceSelection,
  createAgentResourceIdentity,
  createAgentResourceSelection,
  validateAgentResourceSelection,
  validateAgentResourceTopology,
} from './resource_identity.ts';

export type AgentResolvedManifestIdentity = string & {
  readonly __agentResolvedManifestIdentity: unique symbol;
};

export interface AgentResolvedManifestV1 {
  readonly schemaVersion: 1;
  readonly definitionId: AgentManifestDefinitionId;
  readonly resources: readonly AgentResourceIdentity[];
  readonly parameters: Readonly<{ readonly maxSteps: number }>;
  readonly identity: AgentResolvedManifestIdentity;
}

export const RESOLVED_MANIFEST_DOMAIN = 'henji-agent-resolved-manifest:v1\n';
const IDENTITY_PREFIX = 'henji-agent-resolved-manifest:v1:sha256:';
const IDENTITY = /^henji-agent-resolved-manifest:v1:sha256:[0-9a-f]{64}$/;
const encoder = new TextEncoder();

interface ManifestDefinitionContract {
  readonly topologyId: 'default' | 'planner';
  readonly fixedMaxSteps?: number;
}

const MANIFEST_DEFINITION_CONTRACTS: Readonly<
  Record<AgentManifestDefinitionId, ManifestDefinitionContract>
> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<AgentManifestDefinitionId, ManifestDefinitionContract>,
    {
      default: Object.freeze({ topologyId: 'default' }),
      planner: Object.freeze({ topologyId: 'planner' }),
      'default-max-steps-4': Object.freeze({ topologyId: 'default', fixedMaxSteps: 4 }),
    },
  ),
);

export class AgentResolvedManifestError extends Error {
  constructor() {
    super('invalid agent resolved manifest');
    this.name = 'AgentResolvedManifestError';
  }
}

const invalid = (): never => {
  throw new AgentResolvedManifestError();
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
  ) {
    return false;
  }
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor &&
      descriptor.enumerable;
  });
};

const snapshotResources = (value: unknown): string[] => {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
  ) return invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) return invalid();
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 || !names.includes('length') ||
    names.filter((name) => name !== 'length').some((name, index) => name !== String(index))
  ) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    length === undefined || !('value' in length) || length.enumerable ||
    length.value !== value.length
  ) {
    return invalid();
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined || !('value' in descriptor) ||
      !descriptor.enumerable
    ) return invalid();
    if (typeof descriptor.value !== 'string') return invalid();
    result.push(descriptor.value);
  }
  return result;
};

const freezeManifest = (
  definitionId: AgentManifestDefinitionId,
  resources: readonly AgentResourceIdentity[],
  maxSteps: number,
  identity: AgentResolvedManifestIdentity,
): AgentResolvedManifestV1 =>
  Object.freeze({
    schemaVersion: 1 as const,
    definitionId,
    resources: Object.freeze(
      resources.map((resource) => createAgentResourceIdentity(`${resource}`)),
    ),
    parameters: Object.freeze({ maxSteps }),
    identity,
  });

const payloadObject = (
  definitionId: AgentManifestDefinitionId,
  resources: readonly AgentResourceIdentity[],
  maxSteps: number,
) => ({
  schemaVersion: 1 as const,
  definitionId,
  resources: resources.map((resource) => `${resource}`),
  parameters: { maxSteps },
});

const payloadBytes = (
  definitionId: AgentManifestDefinitionId,
  resources: readonly AgentResourceIdentity[],
  maxSteps: number,
): Uint8Array =>
  encoder.encode(
    JSON.stringify(payloadObject(definitionId, resources, maxSteps)),
  );

const digestIdentity = async (
  bytes: Uint8Array,
): Promise<AgentResolvedManifestIdentity> => {
  return await canonicalDomainSeparatedDigest(
    RESOLVED_MANIFEST_DOMAIN,
    bytes,
    IDENTITY_PREFIX,
  ) as AgentResolvedManifestIdentity;
};

const snapshotInput = (value: unknown): {
  readonly definitionId: AgentManifestDefinitionId;
  readonly resources: readonly AgentResourceIdentity[];
  readonly maxSteps: number;
  readonly identity: string;
} => {
  try {
    if (!isPlainObject(value)) return invalid();
    if (
      !exactDataProperties(value, [
        'schemaVersion',
        'definitionId',
        'resources',
        'parameters',
        'identity',
      ])
    ) {
      return invalid();
    }
    const schemaVersion = value.schemaVersion;
    const definitionId = value.definitionId;
    const parameters = value.parameters;
    const identity = value.identity;
    if (schemaVersion !== 1 || typeof definitionId !== 'string') return invalid();
    const contract = resolveManifestDefinitionContract(definitionId);
    const manifestDefinitionId = definitionId as AgentManifestDefinitionId;
    if (
      !isPlainObject(parameters) ||
      !exactDataProperties(parameters, ['maxSteps'])
    ) return invalid();
    if (
      typeof parameters.maxSteps !== 'number' ||
      !Number.isSafeInteger(parameters.maxSteps) ||
      parameters.maxSteps <= 0
    ) return invalid();
    if (typeof identity !== 'string' || !IDENTITY.test(identity)) {
      return invalid();
    }
    const names = snapshotResources(value.resources);
    const selection = createAgentResourceSelection(names, parameters.maxSteps);
    validateAgentResourceTopology(contract.topologyId, selection.resources);
    if (
      contract.fixedMaxSteps !== undefined &&
      selection.parameters.maxSteps !== contract.fixedMaxSteps
    ) return invalid();
    return {
      definitionId: manifestDefinitionId,
      resources: selection.resources.map((resource) => createAgentResourceIdentity(`${resource}`)),
      maxSteps: selection.parameters.maxSteps,
      identity,
    };
  } catch (error) {
    if (error instanceof AgentResolvedManifestError) throw error;
    return invalid();
  }
};

/** Construct and validate one immutable schema-v1 manifest from a validated resource selection. */
export const createAgentResolvedManifest = async (
  definitionId: AgentManifestDefinitionId,
  selection: AgentResourceSelection,
): Promise<AgentResolvedManifestV1> => {
  let resources: readonly AgentResourceIdentity[];
  let maxSteps: number;
  try {
    const validated = validateAgentResourceSelection(selection);
    const contract = resolveManifestDefinitionContract(definitionId);
    validateAgentResourceTopology(contract.topologyId, validated.resources);
    if (
      contract.fixedMaxSteps !== undefined &&
      validated.parameters.maxSteps !== contract.fixedMaxSteps
    ) return invalid();
    resources = validated.resources.map((resource) => createAgentResourceIdentity(`${resource}`));
    maxSteps = validated.parameters.maxSteps;
  } catch {
    return invalid();
  }
  const identity = await digestIdentity(
    payloadBytes(definitionId, resources, maxSteps),
  );
  return freezeManifest(definitionId, resources, maxSteps, identity);
};

/** Validate an untrusted manifest without invoking getters or retaining caller-owned objects. */
export const validateAgentResolvedManifest = async (
  value: unknown,
): Promise<AgentResolvedManifestV1> => {
  const snapshot = snapshotInput(value);
  const expected = await digestIdentity(
    payloadBytes(snapshot.definitionId, snapshot.resources, snapshot.maxSteps),
  );
  if (expected !== snapshot.identity) return invalid();
  return freezeManifest(
    snapshot.definitionId,
    snapshot.resources,
    snapshot.maxSteps,
    snapshot.identity as AgentResolvedManifestIdentity,
  );
};

/** Resolve the exact internal manifest ID contract without echoing untrusted input. */
export const resolveManifestDefinitionContract = (
  value: unknown,
): ManifestDefinitionContract & { readonly id: AgentManifestDefinitionId } => {
  if (
    typeof value !== 'string' ||
    !Object.prototype.hasOwnProperty.call(MANIFEST_DEFINITION_CONTRACTS, value)
  ) return invalid();
  const contract = MANIFEST_DEFINITION_CONTRACTS[value as AgentManifestDefinitionId];
  return Object.freeze({
    id: value as AgentManifestDefinitionId,
    topologyId: contract.topologyId,
    ...(contract.fixedMaxSteps === undefined ? {} : { fixedMaxSteps: contract.fixedMaxSteps }),
  });
};

/** Correlate a validated internal manifest with the executable built-in runtime selection. */
export const validateAgentResolvedManifestCorrelation = (
  manifest: AgentResolvedManifestV1,
  requestedId: BuiltinAgentId,
  selection: AgentResourceSelection,
): void => {
  try {
    if (manifest.definitionId !== requestedId) return invalid();
    const validated = validateAgentResourceSelection(selection);
    if (
      manifest.resources.length !== validated.resources.length ||
      manifest.parameters.maxSteps !== validated.parameters.maxSteps ||
      manifest.resources.some((resource, index) => resource !== validated.resources[index])
    ) return invalid();
  } catch (error) {
    if (error instanceof AgentResolvedManifestError) throw error;
    return invalid();
  }
};

/** Return the exact identity-bearing payload bytes used by the digest (test-only evidence helper). */
export const resolvedManifestPayload = (
  manifest: AgentResolvedManifestV1,
): Uint8Array => {
  const validated = validateAgentResourceSelection(Object.freeze({
    resources: Object.freeze([...manifest.resources]),
    parameters: Object.freeze({ maxSteps: manifest.parameters.maxSteps }),
  }));
  return payloadBytes(
    manifest.definitionId,
    validated.resources,
    validated.parameters.maxSteps,
  );
};
