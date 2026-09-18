/** The finite public selector domain for built-in Agent Definitions. */
export const BUILTIN_AGENT_IDS = Object.freeze(['default', 'planner'] as const);
export type BuiltinAgentId = typeof BUILTIN_AGENT_IDS[number];

/** IDs accepted by the internal schema-v1 resolved-manifest codec. */
export type AgentManifestDefinitionId = BuiltinAgentId;

/** Resource topology remains tied to an executable built-in Definition. */
export type AgentResourceTopologyId = BuiltinAgentId;
