import { type ModelRequest } from './contracts.ts';

/** Legacy observation threshold retained in ContextMetrics; it triggers no transformation. */
export const CONTEXT_TRIGGER_ESTIMATED_TOKENS = 65_536;

/** Legacy observation target retained in ContextMetrics; it triggers no transformation. */
export const CONTEXT_TARGET_ESTIMATED_TOKENS = 49_152;

export interface ContextMetrics {
  readonly messageEstimatedTokensBefore: number;
  readonly messageEstimatedTokensAfter: number;
  readonly toolEstimatedTokens: number;
  readonly requestEstimatedTokensBefore: number;
  readonly requestEstimatedTokensAfter: number;
  readonly triggerTokens: typeof CONTEXT_TRIGGER_ESTIMATED_TOKENS;
  readonly targetTokens: typeof CONTEXT_TARGET_ESTIMATED_TOKENS;
  readonly triggered: boolean;
  readonly targetReached: boolean;
  readonly compressedResultCount: number;
  readonly compressedMessageCount: number;
}

export interface PreparedModelContext {
  readonly request: ModelRequest;
  readonly metrics: ContextMetrics;
}

const encoder = new TextEncoder();

/** Count UTF-8 bytes in one stable JSON representation. */
const jsonBytes = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('context value is not JSON serializable');
  const bytes = encoder.encode(serialized).byteLength;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('context estimate is not a safe integer');
  return bytes;
};

const messageEnvelope = (request: ModelRequest): unknown =>
  request.systemInstruction === undefined
    ? { transcript: request.transcript }
    : { systemInstruction: request.systemInstruction, transcript: request.transcript };

const requestEnvelope = (request: ModelRequest): unknown =>
  request.systemInstruction === undefined
    ? { transcript: request.transcript, tools: request.tools }
    : {
      systemInstruction: request.systemInstruction,
      transcript: request.transcript,
      tools: request.tools,
    };

const cloneRequest = (request: ModelRequest): ModelRequest => structuredClone(request);

/**
 * Return a content-identical defensive model-request view.
 *
 * The estimate is intentionally a local UTF-8-byte heuristic. It is not provider usage or a
 * tokenizer result or a compaction trigger. This pure function performs no I/O, provider work,
 * content transformation, or asynchronous work.
 */
export const prepareModelContext = (request: ModelRequest): PreparedModelContext => {
  const prepared = cloneRequest(request);
  const messageEstimatedTokensBefore = jsonBytes(messageEnvelope(request));
  const toolEstimatedTokens = jsonBytes(request.tools);
  const requestEstimatedTokensBefore = jsonBytes(requestEnvelope(request));

  const metrics: ContextMetrics = {
    messageEstimatedTokensBefore,
    messageEstimatedTokensAfter: messageEstimatedTokensBefore,
    toolEstimatedTokens,
    requestEstimatedTokensBefore,
    requestEstimatedTokensAfter: requestEstimatedTokensBefore,
    triggerTokens: CONTEXT_TRIGGER_ESTIMATED_TOKENS,
    targetTokens: CONTEXT_TARGET_ESTIMATED_TOKENS,
    triggered: false,
    targetReached: messageEstimatedTokensBefore <= CONTEXT_TARGET_ESTIMATED_TOKENS,
    compressedResultCount: 0,
    compressedMessageCount: 0,
  };
  return { request: prepared, metrics };
};
