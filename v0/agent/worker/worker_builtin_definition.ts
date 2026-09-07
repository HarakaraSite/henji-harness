import {
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from '../worker_agent_api.ts';

const definition: ExecutableAgentDefinition = (input) => createDefaultAgentComposition(input);

export default definition;
