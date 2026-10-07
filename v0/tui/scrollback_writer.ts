import type { TerminalPort } from './terminal.ts';
import { cellWidth } from './terminal_text.ts';

/** A normal-screen append plus the rows that Henji may still update. */
export interface ScrollbackFrame {
  readonly committedRows: readonly string[];
  readonly liveRows: readonly string[];
  readonly cursor: { readonly row: number; readonly cell: number };
  readonly size: { readonly columns: number; readonly rows: number };
}

const encoder = new TextEncoder();
const CARRIAGE_RETURN = '\r';
const LINE_END = '\r\n';
const ERASE_LINE = '\x1b[2K';
const SAVE_CURSOR = '\x1b7';
const RESTORE_CURSOR = '\x1b8';

const moveUp = (rows: number): string => rows > 0 ? `\x1b[${rows}A` : '';
const moveDown = (rows: number): string => rows > 0 ? `\x1b[${rows}B` : '';
const moveRight = (cells: number): string => cells > 0 ? `\x1b[${cells}C` : '';

const sameRows = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((row, index) => row === right[index]);

const sameCursor = (
  left: ScrollbackFrame['cursor'],
  right: ScrollbackFrame['cursor'],
): boolean => left.row === right.row && left.cell === right.cell;

const sameSize = (
  left: ScrollbackFrame['size'],
  right: ScrollbackFrame['size'],
): boolean => left.columns === right.columns && left.rows === right.rows;

// deno-lint-ignore no-control-regex -- SGR escapes have an intentional ESC prefix.
const stripSgr = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '');

const reflowHeight = (rows: readonly string[], columns: number): number =>
  rows.reduce(
    (height, row) => height + Math.max(1, Math.ceil(cellWidth(stripSgr(row)) / columns)),
    0,
  );

const clearLiveBand = (
  cursorOffset: number,
  visibleRows: number,
): string[] => {
  const output: string[] = [];
  output.push(moveUp(cursorOffset), CARRIAGE_RETURN);
  output.push(SAVE_CURSOR);
  for (let row = 0; row < visibleRows; row += 1) {
    output.push(ERASE_LINE);
    if (row + 1 < visibleRows) output.push(moveDown(1));
  }
  output.push(RESTORE_CURSOR, CARRIAGE_RETURN);
  return output;
};

/**
 * Writes committed rows once and redraws only the current live band on the normal screen.
 * The cursor is kept inside that band so the next update can find its first row by moving up.
 */
export class ScrollbackWriter {
  private previous: {
    liveRows: string[];
    cursor: { row: number; cell: number };
    size: { columns: number; rows: number };
  } | undefined;

  constructor(private readonly terminal: Pick<TerminalPort, 'write'>) {}

  retainPrefix(count: number): void {
    const previous = this.previous;
    if (previous === undefined || count === 0) return;

    previous.liveRows = previous.liveRows.slice(count);
    previous.cursor = { ...previous.cursor, row: previous.cursor.row - count };
  }

  write(frame: ScrollbackFrame): void {
    const previous = this.previous;
    if (
      previous !== undefined && frame.committedRows.length === 0 &&
      sameRows(previous.liveRows, frame.liveRows) &&
      sameCursor(previous.cursor, frame.cursor) && sameSize(previous.size, frame.size)
    ) return;

    let retainedPrefix = 0;
    if (
      previous !== undefined && frame.committedRows.length === 0 &&
      sameSize(previous.size, frame.size)
    ) {
      const prefixLimit = Math.min(previous.cursor.row, frame.cursor.row);
      while (
        retainedPrefix < prefixLimit &&
        previous.liveRows[retainedPrefix] === frame.liveRows[retainedPrefix]
      ) retainedPrefix += 1;
    }

    const previousRows = previous?.liveRows.slice(retainedPrefix) ?? [];
    const previousCursorRow = previous === undefined ? 0 : previous.cursor.row - retainedPrefix;
    const nextLiveRows = frame.liveRows.slice(retainedPrefix);
    const nextCursorRow = frame.cursor.row - retainedPrefix;
    const output: string[] = [];
    if (previous === undefined) {
      // The first frame starts at the terminal's current output position and replaces that line.
      output.push(CARRIAGE_RETURN, ERASE_LINE);
    } else {
      // ED0 at the top of a full-height band promotes the previous screen in tmux. Clear only
      // rows this writer owns, using cursor motion that cannot scroll the screen or history.
      // A width change reflows each hard line before the cursor moves, so derive the offset and
      // erase height from displayed cell widths rather than the old logical row count.
      const cursorOffset = reflowHeight(
        previousRows.slice(0, previousCursorRow),
        frame.size.columns,
      ) + Math.floor(previous.cursor.cell / frame.size.columns);
      const visibleRows = Math.min(
        reflowHeight(previousRows, frame.size.columns),
        frame.size.rows,
      );
      output.push(...clearLiveBand(cursorOffset, visibleRows));
    }

    for (const row of frame.committedRows) output.push(row, LINE_END);

    for (let index = 0; index < nextLiveRows.length; index += 1) {
      if (index > 0) output.push(LINE_END);
      output.push(nextLiveRows[index]);
    }

    // A full-width final row leaves delayed-wrap pending. CR returns to its head and clears it.
    output.push(CARRIAGE_RETURN);
    const rowsFromLastLiveRow = nextLiveRows.length - 1 - nextCursorRow;
    if (rowsFromLastLiveRow > 0) output.push(moveUp(rowsFromLastLiveRow));
    output.push(moveRight(frame.cursor.cell));

    this.terminal.write(encoder.encode(output.join('')));
    this.previous = {
      liveRows: [...frame.liveRows],
      cursor: { ...frame.cursor },
      size: { ...frame.size },
    };
  }

  close(): void {
    const previous = this.previous;
    if (previous === undefined) return;

    const output: string[] = [];
    if (previous.liveRows.length > 0) {
      const cursorOffset = reflowHeight(
        previous.liveRows.slice(0, previous.cursor.row),
        previous.size.columns,
      ) + Math.floor(previous.cursor.cell / previous.size.columns);
      const visibleRows = Math.min(
        reflowHeight(previous.liveRows, previous.size.columns),
        previous.size.rows,
      );
      output.push(...clearLiveBand(cursorOffset, visibleRows));
    } else {
      output.push(CARRIAGE_RETURN);
    }
    this.terminal.write(encoder.encode(output.join('')));
    this.previous = undefined;
  }
}
