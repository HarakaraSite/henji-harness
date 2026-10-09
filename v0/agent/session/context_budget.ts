import type { Message, Model, ModelRequest } from '../core/contracts.ts';
import type { ModelSelection } from '../provider/model_selection.ts';

export interface ContextBudgetValues {
  readonly historyTokens?: number;
  readonly inputTokens?: number;
  readonly contextTokens?: number;
  readonly outputReserve?: number;
  readonly inputRatio?: number;
}
export interface ContextBudgetConfiguration {
  readonly defaults?: ContextBudgetValues;
  readonly providers?: Readonly<Record<string, ContextBudgetValues>>;
  readonly models?: Readonly<Record<string, ContextBudgetValues>>;
}

/** Capacity fields returned by Core's model catalog for one selected route. */
export interface ContextCapacityMetadata {
  readonly contextTokens?: number;
  readonly inputTokens?: number;
  readonly source: 'models.dev' | 'unknown';
  readonly modelsDevProviderId?: string;
}

type BudgetValueSource =
  | 'explicit-configuration'
  | 'models.dev'
  | 'default'
  | 'unknown';

export const readContextBudget = async (
  root: string,
): Promise<ContextBudgetConfiguration> => {
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
  capacity: ContextCapacityMetadata = { source: 'unknown' },
) => {
  const values: ContextBudgetValues = {
    ...configuration.defaults,
    ...configuration.providers?.[selection.provider],
    ...configuration.models?.[`${selection.provider}/${selection.modelId}`],
  };
  const contextTokens = values.contextTokens ?? capacity.contextTokens;
  const inputTokens = values.inputTokens ?? capacity.inputTokens;
  const inputRatio = values.inputRatio ?? 0.8;
  const outputReserve = requestOutputReserve ?? values.outputReserve;
  const inputBounds: number[] = [];
  if (contextTokens !== undefined) {
    inputBounds.push(Math.floor(contextTokens * inputRatio));
  }
  if (inputTokens !== undefined) inputBounds.push(inputTokens);
  if (contextTokens !== undefined && outputReserve !== undefined) {
    inputBounds.push(contextTokens - outputReserve);
  }
  const inputLimit = inputBounds.length === 0 ? undefined : Math.min(...inputBounds);
  const contextTokensSource: BudgetValueSource = values.contextTokens !== undefined
    ? 'explicit-configuration'
    : capacity.contextTokens !== undefined
    ? capacity.source
    : 'unknown';
  const inputTokensSource: BudgetValueSource = values.inputTokens !== undefined
    ? 'explicit-configuration'
    : capacity.inputTokens !== undefined
    ? capacity.source
    : 'unknown';
  return {
    ...values,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    inputRatio,
    ...(outputReserve === undefined ? {} : { outputReserve }),
    ...(inputLimit === undefined ? {} : { inputLimit }),
    capacitySources: Object.freeze({
      contextTokens: contextTokensSource,
      inputTokens: inputTokensSource,
      inputRatio: values.inputRatio === undefined ? 'default' : 'explicit-configuration',
      outputReserve: requestOutputReserve !== undefined
        ? 'adapter-request'
        : values.outputReserve !== undefined
        ? 'explicit-configuration'
        : 'unknown',
    }),
    ...(capacity.modelsDevProviderId === undefined
      ? {}
      : { modelsDevProviderId: capacity.modelsDevProviderId }),
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
    : model.measureRequestWire?.({
      ...request,
      transcript: conversationTranscript,
    });
  // The real adapter requires a user transcript even for measurement. Measure prefix
  // contribution with a legal minimal user, then subtract that same user-only baseline.
  const dummy = [{
    role: 'user' as const,
    content: { kind: 'text' as const, text: 'x' },
  }];
  const prefixWire = model.measureRequestWire?.({
    ...request,
    transcript: dummy,
  });
  const bareWire = model.measureRequestWire?.({ transcript: dummy, tools: [] });
  const neutralPrefix = bytes(request.systemInstruction ?? '') +
    bytes(request.tools);
  const instructionPrefixBytes = prefixWire === undefined || bareWire === undefined
    ? neutralPrefix
    : prefixWire.bodyBytes - bareWire.bodyBytes;
  const transcriptPrefixBytes = conversationTranscript === request.transcript
    ? 0
    : wire === undefined || conversationWire === undefined
    ? bytes(request.transcript) - bytes(conversationTranscript)
    : wire.bodyBytes - conversationWire.bodyBytes;
  const historyBytes = conversationWire === undefined || prefixWire === undefined ||
      bareWire === undefined
    ? bytes(conversationTranscript)
    : conversationWire.messagesBytes - prefixWire.messagesBytes +
      bareWire.messagesBytes;
  const prefixTokens = Math.ceil((instructionPrefixBytes + transcriptPrefixBytes) / 3) +
    8 * (request.transcript.length - conversationTranscript.length);
  const historyUsedTokens = Math.ceil(historyBytes / 3) +
    8 * conversationTranscript.length;
  const inputTokens = Math.ceil(
    (wire?.bodyBytes ?? neutralPrefix + bytes(request.transcript)) / 3,
  ) +
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
    ...(wire?.messageLimitBytes === undefined ? {} : { messageLimitBytes: wire.messageLimitBytes }),
    ...(wire?.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: wire.bodyLimitBytes }),
  };
};
