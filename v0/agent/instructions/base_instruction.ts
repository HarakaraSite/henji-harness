import {
  type HenjiInstructionRevisionRef,
  isHenjiInstructionRevisionRef,
} from '../definitions/managed_resource_ref.ts';
import { HENJI_COMMON_INSTRUCTION } from './henji_common.ts';

export const HENJI_BASE_INSTRUCTION_SLOT = 'instruction:henji-base' as const;
/** User-scoped base instruction file, read directly without install or activation. */
export const HENJI_BASE_INSTRUCTION_FILE = 'instruction.md' as const;
/** Attribution identity of the direct user-scoped base instruction file. */
export const HENJI_BASE_INSTRUCTION_FILE_ID = 'user/instruction.md' as const;

const BUILTIN_REVISION_DIGEST = '0f9a20203a4bf27e459bcc769e0e679278aa17517897729fc6d74e266f4df56d';
const BUILTIN_CONTENT_DIGEST = 'fd1b23940df71185fd6fa38216fad281be70284bcafbb9f35c31a138917a4bb8';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface SelectedHenjiBaseInstruction {
  readonly schemaVersion: 1;
  readonly slot: typeof HENJI_BASE_INSTRUCTION_SLOT;
  readonly selectionSource: 'built-in' | 'external';
  readonly ref: HenjiInstructionRevisionRef;
  readonly contentDigest: string;
  readonly content: string;
  readonly bytesBase64: string;
}

export type HenjiInstructionErrorCode =
  | 'instruction_invalid'
  | 'instruction_io_failure';

export class HenjiInstructionError extends Error {
  constructor(
    readonly code: HenjiInstructionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HenjiInstructionError';
  }
}

export const henjiInstructionErrorValue = (error: HenjiInstructionError) => ({
  code: error.code,
  message: error.message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
};

const validText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);

/** Decode the base instruction without trim, newline conversion, or Unicode normalization. */
const decodeInstruction = (bytes: Uint8Array): string => {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new HenjiInstructionError(
      'instruction_invalid',
      'base instruction content is not valid UTF-8',
    );
  }
  if (
    text.includes('\0') || text.trim().length === 0 ||
    !sameBytes(encoder.encode(text), bytes)
  ) {
    throw new HenjiInstructionError(
      'instruction_invalid',
      'base instruction content is invalid',
    );
  }
  return text;
};

export const builtinHenjiBaseInstruction = (): SelectedHenjiBaseInstruction => ({
  schemaVersion: 1,
  slot: HENJI_BASE_INSTRUCTION_SLOT,
  selectionSource: 'built-in',
  ref: {
    schemaVersion: 1,
    resourceKind: 'henji-instruction',
    resourceId: 'builtin/henji-base',
    revision: { algorithm: 'sha256', digest: BUILTIN_REVISION_DIGEST },
  },
  contentDigest: `sha256:${BUILTIN_CONTENT_DIGEST}`,
  content: HENJI_COMMON_INSTRUCTION,
  bytesBase64: encoder.encode(HENJI_COMMON_INSTRUCTION).toBase64(),
});

export const validateSelectedHenjiBaseInstruction = (
  value: unknown,
): value is SelectedHenjiBaseInstruction => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'slot',
      'selectionSource',
      'ref',
      'contentDigest',
      'content',
      'bytesBase64',
    ]) || value.schemaVersion !== 1 ||
    value.slot !== HENJI_BASE_INSTRUCTION_SLOT ||
    (value.selectionSource !== 'built-in' &&
      value.selectionSource !== 'external') ||
    !isHenjiInstructionRevisionRef(value.ref) ||
    typeof value.contentDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.contentDigest) ||
    !validText(value.content) || typeof value.bytesBase64 !== 'string'
  ) return false;
  if (
    (value.selectionSource === 'built-in') !==
      (value.ref.resourceId === 'builtin/henji-base')
  ) return false;
  try {
    const bytes = Uint8Array.fromBase64(value.bytesBase64);
    return sameBytes(bytes, encoder.encode(value.content));
  } catch {
    return false;
  }
};

export const verifySelectedHenjiBaseInstruction = async (
  value: unknown,
): Promise<boolean> => {
  if (!validateSelectedHenjiBaseInstruction(value)) return false;
  const bytes = Uint8Array.fromBase64(value.bytesBase64);
  if (value.contentDigest !== `sha256:${await sha256Hex(bytes)}`) return false;
  return value.selectionSource !== 'built-in' ||
    value.ref.revision.digest === BUILTIN_REVISION_DIGEST;
};

export const verifyBuiltinHenjiBaseInstructionIdentity = async (): Promise<
  boolean
> => {
  const bytes = encoder.encode(HENJI_COMMON_INSTRUCTION);
  const content = await sha256Hex(bytes);
  return content === BUILTIN_CONTENT_DIGEST &&
    await sha256Hex(encoder.encode(`henji-instruction-v1\0${HENJI_COMMON_INSTRUCTION}`)) ===
      BUILTIN_REVISION_DIGEST;
};

export interface BaseInstructionFileSystem {
  readonly readFile: (path: string) => Promise<Uint8Array>;
}

const defaultFileSystem: BaseInstructionFileSystem = {
  readFile: (path) => Deno.readFile(path),
};

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;

/**
 * Resolve the base instruction for a Worker generation. A present user-scoped `instruction.md`
 * replaces the minimal built-in core; a missing file falls back to the built-in core. A read
 * failure other than NotFound, or invalid content, fails before the turn starts.
 */
export const resolveHenjiBaseInstruction = async (
  configRoot: string,
  fileSystem: BaseInstructionFileSystem = defaultFileSystem,
): Promise<SelectedHenjiBaseInstruction> => {
  const path = `${configRoot}/${HENJI_BASE_INSTRUCTION_FILE}`;
  let bytes: Uint8Array;
  try {
    bytes = await fileSystem.readFile(path);
  } catch (error) {
    if (isNotFound(error)) return builtinHenjiBaseInstruction();
    throw new HenjiInstructionError(
      'instruction_io_failure',
      'base instruction file could not be read',
    );
  }
  const content = decodeInstruction(bytes);
  const digest = await sha256Hex(bytes);
  return {
    schemaVersion: 1,
    slot: HENJI_BASE_INSTRUCTION_SLOT,
    selectionSource: 'external',
    ref: {
      schemaVersion: 1,
      resourceKind: 'henji-instruction',
      resourceId: HENJI_BASE_INSTRUCTION_FILE_ID,
      revision: { algorithm: 'sha256', digest },
    },
    contentDigest: `sha256:${digest}`,
    content,
    bytesBase64: bytes.toBase64(),
  };
};
