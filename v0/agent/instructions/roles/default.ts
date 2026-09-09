import { defineInstructionComponent } from '../component.ts';

export const DEFAULT_ROLE_INSTRUCTION =
  "You are the built-in root agent. Complete the user's task end to end and provide the final answer.";

export const DEFAULT_ROLE_COMPONENT = defineInstructionComponent(
  'instruction:builtin-default-role',
  DEFAULT_ROLE_INSTRUCTION,
);
