import { type AgentDefinition, defaultAgentDefinition } from './agent_definition.ts';
import type { BuiltinAgentId } from './agent_identity.ts';

export { BUILTIN_AGENT_IDS } from './agent_identity.ts';
export type { BuiltinAgentId } from './agent_identity.ts';

export interface BuiltinAgentSelection {
  readonly id: BuiltinAgentId;
  readonly definition: AgentDefinition;
}

/**
 * Internal compile-time admission for a Definition that is not one of the public built-in
 * preset functions.  It deliberately carries no public selector or loader surface.
 */
export interface InternalAgentDefinitionAdmission {
  readonly id: BuiltinAgentId;
  readonly definition: AgentDefinition;
  readonly topology: 'declared';
}

export type AgentDefinitionAdmission =
  | BuiltinAgentSelection
  | InternalAgentDefinitionAdmission;

/** Admit one compile-time Definition to the existing prepare/materialize contract. */
export const admitInternalAgentDefinition = (
  id: BuiltinAgentId,
  definition: AgentDefinition,
): InternalAgentDefinitionAdmission =>
  Object.freeze({
    id,
    definition,
    topology: 'declared' as const,
  });

/** Internal error used for malformed and unknown explicit selectors. */
export class AgentSelectionError extends Error {
  constructor() {
    super('invalid agent selection');
    this.name = 'AgentSelectionError';
  }
}

// A null-prototype object prevents inherited names from becoming selectors.  The mapping and
// each returned selection are frozen so the compile-time catalog cannot be modified by callers.
const DEFINITIONS: Readonly<Record<BuiltinAgentId, AgentDefinition>> = Object
  .freeze(
    Object.assign(
      Object.create(null) as Record<BuiltinAgentId, AgentDefinition>,
      {
        default: defaultAgentDefinition,
      },
    ),
  );

const IDENTIFIER = /^[a-z][a-z0-9-]{0,31}$/;

const isBuiltinAgentId = (value: string): value is BuiltinAgentId =>
  IDENTIFIER.test(value) &&
  Object.prototype.hasOwnProperty.call(DEFINITIONS, value);

/** The omitted selector resolves to this immutable default selection. */
export const DEFAULT_AGENT_SELECTION: BuiltinAgentSelection = Object.freeze({
  id: 'default',
  definition: defaultAgentDefinition,
});

/** Resolve one exact built-in ID without evaluating a Definition or touching host resources. */
export const resolveBuiltinAgent = (
  rawName?: string,
): BuiltinAgentSelection => {
  if (rawName === undefined) return DEFAULT_AGENT_SELECTION;
  if (!isBuiltinAgentId(rawName)) throw new AgentSelectionError();
  return Object.freeze({ id: rawName, definition: DEFINITIONS[rawName] });
};
