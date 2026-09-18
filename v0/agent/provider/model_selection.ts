export type ReasoningEffort =
  | 'auto'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** Built-in provider ids; declared providers add further ids at runtime. */
export type ProviderId = string;
export const BUILTIN_PROVIDER_IDS: readonly string[] = Object.freeze([
  'openrouter-chat',
  'openrouter-responses',
  'openai-chat',
  'openai-responses',
]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export type AuthProfileId = 'openrouter-api-key' | 'openai-api-key';
export type CredentialAvailabilityStatus = 'present' | 'missing' | 'unknown';

export interface CredentialAvailability {
  readonly authProfile: AuthProfileId;
  readonly status: CredentialAvailabilityStatus;
}

export interface OpenRouterModelSelection {
  readonly provider: 'openrouter-chat';
  readonly api: 'openrouter-chat-completions';
  readonly authProfile: 'openrouter-api-key';
  readonly modelId: string;
  readonly effort: ReasoningEffort;
}

export interface OpenRouterResponsesModelSelection {
  readonly provider: 'openrouter-responses';
  readonly api: 'openrouter-responses';
  readonly authProfile: 'openrouter-api-key';
  readonly modelId: string;
  readonly effort: ReasoningEffort;
}

export interface OpenAIModelSelection {
  readonly provider: 'openai-responses';
  readonly api: 'openai-responses';
  readonly authProfile: 'openai-api-key';
  readonly modelId: string;
  readonly effort: ReasoningEffort;
}

/** Declared provider selection. Currently limited to the shared Responses protocol. */
export interface DeclaredProviderModelSelection {
  readonly provider: string;
  readonly api: 'openai-responses';
  readonly authProfile: 'openrouter-api-key' | 'openai-api-key';
  readonly modelId: string;
  readonly effort: ReasoningEffort;
}

/** Declared provider selection over the shared OpenAI-compatible Chat Completions protocol. */
export interface DeclaredChatModelSelection {
  readonly provider: string;
  readonly api: 'openai-chat-completions';
  readonly authProfile: 'openrouter-api-key' | 'openai-api-key';
  readonly modelId: string;
  readonly effort: ReasoningEffort;
}

export type ModelSelection =
  | OpenRouterModelSelection
  | OpenRouterResponsesModelSelection
  | OpenAIModelSelection
  | DeclaredProviderModelSelection
  | DeclaredChatModelSelection;

const EFFORTS: readonly ReasoningEffort[] = Object.freeze([
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** Structural persisted/protocol validation, deliberately independent of the current catalog. */
export const isStoredModelSelection = (value: unknown): value is ModelSelection => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (
    Object.keys(selection).length !== 5 || typeof selection.modelId !== 'string' ||
    selection.modelId.trim() !== selection.modelId || selection.modelId.length === 0 ||
    typeof selection.effort !== 'string' ||
    !EFFORTS.includes(selection.effort as ReasoningEffort)
  ) return false;
  if (selection.provider === 'openrouter-chat') {
    return selection.api === 'openrouter-chat-completions' &&
      selection.authProfile === 'openrouter-api-key';
  }
  if (selection.provider === 'openrouter-responses') {
    return selection.api === 'openrouter-responses' &&
      selection.authProfile === 'openrouter-api-key';
  }
  if (selection.provider === 'openai-chat') {
    return selection.api === 'openai-chat-completions' &&
      selection.authProfile === 'openai-api-key';
  }
  if (selection.provider === 'openai-responses') {
    return selection.api === 'openai-responses' &&
      selection.authProfile === 'openai-api-key';
  }
  return typeof selection.provider === 'string' && PROVIDER_ID.test(selection.provider) &&
    (selection.api === 'openai-responses' || selection.api === 'openai-chat-completions') &&
    (selection.authProfile === 'openrouter-api-key' ||
      selection.authProfile === 'openai-api-key');
};

export const sameModelSelection = (
  left: ModelSelection,
  right: ModelSelection,
): boolean =>
  left.provider === right.provider && left.api === right.api &&
  left.authProfile === right.authProfile && left.modelId === right.modelId &&
  left.effort === right.effort;

export const modelRouteProfileId = (selection: ModelSelection): string => {
  const component = selection.modelId.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '-');
  return `${selection.provider}-${selection.api}-${component}-${selection.effort}-v1`;
};

export const openRouterStoredSelection = (
  modelId: string,
  effort: ReasoningEffort,
): OpenRouterModelSelection =>
  Object.freeze({
    provider: 'openrouter-chat',
    api: 'openrouter-chat-completions',
    authProfile: 'openrouter-api-key',
    modelId,
    effort,
  });

export const openRouterResponsesStoredSelection = (
  modelId: string,
  effort: ReasoningEffort,
): OpenRouterResponsesModelSelection =>
  Object.freeze({
    provider: 'openrouter-responses',
    api: 'openrouter-responses',
    authProfile: 'openrouter-api-key',
    modelId,
    effort,
  });
