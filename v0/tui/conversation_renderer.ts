import { type UiLogEntry } from './state.ts';

export type ConversationLabelTone = 'user' | 'assistant' | 'tool' | 'system' | 'failure';

/**
 * English guidance appended to a stopped-execution failure row of a persisted Session. It names
 * the reference that `/recall` makes available to the next task — the latest stopped execution
 * when no ID is given — and states that the stopped run itself is not resumed.
 */
export const failureRecallGuidance =
  "/recall without an ID references the latest stopped execution's instructions and partial results from the next task; it does not resume the run";

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
  /** Whole-row tone; when set, every rendered row of the entry uses it. */
  readonly rowTone?: ConversationLabelTone;
}

export interface ConversationEntryProjectionOptions {
  /**
   * Whether `/recall` can reference a stopped execution in this Session. `--no-session` rejects
   * `/recall`, so its failure rows keep the reason alone.
   */
  readonly recallAvailable: boolean;
}

/**
 * Pure Host-side projection for non-assistant entries. Assistant bodies go through the
 * assistant renderer seam in `logRows` so they can carry width and inline spans.
 */
export const projectConversationEntry = (
  entry: UiLogEntry,
  options: ConversationEntryProjectionOptions,
): ConversationEntryProjection => {
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
  const failure = entry.kind === 'recoverable';
  const guidance = failure && options.recallAvailable ? ` · ${failureRecallGuidance}` : '';
  return Object.freeze({
    text: `${entry.label} ${entry.text}${guidance}`,
    labelScalarLength: [...entry.label].length,
    ...(labelTone === undefined ? {} : { labelTone }),
    ...(failure ? { rowTone: 'failure' as const } : {}),
  });
};
