import {
  compareAgentResourceIdentities,
  createAgentResourceIdentity,
  createAgentResourceSelection,
} from '../definitions/resource_identity.ts';
import type { WorkerAgentComposition } from '../worker_agent_api.ts';
import { defineExactInstructionComponent, type InstructionComponent } from './component.ts';
import {
  builtinHenjiBaseInstruction,
  HENJI_BASE_INSTRUCTION_SLOT,
  type SelectedHenjiBaseInstruction,
  validateSelectedHenjiBaseInstruction,
} from './managed_instruction.ts';

let selectedBase: SelectedHenjiBaseInstruction = builtinHenjiBaseInstruction();

export const selectWorkerHenjiBaseInstruction = (
  selection: SelectedHenjiBaseInstruction,
): void => {
  if (!validateSelectedHenjiBaseInstruction(selection)) {
    throw new Error('Worker Henji base instruction is invalid');
  }
  selectedBase = structuredClone(selection);
};

export const selectedWorkerHenjiBaseInstruction = (): SelectedHenjiBaseInstruction =>
  structuredClone(selectedBase);

const exactSelector = (selection: SelectedHenjiBaseInstruction): string =>
  `${selection.selectionSource}:${selection.ref.resourceKind}:${selection.ref.resourceId}@${selection.ref.revision.algorithm}:${selection.ref.revision.digest}`;

const baseComponent = (): InstructionComponent =>
  defineExactInstructionComponent(
    HENJI_BASE_INSTRUCTION_SLOT,
    selectedBase.content,
    exactSelector(selectedBase),
  );

const definitionComponents = (
  composition: WorkerAgentComposition,
): readonly InstructionComponent[] => {
  const components = composition.instructionComponents;
  if (components !== undefined) return components;
  if (composition.systemInstruction === undefined) return [];
  return [
    defineExactInstructionComponent(
      'instruction:definition-contribution',
      composition.systemInstruction,
    ),
  ];
};

export const finalSystemInstructionForContribution = (
  contribution: string | undefined,
): string =>
  contribution === undefined || contribution.length === 0
    ? selectedBase.content
    : `${selectedBase.content}\n\n${contribution}`;

/** Mandatory Worker-core base application for root compositions. */
export const finalizeWorkerInstructionComposition = (
  composition: WorkerAgentComposition,
): WorkerAgentComposition => {
  const baseIdentity = createAgentResourceIdentity(HENJI_BASE_INSTRUCTION_SLOT);
  const components = definitionComponents(composition);
  if (
    composition.instructionComponents !== undefined &&
    composition.systemInstruction !== composition.instructionComponents
        .map((component) => component.text).join('\n\n')
  ) {
    throw new Error('Worker Definition instruction components are incoherent');
  }
  if (
    components.some((component) => component.identity === baseIdentity) ||
    composition.manifest.resources.includes(baseIdentity) ||
    composition.resolved.capabilities.instructions.includes(baseIdentity)
  ) {
    throw new Error(
      'Worker Definition declared the core-owned Henji base instruction slot',
    );
  }
  const finalizedComponents = Object.freeze([baseComponent(), ...components]);
  const systemInstruction = finalSystemInstructionForContribution(
    composition.systemInstruction,
  );
  const resources = [...composition.manifest.resources, String(baseIdentity)]
    .sort();
  const capabilityInstructions = [
    ...composition.resolved.capabilities.instructions,
    baseIdentity,
  ].sort(compareAgentResourceIdentities);
  const selectionResources = [
    ...composition.resolved.resourceSelection.resources,
    baseIdentity,
  ].sort(compareAgentResourceIdentities);
  const resolved = Object.freeze({
    ...composition.resolved,
    systemInstruction,
    capabilities: Object.freeze({
      ...composition.resolved.capabilities,
      instructions: Object.freeze(capabilityInstructions),
    }),
    resourceSelection: createAgentResourceSelection(
      selectionResources.map(String),
      composition.maxSteps,
    ),
  });
  return Object.freeze({
    ...composition,
    systemInstruction,
    instructionComponents: finalizedComponents,
    manifest: Object.freeze({
      ...composition.manifest,
      resources: Object.freeze(resources),
      baseInstruction: Object.freeze({
        slot: selectedBase.slot,
        selectionSource: selectedBase.selectionSource,
        ref: structuredClone(selectedBase.ref),
        contentDigest: selectedBase.contentDigest,
      }),
    }),
    resolved,
  });
};
