import type { ProcessExecutor } from '../runtime/process_contract.ts';
import {
  createCharacterCountTool,
  createFixtureTool,
  createJsonArrayCountTool,
  createJsonObjectKeysTool,
  createJsonResultSubmissionTool,
  Registry,
} from './tools.ts';
import { createWorkTools, type Workspace, type WorkToolSeams } from './work_tools.ts';
import { createBashOutputStore } from './bash_output.ts';

const FIXED_JSON_PATH = 'deno.v0.json';

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

/**
 * Explicit work-tools-only registry for the fixed offline sentinel. It is not a production
 * Definition materializer.
 */
export const createWorkToolsRegistry = (
  workspace: Workspace,
  processExecutor: ProcessExecutor,
  seams: WorkToolSeams = {},
): Registry => {
  const outputStore = seams.bashOutputStore ?? createBashOutputStore();
  return new Registry([
    ...createWorkTools(workspace, processExecutor, outputStore, seams),
    createJsonResultSubmissionTool(),
  ], outputStore);
};
