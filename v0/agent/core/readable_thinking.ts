import type { JsonValue, ProviderState } from './contracts.ts';

export interface ReadableThinking {
  readonly kind: 'text' | 'summary';
  readonly text: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const joined = (parts: readonly string[]): string =>
  parts.filter((part) => part.length > 0).join('\n\n');

/** Select only provider-supplied readable text; encrypted replay items have no display text. */
export const readableThinkingFromState = (
  state: ProviderState | undefined,
): ReadableThinking | undefined => {
  if (state === undefined) return undefined;
  if ('replayItems' in state) {
    const text: string[] = [];
    const summary: string[] = [];
    for (const rawItem of state.replayItems) {
      const item = record(rawItem);
      if (item?.type !== 'reasoning') continue;
      if (Array.isArray(item.content)) {
        for (const rawPart of item.content) {
          const part = record(rawPart);
          if (part?.type === 'reasoning_text' && typeof part.text === 'string') {
            text.push(part.text);
          }
        }
      }
      if (Array.isArray(item.summary)) {
        for (const rawPart of item.summary) {
          const part = record(rawPart);
          if (part?.type === 'summary_text' && typeof part.text === 'string') {
            summary.push(part.text);
          }
        }
      }
    }
    const full = joined(text);
    if (full.length > 0) return { kind: 'text', text: full };
    const short = joined(summary);
    return short.length > 0 ? { kind: 'summary', text: short } : undefined;
  }
  if (state.reasoning?.text) return { kind: 'text', text: state.reasoning.text };
  return readableThinkingFromDetails(state.reasoningDetails);
};

export const readableThinkingFromDetails = (
  details: readonly JsonValue[] | undefined,
): ReadableThinking | undefined => {
  if (details === undefined) return undefined;
  const text: string[] = [];
  const summary: string[] = [];
  for (const rawDetail of details) {
    const detail = record(rawDetail);
    if (detail?.type === 'reasoning.text' && typeof detail.text === 'string') {
      text.push(detail.text);
    } else if (
      detail?.type === 'reasoning.summary' && typeof detail.summary === 'string'
    ) {
      summary.push(detail.summary);
    }
  }
  const full = joined(text);
  if (full.length > 0) return { kind: 'text', text: full };
  const short = joined(summary);
  return short.length > 0 ? { kind: 'summary', text: short } : undefined;
};
