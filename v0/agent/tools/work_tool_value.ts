import type { JsonObject, JsonValue } from '../core/contracts.ts';
import { ToolInputError } from './tools.ts';

export const encoder = new TextEncoder();
export const MAX_TEXT_BYTES = 65_536;
export const MAX_PATH_BYTES = 4_096;
export const MAX_COMMAND_BYTES = 16_384;
export const MAX_CAPTURE_BYTES = 4_096;
export const MAX_PROGRESS_STREAM_BYTES = 4_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const CAPTURE_GRACE_MS = 250;

export const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

export const validTextArgument = (
  value: unknown,
  maxBytes: number,
): value is string =>
  typeof value === 'string' && hasWellFormedUnicode(value) &&
  !value.includes('\0') &&
  encoder.encode(value).byteLength <= maxBytes;

export const exactKeys = (
  value: JsonObject,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

export const invalidToolArguments = (name: string): ToolInputError =>
  new ToolInputError(`invalid ${name} arguments`);

export const validateObject = (
  value: JsonValue,
  keys: readonly string[],
  name: string,
): JsonObject => {
  if (!isObject(value) || !exactKeys(value, keys)) {
    throw invalidToolArguments(name);
  }
  return value;
};

export const concatBytes = (
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array => {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
