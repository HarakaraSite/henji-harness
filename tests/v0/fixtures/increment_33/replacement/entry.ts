import { createDefaultAgentComposition, type ExecutableAgentDefinition } from '@henji/agent';
import { managedReadReplacement } from './read_component.ts';

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input, {
    toolComponents: [managedReadReplacement],
  });

export default definition;
