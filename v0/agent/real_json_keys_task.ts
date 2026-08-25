import { OpenRouterAgentModel } from './openrouter_model.ts';
import {
  type Model,
  type ModelRequest,
  type ModelResult,
  type ToolResultContent,
} from './contracts.ts';
import { runAgent } from './loop.ts';
import { createJsonObjectKeysTool, Registry } from './tools.ts';

const PATH = 'deno.v0.json';
const OBJECT_KEY = 'tasks';
const TOOL_NAME = 'list_json_object_keys';
export const JSON_KEYS_TASK =
  'Use the list_json_object_keys tool exactly once with path "deno.v0.json" and objectKey "tasks". ' +
  'After receiving the tool result, reply with exactly that JSON array and nothing else.';

const sameStringArray = (left: string | undefined, right: string | undefined): boolean => {
  if (left === undefined || right === undefined) return false;
  try {
    const leftValue: unknown = JSON.parse(left);
    const rightValue: unknown = JSON.parse(right);
    return Array.isArray(leftValue) && Array.isArray(rightValue) &&
      leftValue.every((value) => typeof value === 'string') &&
      rightValue.every((value) => typeof value === 'string') &&
      JSON.stringify(leftValue) === JSON.stringify(rightValue);
  } catch {
    return false;
  }
};

const isStringArrayText = (text: string): boolean => {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  } catch {
    return false;
  }
};

export class ExactJsonKeysModel implements Model {
  private step = 0;
  private toolCallId: string | undefined;

  constructor(private readonly delegate: Model) {}

  private previousToolResult(request: ModelRequest): ToolResultContent {
    const previousMessage = request.transcript[request.transcript.length - 1];
    if (previousMessage?.role !== 'tool' || previousMessage.content.length !== 1) {
      throw new Error('expected one preceding tool result');
    }
    const result = previousMessage.content[0];
    if (
      result.kind !== 'tool_result' || result.callId !== this.toolCallId ||
      result.name !== TOOL_NAME || result.outcome !== 'success' ||
      !isStringArrayText(result.text)
    ) throw new Error('preceding tool result did not match the fixed JSON task');
    return result;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.step += 1;
    if (this.step > 2) throw new Error('expected one tool call and one final response');
    const previousResult = this.step === 2 ? this.previousToolResult(request) : undefined;
    const result = await this.delegate.generate(request);
    if (this.step === 1) {
      if (result.kind !== 'tool_calls' || result.calls.length !== 1) {
        throw new Error('expected exactly one tool call');
      }
      const call = result.calls[0];
      const args = call.arguments;
      if (
        call.name !== TOOL_NAME || typeof args !== 'object' || args === null ||
        Array.isArray(args)
      ) throw new Error('tool call did not match the fixed JSON task');
      const objectArgs = args as { readonly [key: string]: unknown };
      if (
        Object.keys(objectArgs).length !== 2 ||
        objectArgs.path !== PATH || objectArgs.objectKey !== OBJECT_KEY
      ) throw new Error('tool call did not match the fixed JSON task');
      this.toolCallId = call.callId;
      return result;
    }
    if (result.kind === 'final' && sameStringArray(result.text, previousResult?.text)) {
      return result;
    }
    throw new Error('expected one final response after the tool result');
  }
}

export const main = async (): Promise<number> => {
  let requestCount = 0;
  const countedFetch: typeof fetch = (input, init) => {
    requestCount += 1;
    return fetch(input, init);
  };
  const model = new ExactJsonKeysModel(new OpenRouterAgentModel({ fetcher: countedFetch }));
  const outcome = await runAgent(
    JSON_KEYS_TASK,
    model,
    new Registry([createJsonObjectKeysTool({ allowedPath: PATH })]),
    { maxSteps: 2 },
  );
  const toolMessage = outcome.transcript.find((message) => message.role === 'tool');
  const toolResult = toolMessage?.role === 'tool' ? toolMessage.content[0] : undefined;
  const ok = outcome.ok && requestCount === 2 && outcome.toolCallCount === 1 &&
    outcome.toolResultCount === 1 && toolResult?.outcome === 'success' &&
    sameStringArray(outcome.finalText, toolResult.text);
  console.log(JSON.stringify({
    ok,
    requestCount,
    steps: outcome.steps,
    toolCallCount: outcome.toolCallCount,
    toolResultCount: outcome.toolResultCount,
    finalText: outcome.finalText,
  }));
  return ok ? 0 : 1;
};

if (import.meta.main) Deno.exit(await main());
