import { type ConversationView, ConversationViewport } from './conversation_viewport.ts';
import { type EditorSnapshot } from './input.ts';
import { uiConversationCount, uiConversationIndexOf, type UiState } from './state.ts';
import { type AssistantSpan, type ConversationLabelTone } from './conversation_renderer.ts';
import {
  cellWidth,
  localTimestampText,
  segmentTerminalText,
  truncateTerminalCells,
  truncateTerminalCellsFromEnd,
} from './terminal_text.ts';

const MIN_COLUMNS = 80;
const MIN_ROWS = 24;
const MAX_COLUMNS = 512;
const MAX_ROWS = 200;
const MAX_EDITOR_ROWS = 8;
export const MAX_FRAME_BYTES = 128 * 1024;

export type FooterTone = 'dim' | 'ready' | 'working';

interface FooterSpan {
  readonly start: number;
  readonly length: number;
  readonly tone: FooterTone;
}

export interface LayoutRow {
  readonly text: string;
  readonly entryId?: string;
  readonly sourceUtf16Offset?: number;
  readonly labelScalarLength?: number;
  readonly labelTone?: ConversationLabelTone;
  /** Whole-row tone; the renderer applies it to the entire row text. */
  readonly rowTone?: ConversationLabelTone;
  readonly spans?: readonly AssistantSpan[];
  readonly footerSpans?: readonly FooterSpan[];
  readonly blinkScalarStart?: number;
  readonly blinkScalarLength?: number;
  readonly kind: 'log' | 'input' | 'footer' | 'omitted' | 'separator';
}

export interface UiLayout {
  readonly columns: number;
  readonly rows: number;
  readonly degraded: boolean;
  readonly log: readonly LayoutRow[];
  readonly viewport?: ConversationView;
  readonly overlay: readonly LayoutRow[];
  readonly beforeInput: readonly LayoutRow[];
  readonly input: readonly LayoutRow[];
  readonly afterInput: readonly LayoutRow[];
  readonly footer: readonly LayoutRow[];
  readonly cursor: { readonly row: number; readonly cell: number };
}

const clamp = (value: number, min: number, max: number): number =>
  Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : min;
const width = (text: string): number => cellWidth(safeDisplay(text));
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
  return truncateTerminalCells(safeDisplay(text), columns);
};
const suffixCells = (text: string, columns: number): string => {
  if (width(text) <= columns) return text;
  if (columns <= 0) return '';
  const marker = '…';
  const markerWidth = width(marker);
  if (columns <= markerWidth) return marker;
  return `${marker}${truncateTerminalCellsFromEnd(safeDisplay(text), columns - markerWidth)}`;
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
): {
  readonly primary: string;
  readonly credential?: string;
  readonly details?: string;
} => {
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
    const credential = parts.slice(index + 1).find((part) => part.startsWith('credential '));
    const inlineDetails = segment.slice(activePrimary.length).replace(
      /^[ ;]+/,
      '',
    );
    const details = [inlineDetails, ...parts.slice(index + 1)].filter((part) =>
      part.length > 0 && part !== credential
    )
      .join(' · ');
    return {
      primary: activePrimary,
      ...(credential === undefined ? {} : { credential }),
      ...(details.length === 0 ? {} : { details }),
    };
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

const remoteFooterControls = (status: string): readonly string[] => {
  const known = new Set([
    'Enter submit',
    'F1 cancel',
    'F2 queue',
    'F3 steer',
    'F4 sessions',
    'Ctrl-C clear',
    'Ctrl-D detach',
    'Ctrl-Q shutdown',
    'cancellation unavailable',
    '/detach',
  ]);
  return status.split(' · ').filter((part) => known.has(part));
};

const remoteExecutionResult = (status: string): readonly string[] => {
  const known = new Set([
    'completed',
    'cancelled',
    'failed',
    'interrupted',
    'unknown',
    'canonical',
    'non-canonical',
    'settlement running',
    'settlement settling',
    'settlement complete',
    'settlement unknown',
  ]);
  return status.split(' · ').filter((part) => known.has(part));
};

type HistoryViewport =
  | { readonly kind: 'start' }
  | {
    readonly kind: 'entry';
    readonly entry: number;
    readonly totalEntries: number;
  };

const historyViewport = (
  state: UiState,
  view: ConversationView,
): HistoryViewport => {
  if (view.atStart) return { kind: 'start' };
  const entryId = view.cursors.find((cursor) => cursor.entryId !== '@startup')?.entryId;
  const entryIndex = entryId === undefined ? -1 : uiConversationIndexOf(state, entryId);
  return entryIndex < 0 ? { kind: 'start' } : {
    kind: 'entry',
    entry: entryIndex + 1,
    totalEntries: uiConversationCount(state),
  };
};

const footerPrimaryText = (state: UiState, columns: number): string => {
  const primary = safeDisplay(
    state.footer?.activity ?? footerStatusParts(footerStatus(state)).primary,
    false,
  );
  const running = state.footer === undefined
    ? state.lifecycle === 'busy' || state.lifecycle === 'cancelling'
    : state.footer.activity === 'working' || state.footer.activity === 'cancelling';
  const elapsed = running && state.busyElapsedSeconds !== undefined &&
      (primary === 'working' || primary === 'busy' || primary === 'cancelling')
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
  const spinner = running &&
      (primary === 'working' || primary === 'busy' || primary === 'cancelling')
    ? BUSY_SPINNER_FRAMES[
      (state.busySpinnerFrame ?? 0) % BUSY_SPINNER_FRAMES.length
    ]
    : undefined;
  const label = primary === 'busy' ? 'working' : primary === 'ready' ? '● ready' : primary;
  const withElapsed = elapsed === undefined ? label : `${label} ${elapsed}`;
  const full = spinner === undefined ? withElapsed : `${spinner} ${withElapsed}`;
  return width(full) <= columns ? full : width(withElapsed) <= columns ? withElapsed : label;
};

const footerStatusText = (
  state: UiState,
  columns: number,
  history?: HistoryViewport,
  primaryInSession = false,
): Readonly<{
  readonly text: string;
  readonly blinkScalarStart?: number;
  readonly blinkScalarLength?: number;
}> => {
  const renderSegments = (segments: readonly string[]): string => segments.join(' · ');
  if (state.overlay.kind === 'slashPicker') {
    return {
      text: truncateCells('↑/↓ select · Enter complete · Esc close', columns),
    };
  }
  if (state.overlay.kind === 'readOnlyHelp') {
    return { text: truncateCells('PageUp/Down scroll · Esc close', columns) };
  }
  if (state.footer !== undefined) {
    const overlay = state.overlay;
    const controls = overlay.kind === 'sessionPicker'
      ? overlay.loading ? ['loading Sessions', 'Esc close'] : [
        '↑/↓ select',
        '←/→ page',
        `Enter ${overlay.actionMode ?? 'view'}`,
        'R resume',
        'D delete',
        'Esc close',
      ]
      : overlay.kind === 'sessionDeleteConfirm'
      ? overlay.deleting ? ['deleting Session'] : ['y delete', 'n/Esc return']
      : overlay.kind === 'choicePicker'
      ? overlay.controls ?? ['Esc close']
      : state.footer.controls;
    const historySegments = history === undefined ? [] : [
      history.kind === 'start'
        ? 'history start'
        : `history ${history.entry}/${history.totalEntries}`,
      ...(state.newBelowCount > 0 ? [`new ${state.newBelowCount}`] : []),
      'Esc latest',
    ];
    const segments = [
      ...historySegments,
      ...(state.footer.hint === undefined || overlay.kind !== 'none'
        ? []
        : [safeDisplay(state.footer.hint, false)]),
      ...controls,
    ];
    while (
      segments.length > Math.max(1, historySegments.length) &&
      width(renderSegments(segments)) > columns
    ) {
      segments.pop();
    }
    return { text: truncateCells(renderSegments(segments), columns) };
  }
  // The editor draft is already visible in the input band. Keep the uncommitted input lanes
  // available in the footer, but do not repeat its byte count as internal status.
  const pending = state.pending?.lanes.filter((lane) => lane.present && lane.kind !== 'editor') ??
    [];
  const pendingSegment = pending.length === 0
    ? undefined
    : `pending ${pending.map((lane) => `${lane.kind}:${lane.byteCount}B`).join(',')}`;
  const belowSegment = state.newBelowCount > 0 ? `new below ${state.newBelowCount}` : undefined;
  const status = footerStatusParts(footerStatus(state));
  const statusControls = remoteFooterControls(state.status);
  const remoteControls = statusControls;
  const remoteResult = remoteExecutionResult(state.status);
  const displayedPrimary = footerPrimaryText(state, columns);
  const commandSegment = state.slashCommandCandidates.length === 0
    ? undefined
    : `cmds: ${state.slashCommandCandidates.join(', ')}`;
  const cancelSegment = state.lifecycle === 'busy' && remoteControls.length === 0
    ? 'F1 cancel'
    : undefined;
  const historyHint = 'Esc latest';
  const historyFull = history === undefined
    ? undefined
    : history.kind === 'start'
    ? `history start · ${historyHint}`
    : `history record ${history.entry} of ${history.totalEntries} · ${historyHint}`;
  const historyRequired = historyFull === undefined
    ? undefined
    : width(historyFull) <= columns
    ? historyFull
    : `history · ${historyHint}`;
  const resultText = remoteResult.length === 0 ? undefined : safeDisplay(
    remoteResult.filter((part) => part !== status.primary).join(' · '),
    false,
  );
  const controlSet = new Set(statusControls);
  const resultSet = new Set(remoteResult);
  const details = status.details?.split(' · ').filter((part) =>
    !controlSet.has(part) && !resultSet.has(part)
  ).join(' · ');
  const fixed = [
    ...(historyRequired === undefined ? [] : [historyRequired]),
    ...(primaryInSession
      ? details === undefined || details.length === 0 ? [] : [safeDisplay(details, false)]
      : historyRequired === undefined
      ? [displayedPrimary]
      : []),
    ...(commandSegment === undefined ? [] : [safeDisplay(commandSegment, false)]),
  ];
  const optional = [
    ...(historyRequired === undefined || primaryInSession
      ? []
      : [{ kind: 'primary', text: displayedPrimary }]),
    ...(status.credential === undefined
      ? []
      : [{ kind: 'credential', text: safeDisplay(status.credential, false) }]),
    ...(primaryInSession || details === undefined || details.length === 0
      ? []
      : [{ kind: 'details', text: safeDisplay(details, false) }]),
    ...(pendingSegment === undefined
      ? []
      : [{ kind: 'pending', text: safeDisplay(pendingSegment, false) }]),
    ...(belowSegment === undefined
      ? []
      : [{ kind: 'below', text: safeDisplay(belowSegment, false) }]),
    ...(cancelSegment === undefined
      ? []
      : [{ kind: 'cancel', text: safeDisplay(cancelSegment, false) }]),
    ...(resultText === undefined || resultText.length === 0
      ? []
      : [{ kind: 'remote-result', text: resultText }]),
    ...remoteControls.map((text) => ({
      kind: 'remote-controls',
      text: safeDisplay(text, false),
    })),
  ];
  let segments = [...fixed, ...optional.map((segment) => segment.text)];
  while (
    segments.length > fixed.length &&
    width(renderSegments(segments)) > columns
  ) {
    const nonPriority = optional.findLastIndex((segment) =>
      segment.kind !== 'cancel' && segment.kind !== 'remote-result' &&
      segment.kind !== 'remote-controls'
    );
    if (nonPriority >= 0) optional.splice(nonPriority, 1);
    else optional.pop();
    segments = [...fixed, ...optional.map((segment) => segment.text)];
  }
  const text = truncateCells(renderSegments(segments), Math.max(1, columns));
  return { text };
};

interface FooterPiece {
  readonly text: string;
  readonly tone?: FooterTone;
}

/** Footer widths use visible cells; style ranges use Unicode scalar offsets. */
const footerRow = (pieces: readonly FooterPiece[], columns: number): LayoutRow => {
  const text = truncateCells(` ${pieces.map((piece) => piece.text).join('')}`, columns);
  const points = [...text].length;
  const footerSpans: FooterSpan[] = [];
  let start = 1;
  for (const piece of pieces) {
    const length = Math.min([...piece.text].length, Math.max(0, points - start));
    if (piece.tone !== undefined && length > 0) {
      footerSpans.push({ start, length, tone: piece.tone });
    }
    start += [...piece.text].length;
  }
  return { text, footerSpans, kind: 'footer' };
};

const footerContentColumns = (columns: number): number => Math.max(0, columns - 2);
const pieceWidth = (pieces: readonly FooterPiece[]): number =>
  pieces.reduce((total, piece) => total + width(piece.text), 0);
const footerGroups = (
  left: readonly FooterPiece[],
  right: readonly FooterPiece[],
  columns: number,
): LayoutRow =>
  footerRow([
    ...left,
    {
      text: ' '.repeat(
        Math.max(3, footerContentColumns(columns) - pieceWidth(left) - pieceWidth(right)),
      ),
    },
    ...right,
  ], columns);

const footerControlsRow = (text: string, columns: number): LayoutRow => {
  const pieces: FooterPiece[] = [];
  for (const [index, segment] of text.split(' · ').entries()) {
    if (index > 0) pieces.push({ text: ' · ', tone: 'dim' });
    const key = segment.match(
      /^(?:Enter|Esc|Tab|Alt-Enter|Shift-Enter|Ctrl-[A-Za-z]|F[1-3]|PageUp\/Down|↑\/↓|←\/→|R|\/)(?= |$)/,
    )?.[0];
    if (key !== undefined) {
      pieces.push({ text: key }, { text: segment.slice(key.length), tone: 'dim' });
    } else {
      const tone = segment.startsWith('● ready')
        ? 'ready'
        : /^(?:. )?(?:working|cancelling)(?: |$)/u.test(segment)
        ? 'working'
        : 'dim';
      pieces.push({ text: segment, tone });
    }
  }
  return footerRow(pieces, columns);
};

const footerSessionText = (
  state: UiState,
  columns: number,
): LayoutRow | undefined => {
  if (state.projection === undefined) return undefined;
  const workspace = safeDisplay(state.projection.workspace, false);
  const session = state.projection.sessionId?.slice(0, 8) ?? 'none';
  const title = safeDisplay(
    state.position?.title ?? state.startup?.position.title ?? 'untitled',
    false,
  );
  const primary = footerStatusParts(footerStatus(state)).primary;
  const active = state.footer !== undefined ||
    ((state.lifecycle === 'busy' || state.lifecycle === 'cancelling') &&
      (primary === 'busy' || primary === 'cancelling'));
  const activity = state.footer?.activity ?? primary;
  const status: FooterPiece[] = active
    ? [{
      text: footerPrimaryText(state, footerContentColumns(columns)),
      tone: activity === 'ready'
        ? 'ready'
        : activity === 'working' || activity === 'busy' || activity === 'cancelling'
        ? 'working'
        : undefined,
    }]
    : [];
  const right: FooterPiece[] = [
    { text: title },
    { text: ` · ${session}`, tone: 'dim' },
  ];
  const opening = active ? [...status, { text: '   ' }] : [];
  const available = footerContentColumns(columns) - pieceWidth(opening) - pieceWidth(right) - 3;
  if (available >= 1) {
    return footerGroups(
      [
        ...opening,
        { text: suffixCells(workspace, available), tone: 'dim' },
      ],
      right,
      columns,
    );
  }
  if (pieceWidth(status) + pieceWidth(right) + (active ? 3 : 0) <= footerContentColumns(columns)) {
    return active ? footerGroups(status, right, columns) : footerRow(right, columns);
  }
  const id: FooterPiece[] = [{ text: session, tone: 'dim' }];
  if (pieceWidth(status) + pieceWidth(id) + (active ? 3 : 0) <= footerContentColumns(columns)) {
    return active ? footerGroups(status, id, columns) : footerRow(id, columns);
  }
  return footerRow(active ? status : id, columns);
};

const footerModelText = (
  state: UiState,
  columns: number,
): LayoutRow | undefined => {
  const model = state.projection?.model;
  if (model === undefined) return undefined;
  const effort: FooterPiece[] = [{ text: safeDisplay(model.effort, false), tone: 'dim' }];
  const provider: FooterPiece[] = [{
    text: `${safeDisplay(model.provider, false)} / `,
    tone: 'dim',
  }];
  const modelAvailable = Math.max(
    1,
    footerContentColumns(columns) - pieceWidth(provider) - pieceWidth(effort) - 3,
  );
  return footerGroups(
    [
      ...provider,
      { text: suffixCells(safeDisplay(model.modelId, false), modelAvailable) },
    ],
    effort,
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
  const row = (line: string, sourceUtf16Offset: number): LayoutRow => {
    const labelScalarLength = styledPrefix === undefined ? 0 : Math.max(
      0,
      Math.min(
        [...line].length,
        styledPrefix.scalarLength - sourceUtf16Offset,
      ),
    );
    return {
      text: line,
      kind,
      entryId,
      sourceUtf16Offset,
      ...(rowTone === undefined ? {} : { rowTone }),
      ...(labelScalarLength === 0 ? {} : {
        labelScalarLength,
        labelTone: styledPrefix!.tone,
      }),
    };
  };
  const segments = segmentTerminalText(text);
  if (segments.length === 0) {
    return [row('', 0)];
  }
  let line = '';
  let lineOffset = 0;
  let sourceOffset = 0;
  let used = 0;
  for (const segment of segments) {
    const displayText = safeDisplay(segment.text);
    const displayWidth = cellWidth(displayText);
    if (segment.text === '\n' || (used > 0 && used + displayWidth > columns)) {
      result.push(row(line, lineOffset));
      line = '';
      used = 0;
      lineOffset = segment.scalarStart;
      if (segment.text === '\n') {
        sourceOffset = segment.scalarEnd;
        lineOffset = sourceOffset;
        continue;
      }
    }
    line += displayText;
    used += displayWidth;
    sourceOffset = segment.scalarEnd;
  }
  result.push(row(line, lineOffset));
  return result;
};

const overlayRows = (
  state: UiState,
  columns: number,
  rows: number,
): { rows: LayoutRow[]; headerRows: number; selectedRow: number } => {
  const overlay = state.overlay;
  if (overlay.kind === 'none') {
    return { rows: [], headerRows: 0, selectedRow: -1 };
  }
  const lines: string[] = [];
  if (overlay.kind === 'startupHelp') {
    lines.push(
      columns < 40 || rows < 16 ? '/help · Esc return' : 'startup help · /help or Esc return',
    );
    lines.push(...(overlay.lines ?? []).slice(0, 12));
  } else if (overlay.kind === 'readOnlyHelp') {
    lines.push('help · PageUp/Down scroll · Esc return');
    lines.push(...overlay.lines);
  } else if (overlay.kind === 'slashPicker') {
    const selected = overlay.candidates[overlay.selected];
    lines.push(
      'slash commands · ↑/↓ select · Enter complete · Esc close',
      selected === undefined
        ? 'no matching commands'
        : `usage: ${selected.usage} │ ${selected.shortcut ?? 'none'}`,
      selected?.description ?? '',
    );
    for (const [index, definition] of overlay.candidates.entries()) {
      lines.push(truncateCells(
        `${index === overlay.selected ? '>' : ' '} ${definition.text} · ${definition.description}`,
        columns,
      ));
    }
  } else if (overlay.kind === 'sessionPicker') {
    const pickerControls = overlay.actionMode === 'view'
      ? 'Enter view · R resume · D delete · Esc return'
      : 'Enter resume · D delete · Esc cancel';
    lines.push(
      `session picker · Up/Down select · Left/Right page · ${pickerControls}`,
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
  } else if (overlay.kind === 'sessionDeleteConfirm') {
    const row = overlay.picker.listing?.sessions[overlay.picker.selected];
    lines.push(
      overlay.deleting ? 'deleting Session…' : 'Delete Session? · y delete · n/Esc return',
      safeDisplay(row?.title ?? 'untitled', false),
      row?.id ?? '',
      'Session and related history will be deleted.',
      ...(overlay.message === undefined ? [] : [safeDisplay(overlay.message, false)]),
    );
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
  const listPicker = overlay.kind === 'sessionPicker' ||
    overlay.kind === 'slashPicker';
  const headerLines = overlay.kind === 'sessionPicker' ? 2 : 3;
  const selectedLine = overlay.kind === 'sessionPicker'
    ? 2 + overlay.selected - overlay.page * 8
    : overlay.kind === 'slashPicker'
    ? 3 + overlay.selected
    : -1;
  const displayedLines = overlay.kind === 'readOnlyHelp' || overlay.kind === 'slashPicker'
    ? lines
    : lines.slice(0, 32);
  for (const [index, line] of displayedLines.entries()) {
    if (listPicker && index === headerLines) {
      headerRows = result.length;
    }
    if (index === selectedLine) selectedRow = result.length;
    result.push(...wrap(line, columns, 'log'));
  }
  if (listPicker && lines.length <= headerLines) {
    headerRows = result.length;
  }
  return { rows: result, headerRows, selectedRow };
};

const inputRows = (
  snapshot: EditorSnapshot,
  columns: number,
  maxRows: number,
): { rows: LayoutRow[]; cursorRow: number; cursorCell: number } => {
  const segments = segmentTerminalText(snapshot.text);
  const scalarLength = segments.at(-1)?.scalarEnd ?? 0;
  const cursor = clamp(snapshot.cursorScalar, 0, scalarLength);
  const all: { text: string; offset: number; cursor?: number }[] = [];
  let text = '';
  let used = 0;
  let offset = 0;
  let cursorRow = 0;
  let cursorCell = 0;
  let cursorSet = false;
  const push = (): void => {
    all.push({ text, offset });
    text = '';
    used = 0;
  };
  for (const segment of segments) {
    if (segment.text === '\n') {
      if (
        !cursorSet && cursor >= segment.scalarStart &&
        cursor < segment.scalarEnd
      ) {
        cursorRow = all.length;
        cursorCell = used;
        cursorSet = true;
      }
      push();
      offset = segment.scalarEnd;
      if (!cursorSet && cursor === segment.scalarEnd) {
        cursorRow = all.length;
        cursorCell = 0;
        cursorSet = true;
      }
      continue;
    }
    const displayText = safeDisplay(segment.text, false);
    const displayWidth = cellWidth(displayText);
    if (text.length > 0 && used + displayWidth > columns) {
      push();
      offset = segment.scalarStart;
    }
    if (
      !cursorSet && cursor >= segment.scalarStart && cursor < segment.scalarEnd
    ) {
      cursorRow = all.length;
      cursorCell = used;
      cursorSet = true;
    }
    text += displayText;
    used += displayWidth;
    offset = segment.scalarEnd;
  }
  if (!cursorSet) {
    cursorRow = all.length;
    cursorCell = used;
  }
  push();
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

/** Screen geometry from editor/footer state, without reading conversation bodies. */
export const measureUi = (
  state: UiState,
  columns = state.terminalSize.columns,
  rows = state.terminalSize.rows,
) => {
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
  return {
    widthLimit,
    heightLimit,
    degraded,
    sessionFooter,
    modelFooter,
    beforeInputCount,
    afterInputCount,
    footerCount,
    editor,
    logHeight,
  };
};

/** Layout the selected conversation range inside measured screen geometry. */
export const layoutUi = (
  state: UiState,
  columns = state.terminalSize.columns,
  rows = state.terminalSize.rows,
  conversation = new ConversationViewport(),
): UiLayout => {
  const {
    widthLimit,
    heightLimit,
    degraded,
    sessionFooter,
    modelFooter,
    beforeInputCount,
    afterInputCount,
    footerCount,
    editor,
    logHeight,
  } = measureUi(state, columns, rows);
  const overlay = overlayRows(state, Math.max(1, widthLimit), heightLimit);
  const overlayStart = state.overlay.kind === 'startupHelp' ||
      state.overlay.kind === 'readOnlyHelp'
    ? 0
    : Math.max(0, overlay.rows.length - logHeight);
  const visibleOverlay = state.overlay.kind === 'readOnlyHelp' && logHeight > 0
    ? [
      ...overlay.rows.slice(0, 1),
      ...overlay.rows.slice(
        1 +
          clamp(
            state.overlay.offset ?? 0,
            0,
            Math.max(0, overlay.rows.length - logHeight),
          ),
        1 +
          clamp(
            state.overlay.offset ?? 0,
            0,
            Math.max(0, overlay.rows.length - logHeight),
          ) + logHeight - 1,
      ),
    ]
    : (state.overlay.kind === 'sessionPicker' ||
        state.overlay.kind === 'slashPicker') &&
        overlay.selectedRow >= 0 && overlay.rows.length > logHeight &&
        logHeight > 0
    ? (() => {
      const headerCount = Math.min(
        overlay.headerRows,
        Math.max(0, logHeight - 1),
      );
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
  const view = overlay.rows.length > 0
    ? undefined
    : conversation.view(state, widthLimit, logHeight, heightLimit);
  const visibleLog = view === undefined ? visibleOverlay : view.rows;
  const paddedLog = [...visibleLog];
  while (paddedLog.length < logHeight) {
    paddedLog.unshift({ text: '', kind: 'log' });
  }
  const history = state.scroll.kind !== 'followLatest' && view !== undefined
    ? historyViewport(state, view)
    : undefined;
  const statusFooter = footerStatusText(
    state,
    Math.max(1, footerContentColumns(widthLimit)),
    history,
    sessionFooter !== undefined && footerCount >= 2 &&
      (state.lifecycle === 'busy' || state.lifecycle === 'cancelling') &&
      ['busy', 'cancelling'].includes(
        footerStatusParts(footerStatus(state)).primary,
      ),
  );
  const footer = [
    footerControlsRow(statusFooter.text, widthLimit),
    ...(sessionFooter === undefined ? [] : [sessionFooter]),
    ...(modelFooter === undefined ? [] : [modelFooter]),
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
    viewport: view,
    overlay: Object.freeze(overlay.rows),
    beforeInput: Object.freeze(beforeInput),
    input: Object.freeze(editor.rows),
    afterInput: Object.freeze(afterInput),
    footer: Object.freeze(footer.map((row) => Object.freeze(row))),
    cursor: Object.freeze({
      row: logHeight + beforeInput.length + editor.cursorRow,
      cell: Math.min(widthLimit, editor.cursorCell + 2),
    }),
  });
};

export type { UiLogEntry } from './state.ts';
