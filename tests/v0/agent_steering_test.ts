import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import { type AgentEvent, EventDeliveryError } from '../../v0/agent/events.ts';
import { type Message, type ModelRequest, type ModelResult } from '../../v0/agent/contracts.ts';
import { CancellationCleanupError, TurnCancellationOwner } from '../../v0/agent/cancellation.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { runAgentTurn } from '../../v0/agent/loop.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { MAX_STEERING_TEXT_BYTES, SteeringOwner } from '../../v0/agent/steering.ts';
import {
  encodeSessionRecord,
  parseCausalTranscript,
  type SessionRecord,
  validateSessionRecord,
} from '../../v0/agent/session_store.ts';
import { Registry } from '../../v0/agent/tools.ts';

const call = (callId: string, name = 'continue') => ({
  callId,
  name,
  arguments: {},
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => resolve = resolvePromise);
  return { promise, resolve };
};

const admittedSteering = (text: string): SteeringOwner => {
  const owner = new SteeringOwner();
  assertEquals(owner.admit(text), 'accepted');
  return owner;
};

Deno.test('steering owner enforces one admission and exact validation boundaries', () => {
  const owner = new SteeringOwner();
  assertEquals(owner.admit('  correction  '), 'accepted');
  assertEquals(owner.state, 'pending');
  assertEquals(owner.admit('second'), 'already_accepted');
  assertEquals(owner.consume(), '  correction  ');
  assertEquals(owner.consume(), undefined);
  assertEquals(owner.state, 'consumed');
  assertEquals(owner.admit('third'), 'already_accepted');
  owner.close();
  assertEquals(owner.state, 'closed');
  const closed = new SteeringOwner();
  closed.close();
  assertEquals(closed.admit('text'), 'idle');

  for (
    const [value, message] of [
      ['', 'steering text must not be blank'],
      [' \t\n', 'steering text must not be blank'],
      ['nul\0text', 'steering text must not contain NUL'],
      ['\ud800', 'steering text must be well-formed Unicode'],
      ['\udc00', 'steering text must be well-formed Unicode'],
      ['x'.repeat(MAX_STEERING_TEXT_BYTES + 1), 'steering text exceeds 65536 UTF-8 bytes'],
    ] as const
  ) {
    const fresh = new SteeringOwner();
    let actual = '';
    try {
      fresh.admit(value);
    } catch (error) {
      actual = error instanceof Error ? error.message : String(error);
    }
    assertEquals(actual, message);
    assertEquals(fresh.state, 'open-empty');
  }
  assertEquals(new SteeringOwner().admit('😀'.repeat(16_384)), 'accepted');
});

Deno.test('loop injects one steering message only after a complete nonterminal tool batch', async () => {
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const gate = deferred<ModelResult>();
  let generated = 0;
  const model = {
    generate(request: ModelRequest) {
      requests.push(request);
      generated += 1;
      if (generated === 1) return { kind: 'tool_calls' as const, calls: [call('one')] };
      if (generated === 2) return gate.promise;
      return { kind: 'final' as const, text: 'done' };
    },
  };
  const registry = new Registry([{
    name: 'continue',
    description: 'continue',
    inputSchema: {},
    execute: () => 'tool complete',
  }]);
  const owner = new SteeringOwner();
  const running = runAgentTurn('task', [], model, registry, {
    eventSink: (event) => {
      events.push(event);
      if (event.kind === 'tool_result') assertEquals(owner.admit('steer now'), 'accepted');
    },
    steering: owner,
  });
  gate.resolve({ kind: 'final', text: 'done' });
  const result = await running;
  assert(result.ok);
  assertEquals(requests.map((request) => request.transcript), [
    [{ role: 'user', content: { kind: 'text', text: 'task' } }],
    [
      { role: 'user', content: { kind: 'text', text: 'task' } },
      {
        role: 'assistant',
        content: [{ kind: 'tool_call', ...call('one') }],
      },
      {
        role: 'tool',
        content: [{
          kind: 'tool_result',
          callId: 'one',
          name: 'continue',
          text: 'tool complete',
          outcome: 'success',
        }],
      },
      { role: 'user', content: { kind: 'text', text: 'steer now' } },
    ],
  ]);
  assertEquals(events.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'steering_message',
    'assistant_message',
    'turn_end',
  ]);
  assertEquals((events[5] as Extract<AgentEvent, { kind: 'steering_message' }>).turn, 1);
  assertEquals(result.steps, 2);
  assertEquals(result.toolCallCount, 1);
  assertEquals(result.toolResultCount, 1);
});

Deno.test('session admits steering during an active turn and commits it as ordinary user text', async () => {
  const secondRequest = deferred<ModelResult>();
  const requests: ModelRequest[] = [];
  let generated = 0;
  const sessionRef: { value?: AgentSession } = {};
  const session = new AgentSession(
    {
      generate(request) {
        requests.push(request);
        generated += 1;
        if (generated === 1) {
          return {
            kind: 'tool_calls' as const,
            calls: [{ callId: 'one', name: 'continue', arguments: { value: 1 } }],
          };
        }
        if (generated === 2) return secondRequest.promise;
        return { kind: 'final' as const, text: 'finished' };
      },
    },
    new Registry([{
      name: 'continue',
      description: 'continue',
      inputSchema: {},
      execute: () => 'complete',
    }]),
    {
      eventSink(event) {
        if (event.kind === 'tool_result') {
          assert(sessionRef.value !== undefined);
          assertEquals(sessionRef.value.steerActiveTurn('fix'), 'accepted');
        }
      },
    },
  );
  sessionRef.value = session;
  const running = session.submit('initial');
  while (generated < 2) await Promise.resolve();
  assertEquals(session.steerActiveTurn('again'), 'already_accepted');
  secondRequest.resolve({ kind: 'final', text: 'finished' });
  const result = await running;
  assert(result.ok);
  assertEquals(session.transcriptSnapshot().map((message) => message.role), [
    'user',
    'assistant',
    'tool',
    'user',
    'assistant',
  ]);
  assertEquals(requests[1].transcript.at(-1), {
    role: 'user',
    content: { kind: 'text', text: 'fix' },
  });
  assertEquals(session.steerActiveTurn('later'), 'idle');
});

Deno.test('schema-v1 derives nextTurn from completed parent turns with one legal steering user', () => {
  const transcript: Message[] = [
    { role: 'user', content: { kind: 'text', text: 'one' } },
    {
      role: 'assistant',
      content: [{ kind: 'tool_call', ...call('one') }],
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'one',
        name: 'continue',
        text: 'ok',
        outcome: 'success',
      }],
    },
    { role: 'user', content: { kind: 'text', text: 'steer' } },
    { role: 'assistant', content: { kind: 'text', text: 'done' } },
    { role: 'user', content: { kind: 'text', text: 'two' } },
    { role: 'assistant', content: { kind: 'text', text: 'done2' } },
  ];
  assertEquals(parseCausalTranscript(transcript), 2);
  const record: SessionRecord = {
    schemaVersion: 1,
    sessionId: '11111111-1111-4111-8111-111111111111',
    workspaceRoot: '/workspace',
    agent: 'default',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:01.000Z',
    nextTurn: 3,
    transcript,
  };
  assert(validateSessionRecord(record));
  assertEquals(
    new TextDecoder().decode(encodeSessionRecord(record)),
    JSON.stringify(record) + '\n',
  );
  assertEquals(parseCausalTranscript(transcript.slice(0, 3)), undefined);
  assertEquals(
    parseCausalTranscript([
      ...transcript.slice(0, 5),
      { role: 'user', content: { kind: 'text', text: 'second steer' } },
    ]),
    undefined,
  );
});

Deno.test('final, terminal, max-step, model, cancellation, event, and cleanup paths close steering', async () => {
  const registry = new Registry([{
    name: 'continue',
    description: 'continue',
    inputSchema: {},
    execute: () => 'continued',
  }]);
  const terminalRegistry = new Registry([{
    name: 'terminal',
    description: 'terminal',
    inputSchema: {},
    terminal: true,
    execute: () => ({
      kind: 'terminate' as const,
      text: 'terminal result',
      finalText: '{"ok":true}',
      terminalKind: 'json_result' as const,
    }),
  }]);
  const admitted = (value: string): SteeringOwner => {
    const owner = new SteeringOwner();
    assertEquals(owner.admit(value), 'accepted');
    return owner;
  };

  const finalOwner = admitted('discarded final');
  const final = await runAgentTurn(
    'final',
    [],
    { generate: () => ({ kind: 'final' as const, text: 'done' }) },
    registry,
    { steering: finalOwner },
  );
  assertEquals(final.stopReason, 'final');
  assertEquals(finalOwner.state, 'closed');

  const terminalOwner = admitted('discarded terminal');
  const terminal = await runAgentTurn(
    'terminal',
    [],
    { generate: () => ({ kind: 'tool_calls' as const, calls: [call('terminal', 'terminal')] }) },
    terminalRegistry,
    { steering: terminalOwner },
  );
  assertEquals(terminal.stopReason, 'tool_terminal');
  assertEquals(terminalOwner.state, 'closed');

  const maxOwner = admitted('discarded max');
  const max = await runAgentTurn(
    'max',
    [],
    { generate: () => ({ kind: 'tool_calls' as const, calls: [call('max')] }) },
    registry,
    { maxSteps: 1, steering: maxOwner },
  );
  assertEquals(max.stopReason, 'max_steps');
  assertEquals(maxOwner.state, 'closed');

  const failureOwner = admitted('discarded failure');
  const failure = await runAgentTurn(
    'failure',
    [],
    {
      generate: () => {
        throw new Error('model failure');
      },
    },
    registry,
    { steering: failureOwner },
  );
  assertEquals(failure.stopReason, 'contract_failure');
  assertEquals(failureOwner.state, 'closed');

  const cancellation = new TurnCancellationOwner();
  cancellation.request();
  const cancelledOwner = admitted('discarded before cancellation');
  const cancelled = await runAgentTurn(
    'cancelled',
    [],
    { generate: () => ({ kind: 'final' as const, text: 'not requested' }) },
    registry,
    { cancellation, steering: cancelledOwner },
  );
  assertEquals(cancelled.stopReason, 'cancelled');
  assertEquals(cancelledOwner.state, 'closed');

  const eventOwner = admitted('discarded event failure');
  let eventRequests = 0;
  const eventResult = runAgentTurn(
    'event failure',
    [],
    {
      generate: () => {
        eventRequests += 1;
        return { kind: 'tool_calls' as const, calls: [call('event')] };
      },
    },
    registry,
    {
      steering: eventOwner,
      eventSink: (event) => {
        if (event.kind === 'steering_message') throw new EventDeliveryError();
      },
    },
  );
  await assertRejects(() => eventResult);
  assertEquals(eventRequests, 1);
  assertEquals(eventOwner.state, 'closed');

  const cleanupOwner = admitted('discarded cleanup');
  const cleanup = await runAgentTurn(
    'cleanup',
    [],
    {
      generate: () => {
        throw new CancellationCleanupError();
      },
    },
    registry,
    { steering: cleanupOwner },
  );
  assertEquals(cleanup.stopReason, 'contract_failure');
  assertEquals(cleanupOwner.state, 'closed');
});

Deno.test('cancellation after steering consumption rolls back the draft and starts no next request', async () => {
  const owner = admittedSteering('cancel after consumption');
  const cancellation = new TurnCancellationOwner();
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  let committed = 0;
  const result = await runAgentTurn(
    'cancel after',
    [],
    {
      generate(request) {
        requests.push(request);
        return { kind: 'tool_calls' as const, calls: [call('one')] };
      },
    },
    new Registry([{
      name: 'continue',
      description: 'continue',
      inputSchema: {},
      execute: () => 'complete',
    }]),
    {
      cancellation,
      steering: owner,
      commit: () => committed += 1,
      eventSink(event) {
        events.push(event);
        if (event.kind === 'tool_result') assertEquals(owner.state, 'pending');
        if (event.kind === 'steering_message') cancellation.request();
      },
    },
  );
  assertEquals(result.stopReason, 'cancelled');
  assertEquals(requests.length, 1);
  assertEquals(committed, 0);
  assertEquals(events.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'steering_message',
    'turn_end',
  ]);
  assertEquals(owner.state, 'closed');
});

Deno.test('planner child stays private while steering waits for the complete parent batch and budgets remain 8/8/16', async () => {
  const owner = new SteeringOwner();
  const childGate = deferred<void>();
  const context = new ParentTurnExecutionContext(1);
  let childSawSteering = false;
  const registry = new Registry([
    createPlannerDelegationTool(async (_task, child) => {
      childSawSteering = Object.hasOwn(child, 'steering');
      assert(child.claimModelRequest());
      assertEquals(owner.admit('while child runs'), 'accepted');
      await childGate.promise;
      return {
        outcome: {
          ok: true,
          task: 'planner task',
          outcome: 'final' as const,
          stopReason: 'final' as const,
          finalText: 'child result',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
        externalRequests: 1,
      };
    }),
    {
      name: 'continue',
      description: 'continue',
      inputSchema: {},
      execute: () => 'parent batch complete',
    },
  ]);
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  let generated = 0;
  const running = runAgentTurn(
    'parent task',
    [],
    {
      generate(request) {
        requests.push(request);
        generated += 1;
        return generated === 1
          ? {
            kind: 'tool_calls' as const,
            calls: [
              {
                callId: 'delegate',
                name: 'delegate_to_planner',
                arguments: { task: 'planner task' },
              },
              call('second'),
            ],
          }
          : { kind: 'final' as const, text: 'parent result' };
      },
    },
    registry,
    { executionContext: context, steering: owner, eventSink: (event) => events.push(event) },
  );
  while (context.snapshot().child < 1) await Promise.resolve();
  assertEquals(owner.state, 'pending');
  assertEquals(events.some((event) => event.kind === 'steering_message'), false);
  childGate.resolve();
  const result = await running;
  assert(result.ok);
  assertEquals(childSawSteering, false);
  assertEquals(context.snapshot(), { parent: 2, child: 1, aggregate: 3 });
  assertEquals(requests[1].transcript.at(-1), {
    role: 'user',
    content: { kind: 'text', text: 'while child runs' },
  });
  assertEquals(events.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
    'steering_message',
    'assistant_message',
    'turn_end',
  ]);
});
