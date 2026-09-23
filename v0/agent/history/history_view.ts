import {
  pendingToolActivityText,
  previewFromToolActivityText,
  settledToolActivityText,
  toolActivityPreview,
} from '../tools/tool_activity.ts';
import type { AssistantMessage, ToolCallContent } from '../core/contracts.ts';
import type { StoredSessionRecord } from '../session/session_store_contract.ts';
import { renderHistoryMarkdown } from '../session/history_export.ts';

const TOOL_PREFIX = 'tool> ';

const isToolCallContent = (
  content: AssistantMessage['content'],
): content is readonly ToolCallContent[] => Array.isArray(content);

/**
 * Render the committed canonical transcript in the same shape as the TUI conversation log:
 * `user>` / `assistant>` / `tool>` labels, tool results folded into the `tool>` activity line
 * (no `tool<`), raw assistant Markdown, and a blank separator between turns.
 */
export const renderSessionView = (record: StoredSessionRecord): string => {
  const lines: string[] = [];
  const toolLines = new Map<string, number>();
  let assistantLine: number | undefined;
  let seenTurn = false;
  for (const message of record.transcript) {
    if (message.role === 'user') {
      if (seenTurn) lines.push('');
      seenTurn = true;
      assistantLine = undefined;
      toolLines.clear();
      lines.push(`user> ${message.content.text}`);
      continue;
    }
    if (message.role === 'assistant') {
      const assistantText = isToolCallContent(message.content)
        ? message.text
        : message.content.text;
      if (assistantText !== undefined) {
        const text = `assistant> ${assistantText}`;
        const currentAssistantLine = assistantLine;
        if (currentAssistantLine === undefined) {
          assistantLine = lines.length;
          lines.push(text);
        } else if (
          !isToolCallContent(message.content) &&
          [...toolLines.values()].some((index) => index > currentAssistantLine)
        ) {
          lines.splice(currentAssistantLine, 1);
          for (const [callId, index] of toolLines) {
            if (index > currentAssistantLine) toolLines.set(callId, index - 1);
          }
          assistantLine = lines.length;
          lines.push(text);
        } else {
          lines[currentAssistantLine] = text;
        }
      }
      if (isToolCallContent(message.content)) {
        for (const call of message.content) {
          const preview = toolActivityPreview(call.name, call.arguments);
          toolLines.set(call.callId, lines.length);
          lines.push(`${TOOL_PREFIX}${pendingToolActivityText(call.name, preview)}`);
        }
      }
      continue;
    }
    for (const result of message.content) {
      const index = toolLines.get(result.callId);
      const preview = index === undefined
        ? ''
        : previewFromToolActivityText(lines[index].slice(TOOL_PREFIX.length), result.name);
      const text = `${TOOL_PREFIX}${settledToolActivityText(result.name, result.outcome, preview)}`;
      if (index === undefined) lines.push(text);
      else lines[index] = text;
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

/** Render the committed canonical transcript as the structured Markdown snapshot. */
export const renderCanonicalView = (
  record: StoredSessionRecord,
  workspaceRoot: string,
): string =>
  renderHistoryMarkdown({
    transcript: record.transcript,
    position: {
      agent: record.agent,
      committedTurn: record.nextTurn - 1,
      createdAt: record.createdAt,
      ...(record.title === null ? {} : { title: record.title }),
    },
    session: { kind: 'durable', sessionId: record.sessionId },
  }, workspaceRoot);
