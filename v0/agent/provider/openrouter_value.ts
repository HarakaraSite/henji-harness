import type { JsonValue } from '../core/contracts.ts';

const encoder = new TextEncoder();

export const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

export const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

export const validSystemInstruction = (value: unknown): value is string =>
  nonBlank(value) && !value.includes('\0') && hasWellFormedUnicode(value);

export const safeJson = (value: unknown): string | undefined => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : encoded;
  } catch {
    return undefined;
  }
};

export const bytes = (value: string): number => encoder.encode(value).byteLength;
