const MAX_PASTE_BYTES = 64 * 1024;
const MAX_EDITOR_BYTES = 64 * 1024;
const MAX_HISTORY_ENTRIES = 32;
const MAX_HISTORY_BYTES = 256 * 1024;
const ESC_TIMEOUT_MS = 50;
const PASTE_BEGIN = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];
const ALT_ENTER_XTERM = [0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x33, 0x3b, 0x31, 0x33, 0x7e];

export interface EditorSnapshot {
  readonly text: string;
  readonly cursorScalar: number;
  readonly byteLength: number;
}

export type InputEvent =
  | { readonly kind: 'printable'; readonly text: string; readonly codePoint: number }
  | { readonly kind: 'enter' }
  | { readonly kind: 'alt_enter' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'ctrl_c' }
  | { readonly kind: 'ctrl_d' }
  | { readonly kind: 'ctrl_o' }
  | { readonly kind: 'ctrl_w' }
  | { readonly kind: 'ctrl_p' }
  | { readonly kind: 'ctrl_n' }
  | { readonly kind: 'ctrl_r' }
  | { readonly kind: 'ctrl_g' }
  | { readonly kind: 'ctrl_t' }
  | { readonly kind: 'ctrl_k' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'left' }
  | { readonly kind: 'right' }
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'home' }
  | { readonly kind: 'end' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid_utf8' }
  | { readonly kind: 'paste'; readonly text: string }
  | { readonly kind: 'paste_rejected' };

export class InputDecodeError extends Error {
  constructor(message = 'incomplete terminal input') {
    super(message);
    this.name = 'InputDecodeError';
  }
}

const utf8Width = (byte: number): number => {
  if (byte <= 0x7f) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
};
const isContinuation = (byte: number): boolean => byte >= 0x80 && byte <= 0xbf;
const matches = (value: readonly number[], expected: readonly number[]): boolean =>
  value.length === expected.length && value.every((byte, index) => byte === expected[index]);
const printableEvent = (text: string): InputEvent => ({
  kind: 'printable',
  text,
  codePoint: text.codePointAt(0)!,
});

/** Strict stateful decoder for terminal bytes and bracketed paste framing. */
export class InputDecoder {
  private utf8: number[] = [];
  private utf8Expected = 0;
  private escape: number[] | null = null;
  private expiredXterm: number[] | null = null;
  private paste = false;
  private pasteBytes: number[] = [];
  private pasteTerminator: number[] = [];
  private pasteRejected = false;
  private pendingCr = false;
  private escapeStartedAt = 0;
  // A second Escape sequence immediately after a timed bare Escape belongs to the same
  // timeout recovery boundary. Preserve the pre-existing consume-as-unknown behavior.
  private unknownAfterBareEscape = false;
  private expiredCsi: number[] | null = null;
  // SS3 (ESC O …) is intentionally unsupported, but its short sequence must be consumed as one
  // event so a function-key payload can never become prompt text. A timed-out prefix retains the
  // same no-fallback rule for its eventual byte.
  private ss3Pending = false;
  private expiredSs3 = false;
  private ss3StartedAt = 0;

  private appendPasteBytes(bytes: Uint8Array): void {
    if (this.pasteRejected) return;
    const remaining = MAX_PASTE_BYTES + 1 - this.pasteBytes.length;
    if (remaining > 0) this.pasteBytes.push(...bytes.subarray(0, remaining));
    if (this.pasteBytes.length > MAX_PASTE_BYTES) this.pasteRejected = true;
  }
  feed(bytes: Uint8Array, now = Date.now()): InputEvent[] {
    const events: InputEvent[] = [];
    for (const byte of bytes) {
      if (this.escape !== null && now - this.escapeStartedAt >= ESC_TIMEOUT_MS) {
        this.expireEscape(events);
      }
      if (this.ss3Pending && now - this.ss3StartedAt >= ESC_TIMEOUT_MS) {
        this.expireSs3(events);
      }
      this.consume(byte, events, now);
    }
    return events;
  }
  push(bytes: Uint8Array, now = Date.now()): InputEvent[] {
    return this.feed(bytes, now);
  }
  poll(now = Date.now()): InputEvent[] {
    if (this.escape !== null && now - this.escapeStartedAt >= ESC_TIMEOUT_MS) {
      const events: InputEvent[] = [];
      this.expireEscape(events);
      return events;
    }
    if (this.ss3Pending && now - this.ss3StartedAt >= ESC_TIMEOUT_MS) {
      const events: InputEvent[] = [];
      this.expireSs3(events);
      return events;
    }
    return [];
  }
  hasPendingEscape(): boolean {
    return this.escape !== null || this.ss3Pending;
  }
  escapeDeadline(): number | undefined {
    if (this.escape !== null) return this.escapeStartedAt + ESC_TIMEOUT_MS;
    return this.ss3Pending ? this.ss3StartedAt + ESC_TIMEOUT_MS : undefined;
  }
  end(): void {
    if (
      this.utf8.length > 0 || this.escape !== null || this.expiredCsi !== null ||
      (this.expiredXterm !== null && this.expiredXterm.length === 2) || this.ss3Pending ||
      this.expiredSs3 || this.paste ||
      this.pasteTerminator.length > 0
    ) throw new InputDecodeError();
  }
  finish(): void {
    this.end();
  }

  private consume(byte: number, events: InputEvent[], now: number): void {
    if (this.paste) {
      this.consumePaste(byte, events);
      return;
    }
    if (this.ss3Pending || this.expiredSs3) {
      this.ss3Pending = false;
      this.expiredSs3 = false;
      events.push({ kind: 'unknown' });
      return;
    }
    if (this.expiredXterm !== null) {
      const index = this.expiredXterm.length;
      if (byte === ALT_ENTER_XTERM[index]) {
        this.expiredXterm.push(byte);
        if (this.expiredXterm.length === ALT_ENTER_XTERM.length) {
          const replay = this.expiredXterm.slice(1);
          this.expiredXterm = null;
          for (const replayByte of replay) this.consume(replayByte, events, now);
        }
        return;
      }
      // A timed CSI prefix is still consumed as one unsupported sequence when it diverges from
      // the legacy xterm Alt+Enter form. Its payload must never fall through as printable text.
      this.expiredCsi = [...this.expiredXterm, byte];
      this.expiredXterm = null;
      if (byte >= 0x40 && byte <= 0x7e) {
        this.expiredCsi = null;
        events.push({ kind: 'unknown' });
      }
      return;
    }
    if (this.expiredCsi !== null) {
      this.expiredCsi.push(byte);
      if (byte >= 0x40 && byte <= 0x7e) {
        this.expiredCsi = null;
        events.push({ kind: 'unknown' });
      }
      return;
    }
    if (this.escape !== null) {
      this.consumeEscape(byte, events, now);
      return;
    }
    if (this.pendingCr) {
      this.pendingCr = false;
      if (byte === 0x0a) return;
    }
    if (this.utf8.length > 0) {
      this.consumeUtf8Continuation(byte, events);
      return;
    }
    if (byte === 0x1b) {
      this.escape = [byte];
      this.escapeStartedAt = now;
      return;
    }
    if (byte === 0x0d) {
      this.pendingCr = true;
      events.push({ kind: 'enter' });
      return;
    }
    if (byte === 0x0a) {
      events.push({ kind: 'enter' });
      return;
    }
    if (byte === 0x08 || byte === 0x7f) {
      events.push({ kind: 'backspace' });
      return;
    }
    if (byte === 0x03) {
      events.push({ kind: 'ctrl_c' });
      return;
    }
    if (byte === 0x04) {
      events.push({ kind: 'ctrl_d' });
      return;
    }
    if (byte === 0x0f) {
      events.push({ kind: 'ctrl_o' });
      return;
    }
    if (byte === 0x17) {
      events.push({ kind: 'ctrl_w' });
      return;
    }
    if (byte === 0x10) {
      events.push({ kind: 'ctrl_p' });
      return;
    }
    if (byte === 0x0e) {
      events.push({ kind: 'ctrl_n' });
      return;
    }
    if (byte === 0x12) {
      events.push({ kind: 'ctrl_r' });
      return;
    }
    if (byte === 0x07) {
      events.push({ kind: 'ctrl_g' });
      return;
    }
    if (byte === 0x14) {
      events.push({ kind: 'ctrl_t' });
      return;
    }
    if (byte === 0x0b) {
      events.push({ kind: 'ctrl_k' });
      return;
    }
    if (byte === 0x09) {
      events.push({ kind: 'tab' });
      return;
    }
    const width = utf8Width(byte);
    if (width === 1) {
      if (byte >= 0x20 && byte !== 0x7f) events.push(printableEvent(String.fromCodePoint(byte)));
      else events.push({ kind: 'unknown' });
      return;
    }
    if (width === 0) {
      events.push({ kind: 'invalid_utf8' });
      return;
    }
    this.utf8 = [byte];
    this.utf8Expected = width;
  }
  private consumeUtf8Continuation(byte: number, events: InputEvent[]): void {
    const expected = this.utf8Expected, first = this.utf8[0], position = this.utf8.length;
    const validSecond = position !== 1 ||
      (first !== 0xe0 && first !== 0xed && first !== 0xf0 && first !== 0xf4) ||
      (first === 0xe0 && byte >= 0xa0) || (first === 0xed && byte <= 0x9f) ||
      (first === 0xf0 && byte >= 0x90) || (first === 0xf4 && byte <= 0x8f);
    if (!isContinuation(byte) || !validSecond) {
      this.utf8 = [];
      this.utf8Expected = 0;
      events.push({ kind: 'invalid_utf8' });
      this.consume(byte, events, Date.now());
      return;
    }
    this.utf8.push(byte);
    if (this.utf8.length !== expected) return;
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(this.utf8));
      this.utf8 = [];
      this.utf8Expected = 0;
      events.push(printableEvent(value));
    } catch {
      this.utf8 = [];
      this.utf8Expected = 0;
      events.push({ kind: 'invalid_utf8' });
    }
  }
  private consumeEscape(byte: number, events: InputEvent[], now: number): void {
    this.escape!.push(byte);
    if (this.escape!.length === 2 && byte !== 0x5b) {
      if (byte === 0x4f) {
        this.ss3Pending = true;
        this.ss3StartedAt = this.escapeStartedAt;
        this.escape = null;
        return;
      }
      this.escape = null;
      if (byte === 0x0d || byte === 0x0a) {
        if (byte === 0x0d) this.pendingCr = true;
        events.push({ kind: 'alt_enter' });
        return;
      }
      events.push({ kind: 'escape' });
      this.consume(byte, events, now);
      return;
    }
    if (this.escape!.length <= 2) return;
    if (matches(this.escape!, ALT_ENTER_XTERM)) {
      this.escape = null;
      events.push({ kind: 'alt_enter' });
      return;
    }
    if (matches(this.escape!, PASTE_BEGIN)) {
      this.escape = null;
      this.paste = true;
      this.pasteBytes = [];
      this.pasteTerminator = [];
      this.pasteRejected = false;
      return;
    }
    const sequence = this.escape!, final = byte >= 0x40 && byte <= 0x7e;
    if (!final) return;
    this.escape = null;
    if (sequence.length === 3) {
      const key = String.fromCharCode(sequence[2]);
      const event = ({ D: 'left', C: 'right', A: 'up', B: 'down', H: 'home', F: 'end' } as Record<
        string,
        InputEvent['kind']
      >)[key];
      if (event !== undefined && !this.unknownAfterBareEscape) {
        events.push({ kind: event } as InputEvent);
        this.unknownAfterBareEscape = false;
        return;
      }
      this.unknownAfterBareEscape = false;
    }
    if (matches(sequence, [0x1b, 0x5b, 0x31, 0x7e])) {
      events.push({ kind: 'home' });
      return;
    }
    if (matches(sequence, [0x1b, 0x5b, 0x34, 0x7e])) {
      events.push({ kind: 'end' });
      return;
    }
    events.push({ kind: 'unknown' });
  }
  private expireEscape(events: InputEvent[]): void {
    const escaped = this.escape;
    this.escape = null;
    events.push({ kind: 'escape' });
    if (escaped !== null && escaped.length === 2 && escaped[1] === 0x4f) {
      this.expiredSs3 = true;
      this.ss3StartedAt = this.escapeStartedAt;
    }
    this.expiredXterm = escaped !== null && escaped.length > 1 && escaped[1] === 0x5b
      ? escaped
      : null;
    this.expiredCsi = null;
    this.unknownAfterBareEscape = escaped?.length === 1;
  }
  private expireSs3(events: InputEvent[]): void {
    this.ss3Pending = false;
    this.expiredSs3 = true;
    events.push({ kind: 'escape' });
  }
  private consumePaste(byte: number, events: InputEvent[]): void {
    if (this.pasteTerminator.length > 0 || byte === 0x1b) {
      this.pasteTerminator.push(byte);
      if (
        PASTE_END.slice(0, this.pasteTerminator.length).every((v, i) =>
          v === this.pasteTerminator[i]
        )
      ) {
        if (this.pasteTerminator.length === PASTE_END.length) {
          this.paste = false;
          this.pasteTerminator = [];
          if (this.pasteRejected || this.pasteBytes.length > MAX_PASTE_BYTES) {
            events.push({ kind: 'paste_rejected' });
            this.pasteBytes = [];
            this.pasteRejected = false;
            return;
          }
          try {
            events.push({
              kind: 'paste',
              text: new TextDecoder('utf-8', { fatal: true }).decode(
                new Uint8Array(this.pasteBytes),
              ),
            });
          } catch {
            events.push({ kind: 'paste_rejected' });
          }
          this.pasteBytes = [];
          this.pasteRejected = false;
          return;
        }
        return;
      }
      this.appendPasteBytes(Uint8Array.from(this.pasteTerminator));
      this.pasteTerminator = [];
      return;
    }
    this.appendPasteBytes(Uint8Array.of(byte));
  }
}

const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
const scalars = (text: string): string[] => [...text];
const scalarIndexToOffset = (text: string, index: number): number => {
  let offset = 0, scalar = 0;
  for (const character of text) {
    if (scalar >= index) break;
    offset += character.length;
    scalar += 1;
  }
  return offset;
};
const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

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
  wordDelete(): boolean {
    return this.deleteWordBackward();
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
  moveHome(): boolean {
    return this.home();
  }
  moveEnd(): boolean {
    return this.end();
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

export const INPUT_ESC_TIMEOUT_MS = ESC_TIMEOUT_MS;
export const INPUT_MAX_BYTES = MAX_EDITOR_BYTES;
export const INPUT_MAX_PASTE_BYTES = MAX_PASTE_BYTES;
export const INPUT_MAX_HISTORY_ENTRIES = MAX_HISTORY_ENTRIES;
export const INPUT_MAX_HISTORY_BYTES = MAX_HISTORY_BYTES;
