const encoder = new TextEncoder();

/** A fully composed retained screen, with zero-based terminal coordinates. */
export interface ScreenFrame {
  readonly rows: readonly string[];
  readonly cursor: { readonly row: number; readonly cell: number };
  readonly size: { readonly columns: number; readonly rows: number };
  /** Identifies the Core epoch and Session represented by this frame. */
  readonly scope: string;
  /** Advances on every resize notification, including a return to the same dimensions. */
  readonly geometryGeneration: number;
}

const sameGeometry = (left: ScreenFrame, right: ScreenFrame): boolean =>
  left.size.columns === right.size.columns && left.size.rows === right.size.rows &&
  left.scope === right.scope && left.geometryGeneration === right.geometryGeneration;

const rowAt = (frame: ScreenFrame, row: number): string => frame.rows[row] ?? '';

const cup = (row: number, cell: number): string => `\x1b[${row + 1};${cell + 1}H`;

/**
 * Encode one synchronized screen update. A missing or incompatible baseline repaints every row;
 * a compatible baseline updates only changed rows and the cursor.
 */
export const encodeScreenFrame = (
  frame: ScreenFrame,
  previous?: ScreenFrame,
): Uint8Array => {
  const full = previous === undefined || !sameGeometry(previous, frame);
  const output: string[] = ['\x1b[?2026h'];
  let changed = full;

  for (let row = 0; row < frame.size.rows; row += 1) {
    const nextLine = rowAt(frame, row);
    if (!full && nextLine === rowAt(previous!, row)) continue;
    changed = true;
    output.push(cup(row, 0), nextLine, '\x1b[K');
  }

  const cursorChanged = changed || previous!.cursor.row !== frame.cursor.row ||
    previous!.cursor.cell !== frame.cursor.cell;
  if (cursorChanged) {
    changed = true;
    output.push(cup(frame.cursor.row, frame.cursor.cell));
  }

  if (!changed) return new Uint8Array();
  output.push('\x1b[?2026l');
  return encoder.encode(output.join(''));
};
