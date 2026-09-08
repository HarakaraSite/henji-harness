import { PRESENTATION_MAX_TEXT_BYTES } from './contract_types.ts';
import { PresentationDeliveryError } from './contract_failure.ts';

export const movePresentationPickerSelection = (
  count: number,
  selected: number,
  page: number,
  direction: 'up' | 'down' | 'left' | 'right',
): { readonly selected: number; readonly page: number } => {
  const total = Math.max(0, Number.isSafeInteger(count) ? count : 0);
  const pageCount = Math.max(1, Math.ceil(total / 8));
  const boundedPage = Math.max(
    0,
    Math.min(pageCount - 1, Number.isSafeInteger(page) ? page : 0),
  );
  if (total === 0) return { selected: 0, page: boundedPage };
  const first = boundedPage * 8;
  const last = Math.min(total - 1, first + 7);
  let nextPage = boundedPage;
  let nextSelected = selected >= first && selected <= last ? selected : first;
  if (direction === 'left') nextPage = Math.max(0, boundedPage - 1);
  if (direction === 'right') {
    nextPage = Math.min(pageCount - 1, boundedPage + 1);
  }
  if (direction === 'left' || direction === 'right') {
    nextSelected = Math.min(total - 1, nextPage * 8);
  } else if (direction === 'up') {
    nextSelected = nextSelected === first ? last : nextSelected - 1;
  } else if (direction === 'down') {
    nextSelected = nextSelected === last ? first : nextSelected + 1;
  }
  return { selected: nextSelected, page: nextPage };
};

const encoder = new TextEncoder();

const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

/** Reject mutable/non-plain values at the boundary without leaking their contents. */
export const snapshotPresentation = <T>(value: T): T => {
  try {
    const visiting = new WeakSet<object>();
    const inspect = (current: unknown, depth: number): void => {
      if (
        current === null || typeof current === 'string' ||
        typeof current === 'number' ||
        typeof current === 'boolean' || current === undefined
      ) return;
      if (typeof current !== 'object' || depth > 32) {
        throw new PresentationDeliveryError();
      }
      if (visiting.has(current)) throw new PresentationDeliveryError();
      const prototype = Object.getPrototypeOf(current);
      if (
        Array.isArray(current)
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      ) {
        throw new PresentationDeliveryError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (
        Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
        Object.values(descriptors).some((descriptor) =>
          descriptor.get !== undefined || descriptor.set !== undefined
        )
      ) {
        throw new PresentationDeliveryError();
      }
      if (Array.isArray(current)) {
        const length = current.length;
        for (const key of Reflect.ownKeys(current)) {
          if (key === 'length') continue;
          if (typeof key !== 'string' || !/^\d+$/u.test(key)) {
            throw new PresentationDeliveryError();
          }
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
            throw new PresentationDeliveryError();
          }
        }
        for (let index = 0; index < length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, String(index))) {
            throw new PresentationDeliveryError();
          }
        }
      }
      visiting.add(current);
      for (const child of Object.values(current)) inspect(child, depth + 1);
      visiting.delete(current);
    };
    inspect(value, 0);
    const copy = structuredClone(value);
    const seen = new WeakSet<object>();
    const freeze = (current: unknown): unknown => {
      if (current === null || typeof current !== 'object') return current;
      if (seen.has(current)) return current;
      seen.add(current);
      for (const child of Object.values(current)) freeze(child);
      return Object.freeze(current);
    };
    return freeze(copy) as T;
  } catch {
    throw new PresentationDeliveryError();
  }
};

export const boundedPresentationText = (value: string): string => {
  if (
    typeof value !== 'string' || !isWellFormed(value) || value.includes('\0')
  ) {
    throw new PresentationDeliveryError();
  }
  if (encoder.encode(value).byteLength <= PRESENTATION_MAX_TEXT_BYTES) {
    return value;
  }
  let result = '';
  let used = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (used + size > PRESENTATION_MAX_TEXT_BYTES) break;
    result += character;
    used += size;
  }
  return result;
};
