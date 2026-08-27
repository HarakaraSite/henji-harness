import { type JsonObject, type JsonValue, type LoopOutcome } from './contracts.ts';
import {
  type ChildTurnExecutionContext,
  type ModelExecutionContext,
  type ParentTurnExecutionContext,
  type TurnRequestBudgetSnapshot,
} from './execution_context.ts';
import { type Tool, ToolInputError } from './tools.ts';

const encoder = new TextEncoder();
export const MAX_PLANNER_TASK_BYTES = 65_536;
export const MAX_PLANNER_RESULT_BYTES = 65_536;

export const DELEGATE_TO_PLANNER_DESCRIPTION =
  'Delegate one explicit planning task to the built-in planner for this parent turn. The planner receives only task, can read the same workspace and saved skills, cannot mutate it, and returns one bounded synchronous result. Call at most once per turn.';

export const DELEGATE_TO_PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      minLength: 1,
      maxLength: 65_536,
    },
  },
  required: ['task'],
  additionalProperties: false,
} as const;

export interface PlannerDelegationUsage {
  readonly modelRequests: number;
  readonly externalRequests: number;
}

export interface PlannerDelegationExecution {
  readonly outcome: LoopOutcome;
  /** Number of counted external fetch starts during this child execution. */
  readonly externalRequests: number;
}

export type PlannerDelegationHandler = (
  task: string,
  childContext: ChildTurnExecutionContext,
) => PlannerDelegationExecution | PromiseLike<PlannerDelegationExecution>;

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const validTask = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') &&
  hasWellFormedUnicode(value) && encoder.encode(value).byteLength <= MAX_PLANNER_TASK_BYTES;

const safeCounter = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const usageDelta = (
  before: TurnRequestBudgetSnapshot,
  after: TurnRequestBudgetSnapshot,
  externalRequests: unknown,
): PlannerDelegationUsage => ({
  modelRequests: safeCounter(after.child - before.child),
  externalRequests: safeCounter(externalRequests),
});

type FailureCode =
  | 'delegation_limit'
  | 'planner_failed'
  | 'planner_output_invalid'
  | 'planner_output_limit';

const failureMessage = (code: FailureCode): string => {
  switch (code) {
    case 'delegation_limit':
      return 'planner delegation is limited to one execution per turn';
    case 'planner_failed':
      return 'planner delegation failed';
    case 'planner_output_invalid':
      return 'planner returned an invalid result';
    case 'planner_output_limit':
      return 'planner result exceeds 64 KiB';
  }
};

const failureEnvelope = (code: FailureCode, usage: PlannerDelegationUsage): string =>
  JSON.stringify({
    ok: false,
    agent: 'planner',
    error: { code, message: failureMessage(code) },
    usage,
  });

const successEnvelope = (
  outcome: LoopOutcome,
  usage: PlannerDelegationUsage,
): string | undefined => {
  if (!outcome.ok || typeof outcome.finalText !== 'string') return undefined;
  if (outcome.finalText.includes('\0') || !hasWellFormedUnicode(outcome.finalText)) {
    return undefined;
  }
  if (outcome.stopReason === 'final') {
    if (outcome.terminalKind !== undefined) return undefined;
    return JSON.stringify({
      ok: true,
      agent: 'planner',
      output: { kind: 'text', text: outcome.finalText },
      usage,
    });
  }
  if (outcome.stopReason === 'tool_terminal' && outcome.terminalKind === 'json_result') {
    return JSON.stringify({
      ok: true,
      agent: 'planner',
      output: { kind: 'json', json: outcome.finalText },
      usage,
    });
  }
  return undefined;
};

const withinResultLimit = (value: string): boolean =>
  encoder.encode(value).byteLength <= MAX_PLANNER_RESULT_BYTES;

const isParentContext = (
  context: ModelExecutionContext | undefined,
): context is ParentTurnExecutionContext =>
  context !== undefined &&
  typeof (context as Partial<ParentTurnExecutionContext>).admitPlannerExecution === 'function';

const emptyUsage: PlannerDelegationUsage = { modelRequests: 0, externalRequests: 0 };

/** Create the sole normal-runtime nonterminal planner delegation tool. */
export const createPlannerDelegationTool = (
  handler: PlannerDelegationHandler,
): Tool => ({
  name: 'delegate_to_planner',
  description: DELEGATE_TO_PLANNER_DESCRIPTION,
  inputSchema: DELEGATE_TO_PLANNER_SCHEMA,
  async execute(argumentsValue: JsonValue, context?: ModelExecutionContext): Promise<string> {
    if (!isObject(argumentsValue) || Object.keys(argumentsValue).length !== 1) {
      throw new ToolInputError('expected an object with only a task string');
    }
    const task = argumentsValue.task;
    if (!validTask(task)) {
      throw new ToolInputError('expected one nonblank well-formed task string up to 64 KiB');
    }

    // A valid call without the parent context is an internal wiring failure, not user input.
    if (!isParentContext(context)) return failureEnvelope('planner_failed', emptyUsage);
    const childContext = context.admitPlannerExecution();
    if (childContext === undefined) return failureEnvelope('delegation_limit', emptyUsage);
    const before = context.snapshot();
    let execution: PlannerDelegationExecution;
    try {
      execution = await handler(task, childContext);
    } catch {
      const usage = usageDelta(before, context.snapshot(), 0);
      return failureEnvelope('planner_failed', usage);
    }
    const usage = usageDelta(before, context.snapshot(), execution?.externalRequests);
    if (
      typeof execution !== 'object' || execution === null ||
      typeof execution.outcome !== 'object' || execution.outcome === null
    ) return failureEnvelope('planner_failed', usage);

    const output = successEnvelope(execution.outcome, usage);
    if (output === undefined) {
      const code = execution.outcome.ok ? 'planner_output_invalid' : 'planner_failed';
      return failureEnvelope(code, usage);
    }
    if (!withinResultLimit(output)) return failureEnvelope('planner_output_limit', usage);
    return output;
  },
});
