import { cloneReplayJsonValue } from '../session/replay_value.ts';
import {
  type AgentExecutionModelCall,
  type AgentExecutionModelCallInput,
  type AgentExecutionRecorderFinish,
  type AgentExecutionRecorderOptions,
  AgentExecutionRecordError,
  type AgentExecutionRecordV1,
  type AgentExecutionToolCall,
  type AgentExecutionToolCallInput,
  type AgentExecutionToolResult,
  type AgentExecutionToolResultInput,
  MAX_EXECUTION_MODEL_CALLS,
  MAX_EXECUTION_TOOL_CALLS,
  MAX_EXECUTION_TOOL_RESULTS,
  RESULT_KINDS,
  TOOL_NAME,
} from './execution_record_contract.ts';
import {
  envelopeIdentities,
  invalid,
  ownDataKeys,
  plain,
  roleCounts,
  safeInt,
} from './execution_record_value.ts';
import { textId, validateAgentExecutionRecord } from './execution_record_validation.ts';

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
