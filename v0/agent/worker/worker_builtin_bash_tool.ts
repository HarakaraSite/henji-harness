import { createAgentResourceIdentity, type ExecutableToolDefinition } from '../worker_agent_api.ts';
import { createBashTool } from '../tools/work_tools.ts';

const identity = createAgentResourceIdentity('tool:bash');

const definition: ExecutableToolDefinition = () => ({
  identity,
  materialize: (bindings) =>
    createBashTool(
      bindings.workspace,
      bindings.processExecutor!,
      bindings.bashOutputStore,
      bindings.workTools.bash ?? {},
    ),
});

export default definition;
