import {
  createCharacterCountTool,
  createFixtureTool,
  createJsonArrayCountTool,
  createJsonObjectKeysTool,
  createJsonResultSubmissionTool,
  Registry,
  type Tool,
} from './tools.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWorkTools,
  createWriteTool,
  type Workspace,
  type WorkToolSeams,
} from './work_tools.ts';
import { createSkillTool, type SkillCatalog } from './skills.ts';
import {
  createPlannerDelegationTool,
  type PlannerDelegationHandler,
} from './planner_delegation.ts';
import type { AgentCapabilityDeclaration } from './agent_definition.ts';
import type { AgentResourceIdentity } from './resource_identity.ts';

export const FIXED_JSON_PATH = 'deno.v0.json';

/** Host-owned values needed to turn declarative capability identities into executable tools. */
export interface RegistryMaterializationContext {
  readonly workspace: Workspace;
  readonly skillCatalog: SkillCatalog;
  readonly workTools?: WorkToolSeams;
  readonly plannerDelegation?: PlannerDelegationHandler;
}

const materializationFailure = (identity: AgentResourceIdentity): never => {
  throw new Error(`unsupported agent capability: ${identity}`);
};

/**
 * Materialize one declared tool identity.  This lookup is intentionally per-capability: the
 * Definition declares membership and order while the host owns workspace/catalog/closures.
 */
export const createDeclaredTool = (
  identity: AgentResourceIdentity,
  context: RegistryMaterializationContext,
): Tool => {
  switch (`${identity}`) {
    case 'tool:bash':
      return createBashTool(context.workspace);
    case 'tool:edit':
      return createEditTool(context.workspace, context.workTools ?? {});
    case 'tool:read':
      return createReadTool(context.workspace);
    case 'tool:write':
      return createWriteTool(context.workspace, context.workTools ?? {});
    case 'tool:skill':
      if (context.skillCatalog.skills.length === 0) return materializationFailure(identity);
      return createSkillTool(context.skillCatalog);
    case 'tool:delegate_to_planner':
      if (context.plannerDelegation === undefined) return materializationFailure(identity);
      return createPlannerDelegationTool(context.plannerDelegation);
    case 'tool:submit_json_result':
      return createJsonResultSubmissionTool();
    default:
      return materializationFailure(identity);
  }
};

const hasIdentity = (
  identities: readonly AgentResourceIdentity[],
  identity: string,
): boolean => identities.some((candidate) => `${candidate}` === identity);

const declaredSkillNames = (
  declaration: AgentCapabilityDeclaration,
): readonly string[] => declaration.skills.map((identity) => `${identity}`.slice('skill:'.length));

/**
 * Materialize a Registry from the effective Definition declaration in declared order.
 * Subagent identities do not create arbitrary runtime plugins; the built-in planner delegation
 * handler is supplied by the host only when the declaration asks for that subagent.
 */
export const createDeclaredRegistry = (
  declaration: AgentCapabilityDeclaration,
  context: RegistryMaterializationContext,
): Registry => {
  for (const subagent of declaration.subagents) {
    if (`${subagent}` !== 'subagent:planner') return materializationFailure(subagent);
  }
  const requiresPlanner = hasIdentity(declaration.subagents, 'subagent:planner');
  const declaresDelegation = hasIdentity(declaration.tools, 'tool:delegate_to_planner');
  if (requiresPlanner !== declaresDelegation) {
    throw new Error('planner delegation declaration is incoherent');
  }
  if (requiresPlanner && context.plannerDelegation === undefined) {
    throw new Error('declared planner subagent requires planner delegation handler');
  }
  if (hasIdentity(declaration.tools, 'tool:skill')) {
    const declared = [...declaredSkillNames(declaration)].sort();
    const materialized = context.skillCatalog.skills.map((skill) => skill.name).sort();
    if (
      declared.length !== materialized.length ||
      declared.some((name, index) => name !== materialized[index])
    ) {
      throw new Error('declared skills do not match host skill catalog');
    }
  }
  const tools = declaration.tools.map((identity) => createDeclaredTool(identity, context));
  return new Registry(tools);
};

/** The exact five definitions used by the versioned corpus and eval runners. */
export const createCorpusRegistry = (
  readFile?: (path: string) => Promise<Uint8Array>,
): Registry =>
  new Registry([
    createCharacterCountTool(),
    createJsonArrayCountTool(),
    createJsonObjectKeysTool({ allowedPath: FIXED_JSON_PATH, readFile }),
    createJsonResultSubmissionTool(),
    createFixtureTool(),
  ]);

/** The normal trusted-local production composition. */
export const createProductionRegistry = (
  workspace: Workspace,
  seams: WorkToolSeams,
  skillCatalog: SkillCatalog,
  plannerDelegation: PlannerDelegationHandler,
): Registry =>
  new Registry(
    [
      ...createWorkTools(workspace, seams),
      ...(skillCatalog.skills.length > 0 ? [createSkillTool(skillCatalog)] : []),
      createPlannerDelegationTool(plannerDelegation),
      createJsonResultSubmissionTool(),
    ] as readonly Tool[],
  );

/**
 * Explicit work-tools-only registry for the fixed offline sentinel. It is not a production
 * Definition materializer and intentionally has no planner delegation capability.
 */
export const createWorkToolsRegistry = (
  workspace: Workspace,
  seams: WorkToolSeams = {},
): Registry =>
  new Registry(
    [
      ...createWorkTools(workspace, seams),
      createJsonResultSubmissionTool(),
    ] as readonly Tool[],
  );

/** The planner capability registry: context reads, optional saved skills, and JSON submission. */
export const createPlannerRegistry = (
  workspace: Workspace,
  skillCatalog: SkillCatalog,
): Registry =>
  new Registry(
    [
      createReadTool(workspace),
      ...(skillCatalog.skills.length > 0 ? [createSkillTool(skillCatalog)] : []),
      createJsonResultSubmissionTool(),
    ] as readonly Tool[],
  );
