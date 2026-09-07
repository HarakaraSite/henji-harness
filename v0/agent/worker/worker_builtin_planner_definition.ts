import {
  createPlannerAgentComposition,
  type ExecutableAgentDefinition,
} from '../worker_agent_api.ts';

const definition: ExecutableAgentDefinition = (input) => createPlannerAgentComposition(input);

export default definition;
