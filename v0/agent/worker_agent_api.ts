import {
  type AgentCapabilityDeclaration,
  type AgentDefinitionInput,
  type AgentDefinitionLimits,
  defaultAgentDefinition,
  plannerAgentDefinition,
  type ResolvedAgentDefinition,
} from './agent_definition.ts';
import type { AgentEventSink } from './events.ts';
import type { LoopOutcome, Model } from './contracts.ts';
import { createDeclaredRegistry } from './registries.ts';
import type { Registry } from './tools.ts';
import type { SkillCatalog } from './skills.ts';
import type { Workspace, WorkToolSeams } from './work_tools.ts';
import type { ChildTurnExecutionContext } from './execution_context.ts';
import { runAgent } from './loop.ts';
import { WORKER_PROTOCOL_VERSION } from './worker_protocol.ts';
import { createAgentResourceSelection } from './resource_identity.ts';

export { WORKER_PROTOCOL_VERSION };
export type { AgentEventSink };

/** Worker-local physical construction seam; no value from this interface crosses postMessage. */
export interface PhysicalIoBindings {
  readonly createModel: (role: 'parent' | 'planner') => Model;
  readonly workTools?: WorkToolSeams;
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
}

export interface WorkerAgentManifest {
  readonly role: 'parent' | 'planner';
  readonly maxSteps: number;
  readonly profileId: string;
  readonly resources: readonly string[];
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

const manifestFor = (
  role: 'parent' | 'planner',
  capabilities: AgentCapabilityDeclaration,
  maxSteps: number,
  modelResource: string,
  profileId: string,
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
  const outcome = await runAgent(
    task,
    input.physicalIo.createModel('planner'),
    plannerRegistry,
    {
      maxSteps: planner.limits.maxSteps,
      systemInstruction: planner.systemInstruction,
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
  });
  const modelResource = `model:${resolved.model.provider}:${resolved.model.profile.id}`;
  const effectiveResolved = Object.freeze({
    ...resolved,
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
    systemInstruction: resolved.systemInstruction,
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
  const modelResource = `model:${resolved.model.provider}:${resolved.model.profile.id}`;
  const effectiveResolved = Object.freeze({
    ...resolved,
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
    systemInstruction: resolved.systemInstruction,
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
