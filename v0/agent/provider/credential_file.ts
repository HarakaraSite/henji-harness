/**
 * Host-owned request-time credential source for the production TUI.
 *
 * The path and validation rules are intentionally fixed.  Tests can provide a
 * filesystem seam, but production has no caller-selected path and the value is
 * returned only to the provider adapter for the current request.
 */

import { credentialPath } from '../runtime/runtime_paths.ts';
import { type AuthProfileId, isAuthProfileId } from './model_selection.ts';

/**
 * Resolve the fixed credential file for a validated auth profile. The profile ID is a non-secret
 * identity; the path is derived from the XDG config root and never caller-selected.
 */
export const credentialFileFor = (profile: AuthProfileId): string => {
  if (!isAuthProfileId(profile)) fail('credential_metadata_invalid');
  return credentialPath(profile);
};

export const MAX_CREDENTIAL_BYTES = 4096 as const;

export type CredentialFileFailureCode =
  | 'credential_metadata_invalid'
  | 'credential_metadata_changed'
  | 'credential_open_failed'
  | 'credential_read_failed'
  | 'credential_oversize'
  | 'credential_invalid';

export class CredentialFileError extends Error {
  readonly code: CredentialFileFailureCode;

  constructor(code: CredentialFileFailureCode) {
    super(code);
    this.name = 'CredentialFileError';
    this.code = code;
  }
}

export interface CredentialFileMetadata {
  readonly isFile: boolean;
  readonly isSymlink: boolean;
  readonly mode: number | null;
  readonly size: number;
  readonly uid: number | null;
  readonly dev?: number;
  readonly ino?: number;
}

export interface CredentialFileHandle {
  readonly stat: () => Promise<CredentialFileMetadata>;
  readonly read: (buffer: Uint8Array) => Promise<number | null>;
  readonly close: () => void;
}

export interface CredentialFileSystem {
  readonly lstat: (path: string) => Promise<CredentialFileMetadata>;
  readonly open: (path: string) => Promise<CredentialFileHandle>;
  readonly effectiveUid: () => number | undefined;
}

export type CredentialFilePresence = 'present' | 'missing' | 'unknown';

const decoder = new TextDecoder('utf-8', { fatal: true });
const unicodeWhitespace = /\p{White_Space}/u;

const optionalNumber = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

const fromFileInfo = (info: Deno.FileInfo): CredentialFileMetadata => ({
  isFile: info.isFile,
  isSymlink: info.isSymlink,
  mode: info.mode,
  size: info.size,
  uid: info.uid,
  ...(optionalNumber(info.dev) === undefined ? {} : { dev: optionalNumber(info.dev) }),
  ...(optionalNumber(info.ino) === undefined ? {} : { ino: optionalNumber(info.ino) }),
});

const defaultFileSystem: CredentialFileSystem = {
  lstat: async (path) => fromFileInfo(await Deno.lstat(path)),
  open: async (path) => {
    const file = await Deno.open(path, { read: true });
    return {
      stat: async () => fromFileInfo(await file.stat()),
      read: (buffer) => file.read(buffer),
      close: () => file.close(),
    };
  },
  effectiveUid: () => {
    try {
      const uid = Deno.uid();
      return typeof uid === 'number' && Number.isSafeInteger(uid) ? uid : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * Check only fixed regular-file presence; do not open, decode, or validate credential material.
 * A directory or symlink is `unknown` so presence agrees with the stricter read contract.
 */
export const credentialFilePresenceAt = async (
  path: string,
  filesystem: CredentialFileSystem = defaultFileSystem,
): Promise<CredentialFilePresence> => {
  let metadata: CredentialFileMetadata;
  try {
    metadata = await filesystem.lstat(path);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? 'missing' : 'unknown';
  }
  return metadata.isFile === true && metadata.isSymlink === false ? 'present' : 'unknown';
};

export const credentialFilePresenceFor = (
  profile: AuthProfileId,
  filesystem: CredentialFileSystem = defaultFileSystem,
): Promise<CredentialFilePresence> =>
  credentialFilePresenceAt(credentialFileFor(profile), filesystem);

const fail = (code: CredentialFileFailureCode): never => {
  throw new CredentialFileError(code);
};

const validateMetadata = (
  metadata: CredentialFileMetadata,
  effectiveUid: number | undefined,
): void => {
  if (
    metadata.isFile !== true || metadata.isSymlink !== false ||
    metadata.mode === null ||
    !Number.isSafeInteger(metadata.mode) ||
    (metadata.mode & 0o7777) !== 0o600 ||
    effectiveUid === undefined || metadata.uid === null ||
    metadata.uid !== effectiveUid ||
    !Number.isSafeInteger(metadata.size) || metadata.size < 1 ||
    metadata.size > MAX_CREDENTIAL_BYTES
  ) {
    fail('credential_metadata_invalid');
  }
};

const compareStableIdentity = (
  before: CredentialFileMetadata,
  after: CredentialFileMetadata,
): void => {
  for (const key of ['dev', 'ino'] as const) {
    const beforeValue = before[key];
    const afterValue = after[key];
    if (beforeValue !== undefined || afterValue !== undefined) {
      if (
        beforeValue === undefined || afterValue === undefined ||
        !Number.isSafeInteger(beforeValue) ||
        !Number.isSafeInteger(afterValue) ||
        beforeValue !== afterValue
      ) {
        fail('credential_metadata_changed');
      }
    }
  }
};

const stripTerminalNewlineSequence = (text: string): string => {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') {
    end -= 1;
    if (end > 0 && text[end - 1] === '\r') end -= 1;
  }
  return text.slice(0, end);
};

/** Decode and validate the single-token credential without exposing its value in errors. */
export const parseCredentialBytes = (bytes: Uint8Array): string => {
  let text = '';
  try {
    text = decoder.decode(bytes);
  } catch {
    fail('credential_invalid');
  }
  text = stripTerminalNewlineSequence(text);
  if (
    text.length === 0 || text.includes('\r') || text.includes('\n') ||
    unicodeWhitespace.test(text) ||
    [...text].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return (codePoint >= 0x00 && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    fail('credential_invalid');
  }
  return text;
};

/** Read one fixed, caller-owned provider profile path with the same stable-file contract. */
const readCredentialFileAt = async (
  path: string,
  filesystem: CredentialFileSystem = defaultFileSystem,
): Promise<string> => {
  let effectiveUid: number | undefined;
  try {
    effectiveUid = filesystem.effectiveUid();
  } catch {
    fail('credential_metadata_invalid');
  }
  let metadata!: CredentialFileMetadata;
  try {
    metadata = await filesystem.lstat(path);
  } catch {
    fail('credential_metadata_invalid');
  }
  validateMetadata(metadata, effectiveUid);

  let file!: CredentialFileHandle;
  try {
    file = await filesystem.open(path);
  } catch {
    fail('credential_open_failed');
  }

  let bytes: Uint8Array | undefined;
  let failure: CredentialFileError | undefined;
  try {
    let openedMetadata!: CredentialFileMetadata;
    try {
      openedMetadata = await file.stat();
    } catch {
      fail('credential_read_failed');
    }
    validateMetadata(openedMetadata, effectiveUid);
    if (openedMetadata.size !== metadata.size) {
      fail('credential_metadata_changed');
    }
    compareStableIdentity(metadata, openedMetadata);

    const buffer = new Uint8Array(MAX_CREDENTIAL_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      let count: number | null = null;
      try {
        count = await file.read(buffer.subarray(offset));
      } catch {
        fail('credential_read_failed');
      }
      if (count === null) break;
      if (
        !Number.isSafeInteger(count) || count <= 0 ||
        count > buffer.byteLength - offset
      ) {
        fail('credential_read_failed');
      }
      offset += count;
    }
    if (offset > MAX_CREDENTIAL_BYTES) fail('credential_oversize');
    if (offset !== metadata.size) fail('credential_metadata_changed');
    bytes = buffer.slice(0, offset);
  } catch (error) {
    failure = error instanceof CredentialFileError
      ? error
      : new CredentialFileError('credential_read_failed');
  }

  try {
    file.close();
  } catch {
    if (failure === undefined) {
      failure = new CredentialFileError('credential_read_failed');
    }
  }
  if (failure !== undefined) throw failure;
  return parseCredentialBytes(bytes!);
};

/** Read and validate the fixed credential file for any validated auth profile. */
export const readCredentialFileFor = (
  profile: AuthProfileId,
  filesystem: CredentialFileSystem = defaultFileSystem,
): Promise<string> => readCredentialFileAt(credentialFileFor(profile), filesystem);
