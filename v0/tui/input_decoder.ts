import {
  ALT_ENTER_XTERM,
  ESC_TIMEOUT_MS,
  InputDecodeError,
  type InputEvent,
  MAX_PASTE_BYTES,
  PASTE_BEGIN,
  PASTE_END,
} from './input_contract.ts';

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
      events.push({ kind: byte === 0x50 ? 'f1' : 'unknown' });
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
    if (byte === 0x01) {
      events.push({ kind: 'ctrl_a' });
      return;
    }
    if (byte === 0x02) {
      events.push({ kind: 'ctrl_b' });
      return;
    }
    if (byte === 0x05) {
      events.push({ kind: 'ctrl_e' });
      return;
    }
    if (byte === 0x06) {
      events.push({ kind: 'ctrl_f' });
      return;
    }
    if (byte === 0x15) {
      events.push({ kind: 'ctrl_u' });
      return;
    }
    if (byte === 0x10) {
      events.push({ kind: 'unknown' });
      return;
    }
    if (byte === 0x0e) {
      events.push({ kind: 'unknown' });
      return;
    }
    if (byte === 0x12) {
      events.push({ kind: 'unknown' });
      return;
    }
    if (byte === 0x07) {
      events.push({ kind: 'unknown' });
      return;
    }
    if (byte === 0x14) {
      events.push({ kind: 'unknown' });
      return;
    }
    if (byte === 0x0b) {
      events.push({ kind: 'ctrl_k' });
      return;
    }
    if (byte === 0x0c) {
      events.push({ kind: 'unknown' });
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
      if (byte === 0x62 || byte === 0x42) {
        this.escape = null;
        events.push({ kind: 'alt_b' });
        return;
      }
      if (byte === 0x66 || byte === 0x46) {
        this.escape = null;
        events.push({ kind: 'alt_f' });
        return;
      }
      if (byte === 0x64 || byte === 0x44) {
        this.escape = null;
        events.push({ kind: 'alt_d' });
        return;
      }
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
    if (matches(sequence, [0x1b, 0x5b, 0x35, 0x7e])) {
      events.push({ kind: 'page_up' });
      return;
    }
    if (matches(sequence, [0x1b, 0x5b, 0x36, 0x7e])) {
      events.push({ kind: 'page_down' });
      return;
    }
    if (matches(sequence, [0x1b, 0x5b, 0x31, 0x31, 0x7e])) {
      events.push({ kind: 'f1' });
      return;
    }
    // Modified Return keys (CSI-u / modifyOtherKeys): Shift=2, Alt=3, Ctrl=5.
    if (
      matches(sequence, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75]) ||
      matches(sequence, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x33, 0x75]) ||
      matches(sequence, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x35, 0x75])
    ) {
      events.push({ kind: 'newline' });
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
