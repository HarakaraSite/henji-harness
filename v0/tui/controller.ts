import { EventDeliveryError } from '../agent/events.ts';
import { type AgentSession } from '../agent/session.ts';
import { type LoopOutcome } from '../agent/contracts.ts';
import { type ContextMetrics } from '../agent/context.ts';
import {
  InputDecodeError,
  InputDecoder,
  type InputEvent,
  TuiEditor,
  TuiEditorHistory,
} from './input.ts';
import { PendingInputCore } from './pending_input.ts';
import { WorkspacePathIndex } from './file_reference.ts';
import { renderFailureStatus, TuiRenderer } from './render.ts';
import { TerminalLifecycle } from './terminal.ts';

export type TuiFailureCode =
  | 'input_failure'
  | 'output_failure'
  | 'agent_failure';

export class TuiControllerError extends Error {
  constructor(readonly code: TuiFailureCode, message?: string) {
    super(message);
    this.name = 'TuiControllerError';
  }
}

interface SessionLike {
  submit(text: string): Promise<LoopOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): ContextMetrics | undefined;
  isAvailable?(): boolean;
}

export interface TuiControllerOptions {
  /** Enables the Step 82 fixed-lane/editor behavior when supplied by the TUI runtime. */
  readonly pending?: PendingInputCore;
  readonly history?: TuiEditorHistory;
  readonly pathIndex?: WorkspacePathIndex;
}

type ControllerState = 'starting' | 'idle' | 'busy' | 'exiting' | 'failed';
type FollowUpSlot = 'closed' | 'open-empty' | 'pending';
type DiscardKey = 'ctrl_c' | 'ctrl_d';
type DiscardIntent = Readonly<{ key: DiscardKey; deadline: number }>;

const sleep = (duration: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), duration));

/** Controller for the first TUI's intentionally small idle/busy state machine. */
export class TuiController {
  readonly editor = new TuiEditor();
  private readonly decoder = new InputDecoder();
  private state: ControllerState = 'starting';
  private active: Promise<LoopOutcome> | null = null;
  private input: Promise<InputEvent[]> | null = null;
  private readPromise: Promise<Uint8Array | null> | null = null;
  private exitIntent: 'return' | 'exit-0' | 129 | 143 = 'return';
  private cancellationRequested = false;
  private steeringAccepted = false;
  private followUpSlot: FollowUpSlot = 'closed';
  private followUpText: string | null = null;
  private firstCtrlCAt: number | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private crashSettlement: Promise<void> | null = null;
  private exitCode = 0;
  private signalCode: number | null = null;
  private signalsInstalled = false;
  private readonly pending?: PendingInputCore;
  private readonly history: TuiEditorHistory;
  private readonly pathIndex?: WorkspacePathIndex;
  private readonly modern: boolean;
  private discardIntent: DiscardIntent | null = null;
  private steeringConsumedBridge = false;

  constructor(
    private readonly lifecycle: TerminalLifecycle,
    private readonly renderer: TuiRenderer,
    private readonly session: SessionLike | AgentSession,
    options: TuiControllerOptions = {},
  ) {
    this.pending = options.pending;
    this.history = options.history ?? new TuiEditorHistory();
    this.pathIndex = options.pathIndex;
    this.modern = options.pending !== undefined || options.pathIndex !== undefined ||
      options.history !== undefined;
  }

  get currentState(): ControllerState {
    return this.state;
  }

  get hasActiveTurn(): boolean {
    return this.active !== null;
  }

  /** Synchronous event bridge used by the runtime before renderer delivery. */
  markSteeringConsumed(): void {
    if (this.pending === undefined) return;
    if (!this.pending.markSteeringConsumed()) throw new TuiControllerError('agent_failure');
    this.steeringConsumedBridge = true;
  }

  pendingMetadata() {
    return this.pending?.snapshot(this.editor.snapshot());
  }

  /** Register handlers before raw acquisition; run() keeps this idempotent for direct callers. */
  installSignals(): void {
    if (this.signalsInstalled) return;
    this.lifecycle.addSignals({
      SIGINT: () => this.dispatchSignal('SIGINT'),
      SIGTERM: () => this.dispatchSignal('SIGTERM'),
      SIGHUP: () => this.dispatchSignal('SIGHUP'),
    });
    this.signalsInstalled = true;
  }

  /** Last-resort crash path: settle an active turn before closing the renderer. */
  handleCrash(): void {
    if (this.state === 'exiting' || this.state === 'failed') return;
    this.state = 'failed';
    this.exitCode = 1;
    this.clearLiveActivity();
    this.dropFollowUpBestEffort();
    this.clearSteeringEditorBestEffort();
    this.crashSettlement ??= this.settleCrash();
  }

  async run(): Promise<number> {
    try {
      this.installSignals();
      if (this.state === 'exiting' || this.state === 'failed') {
        if (this.crashSettlement !== null) await this.crashSettlement;
        if (this.shutdownPromise === null) {
          this.shutdownPromise = this.lifecycle.restore();
        }
        await this.shutdownPromise;
        return this.exitCode;
      }
      this.state = 'idle';
      this.renderer.setStatus('ready');
      this.input = this.readEvents();
      while (this.state === 'idle' || this.state === 'busy') {
        if (this.active === null) {
          const events = await this.input;
          this.input = this.readEvents();
          this.processIdle(events);
          continue;
        }
        const input = this.input;
        const active = this.active;
        const winner = await Promise.race([
          input.then((events) => ({ kind: 'input' as const, events })),
          active.then((outcome) => ({ kind: 'turn' as const, outcome })),
        ]);
        if (winner.kind === 'input') {
          this.input = this.readEvents();
          this.processBusy(winner.events);
        } else if (this.active === active) {
          this.active = null;
          if (this.canFinishTurn()) {
            this.finishTurn(winner.outcome);
          }
        }
      }
      if (this.crashSettlement !== null) await this.crashSettlement;
      if (this.shutdownPromise !== null) await this.shutdownPromise;
      return this.exitCode;
    } catch (error) {
      await this.fail(error);
      throw error instanceof TuiControllerError ? error : new TuiControllerError('agent_failure');
    }
  }

  private async readEvents(): Promise<InputEvent[]> {
    for (;;) {
      const chunkPromise = this.readChunk();
      const deadline = this.decoder.escapeDeadline();
      let chunk: Uint8Array | null;
      if (deadline !== undefined) {
        const remaining = Math.max(0, deadline - Date.now());
        const winner = await Promise.race([
          chunkPromise.then((value) => ({ kind: 'chunk' as const, value })),
          sleep(remaining).then(() => ({ kind: 'timeout' as const })),
        ]);
        if (winner.kind === 'timeout') {
          const events = this.decoder.poll();
          if (events.length > 0) return events;
          continue;
        }
        chunk = winner.value;
      } else {
        chunk = await chunkPromise;
      }
      if (chunk === null) {
        if (this.state === 'exiting' || this.state === 'failed') return [];
        try {
          this.decoder.end();
        } catch (error) {
          throw new TuiControllerError(
            'input_failure',
            error instanceof Error ? error.message : undefined,
          );
        }
        throw new TuiControllerError('input_failure');
      }
      const events = this.decoder.feed(chunk);
      if (events.length > 0) return events;
    }
  }

  private readChunk(): Promise<Uint8Array | null> {
    if (this.readPromise !== null) return this.readPromise;
    const promise = this.lifecycleTerminalRead().catch((error: unknown) => {
      throw new TuiControllerError(
        'input_failure',
        error instanceof Error ? error.message : 'terminal read failed',
      );
    });
    this.readPromise = promise;
    void promise.then(
      () => {
        if (this.readPromise === promise) this.readPromise = null;
      },
      () => {
        if (this.readPromise === promise) this.readPromise = null;
      },
    );
    return promise;
  }

  private lifecycleTerminalRead(): Promise<Uint8Array | null> {
    return this.lifecycle.read();
  }

  private processIdle(events: readonly InputEvent[]): void {
    if (this.modern) {
      this.processModernEvents(events, false);
      return;
    }
    for (const event of events) {
      if (this.state !== 'idle') {
        this.processBusyEvent(event);
        continue;
      }
      switch (event.kind) {
        case 'printable':
          if (!this.editor.append(event.text)) {
            this.renderer.setStatus('input too long');
          } else this.renderer.setEditor(this.editor.text);
          break;
        case 'paste':
          if (event.text.includes('\0')) {
            this.renderer.setStatus('invalid steering input');
          } else if (!this.editor.append(event.text)) {
            this.renderer.setStatus('paste exceeds 64 KiB');
          } else this.renderer.setEditor(this.editor.text);
          break;
        case 'backspace':
          this.editor.backspace();
          this.renderer.setEditor(this.editor.text);
          break;
        case 'enter':
          this.submitIfNonblank();
          break;
        case 'alt_enter':
          this.submitIfNonblank();
          break;
        case 'ctrl_c':
          this.idleCtrlC();
          break;
        case 'ctrl_d':
          if (this.editor.text.length === 0) void this.shutdown(0);
          else this.renderer.setStatus('Ctrl-D exits only on empty input');
          break;
        case 'escape':
        case 'unknown':
        case 'invalid_utf8':
        case 'paste_rejected':
          this.renderer.setStatus(
            event.kind === 'invalid_utf8' ? 'invalid UTF-8' : 'input ignored',
          );
          break;
      }
    }
  }

  private processBusy(events: readonly InputEvent[]): void {
    if (this.modern) {
      for (const event of events) {
        if (this.cancellationRequested && event.kind !== 'ctrl_c') continue;
        this.processModernEvents([event], true);
      }
      return;
    }
    for (const event of events) {
      // Once cooperative cancellation wins, the rest of a timed-out modifier sequence (or
      // same-chunk input) cannot mutate either editor or queue state. A second Ctrl-C is retained
      // so it can promote an already-requested cancellation to the prescribed clean exit.
      if (this.cancellationRequested && event.kind !== 'ctrl_c') continue;
      this.processBusyEvent(event);
    }
  }

  private renderEditorState(): void {
    const snapshot = this.editor.snapshot();
    if (!this.modern) {
      this.renderer.setEditor(snapshot.text);
      return;
    }
    const renderer = this.renderer as TuiRenderer & {
      setEditorSnapshot?: (value: typeof snapshot) => void;
    };
    if (renderer.setEditorSnapshot !== undefined) renderer.setEditorSnapshot(snapshot);
    else renderer.setEditor(snapshot.text);
    const withMetadata = this.renderer as TuiRenderer & {
      setPendingMetadata?: (value: ReturnType<PendingInputCore['snapshot']> | undefined) => void;
    };
    withMetadata.setPendingMetadata?.(this.pending?.snapshot(snapshot));
  }

  private editEvent(event: InputEvent): void {
    let changed = false;
    let textMutation = false;
    switch (event.kind) {
      case 'printable':
        changed = this.editor.insert(event.text);
        textMutation = true;
        break;
      case 'paste':
        changed = this.editor.paste(event.text);
        textMutation = true;
        break;
      case 'backspace':
        changed = this.editor.backspace();
        textMutation = true;
        break;
      case 'ctrl_o':
        changed = this.editor.insert('\n');
        textMutation = true;
        break;
      case 'ctrl_w':
        changed = this.editor.deleteWordBackward();
        textMutation = true;
        break;
      case 'left':
        changed = this.editor.moveLeft();
        break;
      case 'right':
        changed = this.editor.moveRight();
        break;
      case 'up':
        changed = this.editor.moveUp();
        break;
      case 'down':
        changed = this.editor.moveDown();
        break;
      case 'home':
        changed = this.editor.home();
        break;
      case 'end':
        changed = this.editor.end();
        break;
      default:
        return;
    }
    if (changed) {
      if (textMutation) this.history.resetNavigation();
      this.renderEditorState();
    } else if (event.kind === 'paste' || event.kind === 'printable' || event.kind === 'ctrl_o') {
      this.renderer.setStatus(event.kind === 'paste' ? 'paste exceeds 64 KiB' : 'input too long');
    }
  }

  private processModernEvents(events: readonly InputEvent[], busy: boolean): void {
    for (const event of events) {
      if (event.kind === 'ctrl_c') {
        busy ? this.busyCtrlC() : this.modernCtrlC();
        continue;
      }
      if (event.kind === 'ctrl_d') {
        busy
          ? this.renderer.setStatus('busy; Escape cancels, Ctrl-C twice discards and exits')
          : this.modernCtrlD();
        continue;
      }
      if (event.kind === 'escape') {
        if (busy) this.busyEscape();
        else this.renderer.setStatus('input ignored');
        continue;
      }
      if (event.kind === 'enter') {
        if (busy) this.submitSteeringIfNonblank();
        else this.submitIfNonblank();
        continue;
      }
      if (event.kind === 'alt_enter') {
        if (busy) this.queueFollowUpIfNonblank();
        continue;
      }
      if (event.kind === 'tab') {
        this.completePathAtCursor();
        continue;
      }
      if (event.kind === 'ctrl_r') {
        this.popRecovery();
        continue;
      }
      if (event.kind === 'ctrl_p') {
        const snapshot = this.history.previous(this.editor.snapshot());
        if (snapshot === null) this.renderer.setStatus('history empty');
        else {
          this.editor.setSnapshot(snapshot);
          this.renderEditorState();
        }
        continue;
      }
      if (event.kind === 'ctrl_n') {
        const snapshot = this.history.next();
        if (snapshot === null) this.renderer.setStatus('history boundary');
        else {
          this.editor.setSnapshot(snapshot);
          this.renderEditorState();
        }
        continue;
      }
      if (event.kind === 'invalid_utf8') {
        this.renderer.setStatus('invalid UTF-8');
        continue;
      }
      if (event.kind === 'paste_rejected') {
        this.renderer.setStatus('paste exceeds 64 KiB');
        continue;
      }
      if (event.kind === 'unknown') {
        this.renderer.setStatus('input ignored');
        continue;
      }
      this.editEvent(event);
    }
  }

  private modernCtrlD(): void {
    if (this.hasProcessPending()) {
      this.armDiscardConfirmation('ctrl_d', 'pending input; Ctrl-D again to discard and exit');
    } else void this.shutdown(0);
  }
  private modernCtrlC(): void {
    if (this.hasProcessPending()) {
      this.armDiscardConfirmation('ctrl_c', 'pending input; Ctrl-C again to discard and exit');
    } else this.idleCtrlC();
  }
  private hasProcessPending(): boolean {
    return this.editor.text.length > 0 || this.pending?.hasRecovery === true ||
      this.pending?.hasActiveTask === true || this.pending?.hasSteering === true ||
      this.pending?.hasFollowUp === true;
  }
  private armDiscardConfirmation(key: DiscardKey, status: string): void {
    const now = Date.now();
    const intent: DiscardIntent = { key, deadline: now + 2_000 };
    if (
      this.discardIntent !== null && this.discardIntent.key === key &&
      this.discardIntent.deadline >= now
    ) {
      this.discardIntent = null;
      this.pending?.clearAll();
      this.editor.clear();
      this.history.resetNavigation();
      this.renderEditorState();
      void this.shutdown(0);
      return;
    }
    this.discardIntent = intent;
    this.renderer.setStatus(status);
    setTimeout(() => {
      if (this.discardIntent === intent) this.discardIntent = null;
    }, 2_001);
  }
  private completePathAtCursor(): void {
    if (this.pathIndex === undefined) {
      this.renderer.setStatus('path index unavailable');
      return;
    }
    const text = this.editor.text;
    let start = this.editor.cursorScalar;
    const points = [...text];
    while (start > 0 && !/[ \t\n]/u.test(points[start - 1])) start -= 1;
    const fragment = points.slice(start, this.editor.cursorScalar).join('');
    const result = this.pathIndex.completePath(fragment);
    if (result.kind === 'inserted') {
      points.splice(start, this.editor.cursorScalar - start, ...[...result.text]);
      const candidate = points.join('');
      const cursor = start + [...result.text].length;
      if (
        !this.editor.setSnapshot({
          text: candidate,
          cursorScalar: cursor,
          byteLength: new TextEncoder().encode(candidate).byteLength,
        })
      ) this.renderer.setStatus('path replacement too long');
      else {
        this.history.resetNavigation();
        this.renderEditorState();
      }
    } else if (result.kind === 'ambiguous') {
      this.renderer.setStatus(`path match ambiguous (${result.count})`);
    } else if (result.kind === 'incomplete') this.renderer.setStatus('path index unavailable');
    else this.renderer.setStatus('no path match');
  }
  private popRecovery(): void {
    if (this.editor.text.length > 0 || this.pending === undefined) {
      this.renderer.setStatus('recovery requires empty editor');
      return;
    }
    const item = this.pending.popRecovery();
    if (item === null) {
      this.renderer.setStatus('no recoverable input');
      return;
    }
    if (
      !this.editor.setSnapshot({
        text: item.text,
        cursorScalar: [...item.text].length,
        byteLength: new TextEncoder().encode(item.text).byteLength,
      })
    ) {
      this.renderer.setStatus('recovery unavailable');
      return;
    }
    this.history.resetNavigation();
    this.renderEditorState();
    if (this.pending.hasSideEffectWarning) {
      this.renderer.setStatus('tools may have changed the workspace; inspect before resubmitting');
    }
  }

  private processBusyEvent(event: InputEvent): void {
    if (this.state !== 'busy') return;
    if (event.kind === 'ctrl_c') {
      this.busyCtrlC();
    } else if (event.kind === 'escape') {
      this.busyEscape();
    } else if (event.kind === 'alt_enter') {
      this.queueFollowUpIfNonblank();
    } else if (
      (this.session.steerActiveTurn !== undefined && !this.steeringAccepted) ||
      this.followUpSlot === 'open-empty'
    ) {
      const steeringAvailable = this.session.steerActiveTurn !== undefined &&
        !this.steeringAccepted;
      switch (event.kind) {
        case 'printable':
          if (!this.editor.append(event.text)) this.renderer.setStatus('input too long');
          else this.renderer.setEditor(this.editor.text);
          break;
        case 'paste':
          if (event.text.includes('\0')) this.renderer.setStatus('invalid steering input');
          else if (!this.editor.append(event.text)) this.renderer.setStatus('paste exceeds 64 KiB');
          else this.renderer.setEditor(this.editor.text);
          break;
        case 'backspace':
          this.editor.backspace();
          this.renderer.setEditor(this.editor.text);
          break;
        case 'enter':
          if (steeringAvailable) this.submitSteeringIfNonblank();
          else this.renderer.setStatus('steering unavailable');
          break;
        case 'invalid_utf8':
          this.renderer.setStatus('invalid UTF-8');
          break;
        case 'paste_rejected':
          this.renderer.setStatus('paste exceeds 64 KiB');
          break;
        case 'ctrl_d':
        case 'unknown':
          break;
      }
    } else if (event.kind === 'enter') {
      this.renderer.setStatus('steering unavailable');
    }
    // Every other event is deliberately consumed and discarded.
  }

  private submitIfNonblank(): void {
    const text = this.editor.submit();
    if (text === null) {
      this.renderer.setStatus('enter a task');
      return;
    }
    if (this.pending !== undefined && !this.pending.admitTask(text)) {
      this.renderer.setStatus('active task recovery pending');
      return;
    }
    this.pending?.clearSideEffectWarning();
    if (this.modern) this.history.record(text);
    this.editor.clear();
    this.renderEditorState();
    this.followUpSlot = 'open-empty';
    this.followUpText = null;
    this.renderer.setFollowUpPending(false);
    this.state = 'busy';
    this.cancellationRequested = false;
    this.steeringAccepted = false;
    try {
      this.active = Promise.resolve(this.session.submit(text));
    } catch (error) {
      this.active = Promise.reject(error);
    }
  }

  private finishTurn(outcome: LoopOutcome): void {
    if (this.modern) {
      this.finishModernTurn(outcome);
      return;
    }
    this.clearSteeringEditorStrict();
    this.renderer.clearLiveProgress();
    this.steeringAccepted = false;
    if (!outcome.ok && outcome.stopReason !== 'cancelled') {
      this.dropFollowUpStrict();
      this.renderer.setStatus(renderFailureStatus(outcome));
      throw new TuiControllerError('agent_failure');
    }
    if (
      outcome.stopReason === 'tool_terminal' &&
      typeof outcome.finalText === 'string'
    ) {
      this.renderer.renderAssistantFinal(outcome.finalText);
    }
    if (outcome.stopReason === 'cancelled') {
      this.dropFollowUpStrict();
      if (this.exitIntent === 'return') {
        this.state = 'idle';
        this.editor.clear();
        this.renderer.setEditor('');
        this.renderer.setStatus(this.readyStatus());
      } else {
        void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent);
      }
    } else if (this.exitIntent !== 'return') {
      this.dropFollowUpStrict();
      void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent);
    } else if (
      outcome.ok &&
      (outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal') &&
      this.followUpSlot === 'pending' && this.followUpText !== null
    ) {
      const text = this.takeFollowUp();
      this.renderer.setStatus('busy · starting follow-up');
      this.startAutomaticTurn(text);
    } else {
      this.dropFollowUpStrict();
      this.state = 'idle';
      this.renderer.setStatus(this.readyStatus());
    }
  }

  private finishModernTurn(outcome: LoopOutcome): void {
    this.renderer.clearLiveProgress();
    if (this.exitIntent !== 'return' && outcome.stopReason === 'cancelled') {
      this.pending?.clearAll();
      this.editor.clear();
      this.renderEditorState();
      void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent);
      return;
    }
    const recoverable = !outcome.ok && (
      outcome.stopReason === 'cancelled' || outcome.stopReason === 'max_steps' ||
      outcome.stopReason === 'contract_failure'
    ) && (this.session.isAvailable?.() ?? true) && this.exitIntent === 'return';
    if (outcome.ok && (outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal')) {
      this.pending?.commitTask();
      if (this.pending?.hasSteering) this.pending.recoverSteering();
      if (outcome.stopReason === 'tool_terminal' && typeof outcome.finalText === 'string') {
        this.renderer.renderAssistantFinal(outcome.finalText);
      }
    } else if (recoverable) {
      if (
        this.pending !== undefined && !this.pending.recoverAfterSettlement(outcome.toolCallCount)
      ) {
        this.renderer.setStatus('agent failure');
        throw new TuiControllerError('agent_failure');
      }
      this.renderer.setStatus(
        outcome.stopReason === 'max_steps'
          ? 'request limit reached; recoverable input available'
          : outcome.stopReason === 'cancelled'
          ? 'cancelled; recoverable input available'
          : 'agent failure; recoverable input available',
      );
    } else if (!outcome.ok) {
      this.renderer.setStatus(renderFailureStatus(outcome));
      throw new TuiControllerError('agent_failure');
    }
    this.steeringAccepted = false;
    this.steeringConsumedBridge = false;
    if (this.exitIntent !== 'return') {
      this.pending?.clearAll();
      this.editor.clear();
      this.renderEditorState();
      void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent);
      return;
    }
    if (
      outcome.ok && (outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal') &&
      this.pending?.hasFollowUp === true
    ) {
      const text = this.pending.takeFollowUpAsTask();
      if (text === null) throw new TuiControllerError('agent_failure');
      this.history.record(text);
      this.renderer.setStatus('busy · starting follow-up');
      this.startAutomaticTurn(text);
      return;
    }
    this.state = 'idle';
    (this.renderer as TuiRenderer & {
      setPendingMetadata?: (value: ReturnType<PendingInputCore['snapshot']> | undefined) => void;
    }).setPendingMetadata?.(this.pending?.snapshot(this.editor.snapshot()));
    if (recoverable) {
      this.renderer.setStatus(
        this.pending?.hasSideEffectWarning
          ? 'ready · tools may have changed the workspace; inspect before resubmitting'
          : 'ready',
      );
    } else this.renderer.setStatus(this.readyStatus());
  }

  /** Read committed context only after the settled turn is returning to idle. */
  private readyStatus(): string {
    const metrics = this.session.contextSnapshot?.();
    if (metrics === undefined) return 'ready';
    const estimateK = Math.ceil(metrics.messageEstimatedTokensAfter / 1024);
    const base = `ready · ctx ≤${estimateK}K/64K est`;
    return metrics.compressedResultCount === 0
      ? base
      : `${base} · ${metrics.compressedResultCount} omitted`;
  }

  private idleCtrlC(): void {
    const now = Date.now();
    if (this.firstCtrlCAt !== null && now - this.firstCtrlCAt <= 500) {
      void this.shutdown(0);
      return;
    }
    this.editor.clear();
    this.renderer.setEditor('');
    this.firstCtrlCAt = now;
    this.renderer.setStatus('press Ctrl-C again to exit');
    setTimeout(() => {
      if (this.firstCtrlCAt !== null && Date.now() - this.firstCtrlCAt > 500) {
        this.firstCtrlCAt = null;
      }
    }, 501);
  }

  private busyCtrlC(): void {
    if (this.modern) {
      const now = Date.now();
      const intent = this.discardIntent;
      if (intent === null || intent.key !== 'ctrl_c' || intent.deadline < now) {
        const next: DiscardIntent = { key: 'ctrl_c', deadline: now + 2_000 };
        this.discardIntent = next;
        this.renderer.setStatus('cancelling; Ctrl-C again to discard and exit');
      } else {
        this.discardIntent = null;
        this.setExitIntent('exit-0');
      }
      this.requestBusyCancellation('cancelling');
      setTimeout(() => {
        if (this.discardIntent !== null && Date.now() >= this.discardIntent.deadline) {
          this.discardIntent = null;
        }
      }, 2_001);
      return;
    }
    this.setExitIntent('exit-0');
    this.requestBusyCancellation('cancelling; exiting');
    if (this.session.cancelActiveTurn === undefined) {
      this.renderer.setStatus('exiting after current turn');
    }
  }

  private busyEscape(): void {
    this.requestBusyCancellation('cancelling');
  }

  private requestBusyCancellation(status: string): void {
    if (this.session.cancelActiveTurn === undefined) {
      this.renderer.clearLiveProgress();
      this.dropFollowUpStrict();
      this.clearSteeringEditorBestEffort();
      this.renderer.setStatus('cancellation unavailable; turn continues');
      return;
    }
    if (!this.cancellationRequested) {
      const result = this.session.cancelActiveTurn();
      this.cancellationRequested = result !== 'idle';
    }
    // Clear replaceable live activity before redrawing the editor so no stale tool snapshot is
    // emitted after cancellation. The strict editor clear still precedes the status redraw; its
    // failure becomes output_failure and `fail()` waits for this active turn before restoration.
    this.renderer.clearLiveProgress();
    if (this.modern) {
      this.renderer.setStatus(status);
      return;
    }
    this.dropFollowUpStrict();
    this.clearSteeringEditorStrict();
    this.renderer.setStatus(status);
  }

  private setExitIntent(intent: 'exit-0' | 129 | 143): void {
    const rank = (value: typeof this.exitIntent): number =>
      value === 'return' ? 0 : value === 'exit-0' ? 1 : 2;
    if (rank(intent) > rank(this.exitIntent)) this.exitIntent = intent;
  }

  private canFinishTurn(): boolean {
    return this.state !== 'failed' && this.state !== 'exiting';
  }

  private dispatchSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    try {
      this.onSignal(signal);
    } catch (error) {
      // A signal listener can fail during a redraw outside run()'s stack. Start the same guarded
      // crash settlement before rethrowing so the host crash guard cannot restore early.
      this.handleCrash();
      throw error;
    }
  }

  private onSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    if (this.state === 'exiting' || this.state === 'failed') return;
    if (this.state === 'starting') {
      const code = signal === 'SIGINT' ? 0 : signal === 'SIGTERM' ? 143 : 129;
      this.signalCode = code === 0 ? null : code;
      this.state = 'exiting';
      // Before acquire, defer restore until the CLI's acquisition attempt has settled. This
      // prevents a pre-acquisition signal from racing acquire and leaving raw mode enabled.
      if (this.lifecycle.isAcquired()) void this.shutdown(code);
      return;
    }
    if (signal === 'SIGINT') {
      if (this.state === 'busy') this.busyCtrlC();
      else this.modern ? this.modernCtrlC() : this.idleCtrlC();
      return;
    }
    const code = signal === 'SIGTERM' ? 143 : 129;
    this.signalCode = this.signalCode === null ? code : this.signalCode;
    if (this.state === 'busy') {
      this.setExitIntent(code);
      if (this.modern) {
        // A signal-driven shutdown discards the steering editor immediately so the warning redraw
        // cannot echo a partially typed secret while the active turn settles.
        this.editor.clear();
        this.history.resetNavigation();
        this.renderEditorState();
      }
      this.requestBusyCancellation(
        this.modern ? 'discarding pending input for signal shutdown' : 'cancelling; exiting',
      );
    } else {
      if (this.modern) this.signalShutdown(code);
      else void this.shutdown(this.signalCode);
    }
  }

  /** Signal shutdown is an explicit discard transition; it never offers recovery. */
  private signalShutdown(code: 129 | 143): void {
    this.pending?.clearAll();
    this.editor.clear();
    this.history.resetNavigation();
    this.renderEditorState();
    this.renderer.setStatus('discarding pending input for signal shutdown');
    void this.shutdown(code);
  }

  private async shutdown(code: number): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.state = 'exiting';
    this.exitCode = code;
    this.clearLiveActivity();
    this.dropFollowUpBestEffort();
    this.clearSteeringEditorBestEffort();
    this.shutdownPromise = this.lifecycle.restore();
    await this.shutdownPromise;
  }

  private async fail(error: unknown): Promise<void> {
    if (this.state !== 'failed' && this.state !== 'exiting') {
      this.state = 'failed';
    }
    this.clearLiveActivity();
    this.dropFollowUpBestEffort();
    this.clearSteeringEditorBestEffort();
    await this.settleActive();
    if (this.shutdownPromise === null) {
      // Fatal controller/agent failures override any previously requested signal exit intent.
      this.exitCode = 1;
      this.shutdownPromise = this.lifecycle.restore();
    }
    await this.shutdownPromise;
    if (error instanceof TuiControllerError) return;
    if (error instanceof EventDeliveryError) {
      throw new TuiControllerError('output_failure');
    }
    if (error instanceof InputDecodeError) {
      throw new TuiControllerError('input_failure');
    }
  }

  private async settleActive(): Promise<void> {
    const active = this.active;
    if (active === null) return;
    // A busy input/output failure may interrupt before the normal turn branch observes its
    // promise. Request cancellation first and await owned tool/resource settlement before any
    // restore operation can close the terminal.
    try {
      this.session.cancelActiveTurn?.();
    } catch {
      // The original controller failure remains authoritative; settlement is still awaited.
    }
    try {
      await active;
    } catch {
      // The active turn's rejection is secondary to the controller failure being reported.
    }
    if (this.active === active) this.active = null;
  }

  private async settleCrash(): Promise<void> {
    await this.settleActive();
    if (this.shutdownPromise === null) {
      this.shutdownPromise = this.lifecycle.restore();
    }
    await this.shutdownPromise;
  }

  private clearLiveActivity(): void {
    try {
      this.renderer.clearLiveActivity();
    } catch {
      // The original controller/agent failure remains authoritative; restoration still runs.
    }
  }

  /** Normal interactive clearing propagates renderer failure to the output-failure path. */
  private clearSteeringEditorStrict(): void {
    this.editor.clear();
    this.renderer.setEditor('');
  }

  /** Crash/restore cleanup cannot replace the original failure and therefore remains best effort. */
  private clearSteeringEditorBestEffort(): void {
    this.editor.clear();
    try {
      this.renderer.setEditor('');
    } catch {
      // A renderer failure is handled by the enclosing controller failure/restore path.
    }
  }

  private dropFollowUpStrict(): void {
    this.followUpSlot = 'closed';
    this.followUpText = null;
    this.renderer.setFollowUpPending(false);
  }

  private dropFollowUpBestEffort(): void {
    this.followUpSlot = 'closed';
    this.followUpText = null;
    try {
      this.renderer.setFollowUpPending(false);
    } catch {
      // Cleanup preserves the original cancellation/failure precedence.
    }
  }

  private takeFollowUp(): string {
    const text = this.followUpText;
    if (this.followUpSlot !== 'pending' || text === null) {
      throw new TuiControllerError('agent_failure');
    }
    this.followUpSlot = 'closed';
    this.followUpText = null;
    this.renderer.setFollowUpPending(false);
    return text;
  }

  private startAutomaticTurn(text: string): void {
    this.state = 'busy';
    this.cancellationRequested = false;
    this.steeringAccepted = false;
    try {
      this.active = Promise.resolve(this.session.submit(text));
    } catch (error) {
      this.active = Promise.reject(error);
    }
  }

  private queueFollowUpIfNonblank(): void {
    const text = this.editor.submit();
    if (text === null) {
      this.renderer.setStatus('enter follow-up text');
      return;
    }
    if (this.followUpSlot === 'pending') {
      this.renderer.setStatus('follow-up already queued');
      return;
    }
    if (this.followUpSlot === 'closed') {
      this.renderer.setStatus('follow-up slot closed');
      return;
    }
    if (this.pending !== undefined && !this.pending.queueFollowUp(text)) {
      this.renderer.setStatus('follow-up already queued');
      return;
    }
    if (this.modern) this.history.resetNavigation();
    this.editor.clear();
    this.renderEditorState();
    this.renderer.setFollowUpPending(true);
    this.followUpText = text;
    this.followUpSlot = 'pending';
    this.renderer.setStatus('busy');
  }

  private submitSteeringIfNonblank(): void {
    const text = this.editor.submit();
    if (text === null) {
      this.renderer.setStatus('enter steering text');
      return;
    }
    if (this.pending !== undefined && this.pending.reserveSteering(text) === 'refused') {
      this.renderer.setStatus('steering already accepted');
      return;
    }
    let result: 'accepted' | 'idle' | 'already_accepted';
    try {
      result = this.session.steerActiveTurn!(text);
    } catch (error) {
      if (error instanceof RangeError) {
        this.pending?.rollbackSteeringReservation();
        this.renderer.setStatus('invalid steering input');
        return;
      }
      this.pending?.rollbackSteeringReservation();
      throw error;
    }
    if (result === 'accepted') {
      if (this.pending !== undefined && !this.pending.commitSteeringReservation()) {
        throw new TuiControllerError('agent_failure');
      }
      this.steeringAccepted = true;
      if (this.modern) this.history.resetNavigation();
      this.editor.clear();
      this.renderEditorState();
      this.renderer.setStatus('busy · steer pending');
    } else if (result === 'already_accepted') {
      this.pending?.rollbackSteeringReservation();
      this.steeringAccepted = true;
      if (this.modern) this.renderer.setStatus('steering already accepted');
      else this.clearSteeringEditorStrict();
    } else {
      this.pending?.rollbackSteeringReservation();
      if (this.modern) {
        this.renderer.setStatus('steering window closed');
        return;
      }
      this.clearSteeringEditorStrict();
      this.renderer.setStatus('steering window closed');
    }
  }
}
