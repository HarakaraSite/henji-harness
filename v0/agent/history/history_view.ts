import {
  pendingToolActivityText,
  previewFromToolActivityText,
  settledToolActivityText,
  toolActivityPreview,
} from '../tools/tool_activity.ts';
import type { AssistantMessage, ToolCallContent } from '../core/contracts.ts';
import type { StoredSessionRecord } from '../session/session_store_contract.ts';
import type { StoredSessionHistoryExecution } from './history_store_contract.ts';
import type { Message } from '../core/contracts.ts';
import {
  type ConversationEntity,
  type ConversationState,
  orderedConversationEntities,
} from '../../conversation/model.ts';
import { renderHistoryMarkdown } from '../session/history_export.ts';

const TOOL_PREFIX = 'tool> ';
const ASSISTANT_NOTE_LABEL = 'assistant note>';

const isToolCallContent = (
  content: AssistantMessage['content'],
): content is readonly ToolCallContent[] => Array.isArray(content);

/**
 * Render the committed canonical transcript in the same shape as the TUI conversation log:
 * `user>` / `assistant note>` / `assistant>` / `tool>` labels, tool results folded into the `tool>`
 * activity line (no `tool<`), raw assistant Markdown, and a blank separator between turns. Each
 * settled assistant text keeps its own line at its message position: tool-call accompanying text
 * (`assistant note>`) stays before its tool lines and is never replaced by later texts.
 */
const renderMessages = (
  messages: readonly Message[],
  thinking: StoredSessionHistoryExecution['thinking'] = [],
): string[] => {
  const lines: string[] = [];
  const toolLines = new Map<string, number>();
  let seenTurn = false;
  let assistantStep = 0;
  const appendThinking = (step: number): void => {
    for (const observation of thinking) {
      if (observation.modelStep !== step) continue;
      const label = observation.thinkingKind === 'summary'
        ? observation.complete ? 'thinking summary>' : 'thinking summary~'
        : observation.complete
        ? 'thinking>'
        : 'thinking~';
      lines.push(`${label} ${observation.text}`);
    }
  };
  for (const message of messages) {
    if (message.role === 'user') {
      if (seenTurn) lines.push('');
      seenTurn = true;
      toolLines.clear();
      lines.push(`user> ${message.content.text}`);
      continue;
    }
    if (message.role === 'assistant') {
      assistantStep += 1;
      appendThinking(assistantStep);
      const assistantText = isToolCallContent(message.content)
        ? message.text
        : message.content.text;
      if (assistantText !== undefined) {
        const label = isToolCallContent(message.content) ? ASSISTANT_NOTE_LABEL : 'assistant>';
        lines.push(`${label} ${assistantText}`);
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
  for (const observation of thinking) {
    if (observation.modelStep <= assistantStep) continue;
    const label = observation.thinkingKind === 'summary'
      ? observation.complete ? 'thinking summary>' : 'thinking summary~'
      : observation.complete
      ? 'thinking>'
      : 'thinking~';
    lines.push(`${label} ${observation.text}`);
  }
  return lines;
};

export const renderSessionView = (record: StoredSessionRecord): string => {
  const lines = renderMessages(record.transcript);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

/** Render all executions in one Session from semantic history and canonical/noncanonical messages. */
export const renderSessionTimeline = (
  executions: readonly StoredSessionHistoryExecution[],
): string => {
  const blocks = executions.map(({ execution, messages, thinking }) => {
    const header =
      `# execution ${execution.executionId} · ${execution.adoption} · ${execution.outcome}`;
    const lines = renderMessages(messages, thinking);
    if (!messages.some((message) => message.role === 'user')) {
      lines.unshift(`user> ${execution.task}`);
    }
    return [header, ...lines].join('\n');
  });
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
};

const renderConversationEntities = (entities: readonly ConversationEntity[]): string[] => {
  const lines: string[] = [];
  for (const entity of entities) {
    if (entity.kind === 'message') {
      if (entity.role === 'user') {
        lines.push(`user> ${entity.text}`);
      } else {
        const isToolNote = (entity.toolIds?.length ?? 0) > 0 ||
          (entity.toolOccurrenceIds?.length ?? 0) > 0;
        const label = isToolNote
          ? entity.complete ? 'assistant note>' : 'assistant note~'
          : entity.complete
          ? 'assistant>'
          : 'assistant~';
        lines.push(`${label} ${entity.text}`);
      }
      continue;
    }
    if (entity.kind === 'thinking') {
      const label = entity.thinkingKind === 'summary'
        ? entity.complete ? 'thinking summary>' : 'thinking summary~'
        : entity.complete
        ? 'thinking>'
        : 'thinking~';
      lines.push(`${label} ${entity.text}`);
      continue;
    }
    if (entity.kind === 'tool') {
      const preview = toolActivityPreview(entity.name, entity.arguments);
      if (entity.result !== undefined) {
        lines.push(
          `${TOOL_PREFIX}${settledToolActivityText(entity.name, entity.result.outcome, preview)}`,
        );
      } else {
        lines.push(`${TOOL_PREFIX}${pendingToolActivityText(entity.name, preview)}`);
        if (entity.progress !== undefined) lines.push(`  ${entity.progress}`);
      }
    }
  }
  return lines;
};

/** Render the session CLI from the shared keyed conversation state. */
export const renderConversationTimeline = (state: ConversationState): string => {
  const byExecution = new Map<string, ConversationEntity[]>();
  for (const entity of orderedConversationEntities(state)) {
    const list = byExecution.get(entity.executionId) ?? [];
    list.push(entity);
    byExecution.set(entity.executionId, list);
  }
  const executions = [...byExecution.entries()].flatMap(([executionId, entities]) => {
    const entity = entities.find((candidate) => candidate.kind === 'execution');
    return entity?.kind === 'execution' ? [{ executionId, entity }] : [];
  });
  const blocks = executions.map(({ executionId, entity }) => {
    const items = byExecution.get(executionId) ?? [];
    const header =
      `# execution ${entity.executionId} · ${entity.execution.adoption} · ${entity.execution.outcome}`;
    return [header, ...renderConversationEntities(items)].join('\n');
  });
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
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
