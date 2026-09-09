import {
  type AgentResourceIdentity,
  createAgentResourceIdentity,
} from '../definitions/resource_identity.ts';

/** One named fragment of the resolved built-in system instruction. */
export interface InstructionComponent {
  readonly identity: AgentResourceIdentity;
  readonly text: string;
}

/** Define an immutable, non-empty instruction component. */
export const defineInstructionComponent = (
  identity: string,
  text: string,
): InstructionComponent => {
  const normalized = text.trim();
  if (normalized.length === 0) {
    throw new TypeError('instruction component text must not be empty');
  }
  return Object.freeze({
    identity: createAgentResourceIdentity(identity),
    text: normalized,
  });
};
