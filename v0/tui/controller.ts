import {
  isPresentationError,
  movePresentationPickerSelection,
  type PresentationContextPreview,
  PresentationDeliveryError,
  type PresentationHistoryPage,
  type PresentationIntent,
  type PresentationIntentDispatcher,
  type PresentationIntentResult,
  type PresentationNavigationListing,
  type PresentationOutcome,
  type PresentationPosition,
} from '../presentation/contract.ts';
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
export interface TuiSessionLike {
  submit(text: string): Promise<PresentationOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?():
    | import('../presentation/contract.ts').PresentationContextMetrics
    | undefined;
  isAvailable?(): boolean;
  historyPage?(
    page: number,
    turn?: number,
    rows?: number,
  ):
    | Promise<PresentationHistoryPage | undefined>
    | PresentationHistoryPage
    | undefined;
  currentPosition?(): PresentationPosition | undefined;
  contextCompactionPreview?(): PresentationContextPreview | undefined;
  compactContext?(
    signal?: AbortSignal,
  ): Promise<import('../presentation/contract.ts').PresentationContextResult>;
  checkpointSnapshot?(): {
    readonly summary: string;
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
}

export interface TuiNavigationLike {
  readonly persistent: boolean;
  list(signal?: AbortSignal): Promise<PresentationNavigationListing>;
  switchTo(id: string, signal?: AbortSignal): Promise<{
    readonly session: TuiSessionLike;
    readonly position: PresentationPosition;
    readonly restored?: {
      readonly messages: readonly import('../presentation/contract.ts').PresentationMessage[];
      readonly omitted: number;
    };
  }>;
  historyPage(
    page: number,
    turn?: number,
    rows?: number,
  ): Promise<PresentationHistoryPage | undefined>;
  currentPosition(): PresentationPosition;
}

const isPresentationDeliveryError = (error: unknown): boolean =>
  error instanceof PresentationDeliveryError ||
  isPresentationError(error, 'PresentationDeliveryError') ||
  isPresentationError(error, 'EventDeliveryError');
const isCancellationCleanup = (error: unknown): boolean =>
  isPresentationError(error, 'CancellationCleanupError');

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

export interface TuiControllerOptions {
  /** Enables the Step 82 fixed-lane/editor behavior when supplied by the TUI runtime. */
  readonly pending?: PendingInputCore;
  readonly history?: TuiEditorHistory;
  readonly pathIndex?: WorkspacePathIndex;
  /** Persistent host-owned picker/resume/history navigation. */
  readonly navigation?: TuiNavigationLike;
  /** Production-only typed intent authority; legacy session calls remain test-seam compatible. */
  readonly intents?: PresentationIntentDispatcher;
}

type ControllerState =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'compacting'
  | 'history-exporting'
  | 'exiting'
  | 'failed';
type FollowUpSlot = 'closed' | 'open-empty' | 'pending';
type DiscardKey = 'ctrl_c' | 'ctrl_d';
type DiscardIntent = Readonly<{ key: DiscardKey; deadline: number }>;

const sleep = (duration: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), duration));

export type SlashCommand = 'help' | 'sessions' | 'history_export' | 'recover' | 'exit';

/** Exact-match built-in slash parse; args and unknown names are 'unknown', plain tasks are null. */
export const slashCommandOf = (
  text: string,
): SlashCommand | 'unknown' | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed === '/history export') return 'history_export';
  if (
    trimmed === '/help' || trimmed === '/sessions' || trimmed === '/recover' ||
    trimmed === '/exit'
  ) {
    return trimmed.slice(1) as SlashCommand;
  }
  return 'unknown';
};

/** Controller for the first TUI's intentionally small idle/busy state machine. */
export class TuiController {
  readonly editor = new TuiEditor();
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
  private compactionAbort: AbortController | null = null;
  private compactionOperation: Promise<void> | null = null;
  private historyExportOperation:
    | Readonly<{
      readonly operation: Promise<void>;
      readonly binding: string;
      readonly generation: number;
    }>
    | null = null;
  private historyExportGeneration = 0;
  private noticeGeneration = 1_000_000;
  private readonly navigationOperations = new Set<{
    readonly operation: Promise<void>;
    readonly abort: AbortController;
    readonly generation: number;
  }>();
  private navigationGeneration = 0;
  private readonly historyOperations = new Set<{
    readonly operation: Promise<void>;
    readonly abort: AbortController;
    readonly generation: number;
  }>();
  private historyGeneration = 0;
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
  private resizeUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly lifecycle: TerminalLifecycle,
    private readonly renderer: TuiRenderer,
    private session: TuiSessionLike,
    options: TuiControllerOptions = {},
  ) {
    this.pending = options.pending;
    this.history = options.history ?? new TuiEditorHistory();
    this.pathIndex = options.pathIndex;
    this.modern = options.pending !== undefined ||
      options.pathIndex !== undefined ||
      options.history !== undefined || options.navigation !== undefined;
    this.navigation = options.navigation;
    this.intents = options.intents;
  }

  private readonly navigation?: TuiNavigationLike;
  private readonly intents?: PresentationIntentDispatcher;
  private modal:
    | { readonly kind: 'startup-help' }
    | {
      readonly kind: 'picker';
      readonly listing: PresentationNavigationListing;
      readonly selected: number;
      readonly page: number;
    }
    | { readonly kind: 'picker-loading' }
    | { readonly kind: 'history'; readonly page: PresentationHistoryPage }
    | { readonly kind: 'context'; readonly preview: PresentationContextPreview }
    | null = null;

  get currentState(): ControllerState {
    return this.state;
  }

  get hasActiveTurn(): boolean {
    return this.active !== null;
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
        this.state === 'compacting' || this.state === 'history-exporting'
      ) {
        if (this.active === null) {
          const events = await this.input;
          this.input = this.readEvents();
          if ((this.state as ControllerState) === 'compacting') {
            this.processCompacting(events);
          } else if ((this.state as ControllerState) === 'history-exporting') {
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
    const snapshot = this.editor.snapshot();
    if (!this.modern) {
      this.renderer.setEditor(snapshot.text);
      return;
    }
    const renderer = this.renderer as TuiRenderer & {
      setEditorSnapshot?: (value: typeof snapshot) => void;
    };
    if (renderer.setEditorSnapshot !== undefined) {
      renderer.setEditorSnapshot(snapshot);
    } else renderer.setEditor(snapshot.text);
    const withMetadata = this.renderer as TuiRenderer & {
      setPendingMetadata?: (
        value: ReturnType<PendingInputCore['snapshot']> | undefined,
      ) => void;
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
        this.renderer.setStatus(
          'newline is Alt+Return (Shift/Ctrl+Return where sent)',
        );
        break;
      case 'ctrl_w':
        changed = this.editor.deleteWordBackward();
        textMutation = true;
        break;
      case 'ctrl_a':
        changed = this.editor.home();
        break;
      case 'ctrl_e':
        changed = this.editor.end();
        break;
      case 'ctrl_b':
        changed = this.editor.moveLeft();
        break;
      case 'ctrl_f':
        changed = this.editor.moveRight();
        break;
      case 'ctrl_u':
        changed = this.editor.deleteToLineStart();
        textMutation = true;
        break;
      case 'ctrl_k':
        changed = this.editor.deleteToLineEnd();
        textMutation = true;
        break;
      case 'alt_b':
        changed = this.editor.moveWordLeft();
        break;
      case 'alt_f':
        changed = this.editor.moveWordRight();
        break;
      case 'alt_d':
        changed = this.editor.deleteWordForward();
        textMutation = true;
        break;
      case 'newline':
      case 'alt_enter':
        changed = this.editor.insert('\n');
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
    } else if (
      event.kind === 'paste' || event.kind === 'printable' ||
      event.kind === 'newline' || event.kind === 'alt_enter'
    ) {
      this.renderer.setStatus(
        event.kind === 'paste' ? 'paste exceeds 64 KiB' : 'input too long',
      );
    }
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
      if (!busy && this.modal !== null) {
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
        if (busy && slashCommand === 'history_export') {
          this.renderer.setStatus('busy; /history export waits for ready');
        } else if (busy && slashCommand === 'recover') {
          this.renderer.setStatus('busy; /recover waits for ready');
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
    const modal = this.modal;
    if (modal === null) return;
    if (event.kind === 'escape') {
      if (modal.kind === 'picker-loading') this.cancelNavigationOperations();
      else if (modal.kind === 'history') this.cancelHistoryOperations();
      this.modal = null;
      this.renderer.clearModal?.();
      this.renderer.setStatus(this.readyStatus());
      return;
    }
    if (modal.kind === 'startup-help') {
      if (event.kind === 'f1') {
        this.modal = null;
        this.renderer.clearModal?.();
        this.renderer.setStatus(this.readyStatus());
      }
      return;
    }
    if (modal.kind === 'picker-loading') return;
    if (modal.kind === 'picker') {
      const count = modal.listing.sessions.length;
      let selected = modal.selected;
      let page = modal.page;
      if (
        event.kind === 'up' || event.kind === 'down' || event.kind === 'left' ||
        event.kind === 'right'
      ) {
        const moved = movePresentationPickerSelection(
          count,
          selected,
          page,
          event.kind,
        );
        selected = moved.selected;
        page = moved.page;
        this.modal = { ...modal, selected, page };
        this.renderer.renderSessionPicker?.(modal.listing, selected, page);
        return;
      }
      if (event.kind === 'enter') {
        const row = modal.listing.sessions[selected];
        if (row === undefined || row.current) {
          this.modal = null;
          this.renderer.clearModal?.();
          this.renderer.setStatus(this.readyStatus());
          return;
        }
        const abort = new AbortController();
        const generation = ++this.navigationGeneration;
        this.trackNavigationOperation(
          this.resumeSelected(row.id, generation, abort.signal),
          abort,
          generation,
        );
      }
      return;
    }
    if (modal.kind === 'history') {
      let page = modal.page.page;
      let turn = modal.page.turn;
      if (event.kind === 'up') {
        if (page > 0) page -= 1;
        else turn = Math.max(1, turn - 1);
      } else if (event.kind === 'down') {
        if (page + 1 < modal.page.pageCount) page += 1;
        else turn = Math.min(modal.page.totalTurns, turn + 1);
      } else if (event.kind === 'home') {
        turn = 1;
        page = 0;
      } else if (event.kind === 'end') {
        turn = modal.page.totalTurns;
        page = Number.MAX_SAFE_INTEGER;
      } else if (!(event.kind === 'printable' && event.text === 'v')) {
        return;
      }
      if (
        this.intents === undefined && this.navigation === undefined &&
        this.session.historyPage === undefined
      ) return;
      this.startHistoryPageLoad(page, turn);
      return;
    }
    if (modal.kind === 'context') {
      if (event.kind === 'printable' && event.text === 'v') {
        if (this.intents !== undefined) {
          this.renderer.setStatus(
            'context checkpoint summary available after install',
          );
          return;
        }
        const checkpoint = this.session.checkpointSnapshot?.();
        if (checkpoint === undefined) {
          this.renderer.setStatus('no active context checkpoint');
        } else {this.renderer.renderContextSummary?.(
            checkpoint.summary,
            checkpoint.coveredThroughTurn,
          );}
      } else if (event.kind === 'enter') {
        this.startContextCompaction();
      }
    }
  }

  private processCompacting(events: readonly InputEvent[]): void {
    for (const event of events) {
      if (event.kind === 'escape') {
        this.requestCompactionCancellation();
        this.renderer.setStatus('cancelling context compaction');
      } else if (event.kind === 'ctrl_c') {
        const now = Date.now();
        if (
          this.discardIntent !== null && this.discardIntent.key === 'ctrl_c' &&
          this.discardIntent.deadline >= now
        ) {
          this.discardIntent = null;
          this.setExitIntent('exit-0');
        } else {
          this.discardIntent = { key: 'ctrl_c', deadline: now + 2_000 };
        }
        this.requestCompactionCancellation();
        this.renderer.setStatus(
          this.exitIntent === 'exit-0'
            ? 'cancelling context compaction; exiting'
            : 'cancelling context compaction; Ctrl-C again to discard and exit',
        );
      }
    }
  }

  private openPicker(): void {
    if (!this.navigationIdleAllowed()) {
      this.renderer.setStatus('navigation requires an empty idle session');
      return;
    }
    if (
      this.intents === undefined &&
      (this.navigation === undefined || !this.navigation.persistent)
    ) {
      this.renderer.setStatus('session picker unavailable');
      return;
    }
    this.modal = { kind: 'picker-loading' };
    this.renderer.renderSessionPicker?.(
      { sessions: [], skippedInvalid: 0 },
      0,
      0,
      true,
    );
    const abort = new AbortController();
    const generation = ++this.navigationGeneration;
    const operation = Promise.resolve(
      this.intents !== undefined
        ? this.dispatchIntent({ kind: 'list_sessions' })
        : this.navigation!.list(abort.signal).then((listing) => ({
          kind: 'listing' as const,
          listing,
        })),
    ).then(
      (result) => {
        if (result.kind !== 'listing') return;
        const listing = result.listing;
        if (
          this.state !== 'idle' || this.modal?.kind !== 'picker-loading' ||
          abort.signal.aborted || this.navigationGeneration !== generation
        ) return;
        this.modal = { kind: 'picker', listing, selected: 0, page: 0 };
        this.renderer.renderSessionPicker?.(listing, 0, 0);
      },
      (error: unknown) => {
        if (
          isPresentationError(error, 'NavigationCancelledError') ||
          abort.signal.aborted
        ) return;
        if (
          this.state !== 'idle' || this.modal?.kind !== 'picker-loading' ||
          this.navigationGeneration !== generation
        ) return;
        this.modal = null;
        this.renderer.clearModal?.();
        this.renderer.setStatus('session list unavailable');
      },
    );
    this.trackNavigationOperation(operation, abort, generation);
  }

  private openStartupHelp(): void {
    this.modal = { kind: 'startup-help' };
    this.renderer.renderStartupHelp?.();
  }

  /** Keep modal I/O inside the controller's shutdown/failure settlement boundary. */
  private trackNavigationOperation(
    operation: Promise<void>,
    abort: AbortController,
    generation: number,
  ): void {
    const owned = { operation, abort, generation };
    this.navigationOperations.add(owned);
    void operation.then(
      () => {
        this.navigationOperations.delete(owned);
      },
      (error) => {
        this.navigationOperations.delete(owned);
        if (
          isPresentationError(error, 'NavigationCancelledError') ||
          abort.signal.aborted &&
            !isPresentationError(error, 'NavigationFatalError') &&
            !isPresentationDeliveryError(error)
        ) return;
        void this.fail(error).catch(() => {
          // The controller has already entered its fatal shutdown path.
        });
      },
    );
  }

  private async resumeSelected(
    id: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.intents === undefined && this.navigation === undefined) return;
    this.modal = { kind: 'picker-loading' };
    this.renderer.renderSessionPicker?.(
      { sessions: [], skippedInvalid: 0 },
      0,
      0,
      true,
    );
    try {
      let position: PresentationPosition;
      let restored: {
        readonly messages: readonly import('../presentation/contract.ts').PresentationMessage[];
        readonly omitted: number;
      } | undefined;
      if (this.intents !== undefined) {
        const result = await this.dispatchIntent({
          kind: 'resume_session',
          id,
        });
        if (result.kind !== 'binding') throw new PresentationDeliveryError();
        position = result.position;
        restored = result.restored;
      } else {
        const binding = await this.navigation!.switchTo(id, signal);
        this.session = binding.session;
        position = binding.position;
        restored = binding.restored;
      }
      // switchTo owns an irreversible old-close boundary. It may resolve after cancellation only
      // when it has already transferred ownership to the target; adopt that binding before
      // checking generation so shutdown/dismissal cannot retain a closed old session.
      if (
        this.state !== 'idle' || signal.aborted ||
        this.navigationGeneration !== generation
      ) return;
      this.modal = null;
      this.renderer.clearModal?.();
      if (this.intents === undefined && restored !== undefined) {
        this.renderer.renderRestored(restored.messages, restored.omitted);
      }
      if (this.state !== 'idle') return;
      this.renderer.setCurrentPosition?.(position);
      this.renderer.setStatus(this.readyStatus());
    } catch (error) {
      if (
        isPresentationError(error, 'NavigationFatalError') ||
        isPresentationDeliveryError(error)
      ) throw error;
      if (
        isPresentationError(error, 'NavigationCancelledError') || signal.aborted
      ) return;
      if (this.navigationGeneration !== generation) return;
      this.modal = null;
      this.renderer.clearModal?.();
      this.renderer.setStatus(
        'session resume failed; current session unchanged',
      );
    }
  }

  /** Invalidate and abort every unresolved navigation operation, not just the latest one. */
  private cancelNavigationOperations(): void {
    this.navigationGeneration += 1;
    if (this.intents !== undefined) {
      const dispatched = this.dispatchIntent({ kind: 'dismiss_overlay' });
      if (dispatched instanceof Promise) {
        void dispatched.catch(() => {
          // The owned navigation operation remains responsible for its settlement result.
        });
      }
    }
    for (const operation of this.navigationOperations) {
      operation.abort.abort('navigation dismissed');
    }
    this.cancelHistoryOperations();
  }

  private cancelHistoryOperations(): void {
    this.historyGeneration += 1;
    for (const operation of this.historyOperations) {
      operation.abort.abort('history dismissed');
    }
  }

  private openHistory(): void {
    if (!this.navigationIdleAllowed()) {
      this.renderer.setStatus('history requires an empty idle session');
      return;
    }
    if (
      this.intents === undefined && this.navigation === undefined &&
      this.session.historyPage === undefined
    ) {
      this.renderer.setStatus('history unavailable');
      return;
    }
    const position = this.navigation?.currentPosition() ??
      (this.intents !== undefined
        ? (() => {
          const projection = this.renderer.stateSnapshot().projection;
          return projection === undefined ? undefined : {
            sessionId: projection.sessionId,
            agent: projection.agentId,
            committedTurn: projection.committedTurn,
            messageCount: 0,
            checkpoint: projection.checkpoint,
          };
        })()
        : this.session.currentPosition?.());
    const turn = position?.committedTurn ?? 1;
    this.modal = {
      kind: 'history',
      page: {
        turn,
        totalTurns: turn,
        page: 0,
        pageCount: 1,
        entries: [],
        sourceBytes: 0,
        omitted: false,
      },
    };
    this.startHistoryPageLoad(0, turn);
  }

  private startHistoryPageLoad(page: number, turn: number): void {
    this.cancelHistoryOperations();
    const abort = new AbortController();
    const generation = ++this.historyGeneration;
    const operation = this.loadHistoryPage(
      page,
      turn,
      generation,
      abort.signal,
    );
    const owned = { operation, abort, generation };
    this.historyOperations.add(owned);
    void operation.then(
      () => {
        this.historyOperations.delete(owned);
      },
      (error) => {
        this.historyOperations.delete(owned);
        if (isPresentationDeliveryError(error) || !abort.signal.aborted) {
          void this.fail(error).catch(() => {
            // The controller has already entered its fatal shutdown path.
          });
        }
      },
    );
  }

  private async loadHistoryPage(
    page: number,
    turn: number,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (signal.aborted || generation !== this.historyGeneration) return;
      const result = this.intents !== undefined
        ? await this.dispatchIntent({ kind: 'history_page', page, turn })
        : {
          kind: 'history' as const,
          page: this.navigation !== undefined
            ? await this.navigation.historyPage(page, turn, 16)
            : await this.session.historyPage?.(page, turn, 16),
        };
      if (
        signal.aborted || generation !== this.historyGeneration ||
        this.modal?.kind !== 'history'
      ) return;
      if (result.kind !== 'history' || result.page === undefined) {
        this.modal = null;
        this.renderer.setStatus('history unavailable');
        return;
      }
      this.modal = { kind: 'history', page: result.page };
      if (this.intents === undefined) {
        this.renderer.renderHistoryPage?.(result.page);
      }
    } catch (error) {
      if (isPresentationDeliveryError(error)) throw error;
      if (signal.aborted || generation !== this.historyGeneration) return;
      this.modal = null;
      this.renderer.setStatus('history unavailable');
    }
  }

  private openContextPanel(): void {
    if (!this.navigationIdleAllowed()) {
      this.renderer.setStatus(
        'context recovery requires an empty idle session',
      );
      return;
    }
    if (
      this.intents === undefined && (
        this.navigation === undefined || !this.navigation.persistent ||
        this.session.contextCompactionPreview === undefined ||
        this.session.compactContext === undefined
      )
    ) {
      this.renderer.setStatus('context recovery unavailable');
      return;
    }
    try {
      const dispatched = this.intents === undefined
        ? {
          kind: 'context_preview' as const,
          preview: this.session.contextCompactionPreview!(),
        }
        : this.dispatchIntent({ kind: 'compaction', action: 'preview' });
      if (
        dispatched instanceof Promise || dispatched.kind !== 'context_preview'
      ) {
        this.renderer.setStatus('context recovery unavailable');
        return;
      }
      const preview = dispatched.preview;
      if (preview === undefined) {
        this.renderer.setStatus('context recovery unavailable');
        return;
      }
      this.modal = { kind: 'context', preview };
      this.renderer.renderContextPanel?.(preview);
    } catch (error) {
      if (isPresentationDeliveryError(error)) throw error;
      this.renderer.setStatus('context recovery unavailable');
    }
  }

  private navigationIdleAllowed(): boolean {
    return this.state === 'idle' && this.active === null &&
      this.editor.text.length === 0 &&
      this.discardIntent === null && this.pending?.hasActiveTask !== true &&
      this.pending?.hasSteering !== true &&
      this.pending?.hasFollowUp !== true &&
      this.pending?.hasRecovery !== true;
  }

  private async confirmContextCompaction(): Promise<void> {
    if (
      this.modal?.kind !== 'context' ||
      (this.intents === undefined && this.session.compactContext === undefined)
    ) return;
    this.modal = null;
    this.renderer.clearModal?.();
    this.state = 'compacting';
    if (this.intents === undefined) {
      this.compactionAbort = new AbortController();
    }
    this.renderer.setStatus('compacting · one provider request');
    try {
      const dispatched = this.intents === undefined
        ? {
          kind: 'context_result' as const,
          result: await this.session.compactContext!(
            this.compactionAbort!.signal,
          ),
        }
        : await this.dispatchIntent({ kind: 'compaction', action: 'confirm' });
      if (dispatched.kind !== 'context_result') {
        throw new PresentationDeliveryError();
      }
      const result = dispatched.result;
      if (
        this.exitIntent !== 'return' ||
        (this.state as ControllerState) === 'failed' ||
        (this.state as ControllerState) === 'exiting'
      ) return;
      this.state = 'idle';
      this.renderer.setStatus(
        result.kind === 'installed'
          ? `context checkpoint · through turn ${result.coveredThroughTurn}`
          : result.reason ?? 'context compaction refused',
      );
    } catch (error) {
      if (isCancellationCleanup(error)) {
        this.state = 'failed';
        throw error;
      }
      if (isPresentationDeliveryError(error)) throw error;
      if (
        (this.state as ControllerState) !== 'failed' &&
        (this.state as ControllerState) !== 'exiting'
      ) {
        this.state = 'idle';
        this.renderer.setStatus('context compaction failed');
      }
    } finally {
      this.compactionAbort = null;
    }
  }

  private requestCompactionCancellation(): void {
    if (this.intents === undefined) {
      this.compactionAbort?.abort('context compaction cancelled');
      return;
    }
    const dispatched = this.dispatchIntent({
      kind: 'compaction',
      action: 'cancel',
    });
    if (dispatched instanceof Promise) {
      void dispatched.catch(() => {
        // The owned compaction operation reports the authoritative failure or cancellation.
      });
    }
  }

  private startContextCompaction(): void {
    const operation = this.confirmContextCompaction();
    this.compactionOperation = operation;
    void operation.then(
      () => {
        if (this.compactionOperation === operation) {
          this.compactionOperation = null;
        }
        if (this.exitIntent !== 'return' && this.state !== 'failed') {
          void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent)
            .catch(() => {
              // The lifecycle owns the final sanitized failure result.
            });
        }
      },
      (error) => {
        if (this.compactionOperation === operation) {
          this.compactionOperation = null;
        }
        void this.fail(error).catch(() => {
          // The controller has already entered its fatal shutdown path.
        });
      },
    );
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
      points.splice(start, this.editor.cursorScalar - start, ...[
        ...result.text,
      ]);
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
    } else if (result.kind === 'incomplete') {
      this.renderer.setStatus('path index unavailable');
    } else this.renderer.setStatus('no path match');
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
      this.renderer.setStatus(
        'tools may have changed the workspace; inspect before resubmitting',
      );
    } else this.renderer.setStatus('recovered input; edit or resubmit');
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
          if (slashCommandOf(this.editor.text) === 'history_export') {
            this.renderer.setStatus('busy; /history export waits for ready');
          } else if (slashCommandOf(this.editor.text) === 'recover') {
            this.renderer.setStatus('busy; /recover waits for ready');
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
        `unknown command ${this.editor.text.trim()}, try: /help, /sessions, /history export, /recover, /exit`,
      );
      return true;
    }
    const command: SlashCommand = parsed;
    this.editor.clear();
    this.history.resetNavigation();
    this.renderEditorState();
    if (command === 'help') this.openStartupHelp();
    else if (command === 'sessions') this.openPicker();
    else if (command === 'history_export') this.startHistoryExport();
    else if (command === 'recover') this.popRecovery();
    else if (this.modern) this.modernCtrlD();
    else if (this.editor.text.length === 0) void this.shutdown(0);
    else this.renderer.setStatus('Ctrl-D exits only on empty input');
    return true;
  }

  /** Up/Down-edge input-history walk; plain cursor moves stay in editEvent. */
  private walkInputHistory(direction: 'up' | 'down'): boolean {
    if (direction === 'down') {
      if (!this.history.navigating) return false;
      const snapshot = this.history.next();
      if (snapshot === null) this.renderer.setStatus('history boundary');
      else {
        this.editor.setSnapshot(snapshot);
        this.renderEditorState();
      }
      return true;
    }
    if (
      !this.history.navigating && this.editor.text.length > 0 &&
      this.editor.moveUp()
    ) {
      this.renderEditorState();
      return true;
    }
    const snapshot = this.history.previous(this.editor.snapshot());
    if (snapshot === null) {
      if (this.editor.text.length === 0) {
        this.renderer.setStatus('history empty');
      }
      return true;
    }
    this.editor.setSnapshot(snapshot);
    this.renderEditorState();
    return true;
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
      this.history.record(text);
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
    this.history.resetNavigation();
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
    if (this.state === 'compacting') {
      this.processCompacting([{
        kind: signal === 'SIGINT' ? 'ctrl_c' : 'escape',
      }]);
      if (signal !== 'SIGINT') {
        const code = signal === 'SIGTERM' ? 143 : 129;
        this.setExitIntent(code);
      }
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
    this.shutdownPromise = (async () => {
      await this.settleNavigation();
      await this.settleCompaction();
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
    await this.settleCompaction();
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
    await this.settleCompaction();
    await this.settleHistoryExport();
    if (this.shutdownPromise === null) {
      this.shutdownPromise = this.lifecycle.restore();
    }
    await this.shutdownPromise;
  }

  private async settleNavigation(): Promise<void> {
    if (this.intents !== undefined) {
      const dispatched = this.dispatchIntent({ kind: 'dismiss_overlay' });
      if (dispatched instanceof Promise) await Promise.allSettled([dispatched]);
    }
    while (
      this.navigationOperations.size > 0 || this.historyOperations.size > 0
    ) {
      const navigation = [...this.navigationOperations];
      const history = [...this.historyOperations];
      for (const operation of navigation) {
        operation.abort.abort('controller settlement');
      }
      for (const operation of history) {
        operation.abort.abort('controller settlement');
      }
      await Promise.allSettled([
        ...navigation.map((operation) => operation.operation),
        ...history.map((operation) => operation.operation),
      ]);
      for (const operation of navigation) {
        this.navigationOperations.delete(operation);
      }
      for (const operation of history) this.historyOperations.delete(operation);
    }
  }

  private async settleCompaction(): Promise<void> {
    const operation = this.compactionOperation;
    if (operation === null) return;
    if (this.intents === undefined) {
      this.compactionAbort?.abort('controller settlement');
    } else {
      const dispatched = this.dispatchIntent({
        kind: 'compaction',
        action: 'cancel',
      });
      if (dispatched instanceof Promise) await Promise.allSettled([dispatched]);
    }
    try {
      await operation;
    } catch {
      // The operation's failure is already routed through the controller's fatal path.
    }
    if (this.compactionOperation === operation) this.compactionOperation = null;
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
