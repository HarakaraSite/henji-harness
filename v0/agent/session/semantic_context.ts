import { type Message, type ModelRequest } from '../core/contracts.ts';
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
} from '../provider/openrouter_model.ts';
import { type PreparedModelContext, prepareModelContext } from '../core/context.ts';
import { indexSessionHistoryPrefix, type SessionHistoryIndex } from './session_history.ts';

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

const safeString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') &&
  ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });

const summaryEnvelopeFromIndex = (
  indexed: SessionHistoryIndex,
  coveredThroughTurn: number,
): string => {
  const value = {
    schemaVersion: 1,
    operation: 'semantic_context_checkpoint',
    coveredThroughTurn,
    retainedFromTurn: coveredThroughTurn + 1,
    turns: indexed.turns.slice(0, coveredThroughTurn).map((item) => ({
      turn: item.turn,
      messages: item.messages,
    })),
  };
  return JSON.stringify(value);
};

export const summaryEnvelope = (
  transcript: readonly Message[],
  coveredThroughTurn: number,
): string => {
  const indexed = indexSessionHistoryPrefix(transcript);
  if (indexed === undefined) {
    return JSON.stringify({
      schemaVersion: 1,
      operation: 'semantic_context_checkpoint',
      coveredThroughTurn,
      retainedFromTurn: coveredThroughTurn + 1,
      turns: [],
    });
  }
  return summaryEnvelopeFromIndex(indexed, coveredThroughTurn);
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

/** Compose summary + retained canonical suffix + current draft without changing their content. */
export const projectSemanticContext = (
  request: ModelRequest,
  checkpoint: SemanticContextCheckpointV1,
): ModelRequest => {
  const indexed = indexSessionHistoryPrefix(request.transcript);
  const turns = indexed?.turns ?? [];
  if (checkpoint.coveredThroughTurn < 1 || checkpoint.coveredThroughTurn >= turns.length + 1) {
    throw new Error('checkpoint boundary is invalid');
  }
  const end = turns[checkpoint.coveredThroughTurn - 1]?.end;
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
  readonly measureRequestWire?: RequestWireMeasure;
}

type RequestWireMeasure = (
  request: ModelRequest,
) => { readonly messagesBytes: number; readonly bodyBytes: number };

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

/** Build a projected request from already-indexed causal ranges. */
const requestForCheckpointFromIndex = (
  transcript: readonly Message[],
  indexed: SessionHistoryIndex,
  checkpoint: SemanticContextCheckpointV1,
  options: ContextAdmissionOptions,
): ModelRequest => {
  if (checkpoint.coveredThroughTurn < 1 || checkpoint.coveredThroughTurn > indexed.turns.length) {
    throw new Error('checkpoint boundary is invalid');
  }
  const end = indexed.turns[checkpoint.coveredThroughTurn - 1]?.end;
  if (end === undefined) throw new Error('checkpoint boundary is invalid');
  return {
    ...(options.systemInstruction === undefined
      ? {}
      : { systemInstruction: options.systemInstruction }),
    transcript: structuredClone([
      checkpointMessage(checkpoint),
      ...transcript.slice(end),
      draftMessage(),
    ]),
    tools: structuredClone(options.tools),
  };
};

const summaryRequestFromIndex = (
  indexed: SessionHistoryIndex,
  coveredThroughTurn: number,
): ModelRequest => ({
  systemInstruction: SEMANTIC_CONTEXT_SYSTEM_PROMPT,
  transcript: [{
    role: 'user',
    content: { kind: 'text', text: summaryEnvelopeFromIndex(indexed, coveredThroughTurn) },
  }],
  tools: [],
});

const fits = (
  request: ModelRequest,
  measureRequestWire: RequestWireMeasure,
): {
  readonly prepared: PreparedModelContext;
  readonly messagesBytes: number;
  readonly bodyBytes: number;
} | undefined => {
  try {
    const prepared = prepareModelContext(request);
    const measured = measureRequestWire(prepared.request);
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
  measureRequestWire: RequestWireMeasure,
): {
  readonly prepared: PreparedModelContext;
  readonly messagesBytes: number;
  readonly bodyBytes: number;
} | undefined => {
  try {
    const prepared = prepareModelContext(request);
    const measured = measureRequestWire(prepared.request);
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
  const indexed = indexSessionHistoryPrefix(transcript);
  const turns = indexed?.turns ?? [];
  const count = turns.length;
  if (count < 2) return undefined;
  const measure = options.measureRequestWire ?? measureModelRequestWire;
  const baselineInput = options.checkpoint === undefined
    ? requestWithDraft(transcript, options)
    : requestForCheckpoint(transcript, options.checkpoint, options);
  // The comparison baseline is measured even when the current request already exceeds a
  // provider ceiling; only the candidate must fit. This allows compaction to recover a long
  // canonical session without using a hidden truncation fallback.
  const baseline = measurePrepared(baselineInput, measure);
  if (baseline === undefined) return undefined;
  const currentCovered = options.checkpoint?.coveredThroughTurn ?? 0;
  const firstCandidate = currentCovered + 1;
  const lastCandidate = count - 1;
  if (firstCandidate > lastCandidate) return undefined;

  // Summary envelopes grow monotonically with coverage. Find their largest fitting boundary once
  // instead of encoding every oversized prefix while walking candidates from the end.
  const summaryFits = new Map<number, ReturnType<typeof fits>>();
  const summaryFor = (covered: number): ReturnType<typeof fits> => {
    const cached = summaryFits.get(covered);
    if (cached !== undefined || summaryFits.has(covered)) return cached;
    const value = fits(summaryRequestFromIndex(indexed!, covered), measure);
    summaryFits.set(covered, value);
    return value;
  };
  if (summaryFor(firstCandidate) === undefined) return undefined;
  let highestSummary = lastCandidate;
  if (summaryFor(lastCandidate) === undefined) {
    let low = firstCandidate;
    let high = lastCandidate - 1;
    highestSummary = firstCandidate;
    while (low <= high) {
      const middle = low + Math.floor((high - low + 1) / 2);
      if (summaryFor(middle) !== undefined) {
        highestSummary = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
  }

  const candidates = new Map<number, ContextCandidate | undefined>();
  const evaluate = (covered: number): ContextCandidate | undefined => {
    const cached = candidates.get(covered);
    if (cached !== undefined || candidates.has(covered)) return cached;
    const checkpoint: SemanticContextCheckpointV1 = {
      contextSchemaVersion: 1,
      sessionId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceProfileId: options.sourceProfileId,
      coveredThroughTurn: covered,
      retainedFromTurn: covered + 1,
      summary: 'candidate',
    };
    const summaryFit = summaryFor(covered);
    if (summaryFit === undefined) {
      candidates.set(covered, undefined);
      return undefined;
    }
    // Admission reserves the maximum persisted summary/checkpoint wire contribution. A known
    // answer is used here; actual generated text is revalidated immediately before install.
    const reserved = {
      ...checkpoint,
      summary: 'x'.repeat(MAX_CONTEXT_SUMMARY_BYTES),
    };
    let projectedFit: ReturnType<typeof fits>;
    try {
      const bytes = encodeSemanticContextCheckpoint(reserved).byteLength;
      if (bytes > MAX_CONTEXT_CHECKPOINT_FILE_BYTES) {
        candidates.set(covered, undefined);
        return undefined;
      }
      projectedFit = fits(
        requestForCheckpointFromIndex(transcript, indexed!, reserved, options),
        measure,
      );
    } catch {
      candidates.set(covered, undefined);
      return undefined;
    }
    if (projectedFit === undefined || projectedFit.messagesBytes >= baseline.messagesBytes) {
      candidates.set(covered, undefined);
      return undefined;
    }
    let checkpointMessageBytes: number;
    try {
      checkpointMessageBytes = (options.measureRequestWire ?? measureModelRequestWire)({
        transcript: [checkpointMessage(reserved)],
        tools: [],
      })
        .messagesBytes;
    } catch {
      candidates.set(covered, undefined);
      return undefined;
    }
    if (checkpointMessageBytes > MAX_CHECKPOINT_MESSAGE_WIRE_BYTES) {
      candidates.set(covered, undefined);
      return undefined;
    }
    const candidate = {
      coveredThroughTurn: covered,
      retainedFromTurn: covered + 1,
      baseline: baseline.prepared,
      projected: projectedFit.prepared,
      summaryRequestBytes: summaryFit.bodyBytes,
      projectedMessagesBytes: projectedFit.messagesBytes,
      baselineMessagesBytes: baseline.messagesBytes,
    };
    candidates.set(covered, candidate);
    return candidate;
  };

  // Walk summary-fitting boundaries from newest to oldest so the largest useful boundary remains
  // authoritative without rescanning or reparsing prefixes.
  for (let covered = highestSummary; covered >= firstCandidate; covered -= 1) {
    const candidate = evaluate(covered);
    if (candidate !== undefined) return candidate;
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
