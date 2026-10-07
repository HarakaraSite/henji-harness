import {
  type AgentConfigurationChoice,
  resolveWorkerConfiguration,
} from '../../../v0/agent/configuration/configuration_resolver.ts';
import {
  createConfiguredWorkerComposition,
  type WorkerConfigurationResult,
} from '../../../v0/agent/worker/worker_configuration.ts';
import { createProviderFreePhysicalIo } from '../../../v0/agent/worker/worker_probe_physical_io.ts';
import {
  LinuxProcessExecutor,
  sourceProcessRunnerLaunch,
} from '../../../v0/agent/runtime/process_executor.ts';
import { resolveWorkspace } from '../../../v0/agent/tools/work_tools.ts';
import { discoverAgentInstructionSnapshot } from '../../../v0/agent/definitions/agent_instructions.ts';
import { discoverSkills } from '../../../v0/agent/definitions/skills.ts';
import type { ToolCall } from '../../../v0/agent/core/contracts.ts';

interface Request {
  readonly requestId: number;
  readonly kind: 'start' | 'dispatch' | 'close';
  readonly root: string;
  readonly configRoot: string;
  readonly choice?: AgentConfigurationChoice;
  readonly toolFilter?: readonly string[];
  readonly call: ToolCall;
}

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage(value: unknown): void;
};
let configured: WorkerConfigurationResult | undefined;
let processes: LinuxProcessExecutor | undefined;

scope.onmessage = async ({ data }) => {
  try {
    let result: unknown;
    if (data.kind === 'start') {
      const selected = await resolveWorkerConfiguration(data.configRoot, data.choice);
      const workspace = await resolveWorkspace(data.root);
      const instructions = await discoverAgentInstructionSnapshot(workspace.root);
      processes = new LinuxProcessExecutor(sourceProcessRunnerLaunch());
      configured = await createConfiguredWorkerComposition(selected, {
        workspace,
        configRoot: data.configRoot,
        agentInstructions: instructions?.formatted,
        skillCatalog: await discoverSkills(workspace.root, undefined, {}),
        physicalIo: { ...createProviderFreePhysicalIo(), processExecutor: processes },
        toolFilter: data.toolFilter,
      });
      result = configured.ok
        ? {
          ok: true,
          snapshot: configured.snapshot,
          definitions: configured.composition.registry.definitions(),
        }
        : configured;
    } else if (data.kind === 'dispatch') {
      if (configured?.ok !== true) throw new Error('configuration is not ready');
      result = await configured.composition.registry.dispatch(data.call);
    } else {
      if (configured?.ok === true) await configured.composition.registry.close();
      await processes?.close();
      result = 'closed';
    }
    scope.postMessage({ requestId: data.requestId, result });
  } catch (error) {
    scope.postMessage({
      requestId: data.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
