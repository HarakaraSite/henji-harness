import type {
  ApiMessage,
  ApiThinking,
  ApiToolOccurrence,
  RequestKey,
  SessionSnapshot,
} from '../api/contract.ts';
import { requestKeyIdentity } from '../api/reducer.ts';
import {
  pendingToolActivityText,
  settledToolActivityText,
  toolActivityPreview,
} from '../agent/tools/tool_activity.ts';
import { freezeUiLogEntry, type UiLogEntry } from './state.ts';
import type { PresentationPosition, PresentationStartupState } from '../presentation/contract.ts';

/** Display Core-owned orientation without loading workspace resources in the connected UI. */
export const presentationStartupFromSnapshot = (
  snapshot: SessionSnapshot,
  workspace: string,
): PresentationStartupState => ({
  ...snapshot.session.startup,
  startupEvaluation: snapshot.session.startup.status,
  coreEpoch: snapshot.cursor.coreEpoch,
  workspace,
  agentId: snapshot.session.position.agent,
  model: { ...snapshot.session.startup.model, ...snapshot.session.selection },
});

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

export interface SnapshotConversationProjectionHint {
  readonly messageIds?: readonly string[];
  readonly toolOccurrenceIds?: readonly string[];
  readonly thinkingIds?: readonly string[];
  readonly resync?: boolean;
}

export interface SnapshotConversationProjection {
  readonly entries: readonly UiLogEntry[];
  readonly omitted: number;
}

interface EntrySpec {
  readonly id: string;
  readonly kind: UiLogEntry['kind'];
  readonly label: string;
  readonly text: string;
  readonly live: boolean;
  readonly turn?: number;
  readonly callId?: string;
  readonly executionId?: string;
}

interface RetainedEntry {
  readonly entry: UiLogEntry;
  readonly sourceText: string;
}

interface ToolProjection {
  readonly name: string;
  readonly previewFields: readonly unknown[];
  readonly preview: string;
  readonly outcome?: 'success' | 'error';
}

interface MessageProjection {
  readonly source: ApiMessage;
  readonly index: number;
  readonly dependencies: readonly string[];
  readonly userLabel?: string;
  readonly specs: readonly EntrySpec[];
}

interface ThinkingProjection {
  readonly source: ApiThinking;
  readonly spec: EntrySpec;
}

const toolArgs = (
  tool: ApiToolOccurrence,
): Record<string, unknown> | undefined =>
  typeof tool.arguments === 'object' && tool.arguments !== null &&
    !Array.isArray(tool.arguments)
    ? tool.arguments as Record<string, unknown>
    : undefined;

const toolPreviewFields = (tool: ApiToolOccurrence): readonly unknown[] => {
  const args = toolArgs(tool);
  switch (tool.name) {
    case 'bash':
      return [args?.command];
    case 'read':
      return [args?.path, args?.offset, args?.limit];
    case 'write':
    case 'edit':
      return [args?.path];
    case 'bash_output':
      return [args?.stream, args?.offset, args?.limit];
    case 'web_search':
      return [args?.query];
    case 'web_fetch':
      return [args?.url];
    case 'skill':
      return [args?.name];
    case 'spawn_subagent':
      return [args?.agent];
    default:
      return [];
  }
};

const sameFields = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => Object.is(value, right[index]));

const sameEntryMetadata = (left: UiLogEntry, right: EntrySpec): boolean =>
  left.id === right.id && left.kind === right.kind &&
  left.label === right.label &&
  left.live === right.live && left.turn === right.turn &&
  left.callId === right.callId && left.executionId === right.executionId;

const sameDisplayedEntry = (left: UiLogEntry, right: UiLogEntry): boolean =>
  left.id === right.id && left.kind === right.kind &&
  left.label === right.label &&
  left.text === right.text && left.live === right.live &&
  left.turn === right.turn &&
  left.callId === right.callId && left.executionId === right.executionId;

export const snapshotThinkingIdentity = (
  requestKey: RequestKey,
  kind: ApiThinking['thinkingKind'],
): string => `${requestKeyIdentity(requestKey)}:${kind}`;

/** Retains the remote Session's display projection while matching every new snapshot. */
export class SnapshotConversationProjector {
  private scope: string | undefined;
  private entries = new Map<string, RetainedEntry>();
  private tools = new Map<string, ToolProjection>();
  private messages = new Map<string, MessageProjection>();
  private thinking = new Map<string, ThinkingProjection>();

  project(
    snapshot: SessionSnapshot,
    scope: string,
    hint: SnapshotConversationProjectionHint = {},
  ): SnapshotConversationProjection {
    if (this.scope !== scope) {
      this.scope = scope;
      this.entries.clear();
      this.tools.clear();
      this.messages.clear();
      this.thinking.clear();
    }
    const hintedMessages = new Set(hint.messageIds ?? []);
    const hintedTools = new Set(hint.toolOccurrenceIds ?? []);
    const hintedThinking = new Set(hint.thinkingIds ?? []);
    const forceRead = hint.resync === true;

    const toolById = new Map(
      snapshot.conversation.tools.map((tool) => [tool.toolOccurrenceId, tool] as const),
    );
    const nextTools = new Map<string, ToolProjection>();
    const changedTools = new Set<string>();
    for (const tool of snapshot.conversation.tools) {
      const id = tool.toolOccurrenceId;
      const previous = this.tools.get(id);
      const fields = toolPreviewFields(tool);
      const previewUnchanged = previous !== undefined &&
        previous.name === tool.name &&
        sameFields(previous.previewFields, fields);
      const preview = previewUnchanged
        ? previous.preview
        : toolActivityPreview(tool.name, tool.arguments);
      const outcome = tool.result?.outcome;
      const next: ToolProjection = Object.freeze({
        name: tool.name,
        previewFields: fields,
        preview,
        ...(outcome === undefined ? {} : { outcome }),
      });
      nextTools.set(id, next);
      if (
        previous === undefined || previous.name !== next.name ||
        previous.preview !== next.preview || previous.outcome !== next.outcome
      ) changedTools.add(id);
      // A stream hint can name a progress-only update. Only display inputs dirty tool rows.
      if (hintedTools.has(id) && !previewUnchanged && previous !== undefined) {
        changedTools.add(id);
      }
    }
    for (const id of this.tools.keys()) {
      if (!nextTools.has(id)) changedTools.add(id);
    }

    const specs: EntrySpec[] = [];
    const specIndexById = new Map<string, number>();
    const addSpec = (spec: EntrySpec, replace = false): void => {
      const existing = specIndexById.get(spec.id);
      if (existing === undefined) {
        specIndexById.set(spec.id, specs.length);
        specs.push(spec);
      } else if (replace) {
        specs[existing] = spec;
      }
    };

    const thinkingAtIndex = new Map<number, ApiThinking[]>();
    for (const item of snapshot.conversation.thinking) {
      if (item.beforeMessageIndex === undefined) continue;
      const current = thinkingAtIndex.get(item.beforeMessageIndex) ?? [];
      current.push(item);
      thinkingAtIndex.set(item.beforeMessageIndex, current);
    }
    const nextThinking = new Map<string, ThinkingProjection>();
    const addThinking = (index: number): void => {
      for (const item of thinkingAtIndex.get(index) ?? []) {
        const identity = snapshotThinkingIdentity(
          item.requestKey,
          item.thinkingKind,
        );
        const id = `restored:thinking:${identity}`;
        const previous = this.thinking.get(identity);
        const projection = previous !== undefined && previous.source === item &&
            !forceRead && !hintedThinking.has(identity)
          ? previous
          : Object.freeze({
            source: item,
            spec: Object.freeze({
              id,
              kind: 'thinking' as const,
              executionId: item.requestKey.executionId,
              label: item.thinkingKind === 'summary'
                ? item.complete ? 'thinking summary>' : 'thinking summary~'
                : item.complete
                ? 'thinking>'
                : 'thinking~',
              text: item.text,
              live: false,
              turn: item.turn,
            }),
          });
        nextThinking.set(identity, projection);
        addSpec(projection.spec);
      }
    };

    const nextMessages = new Map<string, MessageProjection>();
    const callPreviewById = new Map<string, string>();
    const seenUserTurns = new Set<number>();
    for (
      let index = 0;
      index < snapshot.conversation.messages.length;
      index += 1
    ) {
      addThinking(index);
      const message = snapshot.conversation.messages[index];
      if (message === undefined) continue;
      // Saved conversations without execution records reuse API IDs in each turn.
      // The turn is part of their display identity; message ordering is not.
      const messageIdentity = JSON.stringify([message.id, message.turn]);
      const dependencies = message.toolOccurrenceIds ?? [];
      const cached = this.messages.get(messageIdentity);
      const affectedByTool = dependencies.some((id) => changedTools.has(id));
      const cachedDependenciesMatch = cached !== undefined &&
        sameFields(cached.dependencies, dependencies);
      const userLabel = message.role === 'user'
        ? seenUserTurns.has(message.turn) ? 'steer>' : 'user>'
        : undefined;
      if (message.role === 'user') seenUserTurns.add(message.turn);
      const reusable = cached !== undefined && cached.source === message &&
        cached.index === index && cachedDependenciesMatch && !affectedByTool && !forceRead &&
        !hintedMessages.has(message.id) && cached.userLabel === userLabel;
      let projection: MessageProjection;
      if (reusable) {
        projection = cached;
      } else {
        const messageSpecs: EntrySpec[] = [];
        if (message.role === 'user') {
          messageSpecs.push(Object.freeze({
            id: `restored:message:${messageIdentity}`,
            kind: 'user',
            label: userLabel!,
            executionId: message.executionId,
            text: message.text ?? '',
            live: false,
            turn: message.turn,
          }));
        } else if (message.role === 'assistant') {
          const occurrences = dependencies.flatMap((id) => {
            const tool = toolById.get(id);
            return tool === undefined ? [] : [tool];
          });
          if (occurrences.length === 0) {
            messageSpecs.push(Object.freeze({
              id: `restored:message:${messageIdentity}`,
              kind: 'assistant',
              label: 'assistant>',
              executionId: message.executionId,
              text: message.text ?? '',
              live: false,
              turn: message.turn,
            }));
          } else {
            if (message.text !== undefined) {
              messageSpecs.push(Object.freeze({
                id: `restored:message:${messageIdentity}`,
                kind: 'assistant',
                label: 'assistant note>',
                executionId: message.executionId,
                text: message.text,
                live: false,
                turn: message.turn,
              }));
            }
            for (const tool of occurrences) {
              const activity = nextTools.get(tool.toolOccurrenceId);
              if (activity === undefined) continue;
              callPreviewById.set(
                `${message.turn}:${tool.toolOccurrenceId}`,
                activity.preview,
              );
              messageSpecs.push(Object.freeze({
                id: `restored:tool:${tool.toolOccurrenceId}`,
                kind: 'tool',
                label: 'tool>',
                executionId: tool.executionId,
                text: pendingToolActivityText(tool.name, activity.preview),
                live: false,
                turn: message.turn,
                callId: tool.toolOccurrenceId,
              }));
            }
          }
        } else {
          for (const id of dependencies) {
            const tool = toolById.get(id);
            const activity = nextTools.get(id);
            if (tool?.result === undefined || activity === undefined) continue;
            const rowId = `restored:tool:${id}`;
            messageSpecs.push(Object.freeze({
              id: rowId,
              kind: 'tool',
              label: 'tool>',
              executionId: tool.executionId,
              text: settledToolActivityText(
                tool.name,
                tool.result.outcome,
                callPreviewById.get(`${message.turn}:${id}`) ?? '',
              ),
              live: false,
              turn: message.turn,
              callId: id,
            }));
          }
        }
        projection = Object.freeze({
          source: message,
          index,
          dependencies: Object.freeze([...dependencies]),
          ...(userLabel === undefined ? {} : { userLabel }),
          specs: Object.freeze(messageSpecs),
        });
      }
      nextMessages.set(messageIdentity, projection);
      if (message.role === 'assistant') {
        for (const id of dependencies) {
          const activity = nextTools.get(id);
          if (activity !== undefined) {
            callPreviewById.set(`${message.turn}:${id}`, activity.preview);
          }
        }
      }
      for (const spec of projection.specs) {
        // Tool result messages settle the call row at its original timeline location.
        addSpec(spec, message.role === 'tool');
      }
    }
    addThinking(snapshot.conversation.messages.length);

    const nextEntries = new Map<string, RetainedEntry>();
    const entries = specs.map((spec) => {
      const previous = this.entries.get(spec.id);
      if (
        previous !== undefined && previous.sourceText === spec.text &&
        sameEntryMetadata(previous.entry, spec)
      ) {
        nextEntries.set(
          spec.id,
          Object.freeze({
            entry: previous.entry,
            sourceText: spec.text,
          }),
        );
        return previous.entry;
      }
      const normalized = freezeUiLogEntry({
        ...spec,
        revision: previous === undefined ? 0 : previous.entry.revision + 1,
      });
      if (
        previous !== undefined && sameDisplayedEntry(normalized, previous.entry)
      ) {
        nextEntries.set(
          spec.id,
          Object.freeze({
            entry: previous.entry,
            sourceText: spec.text,
          }),
        );
        return previous.entry;
      }
      nextEntries.set(
        spec.id,
        Object.freeze({ entry: normalized, sourceText: spec.text }),
      );
      return normalized;
    });

    this.entries = nextEntries;
    this.tools = nextTools;
    this.messages = nextMessages;
    this.thinking = nextThinking;
    return Object.freeze({
      entries: Object.freeze(entries),
      omitted: snapshot.conversation.omitted,
    });
  }
}
