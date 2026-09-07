import {
  isPresentationError,
  movePresentationPickerSelection,
  PresentationDeliveryError,
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
  | { readonly kind: 'picker-loading' };

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
  readonly setSession: (session: TuiSessionLike) => void;
  readonly idleAllowed: () => boolean;
  readonly isIdle: () => boolean;
  readonly readyStatus: () => string;
  readonly fail: (error: unknown) => Promise<void>;
}

/** Owns help/session-picker presentation and the navigation operations started by it. */
export class ControllerOverlay {
  private modal: ControllerModal | null = null;
  private readonly navigationOperations = new Set<OwnedNavigationOperation>();
  private navigationGeneration = 0;

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

  process(event: InputEvent): void {
    const modal = this.modal;
    if (modal === null) return;
    const { renderer } = this.options;
    if (event.kind === 'escape') {
      if (modal.kind === 'picker-loading') this.cancelNavigationOperations();
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
  }

  async settle(): Promise<void> {
    if (this.options.intents !== undefined) {
      const dispatched = this.options.dispatch({ kind: 'dismiss_overlay' });
      if (dispatched instanceof Promise) await Promise.allSettled([dispatched]);
    }
    while (this.navigationOperations.size > 0) {
      const navigation = [...this.navigationOperations];
      for (const operation of navigation) {
        operation.abort.abort('controller settlement');
      }
      await Promise.allSettled([
        ...navigation.map((operation) => operation.operation),
      ]);
      for (const operation of navigation) this.navigationOperations.delete(operation);
    }
  }
}
