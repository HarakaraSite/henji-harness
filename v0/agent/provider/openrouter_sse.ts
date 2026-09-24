import type {
  JsonValue,
  ModelGenerateOptions,
  ModelResult,
  OpenRouterProviderState,
} from '../core/contracts.ts';
import { EventDeliveryError } from '../core/events.ts';
import { CancellationCleanupError, TurnCancelledError } from '../core/cancellation.ts';
import type { ProviderEvidenceRecorder } from './provider_evidence.ts';
import { PRODUCTION_PROFILE } from './provider_profile.ts';
import { readableThinkingFromDetails } from '../core/readable_thinking.ts';
import {
  MAX_ASSISTANT_PROGRESS_TEXT_BYTES,
  MAX_ASSISTANT_TEXT_BYTES,
  OpenRouterAgentError,
  type StreamTextAccountingObserver,
} from './openrouter_contract.ts';
import {
  hasOwn,
  providerTimeoutError,
  responseStreamError,
  sseResponseError,
  withResponseStatus,
} from './openrouter_response.ts';
import { bytes, isJsonValue, nonBlank } from './openrouter_value.ts';

const encoder = new TextEncoder();

type SsePayloadHandler = (payload: string, rawFrame: string) => void;

/**
 * Dependency-free SSE framer for the documented Chat Completions subset. It deliberately keeps
 * no raw frame after dispatch; callers receive one decoded data payload at a time.
 */
class SseFramer {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private pendingCr = false;
  private dataLines: string[] = [];
  private eventLines: string[] = [];
  private bomHandled = false;
  private _done = false;

  constructor(private readonly onPayload: SsePayloadHandler) {}

  get done(): boolean {
    return this._done;
  }

  push(bytes: Uint8Array): void {
    if (this._done) return;
    let decoded: string;
    try {
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw sseResponseError('provider response contained invalid UTF-8', 'invalid_utf8');
    }
    this.consume(decoded);
  }

  finish(): void {
    if (this._done) return;
    let decoded: string;
    try {
      decoded = this.decoder.decode();
    } catch {
      throw sseResponseError('provider response contained invalid UTF-8', 'invalid_utf8');
    }
    this.consume(decoded);
    if (this._done) return;
    if (this.pendingCr) {
      this.pendingCr = false;
      this.finishLine();
    }
    // A final nonblank line or a data field without a separator is an incomplete event. Even
    // when the semantic result is already present, `[DONE]` must have a complete SSE frame.
    if (this.line.length > 0 || this.dataLines.length > 0) {
      throw sseResponseError(
        'provider response stream ended with an incomplete event',
        'invalid_sse_framing',
      );
    }
    throw sseResponseError(
      'provider response stream ended before [DONE]',
      'stream_ended_before_done',
    );
  }

  private consume(decoded: string): void {
    for (const character of decoded) {
      if (this._done) return;
      if (!this.bomHandled) {
        this.bomHandled = true;
        if (character === '\ufeff') continue;
      }
      if (this.pendingCr) {
        this.pendingCr = false;
        if (character === '\n') continue;
      }
      if (character === '\r') {
        this.pendingCr = true;
        this.finishLine();
      } else if (character === '\n') {
        this.finishLine();
      } else {
        this.line += character;
      }
    }
  }

  private finishLine(): void {
    const line = this.line;
    this.line = '';
    this.eventLines.push(line);
    if (line.length === 0) {
      this.dispatchEvent();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== 'data') return;
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.dataLines.push(value);
  }

  private dispatchEvent(): void {
    if (this.dataLines.length === 0) {
      this.eventLines = [];
      return;
    }
    const payload = this.dataLines.join('\n');
    const rawFrame = `${this.eventLines.join('\n')}\n`;
    this.dataLines = [];
    this.eventLines = [];
    if (payload.length === 0) {
      throw sseResponseError('provider response contained empty data', 'empty_terminal_result');
    }
    this.onPayload(payload, rawFrame);
    if (payload === '[DONE]') this._done = true;
  }
}

interface StreamToolAssembly {
  readonly index: number;
  id?: string;
  type?: 'function';
  name?: string;
  arguments: string;
}

interface StreamAssembly {
  completionId?: string;
  textParts: string[];
  /** UTF-8 accounting is accumulated per delta; never re-encode the growing text. */
  textBytes: number;
  sawText: boolean;
  sawTools: boolean;
  tools: Map<number, StreamToolAssembly>;
  reasoningDetails: JsonValue[];
  reasoningParts: string[];
  reasoningField?: 'reasoning' | 'reasoning_content';
  liveFrozen: boolean;
  progressText: string;
  progressBytes: number;
  lastReported?: string;
  terminal?: 'stop' | 'tool_calls';
  postTerminalUsageSeen: boolean;
  result?: ModelResult;
}

const STREAM_USAGE_REQUIRED_KEYS = ['completion_tokens', 'prompt_tokens', 'total_tokens'] as const;

const isStreamUsage = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  // Providers may append accounting metadata (for example `cost` or token-detail objects). Only
  // the documented completion counters are required, and usage is never exposed in ModelResult.
  return STREAM_USAGE_REQUIRED_KEYS.every((key) =>
    typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && usage[key] >= 0
  );
};

const safeIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const updateStreamTool = (
  assembly: StreamAssembly,
  raw: unknown,
): void => {
  if (typeof raw !== 'object' || raw === null) {
    throw sseResponseError('provider tool call shape was unsupported', 'unsupported_delta_shape');
  }
  const fragment = raw as {
    index?: unknown;
    id?: unknown;
    type?: unknown;
    function?: unknown;
  };
  if (!safeIndex(fragment.index)) {
    throw sseResponseError('provider tool-call index was invalid', 'incomplete_tool_call');
  }
  const index = fragment.index;
  let target = assembly.tools.get(index);
  if (target === undefined) {
    target = { index, arguments: '' };
    assembly.tools.set(index, target);
  }
  // Some Chat Completions streams repeat metadata keys with null on continuation chunks.
  // The first non-null value remains authoritative; completion still requires all metadata.
  if (hasOwn(fragment, 'id') && fragment.id !== null) {
    if (!nonBlank(fragment.id)) {
      throw sseResponseError('provider tool-call id was invalid', 'incomplete_tool_call');
    }
    if (target.id !== undefined && target.id !== fragment.id) {
      throw sseResponseError('provider tool-call metadata conflicted', 'incomplete_tool_call');
    }
    target.id = fragment.id;
  }
  if (hasOwn(fragment, 'type')) {
    if (fragment.type !== 'function') {
      throw sseResponseError('provider tool-call type was invalid', 'incomplete_tool_call');
    }
    if (target.type !== undefined && target.type !== fragment.type) {
      throw sseResponseError('provider tool-call metadata conflicted', 'incomplete_tool_call');
    }
    target.type = 'function';
  }
  if (hasOwn(fragment, 'function')) {
    if (typeof fragment.function !== 'object' || fragment.function === null) {
      throw sseResponseError('provider tool-call function was invalid', 'incomplete_tool_call');
    }
    const fn = fragment.function as { name?: unknown; arguments?: unknown };
    if (hasOwn(fn, 'name') && fn.name !== null) {
      if (!nonBlank(fn.name)) {
        throw sseResponseError('provider tool-call name was invalid', 'incomplete_tool_call');
      }
      if (target.name !== undefined && target.name !== fn.name) {
        throw sseResponseError('provider tool-call metadata conflicted', 'incomplete_tool_call');
      }
      target.name = fn.name;
    }
    if (hasOwn(fn, 'arguments')) {
      if (typeof fn.arguments !== 'string') {
        throw sseResponseError(
          'provider tool-call arguments were invalid',
          'invalid_tool_arguments',
        );
      }
      target.arguments += fn.arguments;
    }
  }
};

const completeStreamTools = (assembly: StreamAssembly): ModelResult => {
  const indices = [...assembly.tools.keys()].sort((left, right) => left - right);
  if (
    indices.length === 0 ||
    indices.some((index, position) => index !== position)
  ) {
    throw sseResponseError(
      'provider tool-call indices were not contiguous',
      'incomplete_tool_call',
    );
  }
  const calls = indices.map((index) => {
    const tool = assembly.tools.get(index)!;
    if (
      !nonBlank(tool.id) || tool.type !== 'function' || !nonBlank(tool.name)
    ) {
      throw sseResponseError('provider tool-call metadata was incomplete', 'incomplete_tool_call');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tool.arguments);
    } catch {
      throw sseResponseError('provider tool-call arguments were invalid', 'invalid_tool_arguments');
    }
    if (!isJsonValue(parsed)) {
      throw sseResponseError('provider tool-call arguments were invalid', 'invalid_tool_arguments');
    }
    return { callId: tool.id, name: tool.name, arguments: parsed };
  });
  return { kind: 'tool_calls', calls };
};

const processSsePayload = (
  assembly: StreamAssembly,
  payload: string,
  report: ModelGenerateOptions['reportAssistantProgress'],
  observer?: StreamTextAccountingObserver,
  providerId = 'openrouter-chat',
  modelId = PRODUCTION_PROFILE.model,
  reportThinkingDelta?: ModelGenerateOptions['reportThinkingDelta'],
): void => {
  if (payload === '[DONE]') {
    if (assembly.terminal === undefined || assembly.result === undefined) {
      throw sseResponseError(
        'provider stream ended before a terminal result',
        'stream_ended_before_done',
      );
    }
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw sseResponseError('provider response contained invalid JSON', 'invalid_sse_json');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw sseResponseError('provider response shape was unsupported', 'unsupported_response_shape');
  }
  const object = raw as Record<string, unknown>;
  if (
    hasOwn(object, 'error') && object.error !== undefined &&
    object.error !== null
  ) {
    throw sseResponseError('provider response reported an error', 'provider_reported_error');
  }
  // Some OpenAI-compatible providers (for example OpenCode Go) put `usage: null` on every content
  // chunk, so only a present non-null usage counts as a usage frame.
  const hasUsage = hasOwn(object, 'usage') && object.usage !== null &&
    object.usage !== undefined;
  if (!nonBlank(object.id)) {
    throw sseResponseError('provider completion id was invalid', 'invalid_completion_identity');
  }
  if (assembly.completionId === undefined) assembly.completionId = object.id;
  else if (assembly.completionId !== object.id) {
    throw sseResponseError('provider completion id changed', 'invalid_completion_identity');
  }
  const choices = object.choices;
  // A post-terminal usage-only frame (OpenAI `include_usage`, OpenCode Go) carries `choices: []`.
  const usageOnly = hasUsage && Array.isArray(choices) && choices.length === 0;
  if (usageOnly) {
    if (assembly.terminal === undefined) {
      throw sseResponseError('provider usage frame arrived before terminal', 'invalid_usage_frame');
    }
    if (assembly.postTerminalUsageSeen || !isStreamUsage(object.usage)) {
      throw sseResponseError(
        'provider response contained data after terminal',
        'data_after_terminal',
      );
    }
    assembly.postTerminalUsageSeen = true;
    return;
  }
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw sseResponseError(
      'provider response choice shape was unsupported',
      'unsupported_choice_shape',
    );
  }
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
    throw sseResponseError(
      'provider response choice shape was unsupported',
      'unsupported_choice_shape',
    );
  }
  const choiceObject = choice as Record<string, unknown>;
  if (choiceObject.index !== 0) {
    throw sseResponseError(
      'provider response choice index was invalid',
      'unsupported_choice_shape',
    );
  }
  const finishReason = choiceObject.finish_reason;
  if (
    finishReason !== undefined && finishReason !== null &&
    finishReason !== 'stop' && finishReason !== 'tool_calls'
  ) {
    throw sseResponseError(
      'provider response finish reason was unsupported',
      'unsupported_finish_reason',
    );
  }
  const delta = choiceObject.delta;
  if (
    delta !== undefined &&
    (typeof delta !== 'object' || delta === null || Array.isArray(delta))
  ) {
    throw sseResponseError(
      'provider response delta shape was unsupported',
      'unsupported_delta_shape',
    );
  }
  const deltaObject = (delta ?? {}) as Record<string, unknown>;
  const reasoningDetails = deltaObject.reasoning_details;
  if (reasoningDetails !== undefined && reasoningDetails !== null) {
    if (!Array.isArray(reasoningDetails) || !reasoningDetails.every(isJsonValue)) {
      throw sseResponseError(
        'provider reasoning details were unsupported',
        'unsupported_delta_shape',
      );
    }
    assembly.reasoningDetails.push(...structuredClone(reasoningDetails));
  }
  const plainField = typeof deltaObject.reasoning_content === 'string' &&
      deltaObject.reasoning_content.length > 0
    ? 'reasoning_content'
    : typeof deltaObject.reasoning === 'string' && deltaObject.reasoning.length > 0
    ? 'reasoning'
    : undefined;
  if (plainField !== undefined) {
    assembly.reasoningField ??= plainField;
    const part = deltaObject[plainField] as string;
    assembly.reasoningParts.push(part);
    reportThinkingDelta?.({ kind: 'text', text: part });
  } else if (Array.isArray(reasoningDetails)) {
    const readable = readableThinkingFromDetails(reasoningDetails);
    if (readable !== undefined) reportThinkingDelta?.(readable);
  }
  const contentPresent = hasOwn(deltaObject, 'content');
  const content = deltaObject.content;
  const hasContent = typeof content === 'string' && content.length > 0;
  if (
    contentPresent && content !== null && content !== '' &&
    typeof content !== 'string'
  ) {
    throw sseResponseError('provider response content was unsupported', 'unsupported_delta_shape');
  }
  if (
    hasOwn(deltaObject, 'role') && deltaObject.role !== 'assistant' &&
    deltaObject.role !== null
  ) {
    throw sseResponseError('provider response role was invalid', 'unsupported_delta_shape');
  }
  const toolCalls = deltaObject.tool_calls;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (
    hasOwn(deltaObject, 'tool_calls') && toolCalls !== null &&
    !Array.isArray(toolCalls)
  ) {
    throw sseResponseError(
      'provider response tool calls were unsupported',
      'unsupported_delta_shape',
    );
  }

  if (assembly.terminal !== undefined) {
    // Only one content-free post-terminal usage frame is accepted. It has no effect on the
    // authoritative result and cannot consume assistant progress bounds.
    if (
      assembly.postTerminalUsageSeen || !hasUsage || !isStreamUsage(object.usage) ||
      finishReason !== assembly.terminal || hasContent || hasToolCalls ||
      hasOwn(deltaObject, 'content') && content !== '' ||
      hasOwn(deltaObject, 'role') && deltaObject.role !== 'assistant' &&
        deltaObject.role !== null
    ) {
      throw sseResponseError(
        'provider response contained data after terminal',
        'data_after_terminal',
      );
    }
    assembly.postTerminalUsageSeen = true;
    return;
  }

  // A usage frame may share the terminal frame (finish_reason + usage in one chunk, as OpenCode Go
  // deepseek does). Only a usage frame without a terminal reason is out of order.
  if (hasUsage && (finishReason === undefined || finishReason === null)) {
    throw sseResponseError('provider usage frame arrived before terminal', 'invalid_usage_frame');
  }

  if (hasContent) {
    assembly.sawText = true;
    // Keep fragments until the terminal result. Repeatedly concatenating an ever-growing
    // provider string can force quadratic copying on runtimes that flatten ropes eagerly.
    assembly.textParts.push(content);
    const contentBytes = bytes(content);
    observer?.onFragmentBytes?.(contentBytes);
    assembly.textBytes += contentBytes;
    if (assembly.textBytes > MAX_ASSISTANT_TEXT_BYTES) {
      throw new OpenRouterAgentError(
        'limit_exceeded',
        'assistant response exceeds 1 MiB',
        1,
        undefined,
        {
          stage: 'response_parse',
          code: 'limit_exceeded',
          parseReason: 'response_body_too_large',
        },
      );
    }
    if (report && !assembly.liveFrozen) {
      for (const character of content) {
        observer?.onProgressCodePoint?.();
        const size = encoder.encode(character).byteLength;
        if (assembly.progressBytes + size > MAX_ASSISTANT_PROGRESS_TEXT_BYTES) {
          assembly.liveFrozen = true;
          break;
        }
        assembly.progressText += character;
        assembly.progressBytes += size;
      }
      if (
        assembly.progressText.length > 0 && assembly.progressText !== assembly.lastReported
      ) {
        report(assembly.progressText);
        assembly.lastReported = assembly.progressText;
      }
      if (assembly.textBytes > MAX_ASSISTANT_PROGRESS_TEXT_BYTES) {
        assembly.liveFrozen = true;
      }
    }
  }
  if (hasToolCalls) {
    assembly.sawTools = true;
    for (const fragment of toolCalls!) updateStreamTool(assembly, fragment);
  }
  if (finishReason === undefined || finishReason === null) return;
  const state: OpenRouterProviderState | undefined = assembly.reasoningDetails.length === 0 &&
      assembly.reasoningParts.length === 0
    ? undefined
    : {
      provider: providerId,
      model: modelId,
      ...(assembly.reasoningParts.length === 0 ? {} : {
        reasoning: {
          field: assembly.reasoningField!,
          text: assembly.reasoningParts.join(''),
        },
      }),
      ...(assembly.reasoningDetails.length === 0 ? {} : {
        reasoningDetails: structuredClone(assembly.reasoningDetails),
      }),
    };
  if (finishReason === 'stop') {
    if (!assembly.sawText || assembly.sawTools || assembly.textBytes === 0) {
      throw sseResponseError(
        'provider stop result was empty or unsupported',
        'empty_terminal_result',
      );
    }
    assembly.terminal = 'stop';
    assembly.result = {
      kind: 'final',
      text: assembly.textParts.join(''),
      ...(state === undefined ? {} : { providerState: state }),
    };
  } else {
    if (!assembly.sawTools) {
      throw sseResponseError(
        'provider tool result was empty or unsupported',
        'empty_terminal_result',
      );
    }
    assembly.terminal = 'tool_calls';
    const result = completeStreamTools(assembly);
    const mixed = assembly.sawText ? { ...result, text: assembly.textParts.join('') } : result;
    assembly.result = state === undefined ? mixed : {
      ...mixed,
      providerState: state,
    };
  }
};

export const readSseResponse = async (
  response: Response,
  report: ModelGenerateOptions['reportAssistantProgress'],
  isTurnCancelled: () => boolean,
  isTimedOut: () => boolean,
  observer?: StreamTextAccountingObserver,
  evidence?: ProviderEvidenceRecorder,
  providerId = 'openrouter-chat',
  modelId = PRODUCTION_PROFILE.model,
  reportThinkingDelta?: ModelGenerateOptions['reportThinkingDelta'],
): Promise<ModelResult> => {
  if (!response.body) {
    throw sseResponseError(
      'provider response had no body',
      'response_body_missing',
      response.status,
    );
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw responseStreamError(response.status);
  }
  const assembly: StreamAssembly = {
    textParts: [],
    textBytes: 0,
    sawText: false,
    sawTools: false,
    tools: new Map(),
    reasoningDetails: [],
    reasoningParts: [],
    liveFrozen: false,
    progressText: '',
    progressBytes: 0,
    postTerminalUsageSeen: false,
  };
  const framer = new SseFramer((payload, rawFrame) => {
    let parsed: unknown;
    if (payload === '[DONE]') parsed = '[DONE]';
    else {
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = undefined;
      }
    }
    const eventOrdinal = evidence?.recordSseEvent({
      data: payload,
      rawFrame,
      ...(parsed === '[DONE]' || parsed !== undefined && isJsonValue(parsed) ? { parsed } : {}),
    });
    evidence?.recordParserTransition({
      kind: 'event',
      ...(eventOrdinal === undefined ? {} : { reason: `sse_event_${eventOrdinal}` }),
      ...(parsed !== undefined && isJsonValue(parsed) ? { detail: parsed } : {}),
    });
    try {
      const terminalBefore = assembly.terminal;
      processSsePayload(
        assembly,
        payload,
        report,
        observer,
        providerId,
        modelId,
        reportThinkingDelta,
      );
      if (terminalBefore === undefined && assembly.terminal !== undefined) {
        evidence?.recordParserTransition({ kind: 'terminal', reason: assembly.terminal });
      }
      if (payload === '[DONE]') {
        evidence?.recordParserTransition({ kind: 'result', reason: 'done' });
      }
    } catch (error) {
      if (error instanceof OpenRouterAgentError) {
        const parseReason = error.failureFact.parseReason;
        let field = 'provider response';
        if (
          parseReason === 'data_after_terminal' && typeof parsed === 'object' && parsed !== null
        ) {
          const choice = (parsed as Record<string, unknown>).choices;
          const delta = Array.isArray(choice) && choice[0] !== null && typeof choice[0] === 'object'
            ? (choice[0] as Record<string, unknown>).delta
            : undefined;
          if (typeof delta === 'object' && delta !== null) {
            const deltaObject = delta as Record<string, unknown>;
            field = Object.hasOwn(deltaObject, 'content')
              ? 'choices[0].delta.content'
              : Object.hasOwn(deltaObject, 'tool_calls')
              ? 'choices[0].delta.tool_calls'
              : Object.hasOwn(deltaObject, 'role')
              ? 'choices[0].delta.role'
              : 'choices[0].delta';
          }
        }
        evidence?.recordParserTransition({
          kind: 'failure',
          reason: parseReason ?? error.code,
          field,
          ...(parsed !== undefined && isJsonValue(parsed) ? { detail: parsed } : {}),
        });
      }
      throw error;
    }
  });
  const classifySettledFailure = (error: unknown): Error => {
    if (error instanceof EventDeliveryError) return error;
    if (isTurnCancelled()) return new TurnCancelledError();
    if (isTimedOut()) return providerTimeoutError();
    if (error instanceof OpenRouterAgentError) {
      return withResponseStatus(error, response.status);
    }
    return responseStreamError(response.status);
  };
  const settleActiveReaderFailure = async (error: unknown): Promise<never> => {
    let settled = true;
    try {
      await reader.cancel('provider response stream failed');
    } catch {
      settled = false;
    }
    if (!settled) {
      if (error instanceof EventDeliveryError || isTurnCancelled()) {
        throw new CancellationCleanupError();
      }
      if (isTimedOut()) throw providerTimeoutError();
      throw responseStreamError(response.status);
    }
    throw classifySettledFailure(error);
  };
  let failure: unknown;
  let result: ModelResult | undefined;
  try {
    for (;;) {
      // A continuous stream keeps this loop in microtasks, which starves the macrotask deadline
      // timer. The elapsed check aborts the fetch; settle the active reader as well.
      if (isTimedOut()) {
        await settleActiveReaderFailure(providerTimeoutError());
      }
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch (error) {
        // A rejected read means the stream is already errored. Calling cancel again returns the
        // stored stream error in Deno and does not prove a new cleanup failure.
        failure = classifySettledFailure(error);
        break;
      }
      if (item.done) {
        try {
          framer.finish();
        } catch (error) {
          failure = await settleActiveReaderFailure(error);
        }
        break;
      }
      evidence?.appendResponseBytes(item.value);
      try {
        framer.push(item.value);
      } catch (error) {
        failure = await settleActiveReaderFailure(error);
        break;
      }
      if (framer.done) {
        try {
          await reader.cancel('provider stream complete');
        } catch (_error) {
          failure = isTurnCancelled()
            ? new CancellationCleanupError()
            : isTimedOut()
            ? providerTimeoutError()
            : responseStreamError(response.status);
          break;
        }
        result = assembly.result;
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      failure = failure instanceof EventDeliveryError ||
          failure instanceof CancellationCleanupError ||
          isTurnCancelled()
        ? new CancellationCleanupError()
        : isTimedOut()
        ? providerTimeoutError()
        : responseStreamError(response.status);
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw responseStreamError(response.status);
  return result;
};
