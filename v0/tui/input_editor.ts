import { type EditorSnapshot, MAX_EDITOR_BYTES } from './input_contract.ts';
import { byteLength, isWellFormed, scalarIndexToOffset, scalars } from './input_value.ts';

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
  deleteWordBackward(): boolean {
    if (this.cursor === 0) return false;
    const points = scalars(this.value);
    let start = this.cursor;
    while (start > 0 && /^\s$/u.test(points[start - 1])) start -= 1;
    while (start > 0 && !/^\s$/u.test(points[start - 1])) start -= 1;
    if (start === this.cursor) return false;
    points.splice(start, this.cursor - start);
    this.value = points.join('');
    this.cursor = start;
    this.preferredColumn = null;
    return true;
  }
  deleteWordForward(): boolean {
    if (this.cursor >= scalars(this.value).length) return false;
    const points = scalars(this.value);
    let finish = this.cursor;
    while (finish < points.length && /^\s$/u.test(points[finish])) finish += 1;
    while (finish < points.length && !/^\s$/u.test(points[finish])) finish += 1;
    if (finish === this.cursor) return false;
    points.splice(this.cursor, finish - this.cursor);
    this.value = points.join('');
    this.preferredColumn = null;
    return true;
  }
  deleteToLineStart(): boolean {
    const points = scalars(this.value);
    let start = this.cursor;
    while (start > 0 && points[start - 1] !== '\n') start -= 1;
    if (start === this.cursor) return false;
    points.splice(start, this.cursor - start);
    this.value = points.join('');
    this.cursor = start;
    this.preferredColumn = null;
    return true;
  }
  deleteToLineEnd(): boolean {
    const points = scalars(this.value);
    let finish = this.cursor;
    while (finish < points.length && points[finish] !== '\n') finish += 1;
    if (finish === this.cursor) return false;
    points.splice(this.cursor, finish - this.cursor);
    this.value = points.join('');
    this.preferredColumn = null;
    return true;
  }
  moveWordLeft(): boolean {
    if (this.cursor === 0) return false;
    const points = scalars(this.value);
    let position = this.cursor;
    while (position > 0 && /^\s$/u.test(points[position - 1])) position -= 1;
    while (position > 0 && !/^\s$/u.test(points[position - 1])) position -= 1;
    if (position === this.cursor) return false;
    this.cursor = position;
    this.preferredColumn = null;
    return true;
  }
  moveWordRight(): boolean {
    if (this.cursor >= scalars(this.value).length) return false;
    const points = scalars(this.value);
    let position = this.cursor;
    while (position < points.length && /^\s$/u.test(points[position])) position += 1;
    while (position < points.length && !/^\s$/u.test(points[position])) position += 1;
    if (position === this.cursor) return false;
    this.cursor = position;
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
  moveUp(): boolean {
    return this.moveVertical(-1);
  }
  moveDown(): boolean {
    return this.moveVertical(1);
  }
  private moveVertical(direction: -1 | 1): boolean {
    const points = scalars(this.value);
    let lineStart = this.cursor;
    while (lineStart > 0 && points[lineStart - 1] !== '\n') lineStart -= 1;
    const column = this.cursor - lineStart, preferred = this.preferredColumn ?? column;
    let targetStart: number;
    if (direction < 0) {
      if (lineStart === 0) return false;
      targetStart = lineStart - 1;
      while (targetStart > 0 && points[targetStart - 1] !== '\n') targetStart -= 1;
    } else {
      let currentEnd = lineStart;
      while (currentEnd < points.length && points[currentEnd] !== '\n') currentEnd += 1;
      if (currentEnd >= points.length) return false;
      targetStart = currentEnd + 1;
    }
    let targetEnd = targetStart;
    while (targetEnd < points.length && points[targetEnd] !== '\n') targetEnd += 1;
    this.cursor = Math.min(targetEnd, targetStart + preferred);
    this.preferredColumn = preferred;
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
