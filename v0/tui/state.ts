import {
  type PresentationContextPreview,
  type PresentationEvent,
  type PresentationLifecycle,
  type PresentationNavigationListing,
  type PresentationPosition,
  type PresentationProjection,
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
import { truncateText } from './terminal_text.ts';
import type { KeyedConversationStore } from './keyed_conversation_store.ts';

const UI_MAX_ENTRY_BYTES = MAX_CONVERSATION_TEXT_BYTES;

type UiLogKind =
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
  /** A short prefix in system text; only this word and the label use failure color. */
  readonly failureWord?: string;
  /** UTF-8 size of the retained display text, computed when the entry is created. */
  readonly textByteLength?: number;
  readonly revision: number;
  readonly live: boolean;
  readonly turn?: number;
  readonly callId?: string;
  /** Semantic tool name retained only in Host-local display state for activity prefix styling. */
  readonly toolName?: string;
  readonly executionId?: string;
}

export type UiOverlay =
  | Readonly<{ readonly kind: 'none' }>
  | Readonly<
    { readonly kind: 'startupHelp'; readonly lines?: readonly string[] }
  >
  | Readonly<
    {
      readonly kind: 'readOnlyHelp';
      readonly lines: readonly string[];
      readonly offset?: number;
    }
  >
  | Readonly<{
    readonly kind: 'slashPicker';
    readonly candidates: readonly import('./slash_command.ts').SlashCommandDefinition[];
    readonly selected: number;
  }>
  | Readonly<{
    readonly kind: 'sessionPicker';
    readonly listing?: PresentationNavigationListing;
    readonly selected: number;
    readonly page: number;
    readonly loading?: boolean;
    readonly actionMode?: 'resume' | 'view';
  }>
  | Readonly<{
    readonly kind: 'sessionDeleteConfirm';
    readonly picker: Extract<UiOverlay, { kind: 'sessionPicker' }>;
    readonly deleting: boolean;
    readonly message?: string;
  }>
  | Readonly<{
    readonly kind: 'choicePicker';
    readonly lines: readonly string[];
    readonly controls?: readonly string[];
  }>
  | Readonly<
    {
      readonly kind: 'compaction';
      readonly preview?: PresentationContextPreview;
    }
  >;

/** Display facts supplied by the remote controller, independent of conversation notices. */
export interface UiFooter {
  readonly activity: 'ready' | 'working' | 'cancelling' | 'READ-ONLY' | 'DISCONNECTED';
  readonly controls: readonly string[];
  readonly hint?: string;
}

export interface UiState {
  readonly footer?: UiFooter;
  readonly projection?: PresentationProjection;
  readonly lifecycle: PresentationLifecycle;
  readonly position?: PresentationPosition;
  /** Structured startup facts live in the log band but never become conversation entries. */
  readonly startup?: Readonly<{
    readonly state: PresentationStartupState;
    readonly position: PresentationPosition;
  }>;
  readonly log: Readonly<
    { readonly entries: readonly UiLogEntry[]; readonly omittedCount: number }
  >;
  /** Schema-2 remote conversation rows are held by identity and ordered only structurally. */
  readonly keyedConversation?: KeyedConversationStore;
  readonly activeAssistantId?: string;
  readonly activeToolIds: readonly string[];
  readonly turnAttemptOrdinal: number;
  readonly editor: EditorSnapshot;
  readonly pending?: PendingMetadataSnapshot;
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

type UiAction =
  | Readonly<{ readonly kind: 'editor'; readonly snapshot: EditorSnapshot }>
  | Readonly<{ readonly kind: 'clear_live' }>
  | Readonly<{
    readonly kind: 'keyed_conversation';
    readonly store: KeyedConversationStore;
  }>
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
  | Readonly<{ readonly kind: 'footer'; readonly footer: UiFooter }>
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
  | Readonly<
    { readonly kind: 'position'; readonly position: PresentationPosition }
  >
  | Readonly<{ readonly kind: 'session_title'; readonly title: string }>
  | Readonly<{ readonly kind: 'overlay'; readonly overlay: UiOverlay }>;

const encoder = new TextEncoder();
const snapshot = <T>(value: T): T => snapshotPresentation(value);

const safeText = (text: string): string => {
  return safeTextToBytes(text, UI_MAX_ENTRY_BYTES).text;
};

const safeTextToBytes = (
  text: string,
  limit: number,
): Readonly<{ text: string; byteLength: number }> => {
  const maxBytes = Math.max(0, limit);
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) {
    return Object.freeze({ text, byteLength: encoded.byteLength });
  }
  const truncated = truncateText(text, maxBytes).text;
  return Object.freeze({
    text: truncated,
    byteLength: encoder.encode(truncated).byteLength,
  });
};

/** Stable, short failure reasons; diagnostic identifiers and provider details stay out of the UI. */
export const presentationFailureReason = (
  diagnostic: Readonly<{ code: string; stage?: string }>,
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
    default:
      return 'operation failed';
  }
};

const freezeEntry = (entry: UiLogEntry, previous?: UiLogEntry): UiLogEntry => {
  const safe = previous?.text === entry.text && previous.textByteLength !== undefined
    ? { text: entry.text, byteLength: previous.textByteLength }
    : safeTextToBytes(entry.text, UI_MAX_ENTRY_BYTES);
  return Object.freeze({
    ...entry,
    text: safe.text,
    textByteLength: safe.byteLength,
  });
};

/** Normalize and retain the UTF-8 size for a newly projected conversation entry. */
export const freezeUiLogEntry = freezeEntry;

export const uiConversationCount = (state: UiState): number =>
  state.keyedConversation?.size ?? state.log.entries.length;

export const uiConversationEntryAt = (state: UiState, index: number): UiLogEntry | undefined =>
  state.keyedConversation?.entryAt(index) ?? state.log.entries[index];

export const uiConversationIndexOf = (state: UiState, id: string): number =>
  state.keyedConversation?.indexOf(id) ?? state.log.entries.findIndex((entry) => entry.id === id);

export const uiConversationWindow = (
  state: UiState,
  start: number,
  end: number,
): readonly UiLogEntry[] =>
  state.keyedConversation?.window(start, end) ??
    state.log.entries.slice(start, end);

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
    log: Object.freeze({
      entries: Object.freeze(entries),
      omittedCount: state.log.omittedCount,
    }),
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
  }, prior);
  if (relocateToEnd && index < entries.length - 1) {
    entries.splice(index, 1);
    entries.push(replacement);
  } else {
    entries[index] = replacement;
  }
  return Object.freeze({
    ...state,
    log: Object.freeze({
      entries: Object.freeze(entries),
      omittedCount: state.log.omittedCount,
    }),
  });
};

/**
 * Assistant entry ids are unique per assistant message: the first free base id, then `assistant:<n>`.
 * A settled entry is never reused, so every settled assistant text stays in the log.
 */
const assistantEntryId = (state: UiState, turn: number): string => {
  const candidate = (suffix: string): string => turnEntryId(state, turn, suffix);
  if (!state.log.entries.some((entry) => entry.id === candidate('assistant'))) {
    return candidate('assistant');
  }
  for (let ordinal = 1;; ordinal += 1) {
    const id = candidate(`assistant:${ordinal}`);
    if (!state.log.entries.some((entry) => entry.id === id)) return id;
  }
};

/**
 * Settle one assistant text: reuse the live streamed entry of the same turn (so progress fragments
 * never accumulate as entries), otherwise append a fresh entry. The settled entry goes to the log
 * tail so the final answer always follows every tool entry of the turn.
 */
const settleAssistantEntry = (
  state: UiState,
  turn: number,
  label: string,
  text: string,
): UiState => {
  const activeId = state.activeAssistantId;
  const activeIndex = activeId === undefined
    ? -1
    : state.log.entries.findIndex((entry) =>
      entry.id === activeId && entry.live && entry.turn === turn
    );
  if (activeId !== undefined && activeIndex >= 0) {
    return replaceEntry(state, activeId, text, false, label, true);
  }
  return appendEntry(state, {
    id: assistantEntryId(state, turn),
    kind: 'assistant',
    label,
    text,
    revision: 0,
    live: false,
    turn,
  });
};

const removeLiveEntries = (
  state: UiState,
  keep: (entry: UiLogEntry) => boolean = () => false,
): UiState => {
  const entries = state.log.entries.filter((entry) => !entry.live || keep(entry));
  if (entries.length === state.log.entries.length) return state;
  return Object.freeze({
    ...state,
    log: Object.freeze({ ...state.log, entries: Object.freeze(entries) }),
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
      const next = settleAssistantEntry(
        state,
        event.turn,
        Array.isArray(event.message.content) ? 'assistant note>' : 'assistant>',
        assistantText,
      );
      return Object.freeze({ ...next, activeAssistantId: undefined });
    }
    case 'assistant_progress': {
      const activeId = state.activeAssistantId;
      const activeIndex = activeId === undefined
        ? -1
        : state.log.entries.findIndex((entry) =>
          entry.id === activeId && entry.live && entry.turn === event.turn
        );
      if (activeId !== undefined && activeIndex >= 0) {
        const relocateProgressAfterTools = state.activeToolIds.length === 0 &&
          state.log.entries.slice(activeIndex + 1).some((entry) =>
            entry.turn === event.turn && entry.kind === 'tool'
          );
        const next = replaceEntry(
          state,
          activeId,
          event.text,
          true,
          undefined,
          relocateProgressAfterTools,
        );
        return Object.freeze({ ...next, activeAssistantId: activeId });
      }
      const id = assistantEntryId(state, event.turn);
      const next = appendEntry(state, {
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
      // Live thinking snapshots of one model step update the same entry in place; only the first
      // snapshot appends it before the active assistant body.
      if (state.log.entries.some((entry) => entry.id === id)) {
        return Object.freeze({
          ...replaceEntry(state, id, event.text, false, label),
        });
      }
      const activeAssistantIndex = state.log.entries.findIndex((entry) =>
        entry.id === state.activeAssistantId && entry.turn === event.turn &&
        entry.live
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
      const preview = toolActivityPreview(
        event.call.name,
        event.call.arguments,
      );
      const next = state.log.entries.some((entry) => entry.id === id) ? state : appendEntry(state, {
        id,
        kind: 'tool',
        label: 'tool>',
        text: pendingToolActivityText(event.call.name, preview),
        revision: 0,
        live: true,
        turn: event.turn,
        callId: event.call.callId,
        toolName: event.call.name,
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
          toolName: event.name,
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
          text: settledToolActivityText(
            event.result.name,
            event.result.outcome,
            preview,
          ),
          revision: 0,
          live: false,
          turn: event.turn,
          callId: event.result.callId,
          toolName: event.result.name,
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
        settledToolActivityText(
          event.result.name,
          event.result.outcome,
          preview,
        ),
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
          ? {
            committedTurn: Math.max(
              withoutLive.projection.committedTurn,
              event.turn,
            ),
          }
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
                  }, entry)
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
    case 'session_binding_replaced':
      return Object.freeze({
        ...state,
        position: snapshot(event.position),
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
    activeToolIds: Object.freeze([]),
    turnAttemptOrdinal: 0,
    editor: Object.freeze({ ...editor }),
    overlay: Object.freeze({ kind: 'none' }),
    status: projection?.lifecycle === 'idle' ? 'ready' : 'starting',
    slashCommandCandidates: Object.freeze([]),
    terminalSize: Object.freeze({ columns: 80, rows: 24 }),
    generation: projection?.generation ?? 0,
  });

export const reduceUiEvent = (
  state: UiState,
  event: PresentationEvent,
): UiState => eventLog(state, snapshot(event));

const applyKeyedConversation = (
  state: UiState,
  action: Extract<UiAction, { readonly kind: 'keyed_conversation' }>,
): UiState => {
  const store = action.store;
  return Object.freeze({
    ...state,
    log: Object.freeze({ entries: Object.freeze([]), omittedCount: store.omitted }),
    keyedConversation: store,
  });
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
    case 'keyed_conversation':
      return applyKeyedConversation(state, action);
    case 'pending':
      return Object.freeze({
        ...state,
        pending: action.snapshot === undefined ? undefined : Object.freeze({
          ...action.snapshot,
          lanes: Object.freeze([...action.snapshot.lanes]),
        }),
      });
    case 'assistant_final': {
      const next = settleAssistantEntry(
        state,
        action.turn,
        'assistant>',
        action.text,
      );
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
    case 'footer':
      return Object.freeze({ ...state, footer: snapshot(action.footer) });
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
        position: snapshot(action.position),
        startup: Object.freeze({
          state: snapshot(action.state),
          position: snapshot(action.position),
        }),
      });
    case 'position':
      return Object.freeze({ ...state, position: snapshot(action.position) });
    case 'session_title':
      return Object.freeze({
        ...state,
        position: state.position === undefined ? undefined : Object.freeze({
          ...state.position,
          title: safeText(action.title),
        }),
        startup: state.startup === undefined ? undefined : Object.freeze({
          ...state.startup,
          position: Object.freeze({
            ...state.startup.position,
            title: safeText(action.title),
          }),
        }),
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
