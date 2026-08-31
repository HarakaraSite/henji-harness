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

const dynamicLine = (prefix: string, value: string): Uint8Array =>
  staticBytes(`${prefix}${boundedEscaped(value)}\n`);

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
  'keys> Enter submit · busy Enter steer · busy Alt+Enter follow-up',
  'keys> busy Esc cancel · busy Ctrl-C cancel+exit',
  'keys> idle Ctrl-C twice within 500 ms exit · empty Ctrl-D exit',
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
  private status = 'ready';
  private followUpPending = false;
  private liveProgress: string | null = null;
  private liveProgressTool = '';
  private liveAssistant: string | null = null;
  private lastSize = { columns: 80, rows: 24 };

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
    try {
      this.terminal.write(staticBytes(`\r${ERASE_LINE}`));
    } catch {
      // Lifecycle continues static restoration even when this write fails.
    }
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
    this.redraw();
  }

  setStatus(status: string): void {
    this.status = status;
    this.redraw();
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
    this.terminal.write(staticBytes(text));
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
      this.terminal.write(staticBytes(`\r${ERASE_LINE}`));
    } catch {
      throw new EventDeliveryError();
    }
  }
}

export const renderFailureStatus = (outcome: LoopOutcome): string =>
  outcome.stopReason === 'max_steps' ? 'request limit reached' : 'agent failure';

// Keep these imports/exports visible to callers constructing host-owned cleanup assertions.
export { DEFAULT_CURSOR_STYLE, RESET_SCROLL_REGION, RESET_SGR, SHOW_CURSOR };
