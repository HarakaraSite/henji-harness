import { type EditorSnapshot, MAX_EDITOR_BYTES } from './input_contract.ts';
import { byteLength, isWellFormed, scalarIndexToOffset, scalars } from './input_value.ts';
import { moveEditorCursorVertically } from './input_layout.ts';

/** Bounded scalar-aware multiline editor. The editor is the only mutable text owner. */
export class TuiEditor {
  private value = '';
  private cursor = 0;
  private preferredColumn: number | null = null;
  get text(): string {
    return this.value;
  }
  get cursorScalar(): number {
    return this.cursor;
  }
  get byteLength(): number {
    return byteLength(this.value);
  }
  snapshot(): EditorSnapshot {
    return Object.freeze({
      text: this.value,
      cursorScalar: this.cursor,
      byteLength: this.byteLength,
    });
  }
  clear(): void {
    this.value = '';
    this.cursor = 0;
    this.preferredColumn = null;
  }
  setSnapshot(snapshot: EditorSnapshot): boolean {
    if (
      !this.acceptable(snapshot.text) || !Number.isInteger(snapshot.cursorScalar) ||
      snapshot.cursorScalar < 0 || snapshot.cursorScalar > scalars(snapshot.text).length
    ) return false;
    this.value = snapshot.text;
    this.cursor = snapshot.cursorScalar;
    this.preferredColumn = null;
    return true;
  }
  setCursorScalar(cursor: number): boolean {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > scalars(this.value).length) {
      return false;
    }
    this.cursor = cursor;
    this.preferredColumn = null;
    return true;
  }
  append(text: string): boolean {
    return this.insert(text);
  }
  insert(text: string): boolean {
    if (!this.acceptable(text) || this.byteLength + byteLength(text) > MAX_EDITOR_BYTES) {
      return false;
    }
    const offset = scalarIndexToOffset(this.value, this.cursor);
    this.value = `${this.value.slice(0, offset)}${text}${this.value.slice(offset)}`;
    this.cursor += scalars(text).length;
    this.preferredColumn = null;
    return true;
  }
  paste(text: string): boolean {
    return this.insert(text);
  }
  backspace(): boolean {
    if (this.cursor === 0) return false;
    const points = scalars(this.value);
    points.splice(this.cursor - 1, 1);
    this.value = points.join('');
    this.cursor -= 1;
    this.preferredColumn = null;
    return true;
  }
  moveLeft(): boolean {
    if (this.cursor === 0) return false;
    this.cursor -= 1;
    this.preferredColumn = null;
    return true;
  }
  moveRight(): boolean {
    if (this.cursor >= scalars(this.value).length) return false;
    this.cursor += 1;
    this.preferredColumn = null;
    return true;
  }
  home(): boolean {
    const points = scalars(this.value);
    let start = this.cursor;
    while (start > 0 && points[start - 1] !== '\n') start -= 1;
    const changed = start !== this.cursor;
    this.cursor = start;
    this.preferredColumn = null;
    return changed;
  }
  end(): boolean {
    const points = scalars(this.value);
    let finish = this.cursor;
    while (finish < points.length && points[finish] !== '\n') finish += 1;
    const changed = finish !== this.cursor;
    this.cursor = finish;
    this.preferredColumn = null;
    return changed;
  }
  moveUp(columns: number): boolean {
    return this.moveVertical(-1, columns);
  }
  moveDown(columns: number): boolean {
    return this.moveVertical(1, columns);
  }
  private moveVertical(direction: -1 | 1, columns: number): boolean {
    const moved = moveEditorCursorVertically(
      { text: this.value, cursorScalar: this.cursor },
      columns,
      direction,
      this.preferredColumn,
    );
    if (moved === undefined) return false;
    this.cursor = moved.cursor;
    this.preferredColumn = moved.preferredColumn;
    return true;
  }
  submit(): string | null {
    return this.value.trim().length === 0 ? null : this.value;
  }
  private acceptable(text: string): boolean {
    return typeof text === 'string' && isWellFormed(text) && !text.includes('\0') &&
      byteLength(text) <= MAX_EDITOR_BYTES;
  }
}
