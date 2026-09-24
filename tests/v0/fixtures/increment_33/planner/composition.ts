import { createAgentComposition, type ExecutableAgentDefinitionInput } from '@henji/agent';

export const composePlanner = (input: ExecutableAgentDefinitionInput) =>
  createAgentComposition(input, {
    roleInstruction: 'Plan the requested work.',
  });
