import { type Message } from '../core/contracts.ts';
import {
  causalTranscriptIndex,
  causalTranscriptPrefixIndex,
  type SessionRecord,
} from './session_store.ts';
import { settledToolActivityText, toolActivityPreview } from '../tools/tool_activity.ts';

const encoder = new TextEncoder();

/** A completed parent turn and its exact canonical message range. */
export interface SessionHistoryTurn {
  readonly turn: number;
  readonly start: number;
  readonly end: number;
  readonly messages: readonly Message[];
}

export interface SessionHistoryIndex {
  readonly turns: readonly SessionHistoryTurn[];
  readonly messageCount: number;
  readonly turnCount: number;
}

export interface SessionHistoryPage {
  readonly sessionId?: string;
  readonly agent?: SessionRecord['agent'];
  readonly turn: number;
  readonly totalTurns: number;
  readonly page: number;
  readonly pageCount: number;
  readonly entries: readonly SessionHistoryEntry[];
  readonly sourceBytes: number;
  readonly omitted: boolean;
}

export interface SessionHistoryEntry {
  readonly turn: number;
  readonly role: 'user' | 'steer' | 'assistant' | 'tool>';
  readonly messageIndex: number;
  readonly text: string;
}

export const HISTORY_PAGE_SOURCE_BYTES = 8_192;
export const HISTORY_PAGE_ESCAPED_BYTES = 32 * 1_024;
export const HISTORY_PAGE_ROWS = 16;

/**
 * Build a bounded structural view of the schema-v1 transcript. The parser is deliberately
 * independent of any renderer and returns no mutable reference to the session-owned array.
 */
export const indexSessionHistory = (
  transcript: readonly Message[],
): SessionHistoryIndex | undefined => {
  const indexed = causalTranscriptIndex(transcript);
  if (indexed === undefined) return undefined;
  return makeSessionHistoryIndex(transcript, indexed.turns);
};

/** Build the completed prefix of a live request without rescanning every possible slice. */
export const indexSessionHistoryPrefix = (
  transcript: readonly Message[],
): SessionHistoryIndex | undefined => {
  const indexed = causalTranscriptPrefixIndex(transcript);
  if (indexed === undefined) return undefined;
  return makeSessionHistoryIndex(transcript, indexed.turns);
};

const makeSessionHistoryIndex = (
  transcript: readonly Message[],
  ranges: readonly { readonly turn: number; readonly start: number; readonly end: number }[],
): SessionHistoryIndex => {
  const turns = ranges.map((range) =>
    Object.freeze({
      turn: range.turn,
      start: range.start,
      end: range.end,
      messages: Object.freeze(
        transcript.slice(range.start, range.end).map((message) => structuredClone(message)),
      ),
    })
  );
  return Object.freeze({
    turns: Object.freeze(turns),
    messageCount: transcript.length,
    turnCount: turns.length,
  });
};

export const sessionHistoryIndex = indexSessionHistory;

const contentRows = (rows: number | undefined): number => {
  const terminalRows = rows ?? HISTORY_PAGE_ROWS + 5;
  return Math.max(1, Math.min(HISTORY_PAGE_ROWS, terminalRows - 5));
};

// Keep each bounded source chunk small enough that a page can contain the maximum 16 rows while
// remaining below both declared page ceilings, including terminal escaping and modal framing.
const HISTORY_CHUNK_SOURCE_BYTES = Math.floor(HISTORY_PAGE_SOURCE_BYTES / HISTORY_PAGE_ROWS);
const HISTORY_CHUNK_ESCAPED_BYTES = Math.floor(HISTORY_PAGE_ESCAPED_BYTES / HISTORY_PAGE_ROWS);

const entryRows = (turn: SessionHistoryTurn): SessionHistoryEntry[] => {
  const rows: SessionHistoryEntry[] = [];
  let assistantRowIndex: number | undefined;
  const updateAssistant = (entry: SessionHistoryEntry, final: boolean): void => {
    if (assistantRowIndex === undefined) {
      assistantRowIndex = rows.length;
      rows.push(entry);
      return;
    }
    const relocateAfterTools = final &&
      rows.slice(assistantRowIndex + 1).some((row) => row.role === 'tool>');
    if (relocateAfterTools) {
      rows.splice(assistantRowIndex, 1);
      assistantRowIndex = rows.length;
      rows.push(entry);
      return;
    }
    rows[assistantRowIndex] = entry;
  };
  for (let offset = 0; offset < turn.messages.length; offset += 1) {
    const message = turn.messages[offset];
    if (message.role === 'user') {
      rows.push({
        turn: turn.turn,
        role: offset === 0 ? 'user' : 'steer',
        messageIndex: turn.start + offset,
        text: message.content.text,
      });
    } else if (message.role === 'assistant') {
      if (Array.isArray(message.content)) {
        if (message.text !== undefined) {
          updateAssistant({
            turn: turn.turn,
            role: 'assistant',
            messageIndex: turn.start + offset,
            text: message.text,
          }, false);
        }
        const tool = turn.messages[offset + 1];
        if (tool?.role === 'tool') {
          const results = new Map(tool.content.map((result) => [result.callId, result]));
          for (const call of message.content) {
            const result = results.get(call.callId);
            if (result === undefined) continue;
            const preview = call.name === result.name
              ? toolActivityPreview(call.name, call.arguments)
              : '';
            rows.push({
              turn: turn.turn,
              role: 'tool>',
              messageIndex: turn.start + offset,
              text: settledToolActivityText(result.name, result.outcome, preview),
            });
          }
        }
      } else {
        updateAssistant({
          turn: turn.turn,
          role: 'assistant',
          messageIndex: turn.start + offset,
          text: (message.content as { readonly text: string }).text,
        }, true);
      }
    }
  }
  return rows;
};

const splitEntry = (entry: SessionHistoryEntry): SessionHistoryEntry[] => {
  const points = [...entry.text];
  if (points.length === 0) return [entry];
  const chunks: SessionHistoryEntry[] = [];
  let text = '';
  let sourceBytes = 0;
  let escapedBytes = 0;
  for (const point of points) {
    const pointSourceBytes = encoder.encode(point).byteLength;
    const pointEscapedBytes = pointSourceBytes;
    if (
      text.length > 0 &&
      (sourceBytes + pointSourceBytes > HISTORY_CHUNK_SOURCE_BYTES ||
        escapedBytes + pointEscapedBytes > HISTORY_CHUNK_ESCAPED_BYTES)
    ) {
      chunks.push(Object.freeze({ ...entry, text }));
      text = '';
      sourceBytes = 0;
      escapedBytes = 0;
    }
    text += point;
    sourceBytes += pointSourceBytes;
    escapedBytes += pointEscapedBytes;
  }
  if (text.length > 0) chunks.push(Object.freeze({ ...entry, text }));
  return chunks;
};

const expandedRows = (turn: SessionHistoryTurn): readonly SessionHistoryEntry[] =>
  Object.freeze(entryRows(turn).flatMap(splitEntry));

const emptyPage = (
  turn: number,
  totalTurns: number,
  page: number,
  pageCount: number,
  options: { readonly sessionId?: string; readonly agent?: SessionRecord['agent'] },
): SessionHistoryPage => ({
  sessionId: options.sessionId,
  agent: options.agent,
  turn,
  totalTurns,
  page,
  pageCount,
  entries: [],
  sourceBytes: 0,
  omitted: false,
});

const paginate = (
  rows: readonly SessionHistoryEntry[],
  turn: number,
  totalTurns: number,
  options: {
    readonly sessionId?: string;
    readonly agent?: SessionRecord['agent'];
    readonly rows?: number;
  },
): readonly SessionHistoryPage[] => {
  const rowLimit = contentRows(options.rows);
  const pages: SessionHistoryPage[] = [];
  let offset = 0;
  while (offset < rows.length || pages.length === 0) {
    const pageEntries: SessionHistoryEntry[] = [];
    let sourceBytes = 0;
    while (offset < rows.length && pageEntries.length < rowLimit) {
      const entry = rows[offset];
      const nextSourceBytes = sourceBytes + encoder.encode(entry.text).byteLength;
      if (nextSourceBytes > HISTORY_PAGE_SOURCE_BYTES && pageEntries.length > 0) break;
      const candidateEntries = [...pageEntries, entry];
      const candidate = emptyPage(
        turn,
        totalTurns,
        pages.length,
        Math.max(1, rows.length),
        options,
      );
      const framed = {
        ...candidate,
        entries: Object.freeze(candidateEntries),
        sourceBytes: nextSourceBytes,
      };
      if (
        encoder.encode(JSON.stringify(framed)).byteLength > HISTORY_PAGE_ESCAPED_BYTES &&
        pageEntries.length > 0
      ) break;
      pageEntries.push(entry);
      sourceBytes = nextSourceBytes;
      offset += 1;
    }
    // splitEntry guarantees one scalar-safe chunk fits; retain it even if a future framing change
    // consumes the entire budget so pagination remains total and tails stay reachable.
    if (pageEntries.length === 0 && offset < rows.length) {
      pageEntries.push(rows[offset]);
      sourceBytes = encoder.encode(rows[offset].text).byteLength;
      offset += 1;
    }
    pages.push(emptyPage(turn, totalTurns, pages.length, 1, options));
    pages[pages.length - 1] = Object.freeze({
      ...pages[pages.length - 1],
      entries: Object.freeze(pageEntries),
      sourceBytes,
    });
  }
  const pageCount = pages.length;
  return Object.freeze(
    pages.map((page, pageIndex) => Object.freeze({ ...page, page: pageIndex, pageCount })),
  );
};

/** Create one read-only page from one turn, bounded in source bytes and rows. */
export const historyPage = (
  transcript: readonly Message[],
  turnNumber: number,
  options: {
    readonly sessionId?: string;
    readonly agent?: SessionRecord['agent'];
    readonly rows?: number;
  } = {},
): SessionHistoryPage | undefined => {
  return historyPageWindow(transcript, turnNumber, 0, options);
};

/** Build page windows over entry rows while retaining only bounded message slices. */
export const historyPageWindow = (
  transcript: readonly Message[],
  turnNumber: number,
  pageNumber: number,
  options: {
    readonly sessionId?: string;
    readonly agent?: SessionRecord['agent'];
    readonly rows?: number;
  } = {},
): SessionHistoryPage | undefined => {
  const index = indexSessionHistory(transcript);
  if (index === undefined || index.turnCount === 0) return undefined;
  const turn = Math.max(
    1,
    Math.min(index.turnCount, Number.isSafeInteger(turnNumber) ? turnNumber : index.turnCount),
  );
  const source = index.turns[turn - 1];
  if (source === undefined) return undefined;
  const pages = paginate(expandedRows(source), turn, index.turnCount, options);
  const page = Math.max(
    0,
    Math.min(pages.length - 1, Number.isSafeInteger(pageNumber) ? pageNumber : pages.length - 1),
  );
  return pages[page];
};
