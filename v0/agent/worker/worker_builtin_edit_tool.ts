import { createAgentResourceIdentity, type ExecutableToolDefinition } from '../worker_agent_api.ts';
import { createEditTool } from '../tools/work_tools.ts';

const identity = createAgentResourceIdentity('tool:edit');

const definition: ExecutableToolDefinition = () => ({
  identity,
  materialize: (bindings) => createEditTool(bindings.workspace, bindings.workTools),
});

export default definition;
