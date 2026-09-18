import type { OpenRouterAgentProfile } from './openrouter_contract.ts';
import type { OpenRouterModelSelection } from './model_selection.ts';
import { openRouterProfileFor, ROOT_DEFAULT_MODEL_SELECTION } from './openrouter_model_catalog.ts';
import { roleDefaultModelSelection } from './model_catalog.ts';
import { MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS } from '../../resource_limits.ts';

/** Maximum completion requested by the normal production agent. */
export const PRODUCTION_MAX_COMPLETION_TOKENS = MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS;

/** Canonical provider profile for the normal production and planner agents. */
export const PRODUCTION_PROFILE: OpenRouterAgentProfile = openRouterProfileFor(
  ROOT_DEFAULT_MODEL_SELECTION,
  PRODUCTION_MAX_COMPLETION_TOKENS,
);

export const PLANNER_PROFILE: OpenRouterAgentProfile = openRouterProfileFor(
  roleDefaultModelSelection('subagent:planner') as OpenRouterModelSelection,
  PRODUCTION_MAX_COMPLETION_TOKENS,
);
