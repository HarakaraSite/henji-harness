import type { CorpusObservation, CorpusTask } from '../corpus/task_corpus.ts';
import type { LoopOutcome, ToolCallContent, ToolMessage } from '../agent/core/contracts.ts';
import { MAX_STEPS } from './offline_corpus_contract.ts';
import {
  exactKeys,
  fail,
  isJsonValue,
  isNonnegativeInteger,
  isRecord,
  malformed,
} from './offline_corpus_value.ts';

const validateLoopCounters = (outcome: Record<string, unknown>): void => {
  if (
    !isNonnegativeInteger(outcome.steps) || outcome.steps < 1 ||
    outcome.steps > MAX_STEPS ||
    !isNonnegativeInteger(outcome.toolCallCount) ||
    !isNonnegativeInteger(outcome.toolResultCount)
  ) fail('loop_outcome_invalid');
};

export const validateLoopOutcome = (
  task: CorpusTask,
  outcome: unknown,
): LoopOutcome => {
  const object = isRecord(outcome) ? outcome : fail('loop_outcome_invalid');
  const allowedKeys = [
    'ok',
    'task',
    'outcome',
    'stopReason',
    'finalText',
    'terminalKind',
    'error',
    'steps',
    'toolCallCount',
    'toolResultCount',
    'transcript',
  ];
  if (Object.keys(object).some((key) => !allowedKeys.includes(key))) {
    fail('loop_outcome_invalid');
  }
  if (typeof object.ok !== 'boolean' || object.task !== task.prompt) {
    fail('loop_outcome_invalid');
  }
  validateLoopCounters(object);
  if (!Array.isArray(object.transcript)) fail('loop_outcome_invalid');
  if (object.ok && object.stopReason === 'final') {
    if (
      !exactKeys(object, [
        'ok',
        'task',
        'outcome',
        'stopReason',
        'finalText',
        'steps',
        'toolCallCount',
        'toolResultCount',
        'transcript',
      ])
    ) fail('loop_outcome_invalid');
    if (
      object.outcome !== 'final' || object.stopReason !== 'final' ||
      typeof object.finalText !== 'string' || 'error' in object
    ) fail('loop_outcome_invalid');
    if ('terminalKind' in object) fail('loop_outcome_invalid');
  } else if (object.ok && object.stopReason === 'tool_terminal') {
    if (
      !exactKeys(object, [
        'ok',
        'task',
        'outcome',
        'stopReason',
        'finalText',
        'terminalKind',
        'steps',
        'toolCallCount',
        'toolResultCount',
        'transcript',
      ]) || object.outcome !== 'final' ||
      object.stopReason !== 'tool_terminal' ||
      object.terminalKind !== 'json_result' ||
      typeof object.finalText !== 'string' ||
      'error' in object
    ) fail('loop_outcome_invalid');
  } else if (object.outcome === 'contract_failure') {
    if (
      !exactKeys(object, [
        'ok',
        'task',
        'outcome',
        'stopReason',
        'error',
        'steps',
        'toolCallCount',
        'toolResultCount',
        'transcript',
      ])
    ) fail('loop_outcome_invalid');
    if (
      object.stopReason !== object.outcome || typeof object.error !== 'string'
    ) {
      fail('loop_outcome_invalid');
    }
  } else if (object.outcome === 'max_steps') {
    if (
      !exactKeys(object, [
        'ok',
        'task',
        'outcome',
        'stopReason',
        'steps',
        'toolCallCount',
        'toolResultCount',
        'transcript',
      ])
    ) fail('loop_outcome_invalid');
    if (object.stopReason !== object.outcome) fail('loop_outcome_invalid');
  } else {
    fail('loop_outcome_invalid');
  }
  return object as unknown as LoopOutcome;
};

const expectUserMessage = (message: unknown, prompt: string): void => {
  const object = isRecord(message) ? message : malformed();
  if (!exactKeys(object, ['role', 'content']) || object.role !== 'user') {
    malformed();
  }
  const content = object.content;
  if (
    !isRecord(content) || !exactKeys(content, ['kind', 'text']) ||
    content.kind !== 'text' ||
    content.text !== prompt
  ) malformed();
};

const parseToolCall = (
  value: unknown,
  callIds: Set<string>,
): ToolCallContent => {
  const object = isRecord(value) ? value : malformed();
  if (!exactKeys(object, ['kind', 'callId', 'name', 'arguments'])) malformed();
  if (
    object.kind !== 'tool_call' || typeof object.callId !== 'string' ||
    object.callId.trim() === '' ||
    callIds.has(object.callId) || typeof object.name !== 'string' ||
    object.name.trim() === '' ||
    !isJsonValue(object.arguments)
  ) malformed();
  const callId = typeof object.callId === 'string' ? object.callId : malformed();
  callIds.add(callId);
  return object as unknown as ToolCallContent;
};

const parseToolResult = (
  value: unknown,
  call: ToolCallContent,
): ToolMessage['content'][number] => {
  const object = isRecord(value) ? value : malformed();
  if (!exactKeys(object, ['kind', 'callId', 'name', 'text', 'outcome'])) {
    malformed();
  }
  if (
    object.kind !== 'tool_result' || object.callId !== call.callId ||
    object.name !== call.name ||
    typeof object.text !== 'string' ||
    (object.outcome !== 'success' && object.outcome !== 'error')
  ) malformed();
  return object as unknown as ToolMessage['content'][number];
};

const parseTerminalToolResult = (
  value: unknown,
  call: ToolCallContent,
): ToolMessage['content'][number] => {
  const object = isRecord(value) ? value : malformed();
  if (
    !exactKeys(object, [
      'kind',
      'callId',
      'name',
      'text',
      'outcome',
      'terminal',
    ])
  ) malformed();
  if (
    object.kind !== 'tool_result' || object.callId !== call.callId ||
    object.name !== call.name || typeof object.text !== 'string' ||
    object.outcome !== 'success' || object.terminal !== 'json_result' ||
    call.name !== 'submit_json_result'
  ) malformed();
  return object as unknown as ToolMessage['content'][number];
};

const validateTerminalSubmission = (
  call: ToolCallContent,
  result: ToolMessage['content'][number],
  finalText: string,
): void => {
  if (result.text !== 'json result submitted') malformed();
  const argumentsValue = isRecord(call.arguments) ? call.arguments : malformed();
  if (
    !exactKeys(argumentsValue, ['json']) ||
    typeof argumentsValue.json !== 'string'
  ) malformed();
  const input = argumentsValue.json as string;
  if (new TextEncoder().encode(input).byteLength > 65_536) malformed();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    malformed();
  }
  if (!isJsonValue(parsed)) malformed();
  let canonical: string | undefined;
  try {
    canonical = JSON.stringify(parsed);
  } catch {
    malformed();
  }
  if (
    canonical === undefined ||
    new TextEncoder().encode(canonical).byteLength > 65_536 ||
    canonical !== finalText
  ) malformed();
};

export const observationFromLoopOutcome = (
  task: CorpusTask,
  rawOutcome: LoopOutcome,
): CorpusObservation => {
  const outcome = validateLoopOutcome(task, rawOutcome);
  if (!outcome.ok) fail('loop_contract_failure');
  const transcript = outcome.transcript;
  if (transcript.length < 2) malformed();
  expectUserMessage(transcript[0], task.prompt);
  const toolEvents: CorpusObservation['toolEvents'][number][] = [];
  const callIds = new Set<string>();
  let index = 1;
  let requestOrdinal = 0;
  let finalText: string | undefined;
  let submission: CorpusObservation['submission'] = null;
  let assistantCount = 0;
  while (index < transcript.length) {
    const assistant = transcript[index];
    const assistantObject = isRecord(assistant) ? assistant : malformed();
    const assistantKeys = ['role', 'content'];
    if ('text' in assistantObject) {
      if (typeof assistantObject.text !== 'string') malformed();
      assistantKeys.push('text');
    }
    if ('providerState' in assistantObject) assistantKeys.push('providerState');
    if (
      assistantObject.role !== 'assistant' ||
      !exactKeys(assistantObject, assistantKeys)
    ) {
      malformed();
    }
    const content = assistantObject.content;
    if (isRecord(content)) {
      const contentObject = content as Record<string, unknown>;
      if (
        !exactKeys(contentObject, ['kind', 'text']) ||
        contentObject.kind !== 'text' ||
        typeof contentObject.text !== 'string'
      ) {
        malformed();
      }
      if (
        contentObject.text !== outcome.finalText ||
        index + 1 !== transcript.length
      ) malformed();
      finalText = typeof contentObject.text === 'string' ? contentObject.text : malformed();
      assistantCount += 1;
      index += 1;
      break;
    }
    const callsContent = Array.isArray(content) ? content : malformed();
    if (callsContent.length === 0) malformed();
    const calls = callsContent.map((value: unknown) => parseToolCall(value, callIds));
    assistantCount += 1;
    index += 1;
    if (index >= transcript.length) malformed();
    const tool = transcript[index];
    const toolObject = isRecord(tool) ? tool : malformed();
    if (
      toolObject.role !== 'tool' || !exactKeys(toolObject, ['role', 'content'])
    ) malformed();
    const toolContent =
      (Array.isArray(toolObject.content) ? toolObject.content : malformed()) as unknown[];
    if (toolContent.length !== calls.length) {
      malformed();
    }
    if (calls.length === 1 && calls[0].name === 'submit_json_result') {
      const result = parseTerminalToolResult(toolContent[0], calls[0]);
      if (
        index + 1 !== transcript.length ||
        outcome.stopReason !== 'tool_terminal' ||
        outcome.terminalKind !== 'json_result'
      ) {
        malformed();
      }
      validateTerminalSubmission(calls[0], result, outcome.finalText!);
      submission = {
        kind: 'json_result',
        requestOrdinal,
        callId: calls[0].callId,
        resultCallId: result.callId,
        outcome: 'success',
      };
      index += 1;
      requestOrdinal += 1;
      break;
    }
    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      const result = parseToolResult(toolContent[callIndex], calls[callIndex]);
      toolEvents.push({
        requestOrdinal,
        callId: calls[callIndex].callId,
        resultCallId: result.callId,
        callName: calls[callIndex].name,
        resultName: result.name,
        outcome: result.outcome,
      });
    }
    index += 1;
    requestOrdinal += 1;
  }
  if (outcome.stopReason === 'final') requestOrdinal += 1;
  if (
    finalText === undefined && submission === null ||
    index !== transcript.length
  ) malformed();
  if (
    assistantCount !== outcome.steps ||
    toolEvents.length + (submission === null ? 0 : 1) !==
      outcome.toolCallCount ||
    toolEvents.length + (submission === null ? 0 : 1) !==
      outcome.toolResultCount ||
    assistantCount !== requestOrdinal
  ) fail('loop_outcome_invalid');
  return {
    finalText: typeof finalText === 'string' ? finalText : outcome.finalText!,
    requestCount: outcome.steps,
    toolEvents,
    submission,
  };
};
