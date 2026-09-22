import { main as runtimeMain } from '../../v0/agent/cli/runtime_cli.ts';
import { CliRunEventProjector } from '../../v0/agent/cli/run_events.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import type { LoopOutcome } from '../../v0/agent/core/contracts.ts';

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

const successOutcome = (task: string, finalText: string): LoopOutcome => ({
  ok: true,
  task,
  outcome: 'final',
  stopReason: 'final',
  finalText,
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

const recorder = () => {
  const state = { stdout: '', stderr: '' };
  return {
    state,
    deps: {
      stdinIsTerminal: () => true,
      writeStdout: (text: string) => {
        state.stdout += text;
      },
      writeStderr: (text: string) => {
        state.stderr += text;
      },
    },
  };
};

const emitRun = (
  events: readonly AgentEvent[],
  outcome: LoopOutcome,
) =>
(task: string, _selection: unknown, sink?: (event: AgentEvent) => void) => {
  void task;
  for (const event of events) sink?.(event);
  return Promise.resolve({ outcome, requestCount: 1 });
};

const lines = (text: string): unknown[] =>
  text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));

Deno.test('Increment 104 projector derives deltas, resets per step, and drops provider state', () => {
  const projector = new CliRunEventProjector();
  const events: AgentEvent[] = [
    { kind: 'turn_start', turn: 1 },
    {
      kind: 'user_message',
      turn: 1,
      message: { role: 'user', content: { kind: 'text', text: 'hi' } },
    },
    { kind: 'assistant_progress', turn: 1, text: 'hel' },
    { kind: 'assistant_progress', turn: 1, text: 'hello' },
    { kind: 'tool_call', turn: 1, call: { callId: 'c1', name: 'read', arguments: { path: 'x' } } },
    {
      kind: 'tool_result',
      turn: 1,
      result: { kind: 'tool_result', callId: 'c1', name: 'read', text: 'body', outcome: 'success' },
    },
    { kind: 'assistant_progress', turn: 1, text: 'done' },
    {
      kind: 'assistant_message',
      turn: 1,
      message: {
        role: 'assistant',
        content: { kind: 'text', text: 'done' },
        providerState: { provider: 'openrouter-chat', reasoningDetails: [{ secret: 'x' }] },
      },
    },
    { kind: 'turn_end', turn: 1, outcome: 'final', committed: true },
  ];
  const projected = events.flatMap((event) => projector.project(event));
  assertEquals(projected, [
    { kind: 'turn_start', turn: 1 },
    { kind: 'user_message', turn: 1, text: 'hi' },
    { kind: 'assistant_delta', turn: 1, text: 'hel' },
    { kind: 'assistant_delta', turn: 1, text: 'lo' },
    { kind: 'tool_call', turn: 1, callId: 'c1', name: 'read', arguments: { path: 'x' } },
    { kind: 'tool_result', turn: 1, callId: 'c1', name: 'read', outcome: 'success', text: 'body' },
    { kind: 'assistant_delta', turn: 1, text: 'done' },
    { kind: 'assistant_message', turn: 1, text: 'done' },
  ]);
  assert(projector.wasCommitted);
  assert(!JSON.stringify(projected).includes('reasoningDetails'));
  assert(!JSON.stringify(projected).includes('secret'));
});

Deno.test('Increment 104 --json emits curated NDJSON events and a result line', async () => {
  const { state, deps } = recorder();
  const events: AgentEvent[] = [
    { kind: 'turn_start', turn: 1 },
    {
      kind: 'user_message',
      turn: 1,
      message: { role: 'user', content: { kind: 'text', text: 'hi' } },
    },
    { kind: 'assistant_progress', turn: 1, text: 'hello' },
    {
      kind: 'assistant_message',
      turn: 1,
      message: {
        role: 'assistant',
        content: { kind: 'text', text: 'hello' },
        providerState: { provider: 'openrouter-chat', reasoningDetails: [{ secret: 'x' }] },
      },
    },
    { kind: 'turn_end', turn: 1, outcome: 'final', committed: false },
  ];
  const exit = await runtimeMain(['--task', 'hi', '--json'], {
    ...deps,
    run: emitRun(events, successOutcome('hi', 'hello')),
  });
  assertEquals(exit, 0);
  assertEquals(state.stderr, '');
  const parsed = lines(state.stdout) as Record<string, unknown>[];
  assertEquals(parsed.map((record) => record.kind), [
    'turn_start',
    'user_message',
    'assistant_delta',
    'assistant_message',
    'result',
  ]);
  assert(parsed.every((record) => record.v === 1));
  const result = parsed.at(-1)!;
  assertEquals(result.ok, true);
  assertEquals(result.finalText, 'hello');
  assertEquals(result.committed, false);
  assert(!state.stdout.includes('providerState'));
  assert(!state.stdout.includes('reasoningDetails'));
});

Deno.test('Increment 104 --stream writes assistant text to stdout and tool activity to stderr', async () => {
  const { state, deps } = recorder();
  const events: AgentEvent[] = [
    { kind: 'turn_start', turn: 1 },
    { kind: 'assistant_progress', turn: 1, text: 'hel' },
    { kind: 'assistant_progress', turn: 1, text: 'hello' },
    { kind: 'tool_call', turn: 1, call: { callId: 'c1', name: 'read', arguments: { path: 'x' } } },
    {
      kind: 'tool_result',
      turn: 1,
      result: { kind: 'tool_result', callId: 'c1', name: 'read', text: 'body', outcome: 'success' },
    },
    { kind: 'turn_end', turn: 1, outcome: 'final', committed: false },
  ];
  const exit = await runtimeMain(['--task', 'hi', '--stream'], {
    ...deps,
    run: emitRun(events, successOutcome('hi', 'hello')),
  });
  assertEquals(exit, 0);
  assertEquals(state.stdout, 'hello');
  assert(state.stderr.includes('tool> read'));
  assert(state.stderr.includes('tool< read success'));
});

Deno.test('Increment 104 --stream falls back to final text without progress', async () => {
  const { state, deps } = recorder();
  const exit = await runtimeMain(['--task', 'hi', '--stream'], {
    ...deps,
    run: emitRun([{ kind: 'turn_start', turn: 1 }], successOutcome('hi', 'answer')),
  });
  assertEquals(exit, 0);
  assertEquals(state.stdout, 'answer\n');
});

Deno.test('Increment 104 default run stays final-only and unchanged', async () => {
  const { state, deps } = recorder();
  const exit = await runtimeMain(['--task', 'hi'], {
    ...deps,
    run: emitRun(
      [{ kind: 'turn_start', turn: 1 }, { kind: 'assistant_progress', turn: 1, text: 'x' }],
      successOutcome('hi', 'answer'),
    ),
  });
  assertEquals(exit, 0);
  assertEquals(state.stdout, 'answer\n');
  assertEquals(state.stderr, '');
});

Deno.test('Increment 104 rejects --json with --stream', async () => {
  const { state, deps } = recorder();
  const exit = await runtimeMain(['--task', 'hi', '--json', '--stream'], {
    ...deps,
    run: emitRun([], successOutcome('hi', 'answer')),
  });
  assertEquals(exit, 1);
  assertEquals(state.stdout, '');
  assertEquals(JSON.parse(state.stderr).error.code, 'invalid_input');
});

Deno.test('Increment 104 --json reports a failed run as a result record', async () => {
  const { state, deps } = recorder();
  const outcome: LoopOutcome = {
    ok: false,
    task: 'hi',
    outcome: 'max_steps',
    stopReason: 'max_steps',
    error: 'maximum model steps reached',
    steps: 64,
    toolCallCount: 63,
    toolResultCount: 63,
    transcript: [],
  };
  const exit = await runtimeMain(['--task', 'hi', '--json'], {
    ...deps,
    run: emitRun([], outcome),
  });
  assertEquals(exit, 1);
  assertEquals(state.stderr, '');
  const parsed = lines(state.stdout) as Record<string, unknown>[];
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].kind, 'result');
  assertEquals(parsed[0].ok, false);
  assertEquals(parsed[0].stopReason, 'max_steps');
  assertEquals(parsed[0].steps, 64);
});
