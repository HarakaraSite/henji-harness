import { type IntakeLimitProfileV1, utf8Length } from './limits.ts';

export class IntakeError extends Error {
  override readonly name = 'IntakeError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const boundedFrameBrand: unique symbol = Symbol('BoundedSubmissionFrameV1');
export interface BoundedSubmissionFrameV1 {
  readonly bytes: Uint8Array;
  readonly [boundedFrameBrand]: true;
}
export const isBoundedSubmissionFrame = (value: unknown): value is BoundedSubmissionFrameV1 =>
  typeof value === 'object' && value !== null &&
  (value as Record<PropertyKey, unknown>)[boundedFrameBrand] === true &&
  (value as { bytes?: unknown }).bytes instanceof Uint8Array;

export const frameSubmission = (
  chunks: readonly Uint8Array[],
  profile: IntakeLimitProfileV1,
): BoundedSubmissionFrameV1 => {
  let total = 0;
  const kept: Uint8Array[] = [];
  for (const chunk of chunks) {
    const remaining = profile.maxRawBytes + 1 - total;
    if (remaining <= 0) break;
    const part = chunk.subarray(0, remaining);
    kept.push(part);
    total += part.byteLength;
  }
  if (total > profile.maxRawBytes) {
    throw new IntakeError('oversize_input', 'raw input exceeds limit');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of kept) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, [boundedFrameBrand]: true };
};

interface ScanCounters {
  properties: number;
  items: number;
  strings: number;
}

type SyntaxFrame =
  | { kind: 'object'; state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd' }
  | {
    kind: 'array';
    state: 'valueOrEnd' | 'value' | 'commaOrEnd';
  };

// This pass validates grammar without constructing the JSON value or using last-key-wins semantics.
const validateJsonSyntax = (text: string): void => {
  let index = 0;
  let rootComplete = false;
  const stack: SyntaxFrame[] = [];
  const ws = () => {
    while (/[ \t\r\n]/.test(text[index] ?? '')) index++;
  };
  const string = () => {
    if (text[index++] !== '"') throw new IntakeError('json_syntax', 'expected string');
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') return;
      if (char === '\\') {
        const escaped = text[index++];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4))) {
            throw new IntakeError('json_syntax', 'invalid unicode escape');
          }
          index += 4;
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escaped ?? '')) {
          throw new IntakeError('json_syntax', 'invalid escape');
        }
      } else if (char.charCodeAt(0) < 0x20) throw new IntakeError('json_syntax', 'control char');
    }
    throw new IntakeError('json_syntax', 'unterminated string');
  };
  const complete = () => {
    const parent = stack.at(-1);
    if (!parent) rootComplete = true;
    else parent.state = 'commaOrEnd';
  };
  const value = () => {
    ws();
    const char = text[index];
    if (char === '"') {
      string();
      complete();
    } else if (char === '{') {
      index++;
      stack.push({ kind: 'object', state: 'keyOrEnd' });
    } else if (char === '[') {
      index++;
      stack.push({ kind: 'array', state: 'valueOrEnd' });
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(index),
      );
      if (!match) throw new IntakeError('json_syntax', 'invalid value');
      index += match[0].length;
      complete();
    }
  };
  while (!rootComplete || stack.length > 0) {
    const frame = stack.at(-1);
    if (!frame) {
      value();
      continue;
    }
    ws();
    if (frame.kind === 'object') {
      if (frame.state === 'keyOrEnd') {
        if (text[index] === '}') {
          index++;
          stack.pop();
          complete();
        } else {
          string();
          frame.state = 'colon';
        }
      } else if (frame.state === 'key') {
        string();
        frame.state = 'colon';
      } else if (frame.state === 'colon') {
        if (text[index++] !== ':') throw new IntakeError('json_syntax', 'expected colon');
        frame.state = 'value';
      } else if (frame.state === 'value') value();
      else if (text[index] === '}') {
        index++;
        stack.pop();
        complete();
      } else if (text[index++] === ',') frame.state = 'key';
      else throw new IntakeError('json_syntax', 'expected comma');
    } else if (frame.state === 'valueOrEnd') {
      if (text[index] === ']') {
        index++;
        stack.pop();
        complete();
      } else {
        frame.state = 'value';
        value();
      }
    } else if (frame.state === 'value') value();
    else if (text[index] === ']') {
      index++;
      stack.pop();
      complete();
    } else if (text[index++] === ',') frame.state = 'value';
    else throw new IntakeError('json_syntax', 'expected comma');
  }
  ws();
  if (index !== text.length) throw new IntakeError('json_syntax', 'trailing input');
};

// After syntax succeeds, this scanner applies duplicate and resource limits before construction.
const scanJson = (text: string, profile: IntakeLimitProfileV1): void => {
  let index = 0;
  const counters: ScanCounters = { properties: 0, items: 0, strings: 0 };
  const ws = () => {
    while (/[ \t\r\n]/.test(text[index] ?? '')) index++;
  };
  const string = (): string => {
    const start = index;
    if (text[index++] !== '"') throw new IntakeError('json_syntax', 'expected string');
    let escaped = false;
    while (index < text.length) {
      const char = text[index++];
      if (!escaped && char === '"') {
        let decoded: string;
        try {
          decoded = JSON.parse(text.slice(start, index));
        } catch {
          throw new IntakeError('json_syntax', 'invalid string');
        }
        const bytes = utf8Length(decoded);
        if (bytes > profile.maxDecodedStringBytesEach) {
          throw new IntakeError('string_bytes', 'string exceeds limit');
        }
        counters.strings += bytes;
        if (counters.strings > profile.maxDecodedStringBytesTotal) {
          throw new IntakeError('string_bytes', 'string total exceeds limit');
        }
        return decoded;
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    throw new IntakeError('json_syntax', 'unterminated string');
  };
  const value = (depth: number): void => {
    ws();
    const char = text[index];
    if (char === '"') {
      string();
      return;
    }
    if (char === '{') {
      if (depth > profile.maxDepth) throw new IntakeError('depth', 'depth exceeds limit');
      index++;
      ws();
      const keys = new Set<string>();
      if (text[index] === '}') {
        index++;
        return;
      }
      while (true) {
        ws();
        const key = string();
        if (keys.has(key)) throw new IntakeError('duplicate_key', `duplicate key ${key}`);
        keys.add(key);
        counters.properties++;
        if (counters.properties > profile.maxObjectProperties) {
          throw new IntakeError('property_count', 'property count exceeds limit');
        }
        ws();
        if (text[index++] !== ':') throw new IntakeError('json_syntax', 'expected colon');
        value(depth + 1);
        ws();
        if (text[index] === '}') {
          index++;
          return;
        }
        if (text[index++] !== ',') throw new IntakeError('json_syntax', 'expected comma');
      }
    }
    if (char === '[') {
      if (depth > profile.maxDepth) throw new IntakeError('depth', 'depth exceeds limit');
      index++;
      ws();
      if (text[index] === ']') {
        index++;
        return;
      }
      while (true) {
        counters.items++;
        if (counters.items > profile.maxArrayItems) {
          throw new IntakeError('array_items', 'array items exceed limit');
        }
        value(depth + 1);
        ws();
        if (text[index] === ']') {
          index++;
          return;
        }
        if (text[index++] !== ',') throw new IntakeError('json_syntax', 'expected comma');
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(index),
    );
    if (!match) throw new IntakeError('json_syntax', 'invalid value');
    index += match[0].length;
  };
  value(1);
  ws();
  if (index !== text.length) throw new IntakeError('json_syntax', 'trailing input');
};

export const decodeBoundedJson = (
  frame: BoundedSubmissionFrameV1,
  profile: IntakeLimitProfileV1,
): unknown => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame.bytes);
  } catch {
    throw new IntakeError('invalid_utf8', 'input is not UTF-8');
  }
  validateJsonSyntax(text);
  scanJson(text, profile);
  return JSON.parse(text);
};
