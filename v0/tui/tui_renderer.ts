import {
  type PresentationContextPreview,
  PresentationDeliveryError,
  type PresentationDiagnosticDurability,
  type PresentationDiagnosticPersistenceError,
  type PresentationEvent,
  type PresentationFailureDiagnostic,
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
  presentationFailureReason,
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
import { cellWidth, layoutEditorText, pendingMetadataRows } from './editor_render.ts';
import {
  clippedWorkspace,
  historyPageText,
  orientationSession,
  renderStartupOrientationText,
  startupHelpLines,
} from './startup_render.ts';
import {
  boundedEscaped,
  dynamicLine,
  encoder,
  escapeTerminalText,
  toolCallText,
  toolResultText,
  truncateText,
} from './terminal_text.ts';

export interface TuiRendererOptions {
  /** Production uses the retained three-band frame; legacy mode is reserved for direct seams. */
  readonly retained?: boolean;
  /** Host-local assistant body renderer; the default preserves exact plain text. */
  readonly assistantRenderer?: AssistantContentRenderer;
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
/** Renderer with one live editor line; retained production frames use the lifecycle's alternate screen. */
export class TuiRenderer implements TerminalRendererGate {
  private readonly retained: boolean;
  private readonly assistantRenderer: AssistantContentRenderer;
  private closing = false;
  private editorText = '';
  private editorSnapshot: EditorSnapshot | null = null;
  private pendingMetadata: PendingMetadataSnapshot | undefined;
  private status = 'ready';
  private followUpPending = false;
  private liveProgress: string | null = null;
  private liveProgressTool = '';
  private liveAssistant: string | null = null;
  private lastSize = { columns: 80, rows: 24 };
  // The modern editor occupies a bounded block above the status row. These values describe the
  // terminal cursor's position within that block so redraw can erase the previous block without
  // retaining any user text.
  private editorBlockSpan = 0;
  private editorBlockCursorRow = 0;
  private currentPosition: PresentationPosition | undefined;
  private lastTurn = 0;
  private ui = createUiState();
  private startupState: PresentationStartupState | undefined;

  constructor(
    private readonly terminal: TerminalPort,
    options: TuiRendererOptions = {},
  ) {
    this.retained = options.retained === true;
    this.assistantRenderer = options.assistantRenderer ?? plainTextAssistantRenderer;
  }

  get usesAlternateScreen(): boolean {
    return this.retained;
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
    const fixed = [
      ...layout.beforeInput.map((line) => line.text),
      ...layout.input.map((line) => `> ${line.text}`),
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
    this.closing = true;
    this.followUpPending = false;
    this.liveProgress = null;
    this.liveProgressTool = '';
    this.liveAssistant = null;
  }

  /** Clear all replaceable live activity without adding a completed scrollback record. */
  clearLiveActivity(): void {
    this.clearLiveState();
    this.redraw();
  }

  private clearLiveState(): void {
    this.liveProgress = null;
    this.liveProgressTool = '';
    this.liveAssistant = null;
  }

  /** Backwards-compatible name retained for existing controller/test callers. */
  clearLiveProgress(): void {
    this.clearLiveActivity();
  }

  /** Write the startup orientation before any prompt or restored transcript. */
  renderStartupOrientation(state: PresentationStartupState): void {
    if (this.closing) throw new PresentationDeliveryError();
    let columns = 80;
    try {
      const size = this.terminal.consoleSize();
      if (
        Number.isSafeInteger(size.columns) && size.columns > 0 &&
        Number.isSafeInteger(size.rows) && size.rows > 0
      ) columns = size.columns;
    } catch {
      // Keep the documented 80-column fallback for unavailable/invalid terminal sizes.
    }
    this.write(staticBytes(renderStartupOrientationText(state, columns)));
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
    const second = 'trusted-local · credentials checked only when sending';
    if (this.retained) {
      this.ui = reduceUiAction(this.ui, {
        kind: 'startup',
        lines: [first, second],
      });
      this.redraw();
    } else this.writeStatic(`${first}\n${second}\n`);
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
    const help = `${
      startupHelpLines(
        state,
        this.lastSize.columns,
        committedTurn,
        this.lastSize.rows,
      ).join('\n')
    }\n`;
    if (this.retained) this.redraw();
    else this.writeStatic(help);
  }

  clearLiveLine(): void {
    if (this.editorBlockSpan > 0) this.clearEditorBlock();
    else this.terminal.write(staticBytes(`\r${ERASE_LINE}`));
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
        this.setStatus('busy');
        return;
      case 'user_message':
        if (!this.retained) {
          this.clearRecordLine();
          this.write(dynamicLine('user> ', event.message.content.text));
        }
        this.redraw();
        return;
      case 'assistant_message':
        this.clearLiveState();
        if (
          !Array.isArray(event.message.content) &&
          'text' in event.message.content
        ) {
          if (!this.retained) {
            this.clearRecordLine();
            this.write(dynamicLine('assistant> ', event.message.content.text));
          }
          this.redraw();
        }
        return;
      case 'assistant_progress':
        this.liveProgress = null;
        this.liveProgressTool = '';
        this.liveAssistant = event.text;
        this.redraw();
        return;
      case 'tool_call':
        this.clearLiveState();
        if (!this.retained) {
          this.clearRecordLine();
          this.write(
            dynamicLine(
              'tool> ',
              toolCallText(event.call.name, event.call.arguments),
            ),
          );
        }
        this.redraw();
        return;
      case 'tool_progress':
        this.liveAssistant = null;
        this.liveProgressTool = event.name;
        this.liveProgress = 'running…';
        this.redraw();
        return;
      case 'tool_result':
        this.clearLiveState();
        if (!this.retained) {
          this.clearRecordLine();
          this.write(dynamicLine(
            'tool> ',
            toolResultText(event.result.name, event.result.outcome),
          ));
        }
        this.redraw();
        return;
      case 'steering_message':
        this.clearLiveState();
        if (!this.retained) {
          this.clearRecordLine();
          this.write(dynamicLine('steer> ', event.message.content.text));
        }
        this.setStatus('busy · steer applied');
        return;
      case 'turn_end':
        this.clearLiveState();
        this.setStatus(
          event.committed && this.followUpPending
            ? 'busy · starting follow-up'
            : event.committed
            ? 'ready'
            : event.outcome,
        );
        return;
      case 'failure_diagnostic': {
        this.clearLiveState();
        const line = presentationFailureReason(event.diagnostic);
        if (!this.retained) {
          this.clearRecordLine();
          this.write(dynamicLine('failure> ', line));
        }
        this.redraw();
        return;
      }
      case 'session_binding_replaced':
      case 'restored_log':
      case 'history_page':
      case 'context_preview':
      case 'context_result':
      case 'lifecycle':
      case 'warning':
      case 'notice':
        this.redraw();
        return;
    }
  };

  setEditor(text: string): void {
    this.editorText = text;
    this.editorSnapshot = null;
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
    this.editorText = snapshot.text;
    this.editorSnapshot = Object.freeze({ ...snapshot });
    this.ui = reduceUiAction(this.ui, {
      kind: 'editor',
      snapshot: this.editorSnapshot,
    });
    this.redraw();
  }

  setPendingMetadata(metadata: PendingMetadataSnapshot | undefined): void {
    this.pendingMetadata = metadata === undefined ? undefined : Object.freeze({
      ...metadata,
      lanes: Object.freeze([...metadata.lanes]),
    });
    this.ui = reduceUiAction(this.ui, {
      kind: 'pending',
      snapshot: this.pendingMetadata,
    });
    this.redraw();
  }

  setStatus(status: string): void {
    this.status = status;
    this.ui = reduceUiAction(this.ui, { kind: 'status', text: status });
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
    if (!this.retained) this.writeStatic(`\r${ERASE_LINE}\n`);
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
    const start = boundedPage * pageSize;
    const rows = listing.sessions.slice(start, start + pageSize);
    const lines = [
      'session picker · Up/Down select · Left/Right page · Enter resume · Esc cancel',
      `page ${boundedPage + 1}/${pageCount}${loading ? ' · loading' : ''}`,
    ];
    if (rows.length === 0 && !loading) lines.push('no sessions');
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const absolute = start + index;
      const marker = absolute === selected ? '>' : ' ';
      const state = row.current
        ? 'current'
        : row.resumed
        ? 'resumed'
        : row.mismatch
        ? 'mismatch'
        : 'available';
      const updated = escapeTerminalText(row.updatedAt);
      const model = row.modelSelection === undefined
        ? 'legacy model'
        : `${row.modelSelection.provider} ${
          escapeTerminalText(row.modelSelection.modelId)
        } effort:${escapeTerminalText(row.modelSelection.effort)}`;
      lines.push(
        `${marker} ${escapeTerminalText(row.id)} ${
          escapeTerminalText(row.agent)
        } ${updated} t${row.turnCount}/m${row.messageCount} ${model} ${state}`,
      );
    }
    if (listing.skippedInvalid > 0) {
      lines.push(`skipped invalid: ${listing.skippedInvalid}`);
    }
    if (this.retained) {
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
    } else this.writeStatic(`${lines.map((line) => `${line}\n`).join('')}`);
  }

  renderChoicePicker(lines: readonly string[]): void {
    if (this.closing) throw new PresentationDeliveryError();
    if (this.retained) {
      this.ui = reduceUiAction(this.ui, {
        kind: 'overlay',
        overlay: { kind: 'choicePicker', lines: Object.freeze([...lines]) },
      });
      this.redraw();
    } else {
      this.writeStatic(lines.map((line) => `${line}\n`).join(''));
    }
  }

  renderHistoryPage(page: PresentationHistoryPage): void {
    if (this.closing) throw new PresentationDeliveryError();
    if (this.retained) {
      this.ui = reduceUiAction(this.ui, {
        kind: 'overlay',
        overlay: { kind: 'history', page, pageNumber: page.page },
      });
      this.redraw();
    } else this.writeStatic(historyPageText(page));
  }

  renderContextPanel(preview: PresentationContextPreview): void {
    if (this.closing) throw new PresentationDeliveryError();
    const current = preview.currentCheckpoint === undefined
      ? 'none'
      : `through ${preview.currentCheckpoint.coveredThroughTurn}, retain ${preview.currentCheckpoint.retainedFromTurn}+`;
    const proposed = preview.proposed === undefined
      ? 'no useful fitting compaction'
      : `through ${preview.proposed.coveredThroughTurn}, retain ${preview.proposed.retainedFromTurn}+`;
    const estimate = preview.projectedMessagesBytes === undefined
      ? 'unavailable'
      : `${preview.projectedMessagesBytes} bytes (baseline ${preview.baselineMessagesBytes} bytes)`;
    if (this.retained) {
      this.ui = reduceUiAction(this.ui, {
        kind: 'overlay',
        overlay: { kind: 'compaction', preview },
      });
      this.redraw();
    } else {
      this.writeStatic(
        `context recovery · committed turns ${preview.currentTurn}\n` +
          `checkpoint> ${current}\n` +
          `proposed> ${proposed}\n` +
          `provider view> ${estimate}\n` +
          'Enter confirm one provider request · v view summary · Esc cancel\n',
      );
    }
  }

  renderContextSummary(summary: string, coveredThroughTurn: number): void {
    if (this.closing) throw new PresentationDeliveryError();
    if (this.retained) {
      this.ui = reduceUiAction(this.ui, {
        kind: 'status',
        text: `context checkpoint · through turn ${coveredThroughTurn}`,
      });
      this.redraw();
    } else {
      this.writeStatic(
        `context checkpoint · covered through turn ${coveredThroughTurn} · read-only\n` +
          `${boundedEscaped(summary)}\n`,
      );
    }
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
    this.clearLiveState();
    this.ui = reduceUiAction(this.ui, {
      kind: 'assistant_final',
      turn: this.lastTurn,
      text,
    });
    if (!this.retained) {
      this.clearRecordLine();
      this.write(dynamicLine('assistant> ', text));
    }
    this.redraw();
  }

  /** Render a bounded committed transcript before accepting new input. */
  renderRestored(messages: readonly PresentationMessage[], omitted = 0): void {
    if (this.closing) throw new PresentationDeliveryError();
    this.clearLiveState();
    if (this.retained) {
      let turn = 0;
      for (const message of messages) {
        if (message.role === 'user') {
          turn += 1;
          this.ui = reduceUiEvent(this.ui, {
            kind: 'user_message',
            turn,
            message,
          });
        } else if (message.role === 'assistant') {
          if (Array.isArray(message.content)) {
            for (const call of message.content) {
              this.ui = reduceUiEvent(this.ui, {
                kind: 'tool_call',
                turn,
                call,
              });
            }
          } else {
            this.ui = reduceUiEvent(this.ui, {
              kind: 'assistant_message',
              turn,
              message,
            });
          }
        } else {
          for (const result of message.content) {
            this.ui = reduceUiEvent(this.ui, {
              kind: 'tool_result',
              turn,
              result,
            });
          }
        }
      }
      if (omitted > 0) {
        this.ui = reduceUiEvent(this.ui, {
          kind: 'warning',
          code: 'recoverable',
          text: `${omitted} messages omitted`,
          generation: this.ui.generation,
        });
      }
      this.redraw();
      return;
    }
    for (const message of messages) {
      if (message.role === 'user') {
        this.write(dynamicLine('user> ', message.content.text));
      } else if (message.role === 'assistant') {
        if (Array.isArray(message.content)) {
          for (const call of message.content) {
            this.write(dynamicLine('tool> ', call.name));
          }
        } else {
          this.write(
            dynamicLine(
              'assistant> ',
              (message.content as { readonly text: string }).text,
            ),
          );
        }
      } else {
        for (const result of message.content) {
          this.write(
            dynamicLine(
              'tool> ',
              toolResultText(result.name, result.outcome),
            ),
          );
        }
      }
    }
    if (omitted > 0) {
      this.write(dynamicLine('history> ', `${omitted} messages omitted`));
    }
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
    if (this.retained) {
      const frame = this.renderFrame(this.lastSize.columns, this.lastSize.rows);
      this.write(staticBytes(`\x1b[2J\x1b[H${frame}`));
      return;
    }
    const columns = Math.max(8, this.lastSize.columns);
    const status = escapeTerminalText(this.displayStatus(), { editor: true });
    if (this.editorSnapshot !== null) {
      const metadata = pendingMetadataRows(this.pendingMetadata, columns);
      const rows = Math.min(
        8,
        Math.max(1, this.lastSize.rows - 6 - metadata.length),
      );
      const layout = layoutEditorText(
        this.editorSnapshot,
        Math.max(1, columns - 4),
        rows,
      );
      if (this.editorBlockSpan > 0) this.clearEditorBlock();
      const editorRows = layout.rows.map((row) => `\r${ERASE_LINE}> ${row.text}`);
      const metadataRows = metadata.map((row) => `\r${ERASE_LINE}> ${row}`);
      const statusRow = `\r${ERASE_LINE}> [${status}]`;
      const block = [...editorRows, ...metadataRows, statusRow].join('\n');
      const span = layout.rows.length + metadata.length;
      const cursorUp = span - layout.cursorRow;
      const cursorRight = 2 + layout.cursorCell;
      this.write(
        staticBytes(
          `${block}\x1b[${cursorUp}A\r\x1b[${cursorRight}C`,
        ),
      );
      this.editorBlockSpan = span;
      this.editorBlockCursorRow = layout.cursorRow;
      return;
    }
    const editor = this.editorText.length > 0
      ? escapeTerminalText(this.editorText, { editor: true })
      : this.liveAssistant !== null
      ? `assistant~ ${boundedEscaped(this.liveAssistant, { editor: true })}`
      : this.liveProgress === null
      ? escapeTerminalText(this.editorText, { editor: true })
      : `tool~ ${boundedEscaped(this.liveProgressTool, { editor: true })} ${
        boundedEscaped(
          this.liveProgress,
          { editor: true },
        )
      }`;
    const suffix = `  [${status}]`;
    const suffixWidth = [...suffix].reduce(
      (total, character) => total + cellWidth(character),
      0,
    );
    const available = Math.max(0, columns - 2 - suffixWidth);
    let used = 0;
    const visibleCharacters: string[] = [];
    for (const character of [...editor].reverse()) {
      const width = cellWidth(character);
      if (used + width > available) break;
      visibleCharacters.push(character);
      used += width;
    }
    const visible = visibleCharacters.reverse().join('');
    this.write(staticBytes(`\r${ERASE_LINE}> ${visible}${suffix}`));
  }

  private displayStatus(): string {
    if (!this.followUpPending) return this.status;
    if (this.status === 'busy') return 'busy · follow-up queued';
    if (
      this.status === 'busy · steer pending' ||
      this.status === 'busy · steer applied'
    ) return `${this.status} · follow-up queued`;
    return this.status;
  }

  writeStatic(text: string): void {
    if (this.closing) throw new PresentationDeliveryError();
    try {
      this.terminal.write(staticBytes(text));
    } catch {
      throw new PresentationDeliveryError();
    }
  }

  private write(bytes: Uint8Array): void {
    if (this.closing) throw new PresentationDeliveryError();
    try {
      this.terminal.write(bytes);
    } catch {
      throw new PresentationDeliveryError();
    }
  }

  private clearRecordLine(): void {
    if (this.closing) throw new PresentationDeliveryError();
    try {
      if (this.editorBlockSpan > 0) this.clearEditorBlock();
      else this.terminal.write(staticBytes(`\r${ERASE_LINE}`));
    } catch {
      throw new PresentationDeliveryError();
    }
  }

  /** Erase the previous editor/metadata/status block and leave the cursor at its top-left. */
  private clearEditorBlock(bestEffort = false): void {
    if (this.editorBlockSpan === 0) return;
    let output = `\r${this.editorBlockCursorRow > 0 ? `\x1b[${this.editorBlockCursorRow}A` : ''}`;
    for (let index = 0; index <= this.editorBlockSpan; index += 1) {
      output += ERASE_LINE;
      if (index < this.editorBlockSpan) output += '\n';
    }
    output += `\x1b[${this.editorBlockSpan}A\r`;
    try {
      this.terminal.write(staticBytes(output));
    } catch {
      if (!bestEffort) throw new PresentationDeliveryError();
    } finally {
      this.editorBlockSpan = 0;
      this.editorBlockCursorRow = 0;
    }
  }
}

export const renderFailureStatus = (outcome: PresentationOutcome): string =>
  outcome.stopReason === 'max_steps' ? 'request limit reached' : 'agent failure';

// Keep these imports/exports visible to callers constructing host-owned cleanup assertions.
export { DEFAULT_CURSOR_STYLE, RESET_SCROLL_REGION, RESET_SGR, SHOW_CURSOR };
