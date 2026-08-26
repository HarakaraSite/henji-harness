const MAX_PASTE_BYTES = 64 * 1024;
const MAX_EDITOR_BYTES = 64 * 1024;
const ESC_TIMEOUT_MS = 50;
const PASTE_BEGIN = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];

export type InputEvent =
  | {
    readonly kind: 'printable';
    readonly text: string;
    readonly codePoint: number;
  }
  | { readonly kind: 'enter' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'ctrl_c' }
  | { readonly kind: 'ctrl_d' }
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

const matches = (
  value: readonly number[],
  expected: readonly number[],
): boolean =>
  value.length === expected.length &&
  value.every((byte, index) => byte === expected[index]);

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
  private paste = false;
  private pasteBytes: number[] = [];
  private pasteTerminator: number[] = [];
  private pasteRejected = false;
  private pendingCr = false;
  private escapeStartedAt = 0;

  private appendPasteBytes(bytes: Uint8Array): void {
    if (this.pasteRejected) return;
    const remaining = MAX_PASTE_BYTES + 1 - this.pasteBytes.length;
    if (remaining > 0) this.pasteBytes.push(...bytes.subarray(0, remaining));
    if (this.pasteBytes.length > MAX_PASTE_BYTES) this.pasteRejected = true;
  }

  feed(bytes: Uint8Array, now = Date.now()): InputEvent[] {
    const events: InputEvent[] = [];
    for (const byte of bytes) {
      if (
        this.escape !== null && now - this.escapeStartedAt >= ESC_TIMEOUT_MS
      ) {
        this.escape = null;
        events.push({ kind: 'escape' });
      }
      this.consume(byte, events, now);
    }
    return events;
  }

  push(bytes: Uint8Array, now = Date.now()): InputEvent[] {
    return this.feed(bytes, now);
  }

  /** Emit a lone Escape once the fixed timeout has elapsed. */
  poll(now = Date.now()): InputEvent[] {
    if (this.escape !== null && now - this.escapeStartedAt >= ESC_TIMEOUT_MS) {
      this.escape = null;
      return [{ kind: 'escape' }];
    }
    return [];
  }

  hasPendingEscape(): boolean {
    return this.escape !== null;
  }

  escapeDeadline(): number | undefined {
    return this.escape === null ? undefined : this.escapeStartedAt + ESC_TIMEOUT_MS;
  }

  /** EOF is a failure for partial UTF-8, CSI, or bracketed-paste framing. */
  end(): void {
    if (
      this.utf8.length > 0 || this.escape !== null || this.paste ||
      this.pasteTerminator.length > 0
    ) {
      throw new InputDecodeError();
    }
  }

  finish(): void {
    this.end();
  }

  private consume(byte: number, events: InputEvent[], now: number): void {
    if (this.paste) {
      this.consumePaste(byte, events);
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
    const width = utf8Width(byte);
    if (width === 1) {
      if (byte >= 0x20 && byte !== 0x7f) {
        events.push(printableEvent(String.fromCodePoint(byte)));
      } else events.push({ kind: 'unknown' });
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
    const expected = this.utf8Expected;
    const first = this.utf8[0];
    const position = this.utf8.length;
    const validSecond = position !== 1 ||
      (first !== 0xe0 && first !== 0xed && first !== 0xf0 && first !== 0xf4) ||
      (first === 0xe0 && byte >= 0xa0) || (first === 0xed && byte <= 0x9f) ||
      (first === 0xf0 && byte >= 0x90) || (first === 0xf4 && byte <= 0x8f);
    if (!isContinuation(byte) || !validSecond) {
      this.utf8 = [];
      this.utf8Expected = 0;
      events.push({ kind: 'invalid_utf8' });
      // A non-continuation byte may itself be the next valid input byte.
      this.consume(byte, events, Date.now());
      return;
    }
    this.utf8.push(byte);
    if (this.utf8.length !== expected) return;
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(
        new Uint8Array(this.utf8),
      );
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
      this.escape = null;
      events.push({ kind: 'escape' });
      this.consume(byte, events, now);
      return;
    }
    if (this.escape!.length <= 2) return;
    if (matches(this.escape!, PASTE_BEGIN)) {
      this.escape = null;
      this.paste = true;
      this.pasteBytes = [];
      this.pasteTerminator = [];
      this.pasteRejected = false;
      return;
    }
    // A CSI sequence ends at a final byte. Unknown sequences never mutate the editor.
    const final = byte >= 0x40 && byte <= 0x7e;
    if (final) {
      this.escape = null;
      events.push({ kind: 'unknown' });
    }
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
            const text = new TextDecoder('utf-8', { fatal: true }).decode(
              new Uint8Array(this.pasteBytes),
            );
            events.push({ kind: 'paste', text });
          } catch {
            events.push({ kind: 'paste_rejected' });
          }
          this.pasteBytes = [];
          this.pasteRejected = false;
          return;
        }
        return;
      }
      // It was an ESC inside paste, not the terminator: retain all candidate bytes.
      this.appendPasteBytes(Uint8Array.from(this.pasteTerminator));
      this.pasteTerminator = [];
      return;
    }
    this.appendPasteBytes(Uint8Array.of(byte));
  }
}

export class TuiEditor {
  private value = '';

  get text(): string {
    return this.value;
  }

  get byteLength(): number {
    return new TextEncoder().encode(this.value).byteLength;
  }

  clear(): void {
    this.value = '';
  }

  append(text: string): boolean {
    const bytes = new TextEncoder().encode(text).byteLength;
    if (this.byteLength + bytes > MAX_EDITOR_BYTES) return false;
    this.value += text;
    return true;
  }

  backspace(): boolean {
    if (this.value.length === 0) return false;
    const points = [...this.value];
    points.pop();
    this.value = points.join('');
    return true;
  }

  submit(): string | null {
    if (this.value.trim().length === 0) return null;
    return this.value;
  }
}

export const INPUT_ESC_TIMEOUT_MS = ESC_TIMEOUT_MS;
export const INPUT_MAX_BYTES = MAX_EDITOR_BYTES;
export const INPUT_MAX_PASTE_BYTES = MAX_PASTE_BYTES;
