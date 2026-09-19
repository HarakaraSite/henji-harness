import { type UiLogEntry } from './state.ts';

export type ConversationLabelTone = 'user' | 'assistant' | 'tool' | 'system';

export interface AssistantContentRenderer {
  render(text: string, phase: 'streaming' | 'settled'): string;
}

/** The increment-4 default keeps the existing assistant body byte-for-byte. */
export const plainTextAssistantRenderer: AssistantContentRenderer = Object.freeze({
  render: (text: string): string => text,
});

export interface ConversationEntryProjection {
  readonly text: string;
  readonly labelScalarLength: number;
  readonly labelTone?: ConversationLabelTone;
}

/** Pure Host-side projection. Terminal styling remains a later renderer concern. */
export const projectConversationEntry = (
  entry: UiLogEntry,
  assistantRenderer: AssistantContentRenderer = plainTextAssistantRenderer,
): ConversationEntryProjection => {
  const body = entry.kind === 'assistant'
    ? assistantRenderer.render(entry.text, entry.live ? 'streaming' : 'settled')
    : entry.text;
  const labelTone = entry.label === 'user>'
    ? 'user' as const
    : entry.label === 'assistant>' || entry.label === 'assistant~'
    ? 'assistant' as const
    : entry.label === 'tool>'
    ? 'tool' as const
    : entry.label === 'system>'
    ? 'system' as const
    : undefined;
  return Object.freeze({
    text: `${entry.label} ${body}`,
    labelScalarLength: [...entry.label].length,
    ...(labelTone === undefined ? {} : { labelTone }),
  });
};
