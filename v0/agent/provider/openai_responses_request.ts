import type { JsonValue, Message, ModelRequest, ProviderState } from '../core/contracts.ts';

export interface ResponsesWireConfig {
  readonly stateProvider: string;
  readonly includeStore: boolean;
  readonly namespaceTools?: boolean;
}

const replayItemsFor = (
  state: ProviderState | undefined,
  providerId: string,
  modelId: string,
): readonly JsonValue[] | undefined => {
  if (state === undefined || state.provider !== providerId) return undefined;
  const responses = state as {
    readonly replayItems?: readonly JsonValue[];
    readonly model?: string;
  };
  if (!Array.isArray(responses.replayItems)) return undefined;
  if (responses.model !== undefined && responses.model !== modelId) {
    return undefined;
  }
  return responses.replayItems;
};

export const responsesRequestInput = (
  transcript: readonly Message[],
  providerId: string,
  modelId: string,
): unknown[] => {
  const input: unknown[] = [];
  for (const message of transcript) {
    if (message.role === 'user') {
      input.push({ role: 'user', content: message.content.text });
      continue;
    }
    if (message.role === 'assistant') {
      const replayItems = replayItemsFor(
        message.providerState,
        providerId,
        modelId,
      );
      if (replayItems !== undefined) {
        input.push(...replayItems);
        continue;
      }
      if (!Array.isArray(message.content)) {
        input.push({
          role: 'assistant',
          content: (message.content as { readonly text: string }).text,
        });
        continue;
      }
      if (message.text !== undefined) {
        input.push({ role: 'assistant', content: message.text });
      }
      for (const call of message.content) {
        input.push({
          type: 'function_call',
          call_id: call.callId,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }
    for (const result of message.content) {
      input.push({
        type: 'function_call_output',
        call_id: result.callId,
        output: result.text,
      });
    }
  }
  return input;
};

export const responsesRequestTools = (
  request: ModelRequest,
  namespaceTools?: boolean,
): unknown[] | undefined => {
  const functions = request.tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
  if (namespaceTools === true) {
    return functions.length === 0 ? undefined : [{
      type: 'namespace',
      name: 'henji',
      description: 'Henji local tools.',
      tools: functions,
    }];
  }
  return functions;
};

export const measureResponsesRequestWire = (
  request: ModelRequest,
  modelId: string,
  config: ResponsesWireConfig,
): {
  readonly messagesBytes: number;
  readonly bodyBytes: number;
} => {
  const input = responsesRequestInput(
    request.transcript,
    config.stateProvider,
    modelId,
  );
  const tools = responsesRequestTools(request, config.namespaceTools);
  const body = JSON.stringify({
    model: modelId,
    instructions: request.systemInstruction,
    input,
    ...(tools === undefined ? {} : { tools }),
    stream: true,
    ...(config.includeStore ? { store: false } : {}),
  });
  const encoder = new TextEncoder();
  return {
    messagesBytes: encoder.encode(JSON.stringify(input)).byteLength,
    bodyBytes: encoder.encode(body).byteLength,
  };
};
