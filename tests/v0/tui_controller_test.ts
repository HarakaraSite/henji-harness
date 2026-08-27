import { assert, assertEquals } from './test_helpers.ts';
import { type AgentEvent, EventDeliveryError } from '../../v0/agent/events.ts';
import { type LoopOutcome } from '../../v0/agent/contracts.ts';
import { type ContextMetrics } from '../../v0/agent/context.ts';
import { main as tuiMain, parseTuiArgs } from '../../v0/agent/tui_cli.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import { Registry } from '../../v0/agent/tools.ts';
import { TuiController, TuiControllerError } from '../../v0/tui/controller.ts';
import { TuiRenderer } from '../../v0/tui/render.ts';
import {
  BRACKETED_PASTE_ON,
  RESET_SGR,
  TerminalLifecycle,
  type TerminalPort,
} from '../../v0/tui/terminal.ts';

class FakeTerminal implements TerminalPort {
  readonly writes: string[] = [];
  readonly operations: string[] = [];
  readonly raw: boolean[] = [];
  readonly signals: string[] = [];
  readonly signalHandlers = new Map<'SIGINT' | 'SIGTERM' | 'SIGHUP', () => void>();
  private queue: Uint8Array[] = [];
  private waiter: ((value: Uint8Array | null) => void) | null = null;
  private closed = false;
  failRead = false;
  failDrain = false;
  failRawMode: boolean | null = null;
  readonly failWrites = new Set<string>();
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
    this.operations.push(`raw:${mode}`);
    if (this.failRawMode === mode) throw new Error('raw failure');
  }
  read(): Promise<Uint8Array | null> {
    if (this.failRead) return Promise.reject(new Error('read failure'));
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiter = resolve);
  }
  drainAndCloseInput() {
    this.operations.push('drain');
    if (this.failDrain) return Promise.reject(new Error('drain failure'));
    this.closed = true;
    this.queue = [];
    this.waiter?.(null);
    this.waiter = null;
    return Promise.resolve();
  }
  write(bytes: Uint8Array) {
    const text = new TextDecoder().decode(bytes);
    this.writes.push(text);
    this.operations.push(`write:${text}`);
    if (this.failWrites.has(text)) throw new Error('write failure');
  }
  addSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void) {
    this.signals.push(`+${signal}`);
    this.signalHandlers.set(signal, handler);
  }
  removeSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void) {
    this.signals.push(`-${signal}`);
    if (this.signalHandlers.get(signal) === handler) this.signalHandlers.delete(signal);
  }
  push(text: string) {
    const value = new TextEncoder().encode(text);
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(value);
    } else this.queue.push(value);
  }
  output() {
    return this.writes.join('');
  }
  emitSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP') {
    this.signalHandlers.get(signal)?.();
  }
}

const finalOutcome = (task: string, finalText = 'done'): LoopOutcome => ({
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

const cancelledOutcome = (task: string): LoopOutcome => ({
  ok: false,
  task,
  outcome: 'cancelled',
  stopReason: 'cancelled',
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

class FakeSession {
  readonly submitted: string[] = [];
  contextReads = 0;
  private resolveTurn: ((outcome: LoopOutcome) => void) | null = null;
  constructor(
    private readonly sink: (event: AgentEvent) => void,
    private readonly delayed = false,
    private readonly metrics?: ContextMetrics,
  ) {}
  contextSnapshot(): ContextMetrics | undefined {
    this.contextReads += 1;
    return this.metrics;
  }
  submit(task: string): Promise<LoopOutcome> {
    this.submitted.push(task);
    this.sink({ kind: 'turn_start', turn: this.submitted.length });
    this.sink({
      kind: 'user_message',
      turn: this.submitted.length,
      message: { role: 'user', content: { kind: 'text', text: task } },
    });
    const finish = () => {
      this.sink({
        kind: 'assistant_message',
        turn: this.submitted.length,
        message: { role: 'assistant', content: { kind: 'text', text: 'done' } },
      });
      this.sink({
        kind: 'turn_end',
        turn: this.submitted.length,
        outcome: 'final',
        committed: true,
      });
      return finalOutcome(task);
    };
    if (!this.delayed) return Promise.resolve(finish());
    return new Promise((resolve) => {
      this.resolveTurn = () => resolve(finish());
    });
  }
  complete() {
    this.resolveTurn?.(finalOutcome('unused'));
    this.resolveTurn = null;
  }
}

/** A delayed session whose context accessor fails if the controller polls before settlement. */
class DelayedMetricsSession {
  readonly submitted: string[] = [];
  contextReads = 0;
  cancelCount = 0;
  private pending:
    | { readonly task: string; readonly resolve: (outcome: LoopOutcome) => void }
    | null = null;
  constructor(
    private readonly sink: (event: AgentEvent) => void,
    private readonly metrics: ContextMetrics,
  ) {}
  contextSnapshot(): ContextMetrics {
    if (this.pending !== null) throw new Error('context must not be read while busy');
    this.contextReads += 1;
    return { ...this.metrics };
  }
  submit(task: string): Promise<LoopOutcome> {
    this.submitted.push(task);
    const turn = this.submitted.length;
    this.sink({ kind: 'turn_start', turn });
    this.sink({
      kind: 'user_message',
      turn,
      message: { role: 'user', content: { kind: 'text', text: task } },
    });
    return new Promise((resolve) => this.pending = { task, resolve });
  }
  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (this.pending === null) return 'idle';
    this.cancelCount += 1;
    return this.cancelCount === 1 ? 'requested' : 'already_requested';
  }
  completeCancelled(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    const turn = this.submitted.length;
    this.sink({ kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
    pending.resolve(cancelledOutcome(pending.task));
  }
}

class MetricsFailureSession {
  contextReads = 0;
  constructor(
    private readonly metrics: ContextMetrics,
    private readonly rejectSubmission: boolean,
  ) {}
  contextSnapshot(): ContextMetrics {
    this.contextReads += 1;
    return { ...this.metrics };
  }
  submit(task: string): Promise<LoopOutcome> {
    if (this.rejectSubmission) return Promise.reject(new Error('session rejected'));
    return Promise.resolve({
      ok: false,
      task,
      outcome: 'contract_failure',
      stopReason: 'contract_failure',
      error: 'bounded failure',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    });
  }
}

const setup = (session: FakeSession) => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  return {
    terminal,
    renderer,
    lifecycle,
    controller: new TuiController(lifecycle, renderer, session),
  };
};

Deno.test('controller submits exact task and exits on empty Ctrl-D', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new FakeSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const run = controller.run();
  terminal.push(' exact task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x04');
  assertEquals(await run, 0);
  assertEquals(session.submitted, [' exact task']);
  assert(terminal.raw.includes(false));
});

Deno.test('controller formats absent, zero-omission, ceiling, and omitted context statuses exactly', async () => {
  const absentTerminal = new FakeTerminal();
  const absentRenderer = new TuiRenderer(absentTerminal);
  const absentLifecycle = new TerminalLifecycle(absentTerminal, absentRenderer);
  const absentController = new TuiController(absentLifecycle, absentRenderer, {
    submit: (task) => Promise.resolve(finalOutcome(task)),
  });
  await absentLifecycle.acquire();
  const absentRun = absentController.run();
  absentTerminal.push('absent\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(absentTerminal.output().includes('ready]'));
  absentTerminal.push('\x04');
  assertEquals(await absentRun, 0);

  const cases: readonly [string, ContextMetrics, string][] = [
    ['zero', {
      messageEstimatedTokensBefore: 0,
      messageEstimatedTokensAfter: 0,
      toolEstimatedTokens: 0,
      requestEstimatedTokensBefore: 0,
      requestEstimatedTokensAfter: 0,
      triggerTokens: 65_536,
      targetTokens: 49_152,
      triggered: false,
      targetReached: false,
      compressedResultCount: 0,
      compressedMessageCount: 0,
    }, 'ready · ctx ≤0K/64K est'],
    ['ceiling', {
      messageEstimatedTokensBefore: 65 * 1024,
      messageEstimatedTokensAfter: 65 * 1024,
      toolEstimatedTokens: 0,
      requestEstimatedTokensBefore: 65 * 1024,
      requestEstimatedTokensAfter: 65 * 1024,
      triggerTokens: 65_536,
      targetTokens: 49_152,
      triggered: true,
      targetReached: false,
      compressedResultCount: 0,
      compressedMessageCount: 0,
    }, 'ready · ctx ≤65K/64K est'],
    ['omitted', {
      messageEstimatedTokensBefore: 70_000,
      messageEstimatedTokensAfter: 1_025,
      toolEstimatedTokens: 12,
      requestEstimatedTokensBefore: 70_012,
      requestEstimatedTokensAfter: 1_037,
      triggerTokens: 65_536,
      targetTokens: 49_152,
      triggered: true,
      targetReached: true,
      compressedResultCount: 2,
      compressedMessageCount: 1,
    }, 'ready · ctx ≤2K/64K est · 2 omitted'],
  ];
  for (const [name, metrics, expected] of cases) {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const session = new FakeSession((event) => renderer.eventSink(event), false, metrics);
    const controller = new TuiController(lifecycle, renderer, session);
    await lifecycle.acquire();
    const running = controller.run();
    assertEquals(session.contextReads, 0, `${name} reads before settlement`);
    terminal.push(`${name}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(session.contextReads, 1, `${name} reads after settlement`);
    assert(terminal.output().includes(expected), `${name} status`);
    terminal.push('\x04');
    assertEquals(await running, 0, `${name} exit`);
  }
});

Deno.test('delayed metrics context is read once after cancellation, never while busy, and does not alter exit', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new DelayedMetricsSession((event) => renderer.eventSink(event), {
    messageEstimatedTokensBefore: 70_000,
    messageEstimatedTokensAfter: 4_096,
    toolEstimatedTokens: 12,
    requestEstimatedTokensBefore: 70_012,
    requestEstimatedTokensAfter: 4_108,
    triggerTokens: 65_536,
    targetTokens: 49_152,
    triggered: true,
    targetReached: true,
    compressedResultCount: 1,
    compressedMessageCount: 1,
  });
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('delayed task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(session.contextReads, 0);
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(session.cancelCount, 1);
  assertEquals(session.contextReads, 0);
  session.completeCancelled();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(session.contextReads, 1);
  assert(terminal.output().includes('ready · ctx ≤4K/64K est · 1 omitted'));
  terminal.push('\x04');
  assertEquals(await running, 0);
  assertEquals(session.contextReads, 1);
});

Deno.test('metrics accessor is not read for rejected or fatal turn settlement', async () => {
  const metrics: ContextMetrics = {
    messageEstimatedTokensBefore: 70_000,
    messageEstimatedTokensAfter: 4_096,
    toolEstimatedTokens: 12,
    requestEstimatedTokensBefore: 70_012,
    requestEstimatedTokensAfter: 4_108,
    triggerTokens: 65_536,
    targetTokens: 49_152,
    triggered: true,
    targetReached: true,
    compressedResultCount: 1,
    compressedMessageCount: 1,
  };
  for (const rejectSubmission of [true, false]) {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const session = new MetricsFailureSession(metrics, rejectSubmission);
    const controller = new TuiController(lifecycle, renderer, session);
    await lifecycle.acquire();
    const running = controller.run();
    terminal.push(rejectSubmission ? 'rejected\n' : 'fatal\n');
    let error: unknown;
    try {
      await running;
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof TuiControllerError);
    assertEquals((error as TuiControllerError).code, 'agent_failure');
    assertEquals(session.contextReads, 0, rejectSubmission ? 'rejected reads' : 'fatal reads');
  }
});

Deno.test('busy exit-intent settlement does not read committed metrics', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new DelayedMetricsSession((event) => renderer.eventSink(event), {
    messageEstimatedTokensBefore: 70_000,
    messageEstimatedTokensAfter: 4_096,
    toolEstimatedTokens: 12,
    requestEstimatedTokensBefore: 70_012,
    requestEstimatedTokensAfter: 4_108,
    triggerTokens: 65_536,
    targetTokens: 49_152,
    triggered: true,
    targetReached: true,
    compressedResultCount: 1,
    compressedMessageCount: 1,
  });
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('exit task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(session.contextReads, 0);
  terminal.push('\x03');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(session.cancelCount, 1);
  assertEquals(session.contextReads, 0);
  session.completeCancelled();
  assertEquals(await running, 0);
  assertEquals(session.contextReads, 0);
});

Deno.test('idle Ctrl-C clears then exits only on a second press within 500 ms', async () => {
  const { terminal, lifecycle, controller } = setup(new FakeSession(() => {}));
  await lifecycle.acquire();
  const run = controller.run();
  terminal.push('draft\x03');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(controller.editor.text, '');
  terminal.push('\x03');
  assertEquals(await run, 0);
  assert(terminal.output().includes('press Ctrl-C again to exit'));
});

Deno.test('busy input is consumed, Esc reports unavailable, and Ctrl-C exits after turn', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new FakeSession((event) => renderer.eventSink(event), true);
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const run = controller.run();
  terminal.push('task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('discarded\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  terminal.push('\x03');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(controller.editor.text, '');
  session.complete();
  assertEquals(await run, 0);
  assertEquals(session.submitted, ['task']);
  assert(terminal.output().includes('cancellation unavailable; turn continues'));
  assert(terminal.output().includes('exiting after current turn'));
  assert(!terminal.output().includes('discarded'));
});

Deno.test('events after Enter in one chunk use busy semantics', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new FakeSession((event) => renderer.eventSink(event), true);
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const run = controller.run();
  terminal.push('task\n\x03');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(session.submitted, ['task']);
  assert(terminal.output().includes('exiting after current turn'));
  session.complete();
  assertEquals(await run, 0);
});

Deno.test('model/event failure closes renderer and restores terminal', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = {
    submit: (): Promise<LoopOutcome> => Promise.reject(new Error('provider-sensitive marker')),
  };
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const run = controller.run();
  terminal.push('fail\n');
  let error: unknown;
  try {
    await run;
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof TuiControllerError);
  assertEquals((error as TuiControllerError).code, 'agent_failure');
  assert(terminal.raw.includes(false));
  assert(renderer.isClosing);
  assert(!terminal.output().includes('provider-sensitive marker'));
});

Deno.test('renderer sink exceptions are normalized', () => {
  const renderer = new TuiRenderer({
    stdinIsTerminal: () => true,
    stdoutIsTerminal: () => true,
    consoleSize: () => ({ columns: 80, rows: 24 }),
    setRaw: () => {},
    read: () => Promise.resolve(null),
    drainAndCloseInput: () => Promise.resolve(),
    write: () => {
      throw new Error('write marker');
    },
    addSignal: () => {},
    removeSignal: () => {},
  });
  let threw = false;
  try {
    renderer.eventSink({
      kind: 'assistant_message',
      turn: 1,
      message: { role: 'assistant', content: { kind: 'text', text: 'x' } },
    });
  } catch (error) {
    threw = error instanceof EventDeliveryError;
  }
  assert(threw);
});

Deno.test('TUI preflight rejects argv or non-TTY before session/raw acquisition', async () => {
  const terminal = new FakeTerminal();
  let sessions = 0;
  let stderr = '';
  const exit = await tuiMain(['unexpected'], {
    terminal,
    createSession: () => {
      sessions += 1;
      return Promise.reject(new Error('session must not start'));
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(exit, 1);
  assertEquals(sessions, 0);
  assertEquals(terminal.raw, []);
  assert(stderr.includes('"code":"invalid_invocation"'));

  const nonTty = new FakeTerminal();
  nonTty.stdinIsTerminal = () => false;
  let nonTtySessions = 0;
  const nonTtyExit = await tuiMain([], {
    terminal: nonTty,
    createSession: () => {
      nonTtySessions += 1;
      return Promise.reject(new Error('session must not start'));
    },
    writeStderr: () => {},
  });
  assertEquals(nonTtyExit, 1);
  assertEquals(nonTtySessions, 0);
  assertEquals(nonTty.raw, []);
});

Deno.test('TUI parser accepts only omitted or exact --agent NAME forms', () => {
  assertEquals(parseTuiArgs([]), undefined);
  assertEquals(parseTuiArgs(['--agent', 'default']), 'default');
  assertEquals(parseTuiArgs(['--agent', 'planner']), 'planner');
  for (
    const args of [
      ['--agent'],
      ['--agent=planner'],
      ['--agent', 'planner', '--agent', 'default'],
      ['planner'],
      ['--task', 'task'],
    ]
  ) {
    let failed = false;
    try {
      parseTuiArgs(args);
    } catch {
      failed = true;
    }
    assert(failed);
  }
});

Deno.test('TUI resolves planner before session and keeps the selected Definition fixed', async () => {
  const terminal = new FakeTerminal();
  const session = new FakeSession(() => {});
  let selected = '';
  const exit = await tuiMain(['--agent', 'planner'], {
    terminal,
    createSession: (sink, selection) => {
      selected = selection.id;
      const connected = new FakeSession((event) => sink(event));
      setTimeout(() => terminal.push('planner task\n'), 0);
      setTimeout(() => terminal.push('\x04'), 20);
      return Promise.resolve({ session: connected });
    },
    writeStderr: () => {},
  });
  assertEquals(exit, 0);
  assertEquals(selected, 'planner');
  assertEquals(session.submitted, []);
  assert(terminal.raw.includes(false));
});

Deno.test('TUI controller drives an actual session through two delegated turns', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  let modelCalls = 0;
  let childCalls = 0;
  const contexts: ParentTurnExecutionContext[] = [];
  const registry = new Registry([createPlannerDelegationTool((task, child) => {
    childCalls += 1;
    assertEquals(task, childCalls === 1 ? 'first child' : 'second child');
    assert(child.claimModelRequest());
    return { outcome: finalOutcome(task, `plan ${childCalls}`), externalRequests: 1 };
  })]);
  let turnEnds = 0;
  const session = new AgentSession(
    {
      generate: () => {
        modelCalls += 1;
        if (modelCalls === 1 || modelCalls === 3) {
          return {
            kind: 'tool_calls' as const,
            calls: [{
              callId: `delegate-${modelCalls}`,
              name: 'delegate_to_planner',
              arguments: { task: modelCalls === 1 ? 'first child' : 'second child' },
            }],
          };
        }
        return { kind: 'final' as const, text: `parent ${modelCalls / 2}` };
      },
    },
    registry,
    {
      eventSink: (event) => {
        renderer.eventSink(event);
        if (event.kind !== 'turn_end') return;
        turnEnds += 1;
        if (turnEnds === 1) setTimeout(() => terminal.push('second task\n'), 0);
        else setTimeout(() => terminal.push('\x04'), 0);
      },
      createTurnExecutionContext: (turn) => {
        const context = new ParentTurnExecutionContext(turn);
        contexts.push(context);
        return context;
      },
    },
  );
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('first task\n');
  assertEquals(await running, 0);
  assertEquals(modelCalls, 4);
  assertEquals(childCalls, 2);
  assertEquals(contexts.map((context) => context.snapshot()), [
    { parent: 2, child: 1, aggregate: 3 },
    { parent: 2, child: 1, aggregate: 3 },
  ]);
  assert(terminal.output().includes('plan 1'));
  assert(terminal.output().includes('plan 2'));
  assert(terminal.raw.includes(false));
});

Deno.test('invalid TUI selection does not construct or probe the terminal', async () => {
  const terminal = new FakeTerminal();
  terminal.stdinIsTerminal = () => {
    throw new Error('terminal probe must not start');
  };
  let stderr = '';
  const exit = await tuiMain(['--agent', 'unknown'], {
    terminal,
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(exit, 1);
  assert(stderr.includes('"code":"invalid_invocation"'));
  assertEquals(terminal.operations, []);
  assertEquals(terminal.writes, []);
});

Deno.test('pre-controller signals restore and map all handled exits', async () => {
  for (
    const [signal, expected] of [
      ['SIGINT', 0],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const
  ) {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const controller = new TuiController(lifecycle, renderer, new FakeSession(() => {}));
    controller.installSignals();
    await lifecycle.acquire();
    terminal.emitSignal(signal);
    assertEquals(await controller.run(), expected);
    assert(terminal.raw.includes(false));
    assert(renderer.isClosing);
  }
});

Deno.test('partial acquire/read/write/restore failures remain bounded and sanitized', async () => {
  const rawFailure = new FakeTerminal();
  rawFailure.failRawMode = true;
  const rawRenderer = new TuiRenderer(rawFailure);
  const rawLifecycle = new TerminalLifecycle(rawFailure, rawRenderer);
  let acquireFailed = false;
  try {
    await rawLifecycle.acquire();
  } catch {
    acquireFailed = true;
  }
  assert(acquireFailed);
  assertEquals(rawFailure.raw, [true, false]);
  assert(rawRenderer.isClosing);

  const readFailure = new FakeTerminal();
  const readRenderer = new TuiRenderer(readFailure);
  const readLifecycle = new TerminalLifecycle(readFailure, readRenderer);
  await readLifecycle.acquire();
  readFailure.failRead = true;
  const readController = new TuiController(
    readLifecycle,
    readRenderer,
    new FakeSession(() => {}),
  );
  let readError: unknown;
  try {
    await readController.run();
  } catch (error) {
    readError = error;
  }
  assert(readError instanceof TuiControllerError);
  assertEquals((readError as TuiControllerError).code, 'input_failure');
  assert(readFailure.raw.includes(false));

  const outputFailure = new FakeTerminal();
  const outputRenderer = new TuiRenderer(outputFailure);
  const outputLifecycle = new TerminalLifecycle(outputFailure, outputRenderer);
  await outputLifecycle.acquire();
  outputFailure.failWrites.add('\r\x1b[2K>   [ready]');
  const outputController = new TuiController(
    outputLifecycle,
    outputRenderer,
    new FakeSession(() => {}),
  );
  let outputError: unknown;
  try {
    await outputController.run();
  } catch (error) {
    outputError = error;
  }
  assert(outputError instanceof TuiControllerError);
  assertEquals((outputError as TuiControllerError).code, 'output_failure');
  assert(outputFailure.raw.includes(false));

  const cleanupFailure = new FakeTerminal();
  const cleanupRenderer = new TuiRenderer(cleanupFailure);
  const cleanupLifecycle = new TerminalLifecycle(cleanupFailure, cleanupRenderer);
  await cleanupLifecycle.acquire();
  cleanupLifecycle.addSignals({ SIGINT: () => {}, SIGTERM: () => {}, SIGHUP: () => {} });
  cleanupFailure.failDrain = true;
  cleanupFailure.failWrites.add(RESET_SGR);
  await cleanupLifecycle.restore();
  assert(cleanupFailure.raw.includes(false));
  assert(cleanupFailure.signals.includes('-SIGINT'));
  assert(cleanupFailure.signals.includes('-SIGTERM'));
  assert(cleanupFailure.signals.includes('-SIGHUP'));

  const cliFailure = new FakeTerminal();
  cliFailure.failWrites.add(BRACKETED_PASTE_ON);
  const cliRendererSession = new FakeSession(() => {});
  let stderr = '';
  const cliExit = await tuiMain([], {
    terminal: cliFailure,
    createSession: () => Promise.resolve({ session: cliRendererSession }),
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(cliExit, 1);
  assert(stderr.includes('"code":"terminal_failure"'));
  assert(!stderr.includes('raw failure'));

  const startupFailure = new FakeTerminal();
  let startupStderr = '';
  const startupExit = await tuiMain([], {
    terminal: startupFailure,
    createSession: () => Promise.reject(new Error('startup marker')),
    writeStderr: (text) => {
      startupStderr += text;
    },
  });
  assertEquals(startupExit, 1);
  assert(startupStderr.includes('"code":"startup_failure"'));
  assert(!startupStderr.includes('startup marker'));
  assertEquals(startupFailure.writes, []);
});

Deno.test('handled SIGTERM and SIGHUP restore and map to 143/129', async () => {
  for (const [signal, expected] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const controller = new TuiController(lifecycle, renderer, new FakeSession(() => {}));
    await lifecycle.acquire();
    const run = controller.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    terminal.emitSignal(signal);
    assertEquals(await run, expected);
    assert(terminal.raw.includes(false));
    assert(renderer.isClosing);
  }
});

Deno.test('lifecycle restores in order and is idempotent', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  await lifecycle.restore();
  await lifecycle.restore();
  assertEquals(terminal.raw, [true, false]);
  const off = terminal.operations.indexOf('write:\u001b[?2004l');
  const drain = terminal.operations.indexOf('drain');
  const reset = terminal.operations.indexOf('write:\u001b[0m');
  assert(off >= 0 && off < drain && drain < reset);
  assertEquals(
    terminal.operations.filter((operation) => operation === 'write:\u001b[?2004l').length,
    1,
  );
});
