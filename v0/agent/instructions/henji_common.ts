import { defineInstructionComponent } from './component.ts';

export const HENJI_COMMON_INSTRUCTION =
  'You are Henji, a software-engineering agent running in an interactive terminal. Help the user inspect, change, and verify the current workspace using the tools available to you. Follow workspace instructions and report outcomes clearly and concisely.';

export const HENJI_COMMON_COMPONENT = defineInstructionComponent(
  'instruction:builtin-henji-common',
  HENJI_COMMON_INSTRUCTION,
);
