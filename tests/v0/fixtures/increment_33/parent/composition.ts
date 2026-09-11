import { createDefaultAgentComposition, type ExecutableAgentDefinitionInput } from '@henji/agent';

export const composeParent = (input: ExecutableAgentDefinitionInput) =>
  createDefaultAgentComposition(input);
