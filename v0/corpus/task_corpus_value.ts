import {
  type CorpusToolName,
  CorpusValidationError,
  type JsonValue,
  TOOL_NAMES,
} from './task_corpus_contract.ts';

export const fail = (path: string, message: string): never => {
  throw new CorpusValidationError(`${path}: ${message}`);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(path, `fields must be exactly ${expected.join(', ')}`);
  }
};

export const stringValue = (value: unknown, path: string, nonblank = true): string => {
  if (typeof value !== 'string' || (nonblank && value.trim().length === 0)) {
    fail(path, nonblank ? 'must be a nonblank string' : 'must be a string');
  }
  return value as string;
};

export const integer = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== 'number' || !Number.isInteger(value) || value < minimum ||
    value > maximum
  ) {
    fail(path, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
};

export const unique = <T>(values: readonly T[], path: string): void => {
  if (new Set(values).size !== values.length) {
    fail(path, 'must not contain duplicates');
  }
};

export const sortedStrings = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const entries = value as unknown[];
  const values = entries.map((entry, index) => stringValue(entry, `${path}[${index}]`));
  unique(values, path);
  const sorted = [...values].sort();
  if (values.some((entry, index) => entry !== sorted[index])) {
    fail(path, 'must be sorted');
  }
  return values;
};

export const toolName = (value: unknown, path: string): CorpusToolName => {
  if (
    typeof value !== 'string' || !TOOL_NAMES.includes(value as CorpusToolName)
  ) {
    fail(path, 'unknown tool');
  }
  return value as CorpusToolName;
};

export const toolNames = (value: unknown, path: string): readonly CorpusToolName[] => {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const entries = value as unknown[];
  const values = entries.map((entry, index) => toolName(entry, `${path}[${index}]`));
  unique(values, path);
  return values;
};

export const validId = (value: unknown, path: string): string => {
  const id = stringValue(value, path);
  if (
    !/^v1\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(id)
  ) {
    fail(path, 'does not match the versioned ID format');
  }
  return id;
};

export const fixtureId = (value: unknown, path: string): string => {
  const id = stringValue(value, path);
  if (!/^deno-v0-(?:fmt|lint)$/.test(id)) fail(path, 'unknown fixture ID');
  return id;
};

export const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null || typeof value === 'boolean' || typeof value === 'string'
  ) return true;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isSafeInteger(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
};

export const deepEqualJson = (left: JsonValue, right: JsonValue): boolean => {
  if (typeof left !== typeof right || left === null || right === null) {
    return left === right;
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqualJson(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqualJson(left[key], right[key])
    );
};
