import { createAgentResourceIdentity, type ExecutableToolDefinition } from '../worker_agent_api.ts';
import { createWriteTool } from '../tools/work_tools.ts';

const identity = createAgentResourceIdentity('tool:write');

const definition: ExecutableToolDefinition = () => ({
  identity,
  materialize: (bindings) => createWriteTool(bindings.workspace, bindings.workTools),
});

export default definition;
