import { error, type HarnessError } from '../domain/errors.ts';
import { type Envelope, parseEnvelope } from './envelope.ts';

export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;

export const encodeJsonl = (
  envelope: Envelope,
  maxBytes = DEFAULT_MAX_MESSAGE_BYTES,
): string | HarnessError => {
  const line = `${JSON.stringify(envelope)}\n`;
  if (new TextEncoder().encode(line).byteLength > maxBytes) {
    return error(
      'message_limit_exceeded',
      'encoded JSONL message exceeds the configured byte limit',
    );
  }
  return line;
};

export const decodeJsonlLine = (
  line: string,
  maxBytes = DEFAULT_MAX_MESSAGE_BYTES,
): Envelope | HarnessError => {
  if (line.includes('\n') || line.includes('\r')) {
    return error('invalid_jsonl', 'JSONL decoder accepts exactly one line without a newline');
  }
  if (new TextEncoder().encode(line).byteLength > maxBytes) {
    return error('message_limit_exceeded', 'JSONL message exceeds the configured byte limit');
  }
  try {
    return parseEnvelope(JSON.parse(line));
  } catch {
    return error('invalid_jsonl', 'JSONL message is not valid JSON');
  }
};
