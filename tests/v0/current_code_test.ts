import * as agentCli from '../../v0/agent/cli.ts';
import * as mainCli from '../../v0/cli/main.ts';
import type { LoopOutcome, ModelRequest, ToolCall } from '../../v0/agent/contracts.ts';
import type { AgentEvent } from '../../v0/agent/events.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { createJsonResultSubmissionTool, Registry } from '../../v0/agent/tools.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const delegationCall = (): ToolCall => ({
  callId: 'delegate-1',
  name: 'delegate_to_planner',
  arguments: { task: 'make a plan' },
});

Deno.test('public CLI API exposes only the intended runtime entry points', () => {
  assertEquals(Object.keys(agentCli).sort(), ['main']);
  assertEquals(Object.keys(mainCli).sort(), ['defaultStateDirFor', 'main']);
});

Deno.test('agent loop completes plain and terminal-tool turns', async () => {
  const plain = await runAgent(
    'plain',
    { generate: () => ({ kind: 'final', text: 'done' }) },
    new Registry([]),
  );
  assert(plain.ok);
  assertEquals({ stop: plain.stopReason, text: plain.finalText, steps: plain.steps }, {
    stop: 'final',
    text: 'done',
    steps: 1,
  });

  let requests = 0;
  const terminal = await runAgent(
    'json',
    {
      generate: () => {
        requests += 1;
        return {
          kind: 'tool_calls' as const,
          calls: [{
            callId: 'submit-1',
            name: 'submit_json_result',
            arguments: { json: '{"ok":true}' },
          }],
        };
      },
    },
    new Registry([createJsonResultSubmissionTool()]),
  );
  assert(terminal.ok);
  assertEquals(
    { requests, stop: terminal.stopReason, text: terminal.finalText },
    { requests: 1, stop: 'tool_terminal', text: '{"ok":true}' },
  );
});

Deno.test('session commits turns and reports occurrence-bound request counts', async () => {
  let requests = 0;
  const seen: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    {
      generate: (request) => {
        requests += 1;
        seen.push(request);
        return { kind: 'final', text: `answer-${requests}` };
      },
    },
    new Registry([]),
    {
      providerRequestCount: () => requests,
      eventSink: (event) => events.push(event),
    },
  );

  const first = await session.submit('one');
  const second = await session.submit('two');
  assert(first.ok && second.ok);
  assertEquals(seen[1].transcript.map((message) => message.role), [
    'user',
    'assistant',
    'user',
  ]);
  assertEquals(
    [first.turnProviderRequestCount, first.runtimeProviderRequestCount],
    [1, 1],
  );
  assertEquals(
    [second.turnProviderRequestCount, second.runtimeProviderRequestCount],
    [1, 2],
  );
  const ends = events.filter((event) => event.kind === 'turn_end');
  assertEquals(ends.map((event) => event.committed), [true, true]);
});

Deno.test('max-step failure is diagnosed and not committed', async () => {
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    {
      generate: () => ({
        kind: 'tool_calls',
        calls: [{ callId: 'again', name: 'again', arguments: {} }],
      }),
    },
    new Registry([{
      name: 'again',
      description: 'continue',
      inputSchema: {},
      execute: () => 'again',
    }]),
    { maxSteps: 1, eventSink: (event) => events.push(event) },
  );
  const result = await session.submit('bounded');
  assert(!result.ok);
  assertEquals(
    { stop: result.stopReason, stage: result.diagnostic?.stage, code: result.diagnostic?.code },
    { stop: 'max_steps', stage: 'turn_control', code: 'model_step_limit' },
  );
  assertEquals(session.transcriptSnapshot(), []);
  const end = events.at(-1);
  assert(end?.kind === 'turn_end');
  assertEquals(end.committed, false);
});

Deno.test('planner delegation succeeds once and child failure stops the parent immediately', async () => {
  const successContext = new ParentTurnExecutionContext(1);
  const successTool = createPlannerDelegationTool((_task, child) => {
    assert(child.claimModelRequest());
    return {
      externalRequests: 1,
      outcome: {
        ok: true,
        task: 'make a plan',
        outcome: 'final',
        stopReason: 'final',
        finalText: 'child plan',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
    };
  });
  const success = await new Registry([successTool]).dispatch(delegationCall(), successContext);
  assertEquals(success.content.outcome, 'success');
  assert(success.content.text.includes('child plan'));

  let parentRequests = 0;
  const failure: LoopOutcome = {
    ok: false,
    task: 'make a plan',
    outcome: 'contract_failure',
    stopReason: 'contract_failure',
    error: 'child failed',
    steps: 1,
    toolCallCount: 0,
    toolResultCount: 0,
    transcript: [],
  };
  const failedParent = await runAgent(
    'parent',
    {
      generate: () => {
        parentRequests += 1;
        if (parentRequests > 1) throw new Error('parent continued after child failure');
        return { kind: 'tool_calls', calls: [delegationCall()] };
      },
    },
    new Registry([createPlannerDelegationTool(() => ({
      externalRequests: 1,
      outcome: failure,
    }))]),
    { executionContext: new ParentTurnExecutionContext(1) },
  );
  assert(!failedParent.ok);
  assertEquals(
    { requests: parentRequests, stop: failedParent.stopReason },
    { requests: 1, stop: 'contract_failure' },
  );
});

Deno.test('retained UI records exact per-turn and runtime request counts once', () => {
  const event = {
    kind: 'turn_end' as const,
    turn: 2,
    outcome: 'final' as const,
    committed: true,
    turnProviderRequestCount: 3,
    runtimeProviderRequestCount: 7,
  };
  const first = reduceUiEvent(createUiState(), event);
  const second = reduceUiEvent(first, event);
  assertEquals(first.log.entries, [{
    id: 'turn-2:requests',
    kind: 'system',
    label: 'requests>',
    text: 'turn=2 · actual=3 · runtime=7',
    revision: 0,
    live: false,
    turn: 2,
  }]);
  assertEquals(second.log.entries, first.log.entries);
});
