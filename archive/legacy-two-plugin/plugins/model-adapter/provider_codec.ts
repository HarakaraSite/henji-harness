export interface ModelRequest {
  readonly messages: readonly {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
  }[];
}
export interface ModelResponse {
  readonly text: string;
}
export interface HarnessError {
  readonly code: 'invalid_model_response';
  readonly message: string;
}
const error = (message: string): HarnessError => ({ code: 'invalid_model_response', message });

export const OPENROUTER_MODEL = 'google/gemini-3.7-flash';

export interface OpenRouterChatRequest {
  readonly model: typeof OPENROUTER_MODEL;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly stream: false;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const toOpenRouterRequest = (request: ModelRequest): OpenRouterChatRequest => ({
  model: OPENROUTER_MODEL,
  messages: request.messages,
  stream: false,
});

export const fromOpenRouterResponse = (value: unknown): ModelResponse | HarnessError => {
  if (
    !isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1 ||
    !isRecord(value.choices[0]) || !isRecord(value.choices[0].message) ||
    typeof value.choices[0].message.content !== 'string'
  ) {
    return error('OpenRouter response requires exactly one text choice');
  }
  return { text: value.choices[0].message.content };
};
