import {
  type EditorSnapshot,
  MAX_EDITOR_BYTES,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
} from './input_contract.ts';
import { byteLength, isWellFormed, scalars } from './input_value.ts';

export interface EditorHistoryEntry {
  readonly text: string;
}
/** Process-local bounded ordinary prompt history, separate from session history. */
export class TuiEditorHistory {
  private entries: string[] = [];
  private totalBytes = 0;
  private cursor: number | null = null;
  private draft: EditorSnapshot | null = null;
  get length(): number {
    return this.entries.length;
  }
  get byteLength(): number {
    return this.totalBytes;
  }
  get navigating(): boolean {
    return this.cursor !== null;
  }
  snapshot(): readonly EditorHistoryEntry[] {
    return Object.freeze(this.entries.map((text) => Object.freeze({ text })));
  }
  record(text: string): boolean {
    if (!isWellFormed(text) || text.trim().length === 0 || byteLength(text) > MAX_EDITOR_BYTES) {
      return false;
    }
    if (this.entries.at(-1) === text) {
      this.resetNavigation();
      return true;
    }
    this.entries.push(text);
    this.totalBytes += byteLength(text);
    while (this.entries.length > MAX_HISTORY_ENTRIES || this.totalBytes > MAX_HISTORY_BYTES) {
      const removed = this.entries.shift()!;
      this.totalBytes -= byteLength(removed);
    }
    this.resetNavigation();
    return true;
  }
  previous(current: EditorSnapshot): EditorSnapshot | null {
    if (this.entries.length === 0) return null;
    if (this.cursor === null) {
      this.draft = current;
      this.cursor = this.entries.length - 1;
    } else if (this.cursor > 0) this.cursor -= 1;
    const text = this.entries[this.cursor];
    return Object.freeze({
      text,
      cursorScalar: scalars(text).length,
      byteLength: byteLength(text),
    });
  }
  next(): EditorSnapshot | null {
    if (this.cursor === null) return null;
    if (this.cursor < this.entries.length - 1) {
      this.cursor += 1;
      const text = this.entries[this.cursor];
      return Object.freeze({
        text,
        cursorScalar: scalars(text).length,
        byteLength: byteLength(text),
      });
    }
    const draft = this.draft;
    this.resetNavigation();
    return draft === null ? null : Object.freeze({ ...draft });
  }
  resetNavigation(): void {
    this.cursor = null;
    this.draft = null;
  }
}
