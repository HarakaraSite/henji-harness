import {
  type AgentDefinitionInput,
  type AgentDefinitionLimits,
  defaultAgentDefinition,
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
  createAgentResourceIdentity,
  createAgentResourceSelection,
  validateAgentResourceSelection,
} from './definitions/resource_identity.ts';
import type { AgentResourceIdentity } from './definitions/resource_identity.ts';
import { applyDeclaredToolFilter } from './definitions/tool_filter.ts';
import { resolveBuiltinDefinitionInstruction } from './instructions/compose.ts';
import type { ToolComponent } from './tools/tool_components.ts';
import type { WebSearchBackend } from './tools/web_search.ts';
import { defineInstructionComponent, type InstructionComponent } from './instructions/component.ts';
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
import type { AsyncAgentRpc } from './tools/async_agents.ts';

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
    role: 'parent',
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
  /** Worker-local async child agent request seam. */
  readonly asyncAgentRpc?: AsyncAgentRpc;
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
  /** Host-resolved names of managed async Agents available to this generation. */
  readonly asyncAgentNames?: readonly string[];
  /** Spawn-time tool filter (bare tool names) narrowing the declared tool set. */
  readonly toolFilter?: readonly string[];
}

export interface AgentCompositionOptions {
  readonly limits?: Partial<AgentDefinitionLimits>;
  readonly eventSink?: AgentEventSink;
  /**
   * Additional `tool:<name>` identities declared by this Definition, on top of the bundled
   * default declaration. The Host resolves and supplies matching tool Definition components.
   */
  readonly additionalTools?: readonly AgentResourceIdentity[];
  /** Replace the built-in role text while retaining tool/workspace/skill/runtime composition. */
  readonly roleInstruction?: string;
  /** Exact tool declaration for this Definition; omitted uses the bundled default set. */
  readonly tools?: readonly AgentResourceIdentity[];
  /** Exact async Agent declaration; omitted uses the available managed catalog. */
  readonly asyncAgents?: readonly AgentResourceIdentity[];
}

export interface WorkerAgentManifest {
  readonly role: 'parent';
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
  readonly role: 'parent';
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
    throw new Error(
      'Worker Definition returned an incoherent root composition',
    );
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
  role: 'parent',
  resources: readonly AgentResourceIdentity[],
  maxSteps: number,
  profileId: string,
  rootModel: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION,
): WorkerAgentManifest => ({
  role,
  maxSteps,
  profileId,
  resources: Object.freeze(resources.map(String).sort()),
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
  asyncAgentNames: input.asyncAgentNames,
});

const instructionFor = (
  input: ExecutableAgentDefinitionInput,
  registry: Registry,
  roleInstruction?: string,
): {
  readonly components: readonly InstructionComponent[];
  readonly systemInstruction: string;
} => {
  const builtin = resolveBuiltinDefinitionInstruction(
    input.workspace.root,
    input.agentInstructions,
    input.skillCatalog,
    registry.promptGuidelines(),
  );
  if (roleInstruction === undefined) return builtin;
  const components = Object.freeze([
    defineInstructionComponent(
      'instruction:external-agent-role',
      roleInstruction,
    ),
    ...builtin.components.slice(1),
  ]);
  return Object.freeze({
    components,
    systemInstruction: components.map((component) => component.text).join(
      '\n\n',
    ),
  });
};

/**
 * Standard composition used by built-in and external Definitions. The caller chooses to use this
 * factory inside the Worker; Host-side capability IDs are not an external Definition allowlist.
 */
export const createAgentComposition = (
  input: ExecutableAgentDefinitionInput,
  options: AgentCompositionOptions = {},
): WorkerAgentComposition => {
  const resolved = defaultAgentDefinition(definitionInput(input));
  const tools = applyDeclaredToolFilter(
    Object.freeze([
      ...(options.tools ?? resolved.capabilities.tools),
      ...(options.additionalTools ?? []),
    ]),
    input.toolFilter,
  );
  const asyncAgents = options.asyncAgents ?? resolved.capabilities.asyncAgents;
  const roleInstructions = options.roleInstruction === undefined
    ? resolved.capabilities.instructions
    : Object.freeze([
      createAgentResourceIdentity('instruction:external-agent-role'),
      ...resolved.capabilities.instructions.slice(1),
    ]);
  const capabilities = Object.freeze({
    ...resolved.capabilities,
    instructions: Object.freeze([...roleInstructions]),
    tools: Object.freeze([...tools]),
    asyncAgents: Object.freeze([...asyncAgents]),
  });
  const resourceIdentities = [
    createAgentResourceIdentity(
      `model:${resolved.model.provider}:${resolved.model.profile.id}`,
    ),
    ...capabilities.instructions,
    ...capabilities.skills,
    ...capabilities.tools,
    ...capabilities.asyncAgents,
  ];
  resourceIdentities.sort(compareAgentResourceIdentities);
  const uniqueResourceIdentities = resourceIdentities.filter((
    identity,
    index,
  ) =>
    index === 0 ||
    compareAgentResourceIdentities(resourceIdentities[index - 1], identity) !==
      0
  );
  const maxSteps = maxStepsFor(resolved.limits, options);
  const providedToolDefinitions: ToolComponent[] = [
    ...(input.toolDefinitions ?? []),
  ];
  const registry = createDeclaredRegistry(capabilities, {
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
    workTools: input.physicalIo.workTools,
    webSearchBackend: input.physicalIo.webSearchBackend,
    ...(input.physicalIo.asyncAgentRpc === undefined
      ? {}
      : { asyncAgentRpc: input.physicalIo.asyncAgentRpc }),
    ...(providedToolDefinitions.length === 0 ? {} : { toolDefinitions: providedToolDefinitions }),
  });
  const { systemInstruction, components: instructionComponents } = instructionFor(
    input,
    registry,
    options.roleInstruction,
  );
  const effectiveResolved = Object.freeze({
    ...resolved,
    capabilities,
    systemInstruction,
    limits: Object.freeze({ maxSteps }),
    resourceSelection: createAgentResourceSelection(
      uniqueResourceIdentities.map(String),
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
      effectiveResolved.resourceSelection.resources,
      maxSteps,
      resolved.model.profile.id,
    ),
    resolved: effectiveResolved,
  });
};

/** Standard bundled fallback; external Definitions can use createAgentComposition. */
export const createDefaultAgentComposition = (
  input: ExecutableAgentDefinitionInput,
  options: AgentCompositionOptions = {},
): WorkerAgentComposition => createAgentComposition(input, options);
