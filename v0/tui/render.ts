import {
  formatPresentationFailureDiagnostic,
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
  type PresentationStartupState,
} from '../presentation/contract.ts';
import {
  DEFAULT_CURSOR_STYLE,
  ERASE_LINE,
  RESET_SCROLL_REGION,
  RESET_SGR,
  SHOW_CURSOR,
  staticBytes,
  TerminalPort,
  TerminalRendererGate,
} from './terminal.ts';
import { type EditorSnapshot } from './input.ts';
import { type PendingMetadataSnapshot } from './pending_input.ts';
import { type PresentationPosition } from '../presentation/contract.ts';
import { type PresentationProjection } from '../presentation/contract.ts';
import {
  createUiState,
  reduceUiAction,
  reduceUiEvent,
  setUiProjection,
  type UiState,
} from './state.ts';
import { layoutUi, MAX_FRAME_BYTES, type UiLayout } from './layout.ts';

const encoder = new TextEncoder();
const DISPLAY_LIMIT = 64 * 1024;
const ESCAPED_BIDI = (code: number): boolean =>
  code === 0x061c || (code >= 0x200e && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

export interface EscapeOptions {
  /** Render line breaks as the one-line editor marker instead of logical host newlines. */
  readonly editor?: boolean;
}

export interface TuiRendererOptions {
  /** Production uses the retained three-band frame; legacy mode is reserved for direct seams. */
  readonly retained?: boolean;
}

const escapedCodePoint = (code: number): string => {
  let value = code.toString(16).toUpperCase();
  while (value.length < 4) value = `0${value}`;
  return `\\u{${value}}`;
};

/** The sole dynamic-to-terminal escaping boundary. */
export const escapeTerminalText = (
  text: string,
  options: EscapeOptions = {},
): string => {
  let output = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x0a) {
      output += options.editor ? '↵' : '\n';
    } else if (code === 0x09) {
      output += '⇥';
    } else if (
      code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ||
      ESCAPED_BIDI(code)
    ) {
      output += escapedCodePoint(code);
    } else {
      output += character;
    }
  }
  return output;
};

/** Byte count for exactly the dynamic text projection emitted to the terminal. */
export const escapedTerminalTextBytes = (
  text: string,
  options: EscapeOptions = {},
): number => encoder.encode(escapeTerminalText(text, options)).byteLength;

const truncateText = (
  text: string,
  maxBytes = DISPLAY_LIMIT,
): { text: string; truncated: boolean } => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let used = 0;
  let prefix = '';
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (used + size > maxBytes) break;
    prefix += character;
    used += size;
  }
  return { text: prefix, truncated: true };
};

const boundedEscaped = (text: string, options: EscapeOptions = {}): string => {
  const bounded = truncateText(text);
  const escaped = escapeTerminalText(bounded.text, options);
  return bounded.truncated ? `${escaped}… [display truncated]` : escaped;
};

const cellWidth = (character: string): number => {
  const code = character.codePointAt(0)!;
  // Conservative width for common full-width/emoji ranges; combining marks consume no extra cell.
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x1ab0 && code <= 0x1aff)) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) return 2;
  return 1;
};

export interface EditorLayoutRow {
  readonly text: string;
  readonly cursorCell: number | null;
}

export interface EditorLayout {
  readonly rows: readonly EditorLayoutRow[];
  readonly cursorRow: number;
  readonly cursorCell: number;
  readonly omittedAbove: boolean;
  readonly omittedBelow: boolean;
}

/** Pure multiline layout with logical newlines and bounded display-cell wrapping. */
export const layoutEditorText = (
  snapshot: EditorSnapshot,
  columns: number,
  maxRows: number,
): EditorLayout => {
  const width = Number.isSafeInteger(columns) && columns > 0 ? columns : 80;
  const limit = Math.max(1, Number.isSafeInteger(maxRows) ? maxRows : 1);
  const points = [...snapshot.text];
  const cursor = Math.max(0, Math.min(snapshot.cursorScalar, points.length));
  const all: EditorLayoutRow[] = [];
  let line = '', used = 0, cursorRow = 0, cursorCell = 0;
  const push = (force = false): void => {
    if (force || line.length > 0 || all.length === 0) {
      all.push({ text: line, cursorCell: null });
    }
    line = '';
    used = 0;
  };
  for (let index = 0; index <= points.length; index += 1) {
    if (index === cursor) {
      cursorRow = all.length;
      cursorCell = used;
    }
    if (index === points.length) {
      push(true);
      break;
    }
    const point = points[index];
    if (point === '\n') {
      push(true);
      continue;
    }
    const escaped = escapeTerminalText(point, { editor: true });
    const widthOf = [...escaped].reduce(
      (sum, character) => sum + cellWidth(character),
      0,
    );
    if (line.length > 0 && used + widthOf > width) push();
    line += escaped;
    used += widthOf;
  }
  if (all.length === 0) all.push({ text: '', cursorCell: cursorCell });
  const first = Math.max(
    0,
    Math.min(cursorRow - limit + 1, all.length - limit),
  );
  const visible = all.slice(first, first + limit).map((row, index) =>
    Object.freeze({
      ...row,
      cursorCell: first + index === cursorRow ? cursorCell : null,
    })
  );
  return Object.freeze({
    rows: Object.freeze(visible),
    cursorRow: Math.max(0, cursorRow - first),
    cursorCell,
    omittedAbove: first > 0,
    omittedBelow: first + visible.length < all.length,
  });
};

export const pendingMetadataRows = (
  snapshot: PendingMetadataSnapshot | undefined,
  columns = 80,
): readonly string[] => {
  if (snapshot === undefined) return [];
  const live = snapshot.lanes.slice(0, 4).filter((lane) => lane.present);
  const recovery = snapshot.lanes.slice(4).filter((lane) => lane.present);
  const code = (lifecycle: string): string =>
    lifecycle === 'draft'
      ? 'd'
      : lifecycle === 'active_uncommitted'
      ? 'a'
      : lifecycle === 'admitted_unconsumed'
      ? 'u'
      : lifecycle === 'queued_unsubmitted'
      ? 'q'
      : 'r';
  const kind = (value: string): string =>
    value === 'editor' ? 'E' : value === 'active_task' ? 'A' : value === 'steering' ? 'S' : 'F';
  const trim = (value: string): string => [...value].slice(0, Math.max(1, columns)).join('');
  const rows: string[] = [];
  if (live.length > 0) {
    rows.push(
      trim(
        `p ${
          live.map((lane) => `${kind(lane.kind)}:${code(lane.lifecycle)}:${lane.byteCount}`).join(
            ' ',
          )
        }`,
      ),
    );
  }
  if (recovery.length > 0) {
    rows.push(
      trim(
        `r ${
          recovery.map((lane) => `${kind(lane.kind)}:${lane.byteCount}`).join(
            ' ',
          )
        }`,
      ),
    );
  }
  return Object.freeze(rows);
};

const dynamicLine = (prefix: string, value: string): Uint8Array =>
  staticBytes(`${prefix}${boundedEscaped(value)}\n`);

/** Pure history modal projection shared by rendering and its byte admission checks. */
export const historyPageText = (page: PresentationHistoryPage): string => {
  const lines = [
    `history ${page.sessionId === undefined ? 'none' : escapeTerminalText(page.sessionId)} · ${
      page.agent === undefined ? 'default' : escapeTerminalText(page.agent)
    } · turn ${page.turn}/${page.totalTurns} · page ${page.page + 1}/${page.pageCount} · read-only`,
    'Up/Down page · Home oldest · End latest · Esc return',
  ];
  for (const entry of page.entries) {
    lines.push(
      `${entry.role} [t${entry.turn}] ${escapeTerminalText(entry.text)}`,
    );
  }
  if (page.omitted) lines.push('history> page content bounded');
  return truncateText(`${lines.map((line) => `${line}\n`).join('')}`, 32 * 1024)
    .text;
};

const orientationSession = (state: PresentationStartupState): string => {
  switch (state.sessionMode.kind) {
    case 'new':
      return 'new (autosave)';
    case 'continue':
      return 'continue newest';
    case 'exact':
      return 'exact session';
    case 'none':
      return 'no session';
  }
};

const orientationInstruction = (state: PresentationStartupState): string =>
  state.instructions.loaded ? `./${state.instructions.source}` : 'none';

const orientationSkills = (state: PresentationStartupState): string => {
  const names = state.skills.names.length === 0 ? 'none' : state.skills.names.join(', ');
  return `${state.skills.count}: ${names}${
    state.skills.omitted > 0 ? ` (+${state.skills.omitted} more)` : ''
  }`;
};

const orientationTrust = (state: PresentationStartupState): string =>
  state.agentId === 'default'
    ? 'NO HARD SANDBOX; bash/edit/write run with your OS-user access'
    : 'NO HARD SANDBOX; planner has no bash/edit/write';

/** Build the exact twelve logical startup lines without consulting runtime objects. */
export const startupOrientationLines = (
  state: PresentationStartupState,
  workspace = state.workspace,
): readonly string[] => [
  'Henji Harness',
  `workspace> ${escapeTerminalText(workspace)}`,
  `agent> ${escapeTerminalText(state.agentId)}`,
  `model> openrouter / ${escapeTerminalText(state.model.profileId)}`,
  `session> ${orientationSession(state)}`,
  `instructions> ${orientationInstruction(state)}`,
  `skills> ${orientationSkills(state)}`,
  'credential> verified immediately before each provider request; not checked at startup',
  `trust> ${orientationTrust(state)}`,
  'keys> Enter submit · Ctrl-O newline · arrows/Home/End move · Ctrl-W delete',
  'keys> Ctrl-P/N history · Tab path · Ctrl-R recover',
  'keys> busy Enter steer · Alt+Enter follow-up · Esc cancel · Ctrl-C/D exit',
];

const clippedWorkspace = (value: string, columns: number): string => {
  const escaped = escapeTerminalText(value);
  const prefixWidth = [...'workspace> '].reduce(
    (total, character) => total + cellWidth(character),
    0,
  );
  const available = Math.max(1, columns - prefixWidth);
  let used = 0;
  const suffix: string[] = [];
  for (const character of [...escaped].reverse()) {
    const width = cellWidth(character);
    if (used + width > Math.max(1, available - 1)) break;
    suffix.push(character);
    used += width;
  }
  const result = suffix.reverse().join('');
  return result === escaped ? result : `…${result}`;
};

/** Render one bounded orientation block; all dynamic values pass through terminal escaping. */
export const renderStartupOrientationText = (
  state: PresentationStartupState,
  columns = 80,
): string => {
  const validColumns = Number.isSafeInteger(columns) && columns > 0
    ? Math.min(160, Math.max(8, columns))
    : 80;
  const lines = startupOrientationLines(
    state,
    clippedWorkspace(state.workspace, validColumns),
  );
  const output = `${lines.join('\n')}\n`;
  if (encoder.encode(output).byteLength > 2_048) {
    throw new PresentationDeliveryError();
  }
  return output;
};

/**
 * The F1 overlay is a short task-oriented reference, not a runtime metadata report. Dynamic
 * values are limited to the already-sanitized startup projection and the committed position.
 */
export const startupHelpLines = (
  state: PresentationStartupState,
  columns = 80,
  committedTurn = 0,
  rows = 24,
): readonly string[] => {
  const validColumns = Number.isSafeInteger(columns) && columns > 0
    ? Math.min(160, Math.max(8, columns))
    : 80;
  const validRows = Number.isSafeInteger(rows) && rows > 0 ? Math.min(200, Math.max(1, rows)) : 24;
  const session = orientationSession(state);
  if (validColumns < 40 || validRows < 16) {
    // Keep the four safety-critical actions as one short row each on degraded terminals. The
    // remaining detail stays available below them and is still bounded by the layout viewport.
    return Object.freeze([
      'Henji help · F1/Esc',
      '入力 Enter · Ctrl-O 改行',
      '停止 Esc · Ctrl-C×2 exit',
      '再開 Ctrl-D',
      'trust trusted-local · OS user',
      '表示 log/stream/tool/final',
      'steer Enter · follow-up Alt+Enter',
      'session Ctrl-G · history Ctrl-T · context Ctrl-K',
      `現在 ${clippedWorkspace(state.workspace, validColumns)} · t${committedTurn}`,
      'F1/Esc で作業画面へ戻る',
    ]);
  }
  return Object.freeze([
    'Henji help — F1 または Esc で作業画面へ戻る',
    '作業を頼む: 下の`>`へ入力しEnter。Ctrl-Oで改行',
    '作業を見る: logに依頼、assistant途中経過、tool、結果、finalが順に出る',
    '実行中に伝える: Enterで一件steer、Alt+Enterで一件follow-up',
    '止める: 実行中Escでcancel、Ctrl-C二回でsettlement後exit。completed effectは自動rollbackされない',
    '終了と再開: 空入力Ctrl-D。同じdirectoryで`henji --continue`',
    'session/history/context: Ctrl-G / Ctrl-T / Ctrl-K',
    'default capability: workspace read/create/edit、Bash verification、必要時planner相談',
    'trust: trusted-local。tools/BashはOS user権限で動きworkspace外/networkへ到達し得る',
    `現在: ${clippedWorkspace(state.workspace, validColumns)} · agent ${
      boundedEscaped(state.agentId)
    } · session ${boundedEscaped(session)} · committed turn ${committedTurn}`,
  ]);
};

/** Main-screen/scrollback renderer with one live editor line. */
export class TuiRenderer implements TerminalRendererGate {
  private readonly retained: boolean;
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
    return layoutUi(this.ui, columns, rows);
  }

  /** Bounded three-band frame used by the production renderer and provider-free fixtures. */
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
    const terminalFinal = this.ui.log.entries.find((entry) =>
      entry.kind === 'assistant' && entry.turn === this.lastTurn && !entry.live
    )?.text;
    const terminalResultIds = terminalFinal === undefined ? new Set<string>() : new Set(
      this.ui.log.entries.filter((entry) =>
        entry.kind === 'tool' && entry.label.startsWith('tool<') &&
        entry.text === terminalFinal
      ).map((entry) => entry.id),
    );
    // Startup help is ordered as a safety guide: keep its first rows visible on a narrow screen,
    // while other overlays retain their newest-page/tail behavior.
    const overlayLog = this.ui.overlay.kind === 'startupHelp' ? layout.log : layout.overlay;
    const log = (overlayLog.length > 0 ? overlayLog : layout.log)
      .filter((line) => line.entryId === undefined || !terminalResultIds.has(line.entryId))
      .map((line) => line.text);
    const fixed = [
      ...layout.input.map((line) => `> ${line.text}`),
      layout.footer.text,
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
    const second = 'trusted-local · credentials checked only when sending · F1 help';
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
          this.write(dynamicLine('tool> ', event.call.name));
        }
        this.redraw();
        return;
      case 'tool_progress':
        this.liveAssistant = null;
        this.liveProgressTool = event.name;
        this.liveProgress = event.text;
        this.redraw();
        return;
      case 'tool_result':
        this.clearLiveState();
        if (!this.retained) {
          this.clearRecordLine();
          this.write(dynamicLine(
            `tool< ${boundedEscaped(event.result.name)} ${event.result.outcome}> `,
            event.result.text,
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
        if (
          !this.retained && event.turnProviderRequestCount !== undefined &&
          event.runtimeProviderRequestCount !== undefined
        ) {
          this.write(dynamicLine(
            'requests> ',
            `turn=${event.turn} · actual=${event.turnProviderRequestCount} · runtime=${event.runtimeProviderRequestCount}`,
          ));
        }
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
        const line = `${
          formatPresentationFailureDiagnostic(
            event.diagnostic,
            event.durable,
            event.persistenceError,
          )
        }\n` +
          `readback> henji diagnostics show --id ${event.diagnostic.diagnosticId}`;
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
    const short = position.sessionId === undefined ? 'none' : position.sessionId.slice(0, 8);
    this.setStatus(`session ${short} · turn ${position.committedTurn} latest`);
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
    const nextStart = Math.max(
      0,
      Math.min(
        maxStart,
        currentStart + (direction === 'up' ? -viewport : viewport),
      ),
    );
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

  latest(): void {
    this.ui = reduceUiAction(this.ui, { kind: 'latest' });
    this.redraw();
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
      lines.push(
        `${marker} ${escapeTerminalText(row.id)} ${
          escapeTerminalText(row.agent)
        } ${updated} t${row.turnCount}/m${row.messageCount} ${state}`,
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
              `tool< ${result.name} ${result.outcome}> `,
              result.text,
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
