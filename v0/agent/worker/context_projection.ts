import type { Message } from '../core/contracts.ts';

export interface TranscriptProjectionUnit {
  readonly kind: 'assistant_response' | 'tool_exchange' | 'orphan_tool';
  /** Message positions in the original transcript, not a projected transcript. */
  readonly indices: readonly number[];
  readonly complete: boolean;
}

const assistantCalls = (message: Message): readonly string[] =>
  message.role === 'assistant' && Array.isArray(message.content)
    ? message.content.map((content) => content.callId)
    : [];

/** Build complete assistant-response/tool-result units without renumbering their source messages. */
export const transcriptProjectionUnits = (
  messages: readonly Message[],
): readonly TranscriptProjectionUnit[] => {
  const units: TranscriptProjectionUnit[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.role === 'assistant') {
      const callIds = assistantCalls(message);
      if (callIds.length === 0) {
        units.push({ kind: 'assistant_response', indices: [index], complete: true });
        index += 1;
        continue;
      }
      const expected = new Set(callIds);
      const results = new Set<string>();
      const indices = [index];
      let next = index + 1;
      while (next < messages.length && results.size < expected.size) {
        const candidate = messages[next];
        if (candidate.role !== 'tool') break;
        const matchingResults = candidate.content.filter((result) => expected.has(result.callId));
        if (matchingResults.length === 0) break;
        indices.push(next);
        for (const result of matchingResults) results.add(result.callId);
        next += 1;
      }
      units.push({
        kind: 'tool_exchange',
        indices,
        complete: [...expected].every((callId) => results.has(callId)),
      });
      index = next;
      continue;
    }
    if (message.role === 'tool') {
      units.push({ kind: 'orphan_tool', indices: [index], complete: false });
    }
    index += 1;
  }
  return Object.freeze(units);
};

/** Protect every user message, incomplete exchanges, and the latest current exchange. */
export const currentProtectedMessageIndices = (
  messages: readonly Message[],
  units: readonly TranscriptProjectionUnit[] = transcriptProjectionUnits(messages),
): ReadonlySet<number> => {
  const protectedIndices = new Set<number>();
  messages.forEach((message, index) => {
    if (message.role === 'user') protectedIndices.add(index);
  });
  for (const unit of units) {
    if (!unit.complete) unit.indices.forEach((index) => protectedIndices.add(index));
  }
  const latest = units.at(-1);
  latest?.indices.forEach((index) => protectedIndices.add(index));
  return protectedIndices;
};

/** Protect task/steering, the final response, and the latest complete tool exchange. */
export const recentHistoryProtectedMessageIndices = (
  messages: readonly Message[],
  units: readonly TranscriptProjectionUnit[] = transcriptProjectionUnits(messages),
): ReadonlySet<number> => {
  const protectedIndices = new Set<number>();
  messages.forEach((message, index) => {
    if (message.role === 'user') protectedIndices.add(index);
  });
  for (const unit of units) {
    if (!unit.complete) unit.indices.forEach((index) => protectedIndices.add(index));
  }
  const finalResponse = [...units].reverse().find((unit) =>
    unit.kind === 'assistant_response' && unit.complete
  );
  finalResponse?.indices.forEach((index) => protectedIndices.add(index));
  const latestToolExchange = [...units].reverse().find((unit) =>
    unit.kind === 'tool_exchange' && unit.complete
  );
  latestToolExchange?.indices.forEach((index) => protectedIndices.add(index));
  if (finalResponse === undefined && latestToolExchange === undefined) {
    [...units].reverse().find((unit) => unit.complete)?.indices.forEach((index) =>
      protectedIndices.add(index)
    );
  }
  return protectedIndices;
};

/** Complete response units eligible for removal, ordered oldest first. */
export const oldestRemovableProjectionUnits = (
  units: readonly TranscriptProjectionUnit[],
  protectedIndices: ReadonlySet<number>,
): readonly TranscriptProjectionUnit[] =>
  units.filter((unit) =>
    unit.complete && unit.kind !== 'orphan_tool' &&
    !unit.indices.some((index) => protectedIndices.has(index))
  );

/** Compact sorted zero-based original message positions into inclusive ranges. */
export const messageIndexRanges = (
  indices: Iterable<number>,
): readonly (readonly [number, number])[] => {
  const sorted = [...new Set(indices)].sort((left, right) => left - right);
  const ranges: Array<readonly [number, number]> = [];
  for (const index of sorted) {
    const previous = ranges.at(-1);
    if (previous !== undefined && previous[1] + 1 === index) {
      ranges[ranges.length - 1] = [previous[0], index];
    } else {
      ranges.push([index, index]);
    }
  }
  return Object.freeze(ranges);
};
