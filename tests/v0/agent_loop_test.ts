import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  type JsonValue,
  type Message,
  type Model,
  type ModelRequest,
  type ToolCall,
} from '../../v0/agent/contracts.ts';
import { FixtureModel } from '../../v0/agent/fixture_model.ts';
import { main } from '../../v0/agent/cli.ts';
import { runAgent, runAgentTurnObservedForComparison } from '../../v0/agent/loop.ts';
import {
  createFixtureTool,
  createJsonResultSubmissionTool,
  Registry,
  type Tool,
} from '../../v0/agent/tools.ts';

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
    content: {
      kind: 'tool_result',
      callId: 'ok',
      name: 'uppercase_text',
      text: 'HELLO',
      outcome: 'success',
    },
    terminal: null,
  });
  const invalid = await fixed.dispatch({
    callId: 'bad',
    name: 'uppercase_text',
    arguments: { text: 1 },
  });
  assert(
    invalid.content.outcome === 'error' && invalid.content.text.startsWith('invalid arguments:'),
  );
  const unknown = await fixed.dispatch(call('missing', 'missing_tool'));
  assertEquals(unknown.content.outcome, 'error');
  assert(unknown.content.text.includes('unknown tool: missing_tool'));

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
  assert(
    thrown.content.outcome === 'error' && thrown.content.text === 'tool execution error: boom',
  );
  assert(
    rejected.content.outcome === 'error' && rejected.content.text === 'tool execution error: later',
  );
});

Deno.test('successful JSON terminal result records the tool message and stops before another request', async () => {
  let requests = 0;
  const outcome = await runAgent(
    'json task',
    {
      generate: () => {
        requests += 1;
        return {
          kind: 'tool_calls' as const,
          calls: [{
            callId: 'submit-1',
            name: 'submit_json_result',
            arguments: { json: '{ "b": 1, "a": [true, null] }' },
          }],
        };
      },
    },
    new Registry([createJsonResultSubmissionTool()]),
    { maxSteps: 8 },
  );
  assert(outcome.ok);
  assertEquals(requests, 1);
  assertEquals(outcome.stopReason, 'tool_terminal');
  assertEquals(outcome.finalText, '{"b":1,"a":[true,null]}');
  assertEquals(outcome.terminalKind, 'json_result');
  const last = outcome.transcript.at(-1);
  assert(last?.role === 'tool');
  assertEquals(last.content[0], {
    kind: 'tool_result',
    callId: 'submit-1',
    name: 'submit_json_result',
    text: 'json result submitted',
    outcome: 'success',
    terminal: 'json_result',
  });
});

Deno.test('JSON submission accepts every top-level value and canonicalizes strictly', async () => {
  const registry = new Registry([createJsonResultSubmissionTool()]);
  const cases: readonly [JsonValue, string][] = [
    [{ json: 'null' }, 'null'],
    [{ json: 'true' }, 'true'],
    [{ json: '42' }, '42'],
    [{ json: '"text"' }, '"text"'],
    [{ json: '[1, { "b": 2, "a": null }]' }, '[1,{"b":2,"a":null}]'],
    [{ json: '{ "b": 2, "a": [true, null] }' }, '{"b":2,"a":[true,null]}'],
    [
      { json: JSON.stringify(`${'😀'.repeat(16_383)}aa`) },
      JSON.stringify(`${'😀'.repeat(16_383)}aa`),
    ],
  ];
  for (const [argumentsValue, finalText] of cases) {
    const result = await registry.dispatch({
      callId: `valid-${finalText.slice(0, 4)}`,
      name: 'submit_json_result',
      arguments: argumentsValue,
    });
    assertEquals(result.terminal, { kind: 'json_result', finalText });
    assertEquals(result.content, {
      kind: 'tool_result',
      callId: result.content.callId,
      name: 'submit_json_result',
      text: 'json result submitted',
      outcome: 'success',
      terminal: 'json_result',
    });
  }
});

Deno.test('JSON submission rejects wrong shapes, malformed text, fences, and byte overflow', async () => {
  const registry = new Registry([createJsonResultSubmissionTool()]);
  const tooLarge = JSON.stringify(`${'😀'.repeat(16_384)}`);
  const cases: readonly JsonValue[] = [
    null,
    [],
    {},
    { json: 1 },
    { json: ' ' },
    { json: '' },
    { json: '```json\n{"ok":true}\n```' },
    { json: 'prefix {"ok":true}' },
    { json: '{"ok":true} suffix' },
    { json: '{"json":"ok"}', extra: false },
    { json: tooLarge },
  ];
  for (const [index, argumentsValue] of cases.entries()) {
    const result = await registry.dispatch({
      callId: `invalid-${index}`,
      name: 'submit_json_result',
      arguments: argumentsValue,
    });
    assertEquals(result.terminal, null);
    assert(result.content.outcome === 'error');
    assert(result.content.text.startsWith('invalid arguments:'));
  }
});

Deno.test('successful JSON terminal result on step eight does not issue a ninth request', async () => {
  let requests = 0;
  const model = {
    generate: () => {
      requests += 1;
      if (requests < 8) {
        return { kind: 'tool_calls' as const, calls: [call(`domain-${requests}`)] };
      }
      return {
        kind: 'tool_calls' as const,
        calls: [{ callId: 'submit-eighth', name: 'submit_json_result', arguments: { json: '7' } }],
      };
    },
  };
  const outcome = await runAgent(
    'last-step JSON task',
    model,
    new Registry([createFixtureTool(), createJsonResultSubmissionTool()]),
    { maxSteps: 8 },
  );
  assert(outcome.ok);
  assertEquals(requests, 8);
  assertEquals(outcome.steps, 8);
  assertEquals(outcome.stopReason, 'tool_terminal');
  assertEquals(outcome.finalText, '7');
});

Deno.test('multiple terminal calls and terminal-plus-unknown batches execute nothing', async () => {
  let executions = 0;
  const terminalTool: Tool = {
    name: 'counting_terminal',
    description: 'counts terminal executions',
    inputSchema: {},
    terminal: true,
    execute: () => {
      executions += 1;
      return {
        kind: 'terminate' as const,
        text: 'submitted',
        finalText: '1',
        terminalKind: 'json_result' as const,
      };
    },
  };
  const batches: readonly ToolCall[][] = [
    [
      { callId: 'terminal-1', name: 'counting_terminal', arguments: {} },
      { callId: 'terminal-2', name: 'counting_terminal', arguments: {} },
    ],
    [
      { callId: 'terminal-1', name: 'counting_terminal', arguments: {} },
      { callId: 'unknown', name: 'missing_tool', arguments: {} },
    ],
  ];
  for (const calls of batches) {
    let requests = 0;
    const outcome = await runAgent(
      'invalid terminal batch',
      {
        generate: () => {
          requests += 1;
          return { kind: 'tool_calls' as const, calls };
        },
      },
      new Registry([terminalTool]),
      { maxSteps: 1 },
    );
    assert(!outcome.ok);
    assertEquals(executions, 0);
    assertEquals(requests, 1);
    assertEquals(outcome.stopReason, 'max_steps');
    const tool = outcome.transcript.at(-1);
    assert(tool?.role === 'tool');
    assertEquals(tool.content.map((result) => result.text), [
      'terminal tool must be the sole call in its batch',
      'terminal tool must be the sole call in its batch',
    ]);
  }
});

Deno.test('terminal and non-terminal execution-result mismatches stay continuing errors', async () => {
  const nonTerminalReturnsTerminal: Tool = {
    name: 'nonterminal_returns_terminal',
    description: 'invalid non-terminal result',
    inputSchema: {},
    execute: () => ({
      kind: 'terminate' as const,
      text: 'bad',
      finalText: 'bad',
      terminalKind: 'json_result' as const,
    }),
  };
  const terminalReturnsText: Tool = {
    name: 'terminal_returns_text',
    description: 'invalid terminal result',
    inputSchema: {},
    terminal: true,
    execute: () => 'continuing',
  };
  const registry = new Registry([nonTerminalReturnsTerminal, terminalReturnsText]);
  const nonTerminalResult = await registry.dispatch({
    callId: 'nonterminal',
    name: nonTerminalReturnsTerminal.name,
    arguments: {},
  });
  assertEquals(nonTerminalResult.terminal, null);
  assertEquals(nonTerminalResult.content.outcome, 'error');
  assertEquals(
    nonTerminalResult.content.text,
    'tool execution error: tool returned a terminal result from a non-terminal tool',
  );
  const terminalResult = await registry.dispatch({
    callId: 'terminal',
    name: terminalReturnsText.name,
    arguments: {},
  });
  assertEquals(terminalResult.terminal, null);
  assertEquals(terminalResult.content.outcome, 'error');
  assertEquals(
    terminalResult.content.text,
    'tool execution error: tool returned a continuing result from a terminal tool',
  );
});

Deno.test('failed and throwing terminal calls recover on the next bounded request', async () => {
  const throwingTerminal: Tool = {
    name: 'throwing_terminal',
    description: 'throws',
    inputSchema: {},
    terminal: true,
    execute: () => {
      throw new Error('terminal failure');
    },
  };
  const cases: readonly [Registry, ToolCall][] = [
    [new Registry([createJsonResultSubmissionTool()]), {
      callId: 'invalid-terminal',
      name: 'submit_json_result',
      arguments: { json: 'not JSON' },
    }],
    [new Registry([throwingTerminal]), {
      callId: 'throwing-terminal',
      name: 'throwing_terminal',
      arguments: {},
    }],
  ];
  for (const [registry, toolCall] of cases) {
    const outcome = await runAgent(
      'recover terminal task',
      new FixtureModel([
        { kind: 'tool_calls', calls: [toolCall] },
        { kind: 'final', text: 'recovered' },
      ]),
      registry,
      { maxSteps: 2 },
    );
    assert(outcome.ok);
    assertEquals(outcome.finalText, 'recovered');
    assertEquals(outcome.steps, 2);
    assertEquals(outcome.toolResultCount, 1);
  }
});

Deno.test('mixed terminal batches execute no calls and produce ordered continuing errors', async () => {
  let executions = 0;
  const domain: Tool = {
    ...createFixtureTool(),
    execute: () => {
      executions += 1;
      return 'X';
    },
  };
  const outcome = await runAgent(
    'mixed task',
    {
      generate: () => ({
        kind: 'tool_calls',
        calls: [
          { callId: 'terminal', name: 'submit_json_result', arguments: { json: '1' } },
          { callId: 'domain', name: 'uppercase_text', arguments: { text: 'x' } },
        ] as ToolCall[],
      }),
    },
    new Registry([createJsonResultSubmissionTool(), domain]),
    { maxSteps: 1 },
  );
  assert(!outcome.ok);
  assertEquals(executions, 0);
  assertEquals(outcome.stopReason, 'max_steps');
  const last = outcome.transcript.at(-1);
  assert(last?.role === 'tool');
  assertEquals(last.content.map((result) => result.text), [
    'terminal tool must be the sole call in its batch',
    'terminal tool must be the sole call in its batch',
  ]);
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

Deno.test('system instruction is repeated on every request but stays outside transcript', async () => {
  const seen: ModelRequest[] = [];
  const model = {
    generate(request: ModelRequest) {
      seen.push(request);
      return seen.length === 1
        ? { kind: 'tool_calls' as const, calls: [call('context-call')] }
        : { kind: 'final' as const, text: 'done' };
    },
  };
  const instruction =
    'Project context instructions loaded from AGENTS.md.\n\n## ./AGENTS.md\n\nkeep separate';
  const outcome = await runAgent(
    'task',
    model,
    new Registry([createFixtureTool()]),
    { systemInstruction: instruction },
  );
  assert(outcome.ok);
  assertEquals(seen.length, 2);
  assertEquals(seen[0].systemInstruction, instruction);
  assertEquals(seen[1].systemInstruction, instruction);
  assertEquals(outcome.transcript.map((message) => message.role), [
    'user',
    'assistant',
    'tool',
    'assistant',
  ]);
  assert(!JSON.stringify(outcome.transcript).includes(instruction));
});

Deno.test('omitted system instruction preserves request shape', async () => {
  let request: ModelRequest | undefined;
  await runAgent(
    'task',
    { generate: (next) => (request = next, { kind: 'final' as const, text: 'done' }) },
    new Registry([]),
  );
  assert(request !== undefined);
  assert(!Object.hasOwn(request, 'systemInstruction'));
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

Deno.test('comparison observer reports model and accepted tool boundaries exactly once', async () => {
  const trace: string[] = [];
  let executions = 0;
  const model = new FixtureModel([
    { kind: 'tool_calls', calls: [call('observed', 'counting', 'one')] },
    { kind: 'final', text: 'done' },
  ]);
  const tool: Tool = {
    name: 'counting',
    description: 'counts',
    inputSchema: {},
    execute: () => {
      executions += 1;
      return 'ONE';
    },
  };
  const outcome = await runAgentTurnObservedForComparison(
    'observe',
    [],
    model,
    new Registry([tool]),
    {
      modelSettled: (kind) => trace.push(`model:${kind}`),
      toolCallAccepted: (accepted) => trace.push(`call:${accepted.callId}`),
      toolResultAccepted: (result) => trace.push(`result:${result.callId}:${result.outcome}`),
    },
    {
      eventSink: (event) => {
        if (event.kind === 'tool_call') trace.push(`event:call:${event.call.callId}`);
        if (event.kind === 'tool_result') trace.push(`event:result:${event.result.callId}`);
      },
    },
  );
  assert(outcome.ok);
  assertEquals(executions, 1);
  assertEquals(trace, [
    'model:tool_calls',
    'event:call:observed',
    'call:observed',
    'event:result:observed',
    'result:observed:success',
    'model:final',
  ]);
});

Deno.test('comparison observer throw is not converted to tool execution or contract outcome', async () => {
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
  let rejected = false;
  try {
    await runAgentTurnObservedForComparison(
      'observe',
      [],
      new FixtureModel([{ kind: 'tool_calls', calls: [call('throw-call', 'counting')] }]),
      new Registry([tool]),
      {
        modelSettled: () => undefined,
        toolCallAccepted: () => {
          throw new Error('observer-call-marker');
        },
        toolResultAccepted: () => undefined,
      },
    );
  } catch (error) {
    rejected = error instanceof Error && error.message === 'observer-call-marker';
  }
  assert(rejected);
  assertEquals(executions, 0);
});

Deno.test('comparison observer reports synthetic and continuing result boundaries', async () => {
  const trace: string[] = [];
  const outcome = await runAgentTurnObservedForComparison(
    'observe',
    [],
    new FixtureModel([
      {
        kind: 'tool_calls',
        calls: [call('terminal', 'submit_json_result'), call('normal', 'counting')],
      },
      { kind: 'tool_calls', calls: [call('missing', 'missing_tool')] },
      { kind: 'final', text: 'done' },
    ]),
    new Registry([
      createJsonResultSubmissionTool(),
      {
        name: 'counting',
        description: 'counts',
        inputSchema: {},
        execute: () => 'counted',
      },
    ]),
    {
      modelSettled: (kind) => trace.push(`model:${kind}`),
      toolCallAccepted: (accepted) => trace.push(`call:${accepted.callId}`),
      toolResultAccepted: (result) => trace.push(`result:${result.callId}:${result.outcome}`),
    },
    { maxSteps: 3 },
  );
  assertEquals(outcome.stopReason, 'final');
  assertEquals(outcome.toolCallCount, 3);
  assertEquals(outcome.toolResultCount, 3);
  assertEquals(trace, [
    'model:tool_calls',
    'call:terminal',
    'result:terminal:error',
    'call:normal',
    'result:normal:error',
    'model:tool_calls',
    'call:missing',
    'result:missing:error',
    'model:final',
  ]);
});

Deno.test('comparison model and result observer failures retain exact boundary errors', async () => {
  let finalRejected = false;
  try {
    await runAgentTurnObservedForComparison(
      'observe',
      [],
      new FixtureModel([{ kind: 'final', text: 'done' }]),
      new Registry([]),
      {
        modelSettled: () => {
          throw new Error('observer-final-marker');
        },
        toolCallAccepted: () => undefined,
        toolResultAccepted: () => undefined,
      },
    );
  } catch (error) {
    finalRejected = error instanceof Error && error.message === 'observer-final-marker';
  }
  assert(finalRejected);

  let invalidRejected = false;
  try {
    await runAgentTurnObservedForComparison(
      'observe',
      [],
      { generate: () => ({ kind: 'invalid' } as unknown as ReturnType<Model['generate']>) },
      new Registry([]),
      {
        modelSettled: () => {
          throw new Error('observer-error-marker');
        },
        toolCallAccepted: () => undefined,
        toolResultAccepted: () => undefined,
      },
    );
  } catch (error) {
    invalidRejected = error instanceof Error && error.message === 'observer-error-marker';
  }
  assert(invalidRejected);

  let executions = 0;
  let resultRejected = false;
  try {
    await runAgentTurnObservedForComparison(
      'observe',
      [],
      new FixtureModel([{ kind: 'tool_calls', calls: [call('result-call')] }]),
      new Registry([{
        name: 'uppercase_text',
        description: 'uppercase',
        inputSchema: {},
        execute: () => {
          executions += 1;
          return 'OK';
        },
      }]),
      {
        modelSettled: () => undefined,
        toolCallAccepted: () => undefined,
        toolResultAccepted: () => {
          throw new Error('observer-result-marker');
        },
      },
      { maxSteps: 1 },
    );
  } catch (error) {
    resultRejected = error instanceof Error && error.message === 'observer-result-marker';
  }
  assert(resultRejected);
  assertEquals(executions, 1);
});
