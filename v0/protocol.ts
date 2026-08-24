import {
  type Envelope,
  ENVELOPE_VERSION,
  type Failure,
  failure,
  isRecord,
  type RequestEnvelope,
  type ResponseEnvelope,
} from './domain.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encodeJsonl = (value: unknown, maxBytes = 256 * 1024): string | Failure => {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return failure('protocol_violation', 'value is not serializable');
  }
  const line = `${json}\n`;
  if (encoder.encode(line).byteLength > maxBytes) {
    return failure('limit_exceeded', 'JSONL message exceeds limit');
  }
  return line;
};

export const decodeJsonl = (line: string, maxBytes = 256 * 1024): Envelope | Failure => {
  if (encoder.encode(line).byteLength > maxBytes) {
    return failure('limit_exceeded', 'JSONL message exceeds limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return failure('protocol_violation', 'invalid JSONL');
  }
  if (
    !isRecord(value) || value.v !== ENVELOPE_VERSION || typeof value.id !== 'string' ||
    value.id.length === 0
  ) return failure('protocol_violation', 'invalid envelope header');
  if (value.kind === 'request' && typeof value.method === 'string' && 'payload' in value) {
    return value as unknown as RequestEnvelope;
  }
  if (
    value.kind === 'response' && typeof value.replyTo === 'string' && typeof value.ok === 'boolean'
  ) {
    if (value.ok && 'payload' in value) return value as unknown as ResponseEnvelope;
    if (
      !value.ok && isRecord(value.error) && typeof value.error.code === 'string' &&
      typeof value.error.message === 'string'
    ) return value as unknown as ResponseEnvelope;
  }
  return failure('protocol_violation', 'invalid envelope');
};

export const request = (
  id: string,
  method: string,
  payload: unknown,
  parentId?: string,
): RequestEnvelope => ({
  v: ENVELOPE_VERSION,
  id,
  kind: 'request',
  method,
  payload,
  ...(parentId ? { parentId } : {}),
});

export const response = (id: string, replyTo: string, payload: unknown): ResponseEnvelope => ({
  v: ENVELOPE_VERSION,
  id,
  kind: 'response',
  replyTo,
  ok: true,
  payload,
});

export const errorResponse = (
  id: string,
  replyTo: string,
  code: string,
  message: string,
): ResponseEnvelope => ({
  v: ENVELOPE_VERSION,
  id,
  kind: 'response',
  replyTo,
  ok: false,
  error: { code, message },
});

export const bytes = (value: string): number => encoder.encode(value).byteLength;
export const text = (value: Uint8Array): string => decoder.decode(value);
