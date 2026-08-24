import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import { type Message, type ModelRequest, type ToolCall } from '../../v0/agent/contracts.ts';
import { FixtureModel } from '../../v0/agent/fixture_model.ts';
import { main } from '../../v0/agent/cli.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { createFixtureTool, Registry, type Tool } from '../../v0/agent/tools.ts';

const call = (callId: string, name = 'uppercase_text', text = callId): ToolCall => ({
  callId,
  name,
  arguments: { text },
});

const finalAfterTool = (text = 'done') => (request: ModelRequest) => {
  const last = request.transcript.at(-1);
  assert(last?.role === 'tool', 'fixture did not receive a tool message');
  assertEquals(last.content.length, 1);
  assertEquals(last.content[0].outcome, 'success');
  return { kind: 'final' as const, text };
};

const assertThrows = (fn: () => unknown, expected: string): void => {
  try {
    fn();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(expected));
    return;
  }
  throw new Error(`expected error containing ${expected}`);
};

Deno.test('provider-neutral contract represents all message and result variants', () => {
  const messages: Message[] = [
    { role: 'user', content: { kind: 'text', text: 'task' } },
    { role: 'assistant', content: [{ kind: 'tool_call', ...call('c1') }] },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'c1',
        name: 'uppercase_text',
        text: 'C1',
        outcome: 'success',
      }],
    },
    { role: 'assistant', content: { kind: 'text', text: 'final' } },
  ];
  assertEquals(messages.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant']);
  const assistant = messages[1];
  assert(assistant.role === 'assistant' && Array.isArray(assistant.content));
  assertEquals(assistant.content[0].callId, 'c1');
  const tool = messages[2];
  assert(tool.role === 'tool');
  assertEquals(tool.content[0].outcome, 'success');
});

Deno.test('registry presents stable definitions, resolves names, and rejects duplicates', () => {
  const first: Tool = { name: 'z_tool', description: 'z', inputSchema: {}, execute: () => 'z' };
  const second: Tool = { name: 'a_tool', description: 'a', inputSchema: {}, execute: () => 'a' };
  const registry = new Registry([first, second]);
  assertEquals(registry.definitions().map((item) => item.name), ['a_tool', 'z_tool']);
  assert(registry.resolve('a_tool') === second);
  assertThrows(() => new Registry([{ ...first }, { ...first }]), 'duplicate tool name');
  assertThrows(() => new Registry([{ ...first, name: ' ' }]), 'tool name must not be empty');
});

Deno.test('registry normalizes fixed-tool success, invalid input, unknown, and execution errors', async () => {
  const fixed = new Registry([createFixtureTool()]);
  const success = await fixed.dispatch(call('ok', 'uppercase_text', 'hello'));
  assertEquals(success, {
    kind: 'tool_result',
    callId: 'ok',
    name: 'uppercase_text',
    text: 'HELLO',
    outcome: 'success',
  });
  const invalid = await fixed.dispatch({
    callId: 'bad',
    name: 'uppercase_text',
    arguments: { text: 1 },
  });
  assert(invalid.outcome === 'error' && invalid.text.startsWith('invalid arguments:'));
  const unknown = await fixed.dispatch(call('missing', 'missing_tool'));
  assertEquals(unknown.outcome, 'error');
  assert(unknown.text.includes('unknown tool: missing_tool'));

  const throwing: Tool = {
    name: 'throwing',
    description: 'throws',
    inputSchema: {},
    execute: () => {
      throw new Error('boom');
    },
  };
  const rejecting: Tool = {
    name: 'rejecting',
    description: 'rejects',
    inputSchema: {},
    execute: () => Promise.reject(new Error('later')),
  };
  const failures = new Registry([throwing, rejecting]);
  const thrown = await failures.dispatch(call('throw', 'throwing'));
  const rejected = await failures.dispatch(call('reject', 'rejecting'));
  assert(thrown.outcome === 'error' && thrown.text === 'tool execution error: boom');
  assert(rejected.outcome === 'error' && rejected.text === 'tool execution error: later');
});

Deno.test('fixture model records every request and observes prior tool results', async () => {
  const registry = new Registry([createFixtureTool()]);
  const model = new FixtureModel([
    (request) => {
      assertEquals(request.tools, registry.definitions());
      assertEquals(request.transcript.length, 1);
      return { kind: 'tool_calls', calls: [call('one')] };
    },
    (request) => {
      const last = request.transcript.at(-1);
      assert(last?.role === 'tool');
      assertEquals(last.content[0].callId, 'one');
      return { kind: 'final', text: 'observed' };
    },
  ]);
  const outcome = await runAgent('input', model, registry);
  assert(outcome.ok);
  assertEquals(model.callCount, 2);
  assertEquals(model.requestsSnapshot().map((request) => request.transcript.length), [1, 3]);
  assertEquals(outcome.finalText, 'observed');
});

Deno.test('final-only loop stops after one model step without dispatch', async () => {
  let executions = 0;
  const tool: Tool = {
    name: 'unused',
    description: 'unused',
    inputSchema: {},
    execute: () => {
      executions += 1;
      return 'x';
    },
  };
  const outcome = await runAgent(
    'hello',
    new FixtureModel([{ kind: 'final', text: 'answer' }]),
    new Registry([tool]),
  );
  assert(outcome.ok);
  assertEquals(outcome.finalText, 'answer');
  assertEquals(outcome.steps, 1);
  assertEquals(outcome.toolCallCount, 0);
  assertEquals(outcome.toolResultCount, 0);
  assertEquals(outcome.transcript.map((message) => message.role), ['user', 'assistant']);
  assertEquals(executions, 0);
});

Deno.test('one tool round preserves causal transcript and returns final text', async () => {
  const model = new FixtureModel([
    { kind: 'tool_calls', calls: [call('one', 'uppercase_text', 'hello')] },
    finalAfterTool('HELLO'),
  ]);
  const outcome = await runAgent('hello', model, new Registry([createFixtureTool()]));
  assert(outcome.ok);
  assertEquals(outcome.steps, 2);
  assertEquals(outcome.toolCallCount, 1);
  assertEquals(outcome.toolResultCount, 1);
  assertEquals(outcome.transcript.map((message) => message.role), [
    'user',
    'assistant',
    'tool',
    'assistant',
  ]);
  assertEquals(outcome.transcript[1], {
    role: 'assistant',
    content: [{
      kind: 'tool_call',
      callId: 'one',
      name: 'uppercase_text',
      arguments: { text: 'hello' },
    }],
  });
  assertEquals(outcome.transcript[2], {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'one',
      name: 'uppercase_text',
      text: 'HELLO',
      outcome: 'success',
    }],
  });
});

Deno.test('two tool rounds are driven by successive request snapshots', async () => {
  const model = new FixtureModel([
    { kind: 'tool_calls', calls: [call('one', 'uppercase_text', 'first')] },
    (request) => {
      assertEquals(request.transcript.at(-1)?.role, 'tool');
      return { kind: 'tool_calls', calls: [call('two', 'uppercase_text', 'second')] };
    },
    (request) => {
      assertEquals(request.transcript.filter((message) => message.role === 'tool').length, 2);
      return { kind: 'final', text: 'two rounds complete' };
    },
  ]);
  const outcome = await runAgent('task', model, new Registry([createFixtureTool()]));
  assert(outcome.ok);
  assertEquals(outcome.steps, 3);
  assertEquals(outcome.toolCallCount, 2);
  assertEquals(outcome.toolResultCount, 2);
  assertEquals(outcome.transcript.map((message) => message.role), [
    'user',
    'assistant',
    'tool',
    'assistant',
    'tool',
    'assistant',
  ]);
  assertEquals(model.requestsSnapshot().map((request) => request.transcript.length), [1, 3, 5]);
});

Deno.test('unknown, invalid, and execution errors return to the fixture before final', async () => {
  const throwing: Tool = {
    name: 'throwing',
    description: 'throws',
    inputSchema: {},
    execute: () => {
      throw new Error('injected failure');
    },
  };
  const cases: Array<{ name: string; registry: Registry; toolCall: ToolCall; expected: string }> = [
    {
      name: 'unknown',
      registry: new Registry([]),
      toolCall: call('unknown', 'missing'),
      expected: 'unknown tool',
    },
    {
      name: 'invalid',
      registry: new Registry([createFixtureTool()]),
      toolCall: { callId: 'invalid', name: 'uppercase_text', arguments: { text: false } },
      expected: 'invalid arguments',
    },
    {
      name: 'execution',
      registry: new Registry([throwing]),
      toolCall: call('execution', 'throwing'),
      expected: 'tool execution error',
    },
  ];
  for (const testCase of cases) {
    const model = new FixtureModel([
      { kind: 'tool_calls', calls: [testCase.toolCall] },
      (request) => {
        const last = request.transcript.at(-1);
        assert(last?.role === 'tool');
        assert(last.content[0].outcome === 'error');
        assert(last.content[0].text.includes(testCase.expected));
        return { kind: 'final', text: `${testCase.name} recovered` };
      },
    ]);
    const outcome = await runAgent(testCase.name, model, testCase.registry);
    assert(outcome.ok);
    assertEquals(outcome.finalText, `${testCase.name} recovered`);
    assertEquals(outcome.toolResultCount, 1);
  }
});

Deno.test('max steps dispatches the final permitted batch but never calls or executes beyond it', async () => {
  let executions = 0;
  const tool: Tool = {
    name: 'counting',
    description: 'counts',
    inputSchema: {},
    execute: () => {
      executions += 1;
      return 'ok';
    },
  };
  const model = new FixtureModel([
    { kind: 'tool_calls', calls: [call('one', 'counting')] },
    { kind: 'tool_calls', calls: [call('two', 'counting')] },
    { kind: 'tool_calls', calls: [call('three', 'counting')] },
  ]);
  const outcome = await runAgent('loop', model, new Registry([tool]), { maxSteps: 2 });
  assert(!outcome.ok);
  assertEquals(outcome.stopReason, 'max_steps');
  assertEquals(outcome.steps, 2);
  assertEquals(outcome.toolCallCount, 2);
  assertEquals(outcome.toolResultCount, 2);
  assertEquals(model.callCount, 2);
  assertEquals(executions, 2);
  assertEquals(outcome.transcript.filter((message) => message.role === 'tool').length, 2);
  await assertRejects(() => runAgent('x', model, new Registry([]), { maxSteps: 0 }));
});

Deno.test('fixture contract failure is terminal and does not escape as a rejection', async () => {
  const outcome = await runAgent('exhausted', new FixtureModel([]), new Registry([]));
  assert(!outcome.ok);
  assertEquals(outcome.stopReason, 'contract_failure');
  assert(outcome.error?.includes('fixture script exhausted') === true);
  assertEquals(outcome.steps, 1);
  assertEquals(outcome.transcript.length, 1);
});

Deno.test('fixture CLI composes one task into deterministic JSON output', async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    assertEquals(await main(['--task', 'hello']), 0);
  } finally {
    console.log = originalLog;
  }
  assertEquals(lines.length, 1);
  const output = JSON.parse(lines[0]);
  assertEquals(output.task, 'hello');
  assertEquals(output.finalText, 'Fixture result: HELLO');
  assertEquals(output.outcome, 'final');
  assertEquals(output.stopReason, 'final');
  assertEquals(output.steps, 2);
  assertEquals(output.toolCallCount, 1);
  assertEquals(output.toolResultCount, 1);
  assertEquals(output.transcript.map((message: Message) => message.role), [
    'user',
    'assistant',
    'tool',
    'assistant',
  ]);
});

Deno.test('fixture CLI returns exit 1 and JSON contract failure for invalid arguments', async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    assertEquals(await main(['--unknown']), 1);
  } finally {
    console.log = originalLog;
  }
  assertEquals(lines.length, 1);
  const output = JSON.parse(lines[0]);
  assertEquals(output.outcome, 'contract_failure');
  assertEquals(output.stopReason, 'contract_failure');
  assert(output.error.includes('usage: --task TEXT'));
});
