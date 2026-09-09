import {
  isPresentationError,
  PresentationDeliveryError,
  type PresentationIntent,
  type PresentationIntentDispatcher,
  type PresentationIntentResult,
  type PresentationOutcome,
} from '../presentation/contract.ts';
import {
  InputDecodeError,
  InputDecoder,
  type InputEvent,
  TuiEditor,
  TuiEditorHistory,
} from './input.ts';
import { PendingInputCore } from './pending_input.ts';
import { renderFailureStatus, TuiRenderer } from './render.ts';
import { TerminalLifecycle } from './terminal.ts';
import {
  TuiControllerError,
  type TuiControllerOptions,
  type TuiNavigationLike,
  type TuiSessionLike,
} from './controller_contract.ts';
import { type SlashCommand, slashCommandOf } from './slash_command.ts';
import { ControllerEditor } from './controller_editor.ts';
import { ControllerOverlay } from './controller_overlay.ts';
import {
  defaultModelSelectionFor,
  type ModelSelection,
  selectModelFor,
} from '../agent/provider/model_catalog.ts';

export {
  TuiControllerError,
  type TuiControllerOptions,
  type TuiFailureCode,
  type TuiNavigationLike,
  type TuiSessionLike,
} from './controller_contract.ts';
export { type SlashCommand, slashCommandOf } from './slash_command.ts';

const isPresentationDeliveryError = (error: unknown): boolean =>
  error instanceof PresentationDeliveryError ||
  isPresentationError(error, 'PresentationDeliveryError') ||
  isPresentationError(error, 'EventDeliveryError');
type ControllerState =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'history-exporting'
  | 'exiting'
  | 'failed';
type FollowUpSlot = 'closed' | 'open-empty' | 'pending';
type DiscardKey = 'ctrl_c' | 'ctrl_d';
type DiscardIntent = Readonly<{ key: DiscardKey; deadline: number }>;

const sleep = (duration: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), duration));

/** Controller for the first TUI's intentionally small idle/busy state machine. */
export class TuiController {
  readonly editor: TuiEditor;
  private readonly editorController: ControllerEditor;
  private readonly decoder = new InputDecoder();
  private state: ControllerState = 'starting';
  private active: Promise<PresentationOutcome> | null = null;
  private input: Promise<InputEvent[]> | null = null;
  private readPromise: Promise<Uint8Array | null> | null = null;
  private exitIntent: 'return' | 'exit-0' | 129 | 143 = 'return';
  private cancellationRequested = false;
  private steeringAccepted = false;
  private followUpSlot: FollowUpSlot = 'closed';
  private followUpText: string | null = null;
  private firstIdleSigintAt: number | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private historyExportOperation:
    | Readonly<{
      readonly operation: Promise<void>;
      readonly binding: string;
      readonly generation: number;
    }>
    | null = null;
  private historyExportGeneration = 0;
  private noticeGeneration = 1_000_000;
  private crashSettlement: Promise<void> | null = null;
  private exitCode = 0;
  private signalCode: number | null = null;
  private signalsInstalled = false;
  private readonly pending?: PendingInputCore;
  private readonly overlay: ControllerOverlay;
  private readonly modern: boolean;
  private discardIntent: DiscardIntent | null = null;
  private steeringConsumedBridge = false;
  private resizeUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly lifecycle: TerminalLifecycle,
    private readonly renderer: TuiRenderer,
    private session: TuiSessionLike,
    options: TuiControllerOptions = {},
  ) {
    this.pending = options.pending;
    this.modern = options.pending !== undefined ||
      options.pathIndex !== undefined ||
      options.history !== undefined || options.navigation !== undefined;
    this.editorController = new ControllerEditor(
      renderer,
      this.pending,
      options.history ?? new TuiEditorHistory(),
      options.pathIndex,
      this.modern,
    );
    this.editor = this.editorController.editor;
    this.navigation = options.navigation;
    this.intents = options.intents;
    this.overlay = new ControllerOverlay({
      renderer,
      navigation: this.navigation,
      intents: this.intents,
      dispatch: (intent) => this.dispatchIntent(intent),
      setSession: (session) => {
        this.session = session;
      },
      idleAllowed: () => this.navigationIdleAllowed(),
      isIdle: () => this.state === 'idle',
      readyStatus: () => this.readyStatus(),
      modelSelection: () => this.session.modelSelectionSnapshot?.(),
      fail: (error) => this.fail(error),
    });
  }

  private readonly navigation?: TuiNavigationLike;
  private readonly intents?: PresentationIntentDispatcher;

  get currentState(): ControllerState {
    return this.state;
  }

  get hasActiveTurn(): boolean {
    return this.active !== null;
  }

  private selectModelFallback(
    selection: ModelSelection,
  ): Promise<PresentationIntentResult> {
    return (this.session.selectModel?.(selection) ?? Promise.resolve('unavailable')).then(
      (status) =>
        status === 'selected' || status === 'unchanged'
          ? {
            kind: 'model_selection' as const,
            status,
            selection: {
              provider: selection.provider,
              modelId: selection.modelId,
              effort: selection.effort,
            },
          }
          : {
            kind: 'rejected' as const,
            reason: status === 'busy' ? 'busy' as const : 'unavailable' as const,
          },
    );
  }

  /** Route production semantic effects through the neutral adapter command channel. */
  private dispatchIntent(
    intent: PresentationIntent,
  ): PresentationIntentResult | Promise<PresentationIntentResult> {
    if (this.intents !== undefined) return this.intents.dispatch(intent);
    switch (intent.kind) {
      case 'ordinary_submit':
        return this.session.submit(intent.text).then((outcome) => ({
          kind: 'outcome',
          outcome,
        }));
      case 'steering_submit':
        return { kind: 'accepted' };
      case 'cancel_active':
        this.session.cancelActiveTurn?.();
        return { kind: 'accepted' };
      case 'compaction':
        if (intent.action === 'preview') {
          return {
            kind: 'context_preview',
            preview: this.session.contextCompactionPreview?.(),
          };
        }
        if (intent.action === 'cancel') return { kind: 'accepted' };
        return (this.session.compactContext?.() ??
          Promise.resolve({ kind: 'refused', reason: 'unavailable' }))
          .then((result) => ({ kind: 'context_result', result }));
      case 'history_page':
        return Promise.resolve(
          this.session.historyPage?.(intent.page, intent.turn, 16),
        ).then((
          page,
        ) => ({ kind: 'history', page }));
      case 'history_export':
        return { kind: 'rejected', reason: 'unavailable' };
      case 'list_sessions':
        return {
          kind: 'listing',
          listing: { sessions: [], skippedInvalid: 0 },
        };
      case 'select_provider': {
        const current = this.session.modelSelectionSnapshot?.();
        return this.selectModelFallback(
          current?.provider === intent.provider
            ? current
            : defaultModelSelectionFor(intent.provider),
        );
      }
      case 'select_model': {
        const current = this.session.modelSelectionSnapshot?.();
        if (current !== undefined && current.provider !== intent.provider) {
          return { kind: 'rejected', reason: 'invalid' };
        }
        try {
          return this.selectModelFallback(
            selectModelFor(
              intent.provider,
              intent.modelId,
              intent.effort as ModelSelection['effort'],
            ),
          );
        } catch {
          return { kind: 'rejected', reason: 'invalid' };
        }
      }
      case 'resume_session':
      case 'follow_up_queue':
      case 'exit':
      case 'dismiss_overlay':
        return intent.kind === 'exit' ? { kind: 'exit', code: intent.code } : { kind: 'accepted' };
    }
  }

  private submitIntent(text: string): Promise<PresentationOutcome> {
    const result = this.dispatchIntent({ kind: 'ordinary_submit', text });
    return Promise.resolve(result).then((value) => {
      if (value.kind !== 'outcome') {
        throw new TuiControllerError('agent_failure');
      }
      return value.outcome;
    });
  }

  /** Synchronous event bridge used by the runtime before renderer delivery. */
  markSteeringConsumed(): void {
    if (this.pending === undefined) return;
    if (!this.pending.markSteeringConsumed()) {
      throw new TuiControllerError('agent_failure');
    }
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
    this.resizeUnsubscribe = this.lifecycle.subscribeResize((size) => {
      try {
        this.renderer.resize(size.columns, size.rows);
      } catch {
        this.handleCrash();
      }
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
      this.renderer.setStatus(
        this.navigation === undefined ? 'ready' : this.readyStatus(),
      );
      this.input = this.readEvents();
      while (
        this.state === 'idle' || this.state === 'busy' ||
        this.state === 'history-exporting'
      ) {
        if (this.active === null) {
          const events = await this.input;
          this.input = this.readEvents();
          if ((this.state as ControllerState) === 'history-exporting') {
            this.processHistoryExporting(events);
          } else this.processIdle(events);
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
      if (this.state === 'history-exporting') {
        this.processHistoryExporting([event]);
        continue;
      }
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
          if (!this.trySlashCommand()) this.submitIfNonblank();
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
    this.editorController.render();
  }

  private editEvent(event: InputEvent): void {
    this.editorController.apply(event);
  }

  private processModernEvents(
    events: readonly InputEvent[],
    busy: boolean,
  ): void {
    for (const event of events) {
      if (this.state === 'history-exporting') {
        this.processHistoryExporting([event]);
        continue;
      }
      if (!busy && this.overlay.isOpen) {
        this.processModalEvent(event);
        continue;
      }
      if (!busy && event.kind === 'f1') {
        this.openStartupHelp();
        continue;
      }
      if (event.kind === 'ctrl_c') {
        busy ? this.busyCtrlC() : this.modernCtrlC();
        continue;
      }
      if (event.kind === 'ctrl_d') {
        busy
          ? this.renderer.setStatus(
            'busy; Escape cancels, Ctrl-C twice discards and exits',
          )
          : this.modernCtrlD();
        continue;
      }
      if (event.kind === 'escape') {
        if (busy) this.busyEscape();
        else if (this.renderer.stateSnapshot().scroll.kind === 'anchored') {
          this.renderer.latest();
        } else this.renderer.setStatus('input ignored');
        continue;
      }
      if (event.kind === 'enter') {
        const slashCommand = slashCommandOf(this.editor.text);
        if (
          busy &&
          (slashCommand === 'history_export' || slashCommand === 'recover' ||
            slashCommand === 'provider' ||
            slashCommand === 'model' || slashCommand === 'effort')
        ) {
          this.renderer.setStatus(`busy; ${this.editor.text.trim()} waits for ready`);
        } else if (busy) this.submitSteeringIfNonblank();
        else if (!this.trySlashCommand()) this.submitIfNonblank();
        continue;
      }
      if (event.kind === 'alt_enter') {
        if (busy) this.queueFollowUpIfNonblank();
        else this.editEvent(event);
        continue;
      }
      if (!busy && event.kind === 'page_up') {
        this.renderer.scrollPage?.('up');
        continue;
      }
      if (!busy && event.kind === 'page_down') {
        this.renderer.scrollPage?.('down');
        continue;
      }
      if (!busy && (event.kind === 'up' || event.kind === 'down')) {
        if (this.walkInputHistory(event.kind)) continue;
      }
      if (event.kind === 'tab') {
        this.completePathAtCursor();
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

  private processModalEvent(event: InputEvent): void {
    this.overlay.process(event);
  }

  private openPicker(): void {
    this.overlay.openPicker();
  }

  private openStartupHelp(): void {
    this.overlay.openStartupHelp();
  }

  private openProviderPicker(): void {
    this.overlay.openProviderPicker();
  }

  private openModelPicker(): void {
    this.overlay.openModelPicker();
  }

  private openEffortPicker(): void {
    this.overlay.openEffortPicker();
  }

  private navigationIdleAllowed(): boolean {
    return this.state === 'idle' && this.active === null &&
      this.editor.text.length === 0 &&
      this.discardIntent === null && this.pending?.hasActiveTask !== true &&
      this.pending?.hasSteering !== true &&
      this.pending?.hasFollowUp !== true &&
      this.pending?.hasRecovery !== true;
  }

  private currentBindingIdentity(): string {
    if (this.intents !== undefined) {
      const projection = this.renderer.stateSnapshot().projection;
      return projection === undefined
        ? 'unbound'
        : `${projection.sessionId ?? 'no-session'}:${projection.agentId}`;
    }
    const position = this.navigation?.currentPosition() ??
      this.session.currentPosition?.();
    return position === undefined
      ? 'unbound'
      : `${position.sessionId ?? 'no-session'}:${position.agent}`;
  }

  private startHistoryExport(): void {
    if (this.state !== 'idle' || this.historyExportOperation !== null) {
      this.renderer.setStatus('history export already in progress');
      return;
    }
    const binding = this.currentBindingIdentity();
    let dispatched: PresentationIntentResult | Promise<PresentationIntentResult>;
    try {
      dispatched = this.dispatchIntent({ kind: 'history_export' });
    } catch (error) {
      if (isPresentationDeliveryError(error)) throw error;
      this.renderer.setStatus('history export failed');
      return;
    }
    const generation = ++this.historyExportGeneration;
    this.state = 'history-exporting';
    const operation = Promise.resolve(dispatched).then((result) => {
      const owned = this.historyExportOperation;
      if (owned === null || owned.generation !== generation) return;
      if (result.kind === 'rejected') {
        if (this.state === 'history-exporting') {
          this.state = 'idle';
          this.renderer.setStatus('history export unavailable');
        }
        return;
      }
      if (result.kind !== 'history_export') throw new PresentationDeliveryError();
      if (this.state !== 'history-exporting') return;
      if (this.currentBindingIdentity() !== binding) {
        this.state = 'idle';
        this.renderer.setStatus('history export completed for previous session');
        return;
      }
      this.renderer.eventSink({
        kind: 'notice',
        generation: ++this.noticeGeneration,
        text: `history exported through turn ${result.throughTurn}: ${result.path}`,
      });
      this.state = 'idle';
      this.renderer.setStatus(`history exported through turn ${result.throughTurn}`);
    }).catch((error: unknown) => {
      if (isPresentationDeliveryError(error)) throw error;
      const owned = this.historyExportOperation;
      if (
        owned !== null && owned.generation === generation &&
        this.state === 'history-exporting'
      ) {
        this.state = 'idle';
        this.renderer.setStatus('history export failed');
      }
    });
    const owned = Object.freeze({ operation, binding, generation });
    this.historyExportOperation = owned;
    void operation.then(
      () => {
        if (this.historyExportOperation === owned) this.historyExportOperation = null;
      },
      (error) => {
        if (this.historyExportOperation === owned) this.historyExportOperation = null;
        void this.fail(error).catch(() => {
          // The controller has already entered its fatal shutdown path.
        });
      },
    );
    // Once dispatch starts Host-local I/O, ownership must precede any fallible terminal redraw.
    this.renderer.setStatus('exporting history');
  }

  private processHistoryExporting(events: readonly InputEvent[]): void {
    for (const event of events) {
      if (this.state !== 'history-exporting') return;
      if (event.kind === 'enter') {
        if (slashCommandOf(this.editor.text) === 'exit') {
          this.trySlashCommand();
        } else {
          this.renderer.setStatus('history export in progress; retry when ready');
        }
        continue;
      }
      if (event.kind === 'ctrl_d') {
        this.modern ? this.modernCtrlD() : void this.shutdown(0);
        continue;
      }
      if (event.kind === 'ctrl_c') {
        this.modern ? this.modernCtrlC() : this.idleCtrlC();
        continue;
      }
      if (event.kind === 'page_up') {
        this.renderer.scrollPage?.('up');
        continue;
      }
      if (event.kind === 'page_down') {
        this.renderer.scrollPage?.('down');
        continue;
      }
      if (event.kind === 'escape') {
        if (this.renderer.stateSnapshot().scroll.kind === 'anchored') {
          this.renderer.latest();
        } else this.renderer.setStatus('history export in progress');
        continue;
      }
      if (event.kind === 'tab') {
        this.completePathAtCursor();
        continue;
      }
      if (event.kind === 'f1' || event.kind === 'unknown') {
        this.renderer.setStatus('history export in progress');
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
      this.editEvent(event);
    }
  }

  private modernCtrlD(): void {
    if (this.hasProcessPending()) {
      this.armDiscardConfirmation(
        'ctrl_d',
        'pending input; Ctrl-D again to discard and exit',
      );
    } else void this.shutdown(0);
  }
  private modernCtrlC(): void {
    this.idleCtrlC();
  }
  private hasProcessPending(): boolean {
    return this.editor.text.length > 0 || this.pending?.hasRecovery === true ||
      this.pending?.hasActiveTask === true ||
      this.pending?.hasSteering === true ||
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
      this.editorController.resetHistory();
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
    this.editorController.completePath();
  }
  private popRecovery(): void {
    this.editorController.recover();
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
          if (
            slashCommandOf(this.editor.text) === 'history_export' ||
            slashCommandOf(this.editor.text) === 'recover' ||
            slashCommandOf(this.editor.text) === 'provider' ||
            slashCommandOf(this.editor.text) === 'model' ||
            slashCommandOf(this.editor.text) === 'effort'
          ) {
            this.renderer.setStatus(`busy; ${this.editor.text.trim()} waits for ready`);
          } else if (steeringAvailable) this.submitSteeringIfNonblank();
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
      const slashCommand = slashCommandOf(this.editor.text);
      this.renderer.setStatus(
        slashCommand === 'history_export'
          ? 'busy; /history export waits for ready'
          : slashCommand === 'recover'
          ? 'busy; /recover waits for ready'
          : slashCommand === 'provider'
          ? 'busy; /provider waits for ready'
          : slashCommand === 'model'
          ? 'busy; /model waits for ready'
          : slashCommand === 'effort'
          ? 'busy; /effort waits for ready'
          : 'steering unavailable',
      );
    }
    // Every other event is deliberately consumed and discarded.
  }

  /** Fixed built-in slash commands; exact match only, never sent to the model. */
  private trySlashCommand(): boolean {
    const parsed = slashCommandOf(this.editor.text);
    if (parsed === null) return false;
    if (parsed === 'unknown') {
      // Keep the whole hint in one ' · '-free segment so the footer keeps it
      // instead of popping the valid list at narrow widths.
      this.renderer.setStatus(
        `unknown command ${this.editor.text.trim()}, try: /help, /sessions, /provider, /model, /effort, /history export, /recover, /exit`,
      );
      return true;
    }
    const command: SlashCommand = parsed;
    this.editor.clear();
    this.editorController.resetHistory();
    this.renderEditorState();
    if (command === 'help') this.openStartupHelp();
    else if (command === 'sessions') this.openPicker();
    else if (command === 'provider') this.openProviderPicker();
    else if (command === 'model') this.openModelPicker();
    else if (command === 'effort') this.openEffortPicker();
    else if (command === 'history_export') this.startHistoryExport();
    else if (command === 'recover') this.popRecovery();
    else if (this.modern) this.modernCtrlD();
    else if (this.editor.text.length === 0) void this.shutdown(0);
    else this.renderer.setStatus('Ctrl-D exits only on empty input');
    return true;
  }

  /** Up/Down-edge input-history walk; plain cursor moves stay in editEvent. */
  private walkInputHistory(direction: 'up' | 'down'): boolean {
    return this.editorController.walkHistory(direction);
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
    if (this.renderer.stateSnapshot().scroll.kind === 'anchored') {
      this.renderer.latest(false);
    }
    this.pending?.clearSideEffectWarning();
    if (this.modern) this.editorController.record(text);
    this.editor.clear();
    this.renderEditorState();
    this.followUpSlot = 'open-empty';
    this.followUpText = null;
    this.renderer.setFollowUpPending(false);
    this.state = 'busy';
    this.cancellationRequested = false;
    this.steeringAccepted = false;
    try {
      this.active = this.submitIntent(text);
    } catch (error) {
      this.active = Promise.reject(error);
    }
  }

  private finishTurn(outcome: PresentationOutcome): void {
    if (this.modern) {
      this.finishModernTurn(outcome);
      return;
    }
    this.clearSteeringEditorStrict();
    this.renderer.clearLiveProgress();
    if (outcome.diagnostic !== undefined) {
      this.renderer.renderFailureDiagnostic(
        outcome.diagnostic,
        outcome.diagnosticDurability,
        outcome.diagnosticPersistenceError,
      );
    }
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
      (outcome.stopReason === 'final' ||
        outcome.stopReason === 'tool_terminal') &&
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

  private finishModernTurn(outcome: PresentationOutcome): void {
    this.renderer.clearLiveProgress();
    if (outcome.diagnostic !== undefined) {
      this.renderer.renderFailureDiagnostic(
        outcome.diagnostic,
        outcome.diagnosticDurability,
        outcome.diagnosticPersistenceError,
      );
    }
    if (this.exitIntent !== 'return' && outcome.stopReason === 'cancelled') {
      this.pending?.clearAll();
      this.editor.clear();
      this.renderEditorState();
      void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent);
      return;
    }
    const recoverable = !outcome.ok && (
      outcome.stopReason === 'cancelled' ||
      outcome.stopReason === 'max_steps' ||
      outcome.stopReason === 'contract_failure'
    ) &&
      (this.intents !== undefined || (this.session.isAvailable?.() ?? true)) &&
      this.exitIntent === 'return';
    if (
      outcome.ok &&
      (outcome.stopReason === 'final' || outcome.stopReason === 'tool_terminal')
    ) {
      this.pending?.commitTask();
      if (this.pending?.hasSteering) this.pending.recoverSteering();
      if (
        outcome.stopReason === 'tool_terminal' &&
        typeof outcome.finalText === 'string'
      ) {
        this.renderer.renderAssistantFinal(outcome.finalText);
      }
    } else if (recoverable) {
      if (
        this.pending !== undefined &&
        !this.pending.recoverAfterSettlement(outcome.toolCallCount)
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
      outcome.ok &&
      (outcome.stopReason === 'final' ||
        outcome.stopReason === 'tool_terminal') &&
      this.pending?.hasFollowUp === true
    ) {
      const text = this.pending.takeFollowUpAsTask();
      if (text === null) throw new TuiControllerError('agent_failure');
      this.editorController.record(text);
      this.renderer.setStatus('busy · starting follow-up');
      this.startAutomaticTurn(text);
      return;
    }
    this.state = 'idle';
    if (recoverable && this.editor.text.length === 0 && this.pending?.hasRecovery === true) {
      this.popRecovery();
      return;
    }
    (this.renderer as TuiRenderer & {
      setPendingMetadata?: (
        value: ReturnType<PendingInputCore['snapshot']> | undefined,
      ) => void;
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
    if (this.intents !== undefined) {
      const projection = this.renderer.stateSnapshot().projection;
      if (projection === undefined || projection.sessionId === undefined) {
        return 'ready';
      }
      const checkpoint = projection.checkpoint;
      const context = checkpoint === undefined
        ? ''
        : ` · context through ${checkpoint.coveredThroughTurn} · retain ${checkpoint.retainedFromTurn}+`;
      const semantic = checkpoint?.projectedMessagesBytes === undefined
        ? ''
        : ` · semantic ≤${checkpoint.projectedMessagesBytes}B`;
      return `session ${
        projection.sessionId.slice(0, 8)
      } · agent ${projection.agentId} · turn ${projection.committedTurn} · ready${context}${semantic}`;
    }
    const metrics = this.session.contextSnapshot?.();
    const position = this.navigation?.currentPosition() ??
      this.session.currentPosition?.();
    const prefix = position?.sessionId === undefined
      ? undefined
      : `session ${
        position.sessionId.slice(0, 8)
      } · agent ${position.agent} · turn ${position.committedTurn}`;
    const context = position?.checkpoint === undefined
      ? ''
      : ` · context through ${position.checkpoint.coveredThroughTurn} · retain ${position.checkpoint.retainedFromTurn}+`;
    const semantic = position?.checkpoint?.projectedMessagesBytes === undefined
      ? ''
      : ` · semantic ≤${position.checkpoint.projectedMessagesBytes}B`;
    if (metrics === undefined) {
      const base = prefix === undefined ? 'ready' : `${prefix} · ready`;
      return `${base}${context}${semantic}`;
    }
    const estimateK = Math.ceil(metrics.messageEstimatedTokensAfter / 1024);
    const base = `${
      prefix === undefined ? 'ready' : `${prefix} · ready`
    }${context}${semantic} · ctx ≤${estimateK}K/64K est`;
    return metrics.compressedResultCount === 0
      ? base
      : `${base} · ${metrics.compressedResultCount} omitted`;
  }

  private idleCtrlC(): void {
    this.discardIntent = null;
    this.editor.clear();
    this.editorController.resetHistory();
    this.renderEditorState();
    this.renderer.setStatus(
      this.pending?.hasRecovery === true
        ? 'ready · recoverable input available; use /recover'
        : this.readyStatus(),
    );
  }

  /** Preserve the pre-increment-6 external SIGINT transition independently of keyboard Ctrl-C. */
  private idleSigint(): void {
    if (this.modern && this.hasProcessPending()) {
      this.armDiscardConfirmation(
        'ctrl_c',
        'pending input; Ctrl-C again to discard and exit',
      );
      return;
    }
    const now = Date.now();
    if (this.firstIdleSigintAt !== null && now - this.firstIdleSigintAt <= 500) {
      void this.shutdown(0);
      return;
    }
    this.editor.clear();
    this.renderer.setEditor('');
    this.firstIdleSigintAt = now;
    this.renderer.setStatus('press Ctrl-C again to exit');
    setTimeout(() => {
      if (
        this.firstIdleSigintAt !== null && Date.now() - this.firstIdleSigintAt > 500
      ) {
        this.firstIdleSigintAt = null;
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
        if (
          this.discardIntent !== null &&
          Date.now() >= this.discardIntent.deadline
        ) {
          this.discardIntent = null;
        }
      }, 2_001);
      return;
    }
    this.setExitIntent('exit-0');
    this.requestBusyCancellation('cancelling; exiting');
    if (
      this.intents === undefined && this.session.cancelActiveTurn === undefined
    ) {
      this.renderer.setStatus('exiting after current turn');
    }
  }

  private busyEscape(): void {
    this.requestBusyCancellation('cancelling');
  }

  private requestBusyCancellation(status: string): void {
    if (
      this.intents === undefined && this.session.cancelActiveTurn === undefined
    ) {
      this.renderer.clearLiveProgress();
      this.dropFollowUpStrict();
      this.clearSteeringEditorBestEffort();
      this.renderer.setStatus('cancellation unavailable; turn continues');
      return;
    }
    if (!this.cancellationRequested) {
      if (this.intents !== undefined) {
        const result = this.dispatchIntent({ kind: 'cancel_active' });
        this.cancellationRequested = result !== undefined;
      } else {
        const result = this.session.cancelActiveTurn!();
        this.cancellationRequested = result !== 'idle';
      }
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
      else this.idleSigint();
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
        this.editorController.resetHistory();
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
    this.editorController.resetHistory();
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
    this.shutdownPromise = (async () => {
      await this.settleNavigation();
      await this.settleHistoryExport();
      await this.lifecycle.restore();
    })();
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
    await this.settleNavigation();
    await this.settleHistoryExport();
    if (this.shutdownPromise === null) {
      // Fatal controller/agent failures override any previously requested signal exit intent.
      this.exitCode = 1;
      this.shutdownPromise = this.lifecycle.restore();
    }
    await this.shutdownPromise;
    if (error instanceof TuiControllerError) return;
    if (isPresentationDeliveryError(error)) {
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
      if (this.intents !== undefined) {
        this.dispatchIntent({ kind: 'cancel_active' });
      } else this.session.cancelActiveTurn?.();
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
    await this.settleNavigation();
    await this.settleHistoryExport();
    if (this.shutdownPromise === null) {
      this.shutdownPromise = this.lifecycle.restore();
    }
    await this.shutdownPromise;
  }

  private async settleNavigation(): Promise<void> {
    await this.overlay.settle();
  }

  private async settleHistoryExport(): Promise<void> {
    const owned = this.historyExportOperation;
    if (owned === null) return;
    await Promise.allSettled([owned.operation]);
    if (this.historyExportOperation === owned) this.historyExportOperation = null;
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
      this.active = this.submitIntent(text);
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
    if (this.modern) this.editorController.resetHistory();
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
    if (
      this.pending !== undefined &&
      this.pending.reserveSteering(text) === 'refused'
    ) {
      this.renderer.setStatus('steering already accepted');
      return;
    }
    let result: 'accepted' | 'idle' | 'already_accepted';
    try {
      if (this.intents !== undefined) {
        const dispatched = this.dispatchIntent({
          kind: 'steering_submit',
          text,
        });
        result = dispatched instanceof Promise
          ? 'accepted'
          : dispatched.kind === 'accepted'
          ? 'accepted'
          : 'idle';
      } else result = this.session.steerActiveTurn!(text);
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
      if (
        this.pending !== undefined && !this.pending.commitSteeringReservation()
      ) {
        throw new TuiControllerError('agent_failure');
      }
      this.steeringAccepted = true;
      if (this.modern) this.editorController.resetHistory();
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
