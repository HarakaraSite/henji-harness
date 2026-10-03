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
  'openai-chatgpt',
]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && PROVIDER_ID.test(value);
/** Non-secret credential identity; the credential value lives in a fixed config file. */
export type AuthProfileId = string;
const AUTH_PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** Config-root entries that cannot be used as a credential file name. */
const RESERVED_AUTH_PROFILE_IDS: readonly string[] = Object.freeze([
  'providers',
  'instruction',
]);
/** Validate a non-secret auth profile identity without resolving any credential. */
export const isAuthProfileId = (value: unknown): value is AuthProfileId =>
  typeof value === 'string' && AUTH_PROFILE_ID.test(value) &&
  !RESERVED_AUTH_PROFILE_IDS.includes(value);
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

/** ChatGPT's account binding is an execution-local, non-secret registration reference. */
export interface ChatGPTModelSelection {
  readonly provider: 'openai-chatgpt';
  readonly api: 'openai-responses';
  readonly authProfile: 'openai-chatgpt';
  readonly modelId: string;
  readonly effort: ReasoningEffort;
  /** `null` is an explicitly captured turn with no selected account. */
  readonly registrationId?: string | null;
}

/** Declared provider selection. Currently limited to the shared Responses protocol. */
export interface DeclaredProviderModelSelection {
  readonly provider: string;
  readonly api: 'openai-responses';
  readonly authProfile: AuthProfileId;
  readonly modelId: string;
  readonly effort: ReasoningEffort;
}

/** Declared provider selection over the shared OpenAI-compatible Chat Completions protocol. */
export interface DeclaredChatModelSelection {
  readonly provider: string;
  readonly api: 'openai-chat-completions';
  readonly authProfile: AuthProfileId;
  readonly modelId: string;
  readonly effort: ReasoningEffort;
}

export type ModelSelection =
  | OpenRouterModelSelection
  | OpenRouterResponsesModelSelection
  | OpenAIModelSelection
  | ChatGPTModelSelection
  | DeclaredProviderModelSelection
  | DeclaredChatModelSelection;

const REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze([
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);

/** Structural persisted/protocol validation, deliberately independent of the current catalog. */
export const isStoredModelSelection = (value: unknown): value is ModelSelection => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  const chatGptBindingValid = selection.provider === 'openai-chatgpt'
    ? Object.keys(selection).length === (Object.hasOwn(selection, 'registrationId') ? 6 : 5) &&
      (!Object.hasOwn(selection, 'registrationId') || selection.registrationId === null ||
        typeof selection.registrationId === 'string' && selection.registrationId.length > 0)
    : Object.keys(selection).length === 5;
  if (
    !chatGptBindingValid || typeof selection.modelId !== 'string' ||
    selection.modelId.trim() !== selection.modelId || selection.modelId.length === 0 ||
    !isReasoningEffort(selection.effort)
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
  if (selection.provider === 'openai-chatgpt') {
    return selection.api === 'openai-responses' &&
      selection.authProfile === 'openai-chatgpt';
  }
  return isProviderId(selection.provider) &&
    (selection.api === 'openai-responses' || selection.api === 'openai-chat-completions') &&
    isAuthProfileId(selection.authProfile);
};

export const sameModelSelection = (
  left: ModelSelection,
  right: ModelSelection,
): boolean => {
  const registrationId = (selection: ModelSelection): string | null | undefined =>
    'registrationId' in selection ? selection.registrationId : undefined;
  return left.provider === right.provider && left.api === right.api &&
    left.authProfile === right.authProfile && left.modelId === right.modelId &&
    left.effort === right.effort && registrationId(left) === registrationId(right);
};

export const modelRouteProfileId = (selection: ModelSelection): string => {
  const component = selection.modelId.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '-');
  return `${selection.provider}-${selection.api}-${component}-${selection.effort}-v1`;
};
