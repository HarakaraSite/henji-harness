import { type AgentResourceIdentity, createAgentResourceIdentity } from './resource_identity.ts';
import type { Tool } from './tools.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type Workspace,
  type WorkToolSeams,
} from './work_tools.ts';
import { type BashOutputStore, createBashOutputTool } from './bash_output.ts';

const workToolNames = Object.freeze(
  [
    'bash',
    'bash_output',
    'edit',
    'read',
    'write',
  ] as const,
);

export type WorkToolName = typeof workToolNames[number];

/** Worker-local runtime values supplied when one selected work component becomes a Tool. */
export interface ToolComponentBindings {
  readonly workspace: Workspace;
  readonly workTools: WorkToolSeams;
  readonly bashOutputStore: BashOutputStore;
}

/** Executable work-tool component. Functions stay inside the Worker and never enter manifests. */
export interface ToolComponent {
  readonly identity: AgentResourceIdentity;
  materialize(bindings: ToolComponentBindings): Tool;
}

const identityFor = (name: WorkToolName): AgentResourceIdentity =>
  createAgentResourceIdentity(`tool:${name}`);

const component = (
  name: WorkToolName,
  materialize: (bindings: ToolComponentBindings) => Tool,
): ToolComponent => Object.freeze({ identity: identityFor(name), materialize });

/** Built-in components are thin wrappers around the existing work-tool factories. */
export const builtinToolComponents = (): readonly ToolComponent[] =>
  Object.freeze([
    component('bash', (bindings) =>
      createBashTool(
        bindings.workspace,
        bindings.bashOutputStore,
        bindings.workTools.bash ?? {},
      )),
    component('bash_output', (bindings) => createBashOutputTool(bindings.bashOutputStore)),
    component('edit', (bindings) => createEditTool(bindings.workspace, bindings.workTools)),
    component('read', (bindings) => createReadTool(bindings.workspace)),
    component('write', (bindings) => createWriteTool(bindings.workspace, bindings.workTools)),
  ]);

const selectedWorkToolName = (identity: AgentResourceIdentity): WorkToolName | undefined => {
  const value = `${identity}`;
  return workToolNames.find((name) => value === `tool:${name}`);
};

/** Fixed built-in catalog with explicit same-identity replacement for selected root tools. */
export class ToolComponentCatalog {
  private readonly byIdentity: ReadonlyMap<string, ToolComponent>;

  constructor(replacements: readonly ToolComponent[] = []) {
    const entries = new Map(
      builtinToolComponents().map((candidate) => [`${candidate.identity}`, candidate]),
    );
    const replaced = new Set<string>();
    for (const replacement of replacements) {
      const identity = `${replacement.identity}`;
      if (!entries.has(identity) || replaced.has(identity)) {
        throw new Error(`invalid work tool component replacement: ${identity}`);
      }
      entries.set(identity, replacement);
      replaced.add(identity);
    }
    this.byIdentity = entries;
  }

  materialize(identity: AgentResourceIdentity, bindings: ToolComponentBindings): Tool {
    const name = selectedWorkToolName(identity);
    const selected = this.byIdentity.get(`${identity}`);
    if (name === undefined || selected === undefined) {
      throw new Error(`unsupported work tool component: ${identity}`);
    }
    const tool = selected.materialize(bindings);
    if (tool.name !== name) {
      throw new Error(`work tool component ${identity} materialized ${tool.name}`);
    }
    return tool;
  }
}

export const isWorkToolComponentIdentity = (
  identity: AgentResourceIdentity,
): boolean => selectedWorkToolName(identity) !== undefined;
