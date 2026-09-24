import { type EditorSnapshot } from './input.ts';
import { type UiLogEntry, type UiState } from './state.ts';
import {
  type AssistantContentRenderer,
  type AssistantSpan,
  type ConversationLabelTone,
  plainTextAssistantRenderer,
  projectConversationEntry,
} from './conversation_renderer.ts';
import { thinkingBodyRenderer } from './assistant_layout.ts';
import { startupHeaderLines } from './startup_render.ts';
import { cellWidth, localTimestampText } from './terminal_text.ts';

export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;
export const MAX_COLUMNS = 512;
export const MAX_ROWS = 200;
export const MAX_EDITOR_ROWS = 8;
export const MAX_FRAME_BYTES = 128 * 1024;
export const MAX_LAYOUT_SOURCE_BYTES = 2 * 1024 * 1024;

export interface LayoutRow {
  readonly text: string;
  readonly entryId?: string;
  readonly sourceScalarOffset?: number;
  readonly sourceLine?: number;
  readonly sourceColumn?: number;
  readonly labelScalarLength?: number;
  readonly labelTone?: ConversationLabelTone;
  /** Whole-row tone; the renderer applies it to the entire row text. */
  readonly rowTone?: ConversationLabelTone;
  readonly spans?: readonly AssistantSpan[];
  readonly blinkScalarStart?: number;
  readonly blinkScalarLength?: number;
  readonly kind: 'log' | 'input' | 'footer' | 'omitted' | 'separator';
}

export interface UiLayout {
  readonly columns: number;
  readonly rows: number;
  readonly degraded: boolean;
  readonly log: readonly LayoutRow[];
  readonly allLog: readonly LayoutRow[];
  readonly logStart: number;
  readonly totalLogRows: number;
  readonly overlay: readonly LayoutRow[];
  readonly beforeInput: readonly LayoutRow[];
  readonly input: readonly LayoutRow[];
  readonly afterInput: readonly LayoutRow[];
  readonly footer: readonly LayoutRow[];
  readonly cursor: { readonly row: number; readonly cell: number };
  readonly sourceBytes: number;
}

const encoder = new TextEncoder();
const clamp = (value: number, min: number, max: number): number =>
  Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : min;
const width = (text: string): number =>
  [...text].reduce((sum, character) => sum + cellWidth(character), 0);
const escapedCodePoint = (code: number): string => {
  let value = code.toString(16).toUpperCase();
  while (value.length < 4) value = `0${value}`;
  return `\\u{${value}}`;
};
const safeDisplay = (text: string, preserveNewline = true): string => {
  let result = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x0a && preserveNewline) result += character;
    else if (code === 0x09) result += '⇥';
    else if (
      code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ||
      code === 0x061c || (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
    ) {
      result += escapedCodePoint(code);
    } else result += character;
  }
  return result;
};
const truncateCells = (text: string, columns: number): string => {
  let used = 0;
  let result = '';
  for (const character of text) {
    const next = cellWidth(character);
    if (used + next > columns) break;
    result += character;
    used += next;
  }
  return result;
};
const ellipsisCells = (text: string, columns: number): string => {
  if (width(text) <= columns) return text;
  if (columns <= 0) return '';
  if (columns === 1) return '…';
  return `${truncateCells(text, columns - 1)}…`;
};
const suffixCells = (text: string, columns: number): string => {
  if (width(text) <= columns) return text;
  if (columns <= 0) return '';
  const marker = '…';
  const markerWidth = width(marker);
  if (columns <= markerWidth) return marker;
  let used = markerWidth;
  let result = '';
  const characters = [...text];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const next = cellWidth(characters[index]);
    if (used + next > columns) break;
    result = characters[index] + result;
    used += next;
  }
  return `${marker}${result}`;
};

/** Controller ready-status strings contain position facts that are rendered separately below. */
const footerStatus = (state: UiState): string => {
  const parts = state.status.split(' · ');
  const ready = parts.findIndex((part) => part === 'ready' || part.startsWith('ready '));
  const hasPosition = parts[0]?.startsWith('session ') === true &&
    parts.some((part) => part.startsWith('agent ')) &&
    parts.some((part) => part.startsWith('turn '));
  if (hasPosition && ready >= 0) return parts.slice(ready).join(' · ');
  if (
    parts.length === 3 && parts[0]?.startsWith('session ') &&
    parts[1]?.startsWith('turn ') && parts[2] === 'latest'
  ) return state.lifecycle === 'idle' ? 'ready' : state.lifecycle;
  return state.status;
};

/** Fixed frames for the busy `working` indicator; applied only to the final terminal frame. */
export const BUSY_SPINNER_FRAMES: readonly string[] = Object.freeze([
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
]);

const footerStatusParts = (
  status: string,
): { readonly primary: string; readonly credential?: string; readonly details?: string } => {
  const parts = status.split(' · ');
  const primaryIndex = parts.findIndex((part) =>
    part === 'ready' || part.startsWith('ready ') ||
    part === 'busy' || part.startsWith('busy ') ||
    part === 'cancelling' || part.startsWith('cancelling ') ||
    part === 'compacting' || part.startsWith('compacting ') ||
    part === 'recoverable_error' || part.startsWith('recoverable_error ') ||
    part === 'fatal' || part.startsWith('fatal ')
  );
  const index = primaryIndex >= 0 ? primaryIndex : 0;
  const segment = parts[index] ?? status;
  const activePrimary = ['busy', 'cancelling'].find((candidate) =>
    segment === candidate || segment.startsWith(`${candidate} `) ||
    segment.startsWith(`${candidate};`)
  );
  if (activePrimary !== undefined) {
    const inlineDetails = segment.slice(activePrimary.length).replace(/^[ ;]+/, '');
    const details = [inlineDetails, ...parts.slice(index + 1)].filter((part) => part.length > 0)
      .join(' · ');
    return details.length === 0 ? { primary: activePrimary } : { primary: activePrimary, details };
  }
  const trailing = parts.slice(index + 1);
  const credential = trailing.find((part) => part.startsWith('credential missing:'));
  const details = trailing.filter((part) => part !== credential).join(' · ');
  return {
    primary: segment,
    ...(credential === undefined ? {} : { credential }),
    ...(details.length === 0 ? {} : { details }),
  };
};

interface HistoryViewport {
  readonly first: number;
  readonly last: number;
  readonly total: number;
}

const footerStatusText = (
  state: UiState,
  columns: number,
  history?: HistoryViewport,
): Readonly<{
  readonly text: string;
  readonly blinkScalarStart?: number;
  readonly blinkScalarLength?: number;
}> => {
  const renderSegments = (segments: readonly string[]): string =>
    `[${segments.map((segment) => segment.replaceAll(' · ', ' │ ')).join(' │ ')}]`;
  // The editor draft is already visible in the input band. Keep the uncommitted input lanes
  // available in the footer, but do not repeat its byte count as internal status.
  const pending = state.pending?.lanes.filter((lane) => lane.present && lane.kind !== 'editor') ??
    [];
  const pendingSegment = pending.length === 0
    ? undefined
    : `pending ${pending.map((lane) => `${lane.kind}:${lane.byteCount}B`).join(',')}`;
  const belowSegment = state.newBelowCount > 0 ? `new below ${state.newBelowCount}` : undefined;
  const status = footerStatusParts(footerStatus(state));
  const primary = safeDisplay(status.primary, false);
  const elapsed = state.lifecycle === 'busy' &&
      state.busyElapsedSeconds !== undefined &&
      (primary === 'busy' || primary === 'cancelling')
    ? (() => {
      const total = state.busyElapsedSeconds!;
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor(total % 3600 / 60);
      const seconds = total % 60;
      return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    })()
    : undefined;
  const spinner = state.lifecycle === 'busy' &&
      (primary === 'busy' || primary === 'cancelling')
    ? BUSY_SPINNER_FRAMES[(state.busySpinnerFrame ?? 0) % BUSY_SPINNER_FRAMES.length]
    : undefined;
  const primaryLabel = primary === 'busy' ? 'working' : primary;
  const elapsedPrimary = elapsed === undefined ? primaryLabel : `${primaryLabel} ${elapsed}`;
  const spinnerPrimary = spinner === undefined ? elapsedPrimary : `${spinner} ${elapsedPrimary}`;
  const displayedPrimary = width(`[${spinnerPrimary}]`) <= columns
    ? spinnerPrimary
    : (width(`[${elapsedPrimary}]`) <= columns ? elapsedPrimary : primaryLabel);
  const commandSegment = state.slashCommandCandidates.length === 0
    ? undefined
    : `cmds: ${state.slashCommandCandidates.join(', ')}`;
  const commandItem = commandSegment === undefined
    ? []
    : [{ kind: 'commands', text: safeDisplay(commandSegment, false) }];
  const cancelSegment = state.lifecycle === 'busy' ? 'Esc cancel' : undefined;
  const historyFull = history === undefined
    ? undefined
    : `history rows ${history.first}-${history.last}/${history.total} · Esc latest`;
  const historyRequired = historyFull === undefined
    ? undefined
    : width(`[${historyFull}]`) <= columns
    ? historyFull
    : 'history · Esc latest';
  const fixed: string[] = historyRequired === undefined ? [displayedPrimary] : [historyRequired];
  const optional = [
    ...(historyRequired === undefined ? [] : [{ kind: 'primary', text: displayedPrimary }]),
    ...(state.lifecycle === 'busy' ? [] : commandItem),
    ...(status.credential === undefined
      ? []
      : [{ kind: 'credential', text: safeDisplay(status.credential, false) }]),
    ...(status.details === undefined
      ? []
      : [{ kind: 'details', text: safeDisplay(status.details, false) }]),
    ...(pendingSegment === undefined
      ? []
      : [{ kind: 'pending', text: safeDisplay(pendingSegment, false) }]),
    ...(belowSegment === undefined
      ? []
      : [{ kind: 'below', text: safeDisplay(belowSegment, false) }]),
    ...(cancelSegment === undefined
      ? []
      : [{ kind: 'cancel', text: safeDisplay(cancelSegment, false) }]),
    ...(state.lifecycle === 'busy' ? commandItem : []),
  ];
  let segments = [...fixed, ...optional.map((segment) => segment.text)];
  while (
    segments.length > fixed.length &&
    width(renderSegments(segments)) > columns
  ) {
    const commandIndex = optional.findIndex((segment) => segment.kind === 'commands');
    if (commandIndex >= 0) {
      const withoutCommand = optional.filter((_, index) => index !== commandIndex);
      const shell = renderSegments([
        ...fixed,
        ...withoutCommand.map((segment) => segment.text),
        '',
      ]);
      const available = columns - width(shell);
      if (available >= width('cmds: …')) {
        optional[commandIndex] = {
          kind: 'commands',
          text: ellipsisCells(optional[commandIndex].text, available),
        };
      } else optional.splice(commandIndex, 1);
    } else {
      const nonCancel = optional.findLastIndex((segment) => segment.kind !== 'cancel');
      if (nonCancel >= 0) optional.splice(nonCancel, 1);
      else optional.pop();
    }
    segments = [...fixed, ...optional.map((segment) => segment.text)];
  }
  const text = truncateCells(renderSegments(segments), Math.max(1, columns));
  return { text };
};

const footerSessionText = (
  state: UiState,
  columns: number,
): string | undefined => {
  if (state.projection === undefined) return undefined;
  const workspace = safeDisplay(state.projection.workspace, false);
  const session = state.projection.sessionId?.slice(0, 8) ?? 'none';
  const title = safeDisplay(state.startup?.position.title ?? 'untitled', false);
  const fixed = ` session:${session} ${title}]`;
  const available = columns - width(`[${fixed}`);
  if (available >= 1) {
    return `[${suffixCells(workspace, available)}${fixed}`;
  }

  const withoutPath = `[session:${session} ${title}]`;
  if (width(withoutPath) <= columns) return withoutPath;

  const withoutTitle = `[session:${session}]`;
  if (width(withoutTitle) <= columns) return withoutTitle;
  return truncateCells(withoutTitle, columns);
};

const footerModelText = (
  state: UiState,
  columns: number,
): string | undefined => {
  const model = state.projection?.model;
  if (model === undefined) return undefined;
  const effort = safeDisplay(model.effort, false);
  const provider = safeDisplay(model.provider, false);
  const fullModel = safeDisplay(model.modelId, false);
  const full = `[provider:${provider} model:${fullModel} ${effort}]`;
  if (width(full) <= columns) return full;

  const compactFixed = `[provider:${provider} model: ${effort}]`;
  if (width(compactFixed) < columns) {
    const modelAvailable = columns - width(compactFixed);
    return `[provider:${provider} model:${suffixCells(fullModel, modelAvailable)} ${effort}]`;
  }

  const narrowFixed = `[${provider}  ${effort}]`;
  const modelAvailable = Math.max(1, columns - width(narrowFixed));
  return truncateCells(
    `[${provider} ${suffixCells(fullModel, modelAvailable)} ${effort}]`,
    columns,
  );
};

const wrap = (
  text: string,
  columns: number,
  kind: LayoutRow['kind'],
  entryId?: string,
  styledPrefix?: Readonly<{
    readonly scalarLength: number;
    readonly tone: ConversationLabelTone;
  }>,
  rowTone?: ConversationLabelTone,
): LayoutRow[] => {
  const result: LayoutRow[] = [];
  const points = [...text];
  const row = (line: string, sourceScalarOffset: number): LayoutRow => {
    const labelScalarLength = styledPrefix === undefined ? 0 : Math.max(
      0,
      Math.min([...line].length, styledPrefix.scalarLength - sourceScalarOffset),
    );
    return {
      text: line,
      kind,
      entryId,
      sourceScalarOffset,
      ...(rowTone === undefined ? {} : { rowTone }),
      ...(labelScalarLength === 0 ? {} : {
        labelScalarLength,
        labelTone: styledPrefix!.tone,
      }),
    };
  };
  if (points.length === 0) {
    return [row('', 0)];
  }
  let line = '';
  let lineOffset = 0;
  let sourceOffset = 0;
  for (const point of points) {
    const displayPoint = safeDisplay(point);
    if (point === '\n' || width(line + displayPoint) > columns) {
      result.push(row(line, lineOffset));
      lineOffset = sourceOffset;
      line = '';
      if (point === '\n') {
        sourceOffset += 1;
        lineOffset = sourceOffset;
        continue;
      }
    }
    line += displayPoint;
    sourceOffset += 1;
  }
  result.push(row(line, lineOffset));
  return result;
};

const logRows = (
  state: UiState,
  columns: number,
  assistantRenderer: AssistantContentRenderer,
): { rows: LayoutRow[]; sourceBytes: number } => {
  const result: LayoutRow[] = [];
  let sourceBytes = 0;
  // `/recall` needs the persisted Session history, so a `--no-session` TUI has no reference to
  // offer on its failure rows.
  const recallAvailable = state.startup?.state.sessionMode.kind !== 'none';
  const appendSeparator = (): void => {
    if (result.at(-1)?.kind !== 'separator') {
      result.push({ text: '', kind: 'separator' });
    }
  };
  const startupLines = state.startup === undefined || (state.historyWindow?.start ?? 0) > 0
    ? []
    : startupHeaderLines(
      state.startup.state,
      state.startup.position,
      columns,
      state.terminalSize.rows,
    );
  for (const line of startupLines) {
    const content = safeDisplay(line);
    sourceBytes += encoder.encode(content).byteLength;
    if (sourceBytes > MAX_LAYOUT_SOURCE_BYTES) break;
    result.push(...wrap(content, columns, 'log'));
  }
  if (state.log.omittedCount > 0) {
    result.push({
      text: `[${state.log.omittedCount} older entries omitted]`,
      kind: 'omitted',
    });
  }
  let seenTurnStart = false;
  const awaitingUserOutput = new Set<number>();
  let previousEntryKind: UiLogEntry['kind'] | undefined;
  const visibleEntries = state.historyWindow === undefined
    ? state.log.entries
    : state.log.entries.slice(state.historyWindow.start, state.historyWindow.end);
  for (const entry of visibleEntries) {
    const turnStart = entry.kind === 'user' && entry.label === 'user>';
    const userOutputBoundary = entry.turn !== undefined &&
      awaitingUserOutput.has(entry.turn) &&
      (entry.kind === 'tool' || entry.kind === 'assistant' || entry.kind === 'thinking');
    sourceBytes += encoder.encode(entry.text).byteLength;
    if (sourceBytes > MAX_LAYOUT_SOURCE_BYTES) break;
    const thinkingBoundary = previousEntryKind !== undefined &&
      (entry.kind === 'thinking' || previousEntryKind === 'thinking');
    if ((turnStart && seenTurnStart) || userOutputBoundary || thinkingBoundary) {
      appendSeparator();
    }
    if (entry.kind === 'assistant' || entry.kind === 'thinking') {
      const labelWidth = [...entry.label].length;
      const bodyWidth = Math.max(1, columns - labelWidth - 1);
      const renderer = entry.kind === 'thinking' ? thinkingBodyRenderer : assistantRenderer;
      const lines = renderer.render(
        entry.text,
        entry.live ? 'streaming' : 'settled',
        bodyWidth,
      );
      let sourceOffset = 0;
      lines.forEach((assistantLine, lineIndex) => {
        const prefix = lineIndex === 0 ? `${entry.label} ` : '';
        const shift = [...prefix].length;
        const body = entry.kind === 'thinking' ? assistantLine.text.trimEnd() : assistantLine.text;
        const text = safeDisplay(`${prefix}${body}`, false);
        const spans = assistantLine.spans
          .filter((span) => span.length > 0)
          .map((span) => ({ start: span.start + shift, length: span.length, tone: span.tone }));
        result.push({
          text,
          kind: 'log',
          entryId: entry.id,
          sourceScalarOffset: sourceOffset,
          ...(assistantLine.sourceLine === undefined ? {} : {
            sourceLine: assistantLine.sourceLine,
            sourceColumn: assistantLine.sourceColumn ?? 0,
          }),
          ...(lineIndex === 0
            ? { labelScalarLength: labelWidth, labelTone: 'assistant' as const }
            : {}),
          ...(spans.length === 0 ? {} : { spans }),
        });
        sourceOffset += [...text].length + 1;
      });
    } else {
      const projection = projectConversationEntry(entry, { recallAvailable });
      result.push(...wrap(
        projection.text,
        columns,
        'log',
        entry.id,
        projection.labelTone === undefined ? undefined : {
          scalarLength: projection.labelScalarLength,
          tone: projection.labelTone,
        },
        projection.rowTone,
      ));
    }
    if (turnStart && entry.turn !== undefined) {
      seenTurnStart = true;
      awaitingUserOutput.add(entry.turn);
    }
    if (userOutputBoundary && entry.turn !== undefined) {
      awaitingUserOutput.delete(entry.turn);
    }
    previousEntryKind = entry.kind;
  }
  return { rows: result, sourceBytes };
};

const overlayRows = (
  state: UiState,
  columns: number,
  rows: number,
): { rows: LayoutRow[]; headerRows: number; selectedRow: number } => {
  const overlay = state.overlay;
  if (overlay.kind === 'none') return { rows: [], headerRows: 0, selectedRow: -1 };
  const lines: string[] = [];
  if (overlay.kind === 'startupHelp') {
    lines.push(
      columns < 40 || rows < 16 ? 'F1 help · Esc return' : 'startup help · F1/Esc return',
    );
    lines.push(...(overlay.lines ?? []).slice(0, 12));
  } else if (overlay.kind === 'sessionPicker') {
    lines.push(
      `session picker · Up/Down select · Left/Right page · Enter resume · Esc cancel`,
      `page ${overlay.page + 1}${overlay.loading ? ' · loading' : ''}`,
    );
    const rows = overlay.listing?.sessions ?? [];
    const pageSize = 8;
    const start = overlay.page * pageSize;
    for (
      let index = 0;
      index < Math.min(pageSize, rows.length - start);
      index += 1
    ) {
      const row = rows[start + index];
      const selected = start + index === overlay.selected;
      const timestamp = localTimestampText(row.updatedAt);
      const title = row.title ?? 'untitled';
      const availability = row.current ? 'current' : row.mismatch ? 'revision change' : 'resumable';
      lines.push(
        truncateCells(
          `${selected ? '>' : ' '} ${timestamp}  ${safeDisplay(title, false)} · ${
            row.id.slice(0, 8)
          } · ${row.turnCount} turns · ${availability}`,
          columns,
        ),
      );
    }
    if (rows.length === 0 && !overlay.loading) lines.push('no sessions');
  } else if (overlay.kind === 'choicePicker') {
    lines.push(...overlay.lines);
  } else if (overlay.kind === 'compaction') {
    lines.push('context recovery · read-only');
    const preview = overlay.preview;
    if (preview === undefined) lines.push('loading context preview');
    else {
      lines.push(`committed turns ${preview.currentTurn}`);
      lines.push(
        preview.proposed === undefined
          ? 'no useful fitting compaction'
          : `proposed through turn ${preview.proposed.coveredThroughTurn}, retain ${preview.proposed.retainedFromTurn}+`,
      );
      lines.push(
        'Enter confirm one provider request · v view summary · Esc cancel',
      );
    }
  }
  const result: LayoutRow[] = [];
  let headerRows = 0;
  let selectedRow = -1;
  const selectedLine = overlay.kind === 'sessionPicker'
    ? 2 + overlay.selected - overlay.page * 8
    : -1;
  for (const [index, line] of lines.slice(0, 32).entries()) {
    if (overlay.kind === 'sessionPicker' && index === 2) headerRows = result.length;
    if (index === selectedLine) selectedRow = result.length;
    result.push(...wrap(line, columns, 'log'));
  }
  if (overlay.kind === 'sessionPicker' && lines.length <= 2) headerRows = result.length;
  return { rows: result, headerRows, selectedRow };
};

const inputRows = (
  snapshot: EditorSnapshot,
  columns: number,
  maxRows: number,
): { rows: LayoutRow[]; cursorRow: number; cursorCell: number } => {
  const points = [...snapshot.text];
  const cursor = clamp(snapshot.cursorScalar, 0, points.length);
  const all: { text: string; offset: number; cursor?: number }[] = [];
  let text = '';
  let offset = 0;
  let cursorRow = 0;
  let cursorCell = 0;
  const push = (): void => {
    all.push({ text, offset });
    text = '';
  };
  for (let index = 0; index <= points.length; index += 1) {
    if (index === cursor) {
      cursorRow = all.length;
      cursorCell = width(text);
    }
    if (index === points.length) {
      push();
      break;
    }
    const point = points[index];
    const displayPoint = safeDisplay(point);
    if (point === '\n' || width(text + displayPoint) > columns) {
      push();
      if (point === '\n') {
        offset = index + 1;
        continue;
      }
    }
    text += displayPoint;
    offset = index;
  }
  const first = Math.max(
    0,
    Math.min(cursorRow - maxRows + 1, all.length - maxRows),
  );
  const visible = all.slice(first, first + maxRows).map((row) => ({
    text: row.text,
    kind: 'input' as const,
  }));
  return { rows: visible, cursorRow: cursorRow - first, cursorCell };
};

/** Pure retained-screen layout. It only reads immutable UI state and a bounded terminal size. */
export const layoutUi = (
  state: UiState,
  columns = state.terminalSize.columns,
  rows = state.terminalSize.rows,
  assistantRenderer: AssistantContentRenderer = plainTextAssistantRenderer,
): UiLayout => {
  const widthLimit = clamp(columns, 1, MAX_COLUMNS);
  const heightLimit = clamp(rows, 1, MAX_ROWS);
  const degraded = widthLimit < MIN_COLUMNS || heightLimit < MIN_ROWS;
  const sessionFooter = footerSessionText(state, Math.max(1, widthLimit));
  const modelFooter = footerModelText(state, Math.max(1, widthLimit));
  const identityRows = (sessionFooter === undefined ? 0 : 1) +
    (modelFooter === undefined ? 0 : 1);
  const standardHeight = heightLimit >= MIN_ROWS;
  const beforeInputCount = standardHeight ? 1 : 0;
  const afterInputCount = standardHeight ? 1 : 0;
  const footerCount = standardHeight
    ? 1 + identityRows
    : heightLimit >= 5
    ? 1 + identityRows
    : heightLimit >= 3
    ? 1 + Math.min(identityRows, 1)
    : heightLimit === 2
    ? 1
    : 0;
  const maxInput = standardHeight
    ? Math.min(
      MAX_EDITOR_ROWS,
      Math.max(
        1,
        heightLimit - beforeInputCount - afterInputCount - footerCount - 1,
      ),
    )
    : 1;
  // Reserve one cell after the prompt for the cursor. Without this cell, a full-width final
  // character leaves the hardware cursor on that character rather than at the insertion point.
  const editor = inputRows(state.editor, Math.max(1, widthLimit - 3), maxInput);
  const logHeight = Math.max(
    0,
    heightLimit - editor.rows.length - beforeInputCount - afterInputCount -
      footerCount,
  );
  const log = logRows(state, Math.max(1, widthLimit), assistantRenderer);
  const overlay = overlayRows(state, Math.max(1, widthLimit), heightLimit);
  let logStart = Math.max(0, log.rows.length - logHeight);
  if (state.scroll.kind === 'oldest') {
    logStart = 0;
  } else if (state.scroll.kind === 'anchored') {
    const anchor = state.scroll.entryId;
    const sourceOffset = state.scroll.sourceScalarOffset;
    const anchored = log.rows.findIndex((row) =>
      row.entryId === anchor &&
      (row.sourceScalarOffset ?? 0) >= sourceOffset
    );
    if (anchored >= 0) logStart = anchored;
  }
  const overlayStart = state.overlay.kind === 'startupHelp'
    ? 0
    : Math.max(0, overlay.rows.length - logHeight);
  const visibleOverlay = state.overlay.kind === 'sessionPicker' &&
      overlay.selectedRow >= 0 && overlay.rows.length > logHeight && logHeight > 0
    ? (() => {
      const headerCount = Math.min(overlay.headerRows, Math.max(0, logHeight - 1));
      const bodyHeight = logHeight - headerCount;
      const body = overlay.rows.slice(overlay.headerRows);
      const selected = overlay.selectedRow - overlay.headerRows;
      const start = clamp(
        selected - Math.floor(bodyHeight / 2),
        0,
        Math.max(0, body.length - bodyHeight),
      );
      return [
        ...overlay.rows.slice(0, headerCount),
        ...body.slice(start, start + bodyHeight),
      ];
    })()
    : overlay.rows.slice(overlayStart, overlayStart + logHeight);
  const visibleLog = overlay.rows.length > 0
    ? visibleOverlay
    : log.rows.slice(logStart, logStart + logHeight);
  const paddedLog = [...visibleLog];
  while (paddedLog.length < logHeight) {
    paddedLog.unshift({ text: '', kind: 'log' });
  }
  const history = state.scroll.kind !== 'followLatest' && state.overlay.kind === 'none'
    ? {
      first: Math.min(log.rows.length, logStart + 1),
      last: Math.min(log.rows.length, logStart + logHeight),
      total: log.rows.length,
    }
    : undefined;
  const statusFooter = footerStatusText(state, Math.max(1, widthLimit), history);
  const footer = [
    {
      ...statusFooter,
      kind: 'footer' as const,
    },
    ...(sessionFooter === undefined ? [] : [{ text: sessionFooter, kind: 'footer' as const }]),
    ...(modelFooter === undefined ? [] : [{ text: modelFooter, kind: 'footer' as const }]),
  ].slice(0, footerCount);
  const beforeInput = Array.from(
    { length: beforeInputCount },
    () => ({ text: '', kind: 'separator' as const }),
  );
  const afterInput = Array.from(
    { length: afterInputCount },
    () => ({ text: '', kind: 'separator' as const }),
  );
  return Object.freeze({
    columns: widthLimit,
    rows: heightLimit,
    degraded,
    log: Object.freeze(paddedLog),
    allLog: Object.freeze(log.rows),
    logStart,
    totalLogRows: log.rows.length,
    overlay: Object.freeze(overlay.rows),
    beforeInput: Object.freeze(beforeInput),
    input: Object.freeze(editor.rows),
    afterInput: Object.freeze(afterInput),
    footer: Object.freeze(footer.map((row) => Object.freeze(row))),
    cursor: Object.freeze({
      row: logHeight + beforeInput.length + editor.cursorRow,
      cell: Math.min(widthLimit, editor.cursorCell + 2),
    }),
    sourceBytes: Math.min(MAX_LAYOUT_SOURCE_BYTES, log.sourceBytes),
  });
};

export type { UiLogEntry };
