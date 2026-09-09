import {
  type AgentCapabilityDeclaration,
  type AgentDefinitionInput,
  type AgentDefinitionLimits,
  defaultAgentDefinition,
  plannerAgentDefinition,
  type ResolvedAgentDefinition,
} from './definitions/agent_definition.ts';
import type { AgentEventSink } from './core/events.ts';
import type { LoopOutcome, Model } from './core/contracts.ts';
import { createDeclaredRegistry } from './tools/registries.ts';
import type { Registry } from './tools/tools.ts';
import type { SkillCatalog } from './definitions/skills.ts';
import type { Workspace, WorkToolSeams } from './tools/work_tools.ts';
import type { ChildTurnExecutionContext } from './core/execution_context.ts';
import { runAgent } from './core/loop.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/worker_protocol.ts';
import {
  createAgentResourceSelection,
  validateAgentResourceSelection,
} from './definitions/resource_identity.ts';
import {
  type BuiltinInstructionRole,
  resolveBuiltinDefinitionInstruction,
} from './instructions/compose.ts';
import type { ToolComponent } from './tools/tool_components.ts';
import type { WebSearchBackend } from './tools/web_search.ts';
import {
  type ModelSelection,
  PLANNER_DEFAULT_MODEL_SELECTION,
  ROOT_DEFAULT_MODEL_SELECTION,
} from './provider/openrouter_model_catalog.ts';

export { type ToolComponent, ToolComponentCatalog } from './tools/tool_components.ts';
export { createAgentResourceIdentity } from './definitions/resource_identity.ts';
export {
  createProviderFreeWebSearchBackend,
  OpenRouterSonarWebSearchBackend,
  type OpenRouterSonarWebSearchBackendOptions,
  type WebSearchBackend,
  type WebSearchResult,
  type WebSearchSource,
} from './tools/web_search.ts';

export { WORKER_PROTOCOL_VERSION };
export type { AgentEventSink };

/** Worker-local physical construction seam; no value from this interface crosses postMessage. */
export interface PhysicalIoBindings {
  readonly createModel: (
    role: 'parent' | 'planner',
    selection?: ModelSelection,
  ) => Model;
  readonly workTools?: WorkToolSeams;
  readonly webSearchBackend?: WebSearchBackend;
}

/** Data and Worker-local factories supplied to an executable Definition. */
export interface ExecutableAgentDefinitionInput {
  readonly workspace: Workspace;
  readonly agentInstructions?: string;
  readonly skillCatalog: SkillCatalog;
  readonly physicalIo: PhysicalIoBindings;
}

export interface AgentCompositionOptions {
  readonly limits?: Partial<AgentDefinitionLimits>;
  readonly eventSink?: AgentEventSink;
  /** Same-identity work-tool replacements applied only to the returned root composition. */
  readonly toolComponents?: readonly ToolComponent[];
}

export interface WorkerAgentManifest {
  readonly role: 'parent' | 'planner';
  readonly maxSteps: number;
  readonly profileId: string;
  readonly resources: readonly string[];
  readonly rootModel: ModelSelection;
  readonly plannerModel: ModelSelection;
}

export interface WorkerAgentComposition {
  readonly role: 'parent' | 'planner';
  readonly model: Model;
  readonly registry: Registry;
  readonly maxSteps: number;
  readonly systemInstruction?: string;
  readonly manifest: WorkerAgentManifest;
  readonly resolved: ResolvedAgentDefinition;
}

export type ExecutableAgentDefinition = (
  input: ExecutableAgentDefinitionInput,
) => WorkerAgentComposition;

const assertCoherentRootComposition = (
  composition: WorkerAgentComposition,
): void => {
  const selection = validateAgentResourceSelection(
    composition.resolved.resourceSelection,
  );
  if (
    !Number.isSafeInteger(composition.maxSteps) || composition.maxSteps <= 0 ||
    composition.resolved.limits.maxSteps !== composition.maxSteps ||
    selection.parameters.maxSteps !== composition.maxSteps ||
    composition.manifest.maxSteps !== composition.maxSteps ||
    composition.manifest.role !== composition.role
  ) {
    throw new Error('Worker Definition returned an incoherent root composition');
  }
};

/** Apply a Host-requested limit only to the returned root composition. */
export const finalizeRootAgentComposition = (
  composition: WorkerAgentComposition,
  requestedMaxSteps?: number,
): WorkerAgentComposition => {
  if (requestedMaxSteps === undefined) {
    assertCoherentRootComposition(composition);
    return composition;
  }
  if (!Number.isSafeInteger(requestedMaxSteps) || requestedMaxSteps <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }
  const resolved = Object.freeze({
    ...composition.resolved,
    limits: Object.freeze({ maxSteps: requestedMaxSteps }),
    resourceSelection: createAgentResourceSelection(
      composition.resolved.resourceSelection.resources.map(String),
      requestedMaxSteps,
    ),
  });
  const finalized = Object.freeze({
    ...composition,
    maxSteps: requestedMaxSteps,
    manifest: Object.freeze({
      ...composition.manifest,
      maxSteps: requestedMaxSteps,
    }),
    resolved,
  });
  assertCoherentRootComposition(finalized);
  return finalized;
};

const manifestFor = (
  role: 'parent' | 'planner',
  capabilities: AgentCapabilityDeclaration,
  maxSteps: number,
  modelResource: string,
  profileId: string,
  rootModel: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION,
  plannerModel: ModelSelection = PLANNER_DEFAULT_MODEL_SELECTION,
): WorkerAgentManifest => ({
  role,
  maxSteps,
  profileId,
  resources: Object.freeze([
    modelResource,
    ...capabilities.instructions.map(String),
    ...capabilities.skills.map(String),
    ...capabilities.tools.map(String),
    ...capabilities.subagents.map(String),
  ].sort()),
  rootModel: Object.freeze(structuredClone(rootModel)),
  plannerModel: Object.freeze(structuredClone(plannerModel)),
});

const maxStepsFor = (
  definition: AgentDefinitionLimits,
  options: AgentCompositionOptions,
): number => {
  const maxSteps = options.limits?.maxSteps ?? definition.maxSteps;
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }
  return maxSteps;
};

const definitionInput = (
  input: ExecutableAgentDefinitionInput,
): AgentDefinitionInput => ({
  workspace: input.workspace,
  agentInstructions: input.agentInstructions,
  skillCatalog: input.skillCatalog,
});

const compositionInstruction = (
  role: BuiltinInstructionRole,
  input: ExecutableAgentDefinitionInput,
  registry: Registry,
): string =>
  resolveBuiltinDefinitionInstruction(
    role,
    input.workspace.root,
    input.agentInstructions,
    input.skillCatalog,
    registry.promptGuidelines(),
  ).systemInstruction;

const createPlannerHandler = (
  input: ExecutableAgentDefinitionInput,
  planner: ResolvedAgentDefinition,
) =>
async (task: string, childContext: ChildTurnExecutionContext): Promise<{
  readonly outcome: LoopOutcome;
  readonly externalRequests: number;
}> => {
  const requestCountBefore = childContext.providerRequestCount?.() ?? 0;
  const plannerRegistry = createDeclaredRegistry(planner.capabilities, {
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
    workTools: input.physicalIo.workTools,
  });
  const systemInstruction = compositionInstruction(
    'planner',
    input,
    plannerRegistry,
  );
  const outcome = await runAgent(
    task,
    input.physicalIo.createModel('planner'),
    plannerRegistry,
    {
      maxSteps: planner.limits.maxSteps,
      systemInstruction,
      executionContext: childContext,
      signal: childContext.signal,
      cancellation: childContext.cancellation,
      ownsCancellation: false,
    },
  );
  const requestCountAfter = childContext.providerRequestCount?.() ?? requestCountBefore;
  return {
    outcome,
    externalRequests: Math.max(0, requestCountAfter - requestCountBefore),
  };
};

/**
 * Standard composition used by built-in and external Definitions. The caller chooses to use this
 * factory inside the Worker; Host-side capability IDs are not an external Definition allowlist.
 */
export const createDefaultAgentComposition = (
  input: ExecutableAgentDefinitionInput,
  options: AgentCompositionOptions = {},
): WorkerAgentComposition => {
  const resolved = defaultAgentDefinition(definitionInput(input));
  const planner = plannerAgentDefinition(definitionInput(input));
  const maxSteps = maxStepsFor(resolved.limits, options);
  const plannerHandler = createPlannerHandler(input, planner);
  const registry = createDeclaredRegistry(resolved.capabilities, {
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
    workTools: input.physicalIo.workTools,
    plannerDelegation: plannerHandler,
    toolComponents: options.toolComponents,
    webSearchBackend: input.physicalIo.webSearchBackend,
  });
  const systemInstruction = compositionInstruction(
    'default',
    input,
    registry,
  );
  const modelResource = `model:${resolved.model.provider}:${resolved.model.profile.id}`;
  const effectiveResolved = Object.freeze({
    ...resolved,
    systemInstruction,
    limits: Object.freeze({ maxSteps }),
    resourceSelection: createAgentResourceSelection(
      resolved.resourceSelection.resources.map(String),
      maxSteps,
    ),
  });
  return Object.freeze({
    role: 'parent' as const,
    model: input.physicalIo.createModel('parent'),
    registry,
    maxSteps,
    systemInstruction,
    manifest: manifestFor(
      'parent',
      resolved.capabilities,
      maxSteps,
      modelResource,
      resolved.model.profile.id,
    ),
    resolved: effectiveResolved,
  });
};

/** Worker-local built-in planner composition on the same Definition/registry/model seam. */
export const createPlannerAgentComposition = (
  input: ExecutableAgentDefinitionInput,
  options: AgentCompositionOptions = {},
): WorkerAgentComposition => {
  const resolved = plannerAgentDefinition(definitionInput(input));
  const maxSteps = maxStepsFor(resolved.limits, options);
  const registry = createDeclaredRegistry(resolved.capabilities, {
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
    workTools: input.physicalIo.workTools,
  });
  const systemInstruction = compositionInstruction(
    'planner',
    input,
    registry,
  );
  const modelResource = `model:${resolved.model.provider}:${resolved.model.profile.id}`;
  const effectiveResolved = Object.freeze({
    ...resolved,
    systemInstruction,
    limits: Object.freeze({ maxSteps }),
    resourceSelection: createAgentResourceSelection(
      resolved.resourceSelection.resources.map(String),
      maxSteps,
    ),
  });
  return Object.freeze({
    role: 'planner' as const,
    model: input.physicalIo.createModel('planner'),
    registry,
    maxSteps,
    systemInstruction,
    manifest: manifestFor(
      'planner',
      resolved.capabilities,
      maxSteps,
      modelResource,
      resolved.model.profile.id,
    ),
    resolved: effectiveResolved,
  });
};
