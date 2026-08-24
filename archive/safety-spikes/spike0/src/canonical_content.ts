import { hasLoneSurrogate } from './definition_content.ts';

export class CanonicalContentError extends Error {
  override readonly name = 'CanonicalContentError';
}

const fail = (message: string): never => {
  throw new CanonicalContentError(message);
};

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const serialize = (value: unknown, ancestors: WeakSet<object>): string => {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) fail('JCS strings must not contain lone surrogates');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JCS numbers must be finite IEEE 754 values');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || value === null) fail('value is outside the JSON domain');
  const container = value as object;
  if (ancestors.has(container)) fail('cyclic values cannot be canonicalized');
  ancestors.add(container);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      const allowedKeys = new Set<PropertyKey>(['length']);
      for (let index = 0; index < value.length; index++) allowedKeys.add(String(index));
      for (const key of Reflect.ownKeys(value)) {
        if (!allowedKeys.has(key)) fail(`JCS array has non-JSON property ${String(key)}`);
      }
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) fail('sparse arrays cannot be canonicalized');
        const itemDescriptor = descriptor as PropertyDescriptor;
        if (!itemDescriptor.enumerable || !('value' in itemDescriptor)) {
          fail('JCS arrays require enumerable data properties');
        }
        items.push(serialize(itemDescriptor.value, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    if (!isPlainObject(container)) fail('JCS objects must be plain objects');
    const object = container as Record<string, unknown>;
    const keys = Reflect.ownKeys(object);
    if (keys.some((key) => typeof key !== 'string')) fail('JCS objects must not have symbol keys');
    const stringKeys = keys as string[];
    for (const key of stringKeys) {
      if (hasLoneSurrogate(key)) fail('JCS property names must not contain lone surrogates');
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail('JCS objects require enumerable data properties');
      }
    }
    stringKeys.sort();
    return `{${
      stringKeys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        return `${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`;
      }).join(',')
    }}`;
  } finally {
    ancestors.delete(container);
  }
};

export const canonicalize = (value: unknown): string => serialize(value, new WeakSet());

export const canonicalBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalize(value));

export const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `sha256:${hex}`;
};

export const contentHash = async (value: unknown): Promise<string> =>
  await sha256(canonicalBytes(value));
