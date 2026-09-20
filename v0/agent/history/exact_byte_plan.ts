import { createHash } from 'node:crypto';
import type { JsonValue } from '../core/contracts.ts';
import { canonicalJsonBytes } from './context_attribution.ts';

export const EXACT_BYTE_PLAN_SCHEMA_VERSION = 1 as const;
export const HISTORY_DIGEST_ALGORITHM = 'sha256' as const;

export interface ExactByteObjectRef {
  readonly digest: string;
  readonly byteLength: number;
}

declare const validatedExactByteRef: unique symbol;
export interface ValidatedExactByteObjectRef extends ExactByteObjectRef {
  readonly [validatedExactByteRef]: true;
}

export type ExactByteFragment =
  | { readonly kind: 'validated_ref'; readonly object: ExactByteObjectRef }
  | { readonly kind: 'literal'; readonly bytes: Uint8Array };

export interface ExactBytePlan {
  readonly schemaVersion: 1;
  readonly captureBoundary: string;
  readonly serializerVersion: string;
  readonly contentEncoding: string;
  readonly fragments: readonly ExactByteFragment[];
  readonly byteLength: number;
  readonly digest: string;
}

export interface ExactByteCaptureMetrics {
  readonly wireBytes: number;
  readonly unreferencedInputBytes: number;
  readonly validatedFragmentRefs: number;
  readonly capturePasses: 1;
  readonly postHocFullBodyPasses: 0;
}

const digestName = (hex: string): string => `${HISTORY_DIGEST_ALGORITHM}:${hex}`;

export const exactByteDigest = (bytes: Uint8Array): string =>
  digestName(createHash('sha256').update(bytes).digest('hex'));

/** The initial object ingest is the one operation allowed to establish a reusable validated ref. */
export const validatedExactByteObjectRef = (bytes: Uint8Array): ValidatedExactByteObjectRef => ({
  digest: exactByteDigest(bytes),
  byteLength: bytes.byteLength,
} as ValidatedExactByteObjectRef);

const validRef = (ref: ExactByteObjectRef): boolean =>
  /^sha256:[0-9a-f]{64}$/u.test(ref.digest) &&
  Number.isSafeInteger(ref.byteLength) && ref.byteLength >= 0;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/**
 * Adapter-facing evidence sink. Each emitted fragment is observed while it is sent. A validated
 * ref is not rehashed as an object; its emitted bytes only feed the whole-body digest.
 */
export class ExactBytePlanBuilder {
  readonly #whole = createHash('sha256');
  readonly #fragments: ExactByteFragment[] = [];
  #byteLength = 0;
  #literalBytes = 0;
  #validatedRefs = 0;
  #finished = false;

  constructor(
    readonly captureBoundary: string,
    readonly serializerVersion: string,
    readonly contentEncoding = 'identity',
  ) {
    if (!captureBoundary || !serializerVersion || !contentEncoding) {
      throw new TypeError('exact byte plan metadata must not be empty');
    }
  }

  appendLiteral(bytes: Uint8Array): void {
    this.#assertOpen();
    const captured = bytes.slice();
    this.#whole.update(captured);
    this.#fragments.push({ kind: 'literal', bytes: captured });
    this.#byteLength += captured.byteLength;
    this.#literalBytes += captured.byteLength;
  }

  appendValidatedRef(ref: ValidatedExactByteObjectRef, emittedBytes: Uint8Array): void {
    this.#assertOpen();
    if (!validRef(ref) || emittedBytes.byteLength !== ref.byteLength) {
      throw new TypeError('invalid exact byte object ref');
    }
    this.#whole.update(emittedBytes);
    this.#fragments.push({ kind: 'validated_ref', object: { ...ref } });
    this.#byteLength += emittedBytes.byteLength;
    this.#validatedRefs += 1;
  }

  finish(): { readonly plan: ExactBytePlan; readonly metrics: ExactByteCaptureMetrics } {
    this.#assertOpen();
    this.#finished = true;
    const plan: ExactBytePlan = {
      schemaVersion: EXACT_BYTE_PLAN_SCHEMA_VERSION,
      captureBoundary: this.captureBoundary,
      serializerVersion: this.serializerVersion,
      contentEncoding: this.contentEncoding,
      fragments: this.#fragments.map((fragment) =>
        fragment.kind === 'literal'
          ? { kind: 'literal', bytes: fragment.bytes.slice() }
          : { kind: 'validated_ref', object: { ...fragment.object } }
      ),
      byteLength: this.#byteLength,
      digest: digestName(this.#whole.digest('hex')),
    };
    return {
      plan,
      metrics: {
        wireBytes: this.#byteLength,
        unreferencedInputBytes: this.#literalBytes,
        validatedFragmentRefs: this.#validatedRefs,
        capturePasses: 1,
        postHocFullBodyPasses: 0,
      },
    };
  }

  #assertOpen(): void {
    if (this.#finished) throw new Error('exact byte plan is already finished');
  }
}

export type ExactByteObjectResolver = (
  ref: ExactByteObjectRef,
) => Uint8Array | Promise<Uint8Array>;

export const encodeExactBytePlan = (plan: ExactBytePlan): Uint8Array =>
  canonicalJsonBytes({
    schemaVersion: plan.schemaVersion,
    captureBoundary: plan.captureBoundary,
    serializerVersion: plan.serializerVersion,
    contentEncoding: plan.contentEncoding,
    fragments: plan.fragments.map((fragment) =>
      fragment.kind === 'literal'
        ? { kind: 'literal', bytesBase64: fragment.bytes.toBase64() }
        : { kind: 'validated_ref', object: fragment.object }
    ),
    byteLength: plan.byteLength,
    digest: plan.digest,
  } as unknown as JsonValue);

export const decodeExactBytePlan = (bytes: Uint8Array): ExactBytePlan => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError('invalid exact byte plan encoding');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('invalid exact byte plan');
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      'schemaVersion',
      'captureBoundary',
      'serializerVersion',
      'contentEncoding',
      'fragments',
      'byteLength',
      'digest',
    ]) ||
    record.schemaVersion !== EXACT_BYTE_PLAN_SCHEMA_VERSION ||
    typeof record.captureBoundary !== 'string' || !record.captureBoundary ||
    typeof record.serializerVersion !== 'string' || !record.serializerVersion ||
    typeof record.contentEncoding !== 'string' || !record.contentEncoding ||
    !Array.isArray(record.fragments) ||
    !Number.isSafeInteger(record.byteLength) || Number(record.byteLength) < 0 ||
    typeof record.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.digest)
  ) throw new TypeError('invalid exact byte plan');
  const fragments: ExactByteFragment[] = record.fragments.map((fragment) => {
    if (typeof fragment !== 'object' || fragment === null || Array.isArray(fragment)) {
      throw new TypeError('invalid exact byte fragment');
    }
    const item = fragment as Record<string, unknown>;
    if (
      exactKeys(item, ['kind', 'bytesBase64']) && item.kind === 'literal' &&
      typeof item.bytesBase64 === 'string'
    ) {
      try {
        return { kind: 'literal', bytes: Uint8Array.fromBase64(item.bytesBase64) };
      } catch {
        throw new TypeError('invalid exact byte literal');
      }
    }
    if (
      exactKeys(item, ['kind', 'object']) && item.kind === 'validated_ref' &&
      typeof item.object === 'object' &&
      item.object !== null && !Array.isArray(item.object) &&
      exactKeys(item.object as Record<string, unknown>, ['digest', 'byteLength']) &&
      validRef(item.object as unknown as ExactByteObjectRef)
    ) {
      return {
        kind: 'validated_ref',
        object: { ...(item.object as unknown as ExactByteObjectRef) },
      };
    }
    throw new TypeError('invalid exact byte fragment');
  });
  const total = fragments.reduce(
    (sum, fragment) =>
      sum + (fragment.kind === 'literal' ? fragment.bytes.byteLength : fragment.object.byteLength),
    0,
  );
  if (total !== Number(record.byteLength)) throw new TypeError('invalid exact byte plan length');
  return {
    schemaVersion: EXACT_BYTE_PLAN_SCHEMA_VERSION,
    captureBoundary: record.captureBoundary,
    serializerVersion: record.serializerVersion,
    contentEncoding: record.contentEncoding,
    fragments,
    byteLength: Number(record.byteLength),
    digest: record.digest,
  };
};

export const materializeExactBytePlan = async (
  plan: ExactBytePlan,
  resolve: ExactByteObjectResolver,
): Promise<Uint8Array> => {
  if (
    plan.schemaVersion !== EXACT_BYTE_PLAN_SCHEMA_VERSION ||
    !Number.isSafeInteger(plan.byteLength) || plan.byteLength < 0
  ) throw new TypeError('invalid exact byte plan');
  const result = new Uint8Array(plan.byteLength);
  const whole = createHash('sha256');
  let offset = 0;
  for (const fragment of plan.fragments) {
    const bytes = fragment.kind === 'literal' ? fragment.bytes : await resolve(fragment.object);
    if (fragment.kind === 'validated_ref') {
      if (
        bytes.byteLength !== fragment.object.byteLength ||
        exactByteDigest(bytes) !== fragment.object.digest
      ) throw new Error('exact byte object failed read validation');
    }
    if (offset + bytes.byteLength > result.byteLength) {
      throw new Error('exact byte plan length overflow');
    }
    result.set(bytes, offset);
    whole.update(bytes);
    offset += bytes.byteLength;
  }
  if (offset !== plan.byteLength || digestName(whole.digest('hex')) !== plan.digest) {
    throw new Error('exact byte plan digest mismatch');
  }
  return result;
};
