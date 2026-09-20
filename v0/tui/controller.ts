import {
  isPresentationError,
  PresentationDeliveryError,
  type PresentationHumanHistoryDetail,
  type PresentationHumanHistoryPage,
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
import {
  recallExecutionIdOf,
  renameTitleOf,
  SLASH_COMMANDS,
  type SlashCommand,
  slashCommandCandidates,
  slashCommandOf,
} from './slash_command.ts';
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
export {
  recallExecutionIdOf,
  renameTitleOf,
  SLASH_COMMANDS,
  type SlashCommand,
  slashCommandCandidates,
  slashCommandOf,
} from './slash_command.ts';

const isPresentationDeliveryError = (error: unknown): boolean =>
  error instanceof PresentationDeliveryError ||
  isPresentationError(error, 'PresentationDeliveryError') ||
  isPresentationError(error, 'EventDeliveryError');
type ControllerState =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'session-switching'
  | 'recall-selecting'
  | 'history-exporting'
  | 'exiting'
  | 'failed';
type FollowUpSlot = 'closed' | 'open-empty' | 'pending';
type DiscardKey = 'ctrl_c' | 'ctrl_d';
type DiscardIntent = Readonly<{ key: DiscardKey; deadline: number }>;

const sleep = (duration: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), duration));

const mergeHumanHistoryPages = (
  current: PresentationHumanHistoryPage,
  adjacent: PresentationHumanHistoryPage,
  direction: 'older' | 'newer',
): PresentationHumanHistoryPage => {
  const ordered = direction === 'older'
    ? [...adjacent.entries, ...current.entries]
    : [...current.entries, ...adjacent.entries];
  const seen = new Set<string>();
  const entries = ordered.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  return Object.freeze({
    schemaVersion: 1,
    sessionId: current.sessionId,
    entries: Object.freeze(entries),
    executionCount: new Set(entries.map((entry) => entry.executionId)).size,
    ...(direction === 'older'
      ? (adjacent.olderCursor === undefined ? {} : { olderCursor: adjacent.olderCursor })
      : (current.olderCursor === undefined ? {} : { olderCursor: current.olderCursor })),
    ...(direction === 'newer'
      ? (adjacent.newerCursor === undefined ? {} : { newerCursor: adjacent.newerCursor })
      : (current.newerCursor === undefined ? {} : { newerCursor: current.newerCursor })),
    atOldest: direction === 'older' ? adjacent.atOldest : current.atOldest,
    atNewest: direction === 'newer' ? adjacent.atNewest : current.atNewest,
  });
};

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
  private humanHistory: {
    page?: PresentationHumanHistoryPage;
    selected: number;
    anchorEntryId?: string;
    anchorScalarOffset?: number;
    detail?: PresentationHumanHistoryDetail;
    detailMatchScalarOffset?: number;
    query?: string;
    searchInput?: string;
    matchEntryId?: string;
    matchScalarOffset?: number;
    wrapped?: boolean;
    loading?: boolean;
    /** Set when viewing a stored Session read-only; absent means the active Session. */
    sessionId?: string;
  } | null = null;
  private humanHistoryOperation: Promise<void> | null = null;
  private sessionSwitchOperation: Promise<void> | null = null;
  private recallOperation: Promise<void> | null = null;
  private pendingRecallShortId: string | null = null;
  private noticeGeneration = 1_000_000;
  private crashSettlement: Promise<void> | null = null;
  private exitCode = 0;
  private signalCode: number | null = null;
  private signalsInstalled = false;
  private readonly pending?: PendingInputCore;
  private readonly overlay: ControllerOverlay;
  /** True while the provider/model selection confirmation is the transient status line. */
  private modelSelectionNotice = false;
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
      bindingReplaced: () => {
        this.pendingRecallShortId = null;
      },
      idleAllowed: () => this.navigationIdleAllowed(),
      isIdle: () => this.state === 'idle',
      readyStatus: () => this.readyStatus(),
      modelSelection: () => this.session.modelSelectionSnapshot?.(),
      viewSession: (id) => this.startHumanHistory(id),
      selectionStatusApplied: () => {
        this.modelSelectionNotice = true;
      },
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
      case 'history_export_all':
      case 'human_history_open':
      case 'human_history_page':
      case 'human_history_detail':
      case 'human_history_search':
        return { kind: 'rejected', reason: 'unavailable' };
      case 'recall_execution':
        return { kind: 'rejected', reason: 'unavailable' };
      case 'clear_recall':
        return { kind: 'accepted' };
      case 'list_sessions':
        return {
          kind: 'listing',
          listing: { sessions: [], skippedInvalid: 0 },
        };
      case 'rename_session': {
        const status = this.navigation?.renameCurrent?.(intent.title) ?? 'unavailable';
        return status === 'renamed' || status === 'unchanged'
          ? { kind: 'session_title', status, title: intent.title }
          : {
            kind: 'rejected',
            reason: status === 'busy' ? 'busy' : 'unavailable',
          };
      }
      case 'new_session': {
        if (this.navigation?.createNew === undefined) {
          return { kind: 'rejected', reason: 'unavailable' };
        }
        return this.navigation.createNew().then((binding) => {
          this.session = binding.session;
          return {
            kind: 'binding' as const,
            position: binding.position,
            ...(binding.restored === undefined ? {} : { restored: binding.restored }),
          };
        });
      }
      case 'select_provider': {
        const current = this.session.modelSelectionSnapshot?.();
        let selection: ModelSelection;
        try {
          selection = current?.provider === intent.provider
            ? current
            : defaultModelSelectionFor(intent.provider);
        } catch {
          return { kind: 'rejected', reason: 'invalid' };
        }
        return this.selectModelFallback(selection);
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
    this.modelSelectionNotice = false;
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
      const ready = this.readyStatus();
      this.renderer.setStatus(
        this.navigation === undefined && this.intents === undefined &&
          !ready.includes('credential missing:')
          ? 'ready'
          : ready,
      );
      this.input = this.readEvents();
      while (
        this.state === 'idle' || this.state === 'busy' ||
        this.state === 'history-exporting' || this.state === 'session-switching' ||
        this.state === 'recall-selecting'
      ) {
        if (this.active === null) {
          const events = await this.input;
          this.input = this.readEvents();
          if ((this.state as ControllerState) === 'history-exporting') {
            this.processHistoryExporting(events);
          } else if ((this.state as ControllerState) === 'session-switching') {
            this.processSessionSwitching(events);
          } else if ((this.state as ControllerState) === 'recall-selecting') {
            this.processRecallSelecting(events);
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
      if (this.state === 'session-switching') {
        this.processSessionSwitching([event]);
        continue;
      }
      if (this.state === 'recall-selecting') {
        this.processRecallSelecting([event]);
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
    this.refreshSlashCommandCandidates();
  }

  private editEvent(event: InputEvent): void {
    this.editorController.apply(event);
    if (this.modelSelectionNotice && this.state === 'idle') {
      this.modelSelectionNotice = false;
      this.renderer.setStatus(this.readyStatus());
    }
    this.refreshSlashCommandCandidates();
  }

  private refreshSlashCommandCandidates(): void {
    this.renderer.setSlashCommandCandidates(
      this.state === 'idle' || this.state === 'busy'
        ? slashCommandCandidates(this.editor.text)
        : [],
    );
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
      if (this.state === 'session-switching') {
        this.processSessionSwitching([event]);
        continue;
      }
      if (this.state === 'recall-selecting') {
        this.processRecallSelecting([event]);
        continue;
      }
      if (!busy && this.humanHistory !== null) {
        this.processHumanHistoryEvent(event);
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
        else if (this.renderer.stateSnapshot().scroll.kind !== 'followLatest') {
          this.renderer.latest();
        } else this.renderer.setStatus('input ignored');
        continue;
      }
      if (event.kind === 'enter') {
        const slashCommand = slashCommandOf(this.editor.text);
        if (
          busy &&
          (slashCommand === 'history' || slashCommand === 'history_export' ||
            slashCommand === 'history_export_all' || slashCommand === 'recover' ||
            slashCommand === 'recall' ||
            slashCommand === 'provider' ||
            slashCommand === 'model' || slashCommand === 'effort' ||
            slashCommand === 'rename' || slashCommand === 'new')
        ) {
          this.renderer.setStatus(
            slashCommand === 'rename' || slashCommand === 'new' || slashCommand === 'recall'
              ? `busy; /${slashCommand} waits for ready`
              : `busy; ${this.editor.text.trim()} waits for ready`,
          );
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

  private renderHumanHistory(): void {
    if (this.humanHistory === null) return;
    this.renderer.renderHumanHistory(this.humanHistory);
  }

  private trackHumanHistoryOperation(operation: Promise<void>): void {
    this.humanHistoryOperation = operation;
    void operation.then(
      () => {
        if (this.humanHistoryOperation === operation) this.humanHistoryOperation = null;
      },
      (error) => {
        if (this.humanHistoryOperation === operation) this.humanHistoryOperation = null;
        void this.fail(error).catch(() => {});
      },
    );
  }

  private startHumanHistory(viewSessionId?: string): void {
    if (this.state !== 'idle' || this.humanHistory !== null) {
      this.renderer.setStatus('history unavailable while busy');
      return;
    }
    this.humanHistory = {
      selected: 0,
      loading: true,
      ...(viewSessionId === undefined ? {} : { sessionId: viewSessionId }),
    };
    this.renderHumanHistory();
    let dispatched: PresentationIntentResult | Promise<PresentationIntentResult>;
    try {
      dispatched = this.dispatchIntent({
        kind: 'human_history_open',
        ...(viewSessionId === undefined ? {} : { sessionId: viewSessionId }),
      });
    } catch (error) {
      this.humanHistory = null;
      this.renderer.clearModal();
      if (isPresentationDeliveryError(error)) throw error;
      this.renderer.setStatus('history unavailable');
      return;
    }
    const operation = Promise.resolve(dispatched).then((result) => {
      if (this.humanHistory === null) return;
      if (result.kind === 'rejected') {
        this.humanHistory = null;
        this.renderer.clearModal();
        this.renderer.setStatus('history unavailable with --no-session');
        return;
      }
      if (result.kind !== 'human_history_page') throw new PresentationDeliveryError();
      const selected = Math.max(0, result.page.entries.length - 1);
      this.humanHistory = {
        page: result.page,
        selected,
        anchorEntryId: result.page.entries[selected]?.id,
        anchorScalarOffset: Number.MAX_SAFE_INTEGER,
        ...(this.humanHistory.sessionId === undefined
          ? {}
          : { sessionId: this.humanHistory.sessionId }),
      };
      this.renderHumanHistory();
    }).catch((error: unknown) => {
      if (isPresentationDeliveryError(error)) throw error;
      if (this.humanHistory !== null) {
        this.humanHistory = null;
        this.renderer.clearModal();
        this.renderer.setStatus('history read failed');
      }
    });
    this.trackHumanHistoryOperation(operation);
  }

  private loadHumanHistoryPage(
    direction: 'oldest' | 'older' | 'newer' | 'latest',
    cursor?: string,
    moveAfterLoad?: 'previous' | 'next' | 'page_up' | 'page_down',
  ): void {
    if (this.humanHistory === null || this.humanHistoryOperation !== null) return;
    this.humanHistory = { ...this.humanHistory, loading: true };
    this.renderHumanHistory();
    const operation = Promise.resolve(this.dispatchIntent({
      kind: 'human_history_page',
      direction,
      ...(cursor === undefined ? {} : { cursor }),
      ...(this.humanHistory.sessionId === undefined
        ? {}
        : { sessionId: this.humanHistory.sessionId }),
    })).then((result) => {
      if (this.humanHistory === null) return;
      if (result.kind !== 'human_history_page') throw new PresentationDeliveryError();
      const previous = this.humanHistory;
      const selectedId = previous.page?.entries[previous.selected]?.id;
      const page = previous.page !== undefined && (direction === 'older' || direction === 'newer')
        ? mergeHumanHistoryPages(previous.page, result.page, direction)
        : result.page;
      let selected = direction === 'latest'
        ? Math.max(0, page.entries.length - 1)
        : direction === 'oldest'
        ? 0
        : Math.max(0, page.entries.findIndex((entry) => entry.id === selectedId));
      if (moveAfterLoad === 'previous') selected = Math.max(0, selected - 1);
      if (moveAfterLoad === 'next') {
        selected = Math.min(Math.max(0, page.entries.length - 1), selected + 1);
      }
      this.humanHistory = {
        ...previous,
        page,
        selected,
        anchorEntryId: direction === 'oldest' || direction === 'latest' ||
            moveAfterLoad === 'previous' || moveAfterLoad === 'next'
          ? page.entries[selected]?.id
          : previous.anchorEntryId,
        anchorScalarOffset: direction === 'latest'
          ? Number.MAX_SAFE_INTEGER
          : direction === 'oldest' || moveAfterLoad === 'previous' || moveAfterLoad === 'next'
          ? 0
          : previous.anchorScalarOffset,
        detail: undefined,
        detailMatchScalarOffset: undefined,
        loading: false,
      };
      this.renderHumanHistory();
      if (moveAfterLoad === 'page_up' || moveAfterLoad === 'page_down') {
        this.moveHumanHistoryVisualPage(moveAfterLoad, false);
      }
    }).catch((error: unknown) => {
      if (isPresentationDeliveryError(error)) throw error;
      if (this.humanHistory !== null) {
        this.humanHistory = { ...this.humanHistory, loading: false };
        this.renderHumanHistory();
        this.renderer.setStatus('history read failed');
      }
    });
    this.trackHumanHistoryOperation(operation);
  }

  private moveHumanHistoryVisualPage(
    direction: 'page_up' | 'page_down',
    loadAtEdge = true,
  ): void {
    const view = this.humanHistory;
    if (view?.page === undefined || view.detail !== undefined) return;
    const layout = this.renderer.layoutSnapshot();
    const rows = layout.overlay;
    const entryId = view.anchorEntryId ?? view.page.entries[view.selected]?.id;
    if (entryId === undefined) return;
    const sourceOffset = view.anchorScalarOffset ?? 0;
    const matching = rows.map((row, index) => ({ row, index })).filter(({ row }) =>
      row.entryId === entryId
    );
    const currentRow =
      matching.find(({ row }) => (row.sourceScalarOffset ?? 0) >= sourceOffset)?.index ??
        matching.at(-1)?.index;
    if (currentRow === undefined) return;
    const entryRows = rows.map((row, index) => ({ row, index })).filter(({ row }) =>
      row.entryId !== undefined
    );
    const firstRow = entryRows.at(0)?.index;
    const lastRow = entryRows.at(-1)?.index;
    if (firstRow === undefined || lastRow === undefined) return;
    const distance = Math.max(1, layout.log.length);
    const rawTarget = currentRow + (direction === 'page_up' ? -distance : distance);
    if (rawTarget < firstRow && view.page.olderCursor !== undefined && loadAtEdge) {
      this.loadHumanHistoryPage('older', view.page.olderCursor, 'page_up');
      return;
    }
    if (rawTarget > lastRow && view.page.newerCursor !== undefined && loadAtEdge) {
      this.loadHumanHistoryPage('newer', view.page.newerCursor, 'page_down');
      return;
    }
    const targetIndex = Math.max(firstRow, Math.min(lastRow, rawTarget));
    let target = rows[targetIndex];
    if (target.entryId === undefined) {
      const step = direction === 'page_up' ? -1 : 1;
      for (let index = targetIndex; index >= firstRow && index <= lastRow; index += step) {
        if (rows[index].entryId !== undefined) {
          target = rows[index];
          break;
        }
      }
    }
    if (target.entryId === undefined) return;
    const selected = view.page.entries.findIndex((entry) => entry.id === target.entryId);
    if (selected < 0) return;
    this.humanHistory = {
      ...view,
      selected,
      anchorEntryId: target.entryId,
      anchorScalarOffset: target.sourceScalarOffset ?? 0,
    };
    this.renderHumanHistory();
  }

  private openHumanHistoryDetail(detailId: string, scalarOffset = 0): void {
    if (this.humanHistory === null || this.humanHistoryOperation !== null) return;
    const operation = Promise.resolve(this.dispatchIntent({
      kind: 'human_history_detail',
      detailId,
      scalarOffset,
      ...(this.humanHistory.sessionId === undefined
        ? {}
        : { sessionId: this.humanHistory.sessionId }),
    })).then((result) => {
      if (this.humanHistory === null) return;
      if (result.kind !== 'human_history_detail') throw new PresentationDeliveryError();
      this.humanHistory = {
        ...this.humanHistory,
        detail: result.detail,
        detailMatchScalarOffset: this.humanHistory.detail?.detailId === result.detail.detailId
          ? this.humanHistory.detailMatchScalarOffset
          : undefined,
        loading: false,
      };
      this.renderHumanHistory();
    }).catch((error: unknown) => {
      if (isPresentationDeliveryError(error)) throw error;
      this.renderer.setStatus('history detail failed');
    });
    this.trackHumanHistoryOperation(operation);
  }

  private searchHumanHistory(direction: 'next' | 'previous'): void {
    const view = this.humanHistory;
    const query = view?.searchInput ?? view?.query;
    if (view === null || query === undefined || query.length === 0 || this.humanHistoryOperation) {
      return;
    }
    const current = view.page?.entries[view.selected]?.id;
    const currentMatchOffset = view.query === query && view.matchEntryId === current
      ? view.matchScalarOffset
      : undefined;
    const operation = Promise.resolve(this.dispatchIntent({
      kind: 'human_history_search',
      query,
      direction,
      ...(current === undefined ? {} : { fromEntryId: current }),
      ...(currentMatchOffset === undefined ? {} : { fromSourceScalarOffset: currentMatchOffset }),
      ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
    })).then((result) => {
      if (this.humanHistory === null) return;
      if (result.kind !== 'human_history_search') throw new PresentationDeliveryError();
      if (result.hit === undefined) {
        this.humanHistory = { ...this.humanHistory, query, searchInput: undefined };
        this.renderHumanHistory();
        this.renderer.setStatus(`no history match for ${query}`);
        return;
      }
      const selected = result.hit.page.entries.findIndex((entry) =>
        entry.id === result.hit!.entryId
      );
      this.humanHistory = {
        page: result.hit.page,
        selected: Math.max(0, selected),
        anchorEntryId: result.hit.entryId,
        anchorScalarOffset: result.hit.sourceScalarOffset,
        ...(result.hit.detail === undefined ? {} : { detail: result.hit.detail }),
        ...(result.hit.detailMatchScalarOffset === undefined
          ? {}
          : { detailMatchScalarOffset: result.hit.detailMatchScalarOffset }),
        query,
        matchEntryId: result.hit.entryId,
        matchScalarOffset: result.hit.sourceScalarOffset,
        wrapped: result.hit.wrapped,
        ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
      };
      this.renderHumanHistory();
    }).catch((error: unknown) => {
      if (isPresentationDeliveryError(error)) throw error;
      this.renderer.setStatus('history search failed');
    });
    this.trackHumanHistoryOperation(operation);
  }

  private closeHumanHistory(): void {
    this.humanHistory = null;
    this.renderer.clearModal();
    this.renderer.setStatus(this.readyStatus());
  }

  private processHumanHistoryEvent(event: InputEvent): void {
    const view = this.humanHistory;
    if (view === null) return;
    if (view.searchInput !== undefined) {
      if (event.kind === 'escape') {
        this.humanHistory = { ...view, searchInput: undefined };
        this.renderHumanHistory();
      } else if (event.kind === 'enter') {
        if (view.searchInput.length === 0) {
          this.humanHistory = {
            ...view,
            query: undefined,
            searchInput: undefined,
            matchEntryId: undefined,
            matchScalarOffset: undefined,
            detailMatchScalarOffset: undefined,
          };
          this.renderHumanHistory();
        } else this.searchHumanHistory('next');
      } else if (event.kind === 'backspace') {
        this.humanHistory = { ...view, searchInput: [...view.searchInput].slice(0, -1).join('') };
        this.renderHumanHistory();
      } else if (event.kind === 'printable') {
        this.humanHistory = { ...view, searchInput: view.searchInput + event.text };
        this.renderHumanHistory();
      } else if (event.kind === 'paste' && !event.text.includes('\0')) {
        this.humanHistory = { ...view, searchInput: view.searchInput + event.text };
        this.renderHumanHistory();
      }
      return;
    }
    if (view.detail !== undefined) {
      if (event.kind === 'escape' || event.kind === 'backspace') {
        this.humanHistory = { ...view, detail: undefined, detailMatchScalarOffset: undefined };
        this.renderHumanHistory();
      } else if (event.kind === 'page_up' && view.detail.previousOffset !== undefined) {
        this.openHumanHistoryDetail(view.detail.detailId, view.detail.previousOffset);
      } else if (event.kind === 'page_down' && view.detail.nextOffset !== undefined) {
        this.openHumanHistoryDetail(view.detail.detailId, view.detail.nextOffset);
      } else if (event.kind === 'printable' && event.text === 'n') {
        this.searchHumanHistory('next');
      } else if (event.kind === 'printable' && event.text === 'N') {
        this.searchHumanHistory('previous');
      }
      return;
    }
    const page = view.page;
    if (event.kind === 'escape' || (event.kind === 'printable' && event.text === 'q')) {
      this.closeHumanHistory();
    } else if (event.kind === 'printable' && event.text === '/') {
      this.humanHistory = { ...view, searchInput: view.query ?? '' };
      this.renderHumanHistory();
    } else if (event.kind === 'printable' && event.text === 'n') {
      this.searchHumanHistory('next');
    } else if (event.kind === 'printable' && event.text === 'N') {
      this.searchHumanHistory('previous');
    } else if (
      event.kind === 'up' || (event.kind === 'printable' && event.text === 'k')
    ) {
      if (view.selected > 0) {
        const selected = view.selected - 1;
        this.humanHistory = {
          ...view,
          selected,
          anchorEntryId: page?.entries[selected]?.id,
          anchorScalarOffset: 0,
        };
        this.renderHumanHistory();
      } else if (page?.olderCursor !== undefined) {
        this.loadHumanHistoryPage('older', page.olderCursor, 'previous');
      }
    } else if (
      event.kind === 'down' || (event.kind === 'printable' && event.text === 'j')
    ) {
      if (page !== undefined && view.selected + 1 < page.entries.length) {
        const selected = view.selected + 1;
        this.humanHistory = {
          ...view,
          selected,
          anchorEntryId: page.entries[selected]?.id,
          anchorScalarOffset: 0,
        };
        this.renderHumanHistory();
      } else if (page?.newerCursor !== undefined) {
        this.loadHumanHistoryPage('newer', page.newerCursor, 'next');
      }
    } else if (event.kind === 'page_up') {
      this.moveHumanHistoryVisualPage('page_up');
    } else if (event.kind === 'page_down') {
      this.moveHumanHistoryVisualPage('page_down');
    } else if (event.kind === 'home' || (event.kind === 'printable' && event.text === 'g')) {
      this.loadHumanHistoryPage('oldest');
    } else if (event.kind === 'end' || (event.kind === 'printable' && event.text === 'G')) {
      this.loadHumanHistoryPage('latest');
    } else if (event.kind === 'enter') {
      const selected = page?.entries[view.selected];
      if (selected !== undefined) this.openHumanHistoryDetail(selected.detailId);
    }
  }

  private startHistoryExport(all = false): void {
    if (this.state !== 'idle' || this.historyExportOperation !== null) {
      this.renderer.setStatus('history export already in progress');
      return;
    }
    const binding = this.currentBindingIdentity();
    let dispatched: PresentationIntentResult | Promise<PresentationIntentResult>;
    try {
      dispatched = this.dispatchIntent({ kind: all ? 'history_export_all' : 'history_export' });
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
      if (all) {
        if (result.kind !== 'history_export_all') throw new PresentationDeliveryError();
      } else if (result.kind !== 'history_export') throw new PresentationDeliveryError();
      if (result.kind !== 'history_export' && result.kind !== 'history_export_all') {
        throw new PresentationDeliveryError();
      }
      if (this.state !== 'history-exporting') return;
      if (this.currentBindingIdentity() !== binding) {
        this.state = 'idle';
        this.renderer.setStatus('history export completed for previous session');
        return;
      }
      const notice = result.kind === 'history_export'
        ? `history exported through turn ${result.throughTurn}: ${result.path}`
        : `full history exported (${result.executionCount} executions, sha256 ${result.sha256}): ${result.path}`;
      this.renderer.eventSink({
        kind: 'notice',
        generation: ++this.noticeGeneration,
        text: notice,
      });
      this.state = 'idle';
      this.renderer.setStatus(
        result.kind === 'history_export'
          ? `history exported through turn ${result.throughTurn}`
          : `full history exported · ${result.executionCount} executions · ${result.byteLength} bytes`,
      );
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
        if (this.renderer.stateSnapshot().scroll.kind !== 'followLatest') {
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

  private processSessionSwitching(events: readonly InputEvent[]): void {
    for (const event of events) {
      if (this.state !== 'session-switching') return;
      if (event.kind === 'ctrl_d') {
        this.modern ? this.modernCtrlD() : void this.shutdown(0);
      } else {
        this.renderer.setStatus('new session in progress; retry when ready');
      }
    }
  }

  private processRecallSelecting(events: readonly InputEvent[]): void {
    for (const event of events) {
      if (this.state !== 'recall-selecting') return;
      if (event.kind === 'ctrl_d') this.modernCtrlD();
      else this.renderer.setStatus('recall selection in progress; retry when ready');
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
    if (this.editor.text.startsWith('/')) {
      const candidates = slashCommandCandidates(this.editor.text);
      if (candidates.length === 1) {
        this.editorController.completeSlashCommand(candidates[0]);
      }
      this.refreshSlashCommandCandidates();
      return;
    }
    this.editorController.completePath();
    this.refreshSlashCommandCandidates();
  }
  private popRecovery(): void {
    this.editorController.recover();
    this.refreshSlashCommandCandidates();
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
            slashCommandOf(this.editor.text) === 'history' ||
            slashCommandOf(this.editor.text) === 'history_export' ||
            slashCommandOf(this.editor.text) === 'history_export_all' ||
            slashCommandOf(this.editor.text) === 'recover' ||
            slashCommandOf(this.editor.text) === 'recall' ||
            slashCommandOf(this.editor.text) === 'provider' ||
            slashCommandOf(this.editor.text) === 'model' ||
            slashCommandOf(this.editor.text) === 'effort' ||
            slashCommandOf(this.editor.text) === 'rename' ||
            slashCommandOf(this.editor.text) === 'new'
          ) {
            this.renderer.setStatus(
              slashCommandOf(this.editor.text) === 'rename' ||
                slashCommandOf(this.editor.text) === 'new' ||
                slashCommandOf(this.editor.text) === 'recall'
                ? `busy; /${slashCommandOf(this.editor.text)} waits for ready`
                : `busy; ${this.editor.text.trim()} waits for ready`,
            );
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
        slashCommand === 'history' || slashCommand === 'history_export' ||
          slashCommand === 'history_export_all'
          ? `busy; ${this.editor.text.trim()} waits for ready`
          : slashCommand === 'recover'
          ? 'busy; /recover waits for ready'
          : slashCommand === 'recall'
          ? 'busy; /recall waits for ready'
          : slashCommand === 'provider'
          ? 'busy; /provider waits for ready'
          : slashCommand === 'model'
          ? 'busy; /model waits for ready'
          : slashCommand === 'effort'
          ? 'busy; /effort waits for ready'
          : slashCommand === 'rename'
          ? 'busy; /rename waits for ready'
          : slashCommand === 'new'
          ? 'busy; /new waits for ready'
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
        `unknown command ${this.editor.text.trim()}, try: ${
          SLASH_COMMANDS.map((definition) => definition.text).join(', ')
        }`,
      );
      return true;
    }
    const command: SlashCommand = parsed;
    const renameTitle = command === 'rename' ? renameTitleOf(this.editor.text) : null;
    if (command === 'recall') {
      const id = recallExecutionIdOf(this.editor.text);
      if (id === null) {
        this.renderer.setStatus('invalid recall id; use at least 8 UUID characters');
      } else this.startRecallSelection(id);
      return true;
    }
    this.editor.clear();
    this.editorController.resetHistory();
    this.renderEditorState();
    if (command === 'help') this.openStartupHelp();
    else if (command === 'new') this.startNewSession();
    else if (command === 'sessions') this.openPicker();
    else if (command === 'rename') this.renameSession(renameTitle ?? '');
    else if (command === 'provider') this.openProviderPicker();
    else if (command === 'model') this.openModelPicker();
    else if (command === 'effort') this.openEffortPicker();
    else if (command === 'history') this.startHumanHistory();
    else if (command === 'history_export') this.startHistoryExport();
    else if (command === 'history_export_all') this.startHistoryExport(true);
    else if (command === 'recover') this.popRecovery();
    else if (this.modern) this.modernCtrlD();
    else if (this.editor.text.length === 0) void this.shutdown(0);
    else this.renderer.setStatus('Ctrl-D exits only on empty input');
    return true;
  }

  private startRecallSelection(id?: string): void {
    if (this.state !== 'idle' || this.recallOperation !== null) {
      this.renderer.setStatus('recall selection already in progress');
      return;
    }
    let dispatched: PresentationIntentResult | Promise<PresentationIntentResult>;
    try {
      dispatched = this.dispatchIntent({
        kind: 'recall_execution',
        ...(id === undefined ? {} : { id }),
      });
    } catch (error) {
      if (isPresentationDeliveryError(error)) throw error;
      this.renderer.setStatus('recall failed; current selection unchanged');
      return;
    }
    this.state = 'recall-selecting';
    const operation = Promise.resolve(dispatched).then((result) => {
      if (this.state !== 'recall-selecting') return;
      this.state = 'idle';
      if (result.kind === 'recall') {
        this.pendingRecallShortId = result.sourceExecutionId.slice(0, 8);
        this.editor.clear();
        this.editorController.resetHistory();
        this.renderEditorState();
        this.renderer.setStatus(
          `recall ${this.pendingRecallShortId} ready · next task only`,
        );
        return;
      }
      if (result.kind !== 'rejected') throw new PresentationDeliveryError();
      const status = result.reason === 'busy'
        ? 'busy; /recall waits for ready'
        : result.reason === 'not_found'
        ? 'recall execution not found'
        : result.reason === 'ambiguous'
        ? 'recall id is ambiguous'
        : result.reason === 'unavailable'
        ? 'recall unavailable with --no-session'
        : 'recall failed; current selection unchanged';
      this.renderer.setStatus(status);
    }).catch((error: unknown) => {
      if (isPresentationDeliveryError(error)) throw error;
      if (this.state === 'recall-selecting') {
        this.state = 'idle';
        this.renderer.setStatus('recall failed; current selection unchanged');
      }
    });
    this.recallOperation = operation;
    void operation.then(
      () => {
        if (this.recallOperation === operation) this.recallOperation = null;
      },
      (error) => {
        if (this.recallOperation === operation) this.recallOperation = null;
        void this.fail(error).catch(() => {
          // The controller has already entered its fatal shutdown path.
        });
      },
    );
    this.renderer.setStatus('selecting recall execution');
  }

  private startNewSession(): void {
    if (this.state !== 'idle' || this.sessionSwitchOperation !== null) {
      this.renderer.setStatus('new session already in progress');
      return;
    }
    let dispatched: PresentationIntentResult | Promise<PresentationIntentResult>;
    try {
      dispatched = this.dispatchIntent({ kind: 'new_session' });
    } catch (error) {
      if (isPresentationDeliveryError(error)) throw error;
      this.renderer.setStatus('new session failed; current session unchanged');
      return;
    }
    this.state = 'session-switching';
    const operation = Promise.resolve(dispatched).then((result) => {
      if (result.kind === 'rejected') {
        if (this.state === 'session-switching') {
          this.state = 'idle';
          this.renderer.setStatus(
            result.reason === 'busy' ? 'busy; /new waits for ready' : 'new session unavailable',
          );
        }
        return;
      }
      if (result.kind !== 'binding') throw new PresentationDeliveryError();
      this.pendingRecallShortId = null;
      if (this.intents === undefined) {
        const selection = this.session.modelSelectionSnapshot?.();
        this.renderer.eventSink({
          kind: 'session_binding_replaced',
          position: result.position,
          ...(selection === undefined ? {} : {
            modelSelection: {
              provider: selection.provider,
              modelId: selection.modelId,
              effort: selection.effort,
            },
          }),
        });
        this.renderer.renderRestored(
          result.restored?.messages ?? [],
          result.restored?.omitted ?? 0,
        );
      }
      this.renderer.setCurrentPosition(result.position);
      if (this.state !== 'session-switching') return;
      this.state = 'idle';
      this.renderer.setStatus('new session ready');
    }).catch((error: unknown) => {
      if (
        isPresentationDeliveryError(error) ||
        isPresentationError(error, 'NavigationFatalError')
      ) throw error;
      if (this.state === 'session-switching') {
        this.state = 'idle';
        this.renderer.setStatus('new session failed; current session unchanged');
      }
    });
    this.sessionSwitchOperation = operation;
    void operation.then(
      () => {
        if (this.sessionSwitchOperation === operation) this.sessionSwitchOperation = null;
      },
      (error) => {
        if (this.sessionSwitchOperation === operation) this.sessionSwitchOperation = null;
        void this.fail(error).catch(() => {
          // The controller has already entered its fatal shutdown path.
        });
      },
    );
    this.renderer.setStatus('creating new session');
  }

  private renameSession(title: string): void {
    let result: PresentationIntentResult | Promise<PresentationIntentResult>;
    try {
      result = this.dispatchIntent({ kind: 'rename_session', title });
    } catch {
      this.renderer.setStatus('session rename failed');
      return;
    }
    const finish = (value: PresentationIntentResult): void => {
      if (value.kind === 'session_title') {
        this.renderer.setSessionTitle(value.title);
        this.renderer.setStatus(
          value.status === 'renamed' ? 'session renamed' : 'session title unchanged',
        );
      } else if (value.kind === 'rejected') {
        this.renderer.setStatus(
          value.reason === 'busy' ? 'busy; /rename waits for ready' : 'session rename unavailable',
        );
      } else this.renderer.setStatus('session rename failed');
    };
    if (result instanceof Promise) {
      this.renderer.setStatus('renaming session');
      void result.then(finish, () => this.renderer.setStatus('session rename failed'));
    } else finish(result);
  }

  /** Up/Down-edge input-history walk; plain cursor moves stay in editEvent. */
  private walkInputHistory(direction: 'up' | 'down'): boolean {
    const handled = this.editorController.walkHistory(direction);
    this.refreshSlashCommandCandidates();
    return handled;
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
    this.pendingRecallShortId = null;
    if (this.renderer.stateSnapshot().scroll.kind !== 'followLatest') {
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
    this.renderer.clearLiveActivity();
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
    this.renderer.clearLiveActivity();
    if (outcome.diagnostic !== undefined) {
      this.renderer.renderFailureDiagnostic(
        outcome.diagnostic,
        outcome.diagnosticDurability,
        outcome.diagnosticPersistenceError,
      );
    }
    if (
      this.exitIntent !== 'return' &&
      (outcome.stopReason === 'cancelled' || outcome.stopReason === 'interrupted')
    ) {
      this.pending?.clearAll();
      this.editor.clear();
      this.renderEditorState();
      void this.shutdown(this.exitIntent === 'exit-0' ? 0 : this.exitIntent);
      return;
    }
    const recoverable = !outcome.ok && (
      outcome.stopReason === 'cancelled' ||
      outcome.stopReason === 'interrupted' ||
      outcome.stopReason === 'max_steps' ||
      outcome.stopReason === 'contract_failure'
    ) &&
      (this.session.isAvailable?.() ?? true) &&
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
      const reason = outcome.stopReason === 'max_steps'
        ? 'request limit reached'
        : outcome.stopReason === 'interrupted'
        ? 'worker interrupted'
        : outcome.stopReason === 'cancelled'
        ? 'cancelled'
        : 'agent failure';
      const sideEffect = this.pending?.hasSideEffectWarning
        ? ' · tools may have changed the workspace'
        : '';
      this.renderer.setStatus(
        `${reason}; recoverable input available; use /recover${sideEffect}`,
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
    (this.renderer as TuiRenderer & {
      setPendingMetadata?: (
        value: ReturnType<PendingInputCore['snapshot']> | undefined,
      ) => void;
    }).setPendingMetadata?.(this.pending?.snapshot(this.editor.snapshot()));
    if (!recoverable) this.renderer.setStatus(this.readyStatus());
  }

  /** Read committed context only after the settled turn is returning to idle. */
  private readyStatus(): string {
    const base = this.pendingRecallShortId === null
      ? this.readyStatusWithoutCredential()
      : `recall ${this.pendingRecallShortId} ready · next task only`;
    const availability = this.session.credentialAvailabilitySnapshot?.();
    const selection = this.session.modelSelectionSnapshot?.();
    if (
      availability?.status !== 'missing' || selection === undefined ||
      availability.authProfile !== selection.authProfile
    ) return base;
    const parts = base.split(' · ');
    const ready = parts.findIndex((part) => part === 'ready' || part.startsWith('ready '));
    parts.splice(
      ready < 0 ? parts.length : ready + 1,
      0,
      `credential missing: ${selection.provider}`,
    );
    return parts.join(' · ');
  }

  private readyStatusWithoutCredential(): string {
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
    return `${
      prefix === undefined ? 'ready' : `${prefix} · ready`
    }${context}${semantic} · ctx ${estimateK} KiB`;
  }

  private idleCtrlC(): void {
    this.discardIntent = null;
    try {
      this.dispatchIntent({ kind: 'clear_recall' });
    } catch {
      // Editor clearing remains available when the backing session is already unavailable.
    }
    this.pendingRecallShortId = null;
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
      this.renderer.clearLiveActivity();
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
    this.renderer.clearLiveActivity();
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
      await this.settleSessionSwitch();
      await this.settleRecall();
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
    await this.settleSessionSwitch();
    await this.settleRecall();
    await this.settleHumanHistory();
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
    await this.settleSessionSwitch();
    await this.settleRecall();
    await this.settleHistoryExport();
    if (this.shutdownPromise === null) {
      this.shutdownPromise = this.lifecycle.restore();
    }
    await this.shutdownPromise;
  }

  private async settleNavigation(): Promise<void> {
    await this.overlay.settle();
  }

  private async settleSessionSwitch(): Promise<void> {
    const operation = this.sessionSwitchOperation;
    if (operation === null) return;
    await Promise.allSettled([operation]);
    if (this.sessionSwitchOperation === operation) this.sessionSwitchOperation = null;
  }

  private async settleRecall(): Promise<void> {
    const operation = this.recallOperation;
    if (operation === null) return;
    await Promise.allSettled([operation]);
    if (this.recallOperation === operation) this.recallOperation = null;
  }

  private async settleHistoryExport(): Promise<void> {
    const owned = this.historyExportOperation;
    if (owned === null) return;
    await Promise.allSettled([owned.operation]);
    if (this.historyExportOperation === owned) this.historyExportOperation = null;
  }

  private async settleHumanHistory(): Promise<void> {
    const operation = this.humanHistoryOperation;
    if (operation === null) return;
    await Promise.allSettled([operation]);
    if (this.humanHistoryOperation === operation) this.humanHistoryOperation = null;
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
