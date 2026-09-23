import { type Message } from '../core/contracts.ts';
import { causalTranscriptIndex, causalTranscriptPrefixIndex } from './session_store.ts';

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
