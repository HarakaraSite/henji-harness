import { type AgentResourceIdentity } from './resource_identity.ts';

/**
 * Stable marker carried by tool-filter validation failures so the Host can distinguish a
 * spawn-time tool filter rejection from other child start failures.
 */
export const TOOL_FILTER_ERROR_CODE = 'tool_filter_invalid';

export class AgentToolFilterError extends Error {
  constructor(message: string) {
    super(`${TOOL_FILTER_ERROR_CODE}: ${message}`);
    this.name = 'AgentToolFilterError';
  }
}

/**
 * Tool identities that stay effective whenever declared; naming them in a filter is accepted and
 * they are never dropped by filtering.
 */
const FILTER_EXEMPT = Object.freeze(['skill', 'submit_json_result']);

const nameOf = (identity: AgentResourceIdentity): string => {
  const value = `${identity}`;
  return value.startsWith('tool:') ? value.slice('tool:'.length) : value;
};

/**
 * Narrow one declared tool set to a spawn-time filter (`tools: string[]` of bare tool names).
 *
 * The declared set is the boundary: a filter can never add tools the Definition does not declare.
 * Unknown names and a filter that keeps no work tool are tool-filter failures. `tool:skill` and
 * `tool:submit_json_result` are exempt: they stay when declared and are absent when not.
 */
export const applyDeclaredToolFilter = (
  tools: readonly AgentResourceIdentity[],
  filter: readonly string[] | undefined,
): readonly AgentResourceIdentity[] => {
  if (filter === undefined) return tools;
  const selected = new Set<string>();
  for (const name of filter) {
    if (FILTER_EXEMPT.includes(name)) continue;
    selected.add(name);
    if (!tools.some((identity) => nameOf(identity) === name)) {
      throw new AgentToolFilterError(`tool filter references undeclared tools: ${name}`);
    }
  }
  const kept = tools.filter((identity) =>
    FILTER_EXEMPT.includes(nameOf(identity)) || selected.has(nameOf(identity))
  );
  if (!kept.some((identity) => !FILTER_EXEMPT.includes(nameOf(identity)))) {
    throw new AgentToolFilterError('tool filter selects no work tools');
  }
  return Object.freeze([...kept]);
};
