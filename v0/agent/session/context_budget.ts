import type { Message, Model, ModelRequest } from '../core/contracts.ts';
import type { ModelSelection } from '../provider/model_selection.ts';

export interface ContextBudgetValues {
  readonly historyTokens?: number;
  readonly inputTokens?: number;
  readonly contextTokens?: number;
  readonly outputReserve?: number;
}
export interface ContextBudgetConfiguration {
  readonly defaults?: ContextBudgetValues;
  readonly providers?: Readonly<Record<string, ContextBudgetValues>>;
  readonly models?: Readonly<Record<string, ContextBudgetValues>>;
}
export const readContextBudget = async (root: string): Promise<ContextBudgetConfiguration> => {
  try {
    return JSON.parse(await Deno.readTextFile(`${root}/context-budget.json`));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
};
export const resolveContextBudget = (
  configuration: ContextBudgetConfiguration,
  selection: ModelSelection,
  requestOutputReserve?: number,
) => {
  const values = {
    historyTokens: 32_768,
    ...configuration.defaults,
    ...configuration.providers?.[selection.provider],
    ...configuration.models?.[`${selection.provider}/${selection.modelId}`],
  };
  const outputReserve = requestOutputReserve ?? values.outputReserve ?? 65_536;
  const inputLimit = Math.min(
    values.inputTokens ?? Infinity,
    values.contextTokens === undefined ? Infinity : values.contextTokens - outputReserve,
  );
  return {
    ...values,
    outputReserve,
    inputLimit: inputLimit === Infinity ? 65_536 : inputLimit,
    capacitySource: values.inputTokens === undefined && values.contextTokens === undefined
      ? 'operational-estimate'
      : 'explicit-configuration',
    profile: 'wire-utf8-bytes/3+framing-estimate',
    guarantee: 'estimated-tokens',
  };
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Uses the actual selected adapter's wire transform, with an explicitly estimated token profile. */
export const contextCost = (
  model: Model,
  request: ModelRequest,
  conversationTranscript: readonly Message[] = request.transcript,
) => {
  const wire = model.measureRequestWire?.(request);
  // Prefix context can occupy transcript roles too. Keep the full wire for input
  // admission, but measure only completed turns/current draft against H.
  const conversationWire = conversationTranscript === request.transcript
    ? wire
    : model.measureRequestWire?.({ ...request, transcript: conversationTranscript });
  // The real adapter requires a user transcript even for measurement. Measure prefix
  // contribution with a legal minimal user, then subtract that same user-only baseline.
  const dummy = [{ role: 'user' as const, content: { kind: 'text' as const, text: 'x' } }];
  const prefixWire = model.measureRequestWire?.({ ...request, transcript: dummy });
  const bareWire = model.measureRequestWire?.({ transcript: dummy, tools: [] });
  const neutralPrefix = bytes(request.systemInstruction ?? '') + bytes(request.tools);
  const instructionPrefixBytes = prefixWire === undefined || bareWire === undefined
    ? neutralPrefix
    : prefixWire.bodyBytes - bareWire.bodyBytes;
  const transcriptPrefixBytes = conversationTranscript === request.transcript
    ? 0
    : wire === undefined || conversationWire === undefined
    ? bytes(request.transcript) - bytes(conversationTranscript)
    : wire.bodyBytes - conversationWire.bodyBytes;
  const historyBytes =
    conversationWire === undefined || prefixWire === undefined || bareWire === undefined
      ? bytes(conversationTranscript)
      : conversationWire.messagesBytes - prefixWire.messagesBytes + bareWire.messagesBytes;
  const prefixTokens = Math.ceil((instructionPrefixBytes + transcriptPrefixBytes) / 3) +
    8 * (request.transcript.length - conversationTranscript.length);
  const historyUsedTokens = Math.ceil(historyBytes / 3) + 8 * conversationTranscript.length;
  const inputTokens =
    Math.ceil((wire?.bodyBytes ?? neutralPrefix + bytes(request.transcript)) / 3) +
    16 + 8 * request.transcript.length;
  return {
    inputTokens,
    withinWireLimits: wire === undefined ||
      (wire.messagesBytes <= (wire.messageLimitBytes ?? Infinity) &&
        wire.bodyBytes <= (wire.bodyLimitBytes ?? Infinity)),
    prefixTokens,
    historyUsedTokens,
    messagesBytes: wire?.messagesBytes ?? bytes(request.transcript),
    bodyBytes: wire?.bodyBytes ?? bytes(request),
  };
};
