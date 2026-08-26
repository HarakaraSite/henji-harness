import { assert, assertEquals } from './test_helpers.ts';
import {
  type JsonValue,
  type ModelRequest,
  type ModelResult,
  type ToolCall,
} from '../../v0/agent/contracts.ts';
import { FixtureModel } from '../../v0/agent/fixture_model.ts';
import {
  evaluateTaskSelectionOutcome,
  runTwoToolTaskSelection,
  TASK_SELECTION_CASES,
  type TaskSelectionCase,
} from '../../v0/agent/two_tool_task_selection.ts';
import { createCharacterCountTool, createFixtureTool, Registry } from '../../v0/agent/tools.ts';

const call = (callId: string, name: string, text: string): ToolCall => ({
  callId,
  name,
  arguments: { text },
});

const assertContractFailure = (
  run: Awaited<ReturnType<typeof runTwoToolTaskSelection>>,
  model: FixtureModel,
  steps: number,
  toolCalls: number,
  toolResults: number,
  expectedExecutionCounts = { character_count: 0, uppercase_text: 0 },
): void => {
  assert(!run.outcome.ok);
  assertEquals(run.outcome.stopReason, 'contract_failure');
  assertEquals(run.outcome.steps, steps);
  assertEquals(run.outcome.toolCallCount, toolCalls);
  assertEquals(run.outcome.toolResultCount, toolResults);
  assertEquals(model.callCount, steps);
  assertEquals(run.toolExecutionCounts, expectedExecutionCounts);
  assert(!run.evaluation.ok);
};

const successfulModel = (caseName: TaskSelectionCase): FixtureModel => {
  const spec = TASK_SELECTION_CASES[caseName];
  return new FixtureModel([
    (request: ModelRequest) => {
      assertEquals(request.tools.map((tool) => tool.name), ['character_count', 'uppercase_text']);
      assertEquals(request.transcript.length, 1);
      return {
        kind: 'tool_calls' as const,
        calls: [call('selection-call', spec.expectedToolName, spec.inputText)],
      };
    },
    (request: ModelRequest) => {
      assertEquals(request.tools.map((tool) => tool.name), ['character_count', 'uppercase_text']);
      assertEquals(request.transcript.map((message) => message.role), [
        'user',
        'assistant',
        'tool',
      ]);
      const toolMessage = request.transcript[2];
      assert(toolMessage.role === 'tool');
      assertEquals(toolMessage.content[0].text, spec.expectedResultText);
      return { kind: 'final' as const, text: spec.expectedFinalText };
    },
  ]);
};

Deno.test('both fixed tasks select exactly the matching tool and return its result', async () => {
  for (const caseName of ['uppercase', 'count'] as const) {
    const model = successfulModel(caseName);
    const run = await runTwoToolTaskSelection(caseName, model);
    assert(run.outcome.ok);
    assert(run.evaluation.ok);
    assertEquals(run.outcome.steps, 2);
    assertEquals(run.outcome.toolCallCount, 1);
    assertEquals(run.outcome.toolResultCount, 1);
    assertEquals(run.toolExecutionCounts[run.spec.expectedToolName], 1);
    assertEquals(run.toolExecutionCounts[run.spec.excludedToolName], 0);
    assertEquals(model.callCount, 2);
    if (caseName === 'count') {
      assertEquals(JSON.parse(run.outcome.finalText ?? ''), { count: 7 });
    } else {
      assertEquals(run.outcome.finalText, run.spec.expectedFinalText);
    }
  }
});

Deno.test('registry advertises both tools and counts Unicode code points', async () => {
  const registry = new Registry([createFixtureTool(), createCharacterCountTool()]);
  assertEquals(registry.definitions().map((definition) => definition.name), [
    'character_count',
    'uppercase_text',
  ]);
  assertEquals(registry.definitions()[0].inputSchema, {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  });
  const result = await registry.dispatch({
    callId: 'count',
    name: 'character_count',
    arguments: { text: 'Henji 🐣' },
  });
  assertEquals(result, {
    content: {
      kind: 'tool_result',
      callId: 'count',
      name: 'character_count',
      text: '{"count":7}',
      outcome: 'success',
    },
    terminal: null,
  });
  assertEquals(JSON.parse(result.content.text), { count: 7 });
});

Deno.test('character_count rejects every invalid input shape', async () => {
  const registry = new Registry([createCharacterCountTool()]);
  const invalidArguments: readonly JsonValue[] = [
    {},
    { text: 1 },
    { text: 'Henji 🐣', extra: 'unexpected' },
    ['Henji 🐣'],
    null,
  ];
  for (const argumentsValue of invalidArguments) {
    const result = await registry.dispatch({
      callId: 'invalid',
      name: 'character_count',
      arguments: argumentsValue,
    });
    assertEquals(result.content.outcome, 'error');
    assert(result.content.text.startsWith('invalid arguments:'));
  }
});

Deno.test('initial final, wrong, unknown, multiple, and schema-invalid calls fail before dispatch', async () => {
  const cases: readonly {
    readonly modelResult: ModelResult;
  }[] = [
    { modelResult: { kind: 'final', text: 'not allowed' } },
    {
      modelResult: {
        kind: 'tool_calls',
        calls: [call('wrong', 'character_count', 'henji harness step eight')],
      },
    },
    {
      modelResult: {
        kind: 'tool_calls',
        calls: [call('wrong-fixed-value', 'uppercase_text', 'different')],
      },
    },
    {
      modelResult: {
        kind: 'tool_calls',
        calls: [call('unknown', 'not_registered', 'henji harness step eight')],
      },
    },
    {
      modelResult: {
        kind: 'tool_calls',
        calls: [
          call('one', 'uppercase_text', 'henji harness step eight'),
          call('two', 'uppercase_text', 'henji harness step eight'),
        ],
      },
    },
    {
      modelResult: {
        kind: 'tool_calls',
        calls: [{
          callId: 'missing',
          name: 'uppercase_text',
          arguments: {},
        }],
      },
    },
    {
      modelResult: {
        kind: 'tool_calls',
        calls: [{
          callId: 'wrong-type',
          name: 'uppercase_text',
          arguments: { text: 1 },
        }],
      },
    },
    {
      modelResult: {
        kind: 'tool_calls',
        calls: [{
          callId: 'extra',
          name: 'uppercase_text',
          arguments: { text: 'henji harness step eight', extra: 'x' },
        }],
      },
    },
  ];
  for (const testCase of cases) {
    const model = new FixtureModel([testCase.modelResult]);
    const run = await runTwoToolTaskSelection('uppercase', model);
    assertContractFailure(run, model, 1, 0, 0);
  }
});

Deno.test('the nonmatching registered tool is rejected for both fixed tasks', async () => {
  for (const caseName of ['uppercase', 'count'] as const) {
    const spec = TASK_SELECTION_CASES[caseName];
    const model = new FixtureModel([{
      kind: 'tool_calls',
      calls: [call('wrong', spec.excludedToolName, spec.inputText)],
    }]);
    const run = await runTwoToolTaskSelection(caseName, model);
    assertContractFailure(run, model, 1, 0, 0);
  }
});

Deno.test('a second tool call is rejected after the first local result without a third model call', async () => {
  const spec = TASK_SELECTION_CASES.uppercase;
  const model = new FixtureModel([
    { kind: 'tool_calls', calls: [call('first', spec.expectedToolName, spec.inputText)] },
    { kind: 'tool_calls', calls: [call('second', spec.expectedToolName, spec.inputText)] },
  ]);
  const run = await runTwoToolTaskSelection('uppercase', model);
  assertContractFailure(run, model, 2, 1, 1, { character_count: 0, uppercase_text: 1 });
});

Deno.test('a wrong final is rejected after the first local result without a third model call', async () => {
  const spec = TASK_SELECTION_CASES.count;
  const model = new FixtureModel([
    { kind: 'tool_calls', calls: [call('first', spec.expectedToolName, spec.inputText)] },
    { kind: 'final', text: '{"count":6}' },
  ]);
  const run = await runTwoToolTaskSelection('count', model);
  assertContractFailure(run, model, 2, 1, 1, { character_count: 1, uppercase_text: 0 });
});

Deno.test('the evaluator rejects a non-complete tuple', async () => {
  const model = new FixtureModel([{ kind: 'final', text: 'not allowed' }]);
  const run = await runTwoToolTaskSelection('uppercase', model);
  const evaluation = evaluateTaskSelectionOutcome(
    run.outcome,
    'uppercase',
    run.toolExecutionCounts,
  );
  assert(!evaluation.ok);
  assertEquals(evaluation.selectedToolCount, 0);
  assertEquals(evaluation.excludedToolCount, 0);
});
