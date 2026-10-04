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

/** Immutable startup facts. Execution model/effort and request contexts have separate owners. */
export interface WorkerConfigurationSnapshot {
  readonly schemaVersion: 1;
  readonly configurationId: string;
  readonly agent: AgentConfiguration;
  readonly source: ConfigurationSource;
  readonly systemInstruction: string;
  readonly instructionComponents: readonly InstructionComponent[];
  readonly tools: readonly {
    readonly name: string;
    readonly revision: string;
    readonly source: 'bundled' | 'external';
    readonly entry?: string;
    readonly contract: ToolDefinition;
  }[];
  readonly rejections: readonly ConfigurationRejection[];
}

export type WorkerConfigurationResult =
  | { readonly ok: false; readonly rejections: readonly ConfigurationRejection[] }
  | {
    readonly ok: true;
    readonly composition: WorkerAgentComposition;
    readonly snapshot: WorkerConfigurationSnapshot;
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
  try {
    const loaded = await loadWorkerTools(selection.tools.filter((tool) => names.has(tool.name)), {
      workspace: input.workspace,
      skillCatalog: input.skillCatalog,
      processExecutor: input.physicalIo.processExecutor,
      workTools: input.physicalIo.workTools ?? {},
      bashOutputStore: outputStore,
      requestProvider: input.physicalIo.requestProvider,
      credentialAvailability: input.physicalIo.credentialAvailability,
    });
    const rejections = [...selection.rejections, ...loaded.rejections];
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
      tools: composition.registry.definitions().map((contract) => {
        const selected = loaded.accepted.find(({ tool }) => tool.name === contract.name)?.selection;
        return Object.freeze({
          name: contract.name,
          source: selected?.source ?? 'bundled',
          revision: selected?.revision ?? '1',
          ...(selected?.entry === undefined ? {} : { entry: selected.entry }),
          contract: structuredClone(contract),
        });
      }),
      rejections: Object.freeze(rejections),
    });
    return Object.freeze({ ok: true, composition, snapshot });
  } catch (error) {
    await outputStore.close();
    throw error;
  }
};
