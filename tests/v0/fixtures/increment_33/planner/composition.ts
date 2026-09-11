import { createPlannerAgentComposition, type ExecutableAgentDefinitionInput } from '@henji/agent';

export const composePlanner = (input: ExecutableAgentDefinitionInput) =>
  createPlannerAgentComposition(input);
