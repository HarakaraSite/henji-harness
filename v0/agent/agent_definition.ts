import { type OpenRouterAgentProfile } from './openrouter_model.ts';
import { PROFILE } from '../model.ts';
import { composeSystemInstruction } from './agent_instructions.ts';
import { type SkillCatalog } from './skills.ts';
import { type Workspace } from './work_tools.ts';
import {
  type AgentResourceSelection,
  compareAgentResourceIdentities,
  createAgentResourceIdentity,
  createAgentResourceSelection,
} from './resource_identity.ts';

/** The model provider declaration understood by the normal runtime materializer. */
export interface OpenRouterModelDefinition {
  readonly provider: 'openrouter';
  readonly profile: OpenRouterAgentProfile;
}

/** The concrete registry declaration understood by the normal runtime materializer. */
export interface ProductionRegistryDefinition {
  readonly kind: 'production';
  readonly workspace: Workspace;
  readonly skillCatalog: SkillCatalog;
  /** The only built-in registry capability that may be materialized for delegation. */
  readonly plannerDelegation: true;
}

/** The model-capability-limited registry declaration used by the built-in planner. */
export interface PlannerRegistryDefinition {
  readonly kind: 'planner';
  readonly workspace: Workspace;
  readonly skillCatalog: SkillCatalog;
}

/** Host-resolved inputs supplied to an Agent Definition exactly once per composition. */
export interface AgentDefinitionInput {
  readonly workspace: Workspace;
  readonly agentInstructions?: string;
  readonly skillCatalog: SkillCatalog;
}

/** Declarative, synchronous output used to materialize one normal runtime composition. */
export interface ResolvedAgentDefinition {
  readonly model: OpenRouterModelDefinition;
  readonly registry: ProductionRegistryDefinition | PlannerRegistryDefinition;
  readonly agentInstructions?: string;
  readonly skillCatalog: SkillCatalog;
  readonly systemInstruction?: string;
  readonly resourceSelection: AgentResourceSelection;
}

export type AgentDefinition = (input: AgentDefinitionInput) => ResolvedAgentDefinition;

/** The finite request bound declared by the normal runtime's default Agent Definition. */
export const DEFAULT_AGENT_MAX_STEPS = 8;

/** Fixed planner policy appended after all discovered workspace context. */
export const PLANNER_AGENT_INSTRUCTION =
  'You are the built-in planner agent. Inspect the available workspace context needed for the task and produce a clear implementation plan. Do not mutate the workspace.';

const canonicalSelection = (
  resources: readonly string[],
): AgentResourceSelection => {
  const identities = resources.map((resource) => createAgentResourceIdentity(resource));
  identities.sort(compareAgentResourceIdentities);
  return createAgentResourceSelection(identities, DEFAULT_AGENT_MAX_STEPS);
};

const selectionResources = (
  input: AgentDefinitionInput,
  registryKind: 'production' | 'planner',
): string[] => {
  const resources = [`model:openrouter:${PROFILE.id}`];
  if (input.agentInstructions !== undefined) resources.push('instruction:workspace-agents');
  if (input.skillCatalog.manifest !== undefined) {
    resources.push('instruction:project-skill-manifest');
  }
  for (const skill of input.skillCatalog.skills) resources.push(`skill:${skill.name}`);
  if (registryKind === 'production') {
    resources.push(
      'tool:bash',
      'tool:delegate_to_planner',
      'tool:edit',
      'tool:read',
      'tool:submit_json_result',
      'tool:write',
    );
    if (input.skillCatalog.skills.length > 0) resources.push('tool:skill');
    resources.push('subagent:planner');
  } else {
    resources.push('instruction:builtin-planner-policy', 'tool:read');
    if (input.skillCatalog.skills.length > 0) resources.push('tool:skill');
    resources.push('tool:submit_json_result');
  }
  return resources;
};

/**
 * The sole normal-runtime Agent Definition. It only projects already-resolved host inputs and
 * performs no filesystem, credential, network, tool, session, event, or UI work.
 */
export const defaultAgentDefinition: AgentDefinition = (input) => ({
  model: { provider: 'openrouter', profile: PROFILE },
  registry: {
    kind: 'production',
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
    plannerDelegation: true,
  },
  agentInstructions: input.agentInstructions,
  skillCatalog: input.skillCatalog,
  systemInstruction: composeSystemInstruction(input.agentInstructions, input.skillCatalog.manifest),
  resourceSelection: canonicalSelection(selectionResources(input, 'production')),
});

/**
 * The sole built-in planning Definition. It only projects host-resolved snapshots and changes the
 * model capability declaration; it does not itself perform filesystem or tool work.
 */
export const plannerAgentDefinition: AgentDefinition = (input) => ({
  model: { provider: 'openrouter', profile: PROFILE },
  registry: {
    kind: 'planner',
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
  },
  agentInstructions: input.agentInstructions,
  skillCatalog: input.skillCatalog,
  systemInstruction: composeSystemInstruction(
    composeSystemInstruction(input.agentInstructions, input.skillCatalog.manifest),
    PLANNER_AGENT_INSTRUCTION,
  ),
  resourceSelection: canonicalSelection(selectionResources(input, 'planner')),
});
