import {
  type AgentResourceIdentity,
  createAgentResourceIdentity,
} from '../definitions/resource_identity.ts';
import type { SkillCatalog } from '../definitions/skills.ts';
import { defineInstructionComponent, type InstructionComponent } from './component.ts';
import { HENJI_COMMON_COMPONENT } from './henji_common.ts';
import { DEFAULT_ROLE_COMPONENT } from './roles/default.ts';
import { PLANNER_ROLE_COMPONENT } from './roles/planner.ts';
import { runtimeFactsComponent } from './runtime_facts.ts';

export type BuiltinInstructionRole = 'default' | 'planner';

export interface BuiltinInstructionCompositionInput {
  readonly role: BuiltinInstructionRole;
  readonly workspaceRoot: string;
  readonly toolGuidelines: readonly {
    readonly tool: string;
    readonly text: string;
  }[];
  readonly workspaceInstruction?: string;
  readonly skillManifest?: string;
}

export interface BuiltinInstructionComposition {
  readonly components: readonly InstructionComponent[];
  readonly systemInstruction: string;
}

const toolGuidelinesComponent = (
  guidelines: BuiltinInstructionCompositionInput['toolGuidelines'],
): InstructionComponent =>
  defineInstructionComponent(
    'instruction:active-tool-guidelines',
    '## Active tool guidelines\n\n' +
      (guidelines.length === 0
        ? '(none)'
        : guidelines.map((item) => '- ' + item.tool + ': ' + item.text).join('\n')),
  );

const optionalComponent = (
  identity: string,
  text: string | undefined,
): InstructionComponent | undefined =>
  text === undefined ? undefined : defineInstructionComponent(identity, text);

/** Compose the complete built-in instruction in its canonical component order. */
export const resolveBuiltinInstructionComposition = (
  input: BuiltinInstructionCompositionInput,
): BuiltinInstructionComposition => {
  const role = input.role === 'default' ? DEFAULT_ROLE_COMPONENT : PLANNER_ROLE_COMPONENT;
  const components = [
    HENJI_COMMON_COMPONENT,
    role,
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

/** Instruction identities declared by a built-in Definition in canonical source order. */
export const builtinInstructionResourceIdentities = (
  role: BuiltinInstructionRole,
  hasWorkspaceInstruction: boolean,
  hasSkillManifest: boolean,
): readonly AgentResourceIdentity[] => {
  const identities = [
    HENJI_COMMON_COMPONENT.identity,
    role === 'default' ? DEFAULT_ROLE_COMPONENT.identity : PLANNER_ROLE_COMPONENT.identity,
    createAgentResourceIdentity('instruction:active-tool-guidelines'),
    ...(hasWorkspaceInstruction
      ? [createAgentResourceIdentity('instruction:workspace-agents')]
      : []),
    ...(hasSkillManifest
      ? [createAgentResourceIdentity('instruction:project-skill-manifest')]
      : []),
    createAgentResourceIdentity('instruction:runtime-facts'),
  ];
  return Object.freeze(identities);
};

/** Resolve a built-in composition from the snapshots already held by an Agent Definition. */
export const resolveBuiltinDefinitionInstruction = (
  role: BuiltinInstructionRole,
  workspaceRoot: string,
  workspaceInstruction: string | undefined,
  skillCatalog: SkillCatalog,
  toolGuidelines: BuiltinInstructionCompositionInput['toolGuidelines'],
): BuiltinInstructionComposition =>
  resolveBuiltinInstructionComposition({
    role,
    workspaceRoot,
    toolGuidelines,
    workspaceInstruction,
    skillManifest: skillCatalog.manifest,
  });
