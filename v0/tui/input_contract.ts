export const MAX_PASTE_BYTES = 64 * 1024;
export const MAX_EDITOR_BYTES = 64 * 1024;
export const MAX_HISTORY_ENTRIES = 32;
export const MAX_HISTORY_BYTES = 256 * 1024;
export const ESC_TIMEOUT_MS = 50;
export const PASTE_BEGIN = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
export const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];
export const ALT_ENTER_XTERM = [0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x33, 0x3b, 0x31, 0x33, 0x7e];

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
  | { readonly kind: 'ctrl_a' }
  | { readonly kind: 'ctrl_b' }
  | { readonly kind: 'ctrl_e' }
  | { readonly kind: 'ctrl_f' }
  | { readonly kind: 'ctrl_u' }
  | { readonly kind: 'alt_b' }
  | { readonly kind: 'alt_f' }
  | { readonly kind: 'alt_d' }
  | { readonly kind: 'newline' }
  | { readonly kind: 'ctrl_k' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'left' }
  | { readonly kind: 'right' }
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'home' }
  | { readonly kind: 'end' }
  | { readonly kind: 'page_up' }
  | { readonly kind: 'page_down' }
  | { readonly kind: 'f1' }
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

export const INPUT_ESC_TIMEOUT_MS = ESC_TIMEOUT_MS;
export const INPUT_MAX_BYTES = MAX_EDITOR_BYTES;
export const INPUT_MAX_PASTE_BYTES = MAX_PASTE_BYTES;
export const INPUT_MAX_HISTORY_ENTRIES = MAX_HISTORY_ENTRIES;
export const INPUT_MAX_HISTORY_BYTES = MAX_HISTORY_BYTES;
