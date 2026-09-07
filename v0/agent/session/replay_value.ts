import type { JsonValue, Message, ToolCall, ToolResultContent } from '../core/contracts.ts';

export const MAX_REPLAY_VALUE_BYTES = 65_536;
export const MAX_REPLAY_VALUE_NODES = 4_096;
export const MAX_REPLAY_VALUE_DEPTH = 16;
export const MAX_REPLAY_VALUE_PROPERTIES = 128;
export const MAX_REPLAY_ARRAY_ITEMS = 256;
export const MAX_REPLAY_MESSAGE_TEXT_BYTES = 1024 * 1024;
export const MAX_REPLAY_PLANNER_RESULT_BYTES = 2 * 1024 * 1024;
export const MAX_REPLAY_TRANSCRIPT_MESSAGES = 512;

const encoder = new TextEncoder();
const TOOL_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export class AgentReplayValueError extends Error {
  constructor() {
    super('invalid replay value');
    this.name = 'AgentReplayValueError';
  }
}

const invalid = (): never => {
  throw new AgentReplayValueError();
};

const validUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

const stringOk = (
  value: unknown,
  max = MAX_REPLAY_VALUE_BYTES,
  nonempty = false,
): value is string =>
  typeof value === 'string' && validUnicode(value) && (!nonempty || value.length > 0) &&
  encoder.encode(value).byteLength <= max;

const ownDataKeys = (value: Record<string, unknown>, names: readonly string[]): boolean => {
  const keys = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || keys.length !== names.length) {
    return false;
  }
  if (keys.some((key, index) => key !== names[index])) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const arrayData = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names[names.length - 1] !== 'length') return false;
  if (names.some((name, index) => index < value.length && name !== String(index))) return false;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    length === undefined || !('value' in length) || length.enumerable ||
    length.value !== value.length
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      return false;
    }
  }
  return true;
};

const cloneValue = (value: unknown, depth: number, state: { nodes: number }): JsonValue => {
  state.nodes += 1;
  if (state.nodes > MAX_REPLAY_VALUE_NODES) return invalid();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && !stringOk(value)) return invalid();
    return value as JsonValue;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) return invalid();
    return value;
  }
  if (depth >= MAX_REPLAY_VALUE_DEPTH) return invalid();
  if (Array.isArray(value)) {
    if (!arrayData(value) || value.length > MAX_REPLAY_ARRAY_ITEMS) return invalid();
    return Object.freeze(
      value.map((item) => cloneValue(item, depth + 1, state)),
    ) as readonly JsonValue[];
  }
  if (!plain(value)) return invalid();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > MAX_REPLAY_VALUE_PROPERTIES || keys.some((key) => !stringOk(key, 128, true))) {
    return invalid();
  }
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1] >= keys[index]) return invalid();
  }
  const copy: Record<string, JsonValue> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      return invalid();
    }
    copy[key] = cloneValue(descriptor.value, depth + 1, state);
  }
  return Object.freeze(copy);
};

/** Clone and validate one bounded descriptor-safe JSON value. */
export const cloneReplayJsonValue = (value: unknown): JsonValue => {
  const clone = cloneValue(value, 0, { nodes: 0 });
  if (encoder.encode(JSON.stringify(clone)).byteLength > MAX_REPLAY_VALUE_BYTES) return invalid();
  return clone;
};

export const validateReplayJsonValue = (value: unknown): value is JsonValue => {
  try {
    cloneReplayJsonValue(value);
    return true;
  } catch {
    return false;
  }
};

/** Validate one bounded well-formed Unicode string without coercing its value. */
export const isReplayText = (
  value: unknown,
  max = MAX_REPLAY_MESSAGE_TEXT_BYTES,
  nonempty = false,
): value is string => stringOk(value, max, nonempty);

const validCall = (value: unknown): value is ToolCall => {
  if (!plain(value) || !ownDataKeys(value, ['kind', 'callId', 'name', 'arguments'])) return false;
  return value.kind === 'tool_call' && stringOk(value.callId, 128, true) &&
    typeof value.name === 'string' && TOOL_NAME.test(value.name) &&
    validateReplayJsonValue(value.arguments);
};

const validResult = (value: unknown): value is ToolResultContent => {
  if (!plain(value)) return false;
  const keys = Object.getOwnPropertyNames(value);
  const terminal = keys.length === 6;
  const expected = terminal
    ? ['kind', 'callId', 'name', 'text', 'outcome', 'terminal']
    : ['kind', 'callId', 'name', 'text', 'outcome'];
  if (!ownDataKeys(value, expected)) return false;
  const textLimit = value.name === 'delegate_to_planner'
    ? MAX_REPLAY_PLANNER_RESULT_BYTES
    : MAX_REPLAY_MESSAGE_TEXT_BYTES;
  return value.kind === 'tool_result' && stringOk(value.callId, 128, true) &&
    typeof value.name === 'string' && TOOL_NAME.test(value.name) &&
    stringOk(value.text, textLimit) &&
    (value.outcome === 'success' || value.outcome === 'error') &&
    (!terminal || (value.outcome === 'success' && value.terminal === 'json_result'));
};

/** Clone and validate one Message using the current provider-neutral Message shape. */
export const cloneReplayMessage = (value: unknown): Message => {
  if (!plain(value) || !Object.hasOwn(value, 'role') || !Object.hasOwn(value, 'content')) {
    return invalid();
  }
  if (value.role === 'user') {
    if (
      !ownDataKeys(value, ['role', 'content']) || !plain(value.content) ||
      !ownDataKeys(value.content, ['kind', 'text']) || value.content.kind !== 'text' ||
      !stringOk(value.content.text, MAX_REPLAY_MESSAGE_TEXT_BYTES)
    ) return invalid();
    return Object.freeze({
      role: 'user' as const,
      content: Object.freeze({ kind: 'text' as const, text: value.content.text }),
    });
  }
  if (value.role === 'assistant') {
    if (!ownDataKeys(value, ['role', 'content'])) return invalid();
    if (plain(value.content)) {
      if (
        !ownDataKeys(value.content, ['kind', 'text']) || value.content.kind !== 'text' ||
        !stringOk(value.content.text, MAX_REPLAY_MESSAGE_TEXT_BYTES)
      ) return invalid();
      return Object.freeze({
        role: 'assistant' as const,
        content: Object.freeze({ kind: 'text' as const, text: value.content.text }),
      });
    }
    if (
      !arrayData(value.content) || value.content.length < 1 || value.content.length > 32 ||
      !value.content.every(validCall)
    ) return invalid();
    return Object.freeze({
      role: 'assistant' as const,
      content: Object.freeze(value.content.map((call) =>
        Object.freeze({
          kind: 'tool_call' as const,
          callId: call.callId,
          name: call.name,
          arguments: cloneReplayJsonValue(call.arguments),
        })
      )),
    });
  }
  if (value.role === 'tool') {
    if (
      !ownDataKeys(value, ['role', 'content']) || !arrayData(value.content) ||
      value.content.length < 1 || value.content.length > 32 || !value.content.every(validResult)
    ) return invalid();
    return Object.freeze({
      role: 'tool' as const,
      content: Object.freeze(value.content.map((result) =>
        Object.freeze(
          Object.hasOwn(result, 'terminal')
            ? {
              kind: 'tool_result' as const,
              callId: result.callId,
              name: result.name,
              text: result.text,
              outcome: 'success' as const,
              terminal: 'json_result' as const,
            }
            : {
              kind: 'tool_result' as const,
              callId: result.callId,
              name: result.name,
              text: result.text,
              outcome: result.outcome,
            },
        )
      )),
    });
  }
  return invalid();
};

export const cloneReplayTranscript = (
  value: unknown,
  options: { readonly min?: number; readonly max?: number; readonly maxBytes?: number } = {},
): readonly Message[] => {
  if (!arrayData(value)) return invalid();
  const min = options.min ?? 0;
  const max = options.max ?? MAX_REPLAY_TRANSCRIPT_MESSAGES;
  if (value.length < min || value.length > max) return invalid();
  const transcript = Object.freeze(value.map((message) => cloneReplayMessage(message)));
  if (encoder.encode(JSON.stringify(transcript)).byteLength > (options.maxBytes ?? 524_288)) {
    return invalid();
  }
  return transcript;
};

/** Return completed parent-turn count for the bounded schema-v1 causal grammar. */
export const parseReplayCausalTranscript = (transcript: readonly Message[]): number | undefined => {
  if (transcript.length === 0 || transcript[0].role !== 'user') return undefined;
  let index = 0;
  let turns = 0;
  while (index < transcript.length) {
    if (transcript[index].role !== 'user') return undefined;
    index += 1;
    let steering = false;
    let complete = false;
    while (index < transcript.length && !complete) {
      const assistant = transcript[index++];
      if (assistant.role !== 'assistant') return undefined;
      if (!Array.isArray(assistant.content)) {
        complete = true;
        turns += 1;
        break;
      }
      if (index >= transcript.length || transcript[index].role !== 'tool') return undefined;
      const tool = transcript[index++];
      if (tool.role !== 'tool' || tool.content.length !== assistant.content.length) {
        return undefined;
      }
      for (let item = 0; item < tool.content.length; item += 1) {
        if (
          assistant.content[item].callId !== tool.content[item].callId ||
          assistant.content[item].name !== tool.content[item].name
        ) return undefined;
      }
      if (tool.content.some((result) => 'terminal' in result)) {
        complete = true;
        turns += 1;
      } else if (index < transcript.length && transcript[index].role === 'user') {
        if (steering) return undefined;
        steering = true;
        index += 1;
      }
    }
    if (!complete) return undefined;
  }
  return turns;
};

export const replayJsonBytes = (value: unknown): Uint8Array => {
  const clone = cloneReplayJsonValue(value);
  return encoder.encode(JSON.stringify(clone));
};
