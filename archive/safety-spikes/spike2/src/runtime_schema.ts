import { canonicalBytes } from '../../spike0/src/canonical_content.ts';

export const encoder = new TextEncoder();

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const exactObject = (
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> => {
  if (!isPlainObject(value)) throw new Error(`${path}: plain object required`);
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) throw new Error(`${path}: exact fields required`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(`${path}.${key}: enumerable data property required`);
    }
  }
  return value;
};

export const stringValue = (value: unknown, path: string, maxBytes = 256): string => {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > maxBytes) {
    throw new Error(`${path}: bounded string required`);
  }
  return value;
};

export const digestValue = (value: unknown, path: string): string => {
  const digest = stringValue(value, path);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${path}: digest required`);
  return digest;
};

export const timestampValue = (value: unknown, path: string): string => {
  const timestamp = stringValue(value, path, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw new Error(`${path}: UTC millisecond timestamp required`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new Error(`${path}: real timestamp required`);
  }
  return timestamp;
};

export const canonicalSizeAtMost = (value: unknown, limit: number, path: string): number => {
  const size = canonicalBytes(value).byteLength;
  if (size > limit) throw new Error(`${path}: canonical byte limit exceeded`);
  return size;
};

export const boundedWalk = (value: unknown, maxDepth: number, maxEntries: number): void => {
  let entries = 0;
  const ancestors = new WeakSet<object>();
  const walk = (item: unknown, depth: number): void => {
    if (depth > maxDepth) throw new Error('snapshot depth exceeded');
    if (typeof item !== 'object' || item === null) return;
    if (ancestors.has(item)) throw new Error('snapshot cycle');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const allowed = new Set<PropertyKey>(['length']);
        for (let index = 0; index < item.length; index++) allowed.add(String(index));
        if (Reflect.ownKeys(item).some((key) => !allowed.has(key))) {
          throw new Error('array property');
        }
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('sparse array');
          if (++entries > maxEntries) throw new Error('snapshot entry count exceeded');
          walk(descriptor.value, depth + 1);
        }
      } else {
        if (!isPlainObject(item)) throw new Error('plain object required');
        for (const key of Reflect.ownKeys(item)) {
          if (typeof key !== 'string') throw new Error('symbol key');
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('data property');
          if (++entries > maxEntries) throw new Error('snapshot entry count exceeded');
          walk(descriptor.value, depth + 1);
        }
      }
    } finally {
      ancestors.delete(item);
    }
  };
  walk(value, 0);
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
};

export const validatedClone = <T>(value: T): T => deepFreeze(structuredClone(value));
