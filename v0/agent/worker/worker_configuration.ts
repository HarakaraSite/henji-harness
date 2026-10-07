import {
  type AgentConfiguration,
  type ConfigurationRejection,
  configurationRejection,
  type ConfigurationSource,
} from '../configuration/agent_configuration.ts';
import type { WorkerConfigurationSelection } from '../configuration/configuration_resolver.ts';
import {
  createWorkerComposition,
  finalizeWorkerComposition,
  type WorkerAgentComposition,
  type WorkerCompositionInput,
} from '../worker_agent_api.ts';
import { createBashOutputStore } from '../tools/bash_output.ts';
import { loadWorkerTools } from './worker_tool_loader.ts';
import { createAgentResourceIdentity } from '../definitions/resource_identity.ts';
import { applyToolNameFilter } from '../definitions/tool_filter.ts';
import { finalizeWorkerInstructionComposition } from '../instructions/worker_core_finalizer.ts';
import type { InstructionComponent } from '../instructions/component.ts';
import type { ToolDefinition } from '../core/contracts.ts';
import { emptySkillCatalog } from '../definitions/skills.ts';
import { HOOK_API_CONTRACT, HOOK_PHASES, type HookPhase } from '../hook_api.ts';
import { type LoadedWorkerHook, loadWorkerHooks } from '../../hooks/hook_loader.ts';
import {
  createHookScopedProviderRequest,
  type HookProviderEvidenceScope,
} from '../provider/auxiliary_request.ts';

export interface WorkerHookRegistrationSnapshot {
  readonly name: string;
  readonly path: string;
  readonly contract: typeof HOOK_API_CONTRACT;
  readonly handlers: readonly HookPhase[];
}

/** Immutable startup facts. Execution model/effort and request contexts have separate owners. */
export interface WorkerConfigurationSnapshot {
  readonly schemaVersion: 1;
  readonly configurationId: string;
  readonly agent: AgentConfiguration;
  readonly source: ConfigurationSource;
  readonly systemInstruction: string;
  readonly instructionComponents: readonly InstructionComponent[];
  readonly toolPaths: { readonly source?: string; readonly deny: readonly string[] };
  readonly tools: readonly {
    readonly name: string;
    readonly revision: string;
    readonly source: 'bundled' | 'external';
    readonly entry?: string;
    readonly contract: ToolDefinition;
    readonly fileAccess: import('../tools/tool_paths.ts').ToolFileAccess;
    readonly paths: { readonly allow: readonly string[]; readonly deny: readonly string[] };
  }[];
  readonly hooks: readonly WorkerHookRegistrationSnapshot[];
  readonly rejections: readonly ConfigurationRejection[];
}

export type WorkerConfigurationResult =
  | { readonly ok: false; readonly rejections: readonly ConfigurationRejection[] }
  | {
    readonly ok: true;
    readonly composition: WorkerAgentComposition;
    readonly snapshot: WorkerConfigurationSnapshot;
    /** Worker-local handler closures loaded for this generation. */
    readonly hooks: readonly LoadedWorkerHook[];
    /** Mutable Worker-local evidence context read by external hooks' requestProvider closure. */
    readonly hookProviderEvidenceScope: HookProviderEvidenceScope;
  };

/** One factory for default, unnamed generic and named JSON Agents inside a Worker. */
export const createConfiguredWorkerComposition = async (
  selection: WorkerConfigurationSelection,
  input: Omit<WorkerCompositionInput, 'toolComponents' | 'asyncAgentNames'> & {
    readonly toolFilter?: readonly string[];
  },
  maxSteps?: number,
): Promise<WorkerConfigurationResult> => {
  if (selection.agent === undefined) return { ok: false, rejections: selection.rejections };
  const configuration = selection.agent.configuration;
  const names = new Set(applyToolNameFilter(configuration.tools, input.toolFilter));
  const outputStore = input.physicalIo.workTools?.bashOutputStore ?? createBashOutputStore();
  const hookProviderEvidenceScope: HookProviderEvidenceScope = {};
  try {
    const loaded = await loadWorkerTools(selection.tools.filter((tool) => names.has(tool.name)), {
      workspace: input.workspace,
      skillCatalog: input.skillCatalog,
      processExecutor: input.physicalIo.processExecutor,
      workTools: input.physicalIo.workTools ?? {},
      bashOutputStore: outputStore,
      requestProvider: input.physicalIo.requestProvider,
      credentialAvailability: input.physicalIo.credentialAvailability,
    }, {
      ...(input.configRoot === undefined ? {} : { configRoot: input.configRoot }),
      ...(input.credentialRoot === undefined ? {} : { credentialRoot: input.credentialRoot }),
    });
    const loadedHooks = await loadWorkerHooks(selection.hooks, {
      workspace: input.workspace,
      processExecutor: input.physicalIo.processExecutor,
      workTools: input.physicalIo.workTools ?? {},
      requestProvider: input.physicalIo.requestProvider === undefined
        ? undefined
        : createHookScopedProviderRequest(
          input.physicalIo.requestProvider,
          hookProviderEvidenceScope,
        ),
      credentialAvailability: input.physicalIo.credentialAvailability,
    });
    const rejections = [
      ...selection.rejections,
      ...loaded.rejections,
      ...loadedHooks.rejections,
    ];
    const asyncAgents = input.physicalIo.asyncAgentRpc === undefined
      ? []
      : configuration.agents.filter((name) => {
        if (
          name === 'generic' ||
          selection.agents.some((entry) => entry.name === name && entry.rejection === undefined)
        ) return true;
        if (
          !rejections.some((rejection) => rejection.target === 'agent' && rejection.name === name)
        ) {
          rejections.push(
            configurationRejection('agent', name, new Error(`Agent ${name} is unavailable`)),
          );
        }
        return false;
      });
    const unavailable = rejections.length === 0
      ? ''
      : '\n\n## Unavailable configuration entries\n\n' +
        rejections.map((rejection) =>
          `- ${rejection.target} ${rejection.name}${
            rejection.file === undefined ? '' : ` (${rejection.file})`
          }: ${rejection.reason}`
        ).join('\n');
    const composition = finalizeWorkerInstructionComposition(finalizeWorkerComposition(
      createWorkerComposition({
        ...input,
        // The native manifest directs the model to call skill; publish it only with that tool.
        skillCatalog: loaded.accepted.some(({ tool }) => tool.name === 'skill')
          ? input.skillCatalog
          : emptySkillCatalog(),
        // Filtering happens before loading; rejected tools must not be reintroduced here.
        physicalIo: {
          ...input.physicalIo,
          workTools: { ...input.physicalIo.workTools, bashOutputStore: outputStore },
        },
        asyncAgentNames: asyncAgents,
        toolComponents: loaded.accepted.map(({ tool }) => ({
          identity: createAgentResourceIdentity(`tool:${tool.name}`),
          materialize: () => tool,
        })),
      }, {
        roleInstruction: configuration.instruction + unavailable,
      }),
      maxSteps,
    ));
    const snapshot: WorkerConfigurationSnapshot = Object.freeze({
      schemaVersion: 1,
      configurationId: crypto.randomUUID(),
      agent: structuredClone(configuration),
      source: structuredClone(selection.agent.source),
      systemInstruction: composition.systemInstruction ?? '',
      instructionComponents: structuredClone(composition.instructionComponents ?? []),
      toolPaths: {
        ...(loaded.pathConfiguration.source === undefined
          ? {}
          : { source: loaded.pathConfiguration.source }),
        deny: [...loaded.pathConfiguration.deniedPaths],
      },
      tools: composition.registry.definitions().map((contract) => {
        const accepted = loaded.accepted.find(({ tool }) => tool.name === contract.name);
        const selected = accepted?.selection;
        const policy = accepted?.pathPolicy ?? loaded.pathConfiguration.forTool(contract.name);
        return Object.freeze({
          name: contract.name,
          fileAccess: composition.registry.resolve(contract.name)!.fileAccess,
          paths: { allow: [...policy.allowedPaths], deny: [...policy.deniedPaths] },
          source: selected?.source ?? 'bundled',
          revision: selected?.revision ?? '1',
          ...(selected?.entry === undefined ? {} : { entry: selected.entry }),
          contract: structuredClone(contract),
        });
      }),
      hooks: Object.freeze(loadedHooks.accepted.map(({ selection, handlers }) =>
        Object.freeze({
          name: selection.name,
          path: selection.path!,
          contract: selection.contract,
          handlers: Object.freeze(HOOK_PHASES.filter((phase) => handlers[phase] !== undefined)),
        })
      )),
      rejections: Object.freeze(rejections),
    });
    return Object.freeze({
      ok: true,
      composition,
      snapshot,
      hooks: loadedHooks.accepted,
      hookProviderEvidenceScope,
    });
  } catch (error) {
    await outputStore.close();
    throw error;
  }
};
