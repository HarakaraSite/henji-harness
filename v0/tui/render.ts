import { type AgentEvent, EventDeliveryError } from '../agent/events.ts';
import { type LoopOutcome, type Message } from '../agent/contracts.ts';
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
import { type RuntimeDisplayState } from '../agent/startup_orientation.ts';
import { type EditorSnapshot } from './input.ts';
import { type PendingMetadataSnapshot } from './pending_input.ts';
import {
  type ContextRecoveryPreview,
  type NavigationListing,
  type NavigationPosition,
} from '../agent/session_navigation.ts';
import { type SessionHistoryPage } from '../agent/session_history.ts';

const encoder = new TextEncoder();
const DISPLAY_LIMIT = 64 * 1024;
const ESCAPED_BIDI = (code: number): boolean =>
  code === 0x061c || (code >= 0x200e && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

export interface EscapeOptions {
  /** Render line breaks as the one-line editor marker instead of logical host newlines. */
  readonly editor?: boolean;
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
    if (force || line.length > 0 || all.length === 0) all.push({ text: line, cursorCell: null });
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
    const widthOf = [...escaped].reduce((sum, character) => sum + cellWidth(character), 0);
    if (line.length > 0 && used + widthOf > width) push();
    line += escaped;
    used += widthOf;
  }
  if (all.length === 0) all.push({ text: '', cursorCell: cursorCell });
  const first = Math.max(0, Math.min(cursorRow - limit + 1, all.length - limit));
  const visible = all.slice(first, first + limit).map((row, index) =>
    Object.freeze({ ...row, cursorCell: first + index === cursorRow ? cursorCell : null })
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
      trim(`r ${recovery.map((lane) => `${kind(lane.kind)}:${lane.byteCount}`).join(' ')}`),
    );
  }
  return Object.freeze(rows);
};

const dynamicLine = (prefix: string, value: string): Uint8Array =>
  staticBytes(`${prefix}${boundedEscaped(value)}\n`);

/** Pure history modal projection shared by rendering and its byte admission checks. */
export const historyPageText = (page: SessionHistoryPage): string => {
  const lines = [
    `history ${page.sessionId ?? 'none'} · ${
      page.agent ?? 'default'
    } · turn ${page.turn}/${page.totalTurns} · page ${page.page + 1}/${page.pageCount} · read-only`,
    'Up/Down page · Home oldest · End latest · Esc return',
  ];
  for (const entry of page.entries) {
    lines.push(`${entry.role} [t${entry.turn}] ${escapeTerminalText(entry.text)}`);
  }
  if (page.omitted) lines.push('history> page content bounded');
  return `${lines.map((line) => `${line}\n`).join('')}`;
};

const orientationSession = (state: RuntimeDisplayState): string => {
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

const orientationInstruction = (state: RuntimeDisplayState): string =>
  state.instructions.loaded ? `./${state.instructions.source}` : 'none';

const orientationSkills = (state: RuntimeDisplayState): string => {
  const names = state.skills.names.length === 0 ? 'none' : state.skills.names.join(', ');
  return `${state.skills.count}: ${names}${
    state.skills.omitted > 0 ? ` (+${state.skills.omitted} more)` : ''
  }`;
};

const orientationTrust = (state: RuntimeDisplayState): string =>
  state.agentId === 'default'
    ? 'NO HARD SANDBOX; bash/edit/write run with your OS-user access'
    : 'NO HARD SANDBOX; planner has no bash/edit/write';

/** Build the exact twelve logical startup lines without consulting runtime objects. */
export const startupOrientationLines = (
  state: RuntimeDisplayState,
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
  state: RuntimeDisplayState,
  columns = 80,
): string => {
  const validColumns = Number.isSafeInteger(columns) && columns > 0
    ? Math.min(160, Math.max(8, columns))
    : 80;
  const lines = startupOrientationLines(state, clippedWorkspace(state.workspace, validColumns));
  const output = `${lines.join('\n')}\n`;
  if (encoder.encode(output).byteLength > 2_048) {
    throw new EventDeliveryError();
  }
  return output;
};

/** Main-screen/scrollback renderer with one live editor line. */
export class TuiRenderer implements TerminalRendererGate {
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
  private currentPosition: NavigationPosition | undefined;

  constructor(private readonly terminal: TerminalPort) {}

  get isClosing(): boolean {
    return this.closing;
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
  renderStartupOrientation(state: RuntimeDisplayState): void {
    if (this.closing) throw new EventDeliveryError();
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

  clearLiveLine(): void {
    if (this.editorBlockSpan > 0) this.clearEditorBlock();
    else this.terminal.write(staticBytes(`\r${ERASE_LINE}`));
  }

  /** Event sink entry point. It is intentionally synchronous. */
  eventSink = (event: AgentEvent): void => {
    if (this.closing) throw new EventDeliveryError();
    switch (event.kind) {
      case 'turn_start':
        this.setStatus('busy');
        return;
      case 'user_message':
        this.clearRecordLine();
        this.write(dynamicLine('user> ', event.message.content.text));
        this.redraw();
        return;
      case 'assistant_message':
        this.clearLiveState();
        if (
          !Array.isArray(event.message.content) &&
          'text' in event.message.content
        ) {
          this.clearRecordLine();
          this.write(dynamicLine('assistant> ', event.message.content.text));
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
        this.clearRecordLine();
        this.write(dynamicLine('tool> ', event.call.name));
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
        this.clearRecordLine();
        this.write(dynamicLine(
          `tool< ${boundedEscaped(event.result.name)} ${event.result.outcome}> `,
          event.result.text,
        ));
        this.redraw();
        return;
      case 'steering_message':
        this.clearLiveState();
        this.clearRecordLine();
        this.write(dynamicLine('steer> ', event.message.content.text));
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
    }
  };

  setEditor(text: string): void {
    this.editorText = text;
    this.editorSnapshot = null;
    this.redraw();
  }

  setEditorSnapshot(snapshot: EditorSnapshot): void {
    this.editorText = snapshot.text;
    this.editorSnapshot = Object.freeze({ ...snapshot });
    this.redraw();
  }

  setPendingMetadata(metadata: PendingMetadataSnapshot | undefined): void {
    this.pendingMetadata = metadata === undefined
      ? undefined
      : Object.freeze({ ...metadata, lanes: Object.freeze([...metadata.lanes]) });
    this.redraw();
  }

  setStatus(status: string): void {
    this.status = status;
    this.redraw();
  }

  setCurrentPosition(position: NavigationPosition): void {
    this.currentPosition = Object.freeze({ ...position });
    const short = position.sessionId === undefined ? 'none' : position.sessionId.slice(0, 8);
    this.setStatus(`session ${short} · turn ${position.committedTurn} latest`);
  }

  /** End a bounded modal projection and restore the main editor line. */
  clearModal(): void {
    if (this.closing) return;
    this.writeStatic(`\r${ERASE_LINE}\n`);
    this.redraw();
  }

  renderSessionPicker(
    listing: NavigationListing,
    selected = 0,
    page = 0,
    loading = false,
  ): void {
    if (this.closing) throw new EventDeliveryError();
    const pageSize = 8;
    const pageCount = Math.max(1, Math.ceil(listing.sessions.length / pageSize));
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
        `${marker} ${row.id} ${
          escapeTerminalText(row.agent)
        } ${updated} t${row.turnCount}/m${row.messageCount} ${state}`,
      );
    }
    if (listing.skippedInvalid > 0) lines.push(`skipped invalid: ${listing.skippedInvalid}`);
    this.writeStatic(`${lines.map((line) => `${line}\n`).join('')}`);
  }

  renderHistoryPage(page: SessionHistoryPage): void {
    if (this.closing) throw new EventDeliveryError();
    this.writeStatic(historyPageText(page));
  }

  renderContextPanel(preview: ContextRecoveryPreview): void {
    if (this.closing) throw new EventDeliveryError();
    const current = preview.currentCheckpoint === undefined
      ? 'none'
      : `through ${preview.currentCheckpoint.coveredThroughTurn}, retain ${preview.currentCheckpoint.retainedFromTurn}+`;
    const proposed = preview.proposed === undefined
      ? 'no useful fitting compaction'
      : `through ${preview.proposed.coveredThroughTurn}, retain ${preview.proposed.retainedFromTurn}+`;
    const estimate = preview.projectedMessagesBytes === undefined
      ? 'unavailable'
      : `${preview.projectedMessagesBytes} bytes (baseline ${preview.baselineMessagesBytes} bytes)`;
    this.writeStatic(
      `context recovery · committed turns ${preview.currentTurn}\n` +
        `checkpoint> ${current}\n` +
        `proposed> ${proposed}\n` +
        `provider view> ${estimate}\n` +
        'Enter confirm one provider request · v view summary · Esc cancel\n',
    );
  }

  renderContextSummary(summary: string, coveredThroughTurn: number): void {
    if (this.closing) throw new EventDeliveryError();
    this.writeStatic(
      `context checkpoint · covered through turn ${coveredThroughTurn} · read-only\n` +
        `${boundedEscaped(summary)}\n`,
    );
  }

  /** Show only that one ordinary follow-up is pending; the text remains controller-local. */
  setFollowUpPending(pending: boolean): void {
    if (this.closing) return;
    this.followUpPending = pending;
    this.redraw();
  }

  renderAssistantFinal(text: string): void {
    if (this.closing) throw new EventDeliveryError();
    this.clearLiveState();
    this.clearRecordLine();
    this.write(dynamicLine('assistant> ', text));
    this.redraw();
  }

  /** Render a bounded committed transcript before accepting new input. */
  renderRestored(messages: readonly Message[], omitted = 0): void {
    if (this.closing) throw new EventDeliveryError();
    this.clearLiveState();
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
    const columns = Math.max(8, this.lastSize.columns);
    const status = escapeTerminalText(this.displayStatus(), { editor: true });
    if (this.editorSnapshot !== null) {
      const metadata = pendingMetadataRows(this.pendingMetadata, columns);
      const rows = Math.min(8, Math.max(1, this.lastSize.rows - 6 - metadata.length));
      const layout = layoutEditorText(this.editorSnapshot, Math.max(1, columns - 4), rows);
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
    if (this.closing) throw new EventDeliveryError();
    try {
      this.terminal.write(staticBytes(text));
    } catch {
      throw new EventDeliveryError();
    }
  }

  private write(bytes: Uint8Array): void {
    if (this.closing) throw new EventDeliveryError();
    try {
      this.terminal.write(bytes);
    } catch {
      throw new EventDeliveryError();
    }
  }

  private clearRecordLine(): void {
    if (this.closing) throw new EventDeliveryError();
    try {
      if (this.editorBlockSpan > 0) this.clearEditorBlock();
      else this.terminal.write(staticBytes(`\r${ERASE_LINE}`));
    } catch {
      throw new EventDeliveryError();
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
      if (!bestEffort) throw new EventDeliveryError();
    } finally {
      this.editorBlockSpan = 0;
      this.editorBlockCursorRow = 0;
    }
  }
}

export const renderFailureStatus = (outcome: LoopOutcome): string =>
  outcome.stopReason === 'max_steps' ? 'request limit reached' : 'agent failure';

// Keep these imports/exports visible to callers constructing host-owned cleanup assertions.
export { DEFAULT_CURSOR_STYLE, RESET_SCROLL_REGION, RESET_SGR, SHOW_CURSOR };
