/** Product-wide limits whose meaning is shared across component boundaries. */
export const MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS = 65_536;
export const MAX_CONVERSATION_TEXT_BYTES = 1024 * 1024;
export const MAX_PLANNER_RESULT_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const MAX_SERIALIZED_MODEL_MESSAGES_BYTES = 5 * 1024 * 1024;
export const MAX_COMPLETE_MODEL_REQUEST_BYTES = 6 * 1024 * 1024;
