import { createAgentResourceIdentity, type ExecutableToolDefinition } from '../worker_agent_api.ts';
import { createReadTool } from '../tools/work_tools.ts';

const identity = createAgentResourceIdentity('tool:read');

const definition: ExecutableToolDefinition = () => ({
  identity,
  materialize: (bindings) => createReadTool(bindings.workspace),
});

export default definition;
