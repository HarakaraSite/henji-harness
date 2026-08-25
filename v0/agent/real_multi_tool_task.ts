import { OpenRouterAgentModel } from './openrouter_model.ts';
import {
  type Model,
  type ModelRequest,
  type ModelResult,
  type ToolResultContent,
} from './contracts.ts';
import { runAgent } from './loop.ts';
import { createJsonArrayCountTool, createJsonObjectKeysTool, Registry } from './tools.ts';

const PATH = 'deno.v0.json';
const LIST_TOOL_NAME = 'list_json_object_keys';
const COUNT_TOOL_NAME = 'count_json_array_items';
export const MULTI_TOOL_TASK =
  'First use list_json_object_keys with path "deno.v0.json" and objectKey "tasks". ' +
  'Then use count_json_array_items with that JSON array as the json argument. ' +
  'Finally reply with exactly the count_json_array_items JSON result and nothing else.';

const isStringArrayText = (text: string): boolean => {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  } catch {
    return false;
  }
};

const isCountResultText = (text: string): boolean => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 && Number.isSafeInteger(record.count) &&
      (record.count as number) >= 0;
  } catch {
    return false;
  }
};

export class OrderedMultiToolModel implements Model {
  private step = 0;
  private firstCallId: string | undefined;
  private secondCallId: string | undefined;

  constructor(private readonly delegate: Model) {}

  private previousToolResult(
    request: ModelRequest,
    expectedName: string,
    expectedCallId: string | undefined,
    validText: (text: string) => boolean,
  ): ToolResultContent {
    const previousMessage = request.transcript[request.transcript.length - 1];
    if (previousMessage?.role !== 'tool' || previousMessage.content.length !== 1) {
      throw new Error('expected one preceding tool result');
    }
    const result = previousMessage.content[0];
    if (
      result.kind !== 'tool_result' || result.callId !== expectedCallId ||
      result.name !== expectedName || result.outcome !== 'success' ||
      !validText(result.text)
    ) throw new Error('preceding tool result did not match the ordered task');
    return result;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.step += 1;
    if (this.step > 3) throw new Error('expected two tool calls and one final response');
    const previousResult = this.step === 2
      ? this.previousToolResult(request, LIST_TOOL_NAME, this.firstCallId, isStringArrayText)
      : this.step === 3
      ? this.previousToolResult(request, COUNT_TOOL_NAME, this.secondCallId, isCountResultText)
      : undefined;
    const result = await this.delegate.generate(request);
    if (this.step === 1) {
      const call = result.kind === 'tool_calls' && result.calls.length === 1
        ? result.calls[0]
        : undefined;
      if (
        call?.name !== LIST_TOOL_NAME || typeof call.arguments !== 'object' ||
        call.arguments === null || Array.isArray(call.arguments)
      ) throw new Error('first step did not select the JSON-list tool');
      const args = call.arguments as { readonly [key: string]: unknown };
      if (args.path !== PATH || args.objectKey !== 'tasks') {
        throw new Error('first tool arguments did not match the task');
      }
      this.firstCallId = call.callId;
      return result;
    }
    if (this.step === 2) {
      const call = result.kind === 'tool_calls' && result.calls.length === 1
        ? result.calls[0]
        : undefined;
      if (
        call?.name !== COUNT_TOOL_NAME || typeof call.arguments !== 'object' ||
        call.arguments === null || Array.isArray(call.arguments)
      ) throw new Error('second step did not select the JSON-count tool');
      const args = call.arguments as { readonly [key: string]: unknown };
      if (typeof args.json !== 'string') {
        throw new Error('second tool did not receive the first tool result');
      }
      try {
        if (
          JSON.stringify(JSON.parse(args.json)) !==
            JSON.stringify(JSON.parse(previousResult?.text ?? ''))
        ) {
          throw new Error('different JSON value');
        }
      } catch {
        throw new Error('second tool did not receive the first tool result');
      }
      this.secondCallId = call.callId;
      return result;
    }
    if (
      this.step === 3 && result.kind === 'final' && result.text === previousResult?.text
    ) return result;
    throw new Error('final response did not match the second tool result');
  }
}

export const main = async (): Promise<number> => {
  let requestCount = 0;
  const countedFetch: typeof fetch = (input, init) => {
    requestCount += 1;
    return fetch(input, init);
  };
  const outcome = await runAgent(
    MULTI_TOOL_TASK,
    new OrderedMultiToolModel(new OpenRouterAgentModel({ fetcher: countedFetch })),
    new Registry([
      createJsonObjectKeysTool({ allowedPath: PATH }),
      createJsonArrayCountTool(),
    ]),
    { maxSteps: 3 },
  );
  const ok = outcome.ok && requestCount === 3 && outcome.steps === 3 &&
    outcome.toolCallCount === 2 && outcome.toolResultCount === 2;
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
