import { type EditorSnapshot } from './input.ts';
import { type UiLogEntry, type UiState } from './state.ts';
import {
  type AssistantContentRenderer,
  type ConversationLabelTone,
  plainTextAssistantRenderer,
  projectConversationEntry,
} from './conversation_renderer.ts';

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
  readonly labelScalarLength?: number;
  readonly labelTone?: ConversationLabelTone;
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
const isFullwidthForm = (code: number): boolean =>
  (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);
const cellWidth = (character: string): number => {
  const code = character.codePointAt(0)!;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x1ab0 && code <= 0x1aff)) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0x1f300 && code <= 0x1faff) || isFullwidthForm(code)
  ) return 2;
  return 1;
};
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

const footerStatusParts = (
  status: string,
): { readonly primary: string; readonly details?: string } => {
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
  const details = parts.slice(index + 1).join(' · ');
  return details.length === 0
    ? { primary: parts[index] ?? status }
    : { primary: parts[index] ?? status, details };
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
): string => {
  // The editor draft is already visible in the input band. Keep active/recovery lanes available
  // in the footer, but do not repeat its byte count as internal status in the normal footer.
  const pending = state.pending?.lanes.filter((lane) => lane.present && lane.kind !== 'editor') ??
    [];
  const pendingSegment = pending.length === 0
    ? undefined
    : `pending ${pending.map((lane) => `${lane.kind}:${lane.byteCount}B`).join(',')}`;
  const belowSegment = state.newBelowCount > 0 ? `new below ${state.newBelowCount}` : undefined;
  const identity = state.projection === undefined ? undefined : `agent ${state.projection.agentId}`;
  const session = state.projection?.sessionId === undefined
    ? undefined
    : `session ${state.projection.sessionId.slice(0, 8)} · turn ${state.projection.committedTurn}`;
  const status = footerStatusParts(footerStatus(state));
  const primary = safeDisplay(status.primary, false);
  const safeSession = session === undefined ? undefined : safeDisplay(session, false);
  const historyFull = history === undefined
    ? undefined
    : `history rows ${history.first}-${history.last}/${history.total} · Esc latest`;
  const historyRequired = historyFull === undefined
    ? undefined
    : width(`[${historyFull}]`) <= columns
    ? historyFull
    : 'history · Esc latest';
  const fixed: string[] = historyRequired === undefined ? [primary] : [historyRequired];
  const optional = [
    ...(historyRequired === undefined ? [] : [primary]),
    safeSession,
    status.details,
    identity,
    pendingSegment,
    belowSegment,
  ]
    .filter(
      (segment): segment is string => segment !== undefined && segment.length > 0,
    ).map((segment) => safeDisplay(segment, false));
  if (historyRequired === undefined && safeSession !== undefined) {
    const candidate = `[${[...fixed, safeSession].join(' · ')}]`;
    if (width(candidate) <= columns) {
      fixed.push(safeSession);
      optional.splice(optional.indexOf(safeSession), 1);
    }
  }
  const segments = [...fixed, ...optional];
  while (
    segments.length > fixed.length &&
    width(`[${segments.join(' · ')}]`) > columns
  ) {
    segments.pop();
  }
  return truncateCells(`[${segments.join(' · ')}]`, Math.max(1, columns));
};

const footerWorkspaceText = (
  state: UiState,
  columns: number,
): string | undefined => {
  if (state.projection === undefined) return undefined;
  const workspace = safeDisplay(state.projection.workspace, false);
  const available = Math.max(1, columns - width('[cwd ]'));
  return truncateCells(
    `[cwd ${suffixCells(workspace, available)}]`,
    Math.max(1, columns),
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
  const appendSeparator = (): void => {
    if (result.at(-1)?.kind !== 'separator') {
      result.push({ text: '', kind: 'separator' });
    }
  };
  for (const line of state.startup.slice(0, 2)) {
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
  for (const entry of state.log.entries) {
    const turnStart = entry.kind === 'user' && entry.label === 'user>';
    const userOutputBoundary = entry.turn !== undefined &&
      awaitingUserOutput.has(entry.turn) &&
      (entry.kind === 'tool' || entry.kind === 'assistant');
    const projection = projectConversationEntry(entry, assistantRenderer);
    const content = projection.text;
    sourceBytes += encoder.encode(content).byteLength;
    if (sourceBytes > MAX_LAYOUT_SOURCE_BYTES) break;
    if ((turnStart && seenTurnStart) || userOutputBoundary) appendSeparator();
    result.push(...wrap(
      content,
      columns,
      'log',
      entry.id,
      projection.labelTone === undefined ? undefined : {
        scalarLength: projection.labelScalarLength,
        tone: projection.labelTone,
      },
    ));
    if (turnStart && entry.turn !== undefined) {
      seenTurnStart = true;
      awaitingUserOutput.add(entry.turn);
    }
    if (userOutputBoundary && entry.turn !== undefined) {
      awaitingUserOutput.delete(entry.turn);
    }
  }
  return { rows: result, sourceBytes };
};

const overlayRows = (
  state: UiState,
  columns: number,
  rows: number,
): LayoutRow[] => {
  const overlay = state.overlay;
  if (overlay.kind === 'none') return [];
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
      const model = row.modelSelection === undefined
        ? 'legacy model'
        : `${row.modelSelection.modelId} effort:${row.modelSelection.effort}`;
      lines.push(
        `${
          start + index === overlay.selected ? '>' : ' '
        } ${row.id} ${row.agent} t${row.turnCount}/m${row.messageCount} ${model}`,
      );
    }
    if (rows.length === 0 && !overlay.loading) lines.push('no sessions');
  } else if (overlay.kind === 'choicePicker') {
    lines.push(...overlay.lines);
  } else if (overlay.kind === 'history') {
    const page = overlay.page;
    lines.push(
      'history · read-only · Up/Down page · Home oldest · End latest · Esc return',
    );
    if (page === undefined) lines.push('history loading');
    else {
      lines.push(
        `turn ${page.turn}/${page.totalTurns} · page ${page.page + 1}/${page.pageCount}`,
      );
      for (const entry of page.entries.slice(0, 16)) {
        lines.push(`${entry.role} [t${entry.turn}] ${entry.text}`);
      }
      if (page.omitted) lines.push('history> page content bounded');
    }
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
  for (const line of lines.slice(0, 32)) {
    result.push(...wrap(line, columns, 'log'));
  }
  return result;
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
  const workspaceFooter = footerWorkspaceText(state, Math.max(1, widthLimit));
  const standardHeight = heightLimit >= MIN_ROWS;
  const beforeInputCount = standardHeight ? 1 : 0;
  const afterInputCount = standardHeight ? 1 : 0;
  const footerCount = standardHeight
    ? (workspaceFooter === undefined ? 1 : 2)
    : heightLimit >= 3
    ? (workspaceFooter === undefined ? 1 : 2)
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
  if (state.scroll.kind === 'anchored') {
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
    : Math.max(0, overlay.length - logHeight);
  const visibleLog = (overlay.length > 0 ? overlay : log.rows).slice(
    overlay.length > 0 ? overlayStart : logStart,
    (overlay.length > 0 ? overlayStart : logStart) + logHeight,
  );
  const paddedLog = [...visibleLog];
  while (paddedLog.length < logHeight) {
    paddedLog.unshift({ text: '', kind: 'log' });
  }
  const history = state.scroll.kind === 'anchored' && state.overlay.kind === 'none'
    ? {
      first: Math.min(log.rows.length, logStart + 1),
      last: Math.min(log.rows.length, logStart + logHeight),
      total: log.rows.length,
    }
    : undefined;
  const footer = [
    {
      text: footerStatusText(state, Math.max(1, widthLimit), history),
      kind: 'footer' as const,
    },
    ...(workspaceFooter === undefined ? [] : [{ text: workspaceFooter, kind: 'footer' as const }]),
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
    overlay: Object.freeze(overlay),
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

export const layoutMainScreen = layoutUi;
export type { UiLogEntry };
