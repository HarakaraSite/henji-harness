import {
  createAgentResourceIdentity,
  type PhysicalIoBindings,
  type ToolComponent,
} from '../../v0/agent/worker_agent_api.ts';
import { createWebSearchTool } from '../../v0/agent/tools/web_search.ts';
import { createWebFetchTool } from '../../v0/agent/tools/web_fetch.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../../v0/agent/tools/work_tools.ts';
import { createBashOutputTool } from '../../v0/agent/tools/bash_output.ts';

/**
 * Test-only component set matching the bundled default parent declaration. Direct
 * `createDefaultAgentComposition`/`createDeclaredRegistry` callers must supply tool Definition
 * components; the production Host resolves the bundled tool Definition modules itself.
 */
export const bundledToolComponents = (
  physicalIo: PhysicalIoBindings,
): readonly ToolComponent[] => [
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
    materialize: (bindings) =>
      createWebSearchTool(bindings.webSearchBackend ?? physicalIo.webSearchBackend!),
  },
  {
    identity: createAgentResourceIdentity('tool:web_fetch'),
    materialize: () => createWebFetchTool(),
  },
];
