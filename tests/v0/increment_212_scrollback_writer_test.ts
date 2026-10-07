import { type ScrollbackFrame, ScrollbackWriter } from '../../v0/tui/scrollback_writer.ts';
import { segmentTerminalText } from '../../v0/tui/terminal_text.ts';

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const decoder = new TextDecoder();

class ScreenTerminal {
  readonly writes: string[] = [];
  readonly scrollback: string[][] = [];
  screen: string[][];
  cursor = { row: 0, cell: 0 };
  private wrapPending = false;
  private usedCells: number[];
  private savedCursor: { row: number; cell: number; wrapPending: boolean } | undefined;

  constructor(
    private columns: number,
    private rows: number,
  ) {
    this.screen = Array.from({ length: rows }, () => this.blankRow());
    this.usedCells = Array.from({ length: rows }, () => 0);
  }

  write(bytes: Uint8Array): void {
    const text = decoder.decode(bytes);
    this.writes.push(text);
    this.consume(text);
  }

  resize(columns: number, rows: number): void {
    if (columns !== this.columns) this.reflow(columns);
    this.columns = columns;
    if (rows < this.rows && this.screen.length > rows) {
      this.screen = this.screen.slice(0, rows);
      this.usedCells = this.usedCells.slice(0, rows);
    } else if (rows > this.rows) {
      this.screen.push(...Array.from({ length: rows - this.rows }, () => this.blankRow()));
      this.usedCells.push(...Array.from({ length: rows - this.usedCells.length }, () => 0));
    }
    this.rows = rows;
    this.cursor.row = Math.min(this.cursor.row, rows - 1);
    this.cursor.cell = Math.min(this.cursor.cell, columns - 1);
    this.wrapPending = false;
  }

  visibleRows(): string[] {
    return this.screen.map((row) => row.join('').trimEnd());
  }

  allRows(): string[] {
    return [...this.scrollback, ...this.screen].map((row) => row.join('').trimEnd());
  }

  private blankRow(): string[] {
    return Array.from({ length: this.columns }, () => ' ');
  }

  private reflow(columns: number): void {
    const oldScreen = this.screen;
    const oldUsedCells = this.usedCells;
    const oldCursor = { ...this.cursor };
    const contentEnd = Math.max(
      oldCursor.row,
      oldUsedCells.findLastIndex((usedCells) => usedCells > 0),
    );
    const nextScreen: string[][] = [];
    const nextUsedCells: number[] = [];
    let nextCursor: { row: number; cell: number } | undefined;

    for (let rowIndex = 0; rowIndex <= contentEnd; rowIndex += 1) {
      const line = oldScreen[rowIndex].slice(0, oldUsedCells[rowIndex]).join('');
      const lineStartRow = nextScreen.length;
      let row = Array.from({ length: columns }, () => ' ');
      let cell = 0;
      let usedCells = 0;

      for (const segment of segmentTerminalText(line)) {
        if (segment.cellWidth === 0) continue;
        if (cell + segment.cellWidth > columns) {
          nextScreen.push(row);
          nextUsedCells.push(usedCells);
          row = Array.from({ length: columns }, () => ' ');
          cell = 0;
          usedCells = 0;
        }
        row[cell] = segment.text;
        for (let part = 1; part < segment.cellWidth; part += 1) row[cell + part] = '';
        cell += segment.cellWidth;
        usedCells = cell;
      }

      nextScreen.push(row);
      nextUsedCells.push(usedCells);
      if (rowIndex === oldCursor.row) {
        nextCursor = {
          row: lineStartRow + Math.floor(oldCursor.cell / columns),
          cell: oldCursor.cell % columns,
        };
      }
    }

    this.screen = nextScreen;
    this.usedCells = nextUsedCells;
    this.cursor = nextCursor ??
      { row: Math.min(oldCursor.row, nextScreen.length - 1), cell: oldCursor.cell };
    while (this.screen.length > this.rows) {
      this.scrollback.push(this.screen.shift() ?? this.blankRow());
      this.usedCells.shift();
      this.cursor.row -= 1;
    }
    while (this.screen.length < this.rows) {
      this.screen.push(Array.from({ length: columns }, () => ' '));
      this.usedCells.push(0);
    }
    this.cursor.row = Math.max(0, Math.min(this.cursor.row, this.rows - 1));
    this.cursor.cell = Math.min(this.cursor.cell, columns - 1);
  }

  private eraseFromCursorToDisplayEnd(): void {
    this.screen[this.cursor.row].fill(' ', this.cursor.cell);
    for (let row = this.cursor.row + 1; row < this.rows; row += 1) {
      this.screen[row].fill(' ');
      this.usedCells[row] = 0;
    }
    this.usedCells[this.cursor.row] = Math.min(this.usedCells[this.cursor.row], this.cursor.cell);
    this.wrapPending = false;
  }

  private lineFeed(): void {
    this.wrapPending = false;
    if (this.cursor.row === this.rows - 1) {
      this.scrollback.push(this.screen.shift() ?? this.blankRow());
      this.screen.push(this.blankRow());
      this.usedCells.shift();
      this.usedCells.push(0);
    } else {
      this.cursor.row += 1;
    }
  }

  private print(text: string): void {
    for (const segment of segmentTerminalText(text)) {
      if (segment.cellWidth === 0) continue;
      if (this.wrapPending || this.cursor.cell + segment.cellWidth > this.columns) {
        this.lineFeed();
        this.cursor.cell = 0;
      }
      this.screen[this.cursor.row][this.cursor.cell] = segment.text;
      for (let part = 1; part < segment.cellWidth; part += 1) {
        this.screen[this.cursor.row][this.cursor.cell + part] = '';
      }
      this.usedCells[this.cursor.row] = Math.max(
        this.usedCells[this.cursor.row],
        this.cursor.cell + segment.cellWidth,
      );
      if (this.cursor.cell + segment.cellWidth >= this.columns) {
        this.cursor.cell = this.columns - 1;
        this.wrapPending = true;
      } else {
        this.cursor.cell += segment.cellWidth;
      }
    }
  }

  private consume(text: string): void {
    for (let index = 0; index < text.length;) {
      const character = text[index];
      if (character === '\x1b' && text[index + 1] === '7') {
        this.savedCursor = { ...this.cursor, wrapPending: this.wrapPending };
        index += 2;
        continue;
      }
      if (character === '\x1b' && text[index + 1] === '8') {
        if (this.savedCursor !== undefined) {
          this.cursor = { row: this.savedCursor.row, cell: this.savedCursor.cell };
          this.wrapPending = this.savedCursor.wrapPending;
        }
        index += 2;
        continue;
      }
      if (character === '\x1b' && text[index + 1] === '[') {
        let end = index + 2;
        while (end < text.length && !/[A-Za-z]/u.test(text[end])) end += 1;
        const command = text[end];
        const parameters = text.slice(index + 2, end).replace(/^\?/u, '').split(';');
        const amount = Number(parameters[0] || 1);
        if (command === 'A') {
          this.cursor.row = Math.max(0, this.cursor.row - amount);
          this.wrapPending = false;
        } else if (command === 'B') {
          this.cursor.row = Math.min(this.rows - 1, this.cursor.row + amount);
          this.wrapPending = false;
        } else if (command === 'C') {
          this.cursor.cell = Math.min(this.columns - 1, this.cursor.cell + amount);
          this.wrapPending = false;
        } else if (command === 'K' && parameters[0] === '2') {
          this.screen[this.cursor.row].fill(' ');
          this.usedCells[this.cursor.row] = 0;
          this.wrapPending = false;
        } else if (command === 'J' && (parameters[0] === '0' || parameters[0] === '')) {
          this.eraseFromCursorToDisplayEnd();
        }
        index = end + 1;
        continue;
      }
      if (character === '\r') {
        this.cursor.cell = 0;
        this.wrapPending = false;
      } else if (character === '\n') {
        this.lineFeed();
      } else {
        this.print(character);
      }
      index += 1;
    }
  }
}

const frame = (
  committedRows: readonly string[],
  liveRows: readonly string[],
  cursor: ScrollbackFrame['cursor'],
  size: ScrollbackFrame['size'],
): ScrollbackFrame => ({ committedRows, liveRows, cursor, size });

const occurrences = (rows: readonly string[], text: string): number =>
  rows.filter((row) => row === text).length;

Deno.test('committed rows stay once while live rows and cursor move', () => {
  const terminal = new ScreenTerminal(24, 3);
  const writer = new ScrollbackWriter(terminal);

  writer.write(frame([], ['temporary', 'editor> alpha'], { row: 1, cell: 9 }, {
    columns: 24,
    rows: 3,
  }));
  writer.write(frame(['turn one'], ['assistant live one', 'editor> alpha'], {
    row: 1,
    cell: 9,
  }, { columns: 24, rows: 3 }));
  writer.write(frame(['turn two'], ['assistant live two', 'editor> beta'], {
    row: 1,
    cell: 8,
  }, { columns: 24, rows: 3 }));

  const allRows = terminal.allRows();
  assertEquals(occurrences(allRows, 'turn one'), 1);
  assertEquals(occurrences(allRows, 'turn two'), 1);
  assertEquals(occurrences(allRows, 'assistant live one'), 0);
  assertEquals(occurrences(allRows, 'assistant live two'), 1);
  assertEquals(terminal.cursor, { row: 2, cell: 8 });

  const writeCount = terminal.writes.length;
  writer.write(frame([], ['assistant live two', 'editor> beta'], {
    row: 1,
    cell: 8,
  }, { columns: 24, rows: 3 }));
  assertEquals(terminal.writes.length, writeCount);
});

Deno.test('unchanged live prefix is not rewritten for editor and footer updates', () => {
  const terminal = new ScreenTerminal(24, 6);
  const writer = new ScrollbackWriter(terminal);

  writer.write(frame([], ['body one', 'body two', 'editor old', 'footer old'], {
    row: 2,
    cell: 2,
  }, { columns: 24, rows: 6 }));
  writer.write(frame([], ['body one', 'body two', 'editor new', 'footer new'], {
    row: 2,
    cell: 3,
  }, { columns: 24, rows: 6 }));

  assertEquals(terminal.writes.at(-1)?.includes('body one'), false);
  assertEquals(terminal.writes.at(-1)?.includes('body two'), false);
  assertEquals(terminal.visibleRows().slice(0, 4), [
    'body one',
    'body two',
    'editor new',
    'footer new',
  ]);
  assertEquals(terminal.cursor, { row: 2, cell: 3 });
});

Deno.test('live band redraw follows terminal size changes and restores the new cursor', () => {
  const terminal = new ScreenTerminal(24, 5);
  const writer = new ScrollbackWriter(terminal);

  writer.write(frame([], ['body', 'editor> x'], { row: 1, cell: 3 }, {
    columns: 24,
    rows: 5,
  }));
  terminal.resize(24, 7);
  writer.write(frame([], ['body', 'tools', 'editor row one', 'editor row two'], {
    row: 2,
    cell: 5,
  }, { columns: 24, rows: 7 }));
  assertEquals(terminal.visibleRows().slice(0, 4), [
    'body',
    'tools',
    'editor row one',
    'editor row two',
  ]);
  assertEquals(terminal.cursor, { row: 2, cell: 5 });

  terminal.resize(20, 7);
  writer.write(frame([], ['body', 'tools', 'editor row one', 'editor row two'], {
    row: 2,
    cell: 5,
  }, { columns: 20, rows: 7 }));
  assertEquals(terminal.visibleRows().slice(0, 4), [
    'body',
    'tools',
    'editor row one',
    'editor row two',
  ]);
  assertEquals(terminal.cursor, { row: 2, cell: 5 });

  terminal.resize(24, 3);
  writer.write(frame([], ['body', 'editor row one', 'editor row two'], {
    row: 1,
    cell: 2,
  }, { columns: 24, rows: 3 }));
  assertEquals(terminal.visibleRows(), ['body', 'editor row one', 'editor row two']);
  assertEquals(terminal.cursor, { row: 1, cell: 2 });
});

Deno.test('full-width rows use CRLF without spilling an extra wrapped row', () => {
  const terminal = new ScreenTerminal(5, 5);
  const writer = new ScrollbackWriter(terminal);

  writer.write(frame([], ['old'], { row: 0, cell: 0 }, { columns: 5, rows: 5 }));
  writer.write(frame(['12345'], ['abcde', 'INPUT'], { row: 1, cell: 2 }, {
    columns: 5,
    rows: 5,
  }));

  assertEquals(terminal.visibleRows().slice(0, 3), ['12345', 'abcde', 'INPUT']);
  assertEquals(terminal.cursor, { row: 2, cell: 2 });
  assertEquals(occurrences(terminal.allRows(), '12345'), 1);
});

Deno.test('full-height live updates do not promote the old band into scrollback', () => {
  const terminal = new ScreenTerminal(24, 4);
  const writer = new ScrollbackWriter(terminal);

  writer.write(frame([], ['old body', 'old editor', 'old footer', 'old model'], {
    row: 2,
    cell: 4,
  }, { columns: 24, rows: 4 }));
  writer.write(frame(['committed turn'], ['body one', 'body two', 'editor', 'footer'], {
    row: 2,
    cell: 2,
  }, { columns: 24, rows: 4 }));
  const historyAfterCommit = [...terminal.scrollback];

  writer.write(frame([], ['body updated', 'tool result', 'editor', 'footer updated'], {
    row: 2,
    cell: 2,
  }, { columns: 24, rows: 4 }));

  assertEquals(terminal.visibleRows(), ['body updated', 'tool result', 'editor', 'footer updated']);
  assertEquals(terminal.scrollback, historyAfterCommit);
  assertEquals(occurrences(terminal.allRows(), 'committed turn'), 1);
  assertEquals(occurrences(terminal.allRows(), 'old footer'), 0);
  assertEquals(occurrences(terminal.allRows(), 'footer updated'), 1);
  assertEquals(terminal.cursor, { row: 2, cell: 2 });
  assertEquals(terminal.writes.some((write) => write.includes('\x1b[0J')), false);
  assertEquals(terminal.writes.some((write) => write.includes('\x1b[2K')), true);
  assertEquals(terminal.writes.some((write) => write.includes('\x1b[1B')), true);
});

Deno.test('retained conversation survives resize reflow while the remaining band redraws', () => {
  const terminal = new ScreenTerminal(20, 12);
  const writer = new ScrollbackWriter(terminal);
  const retainedBody = '界'.repeat(10);
  const reflowedBody = '文'.repeat(10);
  const oldEditor = '\x1b[36meditor> abcdefghijkl\x1b[0m';
  const oldFooter = 'footer 1234567890123';

  writer.write(frame([], [retainedBody, `\x1b[35m${reflowedBody}\x1b[0m`, oldEditor, oldFooter], {
    row: 2,
    cell: 8,
  }, { columns: 20, rows: 12 }));
  writer.retainPrefix(1);
  terminal.resize(10, 12);

  writer.write(frame([], ['body2 new', 'editor> ', 'footer!'], { row: 1, cell: 8 }, {
    columns: 10,
    rows: 12,
  }));

  assertEquals(terminal.visibleRows().slice(0, 5), [
    '界'.repeat(5),
    '界'.repeat(5),
    'body2 new',
    'editor>',
    'footer!',
  ]);
  assertEquals(occurrences(terminal.allRows(), '界'.repeat(5)), 2);
  assertEquals(occurrences(terminal.allRows(), '文'.repeat(5)), 0);
  assertEquals(occurrences(terminal.allRows(), oldFooter), 0);
  assertEquals(terminal.cursor, { row: 3, cell: 8 });
  assertEquals(terminal.writes.at(-1)?.includes('\x1b7'), true);
  assertEquals(terminal.writes.at(-1)?.includes('\x1b8'), true);
});

Deno.test('close erases the live band and leaves committed rows at its start', () => {
  const terminal = new ScreenTerminal(20, 6);
  const writer = new ScrollbackWriter(terminal);

  writer.write(frame([], ['partial assistant', 'editor> draft'], { row: 1, cell: 8 }, {
    columns: 20,
    rows: 6,
  }));
  writer.write(frame(['final answer'], ['assistant followup', 'editor> draft'], {
    row: 1,
    cell: 8,
  }, { columns: 20, rows: 6 }));
  writer.close();

  const visible = terminal.visibleRows();
  assertEquals(visible[0], 'final answer');
  assertEquals(visible.slice(1).every((row) => row === ''), true);
  assertEquals(occurrences(terminal.allRows(), 'final answer'), 1);
  assertEquals(occurrences(terminal.allRows(), 'assistant followup'), 0);
  assertEquals(terminal.cursor, { row: 1, cell: 0 });
  const writeCount = terminal.writes.length;
  writer.close();
  assertEquals(terminal.writes.length, writeCount);
});
