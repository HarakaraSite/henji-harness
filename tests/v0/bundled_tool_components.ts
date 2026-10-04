import type { ToolComponent } from '../../v0/agent/worker_agent_api.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import {
  createProviderFreeWebSearchBackend,
  createWebFetchTool,
  createWebSearchTool,
} from './helpers/external_web_tools.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../../v0/agent/tools/work_tools.ts';
import { createBashOutputTool } from '../../v0/agent/tools/bash_output.ts';

/** Test-only component set for bundled tool implementations selected by Agent JSON configuration. */
export const bundledToolComponents = (): readonly ToolComponent[] => [
  {
    identity: createAgentResourceIdentity('tool:bash'),
    materialize: (bindings) =>
      createBashTool(
        bindings.workspace,
        bindings.processExecutor!,
        bindings.bashOutputStore,
        bindings.workTools.bash ?? {},
      ),
  },
  {
    identity: createAgentResourceIdentity('tool:bash_output'),
    materialize: (bindings) => createBashOutputTool(bindings.bashOutputStore),
  },
  {
    identity: createAgentResourceIdentity('tool:edit'),
    materialize: (bindings) => createEditTool(bindings.workspace, bindings.workTools),
  },
  {
    identity: createAgentResourceIdentity('tool:read'),
    materialize: (bindings) => createReadTool(bindings.workspace),
  },
  {
    identity: createAgentResourceIdentity('tool:write'),
    materialize: (bindings) => createWriteTool(bindings.workspace, bindings.workTools),
  },
  {
    identity: createAgentResourceIdentity('tool:web_search'),
    materialize: () => createWebSearchTool(createProviderFreeWebSearchBackend()),
  },
  {
    identity: createAgentResourceIdentity('tool:web_fetch'),
    materialize: () => createWebFetchTool(),
  },
];
