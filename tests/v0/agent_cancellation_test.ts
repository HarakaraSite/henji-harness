import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  CancellationCleanupError,
  TurnCancellationOwner,
  TurnCancelledError,
} from '../../v0/agent/cancellation.ts';
import { AGENT_SESSION_UNAVAILABLE, AgentSession } from '../../v0/agent/session.ts';
import { type AgentEvent } from '../../v0/agent/events.ts';
import {
  type LoopOutcome,
  type ModelRequest,
  type ModelResult,
  type ToolCall,
} from '../../v0/agent/contracts.ts';
import { runAgentTurn } from '../../v0/agent/loop.ts';
import { Registry, type Tool } from '../../v0/agent/tools.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import { OpenRouterAgentError, OpenRouterAgentModel } from '../../v0/agent/openrouter_model.ts';
import { createTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { TuiController } from '../../v0/tui/controller.ts';
import { TuiRenderer } from '../../v0/tui/render.ts';
import { TerminalLifecycle, type TerminalPort } from '../../v0/tui/terminal.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const final = (text: string): ModelResult => ({ kind: 'final', text });

const call = (name: string, callId = 'call'): ToolCall => ({
  callId,
  name,
  arguments: {},
});

class FakeTerminal implements TerminalPort {
  readonly writes: string[] = [];
  readonly raw: boolean[] = [];
  readonly handlers = new Map<'SIGINT' | 'SIGTERM' | 'SIGHUP', () => void>();
  private readonly queue: Uint8Array[] = [];
  private waiter: ((value: Uint8Array | null) => void) | null = null;
  private closed = false;
  stdinIsTerminal() {
    return true;
  }
  stdoutIsTerminal() {
    return true;
  }
  consoleSize() {
    return { columns: 80, rows: 24 };
  }
  setRaw(mode: boolean) {
    this.raw.push(mode);
  }
  read() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise<Uint8Array | null>((resolve) => this.waiter = resolve);
  }
  drainAndCloseInput() {
    this.closed = true;
    this.waiter?.(null);
    this.waiter = null;
    return Promise.resolve();
  }
  write(bytes: Uint8Array) {
    this.writes.push(new TextDecoder().decode(bytes));
  }
  addSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void) {
    this.handlers.set(signal, handler);
  }
  removeSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP') {
    this.handlers.delete(signal);
  }
  push(text: string) {
    const bytes = new TextEncoder().encode(text);
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(bytes);
    } else this.queue.push(bytes);
  }
  emitSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP') {
    this.handlers.get(signal)?.();
  }
  output() {
    return this.writes.join('');
  }
}

class CancellableSession {
  readonly submitted: string[] = [];
  cancelCount = 0;
  private pending: { resolve: (outcome: LoopOutcome) => void } | null = null;
  constructor(private readonly sink: (event: AgentEvent) => void) {}
  submit(task: string): Promise<LoopOutcome> {
    this.submitted.push(task);
    const turn = this.submitted.length;
    this.sink({ kind: 'turn_start', turn });
    this.sink({
      kind: 'user_message',
      turn,
      message: { role: 'user', content: { kind: 'text', text: task } },
    });
    return new Promise((resolve) => this.pending = { resolve });
  }
  cancelActiveTurn() {
    this.cancelCount += 1;
    return this.cancelCount === 1 ? 'requested' as const : 'already_requested' as const;
  }
  completeCancelled() {
    if (this.pending === null) return;
    const turn = this.submitted.length;
    this.sink({ kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
    this.pending.resolve(cancelledOutcome(this.submitted.at(-1)!));
    this.pending = null;
  }
  completeFinal() {
    if (this.pending === null) return;
    const turn = this.submitted.length;
    this.sink({
      kind: 'assistant_message',
      turn,
      message: { role: 'assistant', content: { kind: 'text', text: 'ok' } },
    });
    this.sink({ kind: 'turn_end', turn, outcome: 'final', committed: true });
    this.pending.resolve({
      ...cancelledOutcome(this.submitted.at(-1)!),
      ok: true,
      outcome: 'final',
      stopReason: 'final',
      finalText: 'ok',
    });
    this.pending = null;
  }
}

const cancelledOutcome = (task: string) => ({
  ok: false as const,
  task,
  outcome: 'cancelled' as const,
  stopReason: 'cancelled' as const,
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

Deno.test('turn cancellation owner is idempotent and arbitration is synchronous', () => {
  const owner = new TurnCancellationOwner();
  assertEquals(owner.state, 'active');
  assertEquals(owner.request(), 'requested');
  assert(owner.signal.aborted);
  assertEquals(owner.request(), 'already_requested');
  assertEquals(owner.trySettleNormally(), false);
  owner.settleCancelled();
  assertEquals(owner.state, 'settled');
  owner.settleCancelled();
  assertEquals(owner.state, 'settled');

  const normal = new TurnCancellationOwner();
  assert(normal.trySettleNormally());
  assertEquals(normal.request(), 'already_requested');
  normal.markCleanupFailed();
  assertEquals(normal.state, 'settled');
});

Deno.test('pending model cancellation emits one noncommitted end and fresh next-turn signal', async () => {
  const waits = [deferred<ModelResult>(), deferred<ModelResult>()];
  const signals: (AbortSignal | undefined)[] = [];
  const requests: ModelRequest[] = [];
  const model = {
    generate(request: ModelRequest, options?: { signal?: AbortSignal }) {
      requests.push(request);
      signals.push(options?.signal);
      return waits[requests.length - 1].promise;
    },
  };
  const events: AgentEvent[] = [];
  const session = new AgentSession(model, new Registry([]), {
    eventSink: (event) => events.push(event),
  });
  const pending = session.submit('cancel me');
  await Promise.resolve();
  assertEquals(session.cancelActiveTurn(), 'requested');
  assertEquals(session.cancelActiveTurn(), 'already_requested');
  waits[0].resolve(final('discarded'));
  const cancelled = await pending;
  assertEquals(cancelled.stopReason, 'cancelled');
  assertEquals(cancelled.ok, false);
  assertEquals(cancelled.transcript, [{
    role: 'user',
    content: { kind: 'text', text: 'cancel me' },
  }]);
  assertEquals(events.filter((event) => event.kind === 'turn_end'), [{
    kind: 'turn_end',
    turn: 1,
    outcome: 'cancelled',
    committed: false,
  }]);
  assertEquals(session.transcriptSnapshot(), []);
  const next = session.submit('next');
  waits[1].resolve(final('kept'));
  const success = await next;
  assert(success.ok);
  assertEquals(success.finalText, 'kept');
  assert(signals[0] !== undefined && signals[1] !== undefined && signals[0] !== signals[1]);
  assertEquals(requests[1].transcript, [{ role: 'user', content: { kind: 'text', text: 'next' } }]);
});

Deno.test('ordinary model contract failure settles normally before a turn-end cancellation request', async () => {
  const sessionRef: { current?: AgentSession } = {};
  let cancellationResult: string | undefined;
  const session = new AgentSession(
    {
      generate: () => {
        throw new Error('model failure marker');
      },
    },
    new Registry([]),
    {
      eventSink: (event) => {
        if (event.kind === 'turn_end') {
          cancellationResult = sessionRef.current?.cancelActiveTurn();
        }
      },
    },
  );
  sessionRef.current = session;
  const result = await session.submit('ordinary failure');
  assertEquals(result.stopReason, 'contract_failure');
  assertEquals(cancellationResult, 'idle');
  assertEquals(session.transcriptSnapshot(), []);
});

Deno.test('cancellation already won when model throws produces cancelled rather than contract failure', async () => {
  const sessionRef: { current?: AgentSession } = {};
  const session = new AgentSession(
    {
      generate: () => {
        assert(sessionRef.current !== undefined);
        assertEquals(sessionRef.current.cancelActiveTurn(), 'requested');
        throw new Error('late model failure marker');
      },
    },
    new Registry([]),
  );
  sessionRef.current = session;
  const result = await session.submit('cancelled failure');
  assertEquals(result.stopReason, 'cancelled');
  assertEquals(session.cancelActiveTurn(), 'idle');
  assertEquals(session.transcriptSnapshot(), []);
});

Deno.test('cancellation requested by a completed assistant event wins before final settlement', async () => {
  const owner = new TurnCancellationOwner();
  let committed = 0;
  const events: AgentEvent[] = [];
  const outcome = await runAgentTurn(
    'race',
    [],
    { generate: () => final('discarded') },
    new Registry([]),
    {
      cancellation: owner,
      commit: () => committed += 1,
      eventSink: (event) => {
        events.push(event);
        if (event.kind === 'assistant_message') owner.request();
      },
    },
  );
  assertEquals(outcome.stopReason, 'cancelled');
  assertEquals(committed, 0);
  assertEquals(events.at(-1), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'cancelled',
    committed: false,
  });
});

Deno.test('cancellation after a delivered call event prevents dispatch and counts 1/0', async () => {
  let dispatched = 0;
  const owner = new TurnCancellationOwner();
  const events: AgentEvent[] = [];
  const registry = new Registry([{
    name: 'effect',
    description: 'effect',
    inputSchema: { type: 'object' },
    execute() {
      dispatched += 1;
      return 'done';
    },
  }]);
  const result = await runAgentTurn(
    'task',
    [],
    {
      generate: () => ({ kind: 'tool_calls' as const, calls: [call('effect')] }),
    },
    registry,
    {
      cancellation: owner,
      eventSink: (event) => {
        events.push(event);
        if (event.kind === 'tool_call') owner.request();
      },
    },
  );
  assertEquals(result.stopReason, 'cancelled');
  assertEquals(result.toolCallCount, 1);
  assertEquals(result.toolResultCount, 0);
  assertEquals(dispatched, 0);
  assertEquals(events.at(-1), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'cancelled',
    committed: false,
  });
});

Deno.test('cancellation during a multi-call batch keeps earlier results out of the draft message', async () => {
  const owner = new TurnCancellationOwner();
  const calls: string[] = [];
  const events: AgentEvent[] = [];
  const registry = new Registry([{
    name: 'effect',
    description: 'effect',
    inputSchema: { type: 'object' },
    execute(argumentsValue) {
      calls.push((argumentsValue as { readonly id?: string }).id ?? 'missing');
      return 'done';
    },
  }]);
  const outcome = await runAgentTurn(
    'batch',
    [],
    {
      generate: () => ({
        kind: 'tool_calls' as const,
        calls: [call('effect', 'one'), { ...call('effect', 'two'), arguments: { id: 'two' } }],
      }),
    },
    registry,
    {
      cancellation: owner,
      eventSink: (event) => {
        events.push(event);
        if (event.kind === 'tool_call' && event.call.callId === 'two') owner.request();
      },
    },
  );
  assertEquals(outcome.stopReason, 'cancelled');
  assertEquals(outcome.toolCallCount, 2);
  assertEquals(outcome.toolResultCount, 1);
  assertEquals(calls, ['missing']);
  assertEquals(outcome.transcript, [
    { role: 'user', content: { kind: 'text', text: 'batch' } },
    {
      role: 'assistant',
      content: [
        { kind: 'tool_call', callId: 'one', name: 'effect', arguments: {} },
        { kind: 'tool_call', callId: 'two', name: 'effect', arguments: { id: 'two' } },
      ],
    },
  ]);
  assertEquals(events.at(-1), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'cancelled',
    committed: false,
  });
});

Deno.test('cleanup failure is fatal and poisons the session even when turn_end delivery throws', async () => {
  const tool: Tool = {
    name: 'cleanup',
    description: 'cleanup',
    inputSchema: { type: 'object' },
    async execute() {
      await Promise.resolve();
      throw new CancellationCleanupError();
    },
  };
  let modelCalls = 0;
  let eventCount = 0;
  const session = new AgentSession(
    {
      generate: () => {
        modelCalls += 1;
        return { kind: 'tool_calls', calls: [call('cleanup')] };
      },
    },
    new Registry([tool]),
    {
      eventSink: (event) => {
        eventCount += 1;
        if (event.kind === 'turn_end') throw new Error('sink');
      },
    },
  );
  const pending = session.submit('poison');
  await Promise.resolve();
  assertEquals(session.cancelActiveTurn(), 'requested');
  await assertRejects(() => pending);
  assertEquals(modelCalls, 1);
  const beforeEvents = eventCount;
  await assertRejects(async () => {
    try {
      await session.submit('later');
    } catch (error) {
      assertEquals(error instanceof Error ? error.message : '', AGENT_SESSION_UNAVAILABLE);
      throw error;
    }
  });
  assertEquals(modelCalls, 1);
  assertEquals(eventCount, beforeEvents);
});

Deno.test('planner child and parent observe the exact same signal without settling the parent owner', () => {
  const owner = new TurnCancellationOwner();
  const parent = createTurnExecutionContext(1, owner.signal, owner);
  const child = parent.admitPlannerExecution();
  assert(child !== undefined);
  assertEquals(child?.signal, owner.signal);
  assertEquals(child?.cancellation, owner);
  owner.request();
  assert(parent.signal?.aborted);
  assert(child?.signal?.aborted);
});

Deno.test('planner cancellation is rethrown before admission and never becomes a failure envelope', async () => {
  let executions = 0;
  const owner = new TurnCancellationOwner();
  const parent = createTurnExecutionContext(1, owner.signal, owner);
  const tool = createPlannerDelegationTool(() => {
    executions += 1;
    throw new TurnCancelledError();
  });
  owner.request();
  let error: unknown;
  try {
    await tool.execute({ task: 'cancel before admission' }, {
      modelExecution: parent,
      signal: owner.signal,
      cancellation: owner,
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof TurnCancelledError);
  assertEquals(executions, 0);
  assertEquals(parent.hasAdmittedPlannerExecution, false);
});

Deno.test('OpenRouter cancellation waits for an abort-ignoring response body to settle', async () => {
  const bodyGate = deferred<void>();
  let bodyStarted = false;
  const body = {
    getReader() {
      return {
        read: async () => {
          bodyStarted = true;
          await bodyGate.promise;
          return { done: true, value: undefined };
        },
        releaseLock() {},
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
  // Response.body is read-only, so use a response constructed with the gated stream.
  const gatedModel = new OpenRouterAgentModel({
    credential: 'dummy',
    fetcher: () => Promise.resolve({ ok: true, status: 200, body } as Response),
  });
  const owner = new TurnCancellationOwner();
  const pending = gatedModel.generate({
    transcript: [{ role: 'user', content: { kind: 'text', text: 'x' } }],
    tools: [],
  }, { signal: owner.signal });
  while (!bodyStarted) await Promise.resolve();
  owner.request();
  let settled = false;
  void pending.then(() => settled = true, () => settled = true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(settled, false);
  bodyGate.resolve();
  await assertRejects(() => pending);
});

Deno.test('OpenRouter settles an acquired body before cancellation and timeout classification', async () => {
  const request = {
    transcript: [{ role: 'user' as const, content: { kind: 'text' as const, text: 'x' } }],
    tools: [],
  };
  let cancellationBodyCancels = 0;
  const cancellationOwner = new TurnCancellationOwner();
  const cancellationModel = new OpenRouterAgentModel({
    credential: 'dummy',
    fetcher: () => {
      cancellationOwner.request();
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { cancel: () => cancellationBodyCancels += 1 },
      } as unknown as Response);
    },
  });
  let cancellationError: unknown;
  try {
    await cancellationModel.generate(request, { signal: cancellationOwner.signal });
  } catch (error) {
    cancellationError = error;
  }
  assert(cancellationError instanceof TurnCancelledError);
  assertEquals(cancellationBodyCancels, 1);

  const cleanupOwner = new TurnCancellationOwner();
  const cleanupModel = new OpenRouterAgentModel({
    credential: 'dummy',
    fetcher: () => {
      cleanupOwner.request();
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { cancel: () => Promise.reject(new Error('body cleanup marker')) },
      } as Response);
    },
  });
  let cleanupError: unknown;
  try {
    await cleanupModel.generate(request, { signal: cleanupOwner.signal });
  } catch (error) {
    cleanupError = error;
  }
  assert(cleanupError instanceof CancellationCleanupError);

  let timeoutBodyCancels = 0;
  const timeoutModel = new OpenRouterAgentModel({
    credential: 'dummy',
    timeoutMs: 1,
    fetcher: () =>
      new Promise((resolve) =>
        setTimeout(() =>
          resolve({
            ok: true,
            status: 200,
            body: { cancel: () => timeoutBodyCancels += 1 },
          } as unknown as Response), 10)
      ),
  });
  let timeoutError: unknown;
  try {
    await timeoutModel.generate(request);
  } catch (error) {
    timeoutError = error;
  }
  assert(timeoutError instanceof OpenRouterAgentError);
  assertEquals(timeoutError.code, 'transport_error');
  assertEquals(timeoutBodyCancels, 1);

  const httpCleanupOwner = new TurnCancellationOwner();
  const httpCleanupModel = new OpenRouterAgentModel({
    credential: 'dummy',
    fetcher: () => {
      httpCleanupOwner.request();
      return Promise.resolve({
        ok: false,
        status: 503,
        body: { cancel: () => Promise.reject(new Error('http body cleanup marker')) },
      } as Response);
    },
  });
  let httpCleanupError: unknown;
  try {
    await httpCleanupModel.generate(request, { signal: httpCleanupOwner.signal });
  } catch (error) {
    httpCleanupError = error;
  }
  assert(httpCleanupError instanceof CancellationCleanupError);
});

Deno.test('cancellation before credential resolution never starts the provider request', async () => {
  const owner = new TurnCancellationOwner();
  owner.request();
  let credentialReads = 0;
  let requests = 0;
  const model = new OpenRouterAgentModel({
    credentialSource: () => {
      credentialReads += 1;
      return 'dummy';
    },
    fetcher: () => {
      requests += 1;
      return Promise.reject(new Error('must not fetch'));
    },
  });
  let error: unknown;
  try {
    await model.generate({
      transcript: [{ role: 'user', content: { kind: 'text', text: 'x' } }],
      tools: [],
    }, { signal: owner.signal });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof TurnCancelledError);
  assertEquals(credentialReads, 0);
  assertEquals(requests, 0);
});

Deno.test('provider timeout during an abort-ignoring body remains a transport failure', async () => {
  const bodyGate = deferred<void>();
  const body = {
    getReader() {
      return {
        read: async () => {
          await bodyGate.promise;
          return { done: true, value: undefined };
        },
        releaseLock() {},
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
  const model = new OpenRouterAgentModel({
    credential: 'dummy',
    timeoutMs: 1,
    fetcher: () => Promise.resolve({ ok: true, status: 200, body } as Response),
  });
  const pending = model.generate({
    transcript: [{ role: 'user', content: { kind: 'text', text: 'x' } }],
    tools: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 8));
  bodyGate.resolve();
  let error: unknown;
  try {
    await pending;
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error);
  assertEquals(error instanceof Error ? error.message : '', 'provider transport failed');
});

Deno.test('busy Escape cancels after settlement and the same TUI session accepts a later turn', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new CancellableSession(renderer.eventSink);
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('first\n');
  await Promise.resolve();
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(session.cancelCount, 1);
  assert(terminal.output().includes('cancelling'));
  session.completeCancelled();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(controller.currentState, 'idle');
  terminal.push('second\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  session.completeFinal();
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x04');
  assertEquals(await running, 0);
  assertEquals(session.submitted, ['first', 'second']);
});

Deno.test('busy Ctrl-C and handled signals cancel once and restore with their prescribed exits', async () => {
  for (
    const [signal, expectedExit] of [
      ['SIGINT', 0],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const
  ) {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const session = new CancellableSession(renderer.eventSink);
    const controller = new TuiController(lifecycle, renderer, session);
    await lifecycle.acquire();
    const running = controller.run();
    terminal.push('signal me\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    terminal.emitSignal(signal);
    terminal.emitSignal(signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(session.cancelCount, 1);
    assert(terminal.output().includes('cancelling'));
    session.completeCancelled();
    assertEquals(await running, expectedExit);
    assert(terminal.raw.includes(false));
  }
});

Deno.test('Escape followed by Ctrl-C promotes one pending cancellation to clean exit', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new CancellableSession(renderer.eventSink);
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('promote\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x1b\x03');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(session.cancelCount, 1);
  session.completeCancelled();
  assertEquals(await running, 0);
  assertEquals(terminal.raw.filter((value) => value === false).length, 1);
});

Deno.test('TUI cleanup failure restores once and exits through the fatal agent path', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = deferred<LoopOutcome>();
  const session = {
    submit: (_task: string) => pending.promise,
    cancelActiveTurn: () => 'requested' as const,
  };
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('poison\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending.reject(new CancellationCleanupError());
  let error: unknown;
  try {
    await running;
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error);
  assertEquals((error as { readonly code?: string }).code, 'agent_failure');
  assertEquals(terminal.raw.filter((value) => value === false).length, 1);
  assert(renderer.isClosing);
  assert(!terminal.output().includes('cancellation cleanup failed'));
});
