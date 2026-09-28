import type {
  PresentationMessage,
  PresentationPosition,
  PresentationRestoredConversation,
} from '../presentation/contract.ts';
import type { ApiMessage, ApiToolOccurrence, SessionSnapshot } from '../api/contract.ts';

const asPresentationMessage = (
  message: ApiMessage,
  tools: ReadonlyMap<string, ApiToolOccurrence>,
): PresentationMessage | undefined => {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: { kind: 'text', text: message.text ?? '' },
    };
  }
  const occurrences = (message.toolOccurrenceIds ?? []).flatMap((id) => {
    const occurrence = tools.get(id);
    return occurrence === undefined ? [] : [occurrence];
  });
  if (message.role === 'assistant') {
    if (occurrences.length === 0) {
      return {
        role: 'assistant',
        content: { kind: 'text', text: message.text ?? '' },
      };
    }
    return {
      role: 'assistant',
      content: occurrences.map((occurrence) => ({
        kind: 'tool_call' as const,
        callId: occurrence.toolOccurrenceId,
        name: occurrence.name,
        arguments: occurrence.arguments,
      })),
      ...(message.text === undefined ? {} : { text: message.text }),
    };
  }
  const results = occurrences.flatMap((occurrence) =>
    occurrence.result === undefined ? [] : [{
      kind: 'tool_result' as const,
      callId: occurrence.toolOccurrenceId,
      name: occurrence.name,
      text: occurrence.result.text,
      outcome: occurrence.result.outcome,
      ...(occurrence.result.terminal === undefined ? {} : {
        terminal: occurrence.result.terminal,
      }),
    }]
  );
  return results.length === 0 ? undefined : { role: 'tool', content: results };
};

/** Convert the shared session position into the presentation value used by the remote TUI. */
export const presentationPositionFromSnapshot = (
  snapshot: SessionSnapshot,
): PresentationPosition => {
  const { position } = snapshot.session;
  return {
    sessionId: position.sessionId,
    createdAt: position.createdAt,
    ...(position.title === undefined ? {} : { title: position.title }),
    agent: position.agent,
    committedTurn: position.committedTurn,
    messageCount: position.messageCount,
    ...(position.checkpoint === undefined ? {} : {
      checkpoint: {
        coveredThroughTurn: position.checkpoint.coveredThroughTurn,
        retainedFromTurn: position.checkpoint.retainedFromTurn,
      },
    }),
  };
};

/** Convert a shared snapshot's conversation without importing the in-process Host projection. */
export const restoredConversationFromSnapshot = (
  snapshot: SessionSnapshot,
): PresentationRestoredConversation => {
  const tools = new Map(snapshot.conversation.tools.map((tool) => [tool.toolOccurrenceId, tool]));
  return {
    messages: snapshot.conversation.messages.flatMap((message) => {
      const projected = asPresentationMessage(message, tools);
      return projected === undefined ? [] : [projected];
    }),
    messageTurns: snapshot.conversation.messages.map((message) => message.turn),
    omitted: snapshot.conversation.omitted,
    thinking: snapshot.conversation.thinking.flatMap((item) =>
      item.beforeMessageIndex === undefined ? [] : [{
        beforeMessageIndex: item.beforeMessageIndex,
        turn: item.turn,
        modelStep: item.requestKey.modelStep,
        thinkingKind: item.thinkingKind,
        text: item.text,
        complete: item.complete,
      }]
    ),
  };
};
