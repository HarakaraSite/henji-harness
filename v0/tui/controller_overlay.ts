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
  type PresentationPosition,
} from '../presentation/contract.ts';
import type { TuiNavigationLike, TuiSessionLike } from './controller_contract.ts';
import type { InputEvent } from './input.ts';
import type { TuiRenderer } from './render.ts';

type ControllerModal =
  | { readonly kind: 'startup-help' }
  | {
    readonly kind: 'picker';
    readonly listing: PresentationNavigationListing;
    readonly selected: number;
    readonly page: number;
  }
  | { readonly kind: 'picker-loading' }
  | { readonly kind: 'history'; readonly page: PresentationHistoryPage }
  | { readonly kind: 'context'; readonly preview: PresentationContextPreview };

type OwnedNavigationOperation = {
  readonly operation: Promise<void>;
  readonly abort: AbortController;
  readonly generation: number;
};

const isPresentationDeliveryError = (error: unknown): boolean =>
  error instanceof PresentationDeliveryError ||
  isPresentationError(error, 'PresentationDeliveryError') ||
  isPresentationError(error, 'EventDeliveryError');

export interface ControllerOverlayOptions {
  readonly renderer: TuiRenderer;
  readonly navigation?: TuiNavigationLike;
  readonly intents?: PresentationIntentDispatcher;
  readonly dispatch: (
    intent: PresentationIntent,
  ) => PresentationIntentResult | Promise<PresentationIntentResult>;
  readonly getSession: () => TuiSessionLike;
  readonly setSession: (session: TuiSessionLike) => void;
  readonly idleAllowed: () => boolean;
  readonly isIdle: () => boolean;
  readonly readyStatus: () => string;
  readonly startContextCompaction: () => void;
  readonly fail: (error: unknown) => Promise<void>;
}

/** Owns modal presentation and the navigation/history operations started by it. */
export class ControllerOverlay {
  private modal: ControllerModal | null = null;
  private readonly navigationOperations = new Set<OwnedNavigationOperation>();
  private navigationGeneration = 0;
  private readonly historyOperations = new Set<OwnedNavigationOperation>();
  private historyGeneration = 0;

  constructor(private readonly options: ControllerOverlayOptions) {}

  get isOpen(): boolean {
    return this.modal !== null;
  }

  openPicker(): void {
    const { navigation, intents, renderer } = this.options;
    if (!this.options.idleAllowed()) {
      renderer.setStatus('navigation requires an empty idle session');
      return;
    }
    if (intents === undefined && (navigation === undefined || !navigation.persistent)) {
      renderer.setStatus('session picker unavailable');
      return;
    }
    this.modal = { kind: 'picker-loading' };
    renderer.renderSessionPicker?.(
      { sessions: [], skippedInvalid: 0 },
      0,
      0,
      true,
    );
    const abort = new AbortController();
    const generation = ++this.navigationGeneration;
    const operation = Promise.resolve(
      intents !== undefined
        ? this.options.dispatch({ kind: 'list_sessions' })
        : navigation!.list(abort.signal).then((listing) => ({
          kind: 'listing' as const,
          listing,
        })),
    ).then(
      (result) => {
        if (result.kind !== 'listing') return;
        const listing = result.listing;
        if (
          !this.options.isIdle() || this.modal?.kind !== 'picker-loading' ||
          abort.signal.aborted || this.navigationGeneration !== generation
        ) return;
        this.modal = { kind: 'picker', listing, selected: 0, page: 0 };
        renderer.renderSessionPicker?.(listing, 0, 0);
      },
      (error: unknown) => {
        if (
          isPresentationError(error, 'NavigationCancelledError') ||
          abort.signal.aborted
        ) return;
        if (
          !this.options.isIdle() || this.modal?.kind !== 'picker-loading' ||
          this.navigationGeneration !== generation
        ) return;
        this.modal = null;
        renderer.clearModal?.();
        renderer.setStatus('session list unavailable');
      },
    );
    this.trackNavigationOperation(operation, abort, generation);
  }

  openStartupHelp(): void {
    this.modal = { kind: 'startup-help' };
    this.options.renderer.renderStartupHelp?.();
  }

  openHistory(): void {
    const { intents, navigation, renderer } = this.options;
    const session = this.options.getSession();
    if (!this.options.idleAllowed()) {
      renderer.setStatus('history requires an empty idle session');
      return;
    }
    if (
      intents === undefined && navigation === undefined &&
      session.historyPage === undefined
    ) {
      renderer.setStatus('history unavailable');
      return;
    }
    const position = navigation?.currentPosition() ??
      (intents !== undefined
        ? (() => {
          const projection = renderer.stateSnapshot().projection;
          return projection === undefined ? undefined : {
            sessionId: projection.sessionId,
            agent: projection.agentId,
            committedTurn: projection.committedTurn,
            messageCount: 0,
            checkpoint: projection.checkpoint,
          };
        })()
        : session.currentPosition?.());
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

  openContextPanel(): void {
    const { intents, navigation, renderer } = this.options;
    const session = this.options.getSession();
    if (!this.options.idleAllowed()) {
      renderer.setStatus('context recovery requires an empty idle session');
      return;
    }
    if (
      intents === undefined && (
        navigation === undefined || !navigation.persistent ||
        session.contextCompactionPreview === undefined ||
        session.compactContext === undefined
      )
    ) {
      renderer.setStatus('context recovery unavailable');
      return;
    }
    try {
      const dispatched = intents === undefined
        ? {
          kind: 'context_preview' as const,
          preview: session.contextCompactionPreview!(),
        }
        : this.options.dispatch({ kind: 'compaction', action: 'preview' });
      if (
        dispatched instanceof Promise || dispatched.kind !== 'context_preview'
      ) {
        renderer.setStatus('context recovery unavailable');
        return;
      }
      const preview = dispatched.preview;
      if (preview === undefined) {
        renderer.setStatus('context recovery unavailable');
        return;
      }
      this.modal = { kind: 'context', preview };
      renderer.renderContextPanel?.(preview);
    } catch (error) {
      if (isPresentationDeliveryError(error)) throw error;
      renderer.setStatus('context recovery unavailable');
    }
  }

  process(event: InputEvent): void {
    const modal = this.modal;
    if (modal === null) return;
    const { renderer } = this.options;
    if (event.kind === 'escape') {
      if (modal.kind === 'picker-loading') this.cancelNavigationOperations();
      else if (modal.kind === 'history') this.cancelHistoryOperations();
      this.modal = null;
      renderer.clearModal?.();
      renderer.setStatus(this.options.readyStatus());
      return;
    }
    if (modal.kind === 'startup-help') {
      if (event.kind === 'f1') {
        this.modal = null;
        renderer.clearModal?.();
        renderer.setStatus(this.options.readyStatus());
      }
      return;
    }
    if (modal.kind === 'picker-loading') return;
    if (modal.kind === 'picker') {
      const count = modal.listing.sessions.length;
      if (
        event.kind === 'up' || event.kind === 'down' || event.kind === 'left' ||
        event.kind === 'right'
      ) {
        const moved = movePresentationPickerSelection(
          count,
          modal.selected,
          modal.page,
          event.kind,
        );
        this.modal = { ...modal, selected: moved.selected, page: moved.page };
        renderer.renderSessionPicker?.(modal.listing, moved.selected, moved.page);
        return;
      }
      if (event.kind === 'enter') {
        const row = modal.listing.sessions[modal.selected];
        if (row === undefined || row.current) {
          this.modal = null;
          renderer.clearModal?.();
          renderer.setStatus(this.options.readyStatus());
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
      const session = this.options.getSession();
      if (
        this.options.intents === undefined && this.options.navigation === undefined &&
        session.historyPage === undefined
      ) return;
      this.startHistoryPageLoad(page, turn);
      return;
    }
    if (event.kind === 'printable' && event.text === 'v') {
      if (this.options.intents !== undefined) {
        renderer.setStatus('context checkpoint summary available after install');
        return;
      }
      const checkpoint = this.options.getSession().checkpointSnapshot?.();
      if (checkpoint === undefined) {
        renderer.setStatus('no active context checkpoint');
      } else {
        renderer.renderContextSummary?.(
          checkpoint.summary,
          checkpoint.coveredThroughTurn,
        );
      }
    } else if (event.kind === 'enter') {
      this.modal = null;
      renderer.clearModal?.();
      this.options.startContextCompaction();
    }
  }

  private trackNavigationOperation(
    operation: Promise<void>,
    abort: AbortController,
    generation: number,
  ): void {
    const owned = { operation, abort, generation };
    this.navigationOperations.add(owned);
    void operation.then(
      () => this.navigationOperations.delete(owned),
      (error) => {
        this.navigationOperations.delete(owned);
        if (
          isPresentationError(error, 'NavigationCancelledError') ||
          abort.signal.aborted &&
            !isPresentationError(error, 'NavigationFatalError') &&
            !isPresentationDeliveryError(error)
        ) return;
        void this.options.fail(error).catch(() => {
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
    const { intents, navigation, renderer } = this.options;
    if (intents === undefined && navigation === undefined) return;
    this.modal = { kind: 'picker-loading' };
    renderer.renderSessionPicker?.(
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
      if (intents !== undefined) {
        const result = await this.options.dispatch({ kind: 'resume_session', id });
        if (result.kind !== 'binding') throw new PresentationDeliveryError();
        position = result.position;
        restored = result.restored;
      } else {
        const binding = await navigation!.switchTo(id, signal);
        // switchTo may cross its irreversible old-session close before cancellation is observed.
        // Adopt the transferred binding before generation checks so no closed session is retained.
        this.options.setSession(binding.session);
        position = binding.position;
        restored = binding.restored;
      }
      if (
        !this.options.isIdle() || signal.aborted ||
        this.navigationGeneration !== generation
      ) return;
      this.modal = null;
      renderer.clearModal?.();
      if (intents === undefined && restored !== undefined) {
        renderer.renderRestored(restored.messages, restored.omitted);
      }
      if (!this.options.isIdle()) return;
      renderer.setCurrentPosition?.(position);
      renderer.setStatus(this.options.readyStatus());
    } catch (error) {
      if (
        isPresentationError(error, 'NavigationFatalError') ||
        isPresentationDeliveryError(error)
      ) throw error;
      if (isPresentationError(error, 'NavigationCancelledError') || signal.aborted) return;
      if (this.navigationGeneration !== generation) return;
      this.modal = null;
      renderer.clearModal?.();
      renderer.setStatus('session resume failed; current session unchanged');
    }
  }

  private cancelNavigationOperations(): void {
    this.navigationGeneration += 1;
    if (this.options.intents !== undefined) {
      const dispatched = this.options.dispatch({ kind: 'dismiss_overlay' });
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

  private startHistoryPageLoad(page: number, turn: number): void {
    this.cancelHistoryOperations();
    const abort = new AbortController();
    const generation = ++this.historyGeneration;
    const operation = this.loadHistoryPage(page, turn, generation, abort.signal);
    const owned = { operation, abort, generation };
    this.historyOperations.add(owned);
    void operation.then(
      () => this.historyOperations.delete(owned),
      (error) => {
        this.historyOperations.delete(owned);
        if (isPresentationDeliveryError(error) || !abort.signal.aborted) {
          void this.options.fail(error).catch(() => {
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
      const { intents, navigation, renderer } = this.options;
      const result = intents !== undefined
        ? await this.options.dispatch({ kind: 'history_page', page, turn })
        : {
          kind: 'history' as const,
          page: navigation !== undefined
            ? await navigation.historyPage(page, turn, 16)
            : await this.options.getSession().historyPage?.(page, turn, 16),
        };
      if (
        signal.aborted || generation !== this.historyGeneration ||
        this.modal?.kind !== 'history'
      ) return;
      if (result.kind !== 'history' || result.page === undefined) {
        this.modal = null;
        renderer.setStatus('history unavailable');
        return;
      }
      this.modal = { kind: 'history', page: result.page };
      if (intents === undefined) renderer.renderHistoryPage?.(result.page);
    } catch (error) {
      if (isPresentationDeliveryError(error)) throw error;
      if (signal.aborted || generation !== this.historyGeneration) return;
      this.modal = null;
      this.options.renderer.setStatus('history unavailable');
    }
  }

  async settle(): Promise<void> {
    if (this.options.intents !== undefined) {
      const dispatched = this.options.dispatch({ kind: 'dismiss_overlay' });
      if (dispatched instanceof Promise) await Promise.allSettled([dispatched]);
    }
    while (this.navigationOperations.size > 0 || this.historyOperations.size > 0) {
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
      for (const operation of navigation) this.navigationOperations.delete(operation);
      for (const operation of history) this.historyOperations.delete(operation);
    }
  }
}
