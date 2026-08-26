import {
  type JsonObject,
  type JsonValue,
  type LoopOutcome,
  type Model,
  type ModelRequest,
  type ModelResult,
  type TextContent,
  type ToolCall,
  type ToolCallContent,
  type ToolResultContent,
} from './contracts.ts';
import { runAgent } from './loop.ts';
import { createCharacterCountTool, createFixtureTool, Registry, type Tool } from './tools.ts';

export type TaskSelectionCase = 'uppercase' | 'count';
export type SelectionToolName = 'character_count' | 'uppercase_text';

export interface TaskSelectionSpec {
  readonly task: string;
  readonly inputText: string;
  readonly expectedToolName: SelectionToolName;
  readonly excludedToolName: SelectionToolName;
  readonly expectedResultText: string;
  readonly expectedFinalText: string;
}

export const TASK_SELECTION_CASES: Readonly<Record<TaskSelectionCase, TaskSelectionSpec>> = {
  uppercase: {
    task: 'Convert the following text to uppercase: henji harness step eight',
    inputText: 'henji harness step eight',
    expectedToolName: 'uppercase_text',
    excludedToolName: 'character_count',
    expectedResultText: 'HENJI HARNESS STEP EIGHT',
    expectedFinalText: 'HENJI HARNESS STEP EIGHT',
  },
  count: {
    task: 'Count the Unicode code points in the following text: Henji 🐣',
    inputText: 'Henji 🐣',
    expectedToolName: 'character_count',
    excludedToolName: 'uppercase_text',
    expectedResultText: '{"count":7}',
    expectedFinalText: '{"count":7}',
  },
};

export interface ToolExecutionCounts {
  readonly character_count: number;
  readonly uppercase_text: number;
}

export interface TaskSelectionEvaluation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly selectedToolCount: number;
  readonly excludedToolCount: number;
}

export interface TaskSelectionRun {
  readonly caseName: TaskSelectionCase;
  readonly spec: TaskSelectionSpec;
  readonly outcome: LoopOutcome;
  readonly toolExecutionCounts: ToolExecutionCounts;
  readonly evaluation: TaskSelectionEvaluation;
}

const toolNames = (request: ModelRequest): readonly string[] =>
  request.tools.map((tool) => tool.name).sort();

const hasBothTools = (request: ModelRequest): boolean => {
  const names = toolNames(request);
  return names.length === 2 && names[0] === 'character_count' && names[1] === 'uppercase_text';
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

const isToolCall = (value: unknown): value is ToolCall => {
  if (typeof value !== 'object' || value === null) return false;
  const call = value as Record<string, unknown>;
  return typeof call.callId === 'string' && call.callId.trim() !== '' &&
    typeof call.name === 'string' && call.name.trim() !== '' && isJsonValue(call.arguments);
};

const isExactTextArguments = (value: unknown, expectedText: string): value is JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return keys.length === 1 && keys[0] === 'text' && object.text === expectedText;
};

const contractFailure = (message: string): never => {
  throw new Error(`task-selection contract failure: ${message}`);
};

class TaskSelectionGuardedModel implements Model {
  private step = 0;
  private firstCall: ToolCall | undefined;

  constructor(
    private readonly delegate: Model,
    private readonly spec: TaskSelectionSpec,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.step += 1;
    if (this.step > 2) contractFailure('model call exceeded the two-step limit');
    if (!hasBothTools(request)) {
      contractFailure('both task-selection tools were not advertised');
    }

    if (this.step === 1) {
      if (request.transcript.length !== 1 || request.transcript[0].role !== 'user') {
        contractFailure('initial transcript is not a single user message');
      }
      const generated: unknown = await this.delegate.generate(request);
      if (typeof generated !== 'object' || generated === null) {
        contractFailure('initial response is not an object');
      }
      const result = generated as Record<string, unknown>;
      if (result.kind !== 'tool_calls') {
        contractFailure('initial response must contain exactly one tool call');
      }
      const callsValue = result.calls;
      if (!Array.isArray(callsValue)) {
        contractFailure('initial response must contain exactly one tool call');
      }
      const calls = callsValue as readonly unknown[];
      if (calls.length !== 1) {
        contractFailure('initial response must contain exactly one valid tool call');
      }
      const candidate = calls[0];
      if (!isToolCall(candidate)) {
        contractFailure('initial response must contain exactly one valid tool call');
      }
      const call = candidate as ToolCall;
      if (call.name !== this.spec.expectedToolName) {
        contractFailure(`unexpected tool selection: ${call.name}`);
      }
      if (!isExactTextArguments(call.arguments, this.spec.inputText)) {
        contractFailure('tool selection arguments do not match the fixed task');
      }
      this.firstCall = call;
      return generated as ModelResult;
    }

    const firstCall: ToolCall = this.firstCall ??
      contractFailure('second model step had no accepted first call');
    if (request.transcript.length !== 3) {
      contractFailure('second request does not contain one tool round');
    }
    const user = request.transcript[0];
    const assistant = request.transcript[1];
    const tool = request.transcript[2];
    if (user.role !== 'user' || assistant.role !== 'assistant' || tool.role !== 'tool') {
      contractFailure('second request transcript is not causal');
    }
    const assistantContent = assistant.content;
    const toolContent = tool.content;
    if (
      !Array.isArray(assistantContent) ||
      assistantContent.length !== 1 ||
      !Array.isArray(toolContent) ||
      toolContent.length !== 1
    ) {
      contractFailure('second request transcript is not causal');
    }
    const assistantCalls = assistantContent as readonly ToolCallContent[];
    const toolResults = toolContent as readonly ToolResultContent[];
    const assistantCall = assistantCalls[0];
    const toolResult = toolResults[0];
    if (
      assistantCall.kind !== 'tool_call' ||
      assistantCall.callId !== firstCall.callId ||
      assistantCall.name !== this.spec.expectedToolName ||
      !isExactTextArguments(assistantCall.arguments, this.spec.inputText) ||
      toolResult.kind !== 'tool_result' ||
      toolResult.callId !== firstCall.callId ||
      toolResult.name !== this.spec.expectedToolName ||
      toolResult.outcome !== 'success' ||
      toolResult.text !== this.spec.expectedResultText
    ) {
      contractFailure('second request does not contain the expected local result');
    }

    const generated: unknown = await this.delegate.generate(request);
    if (typeof generated !== 'object' || generated === null) {
      contractFailure('final response is not an object');
    }
    const result = generated as Record<string, unknown>;
    if (result.kind !== 'final' || typeof result.text !== 'string') {
      contractFailure('second response must be the exact final response');
    }
    if (result.text !== this.spec.expectedFinalText) {
      contractFailure('final response does not match the fixed task result');
    }
    return generated as ModelResult;
  }
}

type MutableToolExecutionCounts = {
  -readonly [Name in SelectionToolName]: number;
};

const countedTool = (
  tool: Tool,
  name: SelectionToolName,
  counts: MutableToolExecutionCounts,
): Tool => ({
  ...tool,
  execute(argumentsValue: JsonValue) {
    counts[name] += 1;
    return tool.execute(argumentsValue);
  },
});

export const runTwoToolTaskSelection = async (
  caseName: TaskSelectionCase,
  model: Model,
): Promise<TaskSelectionRun> => {
  const spec = TASK_SELECTION_CASES[caseName];
  const counts: MutableToolExecutionCounts = {
    character_count: 0,
    uppercase_text: 0,
  };
  const registry = new Registry([
    countedTool(createFixtureTool(), 'uppercase_text', counts),
    countedTool(createCharacterCountTool(), 'character_count', counts),
  ]);
  const outcome = await runAgent(
    spec.task,
    new TaskSelectionGuardedModel(model, spec),
    registry,
    { maxSteps: 2 },
  );
  const toolExecutionCounts: ToolExecutionCounts = { ...counts };
  return {
    caseName,
    spec,
    outcome,
    toolExecutionCounts,
    evaluation: evaluateTaskSelectionOutcome(outcome, caseName, toolExecutionCounts),
  };
};

export const evaluateTaskSelectionOutcome = (
  outcome: LoopOutcome,
  caseName: TaskSelectionCase,
  toolExecutionCounts: ToolExecutionCounts,
): TaskSelectionEvaluation => {
  const spec = TASK_SELECTION_CASES[caseName];
  const selectedToolCount = toolExecutionCounts[spec.expectedToolName];
  const excludedToolCount = toolExecutionCounts[spec.excludedToolName];
  const fail = (reason: string): TaskSelectionEvaluation => ({
    ok: false,
    reason,
    selectedToolCount,
    excludedToolCount,
  });

  if (
    !outcome.ok ||
    outcome.outcome !== 'final' ||
    outcome.stopReason !== 'final'
  ) {
    return fail('outcome did not finish with a final response');
  }
  if (
    outcome.steps !== 2 ||
    outcome.toolCallCount !== 1 ||
    outcome.toolResultCount !== 1 ||
    outcome.finalText !== spec.expectedFinalText
  ) {
    return fail('outcome counts or final text did not match the fixed tuple');
  }
  if (
    outcome.transcript.length !== 4 ||
    outcome.transcript.map((message) => message.role).join(',') !==
      'user,assistant,tool,assistant'
  ) {
    return fail('outcome transcript did not contain one causal tool round');
  }
  const toolMessage = outcome.transcript[2];
  const finalMessage = outcome.transcript[3];
  if (toolMessage.role !== 'tool' || finalMessage.role !== 'assistant') {
    return fail('outcome transcript contents did not match the fixed tuple');
  }
  const toolContent = toolMessage.content;
  const finalContent = finalMessage.content;
  if (!Array.isArray(toolContent) || toolContent.length !== 1 || Array.isArray(finalContent)) {
    return fail('outcome transcript contents did not match the fixed tuple');
  }
  const finalTextContent = finalContent as TextContent;
  if (finalTextContent.text !== spec.expectedFinalText) {
    return fail('outcome transcript contents did not match the fixed tuple');
  }
  const toolResult = toolContent[0];
  if (
    toolResult.kind !== 'tool_result' ||
    toolResult.name !== spec.expectedToolName ||
    toolResult.outcome !== 'success' ||
    toolResult.text !== spec.expectedResultText
  ) {
    return fail('outcome tool result did not match the fixed tuple');
  }
  if (selectedToolCount !== 1 || excludedToolCount !== 0) {
    return fail('tool execution counts did not match the fixed tuple');
  }
  return { ok: true, selectedToolCount, excludedToolCount };
};
