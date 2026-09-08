import type { Tool } from './tools.ts';
import { createBashOutputStore, createBashOutputTool } from './bash_output.ts';
import { createBashTool } from './bash_tool.ts';
import { createEditTool, createReadTool, createWriteTool } from './file_tools.ts';
import type { Workspace, WorkToolSeams } from './work_tool_contract.ts';

export type { BashToolSeams, Workspace, WorkToolSeams } from './work_tool_contract.ts';
export { resolveWorkspace } from './work_tool_workspace.ts';
export { createEditTool, createReadTool, createWriteTool } from './file_tools.ts';
export { createBashTool } from './bash_tool.ts';

export const createWorkTools = (
  workspace: Workspace,
  seams: WorkToolSeams = {},
): readonly Tool[] => {
  const outputStore = seams.bashOutputStore ?? createBashOutputStore();
  return [
    createBashTool(workspace, outputStore, seams.bash ?? {}),
    createBashOutputTool(outputStore),
    createEditTool(workspace, seams),
    createReadTool(workspace),
    createWriteTool(workspace, seams),
  ];
};
