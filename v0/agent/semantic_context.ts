import { type Message, type ModelRequest } from './contracts.ts';
import {
  encodeSemanticContextCheckpoint,
  MAX_CONTEXT_CHECKPOINT_FILE_BYTES,
  MAX_CONTEXT_SUMMARY_BYTES,
  type SemanticContextCheckpointV1,
} from './session_store.ts';
import {
  MAX_MESSAGE_BYTES,
  MAX_REQUEST_BYTES,
  measureModelRequestWire,
} from './openrouter_model.ts';
import { type PreparedModelContext, prepareModelContext } from './context.ts';
import { indexSessionHistory } from './session_history.ts';

const encoder = new TextEncoder();

export const SEMANTIC_CONTEXT_SYSTEM_PROMPT =
  'You are generating a semantic context checkpoint for Henji Harness.\n' +
  'Summarize only the supplied canonical parent-turn prefix.\n' +
  'Preserve user goals, decisions, constraints, unresolved work, relevant file or state facts, and explicit uncertainty.\n' +
  'Do not introduce credentials, startup instruction or skill text, absolute state paths, or facts that are not present in the supplied messages.\n' +
  'Return exactly one compact JSON object with keys in this order: {"schemaVersion":1,"summary":"..."}.\n' +
  'Return no Markdown, tool call, or extra text.';

export const MAX_NEXT_DRAFT_BYTES = 4_096;
export const MAX_CHECKPOINT_MESSAGE_WIRE_BYTES = 16_384;
export const SUMMARY_TIMEOUT_MS = 30_000;

const safeString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') &&
  ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });

const canonicalTurns = (
  transcript: readonly Message[],
): readonly { turn: number; messages: readonly Message[] }[] => {
  const indexed = indexSessionHistory(transcript);
  if (indexed !== undefined) {
    return indexed.turns.map((item) => ({ turn: item.turn, messages: item.messages }));
  }
  // A live request contains an incomplete draft user message. Keep the committed prefix only;
  // this bounded scanner avoids treating that draft as a completed turn.
  const complete: { turn: number; messages: readonly Message[] }[] = [];
  for (let end = transcript.length - 1; end > 0; end -= 1) {
    const candidate = indexSessionHistory(transcript.slice(0, end));
    if (candidate !== undefined && candidate.turns.length > 0 && candidate.messageCount === end) {
      for (const item of candidate.turns) {
        complete.push({ turn: item.turn, messages: item.messages });
      }
      return complete;
    }
  }
  return [];
};

export const summaryEnvelope = (
  transcript: readonly Message[],
  coveredThroughTurn: number,
): string => {
  const turns = canonicalTurns(transcript).filter((item) => item.turn <= coveredThroughTurn).map((
    item,
  ) => ({
    turn: item.turn,
    messages: item.messages,
  }));
  const value = {
    schemaVersion: 1,
    operation: 'semantic_context_checkpoint',
    coveredThroughTurn,
    retainedFromTurn: coveredThroughTurn + 1,
    turns,
  };
  return JSON.stringify(value);
};

export const summaryRequest = (
  transcript: readonly Message[],
  coveredThroughTurn: number,
): ModelRequest => ({
  systemInstruction: SEMANTIC_CONTEXT_SYSTEM_PROMPT,
  transcript: [{
    role: 'user',
    content: { kind: 'text', text: summaryEnvelope(transcript, coveredThroughTurn) },
  }],
  tools: [],
});

export const parseSummaryResult = (text: unknown): string | undefined => {
  if (typeof text !== 'string' || text.length === 0 || !safeString(text)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 2 || keys[0] !== 'schemaVersion' || keys[1] !== 'summary') return undefined;
  if (object.schemaVersion !== 1 || !safeString(object.summary)) return undefined;
  if (encoder.encode(object.summary).byteLength > MAX_CONTEXT_SUMMARY_BYTES) return undefined;
  return object.summary;
};

export const checkpointMessageText = (
  coveredThroughTurn: number,
  summary: string,
): string =>
  `[henji-context-checkpoint:v1]\ncovered-through-turn: ${coveredThroughTurn}\nretained-from-turn: ${
    coveredThroughTurn + 1
  }\nsummary:\n${summary}`;

export const checkpointMessage = (
  checkpoint: SemanticContextCheckpointV1,
): Message => ({
  role: 'user',
  content: {
    kind: 'text',
    text: checkpointMessageText(checkpoint.coveredThroughTurn, checkpoint.summary),
  },
});

/** Compose summary + retained canonical suffix + current draft, without mechanical omission. */
export const projectSemanticContext = (
  request: ModelRequest,
  checkpoint: SemanticContextCheckpointV1,
): ModelRequest => {
  const turns = canonicalTurns(request.transcript);
  if (checkpoint.coveredThroughTurn < 1 || checkpoint.coveredThroughTurn >= turns.length + 1) {
    throw new Error('checkpoint boundary is invalid');
  }
  let end: number | undefined;
  for (let candidateEnd = request.transcript.length; candidateEnd > 0; candidateEnd -= 1) {
    const indexed = indexSessionHistory(request.transcript.slice(0, candidateEnd));
    const boundary = indexed?.turns[checkpoint.coveredThroughTurn - 1];
    if (boundary !== undefined) {
      end = boundary.end;
      break;
    }
  }
  if (end === undefined) throw new Error('checkpoint boundary is invalid');
  const projected = [checkpointMessage(checkpoint), ...request.transcript.slice(end)];
  return {
    ...(request.systemInstruction === undefined
      ? {}
      : { systemInstruction: request.systemInstruction }),
    transcript: structuredClone(projected),
    tools: structuredClone(request.tools),
  };
};

export interface ContextAdmissionOptions {
  readonly systemInstruction?: string;
  readonly tools: ModelRequest['tools'];
  readonly sourceProfileId: string;
  readonly checkpoint?: SemanticContextCheckpointV1;
}

export interface ContextCandidate {
  readonly coveredThroughTurn: number;
  readonly retainedFromTurn: number;
  readonly baseline: PreparedModelContext;
  readonly projected: PreparedModelContext;
  readonly summaryRequestBytes: number;
  readonly projectedMessagesBytes: number;
  readonly baselineMessagesBytes: number;
}

const draftMessage = (): Message => ({
  role: 'user',
  content: { kind: 'text', text: '\u0001'.repeat(MAX_NEXT_DRAFT_BYTES) },
});

const requestWithDraft = (
  transcript: readonly Message[],
  options: ContextAdmissionOptions,
): ModelRequest => ({
  ...(options.systemInstruction === undefined
    ? {}
    : { systemInstruction: options.systemInstruction }),
  transcript: [...transcript, draftMessage()],
  tools: structuredClone(options.tools),
});

const requestForCheckpoint = (
  transcript: readonly Message[],
  checkpoint: SemanticContextCheckpointV1,
  options: ContextAdmissionOptions,
): ModelRequest => projectSemanticContext(requestWithDraft(transcript, options), checkpoint);

const fits = (
  request: ModelRequest,
): {
  readonly prepared: PreparedModelContext;
  readonly messagesBytes: number;
  readonly bodyBytes: number;
} | undefined => {
  try {
    const prepared = prepareModelContext(request);
    const measured = measureModelRequestWire(prepared.request);
    if (measured.messagesBytes > MAX_MESSAGE_BYTES || measured.bodyBytes > MAX_REQUEST_BYTES) {
      return undefined;
    }
    return { prepared, messagesBytes: measured.messagesBytes, bodyBytes: measured.bodyBytes };
  } catch {
    return undefined;
  }
};

const measurePrepared = (
  request: ModelRequest,
): {
  readonly prepared: PreparedModelContext;
  readonly messagesBytes: number;
  readonly bodyBytes: number;
} | undefined => {
  try {
    const prepared = prepareModelContext(request);
    const measured = measureModelRequestWire(prepared.request);
    return { prepared, messagesBytes: measured.messagesBytes, bodyBytes: measured.bodyBytes };
  } catch {
    return undefined;
  }
};

/** Select the maximum useful boundary using the production encoder and a worst-case draft. */
export const findContextCandidate = (
  transcript: readonly Message[],
  options: ContextAdmissionOptions,
): ContextCandidate | undefined => {
  const turns = canonicalTurns(transcript);
  const count = turns.length;
  if (count < 2) return undefined;
  const baselineInput = options.checkpoint === undefined
    ? requestWithDraft(transcript, options)
    : requestForCheckpoint(transcript, options.checkpoint, options);
  // The comparison baseline is measured even when the current request already exceeds a
  // provider ceiling; only the candidate must fit. This allows compaction to recover a long
  // canonical session without using a hidden truncation fallback.
  const baseline = measurePrepared(baselineInput);
  if (baseline === undefined) return undefined;
  const currentCovered = options.checkpoint?.coveredThroughTurn ?? 0;
  for (let covered = count - 1; covered >= 1; covered -= 1) {
    if (covered <= currentCovered) continue;
    const checkpoint: SemanticContextCheckpointV1 = {
      contextSchemaVersion: 1,
      sessionId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceProfileId: options.sourceProfileId,
      coveredThroughTurn: covered,
      retainedFromTurn: covered + 1,
      summary: 'candidate',
    };
    const summaryFit = fits(summaryRequest(transcript, covered));
    if (summaryFit === undefined) continue;
    // Admission reserves the maximum persisted summary/checkpoint wire contribution. A known
    // answer is used here; actual generated text is revalidated immediately before install.
    const reserved = {
      ...checkpoint,
      summary: 'x'.repeat(MAX_CONTEXT_SUMMARY_BYTES),
    };
    let projectedFit: ReturnType<typeof fits>;
    try {
      const bytes = encodeSemanticContextCheckpoint(reserved).byteLength;
      if (bytes > MAX_CONTEXT_CHECKPOINT_FILE_BYTES) continue;
      projectedFit = fits(requestForCheckpoint(transcript, reserved, options));
    } catch {
      continue;
    }
    if (projectedFit === undefined || projectedFit.messagesBytes >= baseline.messagesBytes) {
      continue;
    }
    let checkpointMessageBytes: number;
    try {
      checkpointMessageBytes =
        measureModelRequestWire({ transcript: [checkpointMessage(reserved)], tools: [] })
          .messagesBytes;
    } catch {
      continue;
    }
    if (checkpointMessageBytes > MAX_CHECKPOINT_MESSAGE_WIRE_BYTES) continue;
    return {
      coveredThroughTurn: covered,
      retainedFromTurn: covered + 1,
      baseline: baseline.prepared,
      projected: projectedFit.prepared,
      summaryRequestBytes: summaryFit.bodyBytes,
      projectedMessagesBytes: projectedFit.messagesBytes,
      baselineMessagesBytes: baseline.messagesBytes,
    };
  }
  return undefined;
};

export const prepareProjectedRequest = (
  request: ModelRequest,
  checkpoint: SemanticContextCheckpointV1 | undefined,
): PreparedModelContext => {
  const semantic = checkpoint === undefined
    ? structuredClone(request)
    : projectSemanticContext(request, checkpoint);
  return prepareModelContext(semantic);
};
