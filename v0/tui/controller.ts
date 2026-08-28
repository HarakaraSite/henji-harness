import { EventDeliveryError } from '../agent/events.ts';
import { type AgentSession } from '../agent/session.ts';
import { type LoopOutcome } from '../agent/contracts.ts';
import { type ContextMetrics } from '../agent/context.ts';
import { InputDecodeError, InputDecoder, type InputEvent, TuiEditor } from './input.ts';
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
  contextSnapshot?(): ContextMetrics | undefined;
}

type ControllerState = 'starting' | 'idle' | 'busy' | 'exiting' | 'failed';

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
  private firstCtrlCAt: number | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private crashSettlement: Promise<void> | null = null;
  private exitCode = 0;
  private signalCode: number | null = null;
  private signalsInstalled = false;

  constructor(
    private readonly lifecycle: TerminalLifecycle,
    private readonly renderer: TuiRenderer,
    private readonly session: SessionLike | AgentSession,
  ) {}

  get currentState(): ControllerState {
    return this.state;
  }

  get hasActiveTurn(): boolean {
    return this.active !== null;
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
          if (!this.editor.append(event.text)) {
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
    for (const event of events) this.processBusyEvent(event);
  }

  private processBusyEvent(event: InputEvent): void {
    if (this.state !== 'busy') return;
    if (event.kind === 'ctrl_c') {
      this.busyCtrlC();
    } else if (event.kind === 'escape') {
      this.busyEscape();
    }
    // Every other event is deliberately consumed and discarded.
  }

  private submitIfNonblank(): void {
    const text = this.editor.submit();
    if (text === null) {
      this.renderer.setStatus('enter a task');
      return;
    }
    this.editor.clear();
    this.renderer.setEditor('');
    this.state = 'busy';
    this.cancellationRequested = false;
    try {
      this.active = Promise.resolve(this.session.submit(text));
    } catch (error) {
      this.active = Promise.reject(error);
    }
  }

  private finishTurn(outcome: LoopOutcome): void {
    this.renderer.clearLiveProgress();
    if (!outcome.ok && outcome.stopReason !== 'cancelled') {
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
      if (this.exitIntent === 'return') {
        this.state = 'idle';
        this.editor.clear();
        this.renderer.setEditor('');
        this.renderer.setStatus(this.readyStatus());
      } else {
        void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent);
      }
    } else if (this.exitIntent !== 'return') {
      void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent);
    } else {
      this.state = 'idle';
      this.renderer.setStatus(this.readyStatus());
    }
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
      this.renderer.setStatus('cancellation unavailable; turn continues');
      return;
    }
    if (!this.cancellationRequested) {
      const result = this.session.cancelActiveTurn();
      this.cancellationRequested = result !== 'idle';
    }
    // Cancellation must own the active tool before any redraw can fail. `fail()` then waits for
    // this promise to settle before closing the terminal and returning the fatal output error.
    this.renderer.clearLiveProgress();
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
      else this.idleCtrlC();
      return;
    }
    const code = signal === 'SIGTERM' ? 143 : 129;
    this.signalCode = this.signalCode === null ? code : this.signalCode;
    if (this.state === 'busy') {
      this.setExitIntent(code);
      this.requestBusyCancellation('cancelling; exiting');
    } else {
      void this.shutdown(this.signalCode);
    }
  }

  private async shutdown(code: number): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.state = 'exiting';
    this.exitCode = code;
    this.clearLiveActivity();
    this.shutdownPromise = this.lifecycle.restore();
    await this.shutdownPromise;
  }

  private async fail(error: unknown): Promise<void> {
    if (this.state !== 'failed' && this.state !== 'exiting') {
      this.state = 'failed';
    }
    this.clearLiveActivity();
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
}
