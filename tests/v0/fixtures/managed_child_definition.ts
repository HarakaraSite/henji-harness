import { createAgentComposition, type ExecutableAgentDefinition } from '@henji/agent';

const definition: ExecutableAgentDefinition = (input) =>
  createAgentComposition(input, {
    roleInstruction: 'Complete the assigned child task.',
    asyncAgents: [],
  });

export default definition;
