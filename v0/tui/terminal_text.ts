import { toolActivityPreview } from '../agent/tools/tool_activity.ts';
import { MAX_CONVERSATION_TEXT_BYTES } from '../resource_limits.ts';

export const encoder = new TextEncoder();
const isFullwidthForm = (code: number): boolean =>
  (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);
export const cellWidth = (character: string): number => {
  const code = character.codePointAt(0)!;
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
const DISPLAY_LIMIT = MAX_CONVERSATION_TEXT_BYTES;
const ESCAPED_BIDI = (code: number): boolean =>
  code === 0x061c || (code >= 0x200e && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

export interface EscapeOptions {
  /** Render line breaks as the one-line editor marker instead of logical host newlines. */
  readonly editor?: boolean;
}

const escapedCodePoint = (code: number): string => {
  let value = code.toString(16).toUpperCase();
  while (value.length < 4) value = `0${value}`;
  return `\\u{${value}}`;
};

/** The sole dynamic-to-terminal escaping boundary. */
export const escapeTerminalText = (
  text: string,
  options: EscapeOptions = {},
): string => {
  let output = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x0a) {
      output += options.editor ? '↵' : '\n';
    } else if (code === 0x09) {
      output += '⇥';
    } else if (
      code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ||
      ESCAPED_BIDI(code)
    ) {
      output += escapedCodePoint(code);
    } else {
      output += character;
    }
  }
  return output;
};

/** Byte count for exactly the dynamic text projection emitted to the terminal. */
export const escapedTerminalTextBytes = (
  text: string,
  options: EscapeOptions = {},
): number => encoder.encode(escapeTerminalText(text, options)).byteLength;

export const truncateText = (
  text: string,
  maxBytes = DISPLAY_LIMIT,
): { text: string; truncated: boolean } => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let used = 0;
  let prefix = '';
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (used + size > maxBytes) break;
    prefix += character;
    used += size;
  }
  return { text: prefix, truncated: true };
};

const shortToolName = (name: string): string => {
  const bounded = truncateText(name, 64);
  return bounded.truncated ? `${bounded.text}…` : bounded.text;
};
export const toolCallText = (name: string, args: unknown): string => {
  const preview = toolActivityPreview(name, args);
  return preview.length === 0 ? shortToolName(name) : `${shortToolName(name)} ${preview}`;
};

const zoneNameFormatter = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });
const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Local wall-clock minute with the environment locale's short zone label. */
export const localTimestampText = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const zone = zoneNameFormatter.formatToParts(date).find((part) => part.type === 'timeZoneName')
    ?.value;
  return zone === undefined || zone.length === 0 ? stamp : `${stamp} ${zone}`;
};
