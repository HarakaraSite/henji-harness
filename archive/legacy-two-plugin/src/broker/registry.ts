export interface BrokerOperation {
  readonly endpointId: 'openrouter-api';
  readonly operationId: 'chat-completions';
  readonly origin: 'https://openrouter.ai';
  readonly method: 'POST';
  readonly path: '/api/v1/chat/completions';
}

export const OPENROUTER_CHAT_COMPLETIONS: BrokerOperation = {
  endpointId: 'openrouter-api',
  operationId: 'chat-completions',
  origin: 'https://openrouter.ai',
  method: 'POST',
  path: '/api/v1/chat/completions',
};

export const resolveOperation = (
  endpointId: string,
  operationId: string,
): BrokerOperation | undefined =>
  endpointId === OPENROUTER_CHAT_COMPLETIONS.endpointId &&
    operationId === OPENROUTER_CHAT_COMPLETIONS.operationId
    ? OPENROUTER_CHAT_COMPLETIONS
    : undefined;
