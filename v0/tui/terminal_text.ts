import { staticBytes } from './terminal.ts';
import { toolActivityPreview } from './tool_activity.ts';
import { MAX_CONVERSATION_TEXT_BYTES } from '../resource_limits.ts';

export const encoder = new TextEncoder();
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

export const boundedEscaped = (text: string, options: EscapeOptions = {}): string => {
  const bounded = truncateText(text);
  const escaped = escapeTerminalText(bounded.text, options);
  return bounded.truncated ? `${escaped}… [display truncated]` : escaped;
};

const shortToolName = (name: string): string => {
  const bounded = truncateText(name, 64);
  return bounded.truncated ? `${bounded.text}…` : bounded.text;
};
export const toolCallText = (name: string, args: unknown): string => {
  const preview = toolActivityPreview(name, args);
  return preview.length === 0 ? shortToolName(name) : `${shortToolName(name)} ${preview}`;
};
export const toolResultText = (
  name: string,
  outcome: 'success' | 'error',
): string => `${shortToolName(name)} ${outcome === 'success' ? '✓' : '✗'}`;

export const dynamicLine = (prefix: string, value: string): Uint8Array =>
  staticBytes(`${prefix}${boundedEscaped(value)}\n`);
