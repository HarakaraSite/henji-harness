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
  createReadTool,
  createWorkTools,
  type Workspace,
  type WorkToolSeams,
} from './work_tools.ts';
import { createSkillTool, type SkillCatalog } from './skills.ts';
import {
  createPlannerDelegationTool,
  type PlannerDelegationHandler,
} from './planner_delegation.ts';

export const FIXED_JSON_PATH = 'deno.v0.json';

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
