import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import { type AgentEvent, EventDeliveryError } from '../../v0/agent/events.ts';
import {
  MAX_TOOL_PROGRESS_TEXT_BYTES,
  MAX_TOOL_PROGRESS_UPDATES_PER_CALL,
} from '../../v0/agent/execution_context.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { runAgentTurn } from '../../v0/agent/loop.ts';
import { CancellationCleanupError, TurnCancelledError } from '../../v0/agent/cancellation.ts';
import { Registry, type Tool } from '../../v0/agent/tools.ts';
import type { ModelRequest, ToolCall } from '../../v0/agent/contracts.ts';

const call = (callId: string, name = 'progress'): ToolCall => ({
  callId,
  name,
  arguments: {},
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => resolve = resolvePromise);
  return { promise, resolve };
};

const eventKinds = (events: readonly AgentEvent[]): readonly string[] =>
  events.map((event) => event.kind);

const progressEvents = (events: readonly AgentEvent[]) =>
  events.filter((event): event is Extract<AgentEvent, { kind: 'tool_progress' }> =>
    event.kind === 'tool_progress'
  );

Deno.test('progress is accumulated, correlated, ordered, and isolated for two calls and turns', async () => {
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const retained: (() => void)[] = [];
  let executeCount = 0;
  const tool: Tool = {
    name: 'progress',
    description: 'progress',
    inputSchema: {},
    execute(_arguments, context) {
      executeCount += 1;
      const report = context && 'reportProgress' in context ? context.reportProgress : undefined;
      assert(report !== undefined);
      const suffix = executeCount === 1 ? 'a' : 'x';
      report(suffix);
      report(suffix + suffix);
      retained.push(() => report('late'));
      return 'result';
    },
  };
  const session = new AgentSession(
    {
      generate(request) {
        requests.push(request);
        return requests.length % 2 === 1
          ? {
            kind: 'tool_calls' as const,
            calls: [call(`call-${requests.length}-a`), call(`call-${requests.length}-b`)],
          }
          : { kind: 'final' as const, text: 'done' };
      },
    },
    new Registry([tool]),
    { eventSink: (event) => events.push(event) },
  );

  const first = await session.submit('first');
  assert(first.ok);
  retained[0]();
  const second = await session.submit('second');
  assert(second.ok);
  retained[1]();
  assertEquals(eventKinds(events), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_progress',
    'tool_progress',
    'tool_result',
    'tool_call',
    'tool_progress',
    'tool_progress',
    'tool_result',
    'assistant_message',
    'turn_end',
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_progress',
    'tool_progress',
    'tool_result',
    'tool_call',
    'tool_progress',
    'tool_progress',
    'tool_result',
    'assistant_message',
    'turn_end',
  ]);
  assertEquals(
    progressEvents(events).map((event) => [event.turn, event.callId, event.name, event.text]),
    [
      [1, 'call-1-a', 'progress', 'a'],
      [1, 'call-1-a', 'progress', 'aa'],
      [1, 'call-1-b', 'progress', 'x'],
      [1, 'call-1-b', 'progress', 'xx'],
      [2, 'call-3-a', 'progress', 'x'],
      [2, 'call-3-a', 'progress', 'xx'],
      [2, 'call-3-b', 'progress', 'x'],
      [2, 'call-3-b', 'progress', 'xx'],
    ],
  );
  assertEquals(first.toolCallCount, 2);
  assertEquals(first.toolResultCount, 2);
  assertEquals(requests.length, 4);
  assertEquals(session.transcriptSnapshot().filter((message) => message.role === 'tool').length, 2);
});

Deno.test('invalid, exact-boundary, and over-count snapshots have no effect on the tool result', async () => {
  const events: AgentEvent[] = [];
  const tool: Tool = {
    name: 'progress',
    description: 'progress',
    inputSchema: {},
    execute(_arguments, context) {
      const report = context && 'reportProgress' in context ? context.reportProgress : undefined;
      assert(report !== undefined);
      report('');
      report('\ud800');
      report('x'.repeat(MAX_TOOL_PROGRESS_TEXT_BYTES + 1));
      report('x'.repeat(MAX_TOOL_PROGRESS_TEXT_BYTES));
      for (let index = 0; index < MAX_TOOL_PROGRESS_UPDATES_PER_CALL + 1; index += 1) {
        report(`update-${index}`);
      }
      return 'authoritative result';
    },
  };
  const result = await runAgentTurn(
    'bounds',
    [],
    {
      generate: (request) =>
        request.transcript.length === 1
          ? { kind: 'tool_calls' as const, calls: [call('bounds')] }
          : { kind: 'final' as const, text: 'finished' },
    },
    new Registry([tool]),
    { eventSink: (event) => events.push(event) },
  );
  assert(result.ok);
  assertEquals(result.toolCallCount, 1);
  assertEquals(result.toolResultCount, 1);
  assertEquals(progressEvents(events).length, MAX_TOOL_PROGRESS_UPDATES_PER_CALL);
  assertEquals(progressEvents(events)[0].text, 'x'.repeat(MAX_TOOL_PROGRESS_TEXT_BYTES));
  assertEquals(progressEvents(events).at(-1)?.text, 'update-62');
  assertEquals(result.transcript.at(-1), {
    role: 'assistant',
    content: { kind: 'text', text: 'finished' },
  });
});

Deno.test('progress event mutation cannot alter dispatch, later events, result, or transcript', async () => {
  let dispatched: unknown;
  const events: AgentEvent[] = [];
  const tool: Tool = {
    name: 'progress',
    description: 'progress',
    inputSchema: {},
    execute(argumentsValue, context) {
      dispatched = argumentsValue;
      const report = context && 'reportProgress' in context ? context.reportProgress : undefined;
      assert(report !== undefined);
      report('original');
      return 'result';
    },
  };
  const outcome = await runAgentTurn(
    'mutation',
    [],
    {
      generate: (request) =>
        request.transcript.length === 1
          ? {
            kind: 'tool_calls' as const,
            calls: [{
              callId: 'mutate',
              name: 'progress',
              arguments: { nested: { value: 'keep' } },
            }],
          }
          : { kind: 'final' as const, text: 'done' },
    },
    new Registry([tool]),
    {
      eventSink(event) {
        events.push(event);
        if (event.kind === 'tool_progress') {
          (event as { text: string }).text = 'changed';
        }
      },
    },
  );
  assert(outcome.ok);
  assertEquals(dispatched, { nested: { value: 'keep' } });
  assertEquals(
    events.filter((event) => event.kind === 'tool_progress').map((event) => event.text),
    ['changed'],
  );
  assertEquals(outcome.transcript[2], {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'mutate',
      name: 'progress',
      text: 'result',
      outcome: 'success',
    }],
  });
});

Deno.test('one-shot no-sink execution omits the progress reporter and keeps final-only output', async () => {
  let contextPresent = false;
  let contextHasReporter = false;
  const tool: Tool = {
    name: 'progress',
    description: 'progress',
    inputSchema: {},
    execute(_arguments, context) {
      contextPresent = context !== undefined;
      contextHasReporter = context !== undefined && 'reportProgress' in context;
      return 'authoritative result';
    },
  };
  const result = await runAgentTurn(
    'no sink',
    [],
    {
      generate: (request) =>
        request.transcript.length === 1
          ? { kind: 'tool_calls' as const, calls: [call('no-sink')] }
          : { kind: 'final' as const, text: 'finished' },
    },
    new Registry([tool]),
  );
  assert(result.ok);
  assertEquals(contextPresent, false);
  assertEquals(contextHasReporter, false);
  assertEquals(result.toolCallCount, 1);
  assertEquals(result.toolResultCount, 1);
  assertEquals(result.finalText, 'finished');
});

Deno.test('cancellation after one snapshot suppresses later progress and result', async () => {
  const events: AgentEvent[] = [];
  const tool: Tool = {
    name: 'progress',
    description: 'progress',
    inputSchema: {},
    execute(_arguments, context) {
      const report = context && 'reportProgress' in context ? context.reportProgress : undefined;
      assert(report !== undefined);
      report('before cancellation');
      context?.cancellation?.request();
      report('after cancellation');
      throw new TurnCancelledError();
    },
  };
  const session = new AgentSession(
    { generate: () => ({ kind: 'tool_calls' as const, calls: [call('cancel')] }) },
    new Registry([tool]),
    { eventSink: (event) => events.push(event) },
  );
  const result = await session.submit('cancel');
  assertEquals(result.stopReason, 'cancelled');
  assertEquals(progressEvents(events).map((event) => event.text), ['before cancellation']);
  assertEquals(events.filter((event) => event.kind === 'tool_result').length, 0);
  assertEquals(result.toolCallCount, 1);
  assertEquals(result.toolResultCount, 0);
  assertEquals(session.transcriptSnapshot(), []);
});

Deno.test('progress sink failure is latched, cancellation is requested, and tool settlement precedes rejection', async () => {
  const events: AgentEvent[] = [];
  const gate = deferred<'settled'>();
  let caught: unknown;
  let settled = false;
  const tool: Tool = {
    name: 'progress',
    description: 'progress',
    inputSchema: {},
    async execute(_arguments, context) {
      const report = context && 'reportProgress' in context ? context.reportProgress : undefined;
      assert(report !== undefined);
      try {
        report('will fail');
      } catch (error) {
        caught = error;
      }
      await gate.promise;
      settled = true;
      return 'must not surface';
    },
  };
  const session = new AgentSession(
    { generate: () => ({ kind: 'tool_calls' as const, calls: [call('failure')] }) },
    new Registry([tool]),
    {
      eventSink(event) {
        events.push(event);
        if (event.kind === 'tool_progress') throw new Error('sink failure');
      },
    },
  );
  const pending = session.submit('sink failure');
  await Promise.resolve();
  await Promise.resolve();
  assert(!settled);
  assertEquals(session.cancelActiveTurn(), 'already_requested');
  gate.resolve('settled');
  let error: unknown;
  try {
    await pending;
  } catch (caughtError) {
    error = caughtError;
  }
  assert(settled);
  assert(caught instanceof EventDeliveryError);
  assert(error instanceof EventDeliveryError);
  assertEquals(eventKinds(events), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_progress',
  ]);
  assertEquals(session.transcriptSnapshot(), []);
});

Deno.test('progress sink failure keeps outward error while cleanup failure poisons the session', async () => {
  const events: AgentEvent[] = [];
  const gate = deferred<'cleanup'>();
  const tool: Tool = {
    name: 'progress',
    description: 'progress',
    inputSchema: {},
    async execute(_arguments, context) {
      const report = context && 'reportProgress' in context ? context.reportProgress : undefined;
      assert(report !== undefined);
      try {
        report('will fail');
      } catch {
        // The tool intentionally swallows the callback exception; the loop latch remains active.
      }
      await gate.promise;
      throw new CancellationCleanupError();
    },
  };
  const session = new AgentSession(
    { generate: () => ({ kind: 'tool_calls' as const, calls: [call('poison')] }) },
    new Registry([tool]),
    {
      eventSink(event) {
        events.push(event);
        if (event.kind === 'tool_progress') throw new Error('sink failure');
      },
    },
  );
  const pending = session.submit('poison');
  await Promise.resolve();
  await Promise.resolve();
  gate.resolve('cleanup');
  let error: unknown;
  try {
    await pending;
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof EventDeliveryError);
  assertEquals(eventKinds(events), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_progress',
  ]);
  await assertRejects(() => session.submit('unavailable'));
});
