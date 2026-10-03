import { createHash } from 'node:crypto';

export const exactByteDigest = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
