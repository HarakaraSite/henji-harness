import { type Message, type ModelRequest, type ToolResultContent } from './contracts.ts';

/** Fixed local estimate at which old tool-result text may be omitted. */
export const CONTEXT_TRIGGER_ESTIMATED_TOKENS = 65_536;

/** Fixed local target used to avoid repeatedly transforming every request. */
export const CONTEXT_TARGET_ESTIMATED_TOKENS = 49_152;

/** The only text inserted into a prepared request view. */
export const OMITTED_TOOL_RESULT_TEXT = '[older tool result omitted for context]';

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
 * Return a defensive model-request view while retaining the caller's full request unchanged.
 *
 * The estimate is intentionally a local UTF-8-byte heuristic. It is not provider usage or a
 * tokenizer result, and this pure function performs no I/O, provider work, or asynchronous work.
 */
export const prepareModelContext = (request: ModelRequest): PreparedModelContext => {
  const prepared = cloneRequest(request) as {
    systemInstruction?: string;
    transcript: Message[];
    tools: ModelRequest['tools'];
  };
  const messageEstimatedTokensBefore = jsonBytes(messageEnvelope(request));
  const toolEstimatedTokens = jsonBytes(request.tools);
  const requestEstimatedTokensBefore = jsonBytes(requestEnvelope(request));
  const triggered = messageEstimatedTokensBefore >= CONTEXT_TRIGGER_ESTIMATED_TOKENS;
  let messageEstimatedTokensAfter = messageEstimatedTokensBefore;
  let requestEstimatedTokensAfter = requestEstimatedTokensBefore;
  let compressedResultCount = 0;
  const compressedMessages = new Set<number>();

  if (triggered) {
    const newestToolMessageIndex = request.transcript.reduce(
      (newest, message, index) => message.role === 'tool' ? index : newest,
      -1,
    );
    if (newestToolMessageIndex >= 0) {
      const markerBytes = jsonBytes(OMITTED_TOOL_RESULT_TEXT);
      for (
        let messageIndex = 0;
        messageIndex < newestToolMessageIndex &&
        messageEstimatedTokensAfter > CONTEXT_TARGET_ESTIMATED_TOKENS;
        messageIndex += 1
      ) {
        const sourceMessage = request.transcript[messageIndex];
        if (sourceMessage.role !== 'tool') continue;
        const preparedMessage = prepared.transcript[messageIndex];
        if (preparedMessage.role !== 'tool') continue;
        for (let resultIndex = 0; resultIndex < sourceMessage.content.length; resultIndex += 1) {
          if (messageEstimatedTokensAfter <= CONTEXT_TARGET_ESTIMATED_TOKENS) break;
          const sourceResult = sourceMessage.content[resultIndex];
          const originalBytes = jsonBytes(sourceResult.text);
          if (markerBytes >= originalBytes) continue;
          const preparedResult = preparedMessage.content[resultIndex] as ToolResultContent & {
            text: string;
          };
          preparedResult.text = OMITTED_TOOL_RESULT_TEXT;
          const delta = originalBytes - markerBytes;
          messageEstimatedTokensAfter -= delta;
          requestEstimatedTokensAfter -= delta;
          compressedResultCount += 1;
          compressedMessages.add(messageIndex);
        }
      }
    }
  }

  const metrics: ContextMetrics = {
    messageEstimatedTokensBefore,
    messageEstimatedTokensAfter,
    toolEstimatedTokens,
    requestEstimatedTokensBefore,
    requestEstimatedTokensAfter,
    triggerTokens: CONTEXT_TRIGGER_ESTIMATED_TOKENS,
    targetTokens: CONTEXT_TARGET_ESTIMATED_TOKENS,
    triggered,
    targetReached: messageEstimatedTokensAfter <= CONTEXT_TARGET_ESTIMATED_TOKENS,
    compressedResultCount,
    compressedMessageCount: compressedMessages.size,
  };
  return { request: prepared, metrics };
};
