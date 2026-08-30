const encoder = new TextEncoder();

/** Compute a domain-separated SHA-256 identity without exposing provider or filesystem APIs. */
export const canonicalDomainSeparatedDigest = async (
  domain: string,
  payload: Uint8Array,
  prefix: string,
): Promise<string> => {
  const domainBytes = encoder.encode(domain);
  const input = new Uint8Array(domainBytes.byteLength + payload.byteLength);
  input.set(domainBytes);
  input.set(payload, domainBytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${prefix}${hex}`;
};

export const canonicalUtf8Bytes = (value: string): Uint8Array => encoder.encode(value);
