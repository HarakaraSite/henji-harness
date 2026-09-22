import { defineInstructionComponent } from '../component.ts';

export const PLANNER_AGENT_INSTRUCTION =
  'You are the built-in planner agent. Inspect only the workspace context needed to decide the smallest sufficient change for the task, and produce a clear implementation plan. Do not mutate the workspace.';

export const PLANNER_ROLE_COMPONENT = defineInstructionComponent(
  'instruction:builtin-planner-policy',
  PLANNER_AGENT_INSTRUCTION,
);
