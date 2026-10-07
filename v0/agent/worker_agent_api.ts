import type { ProcessExecutor } from './runtime/process_contract.ts';
import type { Model } from './core/contracts.ts';
import { type AsyncAgentRpc, createAsyncAgentTools } from './tools/async_agents.ts';
import { type Registry, Registry as ToolRegistry } from './tools/tools.ts';
import type { SkillCatalog } from './definitions/skills.ts';
import type { Workspace, WorkToolSeams } from './tools/work_tools.ts';
import {
  type AgentResourceIdentity,
  compareAgentResourceIdentities,
  createAgentResourceIdentity,
  createAgentResourceSelection,
} from './definitions/resource_identity.ts';
import type { ToolComponent } from './tools/tool_components.ts';
import type { InstructionComponent } from './instructions/component.ts';
import { resolveCommonInstructionComposition } from './instructions/compose.ts';
import { createBashOutputStore } from './tools/bash_output.ts';
import type { BashOutputStore } from './tools/bash_output.ts';
import {
  type ModelSelection,
  ROOT_DEFAULT_MODEL_SELECTION,
} from './provider/openrouter_model_catalog.ts';
import {
  type AuthProfileId,
  type CredentialAvailabilityStatus,
  modelRouteProfileId,
} from './provider/model_selection.ts';
import type { ProviderRequestFn } from './provider/auxiliary_request.ts';

export type { ToolComponent } from './tools/tool_components.ts';
export type { CredentialDeclarationV1 } from './provider/credential_declaration.ts';
export {
  type ProviderHttpRequest,
  type ProviderHttpResponse,
  type ProviderRequestAuthentication,
  type ProviderRequestFn,
} from './provider/auxiliary_request.ts';
export type {
  ProcessCommand,
  ProcessExecutor,
  ProcessOperation,
  ProcessStatus,
} from './runtime/process_contract.ts';

/** The runtime's default step limit; configuration does not declare executable loop code. */
export const DEFAULT_AGENT_MAX_STEPS = 128;

/** Worker-local physical construction seam; no value from this interface crosses postMessage. */
export interface PhysicalIoBindings {
  readonly processExecutor?: ProcessExecutor;
  readonly createModel: (
    role: 'parent',
    selection?: ModelSelection,
  ) => Model;
  readonly workTools?: WorkToolSeams;
  /** Credential-resolving provider request seam used by tool factories. */
  readonly requestProvider?: ProviderRequestFn;
  /** Worker-local metadata probe. It never returns credential material. */
  readonly credentialAvailability?: (
    authProfile: AuthProfileId,
    registrationId?: string | null,
  ) => Promise<CredentialAvailabilityStatus>;
  /** Worker-local async child-agent request seam. */
  readonly asyncAgentRpc?: AsyncAgentRpc;
}

/** Inputs resolved by the Worker for one JSON Agent configuration. */
export interface WorkerCompositionInput {
  readonly workspace: Workspace;
  /** User config root; bundled tools that read host-owned config receive it here. */
  readonly configRoot?: string;
  readonly credentialRoot?: string;
  readonly agentInstructions?: string;
  readonly skillCatalog: SkillCatalog;
  readonly physicalIo: PhysicalIoBindings;
  /** Accepted concrete tool factories selected for this Worker generation. */
  readonly toolComponents: readonly ToolComponent[];
  /** Names of configured child Agents available through the async-agent tool. */
  readonly asyncAgentNames: readonly string[];
}

export interface WorkerCompositionOptions {
  /** Role text from the selected JSON Agent configuration. An empty value omits its component. */
  readonly roleInstruction: string;
  readonly maxSteps?: number;
  readonly rootModel?: ModelSelection;
}

export interface WorkerAgentCapabilities {
  readonly instructions: readonly AgentResourceIdentity[];
  readonly skills: readonly AgentResourceIdentity[];
  readonly tools: readonly AgentResourceIdentity[];
  readonly asyncAgents: readonly AgentResourceIdentity[];
}

/** Runtime-only projection retained for resource/history accounting inside a Worker. */
export interface WorkerAgentResolvedComposition {
  readonly capabilities: WorkerAgentCapabilities;
  readonly limits: Readonly<{ readonly maxSteps: number }>;
  readonly resourceSelection: ReturnType<typeof createAgentResourceSelection>;
  readonly systemInstruction: string;
}

export interface WorkerAgentManifest {
  readonly role: 'parent';
  readonly maxSteps: number;
  readonly profileId: string;
  readonly resources: readonly string[];
  readonly rootModel: ModelSelection;
  readonly baseInstruction?: {
    readonly slot: 'instruction:henji-base';
    readonly selectionSource: 'built-in' | 'external';
    readonly ref: {
      readonly schemaVersion: 1;
      readonly resourceKind: 'henji-instruction';
      readonly resourceId: string;
      readonly revision: { readonly algorithm: 'sha256'; readonly digest: string };
    };
    readonly contentDigest: string;
  };
}

/** Internal runtime composition; it contains no executable Agent Definition or revision refs. */
export interface WorkerAgentComposition {
  readonly role: 'parent';
  readonly model: Model;
  readonly registry: Registry;
  readonly maxSteps: number;
  readonly systemInstruction?: string;
  readonly instructionComponents?: readonly InstructionComponent[];
  readonly manifest: WorkerAgentManifest;
  readonly resolved: WorkerAgentResolvedComposition;
}

const canonicalIdentities = (
  values: readonly AgentResourceIdentity[],
): readonly AgentResourceIdentity[] => {
  const sorted = [...values].sort(compareAgentResourceIdentities);
  return Object.freeze(sorted.filter((value, index) => index === 0 || value !== sorted[index - 1]));
};

const validMaxSteps = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }
  return value;
};

const manifestFor = (
  resources: readonly AgentResourceIdentity[],
  maxSteps: number,
  rootModel: ModelSelection,
): WorkerAgentManifest => ({
  role: 'parent',
  maxSteps,
  profileId: modelRouteProfileId(rootModel),
  resources: Object.freeze(resources.map(String).sort()),
  rootModel: Object.freeze(structuredClone(rootModel)),
});

const assertCoherentComposition = (composition: WorkerAgentComposition): void => {
  if (
    !Number.isSafeInteger(composition.maxSteps) || composition.maxSteps <= 0 ||
    composition.resolved.limits.maxSteps !== composition.maxSteps ||
    composition.resolved.resourceSelection.parameters.maxSteps !== composition.maxSteps ||
    composition.manifest.maxSteps !== composition.maxSteps ||
    composition.manifest.role !== composition.role
  ) {
    throw new Error('Worker composition is incoherent');
  }
};

/** Apply the runtime limit requested by the Host to one common Worker composition. */
export const finalizeWorkerComposition = (
  composition: WorkerAgentComposition,
  requestedMaxSteps?: number,
): WorkerAgentComposition => {
  if (requestedMaxSteps === undefined) {
    assertCoherentComposition(composition);
    return composition;
  }
  const maxSteps = validMaxSteps(requestedMaxSteps);
  const resolved = Object.freeze({
    ...composition.resolved,
    limits: Object.freeze({ maxSteps }),
    resourceSelection: createAgentResourceSelection(
      composition.resolved.resourceSelection.resources.map(String),
      maxSteps,
    ),
  });
  const finalized = Object.freeze({
    ...composition,
    maxSteps,
    manifest: Object.freeze({ ...composition.manifest, maxSteps }),
    resolved,
  });
  assertCoherentComposition(finalized);
  return finalized;
};

/** Build the shared runtime composition directly from the selected JSON configuration. */
export const createWorkerComposition = (
  input: WorkerCompositionInput,
  options: WorkerCompositionOptions,
): WorkerAgentComposition => {
  const maxSteps = validMaxSteps(options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS);
  const rootModel = options.rootModel ?? ROOT_DEFAULT_MODEL_SELECTION;
  const outputStore: BashOutputStore = input.physicalIo.workTools?.bashOutputStore ??
    createBashOutputStore();
  const workTools = Object.freeze({
    ...input.physicalIo.workTools,
    bashOutputStore: outputStore,
  });
  const bindings = Object.freeze({
    workspace: input.workspace,
    processExecutor: input.physicalIo.processExecutor,
    workTools,
    bashOutputStore: outputStore,
  });
  const concreteTools = input.toolComponents.map((component) => component.materialize(bindings));
  const asyncNames = Object.freeze([...new Set(input.asyncAgentNames)].sort());
  const asyncTools = asyncNames.length === 0 || input.physicalIo.asyncAgentRpc === undefined
    ? []
    : createAsyncAgentTools(asyncNames, input.physicalIo.asyncAgentRpc);
  const registry = new ToolRegistry([...concreteTools, ...asyncTools], outputStore);
  const instruction = resolveCommonInstructionComposition({
    workspaceRoot: input.workspace.root,
    toolGuidelines: registry.promptGuidelines(),
    workspaceInstruction: input.agentInstructions,
    skillManifest: input.skillCatalog.manifest,
    roleInstruction: options.roleInstruction,
  });
  const instructionResources = instruction.components.map((component) => component.identity);
  const skills = registry.resolve('skill') === undefined
    ? []
    : input.skillCatalog.skills.map((skill) => createAgentResourceIdentity(`skill:${skill.name}`));
  const tools = registry.definitions().map((definition) =>
    createAgentResourceIdentity(`tool:${definition.name}`)
  );
  const asyncAgents = asyncNames.map((name) => createAgentResourceIdentity(`agent:${name}`));
  const capabilities: WorkerAgentCapabilities = Object.freeze({
    instructions: canonicalIdentities(instructionResources),
    skills: canonicalIdentities(skills),
    tools: canonicalIdentities(tools),
    asyncAgents: canonicalIdentities(asyncAgents),
  });
  const resources = canonicalIdentities([
    createAgentResourceIdentity(`model:${rootModel.provider}:${modelRouteProfileId(rootModel)}`),
    ...capabilities.instructions,
    ...capabilities.skills,
    ...capabilities.tools,
    ...capabilities.asyncAgents,
  ]);
  const resolved: WorkerAgentResolvedComposition = Object.freeze({
    capabilities,
    limits: Object.freeze({ maxSteps }),
    resourceSelection: createAgentResourceSelection(
      resources.map(String),
      maxSteps,
    ),
    systemInstruction: instruction.systemInstruction,
  });
  return Object.freeze({
    role: 'parent' as const,
    model: input.physicalIo.createModel('parent', rootModel),
    registry,
    maxSteps,
    systemInstruction: instruction.systemInstruction,
    instructionComponents: instruction.components,
    manifest: manifestFor(resources, maxSteps, rootModel),
    resolved,
  });
};
