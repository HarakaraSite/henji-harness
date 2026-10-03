import { defineInstructionComponent, type InstructionComponent } from './component.ts';
import { runtimeFactsComponent } from './runtime_facts.ts';

export interface CommonInstructionCompositionInput {
  readonly workspaceRoot: string;
  readonly toolGuidelines: readonly {
    readonly tool: string;
    readonly text: string;
  }[];
  readonly roleInstruction?: string;
  readonly workspaceInstruction?: string;
  readonly skillManifest?: string;
}

export interface CommonInstructionComposition {
  readonly components: readonly InstructionComponent[];
  readonly systemInstruction: string;
}

const toolGuidelinesComponent = (
  guidelines: CommonInstructionCompositionInput['toolGuidelines'],
): InstructionComponent =>
  defineInstructionComponent(
    'instruction:active-tool-guidelines',
    '## Active tool guidelines\n\n' +
      (guidelines.length === 0
        ? '(none)'
        : guidelines.map((item) => '- ' + item.tool + ': ' + item.text).join(
          '\n',
        )),
  );

const optionalComponent = (
  identity: string,
  text: string | undefined,
): InstructionComponent | undefined =>
  text === undefined || text.length === 0 ? undefined : defineInstructionComponent(identity, text);

/** Compose JSON role text with common tool, workspace, skill, and runtime instructions. */
export const resolveCommonInstructionComposition = (
  input: CommonInstructionCompositionInput,
): CommonInstructionComposition => {
  const components = [
    optionalComponent('instruction:agent-role', input.roleInstruction),
    toolGuidelinesComponent(input.toolGuidelines),
    optionalComponent('instruction:workspace-agents', input.workspaceInstruction),
    optionalComponent('instruction:project-skill-manifest', input.skillManifest),
    runtimeFactsComponent(input.workspaceRoot),
  ].filter((component): component is InstructionComponent => component !== undefined);
  return Object.freeze({
    components: Object.freeze(components),
    systemInstruction: components.map((component) => component.text).join('\n\n'),
  });
};
