import { type UiLogEntry } from './state.ts';

export type ConversationLabelTone = 'user' | 'assistant' | 'tool' | 'system';

/** Host-local inline style for a rendered assistant body line. */
export type AssistantSpanTone =
  | 'heading'
  | 'list'
  | 'table'
  | 'quote'
  | 'bold'
  | 'emphasis';

export interface AssistantSpan {
  readonly start: number;
  readonly length: number;
  readonly tone: AssistantSpanTone;
}

export interface AssistantLine {
  readonly text: string;
  readonly spans: readonly AssistantSpan[];
  /** Host-local origin used to keep the viewed content in place after reflow. */
  readonly sourceLine?: number;
  readonly sourceColumn?: number;
}

export interface AssistantContentRenderer {
  render(
    text: string,
    phase: 'streaming' | 'settled',
    width: number,
  ): readonly AssistantLine[];
}

const plainLines = (text: string): readonly AssistantLine[] =>
  Object.freeze(
    text.split('\n').map((line, sourceLine) =>
      Object.freeze({ text: line, spans: Object.freeze([]), sourceLine, sourceColumn: 0 })
    ),
  );

/** The default keeps the existing assistant body text unchanged and emits no inline spans. */
export const plainTextAssistantRenderer: AssistantContentRenderer = Object.freeze({
  render: (text: string): readonly AssistantLine[] => plainLines(text),
});

export interface ConversationEntryProjection {
  readonly text: string;
  readonly labelScalarLength: number;
  readonly labelTone?: ConversationLabelTone;
}

/**
 * Pure Host-side projection for non-assistant entries. Assistant bodies go through the
 * assistant renderer seam in `logRows` so they can carry width and inline spans.
 */
export const projectConversationEntry = (entry: UiLogEntry): ConversationEntryProjection => {
  const labelTone = entry.label === 'user>'
    ? 'user' as const
    : entry.label === 'assistant>' || entry.label === 'assistant~'
    ? 'assistant' as const
    : entry.kind === 'thinking'
    ? 'assistant' as const
    : entry.label === 'tool>'
    ? 'tool' as const
    : entry.label === 'system>'
    ? 'system' as const
    : undefined;
  return Object.freeze({
    text: `${entry.label} ${entry.text}`,
    labelScalarLength: [...entry.label].length,
    ...(labelTone === undefined ? {} : { labelTone }),
  });
};
