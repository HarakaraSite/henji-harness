/** The finite public selector domain for built-in Agent Definitions. */
export const BUILTIN_AGENT_IDS = Object.freeze(['default', 'planner'] as const);
export type BuiltinAgentId = typeof BUILTIN_AGENT_IDS[number];

/** The finite internal domain used only by local comparison material. */
export const COMPARISON_VARIANT_IDS = Object.freeze(
  [
    'default-max-steps-4',
  ] as const,
);
export type ComparisonVariantId = typeof COMPARISON_VARIANT_IDS[number];

/** All IDs accepted by the internal schema-v1 resolved-manifest codec. */
export const AGENT_MANIFEST_DEFINITION_IDS = Object.freeze(
  [
    ...BUILTIN_AGENT_IDS,
    ...COMPARISON_VARIANT_IDS,
  ] as const,
);
export type AgentManifestDefinitionId = typeof AGENT_MANIFEST_DEFINITION_IDS[number];

/** Resource topology remains tied to an executable built-in Definition. */
export type AgentResourceTopologyId = BuiltinAgentId;
