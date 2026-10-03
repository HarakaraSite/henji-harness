/** Small failure-only facts. Never serialize an exception, headers, stack, or response body. */
export interface FailureDetails {
  readonly operation?: string;
  readonly exceptionType?: string;
  readonly message?: string;
  readonly errorCode?: string;
  readonly errorType?: string;
  readonly param?: string;
  readonly causeType?: string;
  readonly causeCode?: string;
  readonly requestId?: string;
  readonly responseId?: string;
  readonly field?: string;
  readonly expectedShape?: string;
  readonly actualShape?: string;
  readonly lastStreamEvent?: string;
  readonly streamEventCount?: number;
  readonly completedReceived?: boolean;
  readonly truncated?: true;
}

export const MAX_FAILURE_DETAILS_BYTES = 4_096;
const MAX_FAILURE_MESSAGE_BYTES = 512;
const MAX_FAILURE_VALUE_BYTES = 128;
const encoder = new TextEncoder();
const stringKeys = [
  'operation',
  'exceptionType',
  'message',
  'errorCode',
  'errorType',
  'param',
  'causeType',
  'causeCode',
  'requestId',
  'responseId',
  'field',
  'expectedShape',
  'actualShape',
  'lastStreamEvent',
] as const;
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
const exceptionType = (value: unknown): unknown => {
  const item = record(value);
  // SDK subclasses may inherit Error.name; plain provider error objects carry an explicit name.
  const name = typeof item?.constructor === 'function' ? item.constructor.name : undefined;
  return name !== undefined && name !== 'Error' && name !== 'Object' ? name : item?.name;
};

export const validateFailureDetails = (value: unknown): value is FailureDetails => {
  const item = record(value);
  if (item === undefined || Array.isArray(value)) return false;
  const allowed = [...stringKeys, 'streamEventCount', 'completedReceived', 'truncated'];
  if (!Object.keys(item).every((key) => allowed.includes(key))) return false;
  for (const key of stringKeys) {
    const text = item[key];
    if (text === undefined) continue;
    if (
      typeof text !== 'string' || encoder.encode(text).length >
        (key === 'message' ? MAX_FAILURE_MESSAGE_BYTES : MAX_FAILURE_VALUE_BYTES)
    ) return false;
  }
  return (item.streamEventCount === undefined ||
    Number.isSafeInteger(item.streamEventCount) && Number(item.streamEventCount) >= 0) &&
    (item.completedReceived === undefined || typeof item.completedReceived === 'boolean') &&
    (item.truncated === undefined || item.truncated === true) &&
    encoder.encode(JSON.stringify(item)).length <= MAX_FAILURE_DETAILS_BYTES;
};

/** Capture only at a failure boundary; known credentials are removed before truncation. */
export const captureFailureDetails = (
  error: unknown,
  options: { operation?: string; secrets?: readonly string[]; facts?: FailureDetails } = {},
): FailureDetails => {
  const item = record(error);
  const inherited = record(item?.failureFact)?.details ?? item?.failureDetails;
  const saved = validateFailureDetails(inherited) ? inherited : undefined;
  const api = record(item?.error);
  const cause = item?.cause;
  const candidates: Record<string, unknown> = {
    operation: options.operation,
    exceptionType: exceptionType(error),
    message: item?.message ?? (typeof error === 'string' ? error : undefined),
    errorCode: item?.code ?? api?.code,
    errorType: item?.type ?? api?.type,
    param: item?.param ?? api?.param,
    causeType: exceptionType(cause),
    causeCode: record(cause)?.code,
    requestId: item?.requestID,
    field: record(item?.failureFact)?.field,
    expectedShape: record(item?.failureFact)?.expectedShape,
    actualShape: record(item?.failureFact)?.actualShape,
    ...options.facts,
    ...saved,
  };
  let truncated = saved?.truncated === true;
  const secrets = (options.secrets ?? []).filter((secret) => secret.length > 0).flatMap((
    secret,
  ) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  const shorten = (value: string, limit: number): string => {
    let cleaned = value;
    for (const secret of secrets) cleaned = cleaned.replaceAll(secret, '[redacted]');
    cleaned = cleaned.replace(
      /\b(?:authorization|proxy-authorization|x-api-key|api-key)\s*[:=]\s*[^\r\n,;]+/giu,
      '[redacted authorization]',
    ).replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '[redacted authorization]');
    const bytes = encoder.encode(cleaned);
    if (bytes.length <= limit) return cleaned;
    truncated = true;
    // Decode a complete UTF-8 prefix, excluding a split final code point.
    let end = limit;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    return new TextDecoder().decode(bytes.subarray(0, end));
  };
  const result: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const value = candidates[key];
    if (typeof value === 'string' || typeof value === 'number') {
      result[key] = shorten(
        String(value),
        key === 'message' ? MAX_FAILURE_MESSAGE_BYTES : MAX_FAILURE_VALUE_BYTES,
      );
    }
  }
  if (typeof candidates.streamEventCount === 'number') {
    result.streamEventCount = candidates.streamEventCount;
  }
  if (typeof candidates.completedReceived === 'boolean') {
    result.completedReceived = candidates.completedReceived;
  }
  if (truncated) result.truncated = true;
  // JSON escaping can enlarge the bounded scalar strings. Keep the whole addition bounded too.
  while (encoder.encode(JSON.stringify(result)).length > MAX_FAILURE_DETAILS_BYTES) {
    const key = stringKeys.reduce(
      (longest, key) =>
        String(result[key] ?? '').length > String(result[longest] ?? '').length ? key : longest,
      'message' as typeof stringKeys[number],
    );
    result[key] = shorten(
      String(result[key]),
      Math.max(1, Math.floor(encoder.encode(String(result[key])).length / 2)),
    );
    result.truncated = true;
  }
  return Object.freeze(result) as FailureDetails;
};
