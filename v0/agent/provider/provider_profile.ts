import type { OpenRouterAgentProfile } from './openrouter_contract.ts';

/** Maximum completion requested by the normal production agent. */
export const PRODUCTION_MAX_COMPLETION_TOKENS = 65_536;

/** Canonical provider profile for the normal production and planner agents. */
export const PRODUCTION_PROFILE: OpenRouterAgentProfile = Object.freeze({
  id: 'openrouter-google-gemini-3.7-flash-vertex-v0',
  model: 'google/gemini-3.7-flash',
  origin: 'https://openrouter.ai',
  path: '/api/v1/chat/completions',
  method: 'POST',
  secretEnv: 'HENJI_OPENROUTER_API_KEY',
  maxCompletionTokens: PRODUCTION_MAX_COMPLETION_TOKENS,
  stream: false,
});
