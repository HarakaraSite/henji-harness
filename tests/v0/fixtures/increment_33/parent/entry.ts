import type { ExecutableAgentDefinition } from '@henji/agent';
import { composeParent } from './composition.ts';

const definition: ExecutableAgentDefinition = (input) => composeParent(input);

export default definition;
