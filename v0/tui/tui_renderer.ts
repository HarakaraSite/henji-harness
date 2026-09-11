import {
  type PresentationContextPreview,
  PresentationDeliveryError,
  type PresentationDiagnosticDurability,
  type PresentationDiagnosticPersistenceError,
  type PresentationEvent,
  type PresentationFailureDiagnostic,
  type PresentationHistoryMatch,
  type PresentationHistoryPage,
  type PresentationMessage,
  type PresentationNavigationListing,
  type PresentationOutcome,
  type PresentationPosition,
  type PresentationProjection,
  type PresentationStartupState,
} from '../presentation/contract.ts';
import {
  BLINK_SGR,
  BLUE_SGR,
  DEFAULT_CURSOR_STYLE,
  ERASE_LINE,
  GREEN_SGR,
  MAGENTA_SGR,
  RESET_SCROLL_REGION,
  RESET_SGR,
  REVERSE_SGR,
  SHOW_CURSOR,
  staticBytes,
  type TerminalPort,
  type TerminalRendererGate,
  YELLOW_SGR,
} from './terminal.ts';
import type { EditorSnapshot } from './input.ts';
import type { PendingMetadataSnapshot } from './pending_input.ts';
import {
  createUiState,
  reduceUiAction,
  reduceUiEvent,
  setUiProjection,
  type UiState,
} from './state.ts';
import { type LayoutRow, layoutUi, MAX_FRAME_BYTES, type UiLayout } from './layout.ts';
import {
  type AssistantContentRenderer,
  plainTextAssistantRenderer,
} from './conversation_renderer.ts';
import { clippedWorkspace, orientationSession, startupHelpLines } from './startup_render.ts';
import { encoder, escapeTerminalText, truncateText } from './terminal_text.ts';

export interface TuiRendererOptions {
  /** Host-local assistant body renderer; the default preserves exact plain text. */
  readonly assistantRenderer?: AssistantContentRenderer;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (id: unknown) => void;
}

const renderLayoutRow = (row: LayoutRow): string => {
  if (
    row.blinkScalarStart !== undefined && row.blinkScalarLength !== undefined &&
    row.blinkScalarLength > 0
  ) {
    const points = [...row.text];
    const start = Math.max(0, Math.min(points.length, row.blinkScalarStart));
    const end = Math.max(start, Math.min(points.length, start + row.blinkScalarLength));
    return `${points.slice(0, start).join('')}${BLINK_SGR}${
      points.slice(start, end).join('')
    }${RESET_SGR}${points.slice(end).join('')}`;
  }
  if (
    row.highlightScalarStart !== undefined && row.highlightScalarLength !== undefined &&
    row.highlightScalarLength > 0
  ) {
    const points = [...row.text];
    const start = Math.max(0, Math.min(points.length, row.highlightScalarStart));
    const end = Math.max(start, Math.min(points.length, start + row.highlightScalarLength));
    const labelEnd = row.labelTone === undefined || row.labelScalarLength === undefined
      ? 0
      : Math.max(0, Math.min(start, row.labelScalarLength));
    const sgr = row.labelTone === 'user'
      ? BLUE_SGR
      : row.labelTone === 'assistant'
      ? YELLOW_SGR
      : row.labelTone === 'tool'
      ? GREEN_SGR
      : MAGENTA_SGR;
    const label = labelEnd === 0 ? '' : `${sgr}${points.slice(0, labelEnd).join('')}${RESET_SGR}`;
    return `${label}${points.slice(labelEnd, start).join('')}${REVERSE_SGR}${
      points.slice(start, end).join('')
    }${RESET_SGR}${points.slice(end).join('')}`;
  }
  if (
    row.labelTone === undefined || row.labelScalarLength === undefined ||
    row.labelScalarLength <= 0
  ) return row.text;
  const points = [...row.text];
  const label = points.slice(0, row.labelScalarLength).join('');
  const body = points.slice(row.labelScalarLength).join('');
  const sgr = row.labelTone === 'user'
    ? BLUE_SGR
    : row.labelTone === 'assistant'
    ? YELLOW_SGR
    : row.labelTone === 'tool'
    ? GREEN_SGR
    : MAGENTA_SGR;
  return `${sgr}${label}${RESET_SGR}${body}`;
};
/** Retained renderer for the production TUI and its injected test seams. */
export class TuiRenderer implements TerminalRendererGate {
  private readonly assistantRenderer: AssistantContentRenderer;
  private closing = false;
  private followUpPending = false;
  private lastSize = { columns: 80, rows: 24 };
  private currentPosition: PresentationPosition | undefined;
  private lastTurn = 0;
  private ui = createUiState();
  private startupState: PresentationStartupState | undefined;
  private readonly now: () => number;
  private readonly scheduleInterval: (callback: () => void, milliseconds: number) => unknown;
  private readonly cancelInterval: (id: unknown) => void;
  private busyStartedAt: number | undefined;
  private busyInterval: unknown;

  constructor(
    private readonly terminal: TerminalPort,
    options: TuiRendererOptions = {},
  ) {
    this.assistantRenderer = options.assistantRenderer ?? plainTextAssistantRenderer;
    this.now = options.now ?? Date.now;
    this.scheduleInterval = options.setInterval ??
      ((callback, milliseconds) => globalThis.setInterval(callback, milliseconds));
    this.cancelInterval = options.clearInterval ??
      ((id) => globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>));
  }

  get usesAlternateScreen(): boolean {
    return true;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  /** Defensive retained state snapshot for alternate hosts and deterministic UI tests. */
  stateSnapshot(): UiState {
    return this.ui;
  }

  /** Pure layout of the current retained screen; no terminal I/O is performed. */
  layoutSnapshot(
    columns = this.lastSize.columns,
    rows = this.lastSize.rows,
  ): UiLayout {
    return layoutUi(this.ui, columns, rows, this.assistantRenderer);
  }

  /** Bounded retained frame used by the production renderer and provider-free fixtures. */
  renderFrame(
    columns = this.lastSize.columns,
    rows = this.lastSize.rows,
  ): string {
    const layout = this.layoutSnapshot(columns, rows);
    const cursorRow = Math.max(1, Math.min(layout.rows, layout.cursor.row + 1));
    const cursorCell = Math.max(
      1,
      Math.min(layout.columns, layout.cursor.cell + 1),
    );
    const cursor = `\x1b[${cursorRow};${cursorCell}H`;
    const frameBudget = Math.max(
      0,
      MAX_FRAME_BYTES - encoder.encode(cursor).byteLength,
    );
    // Startup help is ordered as a safety guide: keep its first rows visible on a narrow screen,
    // while other overlays retain their newest-page/tail behavior.
    const overlayLog = this.ui.overlay.kind === 'startupHelp' ? layout.log : layout.overlay;
    const log = (overlayLog.length > 0 ? overlayLog : layout.log).map(renderLayoutRow);
    const inputPrompt = this.ui.historySearchQuery === undefined ? '> ' : '>/';
    const fixed = [
      ...layout.beforeInput.map((line) => line.text),
      ...layout.input.map((line) => `${inputPrompt}${line.text}`),
      ...layout.afterInput.map((line) => line.text),
      ...layout.footer.map(renderLayoutRow),
    ];
    const fixedFrame = fixed.join('\n');
    if (encoder.encode(fixedFrame).byteLength > frameBudget) {
      return `${truncateText(fixedFrame, frameBudget).text}${cursor}`;
    }
    const retainedLog: string[] = [];
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const candidate = [log[index], ...retainedLog, ...fixed].join('\n');
      if (encoder.encode(candidate).byteLength > frameBudget) break;
      retainedLog.unshift(log[index]);
    }
    return `${[...retainedLog, ...fixed].join('\n')}${cursor}`;
  }

  setProjection(projection: PresentationProjection): void {
    this.ui = setUiProjection(this.ui, projection);
  }

  /** Install the already-projected startup facts used by the local F1 help overlay. */
  setStartupState(state: PresentationStartupState): void {
    this.startupState = Object.freeze({
      ...state,
      model: Object.freeze({ ...state.model }),
      sessionMode: Object.freeze({ ...state.sessionMode }),
      instructions: Object.freeze({ ...state.instructions }),
      skills: Object.freeze({
        ...state.skills,
        names: Object.freeze([...state.skills.names]),
      }),
      trust: Object.freeze({
        ...state.trust,
        osUserTools: Object.freeze([...state.trust.osUserTools]),
      }),
    });
  }

  close(): void {
    this.stopBusyElapsed();
    this.closing = true;
    this.followUpPending = false;
  }

  private startBusyElapsed(): void {
    this.stopBusyElapsed();
    this.busyStartedAt = this.now();
    this.ui = reduceUiAction(this.ui, { kind: 'busy_elapsed', seconds: 0 });
    this.busyInterval = this.scheduleInterval(() => {
      if (this.closing || this.busyStartedAt === undefined) return;
      const seconds = Math.max(0, Math.floor((this.now() - this.busyStartedAt) / 1000));
      if (seconds === this.ui.busyElapsedSeconds) return;
      this.ui = reduceUiAction(this.ui, { kind: 'busy_elapsed', seconds });
      this.redraw();
    }, 1000);
  }

  private stopBusyElapsed(): void {
    if (this.busyInterval !== undefined) this.cancelInterval(this.busyInterval);
    this.busyInterval = undefined;
    this.busyStartedAt = undefined;
    if (this.ui.busyElapsedSeconds !== undefined) {
      this.ui = reduceUiAction(this.ui, { kind: 'busy_elapsed' });
    }
  }

  /** Clear all replaceable live activity without adding a completed scrollback record. */
  clearLiveActivity(): void {
    this.redraw();
  }

  /** Compact startup welcome kept outside ordinary scrollback and capped at two logical rows. */
  renderCompactStartup(
    state: PresentationStartupState,
    sessionId?: string,
  ): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.setStartupState(state);
    let columns = 80;
    try {
      const size = this.terminal.consoleSize();
      if (Number.isSafeInteger(size.columns) && size.columns > 0) {
        columns = size.columns;
      }
    } catch {
      // Use the documented fallback when terminal size is unavailable.
    }
    const identity = sessionId === undefined
      ? orientationSession(state)
      : `${orientationSession(state)} · ${sessionId.slice(0, 8)}`;
    const first = truncateText(
      `Henji Harness · ${escapeTerminalText(state.agentId)} · ${escapeTerminalText(identity)} · ${
        clippedWorkspace(state.workspace, Math.min(160, Math.max(8, columns)))
      }`,
      512,
    ).text;
    const second = 'trusted-local · credential presence shown; value checked only when sending';
    this.ui = reduceUiAction(this.ui, {
      kind: 'startup',
      lines: [first, second],
    });
    this.redraw();
  }

  /** Full startup help is an overlay, never ordinary conversation scrollback. */
  renderStartupHelp(state = this.startupState): void {
    if (state === undefined) return;
    if (this.closing) throw new PresentationDeliveryError();
    this.setStartupState(state);
    try {
      const size = this.terminal.consoleSize();
      if (
        Number.isSafeInteger(size.columns) && size.columns > 0 &&
        Number.isSafeInteger(size.rows) && size.rows > 0
      ) {
        this.lastSize = { columns: size.columns, rows: size.rows };
        this.ui = reduceUiAction(this.ui, {
          kind: 'resize',
          columns: size.columns,
          rows: size.rows,
        });
      }
    } catch {
      // Keep the last known size when the terminal cannot report dimensions.
    }
    const committedTurn = this.currentPosition?.committedTurn ?? this.lastTurn;
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: {
        kind: 'startupHelp',
        lines: startupHelpLines(
          state,
          this.lastSize.columns,
          committedTurn,
          this.lastSize.rows,
        ),
      },
    });
    this.redraw();
  }

  clearLiveLine(): void {
    this.terminal.write(staticBytes(`\r${ERASE_LINE}`));
  }

  /** Event sink entry point. It is intentionally synchronous. */
  eventSink = (event: PresentationEvent): void => {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiEvent(this.ui, event);
    if (
      event.kind === 'user_message' || event.kind === 'turn_start' ||
      event.kind === 'turn_end'
    ) {
      this.lastTurn = Math.max(this.lastTurn, event.turn);
    }
    switch (event.kind) {
      case 'turn_start':
        this.startBusyElapsed();
        this.setStatus('busy');
        return;
      case 'user_message':
        this.redraw();
        return;
      case 'assistant_message':
        this.redraw();
        return;
      case 'assistant_progress':
        this.redraw();
        return;
      case 'tool_call':
        this.redraw();
        return;
      case 'tool_progress':
        this.redraw();
        return;
      case 'tool_result':
        this.redraw();
        return;
      case 'steering_message':
        this.setStatus('busy · steer applied');
        return;
      case 'turn_end':
        this.stopBusyElapsed();
        this.setStatus(
          event.committed && this.followUpPending
            ? 'busy · starting follow-up'
            : event.committed
            ? 'ready'
            : event.outcome,
        );
        return;
      case 'failure_diagnostic': {
        this.stopBusyElapsed();
        this.redraw();
        return;
      }
      case 'session_binding_replaced':
      case 'restored_log':
      case 'history_page':
      case 'context_preview':
      case 'context_result':
        this.redraw();
        return;
      case 'lifecycle':
        if (event.lifecycle !== 'busy') this.stopBusyElapsed();
        this.redraw();
        return;
      case 'warning':
        if (event.code === 'fatal') this.stopBusyElapsed();
        this.redraw();
        return;
      case 'notice':
        this.redraw();
        return;
    }
  };

  setEditor(text: string): void {
    this.ui = reduceUiAction(this.ui, {
      kind: 'editor',
      snapshot: Object.freeze({
        text,
        cursorScalar: [...text].length,
        byteLength: encoder.encode(text).byteLength,
      }),
    });
    this.redraw();
  }

  setEditorSnapshot(snapshot: EditorSnapshot): void {
    this.ui = reduceUiAction(this.ui, {
      kind: 'editor',
      snapshot: Object.freeze({ ...snapshot }),
    });
    this.redraw();
  }

  setPendingMetadata(metadata: PendingMetadataSnapshot | undefined): void {
    const snapshot = metadata === undefined ? undefined : Object.freeze({
      ...metadata,
      lanes: Object.freeze([...metadata.lanes]),
    });
    this.ui = reduceUiAction(this.ui, {
      kind: 'pending',
      snapshot,
    });
    this.redraw();
  }

  setStatus(status: string): void {
    this.ui = reduceUiAction(this.ui, { kind: 'status', text: status });
    this.redraw();
  }

  setHistorySearchQuery(text: string, noMatches = false): void {
    this.ui = reduceUiAction(this.ui, {
      kind: 'history_search_query',
      text,
      noMatches,
    });
    this.redraw();
  }

  clearHistorySearchQuery(): void {
    this.ui = reduceUiAction(this.ui, { kind: 'history_search_query' });
    this.redraw();
  }

  setSlashCommandCandidates(candidates: readonly string[]): void {
    this.ui = reduceUiAction(this.ui, {
      kind: 'slash_command_candidates',
      candidates,
    });
    this.redraw();
  }

  setCurrentPosition(position: PresentationPosition): void {
    this.currentPosition = Object.freeze({ ...position });
  }

  /** Notify the retained layout of a UI-local resize without crossing into the core. */
  resize(columns: number, rows: number): void {
    this.lastSize = {
      columns: Number.isSafeInteger(columns) && columns > 0 ? columns : this.lastSize.columns,
      rows: Number.isSafeInteger(rows) && rows > 0 ? rows : this.lastSize.rows,
    };
    this.ui = reduceUiAction(this.ui, { kind: 'resize', columns, rows });
    if (
      this.ui.overlay.kind === 'startupHelp' && this.startupState !== undefined
    ) {
      const committedTurn = this.currentPosition?.committedTurn ??
        this.lastTurn;
      this.ui = reduceUiAction(this.ui, {
        kind: 'overlay',
        overlay: {
          kind: 'startupHelp',
          lines: startupHelpLines(
            this.startupState,
            this.lastSize.columns,
            committedTurn,
            this.lastSize.rows,
          ),
        },
      });
    }
    this.redraw();
  }

  /** End a bounded modal projection and restore the main editor line. */
  clearModal(): void {
    if (this.closing) return;
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: { kind: 'none' },
    });
    this.redraw();
  }

  /** UI-local scroll action; source anchors remain entry identity plus scalar offset. */
  scrollPage(direction: 'up' | 'down'): void {
    const layout = this.layoutSnapshot();
    const rows = layout.allLog;
    if (rows.length === 0) return;
    const viewport = Math.max(1, layout.log.length);
    let currentStart = layout.logStart;
    if (this.ui.scroll.kind === 'anchored') {
      const anchor = this.ui.scroll.entryId;
      const offset = this.ui.scroll.sourceScalarOffset;
      const anchored = rows.findIndex((row) =>
        row.entryId === anchor && (row.sourceScalarOffset ?? 0) >= offset
      );
      if (anchored >= 0) currentStart = anchored;
    }
    const maxStart = Math.max(0, rows.length - viewport);
    if (maxStart === 0) {
      if (this.ui.scroll.kind === 'anchored') this.latest();
      return;
    }
    const nextStart = Math.max(
      0,
      Math.min(
        maxStart,
        currentStart + (direction === 'up' ? -viewport : viewport),
      ),
    );
    if (direction === 'down' && nextStart === maxStart) {
      this.latest();
      return;
    }
    let target = rows[nextStart];
    if (target?.entryId === undefined) {
      const step = direction === 'up' ? -1 : 1;
      for (
        let index = nextStart;
        index >= 0 && index < rows.length;
        index += step
      ) {
        if (rows[index].entryId !== undefined) {
          target = rows[index];
          break;
        }
      }
    }
    if (target?.entryId === undefined) {
      // Startup and omitted rows do not have conversation identity. At the oldest boundary,
      // choose the first reachable entry instead of falling back to the latest page.
      if (direction === 'up') {
        const firstConversation = rows.find((row) => row.entryId !== undefined);
        if (firstConversation !== undefined) target = firstConversation;
      }
    }
    if (target?.entryId === undefined) {
      this.latest();
      return;
    }
    this.ui = reduceUiAction(this.ui, {
      kind: 'scroll',
      mode: {
        kind: 'anchored',
        entryId: target.entryId,
        sourceScalarOffset: target.sourceScalarOffset ?? 0,
      },
    });
    this.redraw();
  }

  latest(redraw = true): void {
    this.ui = reduceUiAction(this.ui, { kind: 'latest' });
    if (redraw) this.redraw();
  }

  renderSessionPicker(
    listing: PresentationNavigationListing,
    selected = 0,
    page = 0,
    loading = false,
  ): void {
    if (this.closing) throw new PresentationDeliveryError();
    const pageSize = 8;
    const pageCount = Math.max(
      1,
      Math.ceil(listing.sessions.length / pageSize),
    );
    const boundedPage = Math.max(0, Math.min(pageCount - 1, page));
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: {
        kind: 'sessionPicker',
        listing,
        selected,
        page: boundedPage,
        loading,
      },
    });
    this.redraw();
  }

  renderChoicePicker(lines: readonly string[]): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: { kind: 'choicePicker', lines: Object.freeze([...lines]) },
    });
    this.redraw();
  }

  renderHistoryPage(
    page: PresentationHistoryPage,
    match?: PresentationHistoryMatch,
    placement: 'match' | 'start' | 'end' = 'match',
  ): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: {
        kind: 'history',
        page,
        ...(match === undefined ? {} : { match }),
        pageNumber: page.page,
        placement,
      },
    });
    this.redraw();
  }

  renderContextPanel(preview: PresentationContextPreview): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: { kind: 'compaction', preview },
    });
    this.redraw();
  }

  renderContextSummary(_summary: string, coveredThroughTurn: number): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiAction(this.ui, {
      kind: 'status',
      text: `context checkpoint · through turn ${coveredThroughTurn}`,
    });
    this.redraw();
  }

  /** Show only that one ordinary follow-up is pending; the text remains controller-local. */
  setFollowUpPending(pending: boolean): void {
    if (this.closing) return;
    this.followUpPending = pending;
    this.redraw();
  }

  /** Retain one validated diagnostic when a host outcome arrives without its event bridge. */
  renderFailureDiagnostic(
    diagnostic: PresentationFailureDiagnostic,
    durable: PresentationDiagnosticDurability = 'yes',
    persistenceError?: PresentationDiagnosticPersistenceError,
  ): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.eventSink({
      kind: 'failure_diagnostic',
      turn: diagnostic.turnNumber,
      diagnostic,
      durable,
      ...(persistenceError === undefined ? {} : { persistenceError }),
    });
  }

  renderAssistantFinal(text: string): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiAction(this.ui, {
      kind: 'assistant_final',
      turn: this.lastTurn,
      text,
    });
    this.redraw();
  }

  /** Render a bounded committed transcript before accepting new input. */
  renderRestored(messages: readonly PresentationMessage[], omitted = 0): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiEvent(this.ui, { kind: 'restored_log', messages, omitted });
    this.redraw();
  }

  redraw(): void {
    if (this.closing) return;
    try {
      const size = this.terminal.consoleSize();
      if (
        Number.isSafeInteger(size.columns) && size.columns > 0 &&
        Number.isSafeInteger(size.rows) && size.rows > 0
      ) this.lastSize = size;
    } catch {
      // Keep the last valid size, defaulting to 80x24.
    }
    const frame = this.renderFrame(this.lastSize.columns, this.lastSize.rows);
    this.write(staticBytes(`\x1b[2J\x1b[H${frame}`));
  }

  private write(bytes: Uint8Array): void {
    if (this.closing) throw new PresentationDeliveryError();
    try {
      this.terminal.write(bytes);
    } catch {
      throw new PresentationDeliveryError();
    }
  }
}

export const renderFailureStatus = (outcome: PresentationOutcome): string =>
  outcome.stopReason === 'max_steps' ? 'request limit reached' : 'agent failure';

// Keep these imports/exports visible to callers constructing host-owned cleanup assertions.
export { DEFAULT_CURSOR_STYLE, RESET_SCROLL_REGION, RESET_SGR, SHOW_CURSOR };
