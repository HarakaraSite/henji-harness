import { defineInstructionComponent, type InstructionComponent } from './component.ts';

/** Facts that remain valid for the lifetime of one materialized composition. */
export const runtimeFactsComponent = (workspaceRoot: string): InstructionComponent =>
  defineInstructionComponent(
    'instruction:runtime-facts',
    '## Runtime facts\n\nCurrent working directory: ' + workspaceRoot,
  );
