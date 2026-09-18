import { createAgentResourceIdentity, type ExecutableToolDefinition } from '../worker_agent_api.ts';
import { createBashOutputTool } from '../tools/bash_output.ts';

const identity = createAgentResourceIdentity('tool:bash_output');

const definition: ExecutableToolDefinition = () => ({
  identity,
  materialize: (bindings) => createBashOutputTool(bindings.bashOutputStore),
});

export default definition;
