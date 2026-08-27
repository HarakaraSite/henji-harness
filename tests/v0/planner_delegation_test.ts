import { assert, assertEquals } from './test_helpers.ts';
import {
  type JsonValue,
  type LoopOutcome,
  type ModelRequest,
  type ToolCall,
} from '../../v0/agent/contracts.ts';
import { FixtureModel } from '../../v0/agent/fixture_model.ts';
import { ParentTurnExecutionContext, TurnRequestBudget } from '../../v0/agent/execution_context.ts';
import {
  createPlannerDelegationTool,
  DELEGATE_TO_PLANNER_DESCRIPTION,
  DELEGATE_TO_PLANNER_SCHEMA,
} from '../../v0/agent/planner_delegation.ts';
import { runAgent, runAgentTurn } from '../../v0/agent/loop.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { Registry } from '../../v0/agent/tools.ts';
import { type AgentEvent } from '../../v0/agent/events.ts';
import {
  createCorpusRegistry,
  createPlannerRegistry,
  createProductionRegistry,
} from '../../v0/agent/registries.ts';
import { emptySkillCatalog } from '../../v0/agent/skills.ts';

const encoder = new TextEncoder();

const finalOutcome = (task: string, text: string): LoopOutcome => ({
  ok: true,
  task,
  outcome: 'final',
  stopReason: 'final',
  finalText: text,
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

const delegationCall = (callId = 'delegate-1', task = 'plan this'): ToolCall => ({
  callId,
  name: 'delegate_to_planner',
  arguments: { task },
});

const tool = (handler: Parameters<typeof createPlannerDelegationTool>[0]) =>
  createPlannerDelegationTool(handler);

Deno.test('planner delegation publishes the exact nonterminal tool contract', () => {
  const created = tool(() => ({ outcome: finalOutcome('task', 'plan'), externalRequests: 1 }));
  assertEquals(created.name, 'delegate_to_planner');
  assertEquals(created.description, DELEGATE_TO_PLANNER_DESCRIPTION);
  assertEquals(created.inputSchema, DELEGATE_TO_PLANNER_SCHEMA);
  assertEquals(created.terminal, undefined);
});

Deno.test('default, planner, and corpus registries retain exact capability topology', () => {
  const handler = () => ({ outcome: finalOutcome('task', 'plan'), externalRequests: 0 });
  assertEquals(
    createProductionRegistry({ root: '/workspace' }, {}, emptySkillCatalog(), handler)
      .definitions().map((definition) => definition.name),
    ['bash', 'delegate_to_planner', 'edit', 'read', 'submit_json_result', 'write'],
  );
  assertEquals(
    createPlannerRegistry({ root: '/workspace' }, emptySkillCatalog())
      .definitions().map((definition) => definition.name),
    ['read', 'submit_json_result'],
  );
  assertEquals(
    createCorpusRegistry().definitions().map((definition) => definition.name),
    [
      'character_count',
      'count_json_array_items',
      'list_json_object_keys',
      'submit_json_result',
      'uppercase_text',
    ],
  );
});

Deno.test('invalid arguments do not consume admission or invoke the child', async () => {
  let calls = 0;
  const context = new ParentTurnExecutionContext(1);
  const registry = new Registry([tool(() => {
    calls += 1;
    return { outcome: finalOutcome('task', 'unexpected'), externalRequests: 1 };
  })]);
  for (
    const args of [
      {},
      { task: '' },
      { task: '   ' },
      { task: 'ok', extra: true },
      { task: '\0' },
      { task: '\ud800' },
      { task: '😀'.repeat(16_385) },
    ]
  ) {
    const result = await registry.dispatch({
      ...delegationCall('invalid'),
      arguments: args as JsonValue,
    }, context);
    assert(result.content.outcome === 'error');
    assert(result.content.text.startsWith('invalid arguments:'));
  }
  assertEquals(calls, 0);
  assertEquals(context.snapshot(), { parent: 0, child: 0, aggregate: 0 });
});

Deno.test('valid delegation runs synchronously and returns a bounded text envelope', async () => {
  const context = new ParentTurnExecutionContext(1);
  let childTask = '';
  let childLane = '';
  const registry = new Registry([tool((task, child) => {
    childTask = task;
    childLane = child.lane;
    assert(child.claimModelRequest());
    return { outcome: finalOutcome(task, 'child plan'), externalRequests: 1 };
  })]);
  const result = await registry.dispatch(delegationCall(), context);
  assertEquals(childTask, 'plan this');
  assertEquals(childLane, 'child');
  assertEquals(result.content.outcome, 'success');
  assertEquals(
    result.content.text,
    JSON.stringify({
      ok: true,
      agent: 'planner',
      output: { kind: 'text', text: 'child plan' },
      usage: { modelRequests: 1, externalRequests: 1 },
    }),
  );
  assertEquals(context.snapshot(), { parent: 0, child: 1, aggregate: 1 });
});

Deno.test('delegation result is continuing and parent can produce its own final', async () => {
  const context = new ParentTurnExecutionContext(1);
  const registry = new Registry([tool((task, child) => {
    assertEquals(task, 'explicit child task');
    assert(child.claimModelRequest());
    return { outcome: finalOutcome(task, 'child answer'), externalRequests: 1 };
  })]);
  const parent = new FixtureModel([
    { kind: 'tool_calls', calls: [delegationCall('one', 'explicit child task')] },
    (request: ModelRequest) => {
      const result = request.transcript.at(-1);
      assert(result?.role === 'tool');
      assertEquals(result.content[0].outcome, 'success');
      return { kind: 'final' as const, text: 'parent answer' };
    },
  ]);
  const outcome = await runAgent('parent task', parent, registry, { executionContext: context });
  assert(outcome.ok);
  assertEquals(outcome.finalText, 'parent answer');
  assertEquals(outcome.steps, 2);
  assertEquals(outcome.toolCallCount, 1);
  assertEquals(outcome.toolResultCount, 1);
  assertEquals(parent.requestsSnapshot()[0].transcript.length, 1);
});

Deno.test('child events and transcript stay private to the parent delegation call', async () => {
  const context = new ParentTurnExecutionContext(1);
  const registry = new Registry([tool((task, child) => {
    assertEquals(task, 'private child task');
    assert(child.claimModelRequest());
    return { outcome: finalOutcome(task, 'private plan'), externalRequests: 1 };
  })]);
  const events: AgentEvent[] = [];
  const outcome = await runAgentTurn(
    'parent task',
    [],
    new FixtureModel([
      { kind: 'tool_calls', calls: [delegationCall('private', 'private child task')] },
      { kind: 'final', text: 'parent final' },
    ]),
    registry,
    { executionContext: context, eventSink: (event) => events.push(event) },
  );
  assert(outcome.ok);
  assertEquals(events.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'assistant_message',
    'turn_end',
  ]);
  assertEquals(outcome.transcript.map((message) => message.role), [
    'user',
    'assistant',
    'tool',
    'assistant',
  ]);
  assert(JSON.stringify(outcome.transcript).includes('private child task'));
  assert(JSON.stringify(outcome.transcript).includes('private plan'));
});

Deno.test('a second valid call is fixed delegation_limit without child work', async () => {
  let executions = 0;
  const context = new ParentTurnExecutionContext(1);
  const registry = new Registry([tool((_task, child) => {
    executions += 1;
    assert(child.claimModelRequest());
    return { outcome: finalOutcome('task', 'one'), externalRequests: 1 };
  })]);
  const first = await registry.dispatch(delegationCall('first'), context);
  const second = await registry.dispatch(delegationCall('second'), context);
  assertEquals(executions, 1);
  assertEquals(first.content.outcome, 'success');
  assertEquals(
    second.content.text,
    JSON.stringify({
      ok: false,
      agent: 'planner',
      error: {
        code: 'delegation_limit',
        message: 'planner delegation is limited to one execution per turn',
      },
      usage: { modelRequests: 0, externalRequests: 0 },
    }),
  );
  assertEquals(context.snapshot(), { parent: 0, child: 1, aggregate: 1 });
});

Deno.test('invalid then valid calls consume only the valid admission', async () => {
  let executions = 0;
  const context = new ParentTurnExecutionContext(1);
  const registry = new Registry([tool((_task, child) => {
    executions += 1;
    assert(child.claimModelRequest());
    return { outcome: finalOutcome('task', 'ok'), externalRequests: 1 };
  })]);
  const invalid = await registry.dispatch({
    ...delegationCall('invalid'),
    arguments: { task: '' },
  }, context);
  const valid = await registry.dispatch(delegationCall('valid'), context);
  assert(invalid.content.outcome === 'error');
  assertEquals(executions, 1);
  assert(valid.content.text.includes('"ok":true'));
  assertEquals(context.snapshot(), { parent: 0, child: 1, aggregate: 1 });
});

Deno.test('same-context concurrent dispatch admits and executes exactly one child', async () => {
  let resolve!: (value: { outcome: LoopOutcome; externalRequests: number }) => void;
  const delayed = new Promise<{ outcome: LoopOutcome; externalRequests: number }>((done) => {
    resolve = done;
  });
  let executions = 0;
  const context = new ParentTurnExecutionContext(1);
  const registry = new Registry([tool((_task, child) => {
    executions += 1;
    assert(child.claimModelRequest());
    return delayed;
  })]);
  const first = registry.dispatch(delegationCall('first'), context);
  const second = registry.dispatch(delegationCall('second'), context);
  const secondResult = await second;
  assert(secondResult.content.text.includes('"code":"delegation_limit"'));
  resolve({ outcome: finalOutcome('task', 'done'), externalRequests: 1 });
  const firstResult = await first;
  assertEquals(firstResult.content.outcome, 'success');
  assertEquals(executions, 1);
  assertEquals(context.snapshot(), { parent: 0, child: 1, aggregate: 1 });
});

Deno.test('successful terminal JSON maps to a continuing JSON envelope', async () => {
  const context = new ParentTurnExecutionContext(1);
  const registry = new Registry([tool((_task, child) => {
    assert(child.claimModelRequest());
    return {
      outcome: {
        ...finalOutcome('task', '{"b":2,"a":1}'),
        stopReason: 'tool_terminal',
        outcome: 'final',
        terminalKind: 'json_result',
      },
      externalRequests: 1,
    };
  })]);
  const result = await registry.dispatch(delegationCall(), context);
  assertEquals(
    result.content.text,
    JSON.stringify({
      ok: true,
      agent: 'planner',
      output: { kind: 'json', json: '{"b":2,"a":1}' },
      usage: { modelRequests: 1, externalRequests: 1 },
    }),
  );
});

Deno.test('missing context, child failure, and malformed output are sanitized', async () => {
  const missing = await new Registry([tool(() => ({
    outcome: finalOutcome('task', 'should not run'),
    externalRequests: 1,
  }))]).dispatch(delegationCall());
  assertEquals(
    missing.content.text,
    JSON.stringify({
      ok: false,
      agent: 'planner',
      error: { code: 'planner_failed', message: 'planner delegation failed' },
      usage: { modelRequests: 0, externalRequests: 0 },
    }),
  );

  for (
    const outcome of [
      { ...finalOutcome('task', 'bad\0value') },
      { ...finalOutcome('task', '\ud800') },
      { ...finalOutcome('task', 'no output'), finalText: undefined },
      { ...finalOutcome('task', 'wrong'), stopReason: 'max_steps', outcome: 'max_steps' },
    ] as LoopOutcome[]
  ) {
    const context = new ParentTurnExecutionContext(1);
    const registry = new Registry([tool((_task, child) => {
      assert(child.claimModelRequest());
      return { outcome, externalRequests: 0 };
    })]);
    const result = await registry.dispatch(delegationCall(), context);
    const expectedCode = outcome.ok ? 'planner_output_invalid' : 'planner_failed';
    assert(result.content.text.includes(`"code":"${expectedCode}"`));
    assert(!result.content.text.includes('bad'));
  }
});

Deno.test('oversized complete envelope is replaced without truncation', async () => {
  const context = new ParentTurnExecutionContext(1);
  const registry = new Registry([tool((_task, child) => {
    assert(child.claimModelRequest());
    return { outcome: finalOutcome('task', '😀'.repeat(16_384)), externalRequests: 1 };
  })]);
  const result = await registry.dispatch(delegationCall(), context);
  assertEquals(
    result.content.text,
    JSON.stringify({
      ok: false,
      agent: 'planner',
      error: { code: 'planner_output_limit', message: 'planner result exceeds 64 KiB' },
      usage: { modelRequests: 1, externalRequests: 1 },
    }),
  );
  assert(encoder.encode(result.content.text).byteLength <= 65_536);
});

Deno.test('complete success envelope accepts 65,536 bytes and rejects 65,537 bytes', async () => {
  const emptyEnvelope = JSON.stringify({
    ok: true,
    agent: 'planner',
    output: { kind: 'text', text: '' },
    usage: { modelRequests: 1, externalRequests: 0 },
  });
  const exactText = 'x'.repeat(65_536 - encoder.encode(emptyEnvelope).byteLength);
  const exactContext = new ParentTurnExecutionContext(1);
  const exactRegistry = new Registry([tool((_task, child) => {
    assert(child.claimModelRequest());
    return { outcome: finalOutcome('task', exactText), externalRequests: 0 };
  })]);
  const exact = await exactRegistry.dispatch(delegationCall(), exactContext);
  assertEquals(exact.content.outcome, 'success');
  assertEquals(encoder.encode(exact.content.text).byteLength, 65_536);

  const overflowContext = new ParentTurnExecutionContext(1);
  const overflowRegistry = new Registry([tool((_task, child) => {
    assert(child.claimModelRequest());
    return { outcome: finalOutcome('task', `${exactText}x`), externalRequests: 0 };
  })]);
  const overflow = await overflowRegistry.dispatch(delegationCall(), overflowContext);
  assert(overflow.content.text.includes('"code":"planner_output_limit"'));
  assert(encoder.encode(overflow.content.text).byteLength <= 65_536);
});

Deno.test('request lanes enforce 8/8/16 ceilings before a model call', () => {
  const budget = new TurnRequestBudget();
  for (let index = 0; index < 8; index += 1) assert(budget.claim('parent'));
  assert(!budget.claim('parent'));
  for (let index = 0; index < 8; index += 1) assert(budget.claim('child'));
  assert(!budget.claim('child'));
  assert(!budget.claim('parent'));
  assertEquals(budget.snapshot(), { parent: 8, child: 8, aggregate: 16 });
});

Deno.test('loop rejects an exhausted lane before entering the model adapter', async () => {
  const context = new ParentTurnExecutionContext(1);
  for (let index = 0; index < 8; index += 1) assert(context.claimModelRequest());
  const child = context.admitPlannerExecution();
  assert(child !== undefined);
  for (let index = 0; index < 8; index += 1) assert(child.claimModelRequest());
  let modelCalls = 0;
  const outcome = await runAgent(
    'blocked',
    {
      generate: () => {
        modelCalls += 1;
        return { kind: 'final' as const, text: 'must not run' };
      },
    },
    new Registry([]),
    { executionContext: context },
  );
  assert(!outcome.ok);
  assertEquals(outcome.stopReason, 'contract_failure');
  assertEquals(outcome.steps, 0);
  assertEquals(modelCalls, 0);
  assertEquals(context.snapshot(), { parent: 8, child: 8, aggregate: 16 });
});

Deno.test('accepted session turns receive fresh delegation admission and budget', async () => {
  let modelCalls = 0;
  let handlerCalls = 0;
  const contexts: ParentTurnExecutionContext[] = [];
  const registry = new Registry([tool((task, child) => {
    handlerCalls += 1;
    assert(child.claimModelRequest());
    return { outcome: finalOutcome(task, `plan ${handlerCalls}`), externalRequests: 1 };
  })]);
  const session = new AgentSession(
    {
      generate: () => {
        modelCalls += 1;
        return modelCalls % 2 === 1
          ? { kind: 'tool_calls' as const, calls: [delegationCall(`turn-${modelCalls}`)] }
          : { kind: 'final' as const, text: 'parent done' };
      },
    },
    registry,
    {
      createTurnExecutionContext: (turn) => {
        const context = new ParentTurnExecutionContext(turn);
        contexts.push(context);
        return context;
      },
    },
  );
  const first = await session.submit('first');
  const second = await session.submit('second');
  assert(first.ok && second.ok);
  assertEquals(modelCalls, 4);
  assertEquals(handlerCalls, 2);
  assertEquals(contexts.map((context) => context.snapshot()), [
    { parent: 2, child: 1, aggregate: 3 },
    { parent: 2, child: 1, aggregate: 3 },
  ]);
});
