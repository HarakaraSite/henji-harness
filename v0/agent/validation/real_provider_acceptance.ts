import { type CredentialSource, OpenRouterAgentModel } from '../provider/openrouter_model.ts';
import { PRODUCTION_PROFILE } from '../provider/provider_profile.ts';
import {
  type JsonValue,
  type LoopOutcome,
  type Message,
  type Model,
  type ModelRequest,
  type ModelResult,
  type ToolCall,
} from '../core/contracts.ts';
import { runAgent } from '../core/loop.ts';
import { createFixtureTool, Registry } from '../tools/tools.ts';

export const FIXED_TASK =
  'Use the uppercase_text tool exactly once to convert the following ASCII text to uppercase. ' +
  'After receiving the tool result, reply with exactly that result and nothing else: ' +
  'henji harness step seven';
export const FIXED_TOOL_NAME = 'uppercase_text';
export const FIXED_TOOL_INPUT_TEXT = 'henji harness step seven';
export const EXPECTED_TOOL_RESULT = 'HENJI HARNESS STEP SEVEN';
export const EXPECTED_FINAL_TEXT = EXPECTED_TOOL_RESULT;
export const MAX_TASK_BYTES = 1024;
export const MAX_STEPS = 2;

type AcceptanceErrorCode = 'acceptance_input' | 'acceptance_contract';

export interface AcceptanceError {
  readonly code: AcceptanceErrorCode;
  readonly message: string;
}

export interface AcceptanceOutput {
  readonly ok: boolean;
  readonly profile: string;
  readonly outcome: LoopOutcome['outcome'];
  readonly stopReason: LoopOutcome['stopReason'];
  readonly steps: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly requestCount: number;
  readonly finalText?: string;
  readonly error?: AcceptanceError;
}

export interface AcceptanceRun {
  readonly exitCode: 0 | 1;
  readonly output: string;
  readonly result: AcceptanceOutput;
}

export interface AcceptanceDependencies {
  /** Offline tests inject a fake fetch and a dummy credential/source. */
  readonly fetcher?: typeof fetch;
  readonly credential?: string;
  readonly credentialSource?: CredentialSource;
  readonly timeoutMs?: number;
}

const encoder = new TextEncoder();

const inputFailure = (
  requestCount: number,
  message = 'invalid acceptance arguments',
): AcceptanceOutput => ({
  ok: false,
  profile: PRODUCTION_PROFILE.id,
  outcome: 'contract_failure',
  stopReason: 'contract_failure',
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  requestCount,
  error: { code: 'acceptance_input', message },
});

const contractFailure = (
  outcome: LoopOutcome['outcome'],
  stopReason: LoopOutcome['stopReason'],
  steps: number,
  toolCallCount: number,
  toolResultCount: number,
  requestCount: number,
): AcceptanceOutput => ({
  ok: false,
  profile: PRODUCTION_PROFILE.id,
  outcome,
  stopReason,
  steps,
  toolCallCount,
  toolResultCount,
  requestCount,
  error: { code: 'acceptance_contract', message: 'fixed acceptance contract failed' },
});

const isExactArguments = (value: JsonValue): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const objectValue = value as { readonly [key: string]: JsonValue };
  return keys.length === 1 && keys[0] === 'text' && objectValue.text === FIXED_TOOL_INPUT_TEXT;
};

const isExactCall = (value: ToolCall): boolean =>
  typeof value.callId === 'string' && value.callId.trim() !== '' &&
  value.name === FIXED_TOOL_NAME && isExactArguments(value.arguments);

const isCompleteTranscript = (transcript: readonly Message[]): boolean => {
  if (transcript.length !== 4) return false;
  const user = transcript[0];
  if (user.role !== 'user' || user.content.kind !== 'text' || user.content.text !== FIXED_TASK) {
    return false;
  }
  const assistantCall = transcript[1];
  if (
    assistantCall.role !== 'assistant' || !Array.isArray(assistantCall.content) ||
    assistantCall.content.length !== 1 || !isExactCall(assistantCall.content[0])
  ) return false;
  const call = assistantCall.content[0];
  const tool = transcript[2];
  if (tool.role !== 'tool' || tool.content.length !== 1) return false;
  const result = tool.content[0];
  if (
    result.kind !== 'tool_result' || result.callId !== call.callId ||
    result.name !== FIXED_TOOL_NAME || result.text !== EXPECTED_TOOL_RESULT ||
    result.outcome !== 'success'
  ) return false;
  const assistantFinal = transcript[3];
  if (assistantFinal.role !== 'assistant') return false;
  const finalContent = assistantFinal.content;
  return typeof finalContent === 'object' && finalContent !== null && 'kind' in finalContent &&
    finalContent.kind === 'text' && finalContent.text === EXPECTED_FINAL_TEXT;
};

export const evaluateAcceptanceOutcome = (
  outcome: LoopOutcome,
  requestCount: number,
): AcceptanceOutput | undefined => {
  if (
    !outcome.ok || outcome.outcome !== 'final' || outcome.stopReason !== 'final' ||
    outcome.steps !== MAX_STEPS || outcome.toolCallCount !== 1 || outcome.toolResultCount !== 1 ||
    requestCount !== 2 || outcome.finalText !== EXPECTED_FINAL_TEXT ||
    !isCompleteTranscript(outcome.transcript)
  ) return undefined;
  return {
    ok: true,
    profile: PRODUCTION_PROFILE.id,
    outcome: 'final',
    stopReason: 'final',
    steps: MAX_STEPS,
    toolCallCount: 1,
    toolResultCount: 1,
    requestCount: 2,
    finalText: EXPECTED_FINAL_TEXT,
  };
};

class AcceptanceContractError extends Error {
  constructor() {
    super('fixed acceptance response did not match the contract');
    this.name = 'AcceptanceContractError';
  }
}

class GuardedModel implements Model {
  private ordinal = 0;

  constructor(private readonly delegate: Model) {}

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.ordinal += 1;
    if (this.ordinal > MAX_STEPS) throw new AcceptanceContractError();
    const result = await this.delegate.generate(request);
    if (this.ordinal === 1) {
      if (
        result.kind !== 'tool_calls' || result.calls.length !== 1 ||
        !isExactCall(result.calls[0])
      ) throw new AcceptanceContractError();
      return result;
    }
    if (result.kind !== 'final' || result.text !== EXPECTED_FINAL_TEXT) {
      throw new AcceptanceContractError();
    }
    return result;
  }
}

interface ParsedArguments {
  readonly task: string;
}

const parseArguments = (args: readonly string[]): ParsedArguments => {
  let task: string | undefined;
  let confirmed = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--confirm-external-call') {
      if (confirmed) throw new AcceptanceContractError();
      confirmed = true;
      continue;
    }
    if (argument === '--task') {
      if (task !== undefined || index + 1 >= args.length || args[index + 1].startsWith('--')) {
        throw new AcceptanceContractError();
      }
      task = args[++index];
      continue;
    }
    throw new AcceptanceContractError();
  }
  if (!confirmed || task === undefined) throw new AcceptanceContractError();
  if (encoder.encode(task).byteLength > MAX_TASK_BYTES || task !== FIXED_TASK) {
    throw new AcceptanceContractError();
  }
  return { task };
};

const output = (result: AcceptanceOutput): AcceptanceRun => ({
  exitCode: result.ok ? 0 : 1,
  output: JSON.stringify(result),
  result,
});

export const runAcceptance = async (
  args: readonly string[],
  dependencies: AcceptanceDependencies = {},
): Promise<AcceptanceRun> => {
  let requestCount = 0;
  try {
    const parsed = parseArguments(args);
    const baseFetcher = dependencies.fetcher ?? fetch;
    const countedFetcher: typeof fetch = (input, init) => {
      requestCount += 1;
      return baseFetcher(input, init);
    };
    const modelOptions = {
      fetcher: countedFetcher,
      ...(dependencies.credential !== undefined ? { credential: dependencies.credential } : {}),
      ...(dependencies.credentialSource ? { credentialSource: dependencies.credentialSource } : {}),
      ...(dependencies.timeoutMs !== undefined ? { timeoutMs: dependencies.timeoutMs } : {}),
    };
    const model = new GuardedModel(new OpenRouterAgentModel(modelOptions));
    const outcome = await runAgent(
      parsed.task,
      model,
      new Registry([createFixtureTool()]),
      { maxSteps: MAX_STEPS },
    );
    return output(
      evaluateAcceptanceOutcome(outcome, requestCount) ??
        contractFailure(
          outcome.outcome,
          outcome.stopReason,
          outcome.steps,
          outcome.toolCallCount,
          outcome.toolResultCount,
          requestCount,
        ),
    );
  } catch {
    return output(inputFailure(requestCount));
  }
};

export const main = async (args: readonly string[] = Deno.args): Promise<number> => {
  const result = await runAcceptance(args);
  console.log(result.output);
  return result.exitCode;
};

if (import.meta.main) Deno.exit(await main());
