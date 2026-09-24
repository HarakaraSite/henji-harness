import {
  createAgentComposition,
  createAgentResourceIdentity,
  type ExecutableAgentDefinition,
} from '@henji/agent';

const roleInstruction = [
  'You are a reviewer. Review the requested code, plan, or document against its stated purpose.',
  'Inspect the relevant source and execution path before reporting a problem.',
  'Report findings in severity order with concrete evidence, file locations, and the user impact.',
  'Separate verified facts from inferences, and say when no finding was established.',
  'Do not edit the workspace. Use shell commands only for inspection and non-destructive checks.',
].join(' ');

const definition: ExecutableAgentDefinition = (input) =>
  createAgentComposition(input, {
    roleInstruction,
    tools: [
      createAgentResourceIdentity('tool:bash'),
      createAgentResourceIdentity('tool:bash_output'),
      createAgentResourceIdentity('tool:read'),
      ...(input.skillCatalog.skills.length === 0
        ? []
        : [createAgentResourceIdentity('tool:skill')]),
    ],
    asyncAgents: [],
  });

export default definition;
