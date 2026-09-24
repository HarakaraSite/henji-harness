import {
  type PresentationContextPreview,
  type PresentationEvent,
  type PresentationFailureDiagnostic,
  type PresentationLifecycle,
  type PresentationNavigationListing,
  type PresentationPosition,
  type PresentationProjection,
  type PresentationRestoredThinking,
  type PresentationStartupState,
  snapshotPresentation,
} from '../presentation/contract.ts';
import { type EditorSnapshot } from './input.ts';
import { type PendingMetadataSnapshot } from './pending_input.ts';
import {
  pendingToolActivityText,
  previewFromToolActivityText,
  settledToolActivityText,
  toolActivityPreview,
} from '../agent/tools/tool_activity.ts';
import { MAX_CONVERSATION_TEXT_BYTES } from '../resource_limits.ts';

export const UI_MAX_ENTRY_BYTES = MAX_CONVERSATION_TEXT_BYTES;
export const UI_MAX_NEW_BELOW = 512;

export type UiLogKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'warning'
  | 'recoverable'
  | 'fatal'
  | 'system';

export interface UiLogEntry {
  readonly id: string;
  readonly kind: UiLogKind;
  readonly label: string;
  readonly text: string;
  readonly revision: number;
  readonly live: boolean;
  readonly turn?: number;
  readonly callId?: string;
  readonly executionId?: string;
}

export type UiOverlay =
  | Readonly<{ readonly kind: 'none' }>
  | Readonly<
    { readonly kind: 'startupHelp'; readonly lines?: readonly string[] }
  >
  | Readonly<{
    readonly kind: 'sessionPicker';
    readonly listing?: PresentationNavigationListing;
    readonly selected: number;
    readonly page: number;
    readonly loading?: boolean;
  }>
  | Readonly<{
    readonly kind: 'choicePicker';
    readonly lines: readonly string[];
  }>
  | Readonly<
    {
      readonly kind: 'compaction';
      readonly preview?: PresentationContextPreview;
    }
  >;

export type UiScroll =
  | Readonly<{ readonly kind: 'followLatest' }>
  | Readonly<{ readonly kind: 'oldest' }>
  | Readonly<
    {
      readonly kind: 'anchored';
      readonly entryId: string;
      readonly sourceScalarOffset: number;
    }
  >;

export interface UiState {
  readonly projection?: PresentationProjection;
  readonly lifecycle: PresentationLifecycle;
  /** Structured startup facts live in the log band but never become conversation entries. */
  readonly startup?: Readonly<{
    readonly state: PresentationStartupState;
    readonly position: PresentationPosition;
  }>;
  readonly log: Readonly<
    { readonly entries: readonly UiLogEntry[]; readonly omittedCount: number }
  >;
  /** A rendering window over the complete conversation log. */
  readonly historyWindow?: Readonly<{ readonly start: number; readonly end: number }>;
  readonly activeAssistantId?: string;
  readonly activeToolIds: readonly string[];
  readonly turnAttemptOrdinal: number;
  readonly editor: EditorSnapshot;
  readonly pending?: PendingMetadataSnapshot;
  readonly scroll: UiScroll;
  readonly newBelowCount: number;
  readonly overlay: UiOverlay;
  readonly status: string;
  readonly busyElapsedSeconds?: number;
  readonly busySpinnerFrame?: number;
  readonly slashCommandCandidates: readonly string[];
  readonly terminalSize: Readonly<
    { readonly columns: number; readonly rows: number }
  >;
  readonly generation: number;
}

export type UiAction =
  | Readonly<{ readonly kind: 'editor'; readonly snapshot: EditorSnapshot }>
  | Readonly<{ readonly kind: 'clear_live' }>
  | Readonly<
    {
      readonly kind: 'assistant_final';
      readonly turn: number;
      readonly text: string;
    }
  >
  | Readonly<
    { readonly kind: 'pending'; readonly snapshot?: PendingMetadataSnapshot }
  >
  | Readonly<
    { readonly kind: 'resize'; readonly columns: number; readonly rows: number }
  >
  | Readonly<{ readonly kind: 'status'; readonly text: string }>
  | Readonly<{ readonly kind: 'busy_elapsed'; readonly seconds?: number }>
  | Readonly<{ readonly kind: 'busy_spinner'; readonly frame?: number }>
  | Readonly<{
    readonly kind: 'slash_command_candidates';
    readonly candidates: readonly string[];
  }>
  | Readonly<{
    readonly kind: 'startup';
    readonly state: PresentationStartupState;
    readonly position: PresentationPosition;
  }>
  | Readonly<{ readonly kind: 'session_title'; readonly title: string }>
  | Readonly<{ readonly kind: 'scroll'; readonly mode: UiScroll }>
  | Readonly<{ readonly kind: 'latest' }>
  | Readonly<{ readonly kind: 'overlay'; readonly overlay: UiOverlay }>;

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).byteLength;
const snapshot = <T>(value: T): T => snapshotPresentation(value);

const safeText = (text: string): string => {
  return safeTextToBytes(text, UI_MAX_ENTRY_BYTES);
};

const safeTextToBytes = (text: string, limit: number): string => {
  let used = 0;
  let result = '';
  for (const character of text) {
    const size = bytes(character);
    if (used + size > Math.max(0, limit)) break;
    result += character;
    used += size;
  }
  return result;
};

/** Stable, short failure reasons; diagnostic identifiers and provider details stay out of the UI. */
export const presentationFailureReason = (
  diagnostic: PresentationFailureDiagnostic,
): string => {
  switch (diagnostic.code) {
    case 'turn_cancelled':
      return 'cancelled';
    case 'missing_credential':
      return 'credential unavailable';
    case 'invalid_input':
      return 'invalid input';
    case 'request_budget_exhausted':
      return 'request budget exhausted';
    case 'provider_timeout':
      return 'provider deadline exceeded';
    case 'transport_error':
      return 'provider connection failed';
    case 'http_error':
      return 'provider request failed';
    case 'response_error':
      return 'provider response invalid';
    case 'limit_exceeded':
      return 'provider response limit exceeded';
    case 'invalid_model_result':
      return 'model result invalid';
    case 'commit_error':
      return 'session save failed';
    case 'cleanup_error':
      return 'cancellation cleanup failed';
    case 'model_step_limit':
      return 'step limit reached';
    case 'unknown_code':
      return diagnostic.stage === 'unknown_stage' ? 'agent failure' : 'operation failed';
  }
};

const freezeEntry = (entry: UiLogEntry): UiLogEntry =>
  Object.freeze({ ...entry, text: safeText(entry.text) });

const HISTORY_WINDOW_BYTES = 1024 * 1024;
const HISTORY_WINDOW_ENTRIES = 48;

const historyWindowEndingAt = (
  entries: readonly UiLogEntry[],
  end: number,
): Readonly<{ start: number; end: number }> => {
  let start = end;
  let size = 0;
  while (start > 0 && end - start < HISTORY_WINDOW_ENTRIES) {
    const nextSize = bytes(entries[start - 1].text);
    if (start < end && size + nextSize > HISTORY_WINDOW_BYTES) break;
    start -= 1;
    size += nextSize;
  }
  return Object.freeze({ start, end });
};

const historyWindowStartingAt = (
  entries: readonly UiLogEntry[],
  start: number,
): Readonly<{ start: number; end: number }> => {
  let end = start;
  let size = 0;
  while (end < entries.length && end - start < HISTORY_WINDOW_ENTRIES) {
    const nextSize = bytes(entries[end].text);
    if (end > start && size + nextSize > HISTORY_WINDOW_BYTES) break;
    end += 1;
    size += nextSize;
  }
  return Object.freeze({ start, end });
};

export const pageHistoryWindow = (state: UiState, direction: 'up' | 'down'): UiState => {
  const window = state.historyWindow;
  if (window === undefined) return state;
  if (direction === 'up') {
    if (window.start === 0) return state;
    const next = historyWindowEndingAt(state.log.entries, window.start);
    return Object.freeze({
      ...state,
      historyWindow: next,
      scroll: Object.freeze({ kind: 'followLatest' as const }),
    });
  }
  if (window.end >= state.log.entries.length) return state;
  const next = historyWindowStartingAt(state.log.entries, window.end);
  return Object.freeze({
    ...state,
    historyWindow: next,
    scroll: Object.freeze({ kind: 'oldest' as const }),
  });
};

const turnEntryId = (state: UiState, turn: number, suffix: string): string =>
  `turn-${turn}:attempt-${state.turnAttemptOrdinal}:${suffix}`;

const appendEntry = (
  state: UiState,
  entry: UiLogEntry,
  beforeIndex?: number,
): UiState => {
  const incoming = freezeEntry(entry);
  const entries = [...state.log.entries];
  if (beforeIndex === undefined) entries.push(incoming);
  else {entries.splice(
      Math.max(0, Math.min(entries.length, beforeIndex)),
      0,
      incoming,
    );}
  return Object.freeze({
    ...state,
    log: Object.freeze({ entries: Object.freeze(entries), omittedCount: state.log.omittedCount }),
    historyWindow: state.scroll.kind === 'followLatest'
      ? historyWindowEndingAt(entries, entries.length)
      : state.historyWindow,
  });
};

const replaceEntry = (
  state: UiState,
  id: string,
  text: string,
  live: boolean,
  label?: string,
  relocateToEnd = false,
): UiState => {
  const index = state.log.entries.findIndex((entry) => entry.id === id);
  if (index < 0) return state;
  const entries = [...state.log.entries];
  const prior = entries[index];
  const replacement = freezeEntry({
    ...prior,
    text,
    live,
    ...(label === undefined ? {} : { label }),
    revision: prior.revision + 1,
  });
  if (relocateToEnd && index < entries.length - 1) {
    entries.splice(index, 1);
    entries.push(replacement);
  } else {
    entries[index] = replacement;
  }
  return Object.freeze({
    ...state,
    log: Object.freeze({ entries: Object.freeze(entries), omittedCount: state.log.omittedCount }),
    historyWindow: state.scroll.kind === 'followLatest'
      ? historyWindowEndingAt(entries, entries.length)
      : state.historyWindow,
  });
};

const removeLiveEntries = (
  state: UiState,
  keep: (entry: UiLogEntry) => boolean = () => false,
): UiState => {
  const entries = state.log.entries.filter((entry) => !entry.live || keep(entry));
  if (entries.length === state.log.entries.length) return state;
  let scroll = state.scroll;
  let status = state.status;
  if (scroll.kind === 'anchored') {
    const anchorId = scroll.entryId;
    if (!entries.some((entry) => entry.id === anchorId)) {
      const priorIndex = state.log.entries.findIndex((entry) => entry.id === anchorId);
      const successor = entries[Math.min(Math.max(0, priorIndex), entries.length - 1)];
      scroll = successor === undefined ? Object.freeze({ kind: 'followLatest' }) : Object.freeze({
        kind: 'anchored',
        entryId: successor.id,
        sourceScalarOffset: 0,
      });
      status = 'live output cleared; showing nearest retained entry';
    }
  }
  return Object.freeze({
    ...state,
    status,
    scroll,
    log: Object.freeze({ ...state.log, entries: Object.freeze(entries) }),
    historyWindow: state.historyWindow === undefined
      ? undefined
      : state.scroll.kind === 'followLatest'
      ? historyWindowEndingAt(entries, entries.length)
      : Object.freeze({
        start: Math.min(state.historyWindow.start, entries.length),
        end: Math.min(state.historyWindow.end, entries.length),
      }),
  });
};

const eventLog = (state: UiState, event: PresentationEvent): UiState => {
  switch (event.kind) {
    case 'turn_start':
      return Object.freeze({
        ...state,
        lifecycle: 'busy',
        status: 'busy',
        turnAttemptOrdinal: state.turnAttemptOrdinal + 1,
        activeAssistantId: undefined,
        activeToolIds: Object.freeze([]),
      });
    case 'notice':
      return appendEntry(state, {
        id: `notice:${event.generation}`,
        kind: 'system',
        label: 'system>',
        text: event.text,
        revision: 0,
        live: false,
      });
    case 'user_message':
      return Object.freeze({
        ...appendEntry(state, {
          id: turnEntryId(state, event.turn, 'user'),
          kind: 'user',
          label: 'user>',
          text: event.message.content.text,
          revision: 0,
          live: false,
          turn: event.turn,
        }),
      });
    case 'assistant_message': {
      const assistantText = 'text' in event.message.content
        ? event.message.content.text
        : event.message.text;
      if (assistantText === undefined) return state;
      const id = turnEntryId(state, event.turn, 'assistant');
      const existingIndex = state.log.entries.findIndex((entry) => entry.id === id);
      const relocateFinalAfterTools = !Array.isArray(event.message.content) &&
        existingIndex >= 0 &&
        state.log.entries.slice(existingIndex + 1).some((entry) =>
          entry.turn === event.turn && entry.kind === 'tool'
        );
      const next = existingIndex >= 0
        ? replaceEntry(
          state,
          id,
          assistantText,
          false,
          'assistant>',
          relocateFinalAfterTools,
        )
        : appendEntry(state, {
          id,
          kind: 'assistant',
          label: 'assistant>',
          text: assistantText,
          revision: 0,
          live: false,
          turn: event.turn,
        });
      return Object.freeze({ ...next, activeAssistantId: undefined });
    }
    case 'assistant_progress': {
      const id = turnEntryId(state, event.turn, 'assistant');
      const existingIndex = state.log.entries.findIndex((entry) => entry.id === id);
      const relocateProgressAfterTools = existingIndex >= 0 && state.activeToolIds.length === 0 &&
        state.log.entries.slice(existingIndex + 1).some((entry) =>
          entry.turn === event.turn && entry.kind === 'tool'
        );
      const next = existingIndex >= 0
        ? replaceEntry(state, id, event.text, true, undefined, relocateProgressAfterTools)
        : appendEntry(state, {
          id,
          kind: 'assistant',
          label: 'assistant~',
          text: event.text,
          revision: 0,
          live: true,
          turn: event.turn,
        });
      return Object.freeze({ ...next, activeAssistantId: id });
    }
    case 'assistant_thinking': {
      const id = turnEntryId(state, event.turn, `thinking:${event.modelStep}`);
      const label = event.thinkingKind === 'summary'
        ? event.complete ? 'thinking summary>' : 'thinking summary~'
        : event.complete
        ? 'thinking>'
        : 'thinking~';
      const activeAssistantIndex = state.log.entries.findIndex((entry) =>
        entry.id === state.activeAssistantId && entry.turn === event.turn && entry.live
      );
      return appendEntry(state, {
        id,
        kind: 'thinking',
        label,
        text: event.text,
        revision: 0,
        live: false,
        turn: event.turn,
      }, activeAssistantIndex < 0 ? undefined : activeAssistantIndex);
    }
    case 'tool_call': {
      const id = turnEntryId(state, event.turn, `tool:${event.call.callId}`);
      const preview = toolActivityPreview(event.call.name, event.call.arguments);
      const next = state.log.entries.some((entry) => entry.id === id) ? state : appendEntry(state, {
        id,
        kind: 'tool',
        label: 'tool>',
        text: pendingToolActivityText(event.call.name, preview),
        revision: 0,
        live: true,
        turn: event.turn,
        callId: event.call.callId,
      });
      return Object.freeze({
        ...next,
        activeToolIds: state.activeToolIds.includes(event.call.callId)
          ? state.activeToolIds
          : Object.freeze([...state.activeToolIds, event.call.callId]),
      });
    }
    case 'tool_progress': {
      const id = turnEntryId(state, event.turn, `tool:${event.callId}`);
      const existing = state.log.entries.find((entry) => entry.id === id);
      const preview = existing === undefined
        ? ''
        : previewFromToolActivityText(existing.text, event.name);
      const next = existing === undefined
        ? appendEntry(state, {
          id,
          kind: 'tool',
          label: 'tool>',
          text: pendingToolActivityText(event.name, preview),
          revision: 0,
          live: true,
          turn: event.turn,
          callId: event.callId,
        })
        : replaceEntry(
          state,
          id,
          pendingToolActivityText(event.name, preview),
          true,
        );
      return Object.freeze({
        ...next,
        activeToolIds: state.activeToolIds.includes(event.callId)
          ? state.activeToolIds
          : Object.freeze([...state.activeToolIds, event.callId]),
      });
    }
    case 'tool_result': {
      const id = turnEntryId(state, event.turn, `tool:${event.result.callId}`);
      const existing = state.log.entries.find((entry) => entry.id === id);
      const preview = existing === undefined
        ? ''
        : previewFromToolActivityText(existing.text, event.result.name);
      if (existing === undefined) {
        const next = appendEntry(state, {
          id,
          kind: 'tool',
          label: 'tool>',
          text: settledToolActivityText(event.result.name, event.result.outcome, preview),
          revision: 0,
          live: false,
          turn: event.turn,
          callId: event.result.callId,
        });
        return Object.freeze({
          ...next,
          activeToolIds: Object.freeze(
            next.activeToolIds.filter((value) => value !== event.result.callId),
          ),
        });
      }
      const next = replaceEntry(
        state,
        id,
        settledToolActivityText(event.result.name, event.result.outcome, preview),
        false,
        'tool>',
      );
      return Object.freeze({
        ...next,
        activeToolIds: Object.freeze(
          next.activeToolIds.filter((value) => value !== event.result.callId),
        ),
      });
    }
    case 'steering_message':
      return appendEntry(state, {
        id: turnEntryId(state, event.turn, `steer:${state.log.entries.length}`),
        kind: 'user',
        label: 'steer>',
        text: event.message.content.text,
        revision: 0,
        live: false,
        turn: event.turn,
      });
    case 'turn_end': {
      const withoutLive = removeLiveEntries(
        state,
        (entry) => entry.turn !== event.turn,
      );
      const lifecycle = event.committed
        ? 'idle' as const
        : event.outcome === 'cancelled' || event.outcome === 'max_steps' ||
            event.outcome === 'contract_failure'
        ? 'recoverable_error' as const
        : 'fatal' as const;
      const projection = withoutLive.projection === undefined ? undefined : snapshotPresentation({
        ...withoutLive.projection,
        lifecycle,
        ...(event.committed
          ? { committedTurn: Math.max(withoutLive.projection.committedTurn, event.turn) }
          : {}),
      });
      return Object.freeze({
        ...withoutLive,
        projection,
        lifecycle,
        status: event.committed ? 'ready' : event.outcome,
        activeAssistantId: undefined,
        activeToolIds: Object.freeze([]),
      });
    }
    case 'failure_diagnostic': {
      const id = `failure:${event.diagnostic.diagnosticId}`;
      const withoutLive = removeLiveEntries(
        state,
        (entry) => entry.turn !== event.turn,
      );
      const settled = Object.freeze({
        ...withoutLive,
        activeAssistantId: undefined,
        activeToolIds: Object.freeze([]),
      });
      const text = presentationFailureReason(event.diagnostic);
      if (settled.log.entries.some((entry) => entry.id === id)) {
        return Object.freeze({
          ...settled,
          lifecycle: 'recoverable_error',
          log: Object.freeze({
            ...settled.log,
            entries: Object.freeze(
              settled.log.entries.map((entry) =>
                entry.id === id
                  ? freezeEntry({
                    ...entry,
                    text,
                    ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
                  })
                  : entry
              ),
            ),
          }),
        });
      }
      return appendEntry(
        Object.freeze({ ...settled, lifecycle: 'recoverable_error' }),
        {
          id,
          kind: 'recoverable',
          label: 'failure>',
          text,
          revision: 0,
          live: false,
          turn: event.turn,
          ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
        },
      );
    }
    case 'lifecycle':
      return Object.freeze({
        ...state,
        lifecycle: event.lifecycle,
        generation: event.generation,
      });
    case 'restored_log': {
      const entries: UiLogEntry[] = [];
      const thinkingByIndex = new Map<number, PresentationRestoredThinking[]>();
      for (const item of event.thinking ?? []) {
        const items = thinkingByIndex.get(item.beforeMessageIndex) ?? [];
        items.push(item);
        thinkingByIndex.set(item.beforeMessageIndex, items);
      }
      const addThinking = (index: number): void => {
        for (const item of thinkingByIndex.get(index) ?? []) {
          entries.push(freezeEntry({
            id: `restored:thinking:${item.turn}:${item.modelStep}:${index}`,
            kind: 'thinking',
            label: item.thinkingKind === 'summary'
              ? item.complete ? 'thinking summary>' : 'thinking summary~'
              : item.complete
              ? 'thinking>'
              : 'thinking~',
            text: item.text,
            revision: 0,
            live: false,
            turn: item.turn,
          }));
        }
      };
      let turn = 0;
      const seenUserTurns = new Set<number>();
      const assistantIndexByTurn = new Map<number, number>();
      const callPreviewById = new Map<string, string>();
      for (let index = 0; index < event.messages.length; index += 1) {
        addThinking(index);
        const message = event.messages[index];
        turn = event.messageTurns?.[index] ?? (message.role === 'user' ? turn + 1 : turn);
        if (message.role === 'user') {
          const steering = seenUserTurns.has(turn);
          seenUserTurns.add(turn);
          entries.push(freezeEntry({
            id: `restored:user:${index}`,
            kind: 'user',
            label: steering ? 'steer>' : 'user>',
            text: message.content.text,
            revision: 0,
            live: false,
            turn,
          }));
        } else if (message.role === 'assistant') {
          const assistantText = 'text' in message.content ? message.content.text : message.text;
          if (assistantText !== undefined) {
            const priorIndex = assistantIndexByTurn.get(turn);
            if (priorIndex !== undefined) {
              entries.splice(priorIndex, 1);
              for (const [priorTurn, storedIndex] of assistantIndexByTurn) {
                if (storedIndex > priorIndex) assistantIndexByTurn.set(priorTurn, storedIndex - 1);
              }
            }
            assistantIndexByTurn.set(turn, entries.length);
            entries.push(freezeEntry({
              id: `restored:assistant:${turn}`,
              kind: 'assistant',
              label: 'assistant>',
              text: assistantText,
              revision: 0,
              live: false,
              turn,
            }));
          }
          if (Array.isArray(message.content)) {
            for (const call of message.content) {
              const preview = toolActivityPreview(call.name, call.arguments);
              callPreviewById.set(`${turn}:${call.callId}`, preview);
              entries.push(freezeEntry({
                id: `restored:tool:${turn}:${call.callId}`,
                kind: 'tool',
                label: 'tool>',
                text: pendingToolActivityText(call.name, preview),
                revision: 0,
                live: false,
                turn,
                callId: call.callId,
              }));
            }
          }
        } else {
          for (const result of message.content) {
            const id = `restored:tool:${turn}:${result.callId}`;
            const text = settledToolActivityText(
              result.name,
              result.outcome,
              callPreviewById.get(`${turn}:${result.callId}`) ?? '',
            );
            const priorIndex = entries.findIndex((entry) => entry.id === id);
            if (priorIndex >= 0) {
              entries[priorIndex] = freezeEntry({ ...entries[priorIndex], text, revision: 1 });
            } else {
              entries.push(freezeEntry({
                id,
                kind: 'tool',
                label: 'tool>',
                text,
                revision: 0,
                live: false,
                turn,
                callId: result.callId,
              }));
            }
          }
        }
      }
      addThinking(event.messages.length);
      if (event.omitted > 0) {
        entries.push(freezeEntry({
          id: `history:omitted:${event.omitted}`,
          kind: 'warning',
          label: 'history>',
          text: `${event.omitted} messages omitted`,
          revision: 0,
          live: false,
        }));
      }
      return Object.freeze({
        ...state,
        log: Object.freeze({ entries: Object.freeze(entries), omittedCount: 0 }),
        historyWindow: historyWindowEndingAt(entries, entries.length),
        scroll: Object.freeze({ kind: 'followLatest' as const }),
        newBelowCount: 0,
        overlay: Object.freeze({ kind: 'none' }),
      });
    }
    case 'session_binding_replaced':
      return Object.freeze({
        ...state,
        startup: state.startup === undefined ? undefined : Object.freeze({
          state: Object.freeze({
            ...state.startup.state,
            sessionMode: Object.freeze({ kind: 'exact' as const }),
          }),
          position: event.position,
        }),
        projection: state.projection === undefined ? undefined : snapshotPresentation({
          ...state.projection,
          sessionId: event.position.sessionId,
          committedTurn: event.position.committedTurn,
          checkpoint: event.position.checkpoint,
          ...(event.modelSelection === undefined ? {} : { model: event.modelSelection }),
        }),
        scroll: Object.freeze({ kind: 'followLatest' as const }),
        newBelowCount: 0,
        overlay: Object.freeze({ kind: 'none' }),
      });
    case 'model_selection_changed':
      return Object.freeze({
        ...state,
        projection: state.projection === undefined ? undefined : snapshotPresentation({
          ...state.projection,
          model: event.selection,
        }),
      });
    case 'context_preview':
      return Object.freeze({
        ...state,
        overlay: snapshot({
          kind: 'compaction' as const,
          preview: event.preview,
        }),
      });
    case 'context_result':
      return Object.freeze({
        ...state,
        projection: state.projection === undefined || event.result.kind !== 'installed'
          ? state.projection
          : snapshotPresentation({
            ...state.projection,
            checkpoint: event.result.coveredThroughTurn === undefined ||
                event.result.retainedFromTurn === undefined
              ? state.projection.checkpoint
              : {
                coveredThroughTurn: event.result.coveredThroughTurn,
                retainedFromTurn: event.result.retainedFromTurn,
              },
          }),
        overlay: Object.freeze({ kind: 'none' }),
        status: event.result.reason ?? event.result.kind,
      });
    case 'warning':
      return appendEntry(
        Object.freeze({
          ...state,
          lifecycle: event.code === 'fatal' ? 'fatal' : 'recoverable_error',
        }),
        {
          id: `warning:${event.generation}`,
          kind: event.code === 'fatal' ? 'fatal' : 'warning',
          label: `${event.code}>`,
          text: event.text,
          revision: 0,
          live: false,
        },
      );
  }
};

export const createUiState = (
  editor: EditorSnapshot = Object.freeze({
    text: '',
    cursorScalar: 0,
    byteLength: 0,
  }),
  projection?: PresentationProjection,
): UiState =>
  Object.freeze({
    projection: projection === undefined ? undefined : snapshotPresentation(projection),
    lifecycle: projection?.lifecycle ?? 'starting',
    log: Object.freeze({ entries: Object.freeze([]), omittedCount: 0 }),
    historyWindow: Object.freeze({ start: 0, end: 0 }),
    activeToolIds: Object.freeze([]),
    turnAttemptOrdinal: 0,
    editor: Object.freeze({ ...editor }),
    scroll: Object.freeze({ kind: 'followLatest' }),
    newBelowCount: 0,
    overlay: Object.freeze({ kind: 'none' }),
    status: projection?.lifecycle === 'idle' ? 'ready' : 'starting',
    slashCommandCandidates: Object.freeze([]),
    terminalSize: Object.freeze({ columns: 80, rows: 24 }),
    generation: projection?.generation ?? 0,
  });

export const reduceUiEvent = (
  state: UiState,
  event: PresentationEvent,
): UiState => {
  const next = eventLog(state, snapshot(event));
  if (
    next.scroll.kind !== 'followLatest' &&
    next.log.entries !== state.log.entries
  ) {
    return Object.freeze({
      ...next,
      newBelowCount: Math.min(UI_MAX_NEW_BELOW, state.newBelowCount + 1),
    });
  }
  return next;
};

export const reduceUiAction = (state: UiState, action: UiAction): UiState => {
  switch (action.kind) {
    case 'editor':
      return Object.freeze({
        ...state,
        editor: Object.freeze({ ...action.snapshot }),
      });
    case 'clear_live':
      return removeLiveEntries(state);
    case 'pending':
      return Object.freeze({
        ...state,
        pending: action.snapshot === undefined ? undefined : Object.freeze({
          ...action.snapshot,
          lanes: Object.freeze([...action.snapshot.lanes]),
        }),
      });
    case 'assistant_final': {
      const id = turnEntryId(state, action.turn, 'assistant');
      const existing = state.log.entries.some((entry) => entry.id === id);
      const next = existing
        ? replaceEntry(state, id, action.text, false, 'assistant>')
        : appendEntry(state, {
          id,
          kind: 'assistant',
          label: 'assistant>',
          text: action.text,
          revision: 0,
          live: false,
          turn: action.turn,
        });
      return Object.freeze({ ...next, activeAssistantId: undefined });
    }
    case 'resize':
      return Object.freeze({
        ...state,
        terminalSize: Object.freeze({
          columns: clamp(action.columns, 1, 512),
          rows: clamp(action.rows, 1, 200),
        }),
      });
    case 'status':
      return Object.freeze({ ...state, status: safeText(action.text) });
    case 'busy_elapsed':
      return Object.freeze({
        ...state,
        busyElapsedSeconds: action.seconds === undefined
          ? undefined
          : clamp(action.seconds, 0, Number.MAX_SAFE_INTEGER),
      });
    case 'busy_spinner':
      return Object.freeze({
        ...state,
        busySpinnerFrame: action.frame === undefined
          ? undefined
          : clamp(action.frame, 0, Number.MAX_SAFE_INTEGER),
      });
    case 'slash_command_candidates':
      return Object.freeze({
        ...state,
        slashCommandCandidates: Object.freeze(
          action.candidates.map((candidate) => safeText(candidate)),
        ),
      });
    case 'startup':
      return Object.freeze({
        ...state,
        startup: Object.freeze({
          state: snapshot(action.state),
          position: snapshot(action.position),
        }),
      });
    case 'session_title':
      return state.startup === undefined ? state : Object.freeze({
        ...state,
        startup: Object.freeze({
          ...state.startup,
          position: Object.freeze({
            ...state.startup.position,
            title: safeText(action.title),
          }),
        }),
      });
    case 'scroll':
      return Object.freeze({
        ...state,
        scroll: Object.freeze(action.mode),
        newBelowCount: action.mode.kind === 'followLatest' ? 0 : state.newBelowCount,
      });
    case 'latest':
      return Object.freeze({
        ...state,
        scroll: Object.freeze({ kind: 'followLatest' }),
        historyWindow: state.historyWindow === undefined
          ? undefined
          : historyWindowEndingAt(state.log.entries, state.log.entries.length),
        newBelowCount: 0,
      });
    case 'overlay':
      return Object.freeze({
        ...state,
        overlay: snapshot(action.overlay),
      });
  }
};

const clamp = (value: number, min: number, max: number): number =>
  Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : min;

export const setUiProjection = (
  state: UiState,
  projection: PresentationProjection,
): UiState =>
  Object.freeze({
    ...state,
    projection: snapshotPresentation(projection),
    lifecycle: projection.lifecycle,
    generation: projection.generation,
  });
