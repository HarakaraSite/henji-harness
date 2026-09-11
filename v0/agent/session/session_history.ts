import { type Message } from '../core/contracts.ts';
import {
  causalTranscriptIndex,
  causalTranscriptPrefixIndex,
  type SessionRecord,
} from './session_store.ts';

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
  readonly role: 'user' | 'steer' | 'assistant' | 'tool>' | 'tool<';
  readonly messageIndex: number;
  readonly text: string;
  readonly sourceScalarStart?: number;
}

export interface SessionHistoryMatch {
  readonly query: string;
  readonly ordinal: number;
  readonly total: number;
  readonly turn: number;
  readonly role: SessionHistoryEntry['role'];
  readonly messageIndex: number;
  readonly sourceScalarStart: number;
  readonly sourceScalarLength: number;
  readonly pageEntry: number;
}

export interface SessionHistorySearchResult {
  readonly page: SessionHistoryPage;
  readonly match: SessionHistoryMatch;
}

export const HISTORY_PAGE_SOURCE_BYTES = 8_192;
export const HISTORY_PAGE_ESCAPED_BYTES = 32 * 1_024;
export const HISTORY_PAGE_ROWS = 16;

const asText = (message: Message): string => {
  if (message.role === 'user') return (message.content as { readonly text: string }).text;
  if (message.role === 'assistant') {
    if (Array.isArray(message.content)) {
      const calls = message.content.map((call) => call.name).join(', ');
      return message.text === undefined ? calls : `${message.text}\n${calls}`;
    }
    return (message.content as { readonly text: string }).text;
  }
  return message.content.map((result) => result.text).join('\n');
};

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
  for (let offset = 0; offset < turn.messages.length; offset += 1) {
    const message = turn.messages[offset];
    if (message.role === 'user') {
      rows.push({
        turn: turn.turn,
        role: offset === 0 ? 'user' : 'steer',
        messageIndex: turn.start + offset,
        text: asText(message),
      });
    } else if (message.role === 'assistant') {
      rows.push({
        turn: turn.turn,
        role: 'assistant',
        messageIndex: turn.start + offset,
        text: asText(message),
      });
      if (Array.isArray(message.content)) {
        const tool = turn.messages[offset + 1];
        if (tool?.role === 'tool') {
          for (const result of tool.content) {
            rows.push({
              turn: turn.turn,
              role: 'tool>',
              messageIndex: turn.start + offset,
              text: result.name,
            });
            rows.push({
              turn: turn.turn,
              role: 'tool<',
              messageIndex: turn.start + offset + 1,
              text: result.text,
            });
          }
        }
      }
    }
  }
  return rows;
};

const splitEntry = (entry: SessionHistoryEntry): SessionHistoryEntry[] => {
  const points = [...entry.text];
  if (points.length === 0) return [{ ...entry, sourceScalarStart: 0 }];
  const chunks: SessionHistoryEntry[] = [];
  let text = '';
  let sourceBytes = 0;
  let escapedBytes = 0;
  let sourceScalarStart = 0;
  for (const point of points) {
    const pointSourceBytes = encoder.encode(point).byteLength;
    const pointEscapedBytes = pointSourceBytes;
    if (
      text.length > 0 &&
      (sourceBytes + pointSourceBytes > HISTORY_CHUNK_SOURCE_BYTES ||
        escapedBytes + pointEscapedBytes > HISTORY_CHUNK_ESCAPED_BYTES)
    ) {
      chunks.push(Object.freeze({ ...entry, text, sourceScalarStart }));
      sourceScalarStart += [...text].length;
      text = '';
      sourceBytes = 0;
      escapedBytes = 0;
    }
    text += point;
    sourceBytes += pointSourceBytes;
    escapedBytes += pointEscapedBytes;
  }
  if (text.length > 0) {
    chunks.push(Object.freeze({ ...entry, text, sourceScalarStart }));
  }
  return chunks;
};

const expandedRows = (turn: SessionHistoryTurn): readonly SessionHistoryEntry[] =>
  Object.freeze(entryRows(turn).flatMap(splitEntry));

interface ExpandedHistoryEntry {
  readonly entry: SessionHistoryEntry;
  readonly entryOrdinal: number;
  readonly sourceScalarStart: number;
  readonly sourceScalarLength: number;
}

const expandedRowsWithSource = (
  turn: SessionHistoryTurn,
): readonly ExpandedHistoryEntry[] =>
  Object.freeze(
    entryRows(turn).flatMap((entry, entryOrdinal) => {
      return splitEntry(entry).map((chunk) => {
        const sourceScalarLength = [...chunk.text].length;
        const expanded = Object.freeze({
          entry: chunk,
          entryOrdinal,
          sourceScalarStart: chunk.sourceScalarStart ?? 0,
          sourceScalarLength,
        });
        return expanded;
      });
    }),
  );

interface FoldedText {
  readonly points: readonly string[];
  readonly sourceOffsets: readonly number[];
}

const foldedText = (value: string): FoldedText => {
  const points: string[] = [];
  const sourceOffsets: number[] = [];
  let sourceOffset = 0;
  for (const point of value) {
    for (const folded of point.toLowerCase()) {
      points.push(folded);
      sourceOffsets.push(sourceOffset);
    }
    sourceOffset += 1;
  }
  return Object.freeze({
    points: Object.freeze(points),
    sourceOffsets: Object.freeze(sourceOffsets),
  });
};

const foldedNeedle = (value: string): readonly string[] =>
  Object.freeze([...value].flatMap((point) => [...point.toLowerCase()]));

const pointMatchAt = (
  source: readonly string[],
  needle: readonly string[],
  offset: number,
): boolean => needle.every((point, index) => source[offset + index] === point);

interface IndexedMatch {
  readonly turn: number;
  readonly entryOrdinal: number;
  readonly role: SessionHistoryEntry['role'];
  readonly messageIndex: number;
  readonly sourceScalarStart: number;
  readonly sourceScalarLength: number;
}

const entryMatches = (
  entry: SessionHistoryEntry,
  turn: number,
  entryOrdinal: number,
  needle: readonly string[],
): readonly IndexedMatch[] => {
  const source = foldedText(entry.text);
  const matches: IndexedMatch[] = [];
  for (let offset = 0; offset + needle.length <= source.points.length; offset += 1) {
    if (!pointMatchAt(source.points, needle, offset)) continue;
    const start = source.sourceOffsets[offset];
    const last = source.sourceOffsets[offset + needle.length - 1];
    matches.push(Object.freeze({
      turn,
      entryOrdinal,
      role: entry.role,
      messageIndex: entry.messageIndex,
      sourceScalarStart: start,
      sourceScalarLength: Math.max(1, last - start + 1),
    }));
  }
  return Object.freeze(matches);
};

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

/**
 * Find a literal, case-insensitive match in the complete committed transcript and return only the
 * bounded history page that contains it. Match ordinals are chronological and zero-based.
 */
export const searchSessionHistory = (
  transcript: readonly Message[],
  query: string,
  matchOrdinal = 0,
  options: {
    readonly sessionId?: string;
    readonly agent?: SessionRecord['agent'];
    readonly rows?: number;
  } = {},
): SessionHistorySearchResult | undefined => {
  const needle = foldedNeedle(query);
  if (needle.length === 0) return undefined;
  const index = indexSessionHistory(transcript);
  if (index === undefined || index.turnCount === 0) return undefined;

  const matches = index.turns.flatMap((turn) =>
    entryRows(turn).flatMap((entry, entryOrdinal) =>
      entryMatches(entry, turn.turn, entryOrdinal, needle)
    )
  );
  if (matches.length === 0) return undefined;

  const ordinal = Math.max(
    0,
    Math.min(
      matches.length - 1,
      Number.isSafeInteger(matchOrdinal) ? matchOrdinal : 0,
    ),
  );
  const selected = matches[ordinal];
  const turn = index.turns[selected.turn - 1];
  if (turn === undefined) return undefined;

  const expanded = expandedRowsWithSource(turn);
  const chunkIndex = expanded.findIndex((chunk) =>
    chunk.entryOrdinal === selected.entryOrdinal &&
    selected.sourceScalarStart >= chunk.sourceScalarStart &&
    selected.sourceScalarStart < chunk.sourceScalarStart + chunk.sourceScalarLength
  );
  if (chunkIndex < 0) return undefined;

  const pages = paginate(
    expanded.map((chunk) => chunk.entry),
    selected.turn,
    index.turnCount,
    options,
  );
  let pageOffset = 0;
  const pageIndex = pages.findIndex((page) => {
    const contains = chunkIndex >= pageOffset && chunkIndex < pageOffset + page.entries.length;
    pageOffset += page.entries.length;
    return contains;
  });
  if (pageIndex < 0) return undefined;
  const page = pages[pageIndex];
  const precedingEntries = pages.slice(0, pageIndex).reduce(
    (count, candidate) => count + candidate.entries.length,
    0,
  );

  return Object.freeze({
    page,
    match: Object.freeze({
      query,
      ordinal,
      total: matches.length,
      turn: selected.turn,
      role: selected.role,
      messageIndex: selected.messageIndex,
      sourceScalarStart: selected.sourceScalarStart,
      sourceScalarLength: selected.sourceScalarLength,
      pageEntry: chunkIndex - precedingEntries,
    }),
  });
};
