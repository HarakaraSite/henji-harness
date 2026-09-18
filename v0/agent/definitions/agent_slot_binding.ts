import {
  DefinitionSelectorError,
  parseDefinitionRevisionSelector,
} from './definition_selection.ts';
import { ManagedDefinitionError } from './managed_definition_importer.ts';
import { isSubagentName } from './managed_definition_manifest.ts';
import {
  type ManagedDefinitionRevision,
  ManagedDefinitionStore,
} from './managed_definition_store.ts';
import type { DefinitionRevisionRef } from './managed_resource_ref.ts';

export const AGENT_SLOT_BINDING_FILE = 'agents.json';

export const ROOT_AGENT_SLOT = 'agent:default' as const;
const SUBAGENT_SLOT_PREFIX = 'subagent:';

/** One activation-level slot: the single root slot or a named delegated subagent slot. */
export type AgentSlot =
  | { readonly kind: 'root'; readonly slot: typeof ROOT_AGENT_SLOT }
  | { readonly kind: 'subagent'; readonly slot: string; readonly name: string };

export const subagentSlot = (name: string): string => `${SUBAGENT_SLOT_PREFIX}${name}`;

/** Parse one slot name; unknown or malformed slots return undefined. */
export const parseAgentSlot = (value: unknown): AgentSlot | undefined => {
  if (value === ROOT_AGENT_SLOT) return { kind: 'root', slot: ROOT_AGENT_SLOT };
  if (typeof value === 'string' && value.startsWith(SUBAGENT_SLOT_PREFIX)) {
    const name = value.slice(SUBAGENT_SLOT_PREFIX.length);
    if (isSubagentName(name)) return { kind: 'subagent', slot: value, name };
  }
  return undefined;
};

export type AgentBindingErrorCode =
  | 'binding_invalid'
  | 'binding_slot_unknown'
  | 'binding_role_mismatch'
  | 'binding_definition_not_found'
  | 'binding_definition_invalid';

export class AgentBindingError extends Error {
  constructor(
    readonly code: AgentBindingErrorCode,
    message: string,
    readonly slot?: string,
    readonly definition?: DefinitionRevisionRef,
  ) {
    super(message);
    this.name = 'AgentBindingError';
  }
}

export interface AgentSlotBindingsFileV1 {
  readonly schemaVersion: 1;
  readonly bindings: Readonly<Record<string, string>>;
}

export interface ResolvedAgentSlotBinding {
  readonly slot: AgentSlot;
  readonly ref: DefinitionRevisionRef;
  readonly revision: ManagedDefinitionRevision;
}

export const agentSlotBindingsPath = (configRoot: string): string =>
  `${configRoot}/${AGENT_SLOT_BINDING_FILE}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const invalid = (message: string): AgentBindingError =>
  new AgentBindingError('binding_invalid', message);

const parseBindingsFile = (value: unknown): AgentSlotBindingsFileV1 => {
  if (!isRecord(value)) throw invalid('agent slot binding file is not an object');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'bindings' || keys[1] !== 'schemaVersion') {
    throw invalid('agent slot binding file has unexpected keys');
  }
  if (value.schemaVersion !== 1 || !isRecord(value.bindings)) {
    throw invalid('agent slot binding file is not schema version 1');
  }
  const bindings: Record<string, string> = {};
  for (const [slot, selector] of Object.entries(value.bindings)) {
    if (parseAgentSlot(slot) === undefined) {
      throw new AgentBindingError('binding_slot_unknown', 'agent slot is not known', slot);
    }
    if (typeof selector !== 'string' || selector.length === 0) {
      throw invalid('agent slot selector is not a string');
    }
    bindings[slot] = selector;
  }
  return Object.freeze({ schemaVersion: 1 as const, bindings: Object.freeze(bindings) });
};

/** Read the Host-owned activation-level slot bindings; a missing file means no bindings. */
export const readAgentSlotBindings = async (
  configRoot: string,
): Promise<AgentSlotBindingsFileV1> => {
  let text: string;
  try {
    text = await Deno.readTextFile(agentSlotBindingsPath(configRoot));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return Object.freeze({ schemaVersion: 1 as const, bindings: Object.freeze({}) });
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('agent slot binding file is not valid JSON');
  }
  return parseBindingsFile(parsed);
};

const expectedRoleError = (slot: AgentSlot, message: string): AgentBindingError =>
  new AgentBindingError('binding_role_mismatch', message, slot.slot);

const validateRole = (
  slot: AgentSlot,
  revision: ManagedDefinitionRevision,
): void => {
  const manifest = revision.manifest;
  if (slot.kind === 'root') {
    if (manifest.declaredRole !== 'parent') {
      throw expectedRoleError(slot, 'root slot requires a parent-role Definition');
    }
    return;
  }
  if (manifest.declaredRole !== 'subagent' || manifest.subagentName !== slot.name) {
    throw expectedRoleError(
      slot,
      `slot ${slot.slot} requires a subagent Definition named ${slot.name}`,
    );
  }
};

const mapStoreError = (
  slot: AgentSlot,
  ref: DefinitionRevisionRef,
  error: ManagedDefinitionError,
): AgentBindingError =>
  new AgentBindingError(
    error.code === 'module_not_found'
      ? 'binding_definition_not_found'
      : 'binding_definition_invalid',
    error.message,
    slot.slot,
    ref,
  );

/**
 * Resolve every configured activation-level slot to one exact managed revision.
 *
 * Role/name mismatch, unknown slots, malformed selectors, and missing revisions are typed failures.
 * There is no implicit fallback to the bundled Definitions.
 */
export const resolveAgentSlotBindings = async (
  configRoot: string,
  dataRoot: string,
): Promise<ReadonlyMap<string, ResolvedAgentSlotBinding>> => {
  const file = await readAgentSlotBindings(configRoot);
  const store = new ManagedDefinitionStore({ dataRoot });
  const resolved = new Map<string, ResolvedAgentSlotBinding>();
  for (const [slotValue, selector] of Object.entries(file.bindings)) {
    const slot = parseAgentSlot(slotValue);
    if (slot === undefined) {
      throw new AgentBindingError('binding_slot_unknown', 'agent slot is not known', slotValue);
    }
    let ref: DefinitionRevisionRef;
    try {
      ref = parseDefinitionRevisionSelector(selector);
    } catch (error) {
      if (error instanceof DefinitionSelectorError) {
        throw invalid(`slot ${slotValue} selector is not a managed Definition selector`);
      }
      throw error;
    }
    let revision: ManagedDefinitionRevision;
    try {
      revision = await store.resolve(ref);
    } catch (error) {
      if (error instanceof ManagedDefinitionError) throw mapStoreError(slot, ref, error);
      throw error;
    }
    validateRole(slot, revision);
    resolved.set(
      slotValue,
      Object.freeze({
        slot,
        ref: structuredClone(ref),
        revision,
      }),
    );
  }
  return resolved;
};
