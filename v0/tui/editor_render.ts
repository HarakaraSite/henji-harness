import type { EditorSnapshot } from './input.ts';
import type { PendingMetadataSnapshot } from './pending_input.ts';
import { escapeTerminalText } from './terminal_text.ts';

const isFullwidthForm = (code: number): boolean =>
  (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);
export const cellWidth = (character: string): number => {
  const code = character.codePointAt(0)!;
  // Conservative width for common full-width/emoji ranges; combining marks consume no extra cell.
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
    if (force || line.length > 0 || all.length === 0) {
      all.push({ text: line, cursorCell: null });
    }
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
    const widthOf = [...escaped].reduce(
      (sum, character) => sum + cellWidth(character),
      0,
    );
    if (line.length > 0 && used + widthOf > width) push();
    line += escaped;
    used += widthOf;
  }
  if (all.length === 0) all.push({ text: '', cursorCell: cursorCell });
  const first = Math.max(
    0,
    Math.min(cursorRow - limit + 1, all.length - limit),
  );
  const visible = all.slice(first, first + limit).map((row, index) =>
    Object.freeze({
      ...row,
      cursorCell: first + index === cursorRow ? cursorCell : null,
    })
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
  const live = snapshot.lanes.filter((lane) => lane.present);
  const code = (lifecycle: string): string =>
    lifecycle === 'draft'
      ? 'd'
      : lifecycle === 'active_uncommitted'
      ? 'a'
      : lifecycle === 'admitted_unconsumed'
      ? 'u'
      : 'q';
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
  return Object.freeze(rows);
};
