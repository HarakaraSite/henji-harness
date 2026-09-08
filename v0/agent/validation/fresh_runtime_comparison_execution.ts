import {
  type AgentComparisonExecutionObserver,
  runAgentTurnObservedForComparison,
} from '../core/loop.ts';
import type {
  Message,
  Model,
  ModelRequest,
  ModelResult,
  ToolCall,
  ToolResultContent,
} from '../core/contracts.ts';
import { Registry, type Tool } from '../tools/tools.ts';
import { type AgentExecutionRecordV1, createAgentExecutionRecorder } from './execution_record.ts';
import {
  AgentFreshRuntimeComparisonError,
  FRESH_RUNTIME_TASK,
  type FreshRuntimeComparisonExecutionPosition,
  type FreshRuntimeComparisonTestHooks,
  type FreshRuntimeRunSpec,
} from './fresh_runtime_comparison_contract.ts';
import { clonePlain, equalJson, failureFor, plain } from './fresh_runtime_comparison_value.ts';

export const SCRIPT_CALLS: readonly ToolCall[] = Object.freeze([
  Object.freeze({ callId: 'call-1', name: 'uppercase_text', arguments: { text: 'one' } }),
  Object.freeze({ callId: 'call-2', name: 'uppercase_text', arguments: { text: 'two' } }),
  Object.freeze({ callId: 'call-3', name: 'uppercase_text', arguments: { text: 'three' } }),
  Object.freeze({ callId: 'call-4', name: 'uppercase_text', arguments: { text: 'four' } }),
]);

class FreshRuntimeScriptError extends Error {}

class FreshRuntimeScriptedModel implements Model {
  private next = 0;
  constructor(
    private readonly expected: readonly ToolCall[] = SCRIPT_CALLS,
    private readonly beforeGenerate?: () => void,
  ) {}
  generate(request: ModelRequest): Promise<ModelResult> {
    this.beforeGenerate?.();
    const ordinal = this.next++;
    if (
      !Array.isArray(request.transcript) || request.tools.length !== 1 ||
      request.tools[0]?.name !== 'uppercase_text'
    ) {
      throw new FreshRuntimeScriptError();
    }
    const expectedTranscriptLength = ordinal * 2 + 1;
    if (request.transcript.length !== expectedTranscriptLength) throw new FreshRuntimeScriptError();
    const task = request.transcript[0];
    if (
      task?.role !== 'user' || task.content.kind !== 'text' ||
      task.content.text !== FRESH_RUNTIME_TASK
    ) throw new FreshRuntimeScriptError();
    for (let index = 0; index < ordinal; index += 1) {
      const expectedCall = this.expected[index];
      const assistant = request.transcript[index * 2 + 1];
      const tool = request.transcript[index * 2 + 2];
      const expectedArguments = expectedCall?.arguments;
      if (
        expectedCall === undefined || assistant?.role !== 'assistant' ||
        !Array.isArray(assistant.content) || assistant.content.length !== 1 ||
        !equalJson(assistant.content[0], { kind: 'tool_call', ...expectedCall }) ||
        tool?.role !== 'tool' || tool.content.length !== 1 ||
        !plain(expectedArguments) || typeof expectedArguments.text !== 'string' ||
        !equalJson(tool.content[0], {
          kind: 'tool_result',
          callId: expectedCall.callId,
          name: expectedCall.name,
          text: expectedArguments.text.toUpperCase(),
          outcome: 'success',
        })
      ) throw new FreshRuntimeScriptError();
    }
    if (ordinal < this.expected.length) {
      const call = this.expected[ordinal];
      return Promise.resolve({ kind: 'tool_calls', calls: [clonePlain(call)] });
    }
    if (ordinal === this.expected.length) {
      return Promise.resolve({ kind: 'final', text: 'comparison complete' });
    }
    throw new FreshRuntimeScriptError();
  }
}

interface FreshRuntimeComparisonTool extends Tool {
  readonly verifyComplete: () => void;
}

const freshTool = (beforeExecute?: () => void): FreshRuntimeComparisonTool => {
  let next = 0;
  return {
    name: 'uppercase_text',
    description: 'Convert one input text to uppercase.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: (argumentsValue) => {
      beforeExecute?.();
      const expected = SCRIPT_CALLS[next];
      if (
        expected === undefined || !plain(expected.arguments) ||
        typeof expected.arguments.text !== 'string' ||
        !equalJson(argumentsValue, expected.arguments)
      ) throw new AgentFreshRuntimeComparisonError();
      next += 1;
      return expected.arguments.text.toUpperCase();
    },
    verifyComplete: () => {
      if (next !== SCRIPT_CALLS.length) throw new AgentFreshRuntimeComparisonError();
    },
  };
};

/** Test-only bounded fixture seam; production runtime never materializes this tool. */
export const createFreshRuntimeComparisonToolForTest = (): FreshRuntimeComparisonTool =>
  freshTool();

export interface RunExecution {
  readonly record: AgentExecutionRecordV1;
  readonly committed: boolean;
}

export const executeRun = async (
  spec: FreshRuntimeRunSpec,
  position: FreshRuntimeComparisonExecutionPosition,
  hooks?: FreshRuntimeComparisonTestHooks,
): Promise<RunExecution> => {
  hooks?.onConstruct?.('model', spec.side, position);
  const model = new FreshRuntimeScriptedModel(
    SCRIPT_CALLS,
    () => failureFor(hooks, 'model', position),
  );
  hooks?.onConstruct?.('tool', spec.side, position);
  const tool = freshTool(() => failureFor(hooks, 'tool', position));
  hooks?.onConstruct?.('registry', spec.side, position);
  const registry = new Registry([tool]);
  hooks?.onConstruct?.('clock', spec.side, position);
  let clockReads = 0;
  hooks?.onConstruct?.('abort', spec.side, position);
  const abortController = new AbortController();
  hooks?.onConstruct?.('counters', spec.side, position);
  hooks?.onConstruct?.('transcript', spec.side, position);
  const recorder = createAgentExecutionRecorder({
    envelope: spec.envelope,
    runOrdinal: spec.runOrdinal,
    clock: () => {
      const read = clockReads++;
      if (read > 0) failureFor(hooks, 'clock', position);
      return read === 0 ? 1000 : 2250;
    },
  });
  hooks?.onConstruct?.('recorder', spec.side, position);
  let commitCount = 0;
  let committedTranscript: readonly Message[] | undefined;
  hooks?.onConstruct?.('commit', spec.side, position);
  let modelSettlementCount = 0;
  const observer: AgentComparisonExecutionObserver = {
    modelSettled: (kind) => {
      failureFor(hooks, 'observer', position);
      failureFor(hooks, 'recorder', position);
      recorder.recordModelCall({ role: 'parent', resultKind: kind });
      modelSettlementCount += 1;
      hooks?.onProgress?.(
        'model-settled-recorded',
        spec.side,
        position,
        modelSettlementCount,
      );
      // The partial-second seam fires only after the second run has recorded its first
      // actual model settlement, leaving observable recorder/runtime progress to discard.
      if (modelSettlementCount === 1) failureFor(hooks, 'partial-second-run', position);
    },
    toolCallAccepted: (call) =>
      (() => {
        failureFor(hooks, 'observer', position);
        failureFor(hooks, 'recorder', position);
        recorder.recordToolCall({
          role: 'parent',
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        });
      })(),
    toolResultAccepted: (result: ToolResultContent) => {
      failureFor(hooks, 'observer', position);
      failureFor(hooks, 'recorder', position);
      recorder.recordToolResult({
        role: 'parent',
        callId: result.callId,
        name: result.name,
        outcome: result.outcome,
        ...(Object.hasOwn(result, 'terminal') ? { terminal: 'json_result' as const } : {}),
        result: { text: result.text },
      });
    },
  };
  const outcome = await runAgentTurnObservedForComparison(
    spec.envelope.task,
    spec.envelope.initialTranscript,
    model,
    registry,
    observer,
    {
      maxSteps: spec.manifest.parameters.maxSteps,
      systemInstruction: spec.definition.systemInstruction,
      signal: abortController.signal,
      commit: (transcript) => {
        commitCount += 1;
        committedTranscript = transcript;
      },
    },
  );
  const expectedStop = spec.side === 'current' ? 'final' : 'max_steps';
  const expectedOk = spec.side === 'current';
  if (
    outcome.ok !== expectedOk || outcome.stopReason !== expectedStop ||
    outcome.steps !== (spec.side === 'current' ? 5 : 4) || outcome.toolCallCount !== 4 ||
    outcome.toolResultCount !== 4 ||
    (spec.side === 'current' ? commitCount !== 1 : commitCount !== 0) ||
    (spec.side === 'current'
      ? committedTranscript === undefined
      : committedTranscript !== undefined)
  ) throw new FreshRuntimeScriptError();
  tool.verifyComplete();
  failureFor(hooks, 'recorder', position);
  const record = recorder.finish({
    outcome: {
      ok: expectedOk,
      stopReason: expectedStop,
      committed: spec.side === 'current',
      terminalKind: 'none',
    },
    externalRequests: 0,
    transcript: outcome.transcript,
  });
  const execution = { record, committed: spec.side === 'current' };
  hooks?.onRunComplete?.(spec.side, position);
  return execution;
};
