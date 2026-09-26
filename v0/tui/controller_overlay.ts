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
  type CredentialRegistration,
  credentialRegistrationFailureNotice,
  type CredentialRegistrationTarget,
} from '../agent/provider/credential_registration.ts';
import type { AuthProfileId } from '../agent/provider/model_selection.ts';
import {
  modelCatalogEntryFor,
  type ModelSelection,
  type ProviderId,
  providerIdsForSelection,
  type ProviderModelCatalogEntry,
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
  | { readonly kind: 'model-selecting' }
  | {
    readonly kind: 'credential-targets';
    readonly targets: readonly CredentialRegistrationTarget[];
    readonly selected: number;
    readonly top: number;
  }
  | {
    readonly kind: 'credential-input';
    readonly authProfile: AuthProfileId;
    /** Private dialog state; this is the only holder of the entered credential value. */
    readonly value: string;
    readonly notice?: string;
  }
  | { readonly kind: 'credential-saving'; readonly authProfile: AuthProfileId };

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
  /** Notify the controller that a provider/model selection notice is now the status line. */
  readonly selectionStatusApplied?: () => void;
  /** Host-local credential registration used by the dedicated `/login` dialog. */
  readonly credentialRegistration?: CredentialRegistration;
  /** Presence-only display refresh after a successful save; failures leave the save intact. */
  readonly refreshCredentialAvailability?: () => void | Promise<void>;
  readonly fail: (error: unknown) => Promise<void>;
}

/** Owns help/session-picker presentation and the navigation operations started by it. */
export class ControllerOverlay {
  private modal: ControllerModal | null = null;
  private readonly navigationOperations = new Set<OwnedNavigationOperation>();
  private navigationGeneration = 0;
  private modelSelectionOperation: Promise<void> | null = null;
  private credentialSaveOperation: Promise<void> | null = null;

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
      providers: providerIdsForSelection(),
      selected: Math.max(0, providerIdsForSelection().indexOf(selection.provider)),
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

  /** Open the credential registration target picker; no model or session state is touched. */
  openCredentialRegistration(): void {
    const registration = this.options.credentialRegistration;
    const targets = registration?.targets() ?? [];
    if (registration === undefined || targets.length === 0) {
      this.options.renderer.setStatus('credential registration unavailable');
      return;
    }
    const current = this.options.modelSelection();
    const selected = Math.max(
      0,
      targets.findIndex((target) => target.authProfile === current?.authProfile),
    );
    this.modal = {
      kind: 'credential-targets',
      targets,
      selected,
      top: this.credentialWindowTop(selected, 0, targets.length),
    };
    this.renderCredentialTargets();
  }

  /** Rows available for target lines; the window follows the terminal size so selection stays visible. */
  private credentialVisibleRows(): number {
    const rows = this.options.renderer.stateSnapshot?.().terminalSize.rows ?? 24;
    return Math.max(1, Math.min(rows - 8, 24));
  }

  private credentialWindowTop(selected: number, top: number, count: number): number {
    const visible = Math.min(this.credentialVisibleRows(), Math.max(1, count));
    let start = Math.max(0, Math.min(top, Math.max(0, count - visible)));
    if (selected < start) start = selected;
    if (selected > start + visible - 1) start = selected - visible + 1;
    return Math.max(0, Math.min(start, Math.max(0, count - visible)));
  }

  private renderCredentialTargets(): void {
    const modal = this.modal;
    if (modal?.kind !== 'credential-targets') return;
    const count = modal.targets.length;
    const visible = Math.min(this.credentialVisibleRows(), Math.max(1, count));
    const rows = modal.targets.slice(modal.top, modal.top + visible).map((target, offset) => {
      const index = modal.top + offset;
      return `${index === modal.selected ? '>' : ' '} ${target.authProfile} · ${
        target.providers.join(', ')
      }`;
    });
    const window = count > visible
      ? ` · ${modal.top + 1}-${modal.top + rows.length} of ${count}`
      : '';
    this.options.renderer.renderChoicePicker?.([
      `credential registration · Up/Down select · Enter edit · Esc cancel${window}`,
      ...rows,
    ]);
  }

  private renderCredentialInput(notice?: string): void {
    const modal = this.modal;
    if (modal?.kind !== 'credential-input') return;
    // Masking happens before the renderer so no display state ever holds the entered value.
    const masked = '*'.repeat([...modal.value].length);
    const lines = [
      `credential input · ${modal.authProfile} · type or paste the key · Enter save · Esc cancel`,
    ];
    const reason = notice ?? modal.notice;
    if (reason !== undefined && reason !== '') lines.push(reason);
    lines.push(`key> ${masked}`);
    this.options.renderer.renderChoicePicker?.(lines);
  }

  /** Drop every reference to the dialog's private input state. */
  private closeCredentialRegistration(): void {
    this.modal = null;
    this.options.renderer.clearModal?.();
    this.options.renderer.setStatus(this.options.readyStatus());
  }

  private beginCredentialSave(authProfile: AuthProfileId, value: string): void {
    const registration = this.options.credentialRegistration;
    if (registration === undefined) {
      this.closeCredentialRegistration();
      return;
    }
    this.modal = { kind: 'credential-saving', authProfile };
    this.options.renderer.renderChoicePicker?.([
      `saving credential · ${authProfile}`,
    ]);
    const operation = Promise.resolve().then(() => registration.save(authProfile, value)).then(
      async () => {
        this.modal = null;
        this.options.renderer.clearModal?.();
        try {
          await this.options.refreshCredentialAvailability?.();
          // The ready-status prefix keeps the message visible: the footer renders from the
          // `ready` segment onward, so a prefix message would be dropped there.
          this.options.renderer.setStatus(
            `${this.options.readyStatus()} · credential saved: ${authProfile}`,
          );
        } catch {
          // The credential stays saved; only the display refresh is reported incomplete.
          this.options.renderer.setStatus(
            `credential saved: ${authProfile} · display refresh incomplete`,
          );
        }
      },
      (error: unknown) => {
        // The value never leaves the private dialog state; retry keeps it and cancel drops it.
        this.modal = {
          kind: 'credential-input',
          authProfile,
          value,
          notice: credentialRegistrationFailureNotice(error),
        };
        this.renderCredentialInput();
      },
    ).catch((error: unknown) => {
      this.modal = null;
      this.options.renderer.clearModal?.();
      if (isPresentationDeliveryError(error)) {
        void this.options.fail(error).catch(() => {
          // The controller has already entered its fatal shutdown path.
        });
      } else this.options.renderer.setStatus('credential save failed');
    }).finally(() => {
      if (this.credentialSaveOperation === operation) {
        this.credentialSaveOperation = null;
      }
    });
    this.credentialSaveOperation = operation;
  }

  process(event: InputEvent): void {
    const modal = this.modal;
    if (modal === null) return;
    const { renderer } = this.options;
    if (modal.kind === 'model-selecting') return;
    // The save owns the modal until it settles: same-read input cannot reach the normal editor and
    // Esc during a save can never look like a rolled-back success.
    if (modal.kind === 'credential-saving') return;
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
    if (modal.kind === 'credential-targets') {
      if (event.kind === 'up' || event.kind === 'down') {
        const count = modal.targets.length;
        const delta = event.kind === 'up' ? -1 : 1;
        const selected = (modal.selected + delta + count) % count;
        this.modal = {
          ...modal,
          selected,
          top: this.credentialWindowTop(selected, modal.top, count),
        };
        this.renderCredentialTargets();
        return;
      }
      if (event.kind === 'enter') {
        const target = modal.targets[modal.selected];
        if (target === undefined) return;
        this.modal = {
          kind: 'credential-input',
          authProfile: target.authProfile,
          value: '',
        };
        this.renderCredentialInput();
      }
      return;
    }
    if (modal.kind === 'credential-input') {
      if (event.kind === 'ctrl_c' || event.kind === 'ctrl_d') {
        this.closeCredentialRegistration();
        return;
      }
      if (event.kind === 'backspace') {
        this.modal = {
          ...modal,
          value: [...modal.value].slice(0, -1).join(''),
        };
        this.renderCredentialInput();
        return;
      }
      if (event.kind === 'ctrl_u') {
        this.modal = { ...modal, value: '' };
        this.renderCredentialInput();
        return;
      }
      if (event.kind === 'printable' || event.kind === 'paste') {
        if (event.text.includes('\0')) return;
        this.modal = { ...modal, value: `${modal.value}${event.text}` };
        this.renderCredentialInput();
        return;
      }
      if (event.kind === 'enter') {
        this.beginCredentialSave(modal.authProfile, modal.value);
      }
      return;
    }
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
        return;
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
        this.options.selectionStatusApplied?.();
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
      let restored:
        | import('../presentation/contract.ts').PresentationRestoredConversation
        | undefined;
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
        renderer.renderRestored(
          restored.messages,
          restored.omitted,
          restored.thinking,
          restored.messageTurns,
        );
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
    while (this.credentialSaveOperation !== null) {
      const save = this.credentialSaveOperation;
      await Promise.allSettled([save]);
      if (this.credentialSaveOperation === save) this.credentialSaveOperation = null;
    }
  }
}
