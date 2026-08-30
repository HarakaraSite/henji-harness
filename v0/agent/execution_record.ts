import type { Message } from './contracts.ts';
import type { AgentReplayEnvelopeV1 } from './replay_envelope.ts';
import {
  cloneReplayJsonValue,
  cloneReplayTranscript,
  isReplayText,
  parseReplayCausalTranscript,
} from './replay_value.ts';

export const EXECUTION_RECORD_SCHEMA_VERSION = 1 as const;
export const MAX_EXECUTION_MODEL_CALLS = 16;
export const MAX_EXECUTION_TOOL_CALLS = 512;
export const MAX_EXECUTION_TOOL_RESULTS = 512;
export const MAX_EXECUTION_TRANSCRIPT_MESSAGES = 512;
export const MAX_EXECUTION_TRANSCRIPT_BYTES = 524_288;
export const MAX_EXECUTION_RECORD_BYTES = 1_048_576;

const TOOL_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const STOP_REASONS = [
  'final',
  'tool_terminal',
  'max_steps',
  'contract_failure',
  'cancelled',
] as const;
const RESULT_KINDS = ['final', 'tool_calls', 'error', 'cancelled'] as const;
const TOOL_OUTCOMES = ['success', 'error'] as const;
const encoder = new TextEncoder();

export type ExecutionRole = 'parent' | 'planner';
export type ExecutionResultKind = typeof RESULT_KINDS[number];
export type ExecutionStopReason = typeof STOP_REASONS[number];

export interface AgentExecutionModelCall {
  readonly ordinal: number;
  readonly role: ExecutionRole;
  readonly roleOrdinal: number;
  readonly resultKind: ExecutionResultKind;
}

export interface AgentExecutionToolCall {
  readonly ordinal: number;
  readonly role: ExecutionRole;
  readonly roleOrdinal: number;
  readonly modelCallOrdinal: number;
  readonly callId: string;
  readonly name: string;
  readonly arguments: import('./contracts.ts').JsonValue;
}

export interface AgentExecutionToolResult {
  readonly ordinal: number;
  readonly role: ExecutionRole;
  readonly roleOrdinal: number;
  readonly callOrdinal: number;
  readonly callId: string;
  readonly name: string;
  readonly outcome: 'success' | 'error';
  readonly terminal: 'none' | 'json_result';
  readonly result: import('./contracts.ts').JsonValue;
}

export interface AgentExecutionOutcome {
  readonly ok: boolean;
  readonly stopReason: ExecutionStopReason;
  readonly committed: boolean;
  readonly terminalKind: 'none' | 'json_result';
}

export interface AgentExecutionRoleCounts {
  readonly parent: number;
  readonly planner: number;
  readonly aggregate: number;
}

export interface AgentExecutionUsage {
  readonly steps: number;
  readonly modelRequests: AgentExecutionRoleCounts;
  readonly externalRequests: number;
  readonly toolCalls: AgentExecutionRoleCounts;
  readonly toolResults: AgentExecutionRoleCounts;
  readonly providerTokenUsage: 'unsupported';
  readonly cost: 'unsupported';
}

export interface AgentExecutionRecordV1 {
  readonly schemaVersion: 1;
  readonly runOrdinal: number;
  readonly envelopeIdentity: string;
  readonly manifestIdentity: string;
  readonly durationMicros: number;
  readonly outcome: AgentExecutionOutcome;
  readonly usage: AgentExecutionUsage;
  readonly modelCalls: readonly AgentExecutionModelCall[];
  readonly toolCalls: readonly AgentExecutionToolCall[];
  readonly toolResults: readonly AgentExecutionToolResult[];
  readonly transcript: readonly Message[];
}

export class AgentExecutionRecordError extends Error {
  constructor() {
    super('invalid agent execution record');
    this.name = 'AgentExecutionRecordError';
  }
}

const invalid = (): never => {
  throw new AgentExecutionRecordError();
};

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

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

const arrayData = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  return length !== undefined && 'value' in length && !length.enumerable &&
    length.value === value.length &&
    keys.length === value.length + 1 && keys[keys.length - 1] === 'length' &&
    keys.slice(0, -1).every((key, index) => key === String(index)) &&
    (() => {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          return false;
        }
      }
      return true;
    })();
};

const safeInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

const equalJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const envelopeIdentities = (
  envelope: AgentReplayEnvelopeV1,
): {
  envelope: string;
  manifest: string;
  maxSteps: number;
  maxExternal: number;
  maxWall: number;
} => {
  if (
    !plain(envelope) || typeof envelope.identity !== 'string' ||
    typeof envelope.manifest?.identity !== 'string'
  ) return invalid();
  return {
    envelope: envelope.identity,
    manifest: envelope.manifest.identity,
    maxSteps: envelope.budget.maxSteps,
    maxExternal: envelope.budget.maxExternalRequests,
    maxWall: envelope.budget.maxWallTimeMicros,
  };
};

const roleCounts = (
  items: readonly { readonly role: ExecutionRole }[],
): AgentExecutionRoleCounts => {
  const parent = items.filter((item) => item.role === 'parent').length;
  const planner = items.filter((item) => item.role === 'planner').length;
  return { parent, planner, aggregate: parent + planner };
};

const cloneModelCalls = (value: unknown): readonly AgentExecutionModelCall[] => {
  if (!arrayData(value) || value.length > MAX_EXECUTION_MODEL_CALLS) return invalid();
  const calls = value.map((item) => {
    if (
      !plain(item) || !ownDataKeys(item, ['ordinal', 'role', 'roleOrdinal', 'resultKind']) ||
      !safeInt(item.ordinal, 1, MAX_EXECUTION_MODEL_CALLS) ||
      (item.role !== 'parent' && item.role !== 'planner') ||
      !safeInt(item.roleOrdinal, 1, MAX_EXECUTION_MODEL_CALLS) ||
      !RESULT_KINDS.includes(item.resultKind as ExecutionResultKind)
    ) return invalid();
    return Object.freeze({
      ordinal: item.ordinal,
      role: item.role,
      roleOrdinal: item.roleOrdinal,
      resultKind: item.resultKind,
    });
  });
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (call.ordinal !== index + 1) return invalid();
    const prior = calls.slice(0, index).filter((item) => item.role === call.role).length;
    if (call.roleOrdinal !== prior + 1) return invalid();
  }
  return Object.freeze(calls) as readonly AgentExecutionModelCall[];
};

const textId = (value: unknown): value is string => isReplayText(value, 128, true);

const cloneToolCalls = (
  value: unknown,
  modelCalls: readonly AgentExecutionModelCall[],
): readonly AgentExecutionToolCall[] => {
  if (!arrayData(value) || value.length > MAX_EXECUTION_TOOL_CALLS) return invalid();
  const calls = value.map((item) => {
    if (
      !plain(item) ||
      !ownDataKeys(item, [
        'ordinal',
        'role',
        'roleOrdinal',
        'modelCallOrdinal',
        'callId',
        'name',
        'arguments',
      ]) ||
      !safeInt(item.ordinal, 1, MAX_EXECUTION_TOOL_CALLS) ||
      (item.role !== 'parent' && item.role !== 'planner') ||
      !safeInt(item.roleOrdinal, 1, MAX_EXECUTION_TOOL_CALLS) ||
      !safeInt(item.modelCallOrdinal, 1, modelCalls.length) ||
      !textId(item.callId) || typeof item.name !== 'string' || !TOOL_NAME.test(item.name)
    ) return invalid();
    const referenced = modelCalls[item.modelCallOrdinal - 1];
    if (
      referenced === undefined || referenced.role !== item.role ||
      referenced.resultKind !== 'tool_calls'
    ) return invalid();
    return Object.freeze({
      ordinal: item.ordinal,
      role: item.role,
      roleOrdinal: item.roleOrdinal,
      modelCallOrdinal: item.modelCallOrdinal,
      callId: item.callId,
      name: item.name,
      arguments: cloneReplayJsonValue(item.arguments),
    });
  });
  const ids = new Set<string>();
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (call.ordinal !== index + 1) return invalid();
    const rolePrior = calls.slice(0, index).filter((item) => item.role === call.role).length;
    if (call.roleOrdinal !== rolePrior + 1 || ids.has(`${call.role}\0${call.callId}`)) {
      return invalid();
    }
    ids.add(`${call.role}\0${call.callId}`);
  }
  return Object.freeze(calls) as readonly AgentExecutionToolCall[];
};

const cloneToolResults = (
  value: unknown,
  calls: readonly AgentExecutionToolCall[],
): readonly AgentExecutionToolResult[] => {
  if (!arrayData(value) || value.length > MAX_EXECUTION_TOOL_RESULTS) return invalid();
  const results = value.map((item) => {
    if (
      !plain(item) ||
      !ownDataKeys(item, [
        'ordinal',
        'role',
        'roleOrdinal',
        'callOrdinal',
        'callId',
        'name',
        'outcome',
        'terminal',
        'result',
      ]) ||
      !safeInt(item.ordinal, 1, MAX_EXECUTION_TOOL_RESULTS) ||
      (item.role !== 'parent' && item.role !== 'planner') ||
      !safeInt(item.roleOrdinal, 1, MAX_EXECUTION_TOOL_RESULTS) ||
      !safeInt(item.callOrdinal, 1, MAX_EXECUTION_TOOL_CALLS) ||
      !textId(item.callId) || typeof item.name !== 'string' || !TOOL_NAME.test(item.name) ||
      !TOOL_OUTCOMES.includes(item.outcome as 'success' | 'error') ||
      (item.terminal !== 'none' && item.terminal !== 'json_result')
    ) return invalid();
    const call = calls.find((candidate) => candidate.ordinal === item.callOrdinal);
    if (
      call === undefined || call.role !== item.role || call.callId !== item.callId ||
      call.name !== item.name
    ) return invalid();
    if (
      item.terminal === 'json_result' &&
      (item.outcome !== 'success' || item.name !== 'submit_json_result')
    ) return invalid();
    return Object.freeze({
      ordinal: item.ordinal,
      role: item.role,
      roleOrdinal: item.roleOrdinal,
      callOrdinal: item.callOrdinal,
      callId: item.callId,
      name: item.name,
      outcome: item.outcome,
      terminal: item.terminal,
      result: cloneReplayJsonValue(item.result),
    });
  });
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.ordinal !== index + 1) return invalid();
    const rolePrior = results.slice(0, index).filter((item) => item.role === result.role).length;
    if (result.roleOrdinal !== rolePrior + 1) return invalid();
    if (
      results.slice(0, index).some((item) =>
        item.callOrdinal === result.callOrdinal && item.role === result.role
      )
    ) return invalid();
  }
  return Object.freeze(results) as readonly AgentExecutionToolResult[];
};

const cloneOutcome = (value: unknown): AgentExecutionOutcome => {
  if (
    !plain(value) || !ownDataKeys(value, ['ok', 'stopReason', 'committed', 'terminalKind']) ||
    typeof value.ok !== 'boolean' ||
    !STOP_REASONS.includes(value.stopReason as ExecutionStopReason) ||
    typeof value.committed !== 'boolean' ||
    (value.terminalKind !== 'none' && value.terminalKind !== 'json_result')
  ) return invalid();
  const ok = value.stopReason === 'final' || value.stopReason === 'tool_terminal';
  if (
    value.ok !== ok ||
    (value.terminalKind === 'json_result' && value.stopReason !== 'tool_terminal') ||
    (value.stopReason === 'tool_terminal' && value.terminalKind !== 'json_result') ||
    (!ok && value.committed) || (value.committed && !ok)
  ) return invalid();
  return Object.freeze({
    ok: value.ok,
    stopReason: value.stopReason as ExecutionStopReason,
    committed: value.committed,
    terminalKind: value.terminalKind,
  });
};

const cloneCounts = (value: unknown, max = MAX_EXECUTION_TOOL_CALLS): AgentExecutionRoleCounts => {
  if (
    !plain(value) || !ownDataKeys(value, ['parent', 'planner', 'aggregate']) ||
    !safeInt(value.parent, 0, max) || !safeInt(value.planner, 0, max) ||
    !safeInt(value.aggregate, 0, max * 2) || value.aggregate !== value.parent + value.planner
  ) return invalid();
  return Object.freeze({
    parent: value.parent,
    planner: value.planner,
    aggregate: value.aggregate,
  });
};

const cloneUsage = (
  value: unknown,
  envelope: AgentReplayEnvelopeV1,
  modelCalls: readonly AgentExecutionModelCall[],
  toolCalls: readonly AgentExecutionToolCall[],
  toolResults: readonly AgentExecutionToolResult[],
): AgentExecutionUsage => {
  if (
    !plain(value) ||
    !ownDataKeys(value, [
      'steps',
      'modelRequests',
      'externalRequests',
      'toolCalls',
      'toolResults',
      'providerTokenUsage',
      'cost',
    ])
  ) return invalid();
  const modelRequests = cloneCounts(value.modelRequests, MAX_EXECUTION_MODEL_CALLS);
  const calls = cloneCounts(value.toolCalls);
  const results = cloneCounts(value.toolResults);
  if (
    !safeInt(value.steps, 0, envelope.budget.maxSteps) || value.steps !== modelRequests.parent ||
    modelRequests.parent > envelope.budget.modelRequests.parent ||
    modelRequests.planner > envelope.budget.modelRequests.planner ||
    modelRequests.aggregate > envelope.budget.modelRequests.aggregate ||
    !safeInt(value.externalRequests, 0, envelope.budget.maxExternalRequests) ||
    value.externalRequests > modelRequests.aggregate ||
    value.providerTokenUsage !== 'unsupported' || value.cost !== 'unsupported' ||
    !equalJson(modelRequests, roleCounts(modelCalls)) || !equalJson(calls, roleCounts(toolCalls)) ||
    !equalJson(results, roleCounts(toolResults)) ||
    calls.aggregate < results.aggregate
  ) return invalid();
  return Object.freeze({
    steps: value.steps,
    modelRequests,
    externalRequests: value.externalRequests,
    toolCalls: calls,
    toolResults: results,
    providerTokenUsage: 'unsupported' as const,
    cost: 'unsupported' as const,
  });
};

const cloneTranscript = (value: unknown): readonly Message[] =>
  cloneReplayTranscript(value, {
    min: 1,
    max: MAX_EXECUTION_TRANSCRIPT_MESSAGES,
    maxBytes: MAX_EXECUTION_TRANSCRIPT_BYTES,
  });

const validateTranscriptCorrelation = (
  transcript: readonly Message[],
  envelope: AgentReplayEnvelopeV1,
  outcome: AgentExecutionOutcome,
  modelCalls: readonly AgentExecutionModelCall[],
  toolCalls: readonly AgentExecutionToolCall[],
  toolResults: readonly AgentExecutionToolResult[],
): void => {
  const prefix = envelope.initialTranscript;
  if (
    transcript.length <= prefix.length || !equalJson(transcript.slice(0, prefix.length), prefix)
  ) return invalid();
  const userIndex = prefix.length;
  const task = transcript[userIndex];
  if (
    task?.role !== 'user' || task.content.kind !== 'text' || task.content.text !== envelope.task
  ) return invalid();
  const suffix = transcript.slice(userIndex);
  const assistants = suffix.filter((message) => message.role === 'assistant');
  const parentModels = modelCalls.filter((call) => call.role === 'parent');
  const visibleParentModels = parentModels.filter((call) =>
    call.resultKind === 'final' || call.resultKind === 'tool_calls'
  );
  if (assistants.length !== visibleParentModels.length) return invalid();

  // Results may be globally interleaved between parent and planner observations, but each
  // role's dispatch/result stream must remain an exact prefix of its call stream.
  for (const role of ['parent', 'planner'] as const) {
    const calls = toolCalls.filter((call) => call.role === role);
    let resultIndex = 0;
    for (const result of toolResults.filter((item) => item.role === role)) {
      const call = calls[resultIndex++];
      if (call === undefined || call.ordinal !== result.callOrdinal) return invalid();
    }
  }

  const observedResultOrdinals = new Set<number>();
  let observedCallIndex = 0;
  let assistantIndex = 0;
  for (let messageIndex = 1; messageIndex < suffix.length; messageIndex += 1) {
    const message = suffix[messageIndex];
    if (message.role === 'user') {
      if (suffix[messageIndex - 1]?.role !== 'tool') return invalid();
      continue;
    }
    if (message.role === 'tool') return invalid();
    const assistant = message;
    while (
      parentModels[observedCallIndex]?.resultKind === 'error' ||
      parentModels[observedCallIndex]?.resultKind === 'cancelled'
    ) observedCallIndex += 1;
    const call = parentModels[observedCallIndex++];
    if (call === undefined) return invalid();
    if (!Array.isArray(assistant.content)) {
      if (call.resultKind !== 'final') return invalid();
      assistantIndex += 1;
      continue;
    }
    if (call.resultKind !== 'tool_calls') return invalid();
    const declarations = assistant.content;
    const declarationIds = new Set<string>();
    for (const declaration of declarations) {
      if (declarationIds.has(declaration.callId)) return invalid();
      declarationIds.add(declaration.callId);
    }
    const observedCalls = toolCalls.filter((item) =>
      item.role === 'parent' && item.modelCallOrdinal === call.ordinal
    );
    if (observedCalls.length > declarations.length) return invalid();
    for (let index = 0; index < observedCalls.length; index += 1) {
      const declaration = declarations[index];
      const observed = observedCalls[index];
      if (
        declaration === undefined || observed.callId !== declaration.callId ||
        observed.name !== declaration.name || !equalJson(observed.arguments, declaration.arguments)
      ) return invalid();
    }
    const next = suffix[messageIndex + 1];
    if (next?.role === 'tool') {
      if (
        observedCalls.length !== declarations.length || next.content.length !== declarations.length
      ) {
        return invalid();
      }
      for (let index = 0; index < next.content.length; index += 1) {
        const declaration = declarations[index];
        const observedCall = observedCalls[index];
        const result = next.content[index];
        if (
          declaration === undefined || observedCall === undefined || result === undefined ||
          declaration.callId !== result.callId || declaration.name !== result.name
        ) return invalid();
        const observedResult = toolResults.find((item) =>
          item.callOrdinal === observedCall.ordinal
        );
        if (
          observedResult === undefined || observedResult.role !== 'parent' ||
          observedResult.callId !== result.callId || observedResult.name !== result.name ||
          observedResult.outcome !== result.outcome ||
          (observedResult.terminal === 'json_result') !== ('terminal' in result)
        ) return invalid();
        if (observedResultOrdinals.has(observedResult.ordinal)) return invalid();
        observedResultOrdinals.add(observedResult.ordinal);
      }
      messageIndex += 1;
    } else if (
      outcome.stopReason !== 'cancelled' && outcome.stopReason !== 'contract_failure'
    ) {
      return invalid();
    } else if (messageIndex !== suffix.length - 1) {
      return invalid();
    }
    assistantIndex += 1;
  }
  if (assistantIndex !== assistants.length) return invalid();
  for (let index = 0; index < toolCalls.length; index += 1) {
    if (toolCalls[index].ordinal !== index + 1) return invalid();
  }
  if (
    (outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal' ||
      outcome.stopReason === 'max_steps') && toolResults.length !== toolCalls.length
  ) return invalid();
  const terminals = toolResults.filter((result) => result.terminal === 'json_result');
  if (terminals.length > 1) return invalid();
  const terminal = terminals[0];
  if (terminal !== undefined) {
    const terminalCall = toolCalls.find((call) => call.ordinal === terminal.callOrdinal);
    if (
      terminal.role !== 'parent' || terminalCall === undefined ||
      toolCalls.filter((call) => call.modelCallOrdinal === terminalCall.modelCallOrdinal).length !==
        1
    ) return invalid();
  }
  if (terminal !== undefined && outcome.stopReason === 'tool_terminal') {
    if (outcome.terminalKind !== 'json_result') return invalid();
  } else if (outcome.terminalKind !== 'none') {
    return invalid();
  }
  if (
    outcome.stopReason === 'final' && assistants.at(-1)?.role === 'assistant' &&
    Array.isArray(assistants.at(-1)?.content)
  ) return invalid();
  if (outcome.stopReason === 'tool_terminal' && terminal === undefined) return invalid();
  if (
    (outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal') &&
    parseReplayCausalTranscript(transcript) === undefined
  ) {
    return invalid();
  }
  const lastParent = parentModels.at(-1);
  if (
    lastParent === undefined &&
    (outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal' ||
      outcome.stopReason === 'max_steps')
  ) return invalid();
  if (lastParent === undefined) return;
  if (
    outcome.stopReason === 'max_steps' &&
    parentModels.length !== envelope.budget.maxSteps
  ) return invalid();
  if (outcome.stopReason === 'final' && lastParent.resultKind !== 'final') return invalid();
  if (
    (outcome.stopReason === 'tool_terminal' || outcome.stopReason === 'max_steps') &&
    lastParent.resultKind !== 'tool_calls'
  ) return invalid();
};

/** Validate one record against an explicit, already validated replay envelope. */
export const validateAgentExecutionRecord = (
  value: unknown,
  envelope: AgentReplayEnvelopeV1,
): AgentExecutionRecordV1 => {
  try {
    const identities = envelopeIdentities(envelope);
    if (
      !plain(value) ||
      !ownDataKeys(value, [
        'schemaVersion',
        'runOrdinal',
        'envelopeIdentity',
        'manifestIdentity',
        'durationMicros',
        'outcome',
        'usage',
        'modelCalls',
        'toolCalls',
        'toolResults',
        'transcript',
      ]) ||
      value.schemaVersion !== 1 || !safeInt(value.runOrdinal, 1, 1_000_000) ||
      value.envelopeIdentity !== identities.envelope ||
      value.manifestIdentity !== identities.manifest ||
      !safeInt(value.durationMicros, 0, identities.maxWall)
    ) return invalid();
    const outcome = cloneOutcome(value.outcome);
    const modelCalls = cloneModelCalls(value.modelCalls);
    const toolCalls = cloneToolCalls(value.toolCalls, modelCalls);
    const toolResults = cloneToolResults(value.toolResults, toolCalls);
    const usage = cloneUsage(value.usage, envelope, modelCalls, toolCalls, toolResults);
    const transcript = cloneTranscript(value.transcript);
    validateTranscriptCorrelation(
      transcript,
      envelope,
      outcome,
      modelCalls,
      toolCalls,
      toolResults,
    );
    const record = Object.freeze({
      schemaVersion: 1 as const,
      runOrdinal: value.runOrdinal,
      envelopeIdentity: identities.envelope,
      manifestIdentity: identities.manifest,
      durationMicros: value.durationMicros,
      outcome,
      usage,
      modelCalls,
      toolCalls,
      toolResults,
      transcript,
    });
    if (encoder.encode(JSON.stringify(record)).byteLength > MAX_EXECUTION_RECORD_BYTES) {
      return invalid();
    }
    return record;
  } catch (error) {
    if (error instanceof AgentExecutionRecordError) throw error;
    return invalid();
  }
};

export const agentExecutionRecordRepresentation = (
  record: AgentExecutionRecordV1,
  envelope: AgentReplayEnvelopeV1,
): Uint8Array => {
  const validated = validateAgentExecutionRecord(record, envelope);
  const bytes = encoder.encode(JSON.stringify(validated));
  if (bytes.byteLength > MAX_EXECUTION_RECORD_BYTES) return invalid();
  return bytes;
};
export const executionRecordRepresentation = agentExecutionRecordRepresentation;

export interface AgentExecutionModelCallInput {
  readonly role: ExecutionRole;
  readonly resultKind: ExecutionResultKind;
}
export interface AgentExecutionToolCallInput {
  readonly role: ExecutionRole;
  readonly modelCallOrdinal?: number;
  readonly callId: string;
  readonly name: string;
  readonly arguments: import('./contracts.ts').JsonValue;
}
export interface AgentExecutionToolResultInput {
  readonly role: ExecutionRole;
  readonly callOrdinal?: number;
  readonly callId: string;
  readonly name: string;
  readonly outcome: 'success' | 'error';
  readonly terminal?: 'none' | 'json_result';
  readonly result: import('./contracts.ts').JsonValue;
}
export interface AgentExecutionRecorderFinish {
  readonly outcome: AgentExecutionOutcome;
  readonly externalRequests: number;
  readonly transcript: readonly Message[];
}
export interface AgentExecutionRecorderOptions {
  readonly envelope: AgentReplayEnvelopeV1;
  readonly runOrdinal: number;
  readonly clock: () => number;
}

/** Pure finite-state observation recorder. Any malformed event poisons the instance. */
export class AgentExecutionRecorder {
  private state: 'recording' | 'finished' | 'failed' = 'recording';
  private readonly started!: number;
  private readonly modelCalls: AgentExecutionModelCall[] = [];
  private readonly toolCalls: AgentExecutionToolCall[] = [];
  private readonly toolResults: AgentExecutionToolResult[] = [];
  constructor(private readonly options: AgentExecutionRecorderOptions) {
    try {
      envelopeIdentities(options.envelope);
      if (!safeInt(options.runOrdinal, 1, 1_000_000) || typeof options.clock !== 'function') {
        return invalid();
      }
      const start = options.clock();
      if (!safeInt(start, 0, Number.MAX_SAFE_INTEGER)) return invalid();
      this.started = start;
    } catch {
      this.state = 'failed';
      throw new AgentExecutionRecordError();
    }
  }
  private ensureRecording(): void {
    if (this.state !== 'recording') invalid();
  }
  recordModelCall(input: AgentExecutionModelCallInput): void {
    try {
      this.ensureRecording();
      if (
        !plain(input) || !ownDataKeys(input as Record<string, unknown>, ['role', 'resultKind']) ||
        (input.role !== 'parent' && input.role !== 'planner') ||
        !RESULT_KINDS.includes(input.resultKind)
      ) return invalid();
      if (this.modelCalls.length >= MAX_EXECUTION_MODEL_CALLS) return invalid();
      const roleOrdinal = this.modelCalls.filter((item) => item.role === input.role).length + 1;
      this.modelCalls.push({
        ordinal: this.modelCalls.length + 1,
        role: input.role,
        roleOrdinal,
        resultKind: input.resultKind,
      });
    } catch {
      this.state = 'failed';
      throw new AgentExecutionRecordError();
    }
  }
  recordToolCall(input: AgentExecutionToolCallInput): void {
    try {
      this.ensureRecording();
      if (
        !plain(input) ||
        !ownDataKeys(
          input as Record<string, unknown>,
          Object.hasOwn(input, 'modelCallOrdinal')
            ? ['role', 'modelCallOrdinal', 'callId', 'name', 'arguments']
            : ['role', 'callId', 'name', 'arguments'],
        ) || (input.role !== 'parent' && input.role !== 'planner')
      ) return invalid();
      let modelCallOrdinal = input.modelCallOrdinal;
      if (modelCallOrdinal === undefined) {
        for (let index = this.modelCalls.length - 1; index >= 0; index -= 1) {
          const candidate = this.modelCalls[index];
          if (candidate.role === input.role && candidate.resultKind === 'tool_calls') {
            modelCallOrdinal = candidate.ordinal;
            break;
          }
        }
      }
      if (
        this.toolCalls.length >= MAX_EXECUTION_TOOL_CALLS ||
        !safeInt(modelCallOrdinal, 1, this.modelCalls.length)
      ) return invalid();
      const model = this.modelCalls[modelCallOrdinal - 1];
      if (model.role !== input.role || model.resultKind !== 'tool_calls') return invalid();
      const call: AgentExecutionToolCall = {
        ordinal: this.toolCalls.length + 1,
        role: input.role,
        roleOrdinal: this.toolCalls.filter((item) => item.role === input.role).length + 1,
        modelCallOrdinal,
        callId: input.callId,
        name: input.name,
        arguments: cloneReplayJsonValue(input.arguments),
      };
      if (
        !textId(call.callId) || !TOOL_NAME.test(call.name) ||
        this.toolCalls.some((item) => item.role === call.role && item.callId === call.callId)
      ) return invalid();
      this.toolCalls.push(call);
    } catch {
      this.state = 'failed';
      throw new AgentExecutionRecordError();
    }
  }
  recordToolResult(input: AgentExecutionToolResultInput): void {
    try {
      this.ensureRecording();
      if (!plain(input)) return invalid();
      const hasCallOrdinal = Object.hasOwn(input, 'callOrdinal');
      const hasTerminal = Object.hasOwn(input, 'terminal');
      const expected = hasCallOrdinal
        ? (hasTerminal
          ? ['role', 'callOrdinal', 'callId', 'name', 'outcome', 'terminal', 'result']
          : ['role', 'callOrdinal', 'callId', 'name', 'outcome', 'result'])
        : (hasTerminal
          ? ['role', 'callId', 'name', 'outcome', 'terminal', 'result']
          : ['role', 'callId', 'name', 'outcome', 'result']);
      if (
        !ownDataKeys(input as Record<string, unknown>, expected) ||
        (input.role !== 'parent' && input.role !== 'planner') ||
        this.toolResults.length >= MAX_EXECUTION_TOOL_RESULTS ||
        (hasCallOrdinal && !safeInt(input.callOrdinal, 1, MAX_EXECUTION_TOOL_CALLS)) ||
        !textId(input.callId) || typeof input.name !== 'string' || !TOOL_NAME.test(input.name) ||
        (input.outcome !== 'success' && input.outcome !== 'error') ||
        (hasTerminal && input.terminal !== 'none' && input.terminal !== 'json_result')
      ) return invalid();
      const call = hasCallOrdinal
        ? this.toolCalls.find((candidate) => candidate.ordinal === input.callOrdinal)
        : this.toolCalls.find((candidate) =>
          candidate.role === input.role &&
          !this.toolResults.some((result) => result.callOrdinal === candidate.ordinal)
        );
      if (
        call === undefined || call.role !== input.role || call.callId !== input.callId ||
        call.name !== input.name ||
        this.toolResults.some((result) => result.callOrdinal === call.ordinal)
      ) return invalid();
      const terminal = input.terminal ?? 'none';
      if (
        terminal === 'json_result' &&
        (input.outcome !== 'success' || input.name !== 'submit_json_result')
      ) return invalid();
      const result = cloneReplayJsonValue(input.result);
      this.toolResults.push({
        ordinal: this.toolResults.length + 1,
        role: input.role,
        roleOrdinal: this.toolResults.filter((item) => item.role === input.role).length + 1,
        callOrdinal: call.ordinal,
        callId: input.callId,
        name: input.name,
        outcome: input.outcome,
        terminal,
        result,
      });
    } catch {
      this.state = 'failed';
      throw new AgentExecutionRecordError();
    }
  }
  finish(input: AgentExecutionRecorderFinish): AgentExecutionRecordV1 {
    try {
      this.ensureRecording();
      const end = this.options.clock();
      if (
        !safeInt(end, 0, Number.MAX_SAFE_INTEGER) || end < this.started ||
        end - this.started > this.options.envelope.budget.maxWallTimeMicros || !plain(input) ||
        !ownDataKeys(input as Record<string, unknown>, [
          'outcome',
          'externalRequests',
          'transcript',
        ]) || !safeInt(input.externalRequests, 0, this.options.envelope.budget.maxExternalRequests)
      ) return invalid();
      const record = validateAgentExecutionRecord({
        schemaVersion: 1,
        runOrdinal: this.options.runOrdinal,
        envelopeIdentity: this.options.envelope.identity,
        manifestIdentity: this.options.envelope.manifest.identity,
        durationMicros: end - this.started,
        outcome: input.outcome,
        usage: {
          steps: this.modelCalls.filter((call) => call.role === 'parent').length,
          modelRequests: roleCounts(this.modelCalls),
          externalRequests: input.externalRequests,
          toolCalls: roleCounts(this.toolCalls),
          toolResults: roleCounts(this.toolResults),
          providerTokenUsage: 'unsupported',
          cost: 'unsupported',
        },
        modelCalls: this.modelCalls,
        toolCalls: this.toolCalls,
        toolResults: this.toolResults,
        transcript: input.transcript,
      }, this.options.envelope);
      this.state = 'finished';
      return record;
    } catch {
      this.state = 'failed';
      throw new AgentExecutionRecordError();
    }
  }
}

export const createAgentExecutionRecorder = (
  options: AgentExecutionRecorderOptions,
): AgentExecutionRecorder => new AgentExecutionRecorder(options);
export const createExecutionRecorder = createAgentExecutionRecorder;
