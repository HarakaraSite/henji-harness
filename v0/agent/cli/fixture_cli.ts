import { type ModelRequest, type ModelResult } from '../core/contracts.ts';
import { FixtureModel } from '../validation/fixture_model.ts';
import { runAgent } from '../core/loop.ts';
import { createFixtureTool, Registry } from '../tools/tools.ts';

const parseTask = (args: readonly string[]): string => {
  if (args.length !== 2 || args[0] !== '--task') {
    throw new Error('usage: --task TEXT');
  }
  return args[1];
};

const fixtureSteps = (task: string) => [
  {
    kind: 'tool_calls' as const,
    calls: [{ callId: 'fixture-call-1', name: 'uppercase_text', arguments: { text: task } }],
  },
  (request: ModelRequest): ModelResult => {
    const toolMessage = request.transcript.at(-1);
    if (toolMessage?.role !== 'tool' || toolMessage.content.length !== 1) {
      throw new Error('fixture did not receive one tool result');
    }
    const result = toolMessage.content[0];
    if (result.callId !== 'fixture-call-1' || result.name !== 'uppercase_text') {
      throw new Error('fixture received an unexpected tool result');
    }
    if (result.outcome !== 'success') throw new Error('fixture tool result was not successful');
    return { kind: 'final', text: `Fixture result: ${result.text}` };
  },
];

export const main = async (args: readonly string[] = Deno.args): Promise<number> => {
  let task = '';
  try {
    task = parseTask(args);
    const registry = new Registry([createFixtureTool()]);
    const model = new FixtureModel(fixtureSteps(task));
    const result = await runAgent(task, model, registry);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({
      ok: false,
      task,
      outcome: 'contract_failure',
      stopReason: 'contract_failure',
      error: message,
      steps: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    }));
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
