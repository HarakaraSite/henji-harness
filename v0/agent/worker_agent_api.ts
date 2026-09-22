import {
  type AgentCapabilityDeclaration,
  type AgentDefinitionInput,
  type AgentDefinitionLimits,
  defaultAgentDefinition,
  plannerAgentDefinition,
  type ResolvedAgentDefinition,
} from './definitions/agent_definition.ts';
import type { AgentEventSink } from './core/events.ts';
import type { Model } from './core/contracts.ts';
import { createDeclaredRegistry } from './tools/registries.ts';
import type { Registry } from './tools/tools.ts';
import type { SkillCatalog } from './definitions/skills.ts';
import type { Workspace, WorkToolSeams } from './tools/work_tools.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/worker_protocol.ts';
import {
  compareAgentResourceIdentities,
  createAgentResourceSelection,
  validateAgentResourceSelection,
} from './definitions/resource_identity.ts';
import type { AgentResourceIdentity } from './definitions/resource_identity.ts';
import {
  type BuiltinInstructionRole,
  resolveBuiltinDefinitionInstruction,
} from './instructions/compose.ts';
import type { ToolComponent } from './tools/tool_components.ts';
import type { WebSearchBackend } from './tools/web_search.ts';
import type { InstructionComponent } from './instructions/component.ts';
import type {
  HenjiInstructionRevisionRef,
  ToolDefinitionRevisionRef,
} from './definitions/managed_resource_ref.ts';
import {
  type ModelSelection,
  ROOT_DEFAULT_MODEL_SELECTION,
} from './provider/openrouter_model_catalog.ts';
import type { AuthProfileId, CredentialAvailabilityStatus } from './provider/model_selection.ts';
import type { ProviderRequestFn } from './provider/auxiliary_request.ts';

export { type ToolComponent } from './tools/tool_components.ts';
export { createAgentResourceIdentity } from './definitions/resource_identity.ts';
export {
  type ProviderHttpRequest,
  type ProviderHttpResponse,
  type ProviderRequestFn,
} from './provider/auxiliary_request.ts';
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
  /** Credential-resolving provider request seam for tool Definitions; returns raw bytes. */
  readonly requestProvider?: ProviderRequestFn;
  /** Worker-local metadata probe. It never returns credential material. */
  readonly credentialAvailability?: (
    authProfile: AuthProfileId,
  ) => Promise<CredentialAvailabilityStatus>;
}

/** Worker-resolved input for one executable tool Definition module. */
export interface WorkerToolDefinitionInput {
  readonly workspace: Workspace;
  readonly skillCatalog: SkillCatalog;
  readonly physicalIo: PhysicalIoBindings;
}

/** A tool Definition module evaluates to one tool component for its declared identity. */
export type ExecutableToolDefinition = (
  input: WorkerToolDefinitionInput,
) => ToolComponent;

/** One Host/Worker-resolved tool Definition module for a declared tool identity. */
export interface AgentToolDefinitionModule {
  readonly toolIdentity: string;
  readonly ref: ToolDefinitionRevisionRef;
  readonly definition: ExecutableToolDefinition;
}

/** Data and Worker-local factories supplied to an executable Definition. */
export interface ExecutableAgentDefinitionInput {
  readonly workspace: Workspace;
  readonly agentInstructions?: string;
  readonly skillCatalog: SkillCatalog;
  readonly physicalIo: PhysicalIoBindings;
  /** Host/Worker-resolved tool Definition components for declared tool identities. */
  readonly toolDefinitions?: readonly ToolComponent[];
}

export interface AgentCompositionOptions {
  readonly limits?: Partial<AgentDefinitionLimits>;
  readonly eventSink?: AgentEventSink;
  /**
   * Additional `tool:<name>` identities declared by this Definition, on top of the bundled
   * default declaration. The Host resolves and supplies matching tool Definition components.
   */
  readonly additionalTools?: readonly AgentResourceIdentity[];
}

export interface WorkerAgentManifest {
  readonly role: 'parent' | 'planner';
  readonly maxSteps: number;
  readonly profileId: string;
  readonly resources: readonly string[];
  readonly rootModel: ModelSelection;
  /** Exact tool Definition revisions composed into the root composition. */
  readonly tools?: readonly {
    readonly toolIdentity: string;
    readonly ref: ToolDefinitionRevisionRef;
  }[];
  readonly baseInstruction?: {
    readonly slot: 'instruction:henji-base';
    readonly selectionSource: 'built-in' | 'external';
    readonly ref: HenjiInstructionRevisionRef;
    readonly contentDigest: string;
  };
}

export interface WorkerAgentComposition {
  readonly role: 'parent' | 'planner';
  readonly model: Model;
  readonly registry: Registry;
  readonly maxSteps: number;
  readonly systemInstruction?: string;
  /** Built-in named boundaries; external Definitions remain opaque when omitted. */
  readonly instructionComponents?: readonly InstructionComponent[];
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

/**
 * Record the exact tool Definition revisions actually composed into a root composition. Only
 * identities declared by the Definition are attributed; no separate authority is created.
 */
export const finalizeWorkerToolAttribution = (
  composition: WorkerAgentComposition,
  tools: readonly {
    readonly toolIdentity: string;
    readonly ref: ToolDefinitionRevisionRef;
  }[],
): WorkerAgentComposition => {
  const declared = new Set(composition.resolved.capabilities.tools.map(String));
  const attributed = tools.filter((tool) => declared.has(tool.toolIdentity));
  if (attributed.length === 0) return composition;
  return Object.freeze({
    ...composition,
    manifest: Object.freeze({
      ...composition.manifest,
      tools: Object.freeze(attributed.map((tool) =>
        Object.freeze({
          toolIdentity: tool.toolIdentity,
          ref: structuredClone(tool.ref),
        })
      )),
    }),
  });
};

const manifestFor = (
  role: 'parent' | 'planner',
  capabilities: AgentCapabilityDeclaration,
  maxSteps: number,
  modelResource: string,
  profileId: string,
  rootModel: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION,
): WorkerAgentManifest => ({
  role,
  maxSteps,
  profileId,
  resources: Object.freeze([
    modelResource,
    ...capabilities.instructions.map(String),
    ...capabilities.skills.map(String),
    ...capabilities.tools.map(String),
  ].sort()),
  rootModel: Object.freeze(structuredClone(rootModel)),
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

const compositionComponents = (
  role: BuiltinInstructionRole,
  input: ExecutableAgentDefinitionInput,
  registry: Registry,
): readonly InstructionComponent[] =>
  resolveBuiltinDefinitionInstruction(
    role,
    input.workspace.root,
    input.agentInstructions,
    input.skillCatalog,
    registry.promptGuidelines(),
  ).components;

/**
 * Standard composition used by built-in and external Definitions. The caller chooses to use this
 * factory inside the Worker; Host-side capability IDs are not an external Definition allowlist.
 */
export const createDefaultAgentComposition = (
  input: ExecutableAgentDefinitionInput,
  options: AgentCompositionOptions = {},
): WorkerAgentComposition => {
  const resolved = defaultAgentDefinition(definitionInput(input));
  const additionalTools = options.additionalTools ?? [];
  const capabilities = additionalTools.length === 0 ? resolved.capabilities : Object.freeze({
    ...resolved.capabilities,
    tools: Object.freeze([...resolved.capabilities.tools, ...additionalTools]),
  });
  const resourceIdentities = additionalTools.length === 0
    ? resolved.resourceSelection.resources.map(String)
    : (() => {
      const identities = [
        ...resolved.resourceSelection.resources,
        ...additionalTools,
      ];
      identities.sort(compareAgentResourceIdentities);
      return identities
        .filter((identity, index) =>
          index === 0 || compareAgentResourceIdentities(identities[index - 1], identity) !== 0
        )
        .map(String);
    })();
  const maxSteps = maxStepsFor(resolved.limits, options);
  const providedToolDefinitions: ToolComponent[] = [...(input.toolDefinitions ?? [])];
  const registry = createDeclaredRegistry(capabilities, {
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
    workTools: input.physicalIo.workTools,
    webSearchBackend: input.physicalIo.webSearchBackend,
    ...(providedToolDefinitions.length === 0 ? {} : { toolDefinitions: providedToolDefinitions }),
  });
  const systemInstruction = compositionInstruction(
    'default',
    input,
    registry,
  );
  const instructionComponents = compositionComponents('default', input, registry);
  const modelResource = `model:${resolved.model.provider}:${resolved.model.profile.id}`;
  const effectiveResolved = Object.freeze({
    ...resolved,
    capabilities,
    systemInstruction,
    limits: Object.freeze({ maxSteps }),
    resourceSelection: createAgentResourceSelection(
      resourceIdentities,
      maxSteps,
    ),
  });
  return Object.freeze({
    role: 'parent' as const,
    model: input.physicalIo.createModel('parent'),
    registry,
    maxSteps,
    systemInstruction,
    instructionComponents,
    manifest: manifestFor(
      'parent',
      capabilities,
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
    ...(input.toolDefinitions === undefined ? {} : { toolDefinitions: input.toolDefinitions }),
  });
  const systemInstruction = compositionInstruction(
    'planner',
    input,
    registry,
  );
  const instructionComponents = compositionComponents('planner', input, registry);
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
    instructionComponents,
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
