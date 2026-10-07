import {
  type ConfigurationRejection,
  configurationRejection,
} from '../configuration/agent_configuration.ts';
import {
  configurationFileUrl,
  type ToolSelection,
} from '../configuration/configuration_resolver.ts';
import type { ToolFactoryInput } from '../tool_api.ts';
import { type Tool } from '../tools/tools.ts';
import { createSkillTool } from '../definitions/skills.ts';
import { createJsonResultSubmissionTool } from '../tools/tools.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../tools/work_tools.ts';
import { createBashOutputTool } from '../tools/bash_output.ts';
import { createRunTypescriptTool } from '../tools/run_typescript.ts';
import { loadToolPathsConfiguration, type ToolPathsConfiguration } from '../tools/tool_paths.ts';
import { createAgentResourceIdentity } from '../definitions/resource_identity.ts';

const bundledTool = (
  name: string,
  input: ToolFactoryInput,
  configRoot: string | undefined,
): Tool => {
  switch (name) {
    case 'read':
      return createReadTool({ ...input.workspace, pathPolicy: input.pathPolicy });
    case 'write':
      return createWriteTool({ ...input.workspace, pathPolicy: input.pathPolicy }, input.workTools);
    case 'edit':
      return createEditTool({ ...input.workspace, pathPolicy: input.pathPolicy }, input.workTools);
    case 'bash':
      if (input.processExecutor === undefined) throw new Error('process executor is unavailable');
      return createBashTool(
        input.workspace,
        input.processExecutor,
        input.bashOutputStore,
        input.workTools.bash ?? {},
      );
    case 'bash_output':
      return createBashOutputTool(input.bashOutputStore);
    case 'run_typescript': {
      if (input.processExecutor === undefined) throw new Error('process executor is unavailable');
      return createRunTypescriptTool(input.workspace, input.processExecutor, {
        ...(configRoot === undefined ? {} : { configRoot }),
        allowedPaths: input.pathPolicy.allowedPaths,
        deniedPaths: input.pathPolicy.auditDeniedPaths,
      });
    }
    case 'skill':
      return createSkillTool(input.skillCatalog);
    case 'submit_json_result':
      return createJsonResultSubmissionTool();
    default:
      throw new Error(`No bundled implementation for tool ${name}`);
  }
};

const isJson = (value: unknown): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.values(value).every(isJson);
  }
  return false;
};

const validateTool = (value: unknown, name: string): Tool => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('tool factory must return a Tool');
  }
  const tool = value as Tool;
  if (tool.name !== name) throw new Error(`tool factory must return name ${name}`);
  createAgentResourceIdentity(`tool:${name}`);
  if (typeof tool.description !== 'string') throw new Error('Tool.description must be a string');
  if (!isJson(tool.inputSchema)) throw new Error('Tool.inputSchema must be JSON data');
  if (typeof tool.execute !== 'function') throw new Error('Tool.execute must be a function');
  if (
    tool.promptGuidelines !== undefined &&
    (!Array.isArray(tool.promptGuidelines) ||
      tool.promptGuidelines.some((text) => typeof text !== 'string'))
  ) throw new Error('Tool.promptGuidelines must be strings');
  if (!['none', 'read', 'read-write', 'unmanaged'].includes(tool.fileAccess as string)) {
    throw new Error('Tool.fileAccess must be none, read, read-write, or unmanaged');
  }
  if (tool.terminal !== undefined && typeof tool.terminal !== 'boolean') {
    throw new Error('Tool.terminal must be a boolean');
  }
  // Retain one startup declaration together with its executor; later edits cannot mutate it.
  return Object.freeze({
    name: tool.name,
    fileAccess: tool.fileAccess as Tool['fileAccess'],
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...tool.promptGuidelines] }),
    ...(tool.terminal === undefined ? {} : { terminal: tool.terminal }),
    execute: tool.execute.bind(tool),
  });
};

export interface LoadedWorkerTool {
  readonly selection: ToolSelection;
  readonly tool: Tool;
  readonly pathPolicy: ToolFactoryInput['pathPolicy'];
}

/** Imported modules/factories and Tools never cross the Host/Worker boundary. */
export const loadWorkerTools = async (
  selections: readonly ToolSelection[],
  input: Omit<ToolFactoryInput, 'pathPolicy'>,
  bundled: { readonly configRoot?: string; readonly credentialRoot?: string } = {},
): Promise<{
  readonly accepted: readonly LoadedWorkerTool[];
  readonly rejections: readonly ConfigurationRejection[];
  readonly pathConfiguration: ToolPathsConfiguration;
}> => {
  const pathConfiguration = await loadToolPathsConfiguration({
    workspaceRoot: input.workspace.root,
    ...bundled,
  });
  const accepted: LoadedWorkerTool[] = [];
  const rejections: ConfigurationRejection[] = [];
  for (const selection of selections) {
    if (selection.rejection !== undefined) continue;
    // The native skill tool is present only when there is a discovered catalog to read.
    if (
      selection.source === 'bundled' && selection.name === 'skill' &&
      input.skillCatalog.skills.length === 0
    ) continue;
    try {
      const pathPolicy = pathConfiguration.forTool(selection.name);
      const factoryInput: ToolFactoryInput = { ...input, pathPolicy };
      let tool: unknown;
      if (selection.source === 'external') {
        if (selection.entry === undefined) throw new Error('external tool entry is unavailable');
        const module = await import(configurationFileUrl(selection.entry).href);
        if (typeof module.default !== 'function') {
          throw new Error('module default export must be a tool factory');
        }
        tool = await module.default(factoryInput);
      } else {
        tool = bundledTool(selection.name, factoryInput, bundled.configRoot);
      }
      const validated = validateTool(tool, selection.name);
      const configured = validated.fileAccess === 'read' || validated.fileAccess === 'read-write'
        ? Object.freeze({
          ...validated,
          description: validated.description + '\n\nFile access: allow ' +
            JSON.stringify(pathPolicy.allowedPaths) + '; common deny ' +
            JSON.stringify(pathPolicy.deniedPaths) + '.',
        })
        : validated;
      accepted.push(Object.freeze({ selection, tool: configured, pathPolicy }));
    } catch (error) {
      rejections.push(configurationRejection('tool', selection.name, error, selection.entry));
    }
  }
  return Object.freeze({
    pathConfiguration,
    accepted: Object.freeze(accepted),
    rejections: Object.freeze(rejections),
  });
};
