import { error, type HarnessError } from './errors.ts';

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
}

export interface ModelResponse {
  readonly text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseModelRequest = (value: unknown): ModelRequest | HarnessError => {
  if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length === 0) {
    return error('invalid_model_request', 'model request requires a non-empty messages array');
  }
  for (const message of value.messages) {
    if (
      !isRecord(message) ||
      (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string'
    ) {
      return error(
        'invalid_model_request',
        'each message requires a supported role and string content',
      );
    }
  }
  return { messages: value.messages as ModelMessage[] };
};

export const parseModelResponse = (value: unknown): ModelResponse | HarnessError => {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return error('invalid_model_response', 'model response requires string text');
  }
  return { text: value.text };
};
