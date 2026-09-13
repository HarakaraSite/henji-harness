import {
  type AgentResourceIdentity,
  createAgentResourceIdentity,
} from '../definitions/resource_identity.ts';

/** One named fragment of the resolved built-in system instruction. */
export interface InstructionComponent {
  readonly identity: AgentResourceIdentity;
  readonly text: string;
  /** Portable exact source selector when this component came from a managed/built-in revision. */
  readonly sourceLocator?: string;
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

/** Validate without normalizing bytes; used for exact managed instruction projection. */
export const defineExactInstructionComponent = (
  identity: string,
  text: string,
  sourceLocator?: string,
): InstructionComponent => {
  if (text.includes('\0') || text.trim().length === 0) {
    throw new TypeError('instruction component text must not be empty');
  }
  const bytes = new TextEncoder().encode(text);
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== text) {
    throw new TypeError('instruction component text must be valid UTF-8');
  }
  return Object.freeze({
    identity: createAgentResourceIdentity(identity),
    text,
    ...(sourceLocator === undefined ? {} : { sourceLocator }),
  });
};
