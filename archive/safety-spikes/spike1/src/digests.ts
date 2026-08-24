import { canonicalBytes } from '../../spike0/src/canonical_content.ts';

const hexDigest = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return `sha256:${
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  }`;
};

export const domainDigest = async (domain: string, value: unknown): Promise<string> =>
  await hexDigest(canonicalBytes({ domain, value }));

export const rawDigest = async (domain: string, bytes: Uint8Array): Promise<string> => {
  const prefix = new TextEncoder().encode(`${domain}\0`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  return await hexDigest(input);
};
