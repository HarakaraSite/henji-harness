import { cellWidth, escapeTerminalText } from './terminal_text.ts';
import type { AssistantSpan } from './conversation_renderer.ts';

export interface BodyCursor {
  readonly block: number;
  readonly row: number;
}

export interface BodyRow {
  /** Terminal-safe text. Span coordinates refer to this projected text. */
  readonly text: string;
  readonly spans: readonly AssistantSpan[];
  /** UTF-16 offset in the unmodified body represented by this row. */
  readonly sourceUtf16Offset: number;
}

type Mode = 'plain' | 'markdown';

interface WrapLayout {
  /** Relative UTF-16 source starts and ends for rows whose boundaries have been measured. */
  readonly boundaries: number[];
  readonly ends: number[];
  nextSource: number;
  complete: boolean;
}

interface SourceLine {
  start: number;
  end: number;
  readonly id: number;
  version: number;
  readonly wraps: Map<string, WrapLayout>;
  readonly inlineRanges: Map<string, readonly InlineRange[]>;
}

interface InlineRange {
  readonly start: number;
  readonly end: number;
  readonly tone: AssistantSpan['tone'];
}

interface CellRange {
  readonly start: number;
  readonly end: number;
}

type TableAlign = 'left' | 'center' | 'right';

interface TableContext {
  readonly key: string;
  readonly lines: readonly SourceLine[];
  readonly header: readonly CellRange[];
  readonly aligns: readonly TableAlign[];
  readonly rows: readonly (readonly CellRange[])[];
  naturalWidths?: readonly number[];
  readonly layouts: Map<number, readonly number[] | undefined>;
}

interface FenceContext {
  readonly lineId: number;
  readonly indent: string;
  readonly marker: string;
}

interface PlainBlock {
  readonly kind: 'plain';
  readonly line: SourceLine;
}

interface FixedBlock {
  readonly kind: 'fixed';
  readonly line: SourceLine;
  readonly fixedKind:
    | 'blank'
    | 'rule'
    | 'fenceOpen'
    | 'fenceClose'
    | 'tableSeparator';
  readonly output?: string;
  readonly groupStartId?: number;
  readonly tableContext?: TableContext;
  readonly fenceContext?: FenceContext;
}

interface WrappedBlock {
  readonly kind: 'wrapped';
  readonly line: SourceLine;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly firstPrefix: string;
  readonly continuationPrefix: string;
  readonly prefixTone?: AssistantSpan['tone'];
  readonly prefixToneStart?: number;
  readonly prefixToneLength?: number;
  readonly wholeRowTone?: AssistantSpan['tone'];
  readonly wordAware: boolean;
  readonly inline: boolean;
  readonly groupStartId?: number;
  readonly fenceContext?: FenceContext;
}

interface TableBlock {
  readonly kind: 'table';
  readonly context: TableContext;
  /** Header is zero, separator is one, and data rows begin at two. */
  readonly rowIndex: number;
  readonly line: SourceLine;
  readonly groupStartId: number;
}

type Block = PlainBlock | FixedBlock | WrappedBlock | TableBlock;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const isMark = /\p{Mark}/u;
const isEmojiModifier = /[\u{1f3fb}-\u{1f3ff}]/u;
const isEmojiTag = /[\u{e0020}-\u{e007f}]/u;
const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^(\s*)>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

let nextLineId = 0;

const scalarLength = (text: string): number => [...text].length;
const scalarCellWidth = (code: number): number =>
  (code >= 0x1100 && code <= 0x115f) || (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
    ? 2
    : 1;

const escapedScalarWidth = (code: number): number => {
  if (code === 0x09) return 1;
  if (
    code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  ) return Math.max(4, code.toString(16).length) + 4;
  return scalarCellWidth(code);
};

const potentiallyJoined = (code: number): boolean =>
  code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0xe0100 && code <= 0xe01ef) ||
  (code >= 0x1f1e6 && code <= 0x1f1ff) ||
  (code >= 0x1100 && code <= 0x11ff) || (code >= 0xa960 && code <= 0xa97f) ||
  (code >= 0xd7b0 && code <= 0xd7ff) || code === 0x0600 || code === 0x0601 ||
  code === 0x0602 || code === 0x0603 || code === 0x0604 || code === 0x0605 ||
  code === 0x06dd || code === 0x070f || (code >= 0x0890 && code <= 0x0891) ||
  code === 0x08e2;

interface ProjectedSegment {
  readonly end: number;
  readonly width: number;
}

/** Measures one grapheme with terminal_text's escaping and cell-width contract. */
const projectedSegmentAt = (
  text: string,
  offset: number,
  end: number,
): ProjectedSegment => {
  const code = text.codePointAt(offset)!;
  const scalarLengthUtf16 = code > 0xffff ? 2 : 1;
  const nextOffset = offset + scalarLengthUtf16;
  const nextCode = nextOffset < end ? text.codePointAt(nextOffset)! : -1;
  const current = String.fromCodePoint(code);
  const needsSegmenter = potentiallyJoined(code) || isMark.test(current) ||
    isEmojiModifier.test(current) ||
    isEmojiTag.test(current) || (nextCode >= 0 && (
      potentiallyJoined(nextCode) ||
      isMark.test(String.fromCodePoint(nextCode)) ||
      isEmojiModifier.test(String.fromCodePoint(nextCode)) ||
      isEmojiTag.test(String.fromCodePoint(nextCode))
    ));
  if (!needsSegmenter) {
    return { end: nextOffset, width: escapedScalarWidth(code) };
  }
  const rest = text.slice(offset, end);
  const first = segmenter.segment(rest)[Symbol.iterator]().next().value;
  if (first === undefined) return { end, width: 0 };
  return {
    end: offset + first.segment.length,
    width: cellWidth(escapeTerminalText(first.segment)),
  };
};

const escapedWidth = (text: string): number => {
  let width = 0;
  for (let offset = 0; offset < text.length;) {
    const part = projectedSegmentAt(text, offset, text.length);
    width += part.width;
    offset = part.end;
  }
  return width;
};
const spaces = (count: number): string => ' '.repeat(Math.max(0, count));
const lineText = (text: string, line: SourceLine): string => text.slice(line.start, line.end);

const scanLines = (text: string): SourceLine[] => {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines.push({
        start,
        end: index,
        id: ++nextLineId,
        version: 0,
        wraps: new Map(),
        inlineRanges: new Map(),
      });
      start = index + 1;
    }
  }
  lines.push({
    start,
    end: text.length,
    id: ++nextLineId,
    version: 0,
    wraps: new Map(),
    inlineRanges: new Map(),
  });
  return lines;
};

/** Reuse width-independent line caches for text-identical prefix and suffix lines. */
interface ReusedLines {
  readonly lines: SourceLine[];
  readonly prefixCount: number;
  readonly suffixNewStart: number;
}

const sourceLine = (start: number, end: number): SourceLine => ({
  start,
  end,
  id: ++nextLineId,
  version: 0,
  wraps: new Map(),
  inlineRanges: new Map(),
});

const appendedLines = (
  oldText: string,
  oldLines: readonly SourceLine[],
  newText: string,
): ReusedLines => {
  const lines = [...oldLines];
  const last = oldLines[oldLines.length - 1];
  const prefixCount = Math.max(0, oldLines.length - 1);
  let tailStart: number;
  if (oldText.length === 0 || oldText.endsWith('\n')) {
    lines.pop();
    tailStart = oldText.length;
  } else {
    const newline = newText.indexOf('\n', oldText.length);
    const lastEnd = newline < 0 ? newText.length : newline;
    retargetAppendedLine(last, last.end - last.start, lastEnd - last.start);
    last.end = lastEnd;
    if (newline < 0) {
      return { lines, prefixCount, suffixNewStart: lines.length };
    }
    tailStart = newline + 1;
  }

  let lineStart = tailStart;
  for (let index = tailStart; index < newText.length; index += 1) {
    if (newText.charCodeAt(index) === 10) {
      lines.push(sourceLine(lineStart, index));
      lineStart = index + 1;
    }
  }
  lines.push(sourceLine(lineStart, newText.length));
  return { lines, prefixCount, suffixNewStart: prefixCount };
};

const retargetAppendedLine = (
  line: SourceLine,
  oldLength: number,
  newLength: number,
): void => {
  if (oldLength <= 0 || newLength <= oldLength) return;
  const moved = new Map<string, WrapLayout>();
  for (const [key, layout] of line.wraps) {
    const match = /^(\d+):(\d+):(\d+):([wh])$/.exec(key);
    if (match === null || Number(match[2]) !== oldLength) continue;
    if (layout.complete && layout.ends.length > 0) {
      layout.nextSource = layout.boundaries.pop() ?? 0;
      layout.ends.pop();
    }
    layout.complete = false;
    moved.set(`${match[1]}:${newLength}:${match[3]}:${match[4]}`, layout);
    line.wraps.delete(key);
  }
  for (const [key, layout] of moved) line.wraps.set(key, layout);
  line.inlineRanges.clear();
  line.version += 1;
};

const reuseLines = (
  oldText: string,
  oldLines: readonly SourceLine[],
  newText: string,
): ReusedLines => {
  if (newText.startsWith(oldText)) {
    return appendedLines(oldText, oldLines, newText);
  }
  const newLines = scanLines(newText);
  let prefix = 0;
  while (
    prefix < oldLines.length && prefix < newLines.length &&
    lineText(oldText, oldLines[prefix]) === lineText(newText, newLines[prefix])
  ) {
    prefix += 1;
  }

  let oldIndex = oldLines.length - 1;
  let newIndex = newLines.length - 1;
  const suffix: [number, number][] = [];
  while (
    oldIndex >= prefix && newIndex >= prefix &&
    lineText(oldText, oldLines[oldIndex]) ===
      lineText(newText, newLines[newIndex])
  ) {
    suffix.push([oldIndex, newIndex]);
    oldIndex -= 1;
    newIndex -= 1;
  }

  for (let index = 0; index < prefix; index += 1) {
    const old = oldLines[index];
    old.start = newLines[index].start;
    old.end = newLines[index].end;
    newLines[index] = old;
  }
  for (const [oldLineIndex, newLineIndex] of suffix) {
    const old = oldLines[oldLineIndex];
    old.start = newLines[newLineIndex].start;
    old.end = newLines[newLineIndex].end;
    newLines[newLineIndex] = old;
  }

  return { lines: newLines, prefixCount: prefix, suffixNewStart: newIndex + 1 };
};

const splitCells = (source: string): string[] =>
  source.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());

const isSeparatorRow = (source: string): boolean => {
  const row = splitCells(source);
  return row.length > 0 && row.every((cell) => /^:?-+:?$/.test(cell));
};

const parseAligns = (source: string): TableAlign[] =>
  splitCells(source).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });

const cellRanges = (raw: string): CellRange[] => {
  const start = raw.startsWith('|') ? 1 : 0;
  const end = raw.endsWith('|') ? raw.length - 1 : raw.length;
  const result: CellRange[] = [];
  let cellStart = start;
  for (let index = start; index <= end; index += 1) {
    if (index === end || raw[index] === '|') {
      let left = cellStart;
      let right = index;
      while (left < right && /\s/u.test(raw[left])) left += 1;
      while (right > left && /\s/u.test(raw[right - 1])) right -= 1;
      result.push({ start: left, end: right });
      cellStart = index + 1;
    }
  }
  return result;
};

const tableKey = (lines: readonly SourceLine[]): string =>
  lines.map((line) => `${line.id}.${line.version}`).join(',');

const inlineRanges = (
  text: string,
  line: SourceLine,
  start: number,
  end: number,
): readonly InlineRange[] => {
  const key = `${start}:${end}`;
  const existing = line.inlineRanges.get(key);
  if (existing !== undefined) return existing;
  const source = text.slice(line.start + start, line.start + end);
  const result: InlineRange[] = [];
  const patterns: readonly [RegExp, AssistantSpan['tone']][] = [
    [/\*\*\*([^*]+)\*\*\*/g, 'emphasis'],
    [/(?<!\*)\*\*(?!\*)([^*]+)\*\*/g, 'emphasis'],
    [/(?<!\*)\*(?!\*)([^*]+)\*/g, 'emphasis'],
  ];
  for (const [pattern, tone] of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      result.push({
        start: start + match.index,
        end: start + match.index + match[0].length,
        tone,
      });
    }
  }
  const sorted = result.sort((left, right) => left.start - right.start || left.end - right.end);
  const frozen = Object.freeze(sorted);
  line.inlineRanges.set(key, frozen);
  return frozen;
};

const nextHardBoundary = (
  source: string,
  sourceStart: number,
  sourceEnd: number,
  lineStart: number,
  width: number,
): number => {
  if (sourceStart >= sourceEnd) return sourceEnd;
  let used = 0;
  let end = sourceStart;
  let position = lineStart + sourceStart;
  const absoluteEnd = lineStart + sourceEnd;
  while (position < absoluteEnd) {
    const part = projectedSegmentAt(source, position, absoluteEnd);
    if (used > 0 && used + part.width > width) return position - lineStart;
    used += part.width;
    end = part.end - lineStart;
    position = part.end;
  }
  return end;
};

interface WrapSlice {
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

interface RunMeasurement {
  readonly end: number;
  readonly width: number;
  readonly complete: boolean;
}

const scanRun = (
  source: string,
  lineStart: number,
  runStart: number,
  sourceEnd: number,
  whitespace: boolean,
  maxWidth: number,
): RunMeasurement => {
  let end = runStart;
  let used = 0;
  let position = lineStart + runStart;
  const absoluteEnd = lineStart + sourceEnd;
  while (position < absoluteEnd) {
    const part = projectedSegmentAt(source, position, absoluteEnd);
    const isWhitespace = /^\s+$/u.test(source.slice(position, part.end));
    if (isWhitespace !== whitespace) {
      return { end, width: used, complete: true };
    }
    const size = part.width;
    if (used + size > maxWidth) return { end, width: used, complete: false };
    used += size;
    end = part.end - lineStart;
    position = part.end;
  }
  return { end, width: used, complete: true };
};

const nextWordSlice = (
  source: string,
  nextSource: number,
  sourceEnd: number,
  lineStart: number,
  width: number,
): WrapSlice => {
  if (nextSource >= sourceEnd) {
    return { start: sourceEnd, end: sourceEnd, next: sourceEnd };
  }
  let rowStart = nextSource;
  const leading = scanRun(
    source,
    lineStart,
    rowStart,
    sourceEnd,
    true,
    Number.POSITIVE_INFINITY,
  );
  if (leading.end > rowStart) rowStart = leading.end;
  if (rowStart >= sourceEnd) {
    return { start: sourceEnd, end: sourceEnd, next: sourceEnd };
  }

  const firstToken = scanRun(
    source,
    lineStart,
    rowStart,
    sourceEnd,
    false,
    width,
  );
  if (!firstToken.complete) {
    if (firstToken.end > rowStart) {
      return { start: rowStart, end: firstToken.end, next: firstToken.end };
    }
    // A grapheme wider than the available body cells still advances alone.
    const first = projectedSegmentAt(
      source,
      lineStart + rowStart,
      lineStart + sourceEnd,
    );
    const end = first.end - lineStart;
    return { start: rowStart, end, next: end };
  }
  if (firstToken.end === rowStart) {
    const first = projectedSegmentAt(
      source,
      lineStart + rowStart,
      lineStart + sourceEnd,
    );
    const end = first.end - lineStart;
    return { start: rowStart, end, next: end };
  }
  let used = firstToken.width;
  let position = firstToken.end;
  while (position < sourceEnd) {
    const whitespace = scanRun(
      source,
      lineStart,
      position,
      sourceEnd,
      true,
      Number.POSITIVE_INFINITY,
    );
    if (whitespace.end === position) {
      return { start: rowStart, end: position, next: position };
    }
    if (whitespace.end >= sourceEnd) {
      if (used + whitespace.width <= width) {
        return { start: rowStart, end: whitespace.end, next: whitespace.end };
      }
      return { start: rowStart, end: position, next: whitespace.end };
    }
    const nextToken = scanRun(
      source,
      lineStart,
      whitespace.end,
      sourceEnd,
      false,
      Math.max(0, width - used - whitespace.width),
    );
    if (!nextToken.complete) {
      return { start: rowStart, end: position, next: whitespace.end };
    }
    if (nextToken.end === whitespace.end) {
      return { start: rowStart, end: position, next: whitespace.end };
    }
    used += whitespace.width + nextToken.width;
    position = nextToken.end;
  }
  return { start: rowStart, end: position, next: position };
};

const getWrapLayout = (
  line: SourceLine,
  sourceStart: number,
  sourceEnd: number,
  width: number,
  wordAware: boolean,
): WrapLayout => {
  const key = `${sourceStart}:${sourceEnd}:${Math.max(1, width)}:${wordAware ? 'w' : 'h'}`;
  let layout = line.wraps.get(key);
  if (layout === undefined) {
    layout = {
      boundaries: [],
      ends: [],
      nextSource: sourceStart,
      complete: false,
    };
    line.wraps.set(key, layout);
  }
  return layout;
};

const ensureWrapRow = (
  source: string,
  line: SourceLine,
  layout: WrapLayout,
  sourceStart: number,
  sourceEnd: number,
  width: number,
  wordAware: boolean,
  row: number,
): boolean => {
  const limit = Math.max(1, width);
  while (!layout.complete && layout.ends.length <= row) {
    const start = layout.nextSource;
    if (sourceStart === sourceEnd) {
      layout.boundaries.push(sourceStart);
      layout.ends.push(sourceEnd);
      layout.complete = true;
      break;
    }
    const slice = wordAware ? nextWordSlice(source, start, sourceEnd, line.start, limit) : (() => {
      const end = nextHardBoundary(
        source,
        start,
        sourceEnd,
        line.start,
        limit,
      );
      return { start, end, next: end };
    })();
    if (slice.next <= start) {
      layout.boundaries.push(start);
      layout.ends.push(sourceEnd);
      layout.nextSource = sourceEnd;
      layout.complete = true;
      break;
    }
    layout.boundaries.push(slice.start);
    layout.ends.push(slice.end);
    layout.nextSource = slice.next;
    if (slice.next >= sourceEnd) layout.complete = true;
  }
  return row < layout.ends.length;
};

const ensureAllWrapRows = (
  source: string,
  line: SourceLine,
  layout: WrapLayout,
  sourceStart: number,
  sourceEnd: number,
  width: number,
  wordAware: boolean,
): number => {
  while (!layout.complete) {
    ensureWrapRow(
      source,
      line,
      layout,
      sourceStart,
      sourceEnd,
      width,
      wordAware,
      layout.ends.length,
    );
  }
  return Math.max(1, layout.ends.length);
};

const trimEnd = (text: string, start: number, end: number): number => {
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return end;
};

const buildTableContext = (
  source: string,
  headerLine: SourceLine,
  separatorLine: SourceLine,
  dataLines: readonly SourceLine[],
  oldContexts: ReadonlyMap<string, TableContext>,
): TableContext => {
  const allLines = [headerLine, separatorLine, ...dataLines];
  const key = tableKey(allLines);
  const cached = oldContexts.get(key);
  if (cached !== undefined) return cached;
  const headerText = lineText(source, headerLine);
  const separatorText = lineText(source, separatorLine);
  const header = cellRanges(headerText);
  const rows = dataLines.map((line) => cellRanges(lineText(source, line)));
  return {
    key,
    lines: allLines,
    header,
    aligns: parseAligns(separatorText),
    rows,
    layouts: new Map(),
  };
};

const oldTableContexts = (
  blocks: readonly Block[],
): Map<string, TableContext> => {
  const contexts = new Map<string, TableContext>();
  for (const block of blocks) {
    if (block.kind === 'table') {
      contexts.set(block.context.key, block.context);
    }
  }
  return contexts;
};

const markdownRestartLine = (
  oldLines: readonly SourceLine[],
  oldBlocks: readonly Block[],
  prefixCount: number,
): number => {
  let restart = Math.max(0, prefixCount - 1);
  const indexById = new Map(oldLines.map((line, index) => [line.id, index]));
  const relevant = new Set<number>();
  if (prefixCount < oldLines.length) relevant.add(prefixCount);
  if (prefixCount > 0) relevant.add(prefixCount - 1);
  for (const lineIndex of relevant) {
    const line = oldLines[lineIndex];
    const block = oldBlocks.find((candidate) => candidate.line === line);
    if (block === undefined) continue;
    if (block.kind === 'table') {
      const groupLine = indexById.get(block.groupStartId);
      if (groupLine !== undefined) restart = Math.min(restart, groupLine);
    } else if (block.kind === 'fixed' || block.kind === 'wrapped') {
      if (block.groupStartId !== undefined) {
        const groupLine = indexById.get(block.groupStartId);
        if (groupLine !== undefined) restart = Math.min(restart, groupLine);
      }
    }
  }
  return restart;
};

const tableContextFor = (block: Block | undefined): TableContext | undefined =>
  block?.kind === 'table'
    ? block.context
    : block?.kind === 'fixed'
    ? block.tableContext
    : undefined;

const fenceContextAfter = (block: Block | undefined): FenceContext | undefined =>
  block?.kind === 'wrapped'
    ? block.fenceContext
    : block?.kind === 'fixed' && block.fixedKind === 'fenceOpen'
    ? block.fenceContext
    : undefined;

const lineIndexAtStart = (
  lines: readonly SourceLine[],
  start: number,
): number => {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].start < start) low = middle + 1;
    else if (lines[middle].start > start) high = middle - 1;
    else return middle;
  }
  return Math.max(0, Math.min(lines.length - 1, low));
};

interface AppendMarkdownPlan {
  readonly restart: number;
  readonly fenceContext?: FenceContext;
  readonly tableContexts: ReadonlyMap<string, TableContext>;
}

/** Append parsing starts at the changed tail and carries only its boundary context. */
const appendMarkdownPlan = (
  source: string,
  priorLines: readonly SourceLine[],
  priorBlocks: readonly Block[],
  nextLines: readonly SourceLine[],
  prefixCount: number,
): AppendMarkdownPlan => {
  let restart = Math.min(prefixCount, nextLines.length - 1);
  const changed = priorBlocks[restart];
  const previous = restart > 0 ? priorBlocks[restart - 1] : undefined;
  let tableContext = tableContextFor(changed);
  const previousTable = tableContextFor(previous);
  const firstSuffix = nextLines[restart];
  if (tableContext === undefined && previousTable !== undefined) {
    const candidate = lineText(source, firstSuffix);
    if (candidate.includes('|') && candidate.trim().length > 0) {
      tableContext = previousTable;
    }
  }
  if (tableContext !== undefined) {
    restart = lineIndexAtStart(priorLines, tableContext.lines[0].start);
    return {
      restart,
      tableContexts: new Map([[tableContext.key, tableContext]]),
    };
  }

  const fenceContext = fenceContextAfter(previous);
  if (fenceContext === undefined && previous !== undefined) {
    const previousText = lineText(source, nextLines[restart - 1]);
    const candidate = lineText(source, firstSuffix);
    if (previousText.includes('|') && isSeparatorRow(candidate)) restart -= 1;
  }
  return { restart, fenceContext, tableContexts: new Map() };
};

const parseMarkdown = (
  source: string,
  lines: readonly SourceLine[],
  oldContexts: ReadonlyMap<string, TableContext>,
  initialFence?: FenceContext,
): Block[] => {
  const blocks: Block[] = [];
  let index = 0;
  let currentFence = initialFence;
  while (index < lines.length) {
    const line = lines[index];
    const raw = lineText(source, line);
    if (currentFence !== undefined) {
      const close = CLOSE_FENCE.exec(raw);
      if (
        close !== null && close[2][0] === currentFence.marker[0] &&
        close[2].length >= currentFence.marker.length
      ) {
        blocks.push({
          kind: 'fixed',
          line,
          fixedKind: 'fenceClose',
          output: `${close[1]}${close[2]}`,
          groupStartId: currentFence.lineId,
        });
        currentFence = undefined;
      } else {
        blocks.push({
          kind: 'wrapped',
          line,
          sourceStart: 0,
          sourceEnd: raw.length,
          firstPrefix: '',
          continuationPrefix: '',
          wordAware: false,
          inline: false,
          groupStartId: currentFence.lineId,
          fenceContext: currentFence,
        });
      }
      index += 1;
      continue;
    }

    const fence = FENCE.exec(raw);
    if (fence !== null) {
      currentFence = { lineId: line.id, indent: fence[1], marker: fence[2] };
      blocks.push({
        kind: 'fixed',
        line,
        fixedKind: 'fenceOpen',
        output: `${fence[1]}${fence[2]}${fence[3].trimEnd()}`,
        groupStartId: line.id,
        fenceContext: currentFence,
      });
      index += 1;
      continue;
    }

    if (
      raw.includes('|') && index + 1 < lines.length &&
      isSeparatorRow(lineText(source, lines[index + 1]))
    ) {
      const start = index;
      const dataLines: SourceLine[] = [];
      index += 2;
      while (
        index < lines.length && lineText(source, lines[index]).includes('|') &&
        lineText(source, lines[index]).trim().length > 0
      ) {
        dataLines.push(lines[index]);
        index += 1;
      }
      const context = buildTableContext(
        source,
        lines[start],
        lines[start + 1],
        dataLines,
        oldContexts,
      );
      blocks.push({
        kind: 'table',
        context,
        rowIndex: 0,
        line: lines[start],
        groupStartId: lines[start].id,
      });
      blocks.push({
        kind: 'fixed',
        line: lines[start + 1],
        fixedKind: 'tableSeparator',
        groupStartId: lines[start].id,
        tableContext: context,
      });
      dataLines.forEach((dataLine, rowIndex) => {
        blocks.push({
          kind: 'table',
          context,
          rowIndex: rowIndex + 2,
          line: dataLine,
          groupStartId: lines[start].id,
        });
      });
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading !== null) {
      const prefix = `${heading[1]} `;
      const sourceStart = heading[1].length + 1;
      blocks.push({
        kind: 'wrapped',
        line,
        sourceStart,
        sourceEnd: trimEnd(raw, sourceStart, raw.length),
        firstPrefix: prefix,
        continuationPrefix: spaces(escapedWidth(prefix)),
        wholeRowTone: 'heading',
        wordAware: true,
        inline: false,
      });
      index += 1;
      continue;
    }

    if (RULE.test(raw)) {
      blocks.push({ kind: 'fixed', line, fixedKind: 'rule' });
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(raw);
    if (quote !== null) {
      const sourceStart = quote[1].length + 1 +
        (raw[quote[1].length + 1] === ' ' ? 1 : 0);
      const prefix = `${quote[1]}> `;
      blocks.push({
        kind: 'wrapped',
        line,
        sourceStart,
        sourceEnd: trimEnd(raw, sourceStart, raw.length),
        firstPrefix: prefix,
        continuationPrefix: `${quote[1]}  `,
        prefixTone: 'quote',
        prefixToneStart: scalarLength(quote[1]),
        prefixToneLength: 1,
        wordAware: true,
        inline: true,
      });
      index += 1;
      continue;
    }

    const list = LIST.exec(raw);
    if (list !== null) {
      const prefix = `${list[1]}${list[2]} `;
      blocks.push({
        kind: 'wrapped',
        line,
        sourceStart: list[1].length + list[2].length + 1,
        sourceEnd: trimEnd(
          raw,
          list[1].length + list[2].length + 1,
          raw.length,
        ),
        firstPrefix: prefix,
        continuationPrefix: spaces(escapedWidth(prefix)),
        prefixTone: 'list',
        prefixToneStart: scalarLength(list[1]),
        prefixToneLength: scalarLength(list[2]),
        wordAware: true,
        inline: true,
      });
      index += 1;
      continue;
    }

    if (raw.trim().length === 0) {
      blocks.push({ kind: 'fixed', line, fixedKind: 'blank' });
    } else {
      blocks.push({
        kind: 'wrapped',
        line,
        sourceStart: 0,
        sourceEnd: raw.length,
        firstPrefix: '',
        continuationPrefix: '',
        wordAware: true,
        inline: true,
      });
    }
    index += 1;
  }
  return blocks;
};

const lineWrap = (
  block: WrappedBlock | PlainBlock,
  width: number,
): {
  readonly layout: WrapLayout;
  readonly start: number;
  readonly end: number;
  readonly wrapWidth: number;
  readonly wordAware: boolean;
} => {
  if (block.kind === 'plain') {
    return {
      layout: getWrapLayout(
        block.line,
        0,
        block.line.end - block.line.start,
        width,
        false,
      ),
      start: 0,
      end: block.line.end - block.line.start,
      wrapWidth: width,
      wordAware: false,
    };
  }
  const prefixes = wrappedPrefixes(block, width);
  const prefixWidth = Math.max(
    escapedWidth(prefixes.first),
    escapedWidth(prefixes.continuation),
  );
  const wrapWidth = Math.max(1, width - prefixWidth);
  return {
    layout: getWrapLayout(
      block.line,
      block.sourceStart,
      block.sourceEnd,
      wrapWidth,
      block.wordAware,
    ),
    start: block.sourceStart,
    end: block.sourceEnd,
    wrapWidth,
    wordAware: block.wordAware,
  };
};

interface WrappedPrefixes {
  readonly first: string;
  readonly continuation: string;
}

const prefixWithin = (prefix: string, maxWidth: number): string => {
  if (escapedWidth(prefix) <= maxWidth) return prefix;
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return spaces(Math.min(prefix.length, maxWidth));
  return escapedWidth(trimmed) <= maxWidth ? trimmed : '';
};

const shortenPrefixByCells = (prefix: string, maxWidth: number): string => {
  let result = '';
  let used = 0;
  for (let offset = 0; offset < prefix.length;) {
    const part = projectedSegmentAt(prefix, offset, prefix.length);
    if (used + part.width > maxWidth) break;
    result += prefix.slice(offset, part.end);
    used += part.width;
    offset = part.end;
  }
  return result;
};

const tableRecordLabel = (header: string, width: number): string => {
  const label = `${header}: `;
  const bodyMinimum = Math.min(2, Math.max(1, width));
  const budget = Math.max(0, width - bodyMinimum);
  if (escapedWidth(label) <= budget) return label;
  return prefixWithin(label, budget) || shortenPrefixByCells(label, budget);
};

const tableRecordCellWidth = (header: string, width: number): number =>
  Math.max(1, width - escapedWidth(tableRecordLabel(header, width)));

const wrappedPrefixes = (block: WrappedBlock, width: number): WrappedPrefixes => {
  // Reserve room for a two-cell grapheme whenever the terminal can display one.
  const bodyMinimum = Math.min(2, Math.max(1, width));
  const prefixBudget = Math.max(0, width - bodyMinimum);
  return {
    first: prefixWithin(block.firstPrefix, prefixBudget),
    continuation: prefixWithin(block.continuationPrefix, prefixBudget),
  };
};

const prefixToneRange = (
  block: WrappedBlock,
  projectedPrefix: string,
): { readonly start: number; readonly length: number } | undefined => {
  if (block.prefixTone === undefined) return undefined;
  const marker = [...block.firstPrefix].slice(
    block.prefixToneStart ?? 0,
    (block.prefixToneStart ?? 0) + (block.prefixToneLength ?? 1),
  ).join('');
  if (marker.length === 0) return undefined;
  const index = projectedPrefix.indexOf(marker);
  if (index < 0) return undefined;
  return {
    start: scalarLength(escapeTerminalText(projectedPrefix.slice(0, index))),
    length: scalarLength(escapeTerminalText(marker)),
  };
};

const tableWidths = (
  source: string,
  context: TableContext,
  width: number,
): readonly number[] | undefined => {
  const cacheKey = Math.max(1, width);
  if (context.layouts.has(cacheKey)) return context.layouts.get(cacheKey);
  const columns = context.header.length;
  if (context.naturalWidths === undefined) {
    context.naturalWidths = Object.freeze(
      context.header.map((headerCell, column) => {
        let max = escapedWidth(source.slice(
          context.lines[0].start + headerCell.start,
          context.lines[0].start + headerCell.end,
        ));
        for (let row = 0; row < context.rows.length; row += 1) {
          const cell = context.rows[row][column];
          if (cell !== undefined) {
            const line = context.lines[row + 2];
            max = Math.max(
              max,
              escapedWidth(
                source.slice(line.start + cell.start, line.start + cell.end),
              ),
            );
          }
        }
        return Math.max(3, max);
      }),
    );
  }
  const available = cacheKey - (3 * columns + 1);
  if (available < columns * 3) {
    context.layouts.set(cacheKey, undefined);
    return undefined;
  }
  const result = [...context.naturalWidths];
  while (result.reduce((sum, value) => sum + value, 0) > available) {
    let widest = -1;
    let widestValue = 3;
    for (let index = 0; index < columns; index += 1) {
      if (result[index] > widestValue) {
        widest = index;
        widestValue = result[index];
      }
    }
    if (widest < 0) break;
    result[widest] -= 1;
  }
  if (result.reduce((sum, value) => sum + value, 0) > available) {
    context.layouts.set(cacheKey, undefined);
    return undefined;
  }
  const frozen = Object.freeze(result);
  context.layouts.set(cacheKey, frozen);
  return frozen;
};

const tableCellsForRow = (block: TableBlock): readonly CellRange[] =>
  block.rowIndex === 0 ? block.context.header : block.context.rows[block.rowIndex - 2] ?? [];

const tableCellLineForRow = (block: TableBlock): SourceLine =>
  block.rowIndex === 0 ? block.context.lines[0] : block.context.lines[block.rowIndex] ?? block.line;

const tableCellLayout = (
  line: SourceLine,
  range: CellRange,
  width: number,
): WrapLayout => getWrapLayout(line, range.start, range.end, width, true);

const tableRowHeight = (
  source: string,
  block: TableBlock,
  width: number,
): number => {
  const widths = tableWidths(source, block.context, width);
  if (widths === undefined) {
    let count = block.rowIndex >= 3 ? 1 : 0;
    const cells = tableCellsForRow(block);
    for (let index = 0; index < cells.length; index += 1) {
      const header = block.context.header[index];
      const headerText = header === undefined ? '' : source.slice(
        block.context.lines[0].start + header.start,
        block.context.lines[0].start + header.end,
      );
      const line = tableCellLineForRow(block);
      const cellWidth = tableRecordCellWidth(headerText, width);
      count += ensureAllWrapRows(
        source,
        line,
        tableCellLayout(line, cells[index], cellWidth),
        cells[index].start,
        cells[index].end,
        cellWidth,
        true,
      );
    }
    return Math.max(1, count);
  }
  const cells = tableCellsForRow(block);
  let height = 1;
  for (let column = 0; column < block.context.header.length; column += 1) {
    const cell = cells[column] ?? { start: 0, end: 0 };
    const line = tableCellLineForRow(block);
    const cellLayout = tableCellLayout(line, cell, widths[column] ?? 3);
    height = Math.max(
      height,
      ensureAllWrapRows(
        source,
        line,
        cellLayout,
        cell.start,
        cell.end,
        widths[column] ?? 3,
        true,
      ),
    );
  }
  return height;
};

const tableHasRow = (
  source: string,
  block: TableBlock,
  width: number,
  row: number,
): boolean => {
  const widths = tableWidths(source, block.context, width);
  if (widths === undefined) return row < tableRowHeight(source, block, width);
  const cells = tableCellsForRow(block);
  for (let column = 0; column < block.context.header.length; column += 1) {
    const cell = cells[column] ?? { start: 0, end: 0 };
    const line = tableCellLineForRow(block);
    if (
      ensureWrapRow(
        source,
        line,
        tableCellLayout(line, cell, widths[column] ?? 3),
        cell.start,
        cell.end,
        widths[column] ?? 3,
        true,
        row,
      )
    ) return true;
  }
  return false;
};

const wrapRowCountForCell = (
  source: string,
  line: SourceLine,
  cell: CellRange,
  width: number,
): number =>
  ensureAllWrapRows(
    source,
    line,
    tableCellLayout(line, cell, width),
    cell.start,
    cell.end,
    width,
    true,
  );

const findSourceRow = (
  layout: WrapLayout,
  start: number,
  sourceOffset: number,
): number => {
  if (sourceOffset <= start) return 0;
  for (let row = 0; row < layout.ends.length; row += 1) {
    if (sourceOffset < layout.ends[row]) return row;
    if (
      row + 1 < layout.boundaries.length &&
      sourceOffset < layout.boundaries[row + 1]
    ) {
      return row + 1;
    }
  }
  return Math.max(0, layout.ends.length - 1);
};

const styleRangesForRow = (
  source: string,
  line: SourceLine,
  ranges: readonly InlineRange[],
  start: number,
  end: number,
  outputPrefix: string,
): AssistantSpan[] => {
  const prefixScalars = scalarLength(outputPrefix);
  const spans: AssistantSpan[] = [];
  for (const range of ranges) {
    const clippedStart = Math.max(start, range.start);
    const clippedEnd = Math.min(end, range.end);
    if (clippedEnd <= clippedStart) continue;
    const before = escapeTerminalText(
      source.slice(line.start + start, line.start + clippedStart),
    );
    const selected = escapeTerminalText(
      source.slice(line.start + clippedStart, line.start + clippedEnd),
    );
    spans.push({
      start: prefixScalars + scalarLength(before),
      length: scalarLength(selected),
      tone: range.tone,
    });
  }
  return spans;
};

const tableAlignPadding = (
  text: string,
  width: number,
  align: TableAlign,
): number => {
  const pad = Math.max(0, width - escapedWidth(text));
  if (align === 'right') return pad;
  if (align === 'center') return Math.floor(pad / 2);
  return 0;
};

const alignCell = (text: string, width: number, align: TableAlign): string => {
  const pad = Math.max(0, width - escapedWidth(text));
  if (align === 'right') return `${spaces(pad)}${text}`;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return `${spaces(left)}${text}${spaces(pad - left)}`;
  }
  return `${text}${spaces(pad)}`;
};

const cellSourceRow = (
  source: string,
  block: TableBlock,
  widths: readonly number[] | undefined,
  row: number,
  width: number,
): number => {
  const cells = tableCellsForRow(block);
  if (widths === undefined) {
    let offset = block.line.start;
    if (block.rowIndex >= 3 && row === 0) return offset;
    let current = block.rowIndex >= 3 ? 1 : 0;
    for (let column = 0; column < cells.length; column += 1) {
      const header = block.context.header[column];
      const headerText = header === undefined ? '' : source.slice(
        block.context.lines[0].start + header.start,
        block.context.lines[0].start + header.end,
      );
      const line = tableCellLineForRow(block);
      const cell = cells[column];
      const cellWidth = tableRecordCellWidth(headerText, width);
      const layout = tableCellLayout(line, cell, cellWidth);
      const count = wrapRowCountForCell(source, line, cell, cellWidth);
      if (row < current + count) {
        return line.start + layout.boundaries[row - current];
      }
      current += count;
      offset = line.start + cell.start;
    }
    return offset;
  }
  let best = block.line.start;
  let found = false;
  for (let column = 0; column < block.context.header.length; column += 1) {
    const cell = cells[column] ?? { start: 0, end: 0 };
    const line = tableCellLineForRow(block);
    const layout = tableCellLayout(line, cell, widths[column] ?? 3);
    if (
      ensureWrapRow(
        source,
        line,
        layout,
        cell.start,
        cell.end,
        widths[column] ?? 3,
        true,
        row,
      )
    ) {
      const offset = line.start + layout.boundaries[row];
      if (!found || offset < best) best = offset;
      found = true;
    }
  }
  return best;
};

export class BodyDocument {
  private text: string;
  private readonly mode: Mode;
  private lines: SourceLine[];
  private blocks: Block[];
  private readonly tableContexts: Map<string, TableContext>;

  constructor(text: string, mode: Mode) {
    this.text = text;
    this.mode = mode;
    this.lines = scanLines(text);
    this.tableContexts = new Map();
    this.blocks = this.buildBlocks(text, this.lines);
  }

  update(text: string): void {
    if (text === this.text) return;
    const priorText = this.text;
    const priorLines = this.lines;
    const priorBlocks = this.blocks;
    const isAppend = text.startsWith(priorText);
    const reused = reuseLines(priorText, priorLines, text);
    const nextLines = reused.lines;
    this.text = text;
    this.lines = nextLines;
    if (this.mode === 'plain') {
      const prefixBlocks = priorBlocks.slice(0, reused.prefixCount);
      const suffixBlocks = nextLines.slice(reused.prefixCount).map((line) => ({
        kind: 'plain' as const,
        line,
      }));
      this.blocks = [...prefixBlocks, ...suffixBlocks];
    } else if (isAppend) {
      const plan = appendMarkdownPlan(
        text,
        priorLines,
        priorBlocks,
        nextLines,
        reused.prefixCount,
      );
      const prefixBlocks = priorBlocks.slice(0, plan.restart);
      const suffixBlocks = parseMarkdown(
        text,
        nextLines.slice(plan.restart),
        plan.tableContexts,
        plan.fenceContext,
      );
      this.blocks = [...prefixBlocks, ...suffixBlocks];
    } else {
      const restart = markdownRestartLine(
        priorLines,
        priorBlocks,
        reused.prefixCount,
      );
      const oldLineIndexes = new Map(
        priorLines.map((line, index) => [line.id, index]),
      );
      const prefixBlocks = priorBlocks.filter((block) => {
        const lineIndex = oldLineIndexes.get(block.line.id);
        return lineIndex !== undefined && lineIndex < restart;
      });
      const contexts = oldTableContexts(priorBlocks);
      const suffixBlocks = parseMarkdown(
        text,
        nextLines.slice(restart),
        contexts,
      );
      this.blocks = [...prefixBlocks, ...suffixBlocks];
    }
  }

  first(_width: number): BodyCursor {
    return { block: 0, row: 0 };
  }

  isFirst(cursor: BodyCursor): boolean {
    return cursor.block === 0 && cursor.row === 0;
  }

  isLast(cursor: BodyCursor, width: number): boolean {
    if (cursor.block !== this.blocks.length - 1) return false;
    const block = this.blocks[cursor.block];
    if (block === undefined) return false;
    const row = Math.max(0, cursor.row);
    return this.hasRow(block, row, width) &&
      !this.hasRow(block, row + 1, width);
  }

  last(width: number): BodyCursor {
    const block = this.blocks.length - 1;
    if (block < 0) return { block: 0, row: 0 };
    return { block, row: this.lastRow(block, width) };
  }

  seek(sourceUtf16Offset: number, width: number): BodyCursor {
    const sourceOffset = Math.max(
      0,
      Math.min(this.text.length, sourceUtf16Offset),
    );
    const lineIndex = this.lineIndexAt(sourceOffset);
    const blockIndex = this.blockIndexAtLine(lineIndex);
    const block = this.blocks[blockIndex];
    if (block.kind === 'fixed') return { block: blockIndex, row: 0 };
    if (block.kind === 'table') {
      return {
        block: blockIndex,
        row: this.tableSeekRow(block, sourceOffset, width),
      };
    }
    const wrap = lineWrap(block, width);
    const row = this.rowForOffset(
      block.line,
      wrap.layout,
      wrap.start,
      wrap.end,
      wrap.wrapWidth,
      wrap.wordAware,
      sourceOffset,
    );
    return { block: blockIndex, row };
  }

  next(cursor: BodyCursor, width: number): BodyCursor | undefined {
    const blockIndex = this.clampBlock(cursor.block);
    const block = this.blocks[blockIndex];
    const row = Math.max(0, cursor.row);
    if (this.hasRow(block, row + 1, width)) {
      return { block: blockIndex, row: row + 1 };
    }
    if (blockIndex + 1 >= this.blocks.length) return undefined;
    return { block: blockIndex + 1, row: 0 };
  }

  previous(cursor: BodyCursor, width: number): BodyCursor | undefined {
    const blockIndex = this.clampBlock(cursor.block);
    const row = Math.max(0, cursor.row);
    if (row > 0) return { block: blockIndex, row: row - 1 };
    if (blockIndex === 0) return undefined;
    const prior = blockIndex - 1;
    return { block: prior, row: this.lastRow(prior, width) };
  }

  sourceOffset(cursor: BodyCursor, width: number): number {
    const blockIndex = this.clampBlock(cursor.block);
    const row = Math.max(0, cursor.row);
    const block = this.blocks[blockIndex];
    if (block.kind === 'fixed') return block.line.start;
    if (block.kind === 'table') {
      return cellSourceRow(
        this.text,
        block,
        tableWidths(this.text, block.context, width),
        row,
        width,
      );
    }
    const wrap = lineWrap(block, width);
    ensureWrapRow(
      this.text,
      block.line,
      wrap.layout,
      wrap.start,
      wrap.end,
      wrap.wrapWidth,
      wrap.wordAware,
      row,
    );
    return block.line.start + (wrap.layout.boundaries[row] ?? wrap.start);
  }

  /** Stable identity for a projected row without materializing its text or styles. */
  rowKey(cursor: BodyCursor, width: number): string {
    const blockIndex = this.clampBlock(cursor.block);
    const row = Math.max(0, cursor.row);
    const block = this.blocks[blockIndex];
    if (block.kind === 'plain') {
      const wrap = lineWrap(block, width);
      ensureWrapRow(
        this.text,
        block.line,
        wrap.layout,
        wrap.start,
        wrap.end,
        wrap.wrapWidth,
        wrap.wordAware,
        row,
      );
      const start = wrap.layout.boundaries[row] ?? wrap.start;
      const end = wrap.layout.ends[row] ?? start;
      return `plain:${width}:${block.line.id}:${block.line.start}:${start}:${end}`;
    }
    if (block.kind === 'fixed') {
      return [
        'fixed',
        width,
        block.fixedKind,
        block.line.id,
        block.line.version,
        block.line.start,
        block.tableContext?.key ?? '',
      ].join(':');
    }
    if (block.kind === 'table') {
      const sourceOffset = cellSourceRow(
        this.text,
        block,
        tableWidths(this.text, block.context, width),
        row,
        width,
      );
      return [
        'table',
        width,
        block.context.key,
        block.rowIndex,
        row,
        block.line.start,
        sourceOffset,
      ].join(':');
    }

    const wrap = lineWrap(block, width);
    ensureWrapRow(
      this.text,
      block.line,
      wrap.layout,
      wrap.start,
      wrap.end,
      wrap.wrapWidth,
      wrap.wordAware,
      row,
    );
    const start = wrap.layout.boundaries[row] ?? wrap.start;
    const end = wrap.layout.ends[row] ?? start;
    const version = block.inline ? block.line.version : 0;
    return [
      'wrapped',
      width,
      block.line.id,
      version,
      block.line.start,
      start,
      end,
      block.sourceStart,
      block.firstPrefix,
      block.continuationPrefix,
      block.prefixTone ?? '',
      block.wholeRowTone ?? '',
      block.wordAware ? 'w' : 'h',
      block.inline ? 'i' : 'p',
      block.groupStartId ?? '',
      block.fenceContext?.marker ?? '',
    ].join(':');
  }

  render(cursor: BodyCursor, width: number): BodyRow {
    const blockIndex = this.clampBlock(cursor.block);
    const row = Math.max(0, cursor.row);
    const block = this.blocks[blockIndex];
    if (block.kind === 'fixed') return this.renderFixed(block, width);
    if (block.kind === 'table') return this.renderTable(block, row, width);
    if (block.kind === 'plain') return this.renderPlain(block, row, width);
    return this.renderWrapped(block, row, width);
  }

  private buildBlocks(
    source: string,
    lines: readonly SourceLine[],
    oldContexts: ReadonlyMap<string, TableContext> = this.tableContexts,
  ): Block[] {
    if (this.mode === 'plain') {
      return lines.map((line) => ({ kind: 'plain', line }));
    }
    return parseMarkdown(source, lines, oldContexts);
  }

  private clampBlock(block: number): number {
    return Math.max(0, Math.min(this.blocks.length - 1, block));
  }

  private lineIndexAt(offset: number): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const line = this.lines[middle];
      if (offset < line.start) high = middle - 1;
      else if (offset > line.end && middle < this.lines.length - 1) {
        low = middle + 1;
      } else return middle;
    }
    return Math.max(0, Math.min(this.lines.length - 1, low));
  }

  private blockIndexAtLine(lineIndex: number): number {
    // Both parsers emit exactly one block per physical source line.
    return Math.max(0, Math.min(this.blocks.length - 1, lineIndex));
  }

  private rowForOffset(
    line: SourceLine,
    layout: WrapLayout,
    start: number,
    end: number,
    width: number,
    wordAware: boolean,
    sourceOffset: number,
  ): number {
    const relative = Math.max(start, Math.min(end, sourceOffset - line.start));
    while (!layout.complete && layout.nextSource <= relative) {
      ensureWrapRow(
        this.text,
        line,
        layout,
        start,
        end,
        width,
        wordAware,
        layout.ends.length,
      );
    }
    return findSourceRow(layout, start, relative);
  }

  private tableSeekRow(
    block: TableBlock,
    sourceOffset: number,
    width: number,
  ): number {
    const widths = tableWidths(this.text, block.context, width);
    const cells = tableCellsForRow(block);
    if (widths === undefined) {
      let rowStart = block.rowIndex >= 3 ? 1 : 0;
      for (let column = 0; column < cells.length; column += 1) {
        const cell = cells[column];
        const line = tableCellLineForRow(block);
        const header = block.context.header[column];
        const headerText = header === undefined ? '' : this.text.slice(
          block.context.lines[0].start + header.start,
          block.context.lines[0].start + header.end,
        );
        const cellWidth = tableRecordCellWidth(headerText, width);
        const layout = tableCellLayout(line, cell, cellWidth);
        const count = wrapRowCountForCell(this.text, line, cell, cellWidth);
        if (
          sourceOffset >= line.start + cell.start &&
          sourceOffset <= line.start + cell.end
        ) {
          return rowStart +
            this.rowForOffset(
              line,
              layout,
              cell.start,
              cell.end,
              cellWidth,
              true,
              sourceOffset,
            );
        }
        rowStart += count;
      }
      return 0;
    }
    for (let column = 0; column < cells.length; column += 1) {
      const cell = cells[column];
      const line = tableCellLineForRow(block);
      if (
        sourceOffset < line.start + cell.start ||
        sourceOffset > line.start + cell.end
      ) continue;
      return this.rowForOffset(
        line,
        tableCellLayout(line, cell, widths[column] ?? 3),
        cell.start,
        cell.end,
        widths[column] ?? 3,
        true,
        sourceOffset,
      );
    }
    return 0;
  }

  private hasRow(block: Block, row: number, width: number): boolean {
    if (row < 0) return false;
    if (block.kind === 'fixed') return row === 0;
    if (block.kind === 'table') {
      return tableHasRow(this.text, block, width, row);
    }
    const wrap = lineWrap(block, width);
    return ensureWrapRow(
      this.text,
      block.line,
      wrap.layout,
      wrap.start,
      wrap.end,
      wrap.wrapWidth,
      wrap.wordAware,
      row,
    );
  }

  private lastRow(blockIndex: number, width: number): number {
    const block = this.blocks[blockIndex];
    if (block.kind === 'fixed') return 0;
    if (block.kind === 'table') {
      return Math.max(0, tableRowHeight(this.text, block, width) - 1);
    }
    const wrap = lineWrap(block, width);
    return ensureAllWrapRows(
      this.text,
      block.line,
      wrap.layout,
      wrap.start,
      wrap.end,
      wrap.wrapWidth,
      wrap.wordAware,
    ) - 1;
  }

  private renderFixed(block: FixedBlock, width: number): BodyRow {
    let text = block.output ?? '';
    const spans: AssistantSpan[] = [];
    if (block.fixedKind === 'rule') {
      text = '─'.repeat(Math.max(1, Math.min(Math.max(1, width), 40)));
      spans.push({ start: 0, length: scalarLength(text), tone: 'table' });
    } else if (block.fixedKind === 'tableSeparator') {
      const context = block.tableContext;
      if (context !== undefined) {
        const widths = tableWidths(this.text, context, width);
        if (widths !== undefined) {
          text = `|${
            widths.map((value, index) => {
              const align = context.aligns[index] ?? 'left';
              const dashes = align === 'center'
                ? `:${'-'.repeat(Math.max(1, value - 2))}:`
                : align === 'right'
                ? `${'-'.repeat(Math.max(1, value - 1))}:`
                : '-'.repeat(value);
              return ` ${dashes} `;
            }).join('|')
          }|`;
        }
      }
      spans.push({ start: 0, length: scalarLength(text), tone: 'table' });
    }
    return {
      text: escapeTerminalText(text),
      spans: Object.freeze(spans),
      sourceUtf16Offset: block.line.start,
    };
  }

  private renderPlain(block: PlainBlock, row: number, width: number): BodyRow {
    const wrap = lineWrap(block, width);
    ensureWrapRow(
      this.text,
      block.line,
      wrap.layout,
      wrap.start,
      wrap.end,
      wrap.wrapWidth,
      wrap.wordAware,
      row,
    );
    const start = wrap.layout.boundaries[row] ?? 0;
    const end = wrap.layout.ends[row] ?? start;
    return {
      text: escapeTerminalText(
        this.text.slice(block.line.start + start, block.line.start + end),
      ),
      spans: Object.freeze([]),
      sourceUtf16Offset: block.line.start + start,
    };
  }

  private renderWrapped(
    block: WrappedBlock,
    row: number,
    width: number,
  ): BodyRow {
    const wrap = lineWrap(block, width);
    ensureWrapRow(
      this.text,
      block.line,
      wrap.layout,
      wrap.start,
      wrap.end,
      wrap.wrapWidth,
      wrap.wordAware,
      row,
    );
    const start = wrap.layout.boundaries[row] ?? block.sourceStart;
    const end = wrap.layout.ends[row] ?? start;
    const prefixes = wrappedPrefixes(block, width);
    const intendedPrefix = row === 0 ? prefixes.first : prefixes.continuation;
    const body = escapeTerminalText(
      this.text.slice(block.line.start + start, block.line.start + end),
    );
    const prefix = prefixWithin(intendedPrefix, width - cellWidth(body));
    const text = `${escapeTerminalText(prefix)}${body}`;
    const spans: AssistantSpan[] = [];
    if (block.wholeRowTone !== undefined) {
      spans.push({
        start: 0,
        length: scalarLength(text),
        tone: block.wholeRowTone,
      });
    }
    const prefixSpan = prefixToneRange(block, prefix);
    if (block.prefixTone !== undefined && row === 0 && prefixSpan !== undefined) {
      spans.push({
        start: prefixSpan.start,
        length: prefixSpan.length,
        tone: block.prefixTone,
      });
    }
    if (block.inline) {
      spans.push(...styleRangesForRow(
        this.text,
        block.line,
        inlineRanges(this.text, block.line, block.sourceStart, block.sourceEnd),
        start,
        end,
        escapeTerminalText(prefix),
      ));
    }
    return {
      text,
      spans: Object.freeze(spans),
      sourceUtf16Offset: block.line.start + start,
    };
  }

  private renderTable(block: TableBlock, row: number, width: number): BodyRow {
    const widths = tableWidths(this.text, block.context, width);
    const cells = tableCellsForRow(block);
    if (widths === undefined) {
      return this.renderTableRecords(block, cells, row, width);
    }
    let text = '';
    const spans: AssistantSpan[] = [];
    let sourceOffset: number | undefined;
    for (let column = 0; column < block.context.header.length; column += 1) {
      const cell = cells[column] ?? { start: 0, end: 0 };
      const line = tableCellLineForRow(block);
      const cellLayout = tableCellLayout(line, cell, widths[column] ?? 3);
      ensureWrapRow(
        this.text,
        line,
        cellLayout,
        cell.start,
        cell.end,
        widths[column] ?? 3,
        true,
        row,
      );
      const start = cellLayout.boundaries[row] ?? cell.start;
      const end = cellLayout.ends[row] ?? start;
      const rawCell = this.text.slice(line.start + start, line.start + end);
      const projected = escapeTerminalText(rawCell);
      const padded = alignCell(
        projected,
        widths[column] ?? 3,
        block.context.aligns[column] ?? 'left',
      );
      text += '| ';
      spans.push({ start: scalarLength(text) - 1, length: 1, tone: 'table' });
      const contentStart = scalarLength(text) +
        tableAlignPadding(
          projected,
          widths[column] ?? 3,
          block.context.aligns[column] ?? 'left',
        );
      if (block.rowIndex === 0 && projected.length > 0) {
        spans.push({
          start: contentStart,
          length: scalarLength(projected),
          tone: 'bold',
        });
      }
      text += `${padded} `;
      if (sourceOffset === undefined && start < end) {
        sourceOffset = line.start + start;
      }
    }
    text += '|';
    spans.push({ start: scalarLength(text) - 1, length: 1, tone: 'table' });
    return {
      text,
      spans: Object.freeze(spans),
      sourceUtf16Offset: sourceOffset ??
        cellSourceRow(this.text, block, widths, row, width),
    };
  }

  private renderTableRecords(
    block: TableBlock,
    cells: readonly CellRange[],
    row: number,
    width: number,
  ): BodyRow {
    let current = block.rowIndex >= 3 ? 1 : 0;
    if (block.rowIndex >= 3 && row === 0) {
      return {
        text: '',
        spans: Object.freeze([]),
        sourceUtf16Offset: block.line.start,
      };
    }
    for (let column = 0; column < cells.length; column += 1) {
      const header = block.context.header[column];
      const headerText = header === undefined ? '' : this.text.slice(
        block.context.lines[0].start + header.start,
        block.context.lines[0].start + header.end,
      );
      const label = tableRecordLabel(headerText, width);
      const line = tableCellLineForRow(block);
      const cell = cells[column];
      const bodyWidth = tableRecordCellWidth(headerText, width);
      const layout = tableCellLayout(line, cell, bodyWidth);
      const count = wrapRowCountForCell(this.text, line, cell, bodyWidth);
      if (row < current + count) {
        const local = row - current;
        const start = layout.boundaries[local] ?? cell.start;
        const end = layout.ends[local] ?? start;
        const body = escapeTerminalText(
          this.text.slice(line.start + start, line.start + end),
        );
        const visibleLabel = prefixWithin(label, width - cellWidth(body));
        const projectedLabel = escapeTerminalText(visibleLabel);
        return {
          text: `${projectedLabel}${body}`,
          spans: Object.freeze([
            ...(projectedLabel.length === 0 ? [] : [{
              start: 0,
              length: scalarLength(projectedLabel),
              tone: 'list' as const,
            }]),
          ]),
          sourceUtf16Offset: line.start + start,
        };
      }
      current += count;
    }
    return {
      text: '',
      spans: Object.freeze([]),
      sourceUtf16Offset: block.line.start,
    };
  }
}
