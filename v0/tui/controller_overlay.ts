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
import {
  modelCatalogEntryFor,
  type ModelSelection,
  type ProviderId,
  type ProviderModelCatalogEntry,
  PROVIDERS,
  type ReasoningEffort,
  searchModelsFor,
  selectModelFor,
} from '../agent/provider/model_catalog.ts';

type ControllerModal =
  | { readonly kind: 'startup-help' }
  | {
    readonly kind: 'picker';
    readonly listing: PresentationNavigationListing;
    readonly selected: number;
    readonly page: number;
  }
  | { readonly kind: 'picker-loading' }
  | {
    readonly kind: 'provider-picker';
    readonly providers: readonly ProviderId[];
    readonly selected: number;
  }
  | {
    readonly kind: 'model-picker';
    readonly provider: ProviderId;
    readonly query: string;
    readonly entries: readonly ProviderModelCatalogEntry[];
    readonly selected: number;
  }
  | {
    readonly kind: 'effort-picker';
    readonly provider: ProviderId;
    readonly modelId: string;
    readonly efforts: readonly ReasoningEffort[];
    readonly selected: number;
  }
  | { readonly kind: 'model-selecting' };

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
  readonly bindingReplaced?: () => void;
  readonly idleAllowed: () => boolean;
  readonly isIdle: () => boolean;
  readonly readyStatus: () => string;
  readonly modelSelection: () => ModelSelection | undefined;
  readonly fail: (error: unknown) => Promise<void>;
}

/** Owns help/session-picker presentation and the navigation operations started by it. */
export class ControllerOverlay {
  private modal: ControllerModal | null = null;
  private readonly navigationOperations = new Set<OwnedNavigationOperation>();
  private navigationGeneration = 0;
  private modelSelectionOperation: Promise<void> | null = null;

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

  openProviderPicker(): void {
    const selection = this.options.modelSelection();
    if (selection === undefined) {
      this.options.renderer.setStatus('provider picker unavailable');
      return;
    }
    this.modal = {
      kind: 'provider-picker',
      providers: PROVIDERS,
      selected: Math.max(0, PROVIDERS.indexOf(selection.provider)),
    };
    this.renderProviderPicker();
  }

  openModelPicker(): void {
    const selection = this.options.modelSelection();
    if (selection === undefined) {
      this.options.renderer.setStatus('model picker unavailable');
      return;
    }
    const entries = searchModelsFor(selection.provider, '');
    const selected = Math.max(
      0,
      entries.findIndex((entry) => entry.modelId === selection.modelId),
    );
    this.modal = {
      kind: 'model-picker',
      provider: selection.provider,
      query: '',
      entries,
      selected,
    };
    this.renderModelPicker();
  }

  openEffortPicker(): void {
    const selection = this.options.modelSelection();
    const entry = selection === undefined
      ? undefined
      : modelCatalogEntryFor(selection.provider, selection.modelId);
    if (selection === undefined || entry === undefined) {
      this.options.renderer.setStatus('effort picker unavailable');
      return;
    }
    this.modal = {
      kind: 'effort-picker',
      provider: selection.provider,
      modelId: selection.modelId,
      efforts: entry.efforts,
      selected: Math.max(0, entry.efforts.indexOf(selection.effort)),
    };
    this.renderEffortPicker();
  }

  process(event: InputEvent): void {
    const modal = this.modal;
    if (modal === null) return;
    const { renderer } = this.options;
    if (modal.kind === 'model-selecting') return;
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
    if (modal.kind === 'provider-picker') {
      if (event.kind === 'up' || event.kind === 'down') {
        const delta = event.kind === 'up' ? -1 : 1;
        const count = modal.providers.length;
        this.modal = {
          ...modal,
          selected: (modal.selected + delta + count) % count,
        };
        this.renderProviderPicker();
        return;
      }
      if (event.kind === 'enter') {
        const provider = modal.providers[modal.selected];
        const current = this.options.modelSelection();
        if (provider === undefined || provider === current?.provider) {
          this.modal = null;
          renderer.clearModal?.();
          renderer.setStatus(this.options.readyStatus());
        } else {
          this.applyProviderSelection(provider);
        }
      }
      return;
    }
    if (modal.kind === 'model-picker') {
      if (event.kind === 'up' || event.kind === 'down') {
        const count = modal.entries.length;
        if (count === 0) return;
        const delta = event.kind === 'up' ? -1 : 1;
        this.modal = {
          ...modal,
          selected: (modal.selected + delta + count) % count,
        };
        this.renderModelPicker();
        return;
      }
      if (event.kind === 'backspace') {
        this.updateModelQuery([...modal.query].slice(0, -1).join(''));
        return;
      }
      if (event.kind === 'printable' || event.kind === 'paste') {
        if (!event.text.includes('\0')) {
          this.updateModelQuery(`${modal.query}${event.text}`);
        }
        return;
      }
      if (event.kind === 'enter') {
        const entry = modal.entries[modal.selected];
        if (entry !== undefined) {
          this.applyModelSelection(selectModelFor(modal.provider, entry.modelId));
        }
      }
      return;
    }
    if (modal.kind === 'effort-picker') {
      if (event.kind === 'up' || event.kind === 'down') {
        const delta = event.kind === 'up' ? -1 : 1;
        const count = modal.efforts.length;
        this.modal = {
          ...modal,
          selected: (modal.selected + delta + count) % count,
        };
        this.renderEffortPicker();
        return;
      }
      if (event.kind === 'enter') {
        const effort = modal.efforts[modal.selected];
        if (effort !== undefined) {
          this.applyModelSelection(selectModelFor(modal.provider, modal.modelId, effort));
        }
      }
    }
  }

  private updateModelQuery(query: string): void {
    const modal = this.modal;
    if (modal?.kind !== 'model-picker') return;
    const entries = searchModelsFor(modal.provider, query);
    this.modal = { ...modal, query, entries, selected: 0 };
    this.renderModelPicker();
  }

  private renderProviderPicker(): void {
    const modal = this.modal;
    if (modal?.kind !== 'provider-picker') return;
    this.options.renderer.renderChoicePicker?.([
      'provider picker · Up/Down select · Enter choose · Esc cancel',
      ...modal.providers.map((provider, index) =>
        `${index === modal.selected ? '>' : ' '} ${provider}`
      ),
    ]);
  }

  private renderModelPicker(): void {
    const modal = this.modal;
    if (modal?.kind !== 'model-picker') return;
    const lines = [
      `model picker · ${modal.provider} · type to search · Up/Down select · Enter choose · Esc cancel`,
      `search> ${modal.query}`,
      ...modal.entries.map((entry, index) =>
        `${
          index === modal.selected ? '>' : ' '
        } ${entry.modelId} · default effort ${entry.defaultEffort}`
      ),
    ];
    if (modal.entries.length === 0) lines.push('no matching models');
    this.options.renderer.renderChoicePicker?.(lines);
  }

  private renderEffortPicker(): void {
    const modal = this.modal;
    if (modal?.kind !== 'effort-picker') return;
    this.options.renderer.renderChoicePicker?.([
      `effort picker · ${modal.provider} · ${modal.modelId} · Up/Down select · Enter choose · Esc cancel`,
      ...modal.efforts.map((effort, index) => `${index === modal.selected ? '>' : ' '} ${effort}`),
    ]);
  }

  private applyModelSelection(selection: ModelSelection): void {
    this.applySelection(
      {
        kind: 'select_model',
        provider: selection.provider,
        modelId: selection.modelId,
        effort: selection.effort,
      },
      `selecting ${selection.provider} · ${selection.modelId} · effort ${selection.effort}`,
    );
  }

  private applyProviderSelection(provider: ProviderId): void {
    this.applySelection(
      { kind: 'select_provider', provider },
      `selecting provider ${provider}`,
    );
  }

  private applySelection(
    intent: Extract<PresentationIntent, { kind: 'select_model' | 'select_provider' }>,
    pendingText: string,
  ): void {
    if (this.modelSelectionOperation !== null) return;
    this.modal = { kind: 'model-selecting' };
    this.options.renderer.renderChoicePicker?.([pendingText]);
    const operation = Promise.resolve(
      this.options.dispatch(intent),
    ).then((result) => {
      if (result.kind === 'model_selection') {
        this.modal = null;
        this.options.renderer.clearModal?.();
        const selected =
          `provider ${result.selection.provider} · model ${result.selection.modelId} · effort ${result.selection.effort}`;
        const ready = this.options.readyStatus();
        this.options.renderer.setStatus(
          ready.includes('credential missing:') ? `${ready} · ${selected}` : selected,
        );
        return;
      }
      this.modal = null;
      this.options.renderer.clearModal?.();
      this.options.renderer.setStatus(
        result.kind === 'rejected' && result.reason === 'busy'
          ? 'provider/model selection requires idle session'
          : 'provider/model selection unavailable',
      );
    }).catch((error: unknown) => {
      this.modal = null;
      this.options.renderer.clearModal?.();
      if (isPresentationDeliveryError(error)) {
        void this.options.fail(error);
      } else this.options.renderer.setStatus('provider/model selection failed');
    }).finally(() => {
      if (this.modelSelectionOperation === operation) {
        this.modelSelectionOperation = null;
      }
    });
    this.modelSelectionOperation = operation;
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
      this.options.bindingReplaced?.();
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
    if (this.modelSelectionOperation !== null) {
      await Promise.allSettled([this.modelSelectionOperation]);
    }
  }
}
