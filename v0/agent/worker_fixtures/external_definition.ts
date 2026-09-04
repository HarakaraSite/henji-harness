import {
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
  WORKER_PROTOCOL_VERSION,
} from '@henji/agent';
import { RELATIVE_IMPORT_VALUE } from './relative.ts';

export const workerProbe = `${WORKER_PROTOCOL_VERSION}:${RELATIVE_IMPORT_VALUE}`;

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input, { limits: { maxSteps: 4 } });

export default definition;
