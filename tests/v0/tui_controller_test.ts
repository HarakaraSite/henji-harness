import { assert, assertEquals } from './test_helpers.ts';
import { type AgentEvent, EventDeliveryError } from '../../v0/agent/events.ts';
import { CancellationCleanupError } from '../../v0/agent/cancellation.ts';
import { type LoopOutcome } from '../../v0/agent/contracts.ts';
import { type PresentationFailureDiagnostic } from '../../v0/presentation/contract.ts';
import { type ContextMetrics } from '../../v0/agent/context.ts';
import {
  main as tuiMain,
  parseTuiArgs,
  parseTuiInvocation,
  runNavigationSwitchTransaction,
} from '../../v0/agent/tui_cli.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import { Registry } from '../../v0/agent/tools.ts';
import { TuiController, TuiControllerError, type TuiSessionLike } from '../../v0/tui/controller.ts';
import { TuiPresentationAdapter } from '../../v0/agent/tui_presentation_adapter.ts';
import {
  NavigationCancelledError,
  NavigationFatalError,
} from '../../v0/agent/session_navigation.ts';
import type {
  NavigationBinding,
  NavigationListing,
  NavigationPosition,
  SessionNavigationHost,
} from '../../v0/agent/session_navigation.ts';
import type { SessionHistoryPage } from '../../v0/agent/session_history.ts';
import { TuiEditorHistory } from '../../v0/tui/input.ts';
import { WorkspacePathIndex } from '../../v0/tui/file_reference.ts';
import { PendingInputCore } from '../../v0/tui/pending_input.ts';
import { TuiRenderer } from '../../v0/tui/render.ts';
import { projectRuntimeDisplayState } from '../../v0/agent/startup_orientation.ts';
import {
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  RESET_SGR,
  TerminalLifecycle,
  type TerminalPort,
} from '../../v0/tui/terminal.ts';

const fixtureDisplayState = (agentId: 'default' | 'planner' = 'default') =>
  projectRuntimeDisplayState({
    workspaceRoot: '/tmp/tui-fixture',
    agentId,
    profileId: 'fixture-profile',
    sessionMode: 'none',
    skillNames: [],
  });

class FakeTerminal implements TerminalPort {
  readonly writes: string[] = [];
  readonly operations: string[] = [];
  readonly raw: boolean[] = [];
  readonly signals: string[] = [];
  readonly signalHandlers = new Map<'SIGINT' | 'SIGTERM' | 'SIGHUP', () => void>();
  readonly readSnapshots: string[] = [];
  private queue: Uint8Array[] = [];
  private waiter: ((value: Uint8Array | null) => void) | null = null;
  private closed = false;
  failRead = false;
  failDrain = false;
  failRawMode: boolean | null = null;
  failNextWrite = false;
  failOrientation = false;
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
    this.readSnapshots.push(this.output());
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
    if (this.failOrientation && text.startsWith('Henji Harness\n')) {
      this.failOrientation = false;
      throw new Error('orientation write failure');
    }
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('write failure');
    }
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
  endInput() {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(null);
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

const responseParseDiagnostic: PresentationFailureDiagnostic = Object.freeze({
  schemaVersion: 1,
  diagnosticId: '44444444-4444-4444-8444-444444444444',
  stage: 'response_parse',
  code: 'response_error',
  lane: 'parent',
  providerRequestCount: 1,
  httpStatus: 200,
  parseReason: 'invalid_sse_json',
  occurredAt: '2026-09-02T00:00:00.000Z',
  turnNumber: 1,
  modelStep: 1,
  retryCount: 0,
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

class ProgressSession {
  private pending: ((outcome: LoopOutcome) => void) | null = null;
  private active = false;
  private cancellationRequested = false;
  cancelCount = 0;
  settled = false;
  steering: string[] = [];
  constructor(
    private readonly sink: (event: AgentEvent) => void,
    private readonly steeringEnabled = false,
  ) {}
  submit(task: string): Promise<LoopOutcome> {
    this.active = true;
    this.sink({ kind: 'turn_start', turn: 1 });
    this.sink({
      kind: 'user_message',
      turn: 1,
      message: { role: 'user', content: { kind: 'text', text: task } },
    });
    this.sink({
      kind: 'tool_call',
      turn: 1,
      call: { callId: 'progress', name: 'bash', arguments: {} },
    });
    this.sink({
      kind: 'tool_progress',
      turn: 1,
      callId: 'progress',
      name: 'bash',
      text: 'live output',
    });
    return new Promise((resolve) =>
      this.pending = (outcome) => {
        this.active = false;
        resolve(outcome);
      }
    );
  }
  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    // The pending promise models a TERM-ignoring tool: cancellation is only observed when the
    // explicit completion gate is opened below.
    if (!this.active) return 'idle';
    if (this.cancellationRequested) return 'already_requested';
    this.cancellationRequested = true;
    this.cancelCount += 1;
    return 'requested';
  }
  steerActiveTurn(text: string): 'accepted' | 'already_accepted' | 'idle' {
    if (!this.steeringEnabled) return 'idle';
    if (!this.active) return 'idle';
    if (this.steering.length > 0) return 'already_accepted';
    this.steering.push(text);
    return 'accepted';
  }
  complete(): void {
    const resolve = this.pending;
    this.pending = null;
    if (resolve === null) return;
    this.settled = true;
    this.sink({ kind: 'turn_end', turn: 1, outcome: 'cancelled', committed: false });
    resolve(cancelledOutcome('progress task'));
  }

  emitLateProgress(): void {
    this.sink({
      kind: 'tool_progress',
      turn: 1,
      callId: 'progress',
      name: 'bash',
      text: 'late output',
    });
  }
}

class AssistantProgressSession {
  private pending:
    | {
      readonly resolve: (outcome: LoopOutcome) => void;
      readonly reject: (error: unknown) => void;
      readonly task: string;
    }
    | null = null;
  private active = false;
  private cancellationRequested = false;
  firstProgress = false;
  lateProgressRejected = false;
  cancelCount = 0;
  constructor(private readonly sink: (event: AgentEvent) => void) {}
  submit(task: string): Promise<LoopOutcome> {
    this.active = true;
    this.sink({ kind: 'turn_start', turn: 1 });
    this.sink({
      kind: 'user_message',
      turn: 1,
      message: { role: 'user', content: { kind: 'text', text: task } },
    });
    this.sink({ kind: 'assistant_progress', turn: 1, text: 'first chunk' });
    this.firstProgress = true;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, task };
    });
  }
  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (!this.active) return 'idle';
    if (this.cancellationRequested) return 'already_requested';
    this.cancellationRequested = true;
    this.cancelCount += 1;
    return 'requested';
  }
  emitSecondAndFinish(): void {
    const pending = this.pending;
    if (pending === null) return;
    try {
      this.sink({ kind: 'assistant_progress', turn: 1, text: 'second chunk' });
      this.sink({
        kind: 'assistant_message',
        turn: 1,
        message: { role: 'assistant', content: { kind: 'text', text: 'assistant final' } },
      });
      this.sink({ kind: 'turn_end', turn: 1, outcome: 'final', committed: true });
      this.active = false;
      this.pending = null;
      pending.resolve(finalOutcome(pending.task, 'assistant final'));
    } catch (error) {
      this.active = false;
      this.pending = null;
      pending.reject(error);
    }
  }
  completeCancelled(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.active = false;
    this.pending = null;
    this.sink({ kind: 'turn_end', turn: 1, outcome: 'cancelled', committed: false });
    pending.resolve(cancelledOutcome(pending.task));
  }
  emitLateProgress(): void {
    try {
      this.sink({ kind: 'assistant_progress', turn: 1, text: 'late chunk' });
    } catch {
      this.lateProgressRejected = true;
    }
  }
}

class SteeringSession {
  readonly submitted: string[] = [];
  readonly steered: string[] = [];
  cancelCount = 0;
  private resolveTurn: ((outcome: LoopOutcome) => void) | null = null;
  private accepted = false;
  private cancellationRequested = false;
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
    return new Promise((resolve) => this.resolveTurn = resolve);
  }
  steerActiveTurn(text: string): 'accepted' | 'idle' | 'already_accepted' {
    if (this.resolveTurn === null) return 'idle';
    if (this.accepted) return 'already_accepted';
    this.accepted = true;
    this.steered.push(text);
    return 'accepted';
  }
  cancelActiveTurn(): 'requested' | 'idle' | 'already_requested' {
    if (this.resolveTurn === null) return 'idle';
    if (this.cancellationRequested) return 'already_requested';
    this.cancellationRequested = true;
    this.cancelCount += 1;
    return 'requested';
  }
  complete(): void {
    const resolve = this.resolveTurn;
    if (resolve === null) return;
    this.resolveTurn = null;
    if (this.accepted) {
      this.sink({
        kind: 'steering_message',
        turn: 1,
        message: { role: 'user', content: { kind: 'text', text: this.steered[0] } },
      });
    }
    this.sink({
      kind: 'assistant_message',
      turn: 1,
      message: { role: 'assistant', content: { kind: 'text', text: 'answer' } },
    });
    this.sink({ kind: 'turn_end', turn: 1, outcome: 'final', committed: true });
    resolve(finalOutcome('task', 'answer'));
  }
  completeCancelled(): void {
    const resolve = this.resolveTurn;
    if (resolve === null) return;
    this.resolveTurn = null;
    this.sink({ kind: 'turn_end', turn: 1, outcome: 'cancelled', committed: false });
    resolve(cancelledOutcome('task'));
  }
}

class QueueSession {
  readonly submitted: string[] = [];
  readonly steered: string[] = [];
  cancelCount = 0;
  settled = false;
  private pending:
    | {
      readonly turn: number;
      readonly task: string;
      readonly resolve: (outcome: LoopOutcome) => void;
      readonly reject: (error: unknown) => void;
    }
    | null = null;
  private steeringAccepted = false;
  constructor(private readonly sink: (event: AgentEvent) => void) {}
  submit(task: string): Promise<LoopOutcome> {
    if (this.pending !== null) throw new Error('concurrent submit');
    const turn = this.submitted.length + 1;
    this.submitted.push(task);
    this.steeringAccepted = false;
    this.sink({ kind: 'turn_start', turn });
    this.sink({
      kind: 'user_message',
      turn,
      message: { role: 'user', content: { kind: 'text', text: task } },
    });
    return new Promise((resolve, reject) => this.pending = { turn, task, resolve, reject });
  }
  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (this.pending === null) return 'idle';
    if (this.cancelCount > 0) return 'already_requested';
    this.cancelCount += 1;
    return 'requested';
  }
  steerActiveTurn(text: string): 'accepted' | 'already_accepted' | 'idle' {
    if (this.pending === null) return 'idle';
    if (this.steeringAccepted) return 'already_accepted';
    this.steeringAccepted = true;
    this.steered.push(text);
    return 'accepted';
  }
  finish(finalText = 'answer'): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    try {
      if (this.steeringAccepted) {
        this.sink({
          kind: 'steering_message',
          turn: pending.turn,
          message: { role: 'user', content: { kind: 'text', text: this.steered.at(-1)! } },
        });
      }
      this.sink({
        kind: 'assistant_message',
        turn: pending.turn,
        message: { role: 'assistant', content: { kind: 'text', text: finalText } },
      });
      this.sink({ kind: 'turn_end', turn: pending.turn, outcome: 'final', committed: true });
      this.settled = true;
      pending.resolve(finalOutcome(pending.task, finalText));
    } catch (error) {
      this.settled = true;
      pending.reject(error);
    }
  }
  finishCancelled(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.settled = true;
    this.sink({ kind: 'turn_end', turn: pending.turn, outcome: 'cancelled', committed: false });
    pending.resolve(cancelledOutcome(pending.task));
  }
  finishFailure(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.settled = true;
    pending.resolve({
      ok: false,
      task: pending.task,
      outcome: 'contract_failure',
      stopReason: 'contract_failure',
      error: 'queue fixture failure',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    });
  }
  finishDiagnosticFailure(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.settled = true;
    pending.resolve({
      ok: false,
      task: pending.task,
      outcome: 'contract_failure',
      stopReason: 'contract_failure',
      // The controller must render only the typed diagnostic, never this core-only detail.
      error: 'provider response unsafe marker',
      diagnostic: responseParseDiagnostic,
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    });
  }
  finishMaxSteps(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.settled = true;
    this.sink({ kind: 'turn_end', turn: pending.turn, outcome: 'max_steps', committed: false });
    pending.resolve({
      ok: false,
      task: pending.task,
      outcome: 'max_steps',
      stopReason: 'max_steps',
      error: 'queue fixture max steps',
      steps: 8,
      toolCallCount: 8,
      toolResultCount: 8,
      transcript: [],
    });
  }
  finishError(error: unknown): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.settled = true;
    pending.reject(error);
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const waitForSubmitted = async (session: QueueSession, count: number): Promise<void> => {
  for (let attempt = 0; attempt < 20 && session.submitted.length < count; attempt += 1) {
    await tick();
  }
  assertEquals(session.submitted.length, count);
};

const navigationPosition = (id: string, turn = 1): NavigationPosition => ({
  sessionId: id,
  agent: 'default',
  committedTurn: turn,
  messageCount: turn * 2,
});

const navigationRow = (id: string, current: boolean): NavigationListing['sessions'][number] => ({
  id,
  agent: 'default',
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:01.000Z',
  turnCount: 1,
  messageCount: 2,
  current,
  resumed: current,
  mismatch: false,
});

const navigationSession = (id: string, turn = 1): TuiSessionLike => ({
  submit: () => Promise.resolve(finalOutcome('navigation task')),
  currentPosition: () => navigationPosition(id, turn),
  contextSnapshot: () => undefined,
});

const delayedTypedNavigation = () => {
  const currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let started = false;
  let aborted = false;
  let settled = false;
  const oldClosed = false;
  const targetOwned = false;
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () =>
      Promise.resolve({
        sessions: [navigationRow(currentId, true), navigationRow(targetId, false)],
        skippedInvalid: 0,
      }),
    switchTo: (id, signal) => {
      assertEquals(id, targetId);
      started = true;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          setTimeout(() => {
            settled = true;
            reject(new NavigationCancelledError());
          }, 8);
        }, { once: true });
      });
    },
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => navigationPosition(currentId),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const adapter = new TuiPresentationAdapter(
    { submit: () => Promise.resolve(finalOutcome('navigation task')) },
    (event) => renderer.eventSink(event),
    navigation,
  );
  const controller = new TuiController(
    lifecycle,
    renderer,
    adapter,
    {
      pending: new PendingInputCore(),
      history: new TuiEditorHistory(),
      intents: adapter,
    },
  );
  const begin = async (): Promise<{ readonly running: Promise<number> }> => {
    controller.installSignals();
    await lifecycle.acquire();
    const running = controller.run();
    terminal.push('\x07');
    await tick();
    terminal.push('\x1b[B');
    await tick();
    terminal.push('\r');
    await tick();
    assert(started);
    return { running };
  };
  return {
    currentId,
    terminal,
    controller,
    begin,
    get aborted() {
      return aborted;
    },
    get settled() {
      return settled;
    },
    get oldClosed() {
      return oldClosed;
    },
    get targetOwned() {
      return targetOwned;
    },
  };
};

const historyPageFixture = (
  page: number,
  turn: number,
  totalTurns = 2,
): SessionHistoryPage => ({
  sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  agent: 'default',
  turn,
  totalTurns,
  page,
  pageCount: 2,
  entries: [{ turn, role: 'user', messageIndex: 0, text: `history-${page}` }],
  sourceBytes: 10,
  omitted: false,
});

Deno.test('typed navigation Escape aborts before old close and settles the adapter operation', async () => {
  const fixture = delayedTypedNavigation();
  const { running } = await fixture.begin();
  fixture.terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assertEquals(fixture.aborted, true);
  fixture.terminal.push('\x04');
  assertEquals(await running, 0);
  assertEquals(fixture.aborted, true);
  assertEquals(fixture.settled, true);
  assertEquals(fixture.oldClosed, false);
  assertEquals(fixture.targetOwned, false);
  assertEquals(fixture.controller.currentState, 'exiting');
  assertEquals(fixture.terminal.raw.filter((mode) => mode === false).length, 1);
  assert(fixture.terminal.output().includes('session picker'));
});

Deno.test('typed navigation EOF aborts and settles before input-failure restoration', async () => {
  const fixture = delayedTypedNavigation();
  const { running } = await fixture.begin();
  fixture.terminal.endInput();
  await tick();
  assertEquals(fixture.aborted, true);
  let thrown: unknown;
  try {
    await running;
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof TuiControllerError);
  assertEquals((thrown as TuiControllerError).code, 'input_failure');
  assertEquals(fixture.aborted, true);
  assertEquals(fixture.settled, true);
  assertEquals(fixture.oldClosed, false);
  assertEquals(fixture.targetOwned, false);
  assertEquals(fixture.terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('typed navigation signal aborts and settles before signal restoration', async () => {
  const fixture = delayedTypedNavigation();
  const { running } = await fixture.begin();
  fixture.terminal.emitSignal('SIGTERM');
  await tick();
  assertEquals(fixture.aborted, true);
  assertEquals(await running, 143);
  assertEquals(fixture.aborted, true);
  assertEquals(fixture.settled, true);
  assertEquals(fixture.oldClosed, false);
  assertEquals(fixture.targetOwned, false);
  assertEquals(fixture.terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('typed navigation output failure aborts and settles before restoration', async () => {
  const fixture = delayedTypedNavigation();
  const { running } = await fixture.begin();
  void running.catch(() => {
    // Observe the expected fatal result before the delayed output-failure path settles.
  });
  fixture.terminal.failNextWrite = true;
  fixture.terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assertEquals(fixture.aborted, true);
  let thrown: unknown;
  try {
    await running;
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof TuiControllerError);
  assertEquals((thrown as TuiControllerError).code, 'output_failure');
  assertEquals(fixture.aborted, true);
  assertEquals(fixture.settled, true);
  assertEquals(fixture.oldClosed, false);
  assertEquals(fixture.targetOwned, false);
  assertEquals(fixture.terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('production controller picker renders full UUIDs and resumes the visible page target', async () => {
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999',
  ];
  let switched: string | undefined;
  let currentId = ids[0];
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () =>
      Promise.resolve({
        sessions: ids.map((id, index) => navigationRow(id, index === 0)),
        skippedInvalid: 0,
      }),
    switchTo: (id): Promise<NavigationBinding> => {
      switched = id;
      currentId = id;
      return Promise.resolve({
        session: navigationSession(id),
        position: navigationPosition(id),
        restored: { messages: [], omitted: 0 },
      });
    },
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => navigationPosition(currentId),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    navigationSession(currentId),
    { pending: new PendingInputCore(), history: new TuiEditorHistory(), navigation },
  );
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x07');
  await tick();
  assert(terminal.output().includes(ids[0]));
  terminal.push('\x1b[C');
  await tick();
  assert(terminal.output().includes(`page 2/2`));
  assert(terminal.output().includes(`> ${ids[8]}`));
  terminal.push('\r');
  await tick();
  assertEquals(switched, ids[8]);
  terminal.push('\x04');
  await tick();
  terminal.push('\x04');
  assertEquals(await running, 0);
});

Deno.test('production controller treats restored-render failure after switch as fatal', async () => {
  const currentId = '12121212-1212-4121-8121-121212121212';
  const targetId = '34343434-3434-4343-8343-343434343434';
  const terminalRef = new FakeTerminal();
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () =>
      Promise.resolve({
        sessions: [navigationRow(currentId, true), navigationRow(targetId, false)],
        skippedInvalid: 0,
      }),
    switchTo: (id): Promise<NavigationBinding> => {
      terminalRef.failNextWrite = true;
      return Promise.resolve({
        session: navigationSession(id),
        position: navigationPosition(id),
        restored: { messages: [], omitted: 0 },
      });
    },
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => navigationPosition(currentId),
  };
  const renderer = new TuiRenderer(terminalRef);
  const lifecycle = new TerminalLifecycle(terminalRef, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    navigationSession(currentId),
    { pending: new PendingInputCore(), history: new TuiEditorHistory(), navigation },
  );
  await lifecycle.acquire();
  const running = controller.run();
  terminalRef.push('\x07');
  await tick();
  terminalRef.push('\x1b[B');
  await tick();
  terminalRef.push('\r');
  await tick();
  assertEquals(await running, 1);
  assertEquals(controller.currentState, 'failed');
  assertEquals(terminalRef.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('production controller settles a delayed navigation switch before signal restoration', async () => {
  const currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let release: (() => void) | undefined;
  let switched = false;
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () =>
      Promise.resolve({
        sessions: [navigationRow(currentId, true), navigationRow(targetId, false)],
        skippedInvalid: 0,
      }),
    switchTo: (id) =>
      new Promise((resolve) => {
        release = () => {
          switched = true;
          resolve({ session: navigationSession(id), position: navigationPosition(id) });
        };
      }),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => navigationPosition(currentId),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    navigationSession(currentId),
    { pending: new PendingInputCore(), history: new TuiEditorHistory(), navigation },
  );
  controller.installSignals();
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x07');
  await tick();
  terminal.push('\x1b[B');
  await tick();
  terminal.push('\r');
  await tick();
  terminal.emitSignal('SIGTERM');
  await tick();
  assertEquals(switched, false);
  assertEquals(terminal.raw, [true]);
  release?.();
  assertEquals(await running, 143);
  assert(switched);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('dismissed delayed switch remains owned across a new picker and aborts before any late swap', async () => {
  const currentId = 'abababab-abab-4aba-8aba-abababababab';
  const targetId = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd';
  let switchAborted = false;
  let switchSettled = false;
  let releaseSwitch: (() => void) | undefined;
  const currentBinding = currentId;
  let targetOwned = false;
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () =>
      Promise.resolve({
        sessions: [navigationRow(currentId, true), navigationRow(targetId, false)],
        skippedInvalid: 0,
      }),
    switchTo: (_id, signal) =>
      new Promise((_resolve, reject) => {
        releaseSwitch = () => {
          switchSettled = true;
          reject(new NavigationCancelledError());
        };
        signal?.addEventListener('abort', () => {
          switchAborted = true;
          targetOwned = false;
        }, { once: true });
      }),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => navigationPosition(currentBinding),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  let lateRestore = false;
  const renderRestored = renderer.renderRestored.bind(renderer);
  renderer.renderRestored = (...args) => {
    lateRestore = true;
    renderRestored(...args);
  };
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    navigationSession(currentId),
    { pending: new PendingInputCore(), history: new TuiEditorHistory(), navigation },
  );
  controller.installSignals();
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x07');
  await tick();
  terminal.push('\x1b[B');
  await tick();
  terminal.push('\r');
  await tick();
  terminal.push('\x1b\x07');
  await tick();
  terminal.emitSignal('SIGTERM');
  assertEquals(switchAborted, true);
  assertEquals(currentBinding, currentId);
  assertEquals(terminal.raw, [true]);
  releaseSwitch?.();
  assertEquals(await running, 143);
  assertEquals(switchSettled, true);
  assertEquals(targetOwned, false);
  assertEquals(currentBinding, currentId);
  assertEquals(lateRestore, false);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('production controller settles delayed compaction before signal restoration', async () => {
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let aborted = false;
  let release: (() => void) | undefined;
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    contextSnapshot: () => undefined,
    contextCompactionPreview: () => ({
      useful: true,
      currentTurn: 2,
      proposed: { coveredThroughTurn: 1, retainedFromTurn: 2 },
      baselineMessagesBytes: 200,
      projectedMessagesBytes: 100,
    }),
    compactContext: (signal) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () => aborted = true, { once: true });
        release = () => resolve({ kind: 'cancelled' });
      }),
    currentPosition: () => navigationPosition(id, 2),
  };
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () => Promise.resolve({ sessions: [navigationRow(id, true)], skippedInvalid: 0 }),
    switchTo: () => Promise.resolve({ session, position: navigationPosition(id, 2) }),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => navigationPosition(id, 2),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory(), navigation },
  );
  controller.installSignals();
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x0b');
  await tick();
  assert(terminal.output().includes('context recovery'));
  terminal.push('\r');
  await tick();
  assertEquals(controller.currentState, 'compacting');
  terminal.emitSignal('SIGTERM');
  await tick();
  assert(aborted);
  assertEquals(terminal.raw, [true]);
  release?.();
  assertEquals(await running, 143);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('production controller turns compaction cleanup failure into a fatal settled exit', async () => {
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  let rejectCleanup: ((error: unknown) => void) | undefined;
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    contextSnapshot: () => undefined,
    contextCompactionPreview: () => ({
      useful: true,
      currentTurn: 2,
      proposed: { coveredThroughTurn: 1, retainedFromTurn: 2 },
    }),
    compactContext: (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => rejectCleanup = reject, { once: true });
      }),
    currentPosition: () => navigationPosition(id, 2),
  };
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () => Promise.resolve({ sessions: [navigationRow(id, true)], skippedInvalid: 0 }),
    switchTo: () => Promise.resolve({ session, position: navigationPosition(id, 2) }),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => navigationPosition(id, 2),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory(), navigation },
  );
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x0b');
  await tick();
  assert(terminal.output().includes('context recovery'));
  terminal.push('\r');
  await tick();
  assertEquals(controller.currentState, 'compacting');
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(rejectCleanup !== undefined);
  rejectCleanup?.(new CancellationCleanupError());
  assertEquals(await running, 1);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

const runDelayedCompactionFailure = async (
  kind: 'eof' | 'input' | 'output' | 'crash',
): Promise<void> => {
  const id = 'efefefef-efef-4efe-8efe-efefefefefef';
  let aborted = false;
  let release: (() => void) | undefined;
  let settled = false;
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    contextCompactionPreview: () => ({
      useful: true,
      currentTurn: 2,
      proposed: { coveredThroughTurn: 1, retainedFromTurn: 2 },
    }),
    compactContext: (signal) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          release = () => {
            settled = true;
            resolve({ kind: 'cancelled' });
          };
        }, { once: true });
      }),
    currentPosition: () => navigationPosition(id, 2),
  };
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () => Promise.resolve({ sessions: [navigationRow(id, true)], skippedInvalid: 0 }),
    switchTo: () => Promise.resolve({ session, position: navigationPosition(id, 2) }),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => navigationPosition(id, 2),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory(), navigation },
  );
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x0b');
  await tick();
  terminal.push('\r');
  await tick();
  assertEquals(controller.currentState, 'compacting');
  if (kind === 'eof') {
    terminal.endInput();
  } else if (kind === 'input') {
    terminal.failRead = true;
    terminal.push('ignored while compacting');
  } else if (kind === 'output') {
    terminal.failNextWrite = true;
    terminal.push('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 60));
  } else {
    controller.handleCrash();
  }
  await tick();
  assert(aborted);
  assert(release !== undefined);
  assertEquals(terminal.raw, [true]);
  assert(!renderer.isClosing);
  release?.();
  let failure: unknown;
  try {
    const code = await running;
    assertEquals(code, kind === 'crash' ? 1 : 0);
  } catch (error) {
    failure = error;
  }
  if (kind === 'crash') assertEquals(failure, undefined);
  else {
    assert(failure instanceof TuiControllerError);
    assertEquals(
      (failure as TuiControllerError).code,
      kind === 'output' ? 'output_failure' : 'input_failure',
    );
  }
  assert(settled);
  assert(renderer.isClosing);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
};

Deno.test('EOF aborts delayed compaction before awaiting settlement and restoration', async () => {
  await runDelayedCompactionFailure('eof');
});

Deno.test('input failure aborts delayed compaction before awaiting settlement and restoration', async () => {
  await runDelayedCompactionFailure('input');
});

Deno.test('output failure aborts delayed compaction before awaiting settlement and restoration', async () => {
  await runDelayedCompactionFailure('output');
});

Deno.test('crash aborts delayed compaction before awaiting settlement and restoration', async () => {
  await runDelayedCompactionFailure('crash');
});

Deno.test('ephemeral Ctrl-T opens the latest committed turn from the session position', async () => {
  const requested: number[] = [];
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    currentPosition: () => navigationPosition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 2),
    historyPage: (page, turn) => {
      requested.push(turn ?? 0);
      return {
        sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        agent: 'default',
        turn: turn ?? 0,
        totalTurns: 2,
        page,
        pageCount: 1,
        entries: [],
        sourceBytes: 0,
        omitted: false,
      };
    },
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory() },
  );
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x14');
  await tick();
  assertEquals(requested, [2]);
  assert(terminal.output().includes('turn 2/2'));
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  terminal.push('\x04');
  assertEquals(await running, 0);
});

Deno.test('history modal owns loads across dismiss and ignores a late page', async () => {
  let release: ((page: SessionHistoryPage) => void) | undefined;
  let rendered = 0;
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    currentPosition: () => navigationPosition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 2),
    historyPage: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.renderHistoryPage = () => rendered += 1;
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory() },
  );
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x14');
  await tick();
  await tick();
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  release?.(historyPageFixture(0, 2));
  await tick();
  assertEquals(rendered, 0);
  terminal.push('\x04');
  assertEquals(await running, 0);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('history page generations prevent a reversed late result from overwriting the newest page', async () => {
  const releases: Array<(page: SessionHistoryPage) => void> = [];
  const rendered: string[] = [];
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    currentPosition: () => navigationPosition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 2),
    historyPage: () => new Promise((resolve) => releases.push(resolve)),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.renderHistoryPage = (page) => rendered.push(page.entries[0]?.text ?? '');
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory() },
  );
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x14');
  await tick();
  assertEquals(releases.length, 1);
  releases[0](historyPageFixture(0, 2));
  await tick();
  terminal.push('\x1b[B');
  await tick();
  assertEquals(releases.length, 2);
  terminal.push('\x1b[A');
  await tick();
  assertEquals(releases.length, 3);
  releases[1](historyPageFixture(1, 2));
  await tick();
  releases[2](historyPageFixture(0, 2));
  await tick();
  assertEquals(rendered, ['history-0', 'history-0']);
  terminal.push('\x1b');
  await tick();
  terminal.push('\x04');
  assertEquals(await running, 0);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('history loads settle before SIGTERM restoration and do not render', async () => {
  let release: ((page: SessionHistoryPage) => void) | undefined;
  let rendered = 0;
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    currentPosition: () => navigationPosition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 2),
    historyPage: () => new Promise((resolve) => release = resolve),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.renderHistoryPage = () => rendered += 1;
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory() },
  );
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('\x14');
  await tick();
  terminal.emitSignal('SIGTERM');
  await tick();
  release?.(historyPageFixture(0, 2));
  assertEquals(await running, 143);
  assertEquals(rendered, 0);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('history loads settle before EOF failure and do not render', async () => {
  let release: ((page: SessionHistoryPage) => void) | undefined;
  let rendered = 0;
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    currentPosition: () => navigationPosition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 2),
    historyPage: () => new Promise((resolve) => release = resolve),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.renderHistoryPage = () => rendered += 1;
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory() },
  );
  await lifecycle.acquire();
  const running = controller.run();
  const settled = running.then(
    (value) => ({ exit: value } as const),
    (error) => ({ error } as const),
  );
  terminal.push('\x14');
  await tick();
  terminal.endInput();
  await tick();
  release?.(historyPageFixture(0, 2));
  const outcome = await settled;
  assert('error' in outcome);
  assert(outcome.error instanceof TuiControllerError);
  assertEquals((outcome.error as TuiControllerError).code, 'input_failure');
  assertEquals(rendered, 0);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('history, context preview, and post-install status delivery failures are fatal', async () => {
  const makeNavigation = (session: TuiSessionLike): SessionNavigationHost => ({
    persistent: true,
    list: () => Promise.resolve({ sessions: [], skippedInvalid: 0 }),
    switchTo: () =>
      Promise.resolve({
        session,
        position: navigationPosition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 2),
      }),
    historyPage: (page, turn) =>
      session.historyPage?.(page, turn, 16) as Promise<SessionHistoryPage>,
    currentPosition: () => navigationPosition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 2),
  });
  const runFailure = async (
    kind: 'history' | 'preview' | 'post-install',
  ): Promise<void> => {
    let installed = false;
    const session: TuiSessionLike = {
      submit: () => Promise.resolve(finalOutcome('unused')),
      currentPosition: () => navigationPosition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 2),
      historyPage: () => Promise.resolve(historyPageFixture(0, 2)),
      contextCompactionPreview: () => ({
        useful: true,
        currentTurn: 2,
        proposed: { coveredThroughTurn: 1, retainedFromTurn: 2 },
        baselineMessagesBytes: 200,
        projectedMessagesBytes: 100,
      }),
      compactContext: () => {
        installed = true;
        return Promise.resolve({ kind: 'installed', coveredThroughTurn: 1, retainedFromTurn: 2 });
      },
    };
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const originalHistory = renderer.renderHistoryPage.bind(renderer);
    const originalContext = renderer.renderContextPanel.bind(renderer);
    const originalStatus = renderer.setStatus.bind(renderer);
    if (kind === 'history') {
      renderer.renderHistoryPage = () => {
        throw new EventDeliveryError();
      };
    }
    if (kind === 'preview') {
      renderer.renderContextPanel = () => {
        throw new EventDeliveryError();
      };
    }
    if (kind === 'post-install') {
      renderer.setStatus = (status) => {
        if (status.startsWith('context checkpoint')) throw new EventDeliveryError();
        originalStatus(status);
      };
    }
    // Keep the bound methods referenced so this test continues to type-check if renderer hooks
    // become optional in a future controller-facing interface.
    void originalHistory;
    void originalContext;
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const controller = new TuiController(
      lifecycle,
      renderer,
      session,
      {
        pending: new PendingInputCore(),
        history: new TuiEditorHistory(),
        navigation: makeNavigation(session),
      },
    );
    await lifecycle.acquire();
    const running = controller.run();
    const settled = running.then(
      (value) => ({ exit: value } as const),
      (error) => ({ error } as const),
    );
    terminal.push(kind === 'history' ? '\x14' : '\x0b');
    await tick();
    if (kind === 'post-install') terminal.push('\r');
    const outcome = await settled;
    if ('error' in outcome) {
      assert(outcome.error instanceof TuiControllerError);
      assertEquals((outcome.error as TuiControllerError).code, 'output_failure');
    } else assertEquals(outcome.exit, 1);
    if (kind === 'post-install') assert(installed);
    assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
  };
  await runFailure('history');
  await runFailure('preview');
  await runFailure('post-install');
});

Deno.test('ready status projects checkpoint boundary and semantic estimate without summary text', async () => {
  const summary = 'secret semantic checkpoint summary';
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const session: TuiSessionLike = {
    submit: () => Promise.resolve(finalOutcome('unused')),
    contextSnapshot: () => ({
      messageEstimatedTokensAfter: 1_024,
      messageEstimatedTokensBefore: 1_024,
      toolEstimatedTokens: 0,
      requestEstimatedTokensBefore: 1_024,
      requestEstimatedTokensAfter: 1_024,
      triggerTokens: 65_536,
      targetTokens: 49_152,
      triggered: false,
      targetReached: false,
      compressedResultCount: 0,
      compressedMessageCount: 0,
    }),
    currentPosition: () => ({
      ...navigationPosition(id, 3),
      checkpoint: { coveredThroughTurn: 2, retainedFromTurn: 3, projectedMessagesBytes: 12345 },
    }),
    checkpointSnapshot: () => ({ summary, coveredThroughTurn: 2, retainedFromTurn: 3 }),
  };
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () => Promise.resolve({ sessions: [], skippedInvalid: 0 }),
    switchTo: () => Promise.resolve({ session, position: navigationPosition(id, 3) }),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => ({
      ...navigationPosition(id, 3),
      checkpoint: { coveredThroughTurn: 2, retainedFromTurn: 3, projectedMessagesBytes: 12345 },
    }),
  };
  const controller = new TuiController(
    lifecycle,
    renderer,
    session,
    { pending: new PendingInputCore(), history: new TuiEditorHistory(), navigation },
  );
  await lifecycle.acquire();
  const running = controller.run();
  await tick();
  assert(terminal.output().includes('session ffffffff · agent default · turn 3'));
  assert(terminal.output().includes('context through 2 · retain 3+ · semantic ≤12345B'));
  assert(!terminal.output().includes(summary));
  terminal.push('\x04');
  assertEquals(await running, 0);
});

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

Deno.test('busy Alt+Enter queues one ordinary turn after durable settlement with no ready gap', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  await tick();
  terminal.push('queued\x1b\r');
  await tick();
  assertEquals(session.submitted, ['manual']);
  assertEquals(controller.editor.text, '');
  assert(terminal.output().includes('busy · follow-up queued'));
  assert(!terminal.output().includes('user> queued'));
  const beforeSettlement = terminal.writes.length;
  session.finish('manual answer');
  await waitForSubmitted(session, 2);
  const settlementOutput = terminal.writes.slice(beforeSettlement).join('');
  assert(settlementOutput.includes('busy · starting follow-up'));
  assert(!settlementOutput.includes('[ready]'));
  assertEquals(session.submitted, ['manual', 'queued']);
  assertEquals((terminal.output().match(/user> queued/g) ?? []).length, 1);

  // The automatic turn consumes the one slot: a second Alt+Enter cannot replenish it, while
  // the fresh ordinary turn still has its independent steering lane.
  terminal.push('third\x1b[27;3;13~');
  await tick();
  assertEquals(controller.editor.text, 'third');
  assert(terminal.output().includes('follow-up slot closed'));
  terminal.push('\n');
  await tick();
  assertEquals(session.steered, ['third']);
  assertEquals(controller.editor.text, '');
  session.finish('queued answer');
  await tick();
  assertEquals(session.submitted, ['manual', 'queued']);
  terminal.push('\x04\x04');
  assertEquals(await running, 0);
});

Deno.test('steering and follow-up lanes admit in either order and compose status without sharing text', async () => {
  for (const order of ['queue-first', 'steer-first'] as const) {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const session = new QueueSession((event) => renderer.eventSink(event));
    const controller = new TuiController(lifecycle, renderer, session);
    await lifecycle.acquire();
    const running = controller.run();
    terminal.push('manual\n');
    await tick();
    if (order === 'queue-first') terminal.push('queued\x1b\r');
    else terminal.push('steer\n');
    await tick();
    if (order === 'queue-first') terminal.push('steer\n');
    else terminal.push('queued\x1b\r');
    await tick();
    assertEquals(controller.editor.text, '');
    assertEquals(session.submitted, ['manual']);
    assertEquals(session.steered, ['steer']);
    session.finish();
    await waitForSubmitted(session, 2);
    assertEquals(session.submitted, ['manual', 'queued']);
    assertEquals((terminal.output().match(/user> queued/g) ?? []).length, 1);
    assert(!terminal.output().includes('user> steer'));
    session.finish();
    await tick();
    terminal.push('\x04');
    assertEquals(await running, 0);
  }
});

Deno.test('follow-up works without steering capability and busy Enter never aliases it', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const full = new QueueSession((event) => renderer.eventSink(event));
  const session = {
    submit: (text: string) => full.submit(text),
    cancelActiveTurn: () => full.cancelActiveTurn(),
  };
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  await tick();
  terminal.push('\n');
  await tick();
  assert(terminal.output().includes('steering unavailable'));
  terminal.push('queued\x1b\r');
  await tick();
  assertEquals(full.submitted, ['manual']);
  full.finish();
  await waitForSubmitted(full, 2);
  assertEquals(full.submitted, ['manual', 'queued']);
  full.finish();
  await tick();
  terminal.push('\x04');
  assertEquals(await running, 0);
});

Deno.test('follow-up admission preserves blank, duplicate, NUL, and bounded editor behavior', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  await tick();
  terminal.push('\x1b\r');
  await tick();
  assert(terminal.output().includes('enter follow-up text'));
  terminal.push('\x1b[200~bad\0paste\x1b[201~');
  await tick();
  assert(terminal.output().includes('invalid steering input'));
  assertEquals(controller.editor.text, '');
  terminal.push('queued\x1b\r');
  await tick();
  terminal.push('draft');
  await tick();
  terminal.push('\x1b\r');
  await tick();
  assertEquals(controller.editor.text, 'draft');
  assert(terminal.output().includes('follow-up already queued'));
  assert(!terminal.output().includes('user> draft'));
  session.finish();
  await waitForSubmitted(session, 2);
  assertEquals(session.submitted, ['manual', 'queued']);
  session.finish();
  await tick();
  terminal.push('\x04');
  assertEquals(await running, 0);
});

Deno.test('signal cancellation drops a pending follow-up before restoration', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  controller.installSignals();
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  await tick();
  terminal.push('queued\x1b\r');
  await tick();
  terminal.emitSignal('SIGTERM');
  await tick();
  session.finishCancelled();
  assertEquals(await running, 143);
  assertEquals(session.submitted, ['manual']);
  assert(!terminal.output().includes('user> queued'));
  assert(renderer.isClosing);
});

Deno.test('follow-up accepts the exact 65,536-byte bracketed-paste boundary atomically', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  await tick();
  terminal.push(`\x1b[200~${'x'.repeat(65_536)}\x1b[201~\x1b\r`);
  await tick();
  assertEquals(session.submitted, ['manual']);
  session.finish();
  await waitForSubmitted(session, 2);
  assertEquals(session.submitted[1].length, 65_536);
  assertEquals(new TextEncoder().encode(session.submitted[1]).byteLength, 65_536);
  session.finish();
  await tick();
  terminal.push('\x04');
  assertEquals(await running, 0);
});

Deno.test('pending follow-up drops on cancellation and failure without a second submission', async () => {
  const cancelledTerminal = new FakeTerminal();
  const cancelledRenderer = new TuiRenderer(cancelledTerminal);
  const cancelledLifecycle = new TerminalLifecycle(cancelledTerminal, cancelledRenderer);
  const cancelledSession = new QueueSession((event) => cancelledRenderer.eventSink(event));
  const cancelledController = new TuiController(
    cancelledLifecycle,
    cancelledRenderer,
    cancelledSession,
  );
  await cancelledLifecycle.acquire();
  const cancelledRun = cancelledController.run();
  cancelledTerminal.push('manual\n');
  await tick();
  cancelledTerminal.push('queued\x1b\r');
  await tick();
  cancelledTerminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(!cancelledTerminal.output().includes('user> queued')); // no pending text disclosure
  cancelledSession.finishCancelled();
  await tick();
  assertEquals(cancelledSession.submitted, ['manual']);
  cancelledTerminal.push('\x04');
  assertEquals(await cancelledRun, 0);

  const failureTerminal = new FakeTerminal();
  const failureRenderer = new TuiRenderer(failureTerminal);
  const failureLifecycle = new TerminalLifecycle(failureTerminal, failureRenderer);
  const failureSession = new QueueSession((event) => failureRenderer.eventSink(event));
  const failureController = new TuiController(failureLifecycle, failureRenderer, failureSession);
  await failureLifecycle.acquire();
  const failureRun = failureController.run();
  failureTerminal.push('manual\n');
  await tick();
  failureTerminal.push('queued\x1b\r');
  await tick();
  failureSession.finishFailure();
  let failure: unknown;
  try {
    await failureRun;
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof TuiControllerError);
  assertEquals((failure as TuiControllerError).code, 'agent_failure');
  assertEquals(failureSession.submitted, ['manual']);
  assert(failureRenderer.isClosing);
});

Deno.test('pending follow-up drops on max steps with one restore and no late writes', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  await tick();
  terminal.push('queued\x1b\r');
  await tick();
  session.finishMaxSteps();

  let failure: unknown;
  try {
    await running;
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof TuiControllerError);
  assertEquals((failure as TuiControllerError).code, 'agent_failure');
  assertEquals(session.submitted, ['manual']);
  assert(renderer.isClosing);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
  assert(!terminal.output().includes('user> queued'));
  const writes = terminal.writes.length;
  let lateRejected = false;
  try {
    renderer.eventSink({ kind: 'assistant_progress', turn: 1, text: 'late max-step output' });
  } catch {
    lateRejected = true;
  }
  assert(lateRejected);
  assertEquals(terminal.writes.length, writes);
});

Deno.test('queue drops on EOF, output/event failure, and cleanup poison after settlement', async () => {
  const runFailureCase = async (kind: 'eof' | 'output' | 'event' | 'cleanup'): Promise<void> => {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const session = new QueueSession((event) => {
      renderer.eventSink(event);
      if (kind === 'event' && event.kind === 'turn_end') throw new EventDeliveryError();
    });
    const controller = new TuiController(lifecycle, renderer, session);
    await lifecycle.acquire();
    const running = controller.run();
    terminal.push('manual\n');
    await tick();
    terminal.push('queued\x1b\r');
    await tick();
    assert(!terminal.output().includes('user> queued'));

    if (kind === 'eof') {
      terminal.endInput();
      for (let attempt = 0; attempt < 20 && session.cancelCount === 0; attempt += 1) await tick();
      assertEquals(session.cancelCount, 1);
      session.finishCancelled();
    } else if (kind === 'cleanup') {
      terminal.push('\x1b');
      await new Promise((resolve) => setTimeout(resolve, 60));
      for (let attempt = 0; attempt < 20 && session.cancelCount === 0; attempt += 1) await tick();
      assertEquals(session.cancelCount, 1);
      session.finishError(new CancellationCleanupError());
    } else {
      if (kind === 'output') terminal.failNextWrite = true;
      session.finish();
    }

    let failure: unknown;
    try {
      await running;
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof TuiControllerError);
    assertEquals(
      (failure as TuiControllerError).code,
      kind === 'eof' ? 'input_failure' : kind === 'cleanup' ? 'agent_failure' : 'output_failure',
    );
    assert(session.settled);
    assertEquals(session.submitted, ['manual']);
    assert(renderer.isClosing);
    assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
    const writes = terminal.writes.length;
    let rejected = false;
    try {
      renderer.eventSink({
        kind: 'tool_progress',
        turn: 1,
        callId: 'late',
        name: 'bash',
        text: 'late queue output',
      });
    } catch (error) {
      rejected = error instanceof EventDeliveryError;
    }
    assert(rejected);
    assertEquals(terminal.writes.length, writes);
    assert(!terminal.output().includes('user> queued'));
  };

  await runFailureCase('eof');
  await runFailureCase('output');
  await runFailureCase('event');
  await runFailureCase('cleanup');
});

Deno.test('successful turn with exit intent drops a queued follow-up before restore', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  await tick();
  terminal.push('queued\x1b\r');
  await tick();
  terminal.push('\x03');
  await tick();
  session.finish('manual answer');
  assertEquals(await running, 0);
  assertEquals(session.submitted, ['manual']);
  assert(renderer.isClosing);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
  assert(!terminal.output().includes('user> queued'));
});

Deno.test('crash drops a pending follow-up before one close and rejects late writes', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  await tick();
  terminal.push('queued\x1b\r');
  await tick();
  controller.handleCrash();
  session.finishError(new Error('injected queue crash'));

  let failure: unknown;
  try {
    await running;
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof TuiControllerError);
  assertEquals((failure as TuiControllerError).code, 'agent_failure');
  assertEquals(session.submitted, ['manual']);
  assert(renderer.isClosing);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
  assert(!terminal.output().includes('user> queued'));
  const writes = terminal.writes.length;
  let lateRejected = false;
  try {
    renderer.eventSink({ kind: 'assistant_progress', turn: 1, text: 'late crash output' });
  } catch {
    lateRejected = true;
  }
  assert(lateRejected);
  assertEquals(terminal.writes.length, writes);
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
  assert(!terminal.output().includes('user> discarded'));
});

Deno.test('busy input admits one steering message and renders it as one escaped record', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new SteeringSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const run = controller.run();
  terminal.push('task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('fix\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(session.steered, ['fix']);
  assertEquals(controller.editor.text, '');
  assert(terminal.output().includes('busy · steer pending'));
  session.complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(terminal.output().includes('steer> fix\n'));
  assert(terminal.output().includes('busy · steer applied'));
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('busy steering paste containing NUL is rejected atomically before editor admission', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new SteeringSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const run = controller.run();
  terminal.push('task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x1b[200~before\0after\x1b[201~');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(controller.editor.text, '');
  assert(terminal.output().includes('invalid steering input'));
  assertEquals(session.steered, []);
  session.complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('controller replaces delayed assistant chunks before one final and restores once', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new AssistantProgressSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('assistant task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(session.firstProgress);
  terminal.push('\x04');
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Ctrl-D is consumed while busy; release the model only after observing the live first chunk.
  session.emitSecondAndFinish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x04');
  assertEquals(await running, 0);
  const output = terminal.output();
  const first = output.indexOf('assistant~ first chunk');
  const second = output.indexOf('assistant~ second chunk');
  const final = output.indexOf('assistant> assistant final');
  assert(first >= 0 && second > first && final > second);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
  session.emitLateProgress();
  assert(session.lateProgressRejected);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('controller settles delayed assistant progress cancellation before restoring once', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new AssistantProgressSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('cancel assistant\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(session.cancelCount, 1);
  session.completeCancelled();
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('\x04');
  assertEquals(await running, 0);
  const output = terminal.output();
  assert(output.includes('assistant~ first chunk'));
  assert(!output.includes('assistant~ second chunk'));
  assert(!output.includes('assistant> assistant final'));
  assert(output.includes('[cancelled]'));
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
  session.emitLateProgress();
  assert(session.lateProgressRejected);
});

Deno.test('controller output failure settles assistant progress and retains one terminal restore', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new AssistantProgressSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('output failure\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.failNextWrite = true;
  session.emitSecondAndFinish();
  let failure: unknown;
  try {
    await running;
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof TuiControllerError);
  assertEquals((failure as TuiControllerError).code, 'output_failure');
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
  const writes = terminal.writes.length;
  session.emitLateProgress();
  assert(session.lateProgressRejected);
  assertEquals(terminal.writes.length, writes);
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

Deno.test('TUI persistence grammar accepts both flag orders and rejects conflicts', () => {
  const session = '11111111-1111-4111-8111-111111111111';
  assertEquals(parseTuiInvocation(['--continue', '--agent', 'planner']), {
    rawAgentName: 'planner',
    persistence: 'continue',
  });
  assertEquals(parseTuiInvocation(['--agent', 'default', '--session', session]), {
    rawAgentName: 'default',
    persistence: 'session',
    sessionId: session,
  });
  assertEquals(parseTuiInvocation(['--no-session']), {
    rawAgentName: undefined,
    persistence: 'none',
  });
  for (
    const args of [
      ['--continue', '--no-session'],
      ['--session', 'not-a-uuid'],
      ['--agent', 'default', 'extra'],
    ]
  ) {
    let failed = false;
    try {
      parseTuiInvocation(args);
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
      return Promise.resolve({ session: connected, displayState: fixtureDisplayState('planner') });
    },
    writeStderr: () => {},
  });
  assertEquals(exit, 0);
  assertEquals(selected, 'planner');
  assertEquals(session.submitted, []);
  assert(terminal.raw.includes(false));
  assert(terminal.readSnapshots.length > 0);
  assert(
    terminal.readSnapshots[0].includes(
      'keys> busy Enter steer · Alt+Enter follow-up · Esc cancel · Ctrl-C/D exit\n',
    ),
  );
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

  const directClearFailure = new FakeTerminal();
  const directClearRenderer = new TuiRenderer(directClearFailure);
  const directClearLifecycle = new TerminalLifecycle(directClearFailure, directClearRenderer);
  await directClearLifecycle.acquire();
  directClearLifecycle.addSignals({ SIGINT: () => {}, SIGTERM: () => {}, SIGHUP: () => {} });
  directClearFailure.failWrites.add('\r\x1b[2K');
  await directClearLifecycle.restore();
  assertEquals(directClearLifecycle.restoreStatus(), 'failed');
  assert(directClearFailure.operations.includes('drain'));
  assert(directClearFailure.raw.includes(false));
  assert(directClearFailure.signals.includes('-SIGINT'));
  assert(directClearFailure.signals.includes('-SIGTERM'));
  assert(directClearFailure.signals.includes('-SIGHUP'));

  const liveClearFailure = new FakeTerminal();
  liveClearFailure.failWrites.add('\r\x1b[2K');
  let liveClearStderr = '';
  const liveClearExit = await tuiMain([], {
    terminal: liveClearFailure,
    createSession: () => {
      setTimeout(() => liveClearFailure.push('\x04'), 0);
      return Promise.resolve({
        session: new FakeSession(() => {}),
        displayState: fixtureDisplayState(),
      });
    },
    writeStderr: (text) => {
      liveClearStderr += text;
    },
  });
  assertEquals(liveClearExit, 1);
  assertEquals(
    liveClearStderr.split('\n').filter((line) => line.includes('"code":"terminal_failure"')).length,
    1,
  );
  assertEquals(liveClearFailure.raw.filter((mode) => mode === false).length, 1);
  assert(liveClearFailure.signals.includes('-SIGINT'));
  assert(liveClearFailure.signals.includes('-SIGTERM'));
  assert(liveClearFailure.signals.includes('-SIGHUP'));

  const cliFailure = new FakeTerminal();
  cliFailure.failWrites.add(BRACKETED_PASTE_ON);
  const cliRendererSession = new FakeSession(() => {});
  let stderr = '';
  const cliExit = await tuiMain([], {
    terminal: cliFailure,
    createSession: () =>
      Promise.resolve({ session: cliRendererSession, displayState: fixtureDisplayState() }),
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

Deno.test('busy cancellation clears live progress before settled status and ignores no late redraw', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new ProgressSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('progress task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(terminal.output().includes('tool~ bash live output'));
  const beforeCancel = terminal.writes.length;
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(terminal.writes.slice(beforeCancel).every((write) => !write.includes('tool~')));
  session.complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(terminal.output().includes('[cancelled]'));
  terminal.push('\x04');
  assertEquals(await running, 0);
});

Deno.test('busy cancellation clears steering draft before status for Escape, Ctrl-C, and signals', async () => {
  for (
    const [action, expectedExit] of [
      ['escape', 0],
      ['ctrl_c', 0],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const
  ) {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const session = new ProgressSession((event) => renderer.eventSink(event), true);
    const controller = new TuiController(lifecycle, renderer, session);
    if (action === 'SIGTERM' || action === 'SIGHUP') controller.installSignals();
    await lifecycle.acquire();
    const running = controller.run();
    terminal.push('steering task\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    terminal.push('draft');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(controller.editor.text, 'draft');
    const beforeCancel = terminal.operations.length;
    if (action === 'escape') {
      terminal.push('\x1b');
      await new Promise((resolve) => setTimeout(resolve, 60));
    } else if (action === 'ctrl_c') {
      terminal.push('\x03');
    } else terminal.emitSignal(action);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(controller.editor.text, '');
    assertEquals(session.cancelCount, 1);
    const status = terminal.operations.findIndex((operation, index) =>
      index >= beforeCancel &&
      operation.includes(action === 'escape' ? '[cancelling]' : '[cancelling; exiting]')
    );
    assert(status >= 0);
    session.complete();
    if (action === 'escape') terminal.push('\x04');
    assertEquals(await running, expectedExit);
    const writesAfterRestore = terminal.writes.length;
    try {
      session.emitLateProgress();
    } catch {
      // Closed renderer rejects a late event before any terminal write.
    }
    assertEquals(terminal.writes.length, writesAfterRestore);
  }
});

Deno.test('steering editor clear failure is output_failure and settles before one restore', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new SteeringSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.push('fix');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(controller.editor.text, 'fix');
  terminal.failNextWrite = true;
  terminal.push('\n');
  const settle = (async () => {
    while (session.cancelCount === 0) await Promise.resolve();
    session.completeCancelled();
  })();
  let failure: unknown;
  try {
    await running;
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof TuiControllerError);
  assertEquals((failure as TuiControllerError).code, 'output_failure');
  assertEquals(controller.editor.text, '');
  assertEquals(session.cancelCount, 1);
  await settle;
  // The session cancellation gate is released by completeCancelled; the controller failure path
  // has already awaited it before reporting and restoring.
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
  assert(renderer.isClosing);
  const writesAfterClose = terminal.writes.length;
  try {
    session.complete();
  } catch {
    // Closed renderer rejects stale completion events.
  }
  assertEquals(terminal.writes.length, writesAfterClose);
});

Deno.test('busy progress output failure cancels and settles before restore', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new ProgressSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('progress task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(terminal.output().includes('tool~ bash live output'));
  // Fail the clear redraw after progress is visible; cancellation must be requested first.
  terminal.failWrites.add('\r\x1b[2K>   [busy]');
  terminal.push('\x1b');
  setTimeout(() => session.complete(), 100);
  let error: unknown;
  try {
    await running;
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof TuiControllerError);
  assertEquals((error as TuiControllerError).code, 'output_failure');
  assertEquals(session.cancelCount, 1);
  assert(session.settled);
  const restore = terminal.operations.indexOf('write:\x1b[?2004l');
  const settledStatus = terminal.operations.findIndex((operation) =>
    operation.includes('[cancelled]')
  );
  assert(settledStatus >= 0 && settledStatus < restore);
  assert(renderer.isClosing);
  const writesAfterClose = terminal.writes.length;
  try {
    session.emitLateProgress();
  } catch {
    // Closed renderer rejects a late event before any terminal write.
  }
  assertEquals(terminal.writes.length, writesAfterClose);
});

Deno.test('signal redraw failure settles a gated TERM-ignoring tool before restore', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new ProgressSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session);
  controller.installSignals();
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('progress task\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(terminal.output().includes('tool~ bash live output'));

  // The signal listener's status redraw fails after visible progress. Its crash path must cancel
  // the active gated tool before any paste-off/raw restore operation can begin.
  terminal.failWrites.add('\r\x1b[2K>   [busy]');
  let signalError: unknown;
  try {
    terminal.emitSignal('SIGTERM');
  } catch (error) {
    signalError = error;
  }
  assert(signalError instanceof Error);
  assertEquals(session.cancelCount, 1);
  assert(!session.settled);
  assert(!renderer.isClosing);
  assertEquals(terminal.raw, [true]);
  assert(!terminal.operations.includes(`write:${BRACKETED_PASTE_OFF}`));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(!renderer.isClosing);
  assertEquals(terminal.raw, [true]);

  session.complete();
  assertEquals(await running, 1);
  assert(session.settled);
  const settledStatus = terminal.operations.findIndex((operation) =>
    operation.includes('[cancelled]')
  );
  const pasteOff = terminal.operations.indexOf(`write:${BRACKETED_PASTE_OFF}`);
  const rawRestore = terminal.operations.indexOf('raw:false');
  assert(settledStatus >= 0 && pasteOff > settledStatus && rawRestore > pasteOff);
  assert(renderer.isClosing);
  const writesAfterClose = terminal.writes.length;
  try {
    session.emitLateProgress();
  } catch {
    // Closed renderer rejects late events before any terminal write.
  }
  assertEquals(terminal.writes.length, writesAfterClose);
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

Deno.test('modern controller preserves fixed lanes through cancellation without auto-resubmit', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = new PendingInputCore();
  const controllerRef: { current?: TuiController } = {};
  const session = new QueueSession((event) => {
    if (event.kind === 'steering_message') controllerRef.current?.markSteeringConsumed();
    renderer.eventSink(event);
  });
  const controller = new TuiController(lifecycle, renderer, session, {
    pending,
    history: new TuiEditorHistory(),
    pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
  });
  controllerRef.current = controller;
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('task\n');
  await tick();
  terminal.push('steer\n');
  await tick();
  terminal.push('follow\x1b\r');
  await tick();
  assertEquals(session.submitted, ['task']);
  assert(pending.hasActiveTask);
  assert(pending.hasSteering);
  assert(pending.hasFollowUp);
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  session.finishCancelled();
  await tick();
  assertEquals(session.submitted, ['task']);
  assertEquals(pending.snapshot().recoveryCount, 3);
  assertEquals(controller.currentState, 'idle');
  terminal.push('\x12');
  await tick();
  assertEquals(controller.editor.text, 'task');
  terminal.push('!');
  await tick();
  terminal.push('\x0e');
  await tick();
  assertEquals(controller.editor.text, 'task!');
  pending.clearAll();
  terminal.push('\x03\x03');
  assertEquals(await running, 0);
});

Deno.test('modern diagnostic fallback retains the ID and returns to ready without resubmit', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = new PendingInputCore();
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session, {
    pending,
    history: new TuiEditorHistory(),
    pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
  });
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('diagnostic task\n');
  await tick();
  session.finishDiagnosticFailure();
  await tick();

  const frame = renderer.renderFrame();
  assertEquals(session.submitted, ['diagnostic task']);
  assertEquals(controller.currentState, 'idle');
  assert(pending.hasRecovery);
  assert(frame.includes(
    'failure> id=44444444-4444-4444-8444-444444444444 · stage=response_parse',
  ));
  assert(frame.includes('durable=yes'));
  assert(frame.includes(
    'readback> henji diagnostics show --id 44444444-4444-4444-8444-444444444444',
  ));
  assert(!frame.includes('provider response unsafe marker'));
  assert(frame.includes('[ready'));

  // A recoverable diagnostic is not an implicit retry; an explicit EOF is still clean exit.
  terminal.push('\x04');
  await tick();
  terminal.push('\x04');
  assertEquals(await running, 0);
  assertEquals(session.submitted, ['diagnostic task']);
  assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
});

Deno.test('successful modern outcome retains no diagnostic marker', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = new PendingInputCore();
  const session = new FakeSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session, {
    pending,
    history: new TuiEditorHistory(),
    pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
  });
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('ordinary task\n');
  await tick();
  await tick();
  assertEquals(controller.currentState, 'idle');
  const frame = renderer.renderFrame();
  assert(!frame.includes('failure>'));
  assert(!frame.includes('diagnostics show'));
  terminal.push('\x04');
  assertEquals(await running, 0);
});

Deno.test('modern busy Ctrl-C cancels first and only a second press discards after settlement', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = new PendingInputCore();
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session, {
    pending,
    history: new TuiEditorHistory(),
    pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
  });
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('task\n');
  await tick();
  terminal.push('draft');
  await tick();
  terminal.push('\x03');
  await tick();
  assertEquals(session.cancelCount, 1);
  session.finishCancelled();
  await tick();
  assertEquals(controller.currentState, 'idle');
  assertEquals(controller.editor.text, 'draft');
  assert(pending.hasRecovery);
  terminal.push('\x03');
  assertEquals(await running, 0);
  assertEquals(controller.editor.text, '');
  assertEquals(pending.hasRecovery, false);
});

Deno.test('modern idle Ctrl-D confirms nonempty editor before discarding', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = new PendingInputCore();
  const session = new FakeSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session, {
    pending,
    history: new TuiEditorHistory(),
    pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
  });
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('draft\x04');
  await tick();
  assertEquals(controller.editor.text, 'draft');
  assert(terminal.output().includes('pending input; Ctrl-D again to discard and exit'));
  terminal.push('\x04');
  assertEquals(await running, 0);
  assertEquals(controller.editor.text, '');
});

Deno.test('modern discard confirmation is typed, refuses cross-key presses, and expires', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = new PendingInputCore();
  const controller = new TuiController(lifecycle, renderer, new FakeSession(() => {}), {
    pending,
    history: new TuiEditorHistory(),
    pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
  });
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('draft\x04');
  await tick();
  assertEquals(controller.editor.text, 'draft');
  terminal.push('\x03');
  await tick();
  assertEquals(controller.editor.text, 'draft');
  assert(controller.currentState === 'idle');
  terminal.push('\x03');
  assertEquals(await running, 0);
  assertEquals(controller.editor.text, '');

  const timeoutTerminal = new FakeTerminal();
  const timeoutRenderer = new TuiRenderer(timeoutTerminal);
  const timeoutLifecycle = new TerminalLifecycle(timeoutTerminal, timeoutRenderer);
  const timeoutController = new TuiController(
    timeoutLifecycle,
    timeoutRenderer,
    new FakeSession(() => {}),
    {
      pending: new PendingInputCore(),
      history: new TuiEditorHistory(),
      pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
    },
  );
  await timeoutLifecycle.acquire();
  const timeoutRun = timeoutController.run();
  timeoutTerminal.push('draft\x04');
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 2_050));
  timeoutTerminal.push('\x04');
  await tick();
  assertEquals(timeoutController.editor.text, 'draft');
  timeoutTerminal.push('\x04');
  assertEquals(await timeoutRun, 0);
  assertEquals(timeoutController.editor.text, '');
});

Deno.test('modern idle SIGINT confirms while TERM and HUP explicitly discard and preserve exits', async () => {
  const sigintTerminal = new FakeTerminal();
  const sigintRenderer = new TuiRenderer(sigintTerminal);
  const sigintLifecycle = new TerminalLifecycle(sigintTerminal, sigintRenderer);
  const sigintController = new TuiController(
    sigintLifecycle,
    sigintRenderer,
    new FakeSession(() => {}),
    {
      pending: new PendingInputCore(),
      history: new TuiEditorHistory(),
      pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
    },
  );
  sigintController.installSignals();
  await sigintLifecycle.acquire();
  const sigintRun = sigintController.run();
  sigintTerminal.push('draft');
  await tick();
  const before = sigintTerminal.writes.length;
  sigintTerminal.emitSignal('SIGINT');
  await tick();
  assertEquals(sigintController.editor.text, 'draft');
  assert(sigintTerminal.writes.slice(before).join('').includes('Ctrl-C again'));
  sigintTerminal.emitSignal('SIGINT');
  assertEquals(await sigintRun, 0);

  for (const [signal, expected] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const pending = new PendingInputCore();
    const controller = new TuiController(lifecycle, renderer, new FakeSession(() => {}), {
      pending,
      history: new TuiEditorHistory(),
      pathIndex: WorkspacePathIndex.empty('/tmp/tui-fixture'),
    });
    controller.installSignals();
    await lifecycle.acquire();
    const run = controller.run();
    terminal.push('secret draft');
    await tick();
    const writesBeforeSignal = terminal.writes.length;
    terminal.emitSignal(signal);
    assertEquals(await run, expected);
    const postSignal = terminal.writes.slice(writesBeforeSignal).join('');
    assert(postSignal.includes('discarding pending input for signal shutdown'));
    assert(!postSignal.includes('secret draft'));
    assertEquals(controller.editor.text, '');
    assertEquals(pending.hasRecovery, false);
  }
});

Deno.test('modern text edits detach history navigation while cursor movement preserves it', async () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = new PendingInputCore();
  const session = new QueueSession((event) => renderer.eventSink(event));
  const controller = new TuiController(lifecycle, renderer, session, {
    pending,
    history: new TuiEditorHistory(),
    pathIndex: WorkspacePathIndex.fromCandidates(['saved.md']),
  });
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('saved\n');
  await tick();
  session.finish();
  await tick();

  // Navigation alone remains active; each successful text mutation then detaches it.
  terminal.push('\x10');
  await tick();
  assertEquals(controller.editor.text, 'saved');
  terminal.push('\x1b[D');
  await tick();
  terminal.push('!');
  await tick();
  assertEquals(controller.editor.text, 'save!d');
  terminal.push('\x0e');
  await tick();
  assertEquals(controller.editor.text, 'save!d');
  assert(terminal.output().includes('history boundary'));

  // Ctrl-W, paste, and Tab each follow the same detach rule after a fresh navigation.
  terminal.push('\x10\x7f');
  await tick();
  assertEquals(controller.editor.text, 'save');
  terminal.push('\x0e');
  await tick();
  assertEquals(controller.editor.text, 'save');
  terminal.push('\x10\x17');
  await tick();
  assertEquals(controller.editor.text, '');
  terminal.push('\x10\x1b[200~!\x1b[201~');
  await tick();
  assertEquals(controller.editor.text, 'saved!');
  terminal.push('\x10');
  await tick();
  terminal.push('\x17');
  await tick();
  assertEquals(controller.editor.text, '');
  terminal.push('saved\t');
  await tick();
  assertEquals(controller.editor.text, '"./saved.md"');

  // Steering admission also detaches a prior history navigation, even when it does not edit
  // the selected snapshot itself.
  terminal.push('\n');
  await tick();
  terminal.push('\x10');
  await tick();
  assertEquals(controller.editor.text, '"./saved.md"');
  terminal.push('\n');
  await tick();
  assertEquals(session.steered, ['"./saved.md"']);
  terminal.push('\x0e');
  await tick();
  assertEquals(controller.editor.text, '');
  assert(terminal.output().includes('history boundary'));
  session.finish();
  await tick();
  terminal.push('\x04\x04');
  assertEquals(await running, 0);
});

const fakeNavigationSession = (): AgentSession => ({}) as AgentSession;

Deno.test('production navigation transaction transfers target ownership after old close', async () => {
  const target = fakeNavigationSession();
  const events: string[] = [];
  const result = await runNavigationSwitchTransaction({
    materializeTarget: () => {
      events.push('materialize');
      return target;
    },
    closeTarget: () =>
      Promise.resolve().then(() => {
        events.push('factory-close');
      }),
    closeCurrent: () =>
      Promise.resolve().then(() => {
        events.push('old-close');
      }),
    commitTarget: (session) => {
      events.push('swap');
      assertEquals(session, target);
    },
  });
  assertEquals(result, target);
  assertEquals(events, ['materialize', 'old-close', 'swap']);
});

Deno.test('navigation abort after old close transfers target ownership instead of cancelling', async () => {
  const target = fakeNavigationSession();
  const abort = new AbortController();
  const events: string[] = [];
  const result = await runNavigationSwitchTransaction({
    signal: abort.signal,
    materializeTarget: () => {
      events.push('materialize');
      return target;
    },
    closeTarget: () => {
      events.push('target-close');
      return Promise.resolve();
    },
    closeCurrent: () =>
      Promise.resolve().then(() => {
        events.push('old-close');
        abort.abort('dismissed after old close');
      }),
    commitTarget: (session) => {
      events.push('swap');
      assertEquals(session, target);
    },
  });
  assertEquals(result, target);
  assertEquals(events, ['materialize', 'old-close', 'swap']);
});

Deno.test('production navigation transaction closes target when old close fails', async () => {
  const events: string[] = [];
  let thrown: unknown;
  try {
    await runNavigationSwitchTransaction({
      materializeTarget: () => {
        events.push('materialize');
        return fakeNavigationSession();
      },
      closeTarget: () =>
        Promise.resolve().then(() => {
          events.push('factory-close');
        }),
      closeCurrent: () =>
        Promise.resolve().then(() => {
          events.push('old-close');
          throw new Error('old close');
        }),
      commitTarget: () => events.push('swap'),
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof NavigationFatalError);
  assertEquals(events, ['materialize', 'old-close', 'factory-close']);
});

Deno.test('production navigation transaction reports target cleanup failure fatally', async () => {
  const events: string[] = [];
  let thrown: unknown;
  try {
    await runNavigationSwitchTransaction({
      materializeTarget: () => {
        events.push('materialize');
        return fakeNavigationSession();
      },
      closeTarget: () =>
        Promise.resolve().then(() => {
          events.push('factory-close');
          throw new Error('target cleanup');
        }),
      closeCurrent: () =>
        Promise.resolve().then(() => {
          events.push('old-close');
          throw new Error('old close');
        }),
      commitTarget: () => events.push('swap'),
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof NavigationFatalError);
  assertEquals(events, ['materialize', 'old-close', 'factory-close']);
});
