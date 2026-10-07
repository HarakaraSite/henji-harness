import type { EditorSnapshot } from './input_contract.ts';
import { cellWidth, escapeTerminalText, segmentTerminalText } from './terminal_text.ts';

interface EditorRow {
  readonly text: string;
  readonly scalarStart: number;
  readonly scalarEnd: number;
}

/** The displayed editor rows and cursor share the same wrapping and source coordinates. */
export const layoutEditorText = (
  snapshot: Pick<EditorSnapshot, 'text' | 'cursorScalar'>,
  columns: number,
) => {
  const segments = segmentTerminalText(snapshot.text);
  const cursor = snapshot.cursorScalar;
  const rows: EditorRow[] = [];
  let text = '';
  let used = 0;
  let scalarStart = 0;
  let scalarEnd = 0;
  let cursorRow = 0;
  let cursorCell = 0;
  let cursorSet = false;
  const push = (): void => {
    rows.push({ text, scalarStart, scalarEnd });
    text = '';
    used = 0;
    scalarStart = scalarEnd;
  };
  for (const segment of segments) {
    if (segment.text === '\n') {
      if (!cursorSet && cursor >= segment.scalarStart && cursor < segment.scalarEnd) {
        cursorRow = rows.length;
        cursorCell = used;
        cursorSet = true;
      }
      push();
      scalarStart = scalarEnd = segment.scalarEnd;
      continue;
    }
    const display = escapeTerminalText(segment.text);
    const cells = cellWidth(display);
    if (text.length > 0 && used + cells > columns) push();
    if (!cursorSet && cursor >= segment.scalarStart && cursor < segment.scalarEnd) {
      cursorRow = rows.length;
      cursorCell = used;
      cursorSet = true;
    }
    text += display;
    used += cells;
    scalarEnd = segment.scalarEnd;
  }
  if (!cursorSet) {
    cursorRow = rows.length;
    cursorCell = used;
  }
  push();
  return { rows, cursorRow, cursorCell };
};

export const moveEditorCursorVertically = (
  snapshot: Pick<EditorSnapshot, 'text' | 'cursorScalar'>,
  columns: number,
  direction: -1 | 1,
  preferredColumn: number | null,
): { cursor: number; preferredColumn: number } | undefined => {
  const layout = layoutEditorText(snapshot, columns);
  const index = layout.cursorRow + direction;
  const row = layout.rows[index];
  if (row === undefined) return undefined;
  const column = preferredColumn ?? layout.cursorCell;
  const source = [...snapshot.text].slice(row.scalarStart, row.scalarEnd).join('');
  let used = 0;
  let cursor = row.scalarStart;
  let lastStart = cursor;
  for (const segment of segmentTerminalText(source)) {
    const cells = cellWidth(escapeTerminalText(segment.text));
    if (used + cells > column) break;
    used += cells;
    lastStart = row.scalarStart + segment.scalarStart;
    cursor = row.scalarStart + segment.scalarEnd;
  }
  // A wrap boundary belongs to the next displayed row; keep this move in its target row.
  if (cursor === row.scalarEnd && layout.rows[index + 1]?.scalarStart === cursor) {
    cursor = lastStart;
  }
  return { cursor, preferredColumn: column };
};
