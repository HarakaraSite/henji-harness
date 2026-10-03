import {
  type PresentationContextPreview,
  PresentationDeliveryError,
  type PresentationDiagnosticDurability,
  type PresentationDiagnosticPersistenceError,
  type PresentationEvent,
  type PresentationFailureDiagnostic,
  type PresentationNavigationListing,
  type PresentationOutcome,
  type PresentationPosition,
  type PresentationProjection,
  type PresentationStartupState,
} from '../presentation/contract.ts';
import {
  BLINK_SGR,
  BLUE_SGR,
  BOLD_SGR,
  CYAN_SGR,
  DEFAULT_CURSOR_STYLE,
  DIM_SGR,
  ERASE_LINE,
  GREEN_SGR,
  MAGENTA_SGR,
  RED_SGR,
  RESET_SCROLL_REGION,
  RESET_SGR,
  type ScreenFrame,
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
  pageHistoryWindow,
  reduceUiAction,
  reduceUiEvent,
  setUiProjection,
  uiConversationCount,
  type UiFooter,
  type UiState,
} from './state.ts';
import {
  BUSY_SPINNER_FRAMES,
  type FooterTone,
  type LayoutRow,
  layoutUi,
  MAX_FRAME_BYTES,
  type UiLayout,
} from './layout.ts';
import {
  type AssistantContentRenderer,
  type AssistantSpanTone,
  type ConversationLabelTone,
} from './conversation_renderer.ts';
import { markdownAssistantRenderer } from './assistant_layout.ts';
import { EntryLayoutCache } from './entry_layout_cache.ts';
import { startupHelpLines } from './startup_render.ts';
import { encoder, segmentTerminalText } from './terminal_text.ts';

export interface TuiRendererOptions {
  /** Host-local assistant body renderer; the default lays out markdown readability spans. */
  readonly assistantRenderer?: AssistantContentRenderer;
  readonly now?: () => number;
  readonly setInterval?: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  readonly clearInterval?: (id: unknown) => void;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout?: (id: unknown) => void;
}

const LABEL_SGR: Record<ConversationLabelTone, string> = {
  user: BLUE_SGR,
  assistant: YELLOW_SGR,
  tool: CYAN_SGR,
  system: MAGENTA_SGR,
  failure: RED_SGR,
};

const SPAN_SGR: Record<AssistantSpanTone, string> = {
  heading: GREEN_SGR,
  list: CYAN_SGR,
  table: DIM_SGR,
  quote: MAGENTA_SGR,
  bold: BOLD_SGR,
  emphasis: CYAN_SGR,
};

const FOOTER_SGR: Record<FooterTone, string> = {
  dim: DIM_SGR,
  bold: BOLD_SGR,
  ready: CYAN_SGR,
  working: YELLOW_SGR,
};

const renderLayoutRow = (row: LayoutRow): string => {
  // A whole-row tone covers label, reason and guidance in one color; such rows carry no spans.
  if (row.rowTone !== undefined && row.text.length > 0) {
    return `${LABEL_SGR[row.rowTone]}${row.text}${RESET_SGR}`;
  }
  const ranges: { start: number; length: number; sgr: string }[] = [];
  if (
    row.labelTone !== undefined && row.labelScalarLength !== undefined &&
    row.labelScalarLength > 0
  ) {
    ranges.push({
      start: 0,
      length: row.labelScalarLength,
      sgr: LABEL_SGR[row.labelTone],
    });
  }
  for (const span of row.spans ?? []) {
    ranges.push({
      start: span.start,
      length: span.length,
      sgr: SPAN_SGR[span.tone],
    });
  }
  for (const span of row.footerSpans ?? []) {
    ranges.push({ start: span.start, length: span.length, sgr: FOOTER_SGR[span.tone] });
  }
  if (
    row.blinkScalarStart !== undefined && row.blinkScalarLength !== undefined &&
    row.blinkScalarLength > 0
  ) {
    ranges.push({
      start: row.blinkScalarStart,
      length: row.blinkScalarLength,
      sgr: BLINK_SGR,
    });
  }
  if (ranges.length === 0) return row.text;
  const points = [...row.text];
  ranges.sort((left, right) => left.start - right.start || left.length - right.length);
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(
      cursor,
      Math.max(0, Math.min(points.length, range.start)),
    );
    const end = Math.max(
      start,
      Math.min(points.length, range.start + range.length),
    );
    if (end <= start) continue;
    output += points.slice(cursor, start).join('');
    output += `${range.sgr}${points.slice(start, end).join('')}${RESET_SGR}`;
    cursor = end;
  }
  output += points.slice(cursor).join('');
  return output;
};
/** Bound a styled row without splitting SGR tokens or a grapheme cluster. */
const boundedStyledRow = (text: string, maxBytes: number): string => {
  let output = '';
  let used = 0;
  let styled = false;
  // Terminal styling tokens must remain intact when applying the existing frame byte budget.
  // deno-lint-ignore no-control-regex
  for (const token of text.match(/\x1b\[[0-9;]*m|[^\x1b]+/g) ?? []) {
    const pieces = token.startsWith('\x1b')
      ? [token]
      : segmentTerminalText(token).map((s) => s.text);
    for (const piece of pieces) {
      const size = encoder.encode(piece).byteLength;
      const reserve = styled || piece.startsWith('\x1b') ? encoder.encode(RESET_SGR).byteLength : 0;
      if (used + size + reserve > maxBytes) {
        return styled ? `${output}${RESET_SGR}` : output;
      }
      output += piece;
      used += size;
      if (piece.startsWith('\x1b')) styled = piece !== RESET_SGR;
    }
  }
  return styled ? `${output}${RESET_SGR}` : output;
};

/** Retained renderer for the production TUI and its injected test seams. */
export class TuiRenderer implements TerminalRendererGate {
  private readonly assistantRenderer: AssistantContentRenderer;
  private closing = false;
  private lastSize = { columns: 80, rows: 24 };
  private currentPosition: PresentationPosition | undefined;
  private lastTurn = 0;
  private ui = createUiState();
  private startupState: PresentationStartupState | undefined;
  private readonly now: () => number;
  private readonly scheduleInterval: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  private readonly cancelInterval: (id: unknown) => void;
  private busyStartedAt: number | undefined;
  private busySpinnerFrame = 0;
  private busyInterval: unknown;
  private readonly scheduleTimeout: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  private readonly cancelTimeout: (id: unknown) => void;
  private renderTimer: unknown;
  private lastRenderStarted: number | undefined;
  private displayScope = 'local';
  private geometryGeneration = 0;
  private displayedLayout: UiLayout | undefined;
  private navigationGeneration = 0;
  private displayedNavigationGeneration = 0;
  private readonly entryLayoutCache = new EntryLayoutCache();
  private readonly renderFailureHandlers = new Set<() => void>();

  constructor(
    private readonly terminal: TerminalPort,
    options: TuiRendererOptions = {},
  ) {
    this.assistantRenderer = options.assistantRenderer ??
      markdownAssistantRenderer;
    this.now = options.now ?? Date.now;
    this.scheduleInterval = options.setInterval ??
      ((callback, milliseconds) => globalThis.setInterval(callback, milliseconds));
    this.cancelInterval = options.clearInterval ??
      ((id) =>
        globalThis.clearInterval(
          id as ReturnType<typeof globalThis.setInterval>,
        ));
    this.scheduleTimeout = options.setTimeout ??
      ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
    this.cancelTimeout = options.clearTimeout ??
      ((id) =>
        globalThis.clearTimeout(
          id as ReturnType<typeof globalThis.setTimeout>,
        ));
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
    return layoutUi(
      this.ui,
      columns,
      rows,
      this.assistantRenderer,
      this.entryLayoutCache,
    );
  }

  /** Pure serialized frame retained for callers inspecting readable rows and cursor. */
  renderFrame(
    columns = this.lastSize.columns,
    rows = this.lastSize.rows,
  ): string {
    const frame = this.renderScreenFrame(columns, rows);
    return `${frame.rows.join('\n')}\x1b[${frame.cursor.row + 1};${frame.cursor.cell + 1}H`;
  }

  renderScreenFrame(
    columns = this.lastSize.columns,
    rows = this.lastSize.rows,
  ): ScreenFrame {
    const layout = this.layoutSnapshot(columns, rows);
    return this.frameFromLayout(layout);
  }

  private frameFromLayout(layout: UiLayout): ScreenFrame {
    const rendered = [
      ...layout.log.map(renderLayoutRow),
      ...layout.beforeInput.map((line) => line.text),
      ...layout.input.map((line) => `> ${line.text}`),
      ...layout.afterInput.map((line) => line.text),
      ...layout.footer.map(renderLayoutRow),
    ];
    // Reserve positioning/sync controls. Keep row coordinates fixed when omitting content.
    let available = Math.max(0, MAX_FRAME_BYTES - rendered.length * 32 - 128);
    for (let index = rendered.length - 1; index >= 0; index -= 1) {
      const line = rendered[index];
      const size = encoder.encode(line).byteLength;
      if (size <= available) {
        available -= size;
        continue;
      }
      rendered[index] = boundedStyledRow(line, available);
      available -= encoder.encode(rendered[index]).byteLength;
    }
    return Object.freeze({
      rows: Object.freeze(rendered),
      cursor: Object.freeze({
        row: Math.max(0, Math.min(layout.rows - 1, layout.cursor.row)),
        cell: Math.max(0, Math.min(layout.columns - 1, layout.cursor.cell)),
      }),
      size: Object.freeze({ columns: layout.columns, rows: layout.rows }),
      scope: this.displayScope,
      geometryGeneration: this.geometryGeneration,
    });
  }

  setProjection(
    projection: PresentationProjection,
    busyStartedAt?: number,
  ): void {
    this.ui = setUiProjection(this.ui, projection);
    if (this.ui.footer !== undefined) return;
    if (
      projection.lifecycle === 'busy' || projection.lifecycle === 'cancelling'
    ) {
      if (busyStartedAt !== undefined && this.busyStartedAt !== busyStartedAt) {
        this.startBusyElapsed(busyStartedAt);
      }
    } else this.stopBusyElapsed();
  }

  setRemoteFooter(footer: UiFooter, startedAt?: number): void {
    this.ui = reduceUiAction(this.ui, { kind: 'footer', footer });
    if (footer.activity === 'working' || footer.activity === 'cancelling') {
      if (this.busyInterval === undefined || this.busyStartedAt !== startedAt) {
        this.startBusyElapsed(startedAt, startedAt !== undefined);
      }
    } else this.stopBusyElapsed();
    this.redraw();
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
    if (this.renderTimer !== undefined) this.cancelTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.stopBusyElapsed();
    this.closing = true;
  }

  private startBusyElapsed(startedAt = this.now(), elapsed = true): void {
    this.stopBusyElapsed();
    this.busyStartedAt = elapsed ? startedAt : undefined;
    this.busySpinnerFrame = 0;
    this.ui = reduceUiAction(this.ui, {
      kind: 'busy_elapsed',
      seconds: elapsed ? Math.max(0, Math.floor((this.now() - startedAt) / 1000)) : undefined,
    });
    this.ui = reduceUiAction(this.ui, { kind: 'busy_spinner', frame: 0 });
    this.busyInterval = this.scheduleInterval(() => {
      if (this.closing) return;
      this.busySpinnerFrame = (this.busySpinnerFrame + 1) %
        BUSY_SPINNER_FRAMES.length;
      this.ui = reduceUiAction(this.ui, {
        kind: 'busy_spinner',
        frame: this.busySpinnerFrame,
      });
      const seconds = this.busyStartedAt === undefined ? undefined : Math.max(
        0,
        Math.floor((this.now() - this.busyStartedAt) / 1000),
      );
      if (seconds !== this.ui.busyElapsedSeconds) {
        this.ui = reduceUiAction(this.ui, { kind: 'busy_elapsed', seconds });
      }
      this.redraw();
    }, 120);
  }

  private stopBusyElapsed(): void {
    if (this.busyInterval !== undefined) this.cancelInterval(this.busyInterval);
    this.busyInterval = undefined;
    this.busyStartedAt = undefined;
    this.busySpinnerFrame = 0;
    if (this.ui.busyElapsedSeconds !== undefined) {
      this.ui = reduceUiAction(this.ui, { kind: 'busy_elapsed' });
    }
    if (this.ui.busySpinnerFrame !== undefined) {
      this.ui = reduceUiAction(this.ui, { kind: 'busy_spinner' });
    }
  }

  /** Clear all replaceable live activity without adding a completed scrollback record. */
  clearLiveActivity(): void {
    this.redraw();
  }

  /** Structured startup orientation kept outside ordinary conversation entries. */
  renderCompactStartup(
    state: PresentationStartupState,
    position: PresentationPosition,
  ): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.setStartupState(state);
    this.ui = reduceUiAction(this.ui, {
      kind: 'startup',
      state,
      position,
    });
    this.redraw();
  }

  setSessionTitle(title: string): void {
    this.ui = reduceUiAction(this.ui, { kind: 'session_title', title });
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

  /** Read-only remote help stays local to this terminal and omits unsupported task commands. */
  renderReadOnlyHelp(lines: readonly string[]): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: { kind: 'readOnlyHelp', lines: [...lines] },
    });
    this.redraw();
  }

  scrollHelp(direction: 'up' | 'down'): void {
    if (this.ui.overlay.kind !== 'readOnlyHelp') return;
    const layout = this.layoutSnapshot(
      this.lastSize.columns,
      this.lastSize.rows,
    );
    const page = Math.max(1, layout.log.length - 1);
    const offset = Math.max(
      0,
      Math.min(
        Math.max(0, layout.overlay.length - 1 - page),
        (this.ui.overlay.offset ?? 0) + (direction === 'up' ? -page : page),
      ),
    );
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: { ...this.ui.overlay, offset },
    });
    this.redraw();
  }

  renderSlashPicker(
    candidates: readonly import('./slash_command.ts').SlashCommandDefinition[],
    selected: number,
  ): void {
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: { kind: 'slashPicker', candidates: [...candidates], selected },
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
      case 'assistant_thinking':
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
          event.committed &&
            this.ui.pending?.lanes.some((lane) => lane.kind === 'follow_up' && lane.present)
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

  setSlashCommandCandidates(candidates: readonly string[]): void {
    this.ui = reduceUiAction(this.ui, {
      kind: 'slash_command_candidates',
      candidates,
    });
    this.redraw();
  }

  setCurrentPosition(position: PresentationPosition): void {
    this.currentPosition = Object.freeze({ ...position });
    this.ui = reduceUiAction(this.ui, { kind: 'position', position });
  }

  /** Notify the retained layout of a UI-local resize without crossing into the core. */
  resize(columns: number, rows: number): void {
    this.geometryGeneration += 1;
    const oldLayout = this.displayedLayout;
    const oldAnchor = this.ui.scroll.kind === 'anchored' && oldLayout !== undefined
      ? oldLayout.allLog[oldLayout.logStart]
      : undefined;
    this.lastSize = {
      columns: Number.isSafeInteger(columns) && columns > 0 ? columns : this.lastSize.columns,
      rows: Number.isSafeInteger(rows) && rows > 0 ? rows : this.lastSize.rows,
    };
    this.ui = reduceUiAction(this.ui, { kind: 'resize', columns, rows });
    if (
      oldAnchor?.entryId !== undefined && this.ui.scroll.kind === 'anchored'
    ) {
      this.ui = reduceUiAction(this.ui, {
        kind: 'scroll',
        mode: {
          kind: 'anchored',
          entryId: oldAnchor.entryId,
          sourceScalarOffset: oldAnchor.sourceScalarOffset ?? 0,
        },
      });
    }
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
    // Navigation starts at the content the user last saw, even when a projection is pending.
    const layout = this.navigationGeneration === this.displayedNavigationGeneration
      ? this.displayedLayout ?? this.layoutSnapshot()
      : this.layoutSnapshot();
    this.navigationGeneration += 1;
    const rows = layout.allLog;
    if (rows.length === 0) return;
    const viewport = Math.max(1, layout.log.length);
    let currentStart = layout.logStart;
    if (this.ui.scroll.kind === 'oldest') {
      currentStart = 0;
    } else if (this.ui.scroll.kind === 'anchored') {
      const anchor = this.ui.scroll.entryId;
      const offset = this.ui.scroll.sourceScalarOffset;
      const anchored = rows.findLastIndex((row) =>
        row.entryId === anchor && (row.sourceScalarOffset ?? 0) <= offset
      );
      if (anchored >= 0) currentStart = anchored;
    }
    const maxStart = Math.max(0, rows.length - viewport);
    const history = this.ui.historyWindow;
    if (
      direction === 'up' && (currentStart === 0 || maxStart === 0) &&
      history !== undefined && history.start > 0
    ) {
      this.ui = pageHistoryWindow(this.ui, 'up');
      const previousPage = this.layoutSnapshot();
      if (
        this.ui.historyWindow?.start === 0 &&
        previousPage.allLog.length <= viewport
      ) {
        this.ui = reduceUiAction(this.ui, {
          kind: 'scroll',
          mode: { kind: 'oldest' },
        });
      } else {
        const firstVisible = previousPage.log.find((row) => row.entryId !== undefined);
        if (firstVisible?.entryId !== undefined) {
          this.ui = reduceUiAction(this.ui, {
            kind: 'scroll',
            mode: {
              kind: 'anchored',
              entryId: firstVisible.entryId,
              sourceScalarOffset: firstVisible.sourceScalarOffset ?? 0,
            },
          });
        }
      }
      this.redraw();
      return;
    }
    if (
      direction === 'down' && currentStart >= maxStart &&
      history !== undefined &&
      history.end < uiConversationCount(this.ui)
    ) {
      this.ui = pageHistoryWindow(this.ui, 'down');
      this.redraw();
      return;
    }
    if (maxStart === 0) {
      if (
        direction === 'up' && history?.start === 0 &&
        history.end < uiConversationCount(this.ui) &&
        this.ui.scroll.kind !== 'oldest'
      ) {
        this.ui = reduceUiAction(this.ui, {
          kind: 'scroll',
          mode: { kind: 'oldest' },
        });
        this.redraw();
      } else if (
        direction === 'down' && this.ui.scroll.kind !== 'followLatest'
      ) {
        this.latest();
      }
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
      if (history === undefined || history.end >= uiConversationCount(this.ui)) {
        this.latest();
        return;
      }
    }
    if (direction === 'up' && nextStart === 0) {
      this.ui = reduceUiAction(this.ui, {
        kind: 'scroll',
        mode: { kind: 'oldest' },
      });
      this.redraw();
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
      if (direction === 'up') {
        this.ui = reduceUiAction(this.ui, {
          kind: 'scroll',
          mode: { kind: 'oldest' },
        });
        this.redraw();
        return;
      }
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
    actionMode: 'resume' | 'view' = 'resume',
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
        actionMode,
      },
    });
    this.redraw();
  }

  renderSessionDeleteConfirmation(
    picker: Extract<import('./state.ts').UiOverlay, { kind: 'sessionPicker' }>,
    deleting = false,
    message?: string,
  ): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: {
        kind: 'sessionDeleteConfirm',
        picker,
        deleting,
        ...(message === undefined ? {} : { message }),
      },
    });
    this.redraw();
  }

  renderChoicePicker(lines: readonly string[], controls?: readonly string[]): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.ui = reduceUiAction(this.ui, {
      kind: 'overlay',
      overlay: {
        kind: 'choicePicker',
        lines: Object.freeze([...lines]),
        ...(controls === undefined ? {} : { controls: Object.freeze([...controls]) }),
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

  /** Retain one validated diagnostic when a host outcome arrives without its event bridge. */
  renderFailureDiagnostic(
    diagnostic: PresentationFailureDiagnostic,
    durable: PresentationDiagnosticDurability = 'yes',
    persistenceError?: PresentationDiagnosticPersistenceError,
    executionId?: string,
  ): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.eventSink({
      kind: 'failure_diagnostic',
      turn: diagnostic.turnNumber,
      diagnostic,
      durable,
      ...(executionId === undefined ? {} : { executionId }),
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

  /** Apply projection work synchronously; only the terminal draw is coalesced. */
  updateConversation(update: () => void): void {
    if (this.closing) return;
    update();
    this.redraw();
  }

  setDisplayScope(scope: string): void {
    if (scope === this.displayScope) return;
    this.displayScope = scope;
    this.displayedLayout = undefined;
    this.entryLayoutCache.clear();
    this.clearModal();
    this.latest();
  }

  setKeyedConversationStore(
    store: import('./keyed_conversation_store.ts').KeyedConversationStore,
    resetScroll = false,
    structureChanged = false,
    previousIds?: readonly string[],
  ): void {
    if (this.closing) return;
    this.ui = reduceUiAction(this.ui, {
      kind: 'keyed_conversation',
      store,
      resetScroll,
      structureChanged,
      ...(previousIds === undefined ? {} : { previousIds }),
    });
    this.redraw();
  }

  subscribeRenderFailure(handler: () => void): () => void {
    this.renderFailureHandlers.add(handler);
    return () => {
      this.renderFailureHandlers.delete(handler);
    };
  }

  redraw(): void {
    if (this.closing || this.renderTimer !== undefined) return;
    const delay = this.lastRenderStarted === undefined
      ? 0
      : Math.max(0, 16 - (this.now() - this.lastRenderStarted));
    this.renderTimer = this.scheduleTimeout(() => {
      this.renderTimer = undefined;
      try {
        this.flushRender();
      } catch {
        for (const handler of this.renderFailureHandlers) handler();
      }
    }, delay);
  }

  /** Complete pending display work; used by deterministic probes without changing update rules. */
  flushRender(): void {
    if (this.closing) return;
    if (this.renderTimer !== undefined) this.cancelTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.lastRenderStarted = this.now();
    try {
      const size = this.terminal.consoleSize();
      if (
        Number.isSafeInteger(size.columns) && size.columns > 0 &&
        Number.isSafeInteger(size.rows) && size.rows > 0
      ) this.lastSize = size;
    } catch {
      // Keep the last valid size, defaulting to 80x24.
    }
    if (
      this.ui.terminalSize.columns !== this.lastSize.columns ||
      this.ui.terminalSize.rows !== this.lastSize.rows
    ) {
      this.ui = reduceUiAction(this.ui, {
        kind: 'resize',
        columns: this.lastSize.columns,
        rows: this.lastSize.rows,
      });
    }
    const layout = this.layoutSnapshot(
      this.lastSize.columns,
      this.lastSize.rows,
    );
    const frame = this.frameFromLayout(layout);
    const navigationGeneration = this.navigationGeneration;
    this.terminal.writeFrame(frame, () => {
      if (frame.scope === this.displayScope) {
        this.displayedLayout = layout;
        this.displayedNavigationGeneration = navigationGeneration;
      }
    });
  }
}

export const renderFailureStatus = (outcome: PresentationOutcome): string =>
  outcome.stopReason === 'max_steps' ? 'request limit reached' : 'agent failure';

// Keep these imports/exports visible to callers constructing host-owned cleanup assertions.
export { DEFAULT_CURSOR_STYLE, RESET_SCROLL_REGION, RESET_SGR, SHOW_CURSOR };
