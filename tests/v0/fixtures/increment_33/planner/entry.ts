import type { ExecutableAgentDefinition } from '@henji/agent';
import { composePlanner } from './composition.ts';

const definition: ExecutableAgentDefinition = (input) => composePlanner(input);

export default definition;
