import { type OpenRouterAgentProfile } from '../provider/openrouter_model.ts';
import { PRODUCTION_PROFILE } from '../provider/provider_profile.ts';
import { type SkillCatalog } from './skills.ts';
import { type Workspace } from '../tools/work_tools.ts';
import {
  builtinInstructionResourceIdentities,
  resolveBuiltinDefinitionInstruction,
} from '../instructions/compose.ts';
export { PLANNER_AGENT_INSTRUCTION } from '../instructions/roles/planner.ts';
import {
  type AgentResourceIdentity,
  type AgentResourceSelection,
  compareAgentResourceIdentities,
  createAgentResourceIdentity,
  createAgentResourceSelection,
} from './resource_identity.ts';

/** Provider-neutral model declaration consumed by the runtime adapter boundary. */
export interface AgentModelDefinition {
  readonly provider: 'openrouter';
  readonly profile: OpenRouterAgentProfile;
}

/** Compatibility name for callers that only need the current adapter's profile shape. */
export type OpenRouterModelDefinition = AgentModelDefinition;

/**
 * The effective capability declaration of one Definition.
 *
 * These are resource identities only.  Workspace, discovered skill bodies, and executable tool
 * factories are deliberately supplied by the host when this declaration is materialized.
 */
export interface AgentCapabilityDeclaration {
  readonly instructions: readonly AgentResourceIdentity[];
  readonly skills: readonly AgentResourceIdentity[];
  readonly tools: readonly AgentResourceIdentity[];
  readonly subagents: readonly AgentResourceIdentity[];
}

/** Data-only execution limits declared by an Agent Definition. */
export interface AgentDefinitionLimits {
  readonly maxSteps: number;
}

/** Host-resolved inputs supplied to an Agent Definition exactly once per composition. */
export interface AgentDefinitionInput {
  readonly workspace: Workspace;
  readonly agentInstructions?: string;
  readonly skillCatalog: SkillCatalog;
}

/** Declarative, synchronous output used to materialize one normal runtime composition. */
export interface ResolvedAgentDefinition {
  readonly model: AgentModelDefinition;
  readonly agentInstructions?: string;
  readonly systemInstruction?: string;
  readonly capabilities: AgentCapabilityDeclaration;
  readonly limits: AgentDefinitionLimits;
  /** Canonical flattened identity view used by manifest/resource validation. */
  readonly resourceSelection: AgentResourceSelection;
}

export type AgentDefinition = (input: AgentDefinitionInput) => ResolvedAgentDefinition;

/** The finite request bound declared by the normal runtime's default Agent Definition. */
export const DEFAULT_AGENT_MAX_STEPS = 64;

const canonicalSelection = (
  resources: readonly AgentResourceIdentity[],
  maxSteps: number,
): AgentResourceSelection => {
  const identities = [...resources];
  identities.sort(compareAgentResourceIdentities);
  return createAgentResourceSelection(identities, maxSteps);
};

const declarationsFor = (
  input: AgentDefinitionInput,
  registryKind: 'production' | 'planner',
): AgentCapabilityDeclaration => {
  const instructions = [...builtinInstructionResourceIdentities(
    registryKind === 'production' ? 'default' : 'planner',
    input.agentInstructions !== undefined,
    input.skillCatalog.manifest !== undefined,
  )];
  const skills = input.skillCatalog.skills.map((skill) =>
    createAgentResourceIdentity(`skill:${skill.name}`)
  );
  const tools: AgentResourceIdentity[] = [];
  const subagents: AgentResourceIdentity[] = [];
  if (registryKind === 'production') {
    tools.push(
      ...[
        'tool:bash',
        'tool:bash_output',
        'tool:edit',
        'tool:read',
        'tool:web_search',
        'tool:write',
      ].map((name) => createAgentResourceIdentity(name)),
    );
    if (input.skillCatalog.skills.length > 0) {
      tools.push(createAgentResourceIdentity('tool:skill'));
    }
    tools.push(
      createAgentResourceIdentity('tool:delegate_to_planner'),
      createAgentResourceIdentity('tool:submit_json_result'),
    );
    subagents.push(createAgentResourceIdentity('subagent:planner'));
  } else {
    tools.push(createAgentResourceIdentity('tool:read'));
    if (input.skillCatalog.skills.length > 0) {
      tools.push(createAgentResourceIdentity('tool:skill'));
    }
    tools.push(createAgentResourceIdentity('tool:submit_json_result'));
  }
  return Object.freeze({
    instructions: Object.freeze(instructions),
    skills: Object.freeze(skills),
    tools: Object.freeze(tools),
    subagents: Object.freeze(subagents),
  });
};

const flattenResources = (
  model: AgentModelDefinition,
  capabilities: AgentCapabilityDeclaration,
): AgentResourceIdentity[] => [
  createAgentResourceIdentity(`model:${model.provider}:${model.profile.id}`),
  ...capabilities.instructions,
  ...capabilities.skills,
  ...capabilities.tools,
  ...capabilities.subagents,
];

const resolveDefinition = (
  input: AgentDefinitionInput,
  kind: 'production' | 'planner',
): ResolvedAgentDefinition => {
  const model: AgentModelDefinition = Object.freeze({
    provider: 'openrouter',
    profile: PRODUCTION_PROFILE,
  });
  const capabilities = declarationsFor(input, kind);
  const limits = Object.freeze({ maxSteps: DEFAULT_AGENT_MAX_STEPS });
  const systemInstruction = resolveBuiltinDefinitionInstruction(
    kind === 'production' ? 'default' : 'planner',
    input.workspace.root,
    input.agentInstructions,
    input.skillCatalog,
    [],
  ).systemInstruction;
  const resourceSelection = canonicalSelection(
    flattenResources(model, capabilities),
    limits.maxSteps,
  );
  return Object.freeze({
    model,
    agentInstructions: input.agentInstructions,
    systemInstruction,
    capabilities,
    limits,
    resourceSelection,
  });
};

/**
 * The sole normal-runtime Agent Definition. It only projects already-resolved host inputs and
 * performs no filesystem, credential, network, tool, session, event, or UI work.
 */
export const defaultAgentDefinition: AgentDefinition = (input) =>
  resolveDefinition(input, 'production');

/**
 * The sole built-in planning Definition. It only projects host-resolved snapshots and changes the
 * model capability declaration; it does not itself perform filesystem or tool work.
 */
export const plannerAgentDefinition: AgentDefinition = (input) =>
  resolveDefinition(input, 'planner');
