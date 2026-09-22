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
import { createSkillTool, type SkillCatalog } from '../definitions/skills.ts';
import type { AgentCapabilityDeclaration } from '../definitions/agent_definition.ts';
import type { AgentResourceIdentity } from '../definitions/resource_identity.ts';
import { type BashOutputStore, createBashOutputStore } from './bash_output.ts';
import type { ToolComponent } from './tool_components.ts';
import type { WebSearchBackend } from './web_search.ts';

export const FIXED_JSON_PATH = 'deno.v0.json';

/** Host-owned values needed to turn declarative capability identities into executable tools. */
export interface RegistryMaterializationContext {
  readonly workspace: Workspace;
  readonly skillCatalog: SkillCatalog;
  readonly workTools?: WorkToolSeams;
  readonly bashOutputStore?: BashOutputStore;
  readonly webSearchBackend?: WebSearchBackend;
  /** Tool Definition components for identities resolved by the Host/Worker. */
  readonly toolDefinitions?: readonly ToolComponent[];
  /** Internal lookup for Definition-provided tool components. */
  readonly toolDefinitionComponents?: ReadonlyMap<string, ToolComponent>;
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
  const defined = context.toolDefinitionComponents?.get(`${identity}`);
  if (defined !== undefined) {
    const outputStore = context.bashOutputStore ?? context.workTools?.bashOutputStore ??
      createBashOutputStore();
    const tool = defined.materialize({
      workspace: context.workspace,
      workTools: context.workTools ?? {},
      bashOutputStore: outputStore,
      webSearchBackend: context.webSearchBackend,
    });
    const value = `${identity}`;
    const name = value.startsWith('tool:') ? value.slice('tool:'.length) : value;
    if (tool.name !== name) {
      throw new Error(`tool Definition component ${identity} materialized ${tool.name}`);
    }
    return tool;
  }
  const value = `${identity}`;
  switch (value) {
    case 'tool:skill':
      if (context.skillCatalog.skills.length === 0) return materializationFailure(identity);
      return createSkillTool(context.skillCatalog);
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
 */
export const createDeclaredRegistry = (
  declaration: AgentCapabilityDeclaration,
  context: RegistryMaterializationContext,
): Registry => {
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
  const outputStore = context.bashOutputStore ?? context.workTools?.bashOutputStore ??
    createBashOutputStore();
  const toolDefinitionComponents = new Map<string, ToolComponent>(
    (context.toolDefinitions ?? []).map((component) =>
      [`${component.identity}`, component] as const
    ),
  );
  const materializationContext = {
    ...context,
    bashOutputStore: outputStore,
    toolDefinitionComponents,
  };
  const tools = declaration.tools.map((identity) =>
    createDeclaredTool(identity, materializationContext)
  );
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

/**
 * Explicit work-tools-only registry for the fixed offline sentinel. It is not a production
 * Definition materializer.
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
