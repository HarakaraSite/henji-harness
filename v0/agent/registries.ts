import {
  createCharacterCountTool,
  createFixtureTool,
  createJsonArrayCountTool,
  createJsonObjectKeysTool,
  createJsonResultSubmissionTool,
  Registry,
  type Tool,
} from './tools.ts';
import { createWorkTools, type Workspace, type WorkToolSeams } from './work_tools.ts';
import { createSkillTool, type SkillCatalog } from './skills.ts';

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
  seams: WorkToolSeams = {},
  skillCatalog?: SkillCatalog,
): Registry =>
  new Registry(
    [
      ...createWorkTools(workspace, seams),
      ...(skillCatalog !== undefined && skillCatalog.skills.length > 0
        ? [createSkillTool(skillCatalog)]
        : []),
      createJsonResultSubmissionTool(),
    ] as readonly Tool[],
  );
