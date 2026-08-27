import { type OpenRouterAgentProfile } from './openrouter_model.ts';
import { PROFILE } from '../model.ts';
import { composeSystemInstruction } from './agent_instructions.ts';
import { type SkillCatalog } from './skills.ts';
import { type Workspace } from './work_tools.ts';

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
  readonly maxSteps: number;
}

export type AgentDefinition = (input: AgentDefinitionInput) => ResolvedAgentDefinition;

/** The finite request bound declared by the normal runtime's default Agent Definition. */
export const DEFAULT_AGENT_MAX_STEPS = 8;

/** Fixed planner policy appended after all discovered workspace context. */
export const PLANNER_AGENT_INSTRUCTION =
  'You are the built-in planner agent. Inspect the available workspace context needed for the task and produce a clear implementation plan. Do not mutate the workspace.';

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
  maxSteps: DEFAULT_AGENT_MAX_STEPS,
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
  maxSteps: DEFAULT_AGENT_MAX_STEPS,
});
