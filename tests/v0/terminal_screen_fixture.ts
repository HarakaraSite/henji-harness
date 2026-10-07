import type { ScreenFrame } from '../../v0/tui/screen_frame.ts';
import { segmentTerminalText } from '../../v0/tui/terminal_text.ts';

/** Minimal terminal screen for inspecting the actual normal-screen byte stream in UI tests. */
export class TerminalScreen {
  private lines: string[][];
  private row = 0;
  private cell = 0;
  private wrap = false;
  private saved: { row: number; cell: number; wrap: boolean } | undefined;
  readonly history: string[] = [];
  constructor(private columns = 80, private rows = 24) {
    this.lines = Array.from({ length: rows }, () => this.blank());
  }
  private blank(): string[] {
    return Array(this.columns).fill(' ');
  }
  resize(columns: number, rows: number): void {
    if (columns === this.columns && rows === this.rows) return;
    this.columns = columns;
    this.lines = this.lines.map((
      line,
    ) => [
      ...line.slice(0, columns),
      ...Array(Math.max(0, columns - line.length)).fill(' '),
    ]);
    while (this.lines.length > rows) {
      this.history.push(this.lines.shift()!.join(''));
      this.row--;
    }
    while (this.lines.length < rows) this.lines.push(this.blank());
    this.rows = rows;
    this.row = Math.max(0, Math.min(rows - 1, this.row));
    this.cell = Math.min(columns - 1, this.cell);
    this.wrap = false;
  }
  write(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    for (
      // deno-lint-ignore no-control-regex
      const token of text.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[78]|\r|\n|[^\x1b\r\n]+/g) ??
        []
    ) {
      if (token === '\x1b7') {
        this.saved = { row: this.row, cell: this.cell, wrap: this.wrap };
      } else if (token === '\x1b8') {
        if (this.saved !== undefined) {
          this.row = this.saved.row;
          this.cell = this.saved.cell;
          this.wrap = this.saved.wrap;
        }
      } else if (token.startsWith('\x1b[')) {
        const command = token.at(-1);
        const parameters = token.slice(2, -1).split(';').map(Number);
        const amount = parameters[0] || 1;
        if (command === 'A') this.row = Math.max(0, this.row - amount);
        if (command === 'B') {
          this.row = Math.min(this.rows - 1, this.row + amount);
        }
        if (command === 'C') {
          this.cell = Math.min(this.columns - 1, this.cell + amount);
        }
        if (command === 'H') {
          this.row = Math.min(this.rows - 1, amount - 1);
          this.cell = (parameters[1] || 1) - 1;
        }
        if (command === 'J' && (parameters[0] === 0 || parameters[0] === 2)) {
          if (parameters[0] === 2) {
            this.lines = Array.from({ length: this.rows }, () => this.blank());
          } else {
            this.lines[this.row].fill(' ', this.cell);
            for (let i = this.row + 1; i < this.rows; i++) {
              this.lines[i].fill(' ');
            }
          }
        }
        if (command === 'K') {
          this.lines[this.row].fill(' ', parameters[0] === 2 ? 0 : this.cell);
        }
        if (command !== 'm') this.wrap = false;
      } else if (token === '\r') {
        this.cell = 0;
        this.wrap = false;
      } else if (token === '\n') this.lineFeed();
      else {for (const segment of segmentTerminalText(token)) {
          if (segment.cellWidth === 0) continue;
          if (this.wrap || this.cell + segment.cellWidth > this.columns) {
            this.lineFeed();
            this.cell = 0;
          }
          this.lines[this.row][this.cell] = segment.text;
          for (let i = 1; i < segment.cellWidth; i++) {
            this.lines[this.row][this.cell + i] = '';
          }
          if (this.cell + segment.cellWidth >= this.columns) {
            this.cell = this.columns - 1;
            this.wrap = true;
          } else this.cell += segment.cellWidth;
        }}
    }
  }
  private lineFeed(): void {
    this.wrap = false;
    if (this.row === this.rows - 1) {
      this.history.push(this.lines.shift()!.join('').trimEnd());
      this.lines.push(this.blank());
    } else this.row++;
  }
  frame(): ScreenFrame {
    return {
      rows: this.lines.map((line) => line.join('').trimEnd()),
      cursor: { row: this.row, cell: this.cell },
      size: { columns: this.columns, rows: this.rows },
      scope: 'terminal',
      geometryGeneration: 0,
    };
  }
}
