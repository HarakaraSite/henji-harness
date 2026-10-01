import type {
  ApiSelection,
  CatalogReadResult,
  CredentialPresenceReadResult,
  CredentialRegisterResult,
  SelectionChangeValue,
} from '../api/contract.ts';
import { type HenjiApiClient, HenjiApiError } from '../api/client.ts';
import type {
  ChatGPTAuthResult,
  ChatGPTLoginAttempt,
  ChatGPTOperation,
  ChatGPTState,
} from '../api/chatgpt_contract.ts';
import type { CommandResult, CoreCommandValue } from '../api/contract.ts';
import type { InputEvent } from './input.ts';
import type { TuiRenderer } from './render.ts';

type ProviderChoice = Extract<
  CatalogReadResult,
  { kind: 'providers' }
>['providers'][number];
type ModelChoice = Extract<
  CatalogReadResult,
  { kind: 'models' }
>['models'][number];
type ProfileChoice = Extract<
  CatalogReadResult,
  { kind: 'credentials' }
>['profiles'][number];

type ChatGPTProfileChoice = ProfileChoice & {
  readonly method?: 'api-key' | 'chatgpt';
  readonly label?: string;
};

type CatalogModal =
  | {
    readonly kind: 'loading';
    readonly title: string;
    readonly generation: number;
    readonly sessionId: string;
  }
  | {
    readonly kind: 'providers';
    readonly entries: readonly ProviderChoice[];
    readonly selected: number;
  }
  | {
    readonly kind: 'models';
    readonly metadataStatus: 'loaded' | 'unavailable';
    readonly savingFavorite?: boolean;
    readonly provider: string;
    readonly query: string;
    readonly currentModelId: string;
    readonly catalog: readonly ModelChoice[];
    readonly entries: readonly ModelChoice[];
    readonly selected: number;
    readonly top: number;
  }
  | {
    readonly kind: 'efforts';
    readonly source: 'models.dev' | 'catalog' | 'unknown' | 'override';
    readonly provider: string;
    readonly modelId: string;
    readonly efforts: readonly string[];
    readonly selected: number;
  }
  | {
    readonly kind: 'profiles';
    readonly entries: readonly ChatGPTProfileChoice[];
    readonly presence: CredentialPresenceReadResult['profiles'];
    readonly selected: number;
    readonly top: number;
  }
  | {
    readonly kind: 'chatgpt-accounts';
    readonly state: ChatGPTState;
    readonly selected: number;
    readonly notice?: string;
  }
  | {
    readonly kind: 'chatgpt-authorize';
    readonly state: ChatGPTState;
    readonly attempt: ChatGPTLoginAttempt;
  }
  | {
    readonly kind: 'chatgpt-callback';
    readonly state: ChatGPTState;
    readonly attempt: ChatGPTLoginAttempt;
    /** The full callback URL stays in this modal state and is never rendered. */
    readonly callbackUrl: string;
  }
  | {
    readonly kind: 'chatgpt-operation';
    readonly operation: 'status' | 'begin' | 'complete' | 'cancel' | 'select';
    readonly generation: number;
    readonly state?: ChatGPTState;
    readonly attempt?: ChatGPTLoginAttempt;
  }
  | {
    readonly kind: 'chatgpt-models';
    readonly state: ChatGPTState;
    readonly accountLabel: string;
    readonly entries: readonly ModelChoice[];
    readonly selected: number;
    readonly top: number;
  }
  | {
    readonly kind: 'credential-input';
    readonly authProfile: string;
    /** Credential material is held only in this dedicated dialog state. */
    readonly value: string;
    readonly notice?: string;
  }
  | { readonly kind: 'saving-credential'; readonly authProfile: string }
  | { readonly kind: 'saving-selection' };

export interface RemoteCatalogUiOptions {
  readonly client: Pick<
    HenjiApiClient,
    | 'catalogRead'
    | 'modelFavorite'
    | 'selectionChange'
    | 'commandRead'
    | 'credentialPresenceRead'
    | 'credentialRegister'
    | 'chatgptAuth'
  >;
  readonly renderer: Pick<
    TuiRenderer,
    'renderChoicePicker' | 'clearModal'
  >;
  readonly sessionId: () => string;
  readonly selection: () => ApiSelection;
  readonly selectionChanged: (selection: ApiSelection) => void;
  readonly canChangeSelection: () => boolean;
  readonly canRegisterCredential: () => boolean;
  readonly setNotice: (notice?: string) => void;
  readonly retainNotice: (
    sessionId: string,
    identity: string,
    text: string,
    failureWord?: string,
  ) => void;
}

const wrappedIndex = (
  selected: number,
  count: number,
  direction: -1 | 1,
): number => count === 0 ? 0 : (selected + direction + count) % count;

const modelWindowTop = (
  selected: number,
  top: number,
  count: number,
): number => {
  const visible = 10;
  if (selected < top) return selected;
  if (selected >= top + visible) return selected - visible + 1;
  return Math.max(0, Math.min(top, count - visible));
};

const profileWindowTop = (
  selected: number,
  top: number,
  count: number,
): number => {
  const visible = 10;
  if (selected < top) return selected;
  if (selected >= top + visible) return selected - visible + 1;
  return Math.max(0, Math.min(top, count - visible));
};

const catalogTitle = (
  kind: 'providers' | 'models' | 'efforts' | 'credentials',
) =>
  kind === 'providers'
    ? 'loading provider catalog'
    : kind === 'models'
    ? 'loading model catalog'
    : kind === 'efforts'
    ? 'loading effort catalog'
    : 'loading credential profiles';

const acceptedSelection = (
  command:
    | CommandResult<SelectionChangeValue>
    | CommandResult<CoreCommandValue>,
): ApiSelection | undefined => {
  if (command.kind !== 'accepted' || !('selection' in command.value)) {
    return undefined;
  }
  return command.value.selection;
};

const runSelectionCommand = async (
  client: RemoteCatalogUiOptions['client'],
  sessionId: string,
  selection: ApiSelection,
  commandId: string,
): Promise<CommandResult<CoreCommandValue>> => {
  try {
    return await client.selectionChange(sessionId, { commandId, selection });
  } catch {
    let state = await client.commandRead(commandId);
    while (state.kind === 'processing') {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      state = await client.commandRead(commandId);
    }
    return state;
  }
};

const profilePresence = (
  profiles: CredentialPresenceReadResult['profiles'],
  authProfile: string,
): CredentialPresenceReadResult['profiles'][number] | undefined =>
  profiles.find((profile) => profile.authProfile === authProfile);

/** Core-backed selection and credential interactions for the remote TUI. */
export class RemoteCatalogUi {
  private modal: CatalogModal | null = null;
  private generation = 0;

  constructor(private readonly options: RemoteCatalogUiOptions) {}

  get isOpen(): boolean {
    return this.modal !== null;
  }

  async openProviders(): Promise<void> {
    if (!this.requireSelectionReady('/provider')) return;
    const sessionId = this.options.sessionId();
    const generation = this.beginLoading('providers', sessionId);
    try {
      const result = await this.options.client.catalogRead({
        kind: 'providers',
      });
      if (!this.current(generation)) return;
      if (result.kind !== 'providers') {
        throw new TypeError('provider catalog unavailable');
      }
      const selected = Math.max(
        0,
        result.providers.findIndex((entry) => entry.provider === this.options.selection().provider),
      );
      this.modal = { kind: 'providers', entries: result.providers, selected };
      this.options.setNotice(undefined);
      this.renderProviders();
    } catch {
      this.failCatalog(generation, 'provider catalog unavailable');
    }
  }

  async openModels(): Promise<void> {
    if (!this.requireSelectionReady('/model')) return;
    const selection = this.options.selection();
    const sessionId = this.options.sessionId();
    const generation = this.beginLoading('models', sessionId);
    try {
      const result = await this.options.client.catalogRead({
        kind: 'models',
        provider: selection.provider,
        sessionId,
      });
      if (!this.current(generation)) return;
      if (result.kind !== 'models') {
        throw new TypeError('model catalog unavailable');
      }
      const selected = Math.max(
        0,
        result.models.findIndex((entry) => entry.modelId === selection.modelId),
      );
      this.modal = {
        kind: 'models',
        metadataStatus: result.metadataStatus,
        provider: result.provider,
        query: '',
        currentModelId: selection.modelId,
        catalog: result.models,
        entries: result.models,
        selected,
        top: modelWindowTop(selected, 0, result.models.length),
      };
      this.options.setNotice(undefined);
      this.renderModels();
    } catch {
      this.failCatalog(generation, 'model catalog unavailable');
    }
  }

  async openEfforts(): Promise<void> {
    if (!this.requireSelectionReady('/effort')) return;
    const selection = this.options.selection();
    const sessionId = this.options.sessionId();
    const generation = this.beginLoading('efforts', sessionId);
    try {
      const result = await this.options.client.catalogRead({
        kind: 'efforts',
        provider: selection.provider,
        modelId: selection.modelId,
      });
      if (!this.current(generation)) return;
      if (result.kind !== 'efforts') {
        throw new TypeError('effort catalog unavailable');
      }
      this.modal = {
        kind: 'efforts',
        source: result.source,
        provider: result.provider,
        modelId: result.modelId,
        efforts: result.efforts,
        selected: Math.max(0, result.efforts.indexOf(selection.effort)),
      };
      this.options.setNotice(undefined);
      this.renderEfforts();
    } catch {
      this.failCatalog(generation, 'effort catalog unavailable');
    }
  }

  async openLogin(): Promise<void> {
    const sessionId = this.options.sessionId();
    const generation = this.beginLoading('credentials', sessionId);
    try {
      const [catalog, presence] = await Promise.all([
        this.options.client.catalogRead({ kind: 'credentials' }),
        this.options.client.credentialPresenceRead(),
      ]);
      if (!this.current(generation)) return;
      if (catalog.kind !== 'credentials') {
        throw new TypeError('credential catalog unavailable');
      }
      if (catalog.profiles.length === 0) {
        this.closeWithNotice();
        this.options.retainNotice(
          sessionId,
          `catalog:${generation}`,
          'No credential profiles are available',
        );
        return;
      }
      const provider = this.options.selection().provider;
      const selectedProfile = catalog.profiles.findIndex((profile) =>
        profile.providers.includes(provider)
      );
      this.modal = {
        kind: 'profiles',
        entries: catalog.profiles,
        presence: presence.profiles,
        selected: Math.max(0, selectedProfile),
        top: profileWindowTop(
          Math.max(0, selectedProfile),
          0,
          catalog.profiles.length,
        ),
      };
      this.options.setNotice(undefined);
      this.renderProfiles();
    } catch {
      this.failCatalog(generation, 'credential profile catalog unavailable');
    }
  }

  process(event: InputEvent): void {
    const modal = this.modal;
    if (modal === null) return;
    if (modal.kind === 'chatgpt-operation') {
      if (modal.operation === 'complete' || modal.operation === 'select') return;
      if (event.kind === 'escape' || event.kind === 'ctrl_d') {
        this.cancelPendingChatGPT(modal);
      }
      return;
    }
    if (
      modal.kind === 'saving-credential' || modal.kind === 'saving-selection'
    ) return;
    if (
      event.kind === 'escape' || event.kind === 'ctrl_d'
    ) {
      if (
        modal.kind === 'chatgpt-authorize' || modal.kind === 'chatgpt-callback'
      ) {
        this.closeWithNotice();
        void this.cancelChatGPTAttempt(modal.attempt.attemptId);
        return;
      }
      if (modal.kind === 'chatgpt-models') {
        this.showChatGPTAccounts(modal.state);
        return;
      }
      this.closeWithNotice();
      return;
    }
    if (modal.kind === 'loading') return;
    if (modal.kind === 'chatgpt-authorize') {
      if (event.kind === 'enter') {
        this.modal = {
          kind: 'chatgpt-callback',
          state: modal.state,
          attempt: modal.attempt,
          callbackUrl: '',
        };
        this.renderChatGPTCallback();
      }
      return;
    }
    if (modal.kind === 'chatgpt-callback') {
      this.processChatGPTCallback(modal, event);
      return;
    }
    if (modal.kind === 'chatgpt-accounts') {
      this.processChatGPTAccounts(modal, event);
      return;
    }
    if (modal.kind === 'chatgpt-models') {
      this.processChatGPTModels(modal, event);
      return;
    }
    if (modal.kind === 'credential-input') {
      this.processCredentialInput(modal, event);
      return;
    }
    if (event.kind === 'up' || event.kind === 'down') {
      const direction = event.kind === 'up' ? -1 : 1;
      if (modal.kind === 'providers') {
        this.modal = {
          ...modal,
          selected: wrappedIndex(
            modal.selected,
            modal.entries.length,
            direction,
          ),
        };
        this.renderProviders();
      } else if (modal.kind === 'models') {
        const selected = wrappedIndex(
          modal.selected,
          modal.entries.length,
          direction,
        );
        this.modal = {
          ...modal,
          selected,
          top: modelWindowTop(selected, modal.top, modal.entries.length),
        };
        this.renderModels();
      } else if (modal.kind === 'efforts') {
        this.modal = {
          ...modal,
          selected: wrappedIndex(
            modal.selected,
            modal.efforts.length,
            direction,
          ),
        };
        this.renderEfforts();
      } else if (modal.kind === 'profiles') {
        const selected = wrappedIndex(
          modal.selected,
          modal.entries.length,
          direction,
        );
        this.modal = {
          ...modal,
          selected,
          top: profileWindowTop(selected, modal.top, modal.entries.length),
        };
        this.renderProfiles();
      }
      return;
    }
    if (modal.kind === 'models' && event.kind === 'tab') {
      if (!modal.savingFavorite) void this.toggleFavorite();
      return;
    }
    if (
      modal.kind === 'models' && modal.savingFavorite && event.kind === 'enter'
    ) return;
    if (modal.kind === 'models' && event.kind === 'backspace') {
      this.updateModelQuery([...modal.query].slice(0, -1).join(''));
      return;
    }
    if (
      modal.kind === 'models' &&
      (event.kind === 'printable' || event.kind === 'paste')
    ) {
      if (!event.text.includes('\0')) {
        this.updateModelQuery(`${modal.query}${event.text}`);
      }
      return;
    }
    if (event.kind !== 'enter') return;
    if (modal.kind === 'providers') {
      const entry = modal.entries[modal.selected];
      if (
        entry === undefined ||
        entry.provider === this.options.selection().provider
      ) {
        this.closeWithNotice();
      } else void this.applySelection(entry.defaultSelection);
    } else if (modal.kind === 'models') {
      const entry = modal.entries[modal.selected];
      if (entry !== undefined) {
        void this.applySelection({
          provider: modal.provider,
          modelId: entry.modelId,
          effort: entry.defaultEffort,
        });
      }
    } else if (modal.kind === 'efforts') {
      const effort = modal.efforts[modal.selected];
      if (effort !== undefined) {
        void this.applySelection({ ...this.options.selection(), effort });
      }
    } else if (modal.kind === 'profiles') {
      const profile = modal.entries[modal.selected];
      if (profile !== undefined) {
        if (profile.method === 'chatgpt') {
          void this.openChatGPTAuth();
        } else if (!this.options.canRegisterCredential()) {
          const sessionId = this.options.sessionId();
          this.closeWithNotice();
          this.options.retainNotice(
            sessionId,
            `local:${crypto.randomUUID()}`,
            'REJECTED · credential.register · requires an idle Session; check execution state and retry',
            'REJECTED',
          );
        } else {
          this.modal = {
            kind: 'credential-input',
            authProfile: profile.authProfile,
            value: '',
          };
          this.renderCredentialInput();
        }
      }
    }
  }

  close(): void {
    const modal = this.modal;
    if (
      modal?.kind === 'chatgpt-authorize' || modal?.kind === 'chatgpt-callback'
    ) {
      void this.cancelChatGPTAttempt(modal.attempt.attemptId);
    } else if (
      modal?.kind === 'chatgpt-operation' && modal.operation !== 'complete' &&
      modal.attempt !== undefined
    ) {
      void this.cancelChatGPTAttempt(modal.attempt.attemptId);
    }
    ++this.generation;
    this.modal = null;
    this.options.renderer.clearModal();
    this.options.setNotice(undefined);
  }

  private async requestChatGPT(
    operation: ChatGPTOperation,
  ): Promise<ChatGPTAuthResult> {
    return await this.options.client.chatgptAuth(operation);
  }

  private beginChatGPTOperation(
    operation: Extract<ChatGPTOperation, { kind: string }>['kind'],
    state?: ChatGPTState,
    attempt?: ChatGPTLoginAttempt,
  ): number {
    const generation = ++this.generation;
    this.modal = {
      kind: 'chatgpt-operation',
      operation,
      generation,
      ...(state === undefined ? {} : { state }),
      ...(attempt === undefined ? {} : { attempt }),
    };
    this.options.setNotice(undefined);
    this.options.renderer.renderChoicePicker(
      [
        `ChatGPT ${operation} · waiting for Core`,
        ...(operation === 'complete'
          ? ['Sign-in submitted; waiting for registration to finish.']
          : operation === 'select'
          ? ['Account selection submitted; waiting for Core to finish.']
          : []),
      ],
      operation === 'complete' || operation === 'select' ? [] : ['Esc cancel'],
    );
    return generation;
  }

  private currentChatGPTOperation(generation: number): boolean {
    return this.modal?.kind === 'chatgpt-operation' &&
      this.modal.generation === generation && this.generation === generation;
  }

  private async openChatGPTAuth(): Promise<void> {
    const generation = this.beginChatGPTOperation('status');
    try {
      const result = await this.requestChatGPT({ kind: 'status' });
      if (!this.currentChatGPTOperation(generation)) return;
      if (result.kind === 'rejected') {
        this.closeWithNotice();
        this.retainChatGPTFailure(result.reason);
        return;
      }
      if (result.state.accounts.length === 0) {
        void this.beginChatGPTLogin(undefined, result.state);
      } else {
        this.showChatGPTAccounts(result.state);
      }
    } catch {
      if (!this.currentChatGPTOperation(generation)) return;
      this.closeWithNotice();
      this.retainChatGPTFailure('unavailable');
    }
  }

  private async beginChatGPTLogin(
    registrationId: string | undefined,
    fallbackState: ChatGPTState,
  ): Promise<void> {
    const generation = this.beginChatGPTOperation('begin', fallbackState);
    try {
      const result = await this.requestChatGPT({
        kind: 'begin',
        ...(registrationId === undefined ? {} : { registrationId }),
      });
      if (!this.currentChatGPTOperation(generation)) {
        if (result.kind === 'chatgpt' && result.attempt !== undefined) {
          void this.cancelChatGPTAttempt(result.attempt.attemptId);
        }
        return;
      }
      if (result.kind === 'rejected') {
        this.showChatGPTAccounts(
          fallbackState,
          `ChatGPT sign-in failed · ${result.reason}`,
        );
        this.retainChatGPTFailure(result.reason);
      } else if (result.attempt === undefined) {
        this.showChatGPTAccounts(
          result.state,
          'ChatGPT sign-in failed · missing_attempt',
        );
        this.retainChatGPTFailure('missing_attempt');
      } else {
        this.modal = {
          kind: 'chatgpt-authorize',
          state: result.state,
          attempt: result.attempt,
        };
        this.renderChatGPTAuthorize();
      }
    } catch {
      if (!this.currentChatGPTOperation(generation)) return;
      this.showChatGPTAccounts(
        fallbackState,
        'ChatGPT sign-in failed · unavailable',
      );
      this.retainChatGPTFailure('unavailable');
    }
  }

  private async completeChatGPTLogin(
    modal: Extract<CatalogModal, { kind: 'chatgpt-callback' }>,
  ): Promise<void> {
    const generation = this.beginChatGPTOperation(
      'complete',
      modal.state,
      modal.attempt,
    );
    try {
      const result = await this.requestChatGPT({
        kind: 'complete',
        attemptId: modal.attempt.attemptId,
        callbackUrl: modal.callbackUrl,
      });
      if (!this.currentChatGPTOperation(generation)) return;
      if (result.kind === 'rejected') {
        this.showChatGPTAccounts(
          modal.state,
          `ChatGPT sign-in failed · ${result.reason}`,
        );
        this.retainChatGPTFailure(result.reason);
        return;
      }
      const account = result.state.accounts.find((item) =>
        item.registrationId === modal.attempt.registrationId
      );
      this.showChatGPTAccounts(
        result.state,
        account === undefined
          ? 'Connected ChatGPT account'
          : `Connected account · ${this.chatGPTAccountName(account)}`,
      );
    } catch {
      if (!this.currentChatGPTOperation(generation)) return;
      this.showChatGPTAccounts(
        modal.state,
        'ChatGPT sign-in failed · unavailable',
      );
      this.retainChatGPTFailure('unavailable');
    }
  }

  private async selectChatGPTAccount(
    state: ChatGPTState,
    registrationId: string,
  ): Promise<ChatGPTState | undefined> {
    const generation = this.beginChatGPTOperation('select', state);
    try {
      const result = await this.requestChatGPT({
        kind: 'select',
        registrationId,
      });
      if (!this.currentChatGPTOperation(generation)) return undefined;
      if (result.kind === 'rejected') {
        this.showChatGPTAccounts(
          state,
          `ChatGPT account selection failed · ${result.reason}`,
        );
        this.retainChatGPTFailure(result.reason);
        return undefined;
      }
      this.closeWithNotice();
      this.options.retainNotice(
        this.options.sessionId(),
        `chatgpt-account:${crypto.randomUUID()}`,
        `Selected ChatGPT account · ${
          this.chatGPTAccountName(
            result.state.accounts.find((item) => item.registrationId === registrationId) ??
              {
                registrationId,
                label: registrationId,
                needsReauthentication: false,
              },
          )
        }`,
      );
      return result.state;
    } catch {
      if (!this.currentChatGPTOperation(generation)) return undefined;
      this.showChatGPTAccounts(
        state,
        'ChatGPT account selection failed · unavailable',
      );
      this.retainChatGPTFailure('unavailable');
      return undefined;
    }
  }

  private async openChatGPTModels(
    state: ChatGPTState,
    accountIndex: number,
  ): Promise<void> {
    const account = state.accounts[accountIndex];
    if (account === undefined) {
      this.showChatGPTAccounts(
        state,
        'No connected ChatGPT account is available for models',
      );
      return;
    }
    const sessionId = this.options.sessionId();
    const generation = this.beginLoading('models', sessionId);
    try {
      const result = await this.options.client.catalogRead({
        kind: 'models',
        provider: 'openai-chatgpt',
        registrationId: account.registrationId,
      });
      if (!this.current(generation)) return;
      if (result.kind !== 'models') {
        throw new TypeError('model catalog unavailable');
      }
      this.modal = {
        kind: 'chatgpt-models',
        state,
        accountLabel: this.chatGPTAccountName(account),
        entries: result.models,
        selected: 0,
        top: 0,
      };
      this.options.setNotice(undefined);
      this.renderChatGPTModels();
    } catch (error) {
      this.failCatalog(
        generation,
        error instanceof HenjiApiError
          ? `ChatGPT model catalog unavailable · ${error.message}`
          : 'ChatGPT model catalog unavailable',
      );
    }
  }

  private showChatGPTAccounts(state: ChatGPTState, notice?: string): void {
    const selectedAccount = state.accounts.findIndex((account) =>
      account.registrationId === state.selectedRegistrationId
    );
    this.modal = {
      kind: 'chatgpt-accounts',
      state,
      selected: Math.max(0, selectedAccount),
      ...(notice === undefined ? {} : { notice }),
    };
    this.options.setNotice(undefined);
    this.renderChatGPTAccounts();
  }

  private chatGPTAccountName(
    account: ChatGPTState['accounts'][number],
  ): string {
    const label = account.label || account.registrationId;
    return `${label} · registration ${account.registrationId}`;
  }

  private retainChatGPTFailure(reason: string): void {
    const sessionId = this.options.sessionId();
    this.options.retainNotice(
      sessionId,
      `chatgpt-auth:${crypto.randomUUID()}`,
      `REJECTED · ChatGPT authentication · ${reason}`,
      'REJECTED',
    );
  }

  private async cancelChatGPTAttempt(attemptId: string): Promise<void> {
    try {
      await this.requestChatGPT({ kind: 'cancel', attemptId });
    } catch {
      // Cancellation is best-effort after the TUI has discarded the pending callback.
    }
  }

  private cancelPendingChatGPT(
    modal: Extract<CatalogModal, { kind: 'chatgpt-operation' }>,
  ): void {
    this.closeWithNotice();
    if (modal.attempt !== undefined) {
      void this.cancelChatGPTAttempt(modal.attempt.attemptId);
    }
  }

  private processChatGPTAccounts(
    modal: Extract<CatalogModal, { kind: 'chatgpt-accounts' }>,
    event: InputEvent,
  ): void {
    if (event.kind === 'up' || event.kind === 'down') {
      const selected = wrappedIndex(
        modal.selected,
        modal.state.accounts.length,
        event.kind === 'up' ? -1 : 1,
      );
      this.modal = { ...modal, selected };
      this.renderChatGPTAccounts();
      return;
    }
    if (event.kind === 'enter') {
      const account = modal.state.accounts[modal.selected];
      if (account === undefined) {
        void this.beginChatGPTLogin(undefined, modal.state);
      } else {
        void this.selectChatGPTAccount(modal.state, account.registrationId);
      }
      return;
    }
    if (event.kind !== 'printable' && event.kind !== 'paste') return;
    const shortcut = event.text.toLocaleLowerCase();
    if (shortcut === 'm') {
      void this.openChatGPTModels(modal.state, modal.selected);
    } else if (shortcut === 'a') {
      void this.beginChatGPTLogin(undefined, modal.state);
    } else if (shortcut === 'r') {
      const account = modal.state.accounts[modal.selected];
      if (account !== undefined) {
        void this.beginChatGPTLogin(account.registrationId, modal.state);
      }
    }
  }

  private processChatGPTModels(
    modal: Extract<CatalogModal, { kind: 'chatgpt-models' }>,
    event: InputEvent,
  ): void {
    if (event.kind === 'escape' || event.kind === 'ctrl_d') {
      this.showChatGPTAccounts(modal.state);
    } else if (event.kind === 'up' || event.kind === 'down') {
      const selected = wrappedIndex(
        modal.selected,
        modal.entries.length,
        event.kind === 'up' ? -1 : 1,
      );
      this.modal = {
        ...modal,
        selected,
        top: modelWindowTop(selected, modal.top, modal.entries.length),
      };
      this.renderChatGPTModels();
    } else if (event.kind === 'enter') {
      this.showChatGPTAccounts(modal.state);
    }
  }

  private processChatGPTCallback(
    modal: Extract<CatalogModal, { kind: 'chatgpt-callback' }>,
    event: InputEvent,
  ): void {
    if (event.kind === 'backspace') {
      this.modal = {
        ...modal,
        callbackUrl: [...modal.callbackUrl].slice(0, -1).join(''),
      };
      this.renderChatGPTCallback();
    } else if (event.kind === 'ctrl_u') {
      this.modal = { ...modal, callbackUrl: '' };
      this.renderChatGPTCallback();
    } else if (event.kind === 'printable' || event.kind === 'paste') {
      if (!event.text.includes('\0')) {
        this.modal = {
          ...modal,
          callbackUrl: `${modal.callbackUrl}${event.text}`,
        };
        this.renderChatGPTCallback();
      }
    } else if (event.kind === 'enter') {
      void this.completeChatGPTLogin(modal);
    }
  }

  private requireSelectionReady(command: string): boolean {
    if (this.options.canChangeSelection()) return true;
    this.options.setNotice(
      command === '/login'
        ? 'busy; /login registers credentials when idle'
        : `busy; ${command} waits for ready`,
    );
    const sessionId = this.options.sessionId();
    const operation = command === '/provider'
      ? 'provider selection'
      : command === '/model'
      ? 'model selection'
      : 'effort selection';
    this.options.retainNotice(
      sessionId,
      `local:${crypto.randomUUID()}`,
      `REJECTED · ${operation} · requires a ready active Session; check execution state and retry`,
      'REJECTED',
    );
    return false;
  }

  private beginLoading(
    kind: 'providers' | 'models' | 'efforts' | 'credentials',
    sessionId: string,
  ): number {
    const generation = ++this.generation;
    this.modal = {
      kind: 'loading',
      title: catalogTitle(kind),
      generation,
      sessionId,
    };
    this.options.setNotice(undefined);
    this.options.renderer.renderChoicePicker([
      this.modal.title,
      'Esc cancels',
    ], ['Esc cancel']);
    return generation;
  }

  private current(generation: number): boolean {
    return this.generation === generation && this.modal?.kind === 'loading' &&
      this.modal.generation === generation;
  }

  private failCatalog(generation: number, notice: string): void {
    if (!this.current(generation)) return;
    const loading = this.modal;
    if (loading?.kind !== 'loading') return;
    this.modal = null;
    this.options.renderer.clearModal();
    this.options.setNotice(undefined);
    this.options.retainNotice(
      loading.sessionId,
      `catalog:${generation}`,
      `FAILED · ${notice}`,
      'FAILED',
    );
  }

  private closeWithNotice(notice?: string): void {
    ++this.generation;
    this.modal = null;
    this.options.renderer.clearModal();
    this.options.setNotice(notice);
  }

  private async applySelection(selection: ApiSelection): Promise<void> {
    const sessionId = this.options.sessionId();
    const commandId = crypto.randomUUID();
    this.modal = { kind: 'saving-selection' };
    this.options.renderer.renderChoicePicker([
      'saving provider/model selection',
    ], ['saving']);
    try {
      const command = await runSelectionCommand(
        this.options.client,
        sessionId,
        selection,
        commandId,
      );
      if (this.modal?.kind !== 'saving-selection') return;
      if (command.kind === 'rejected') {
        this.closeWithNotice();
        this.options.retainNotice(
          sessionId,
          commandId,
          `REJECTED · provider/model selection · ${command.reason}`,
          'REJECTED',
        );
        return;
      }
      const effective = acceptedSelection(command);
      if (effective === undefined) {
        this.closeWithNotice();
        this.options.retainNotice(
          sessionId,
          commandId,
          'UNCONFIRMED · provider/model selection · check the active selection before retrying',
          'UNCONFIRMED',
        );
        return;
      }
      this.options.selectionChanged(effective);
      this.closeWithNotice();
    } catch {
      if (this.modal?.kind === 'saving-selection') {
        this.closeWithNotice();
        this.options.retainNotice(
          sessionId,
          commandId,
          'UNCONFIRMED · provider/model selection · response unavailable · check the active selection before retrying',
          'UNCONFIRMED',
        );
      }
    }
  }

  private updateModelQuery(query: string): void {
    const modal = this.modal;
    if (modal?.kind !== 'models') return;
    const normalized = query.toLocaleLowerCase();
    const entries = normalized.length === 0
      ? modal.catalog
      : modal.catalog.filter((entry) =>
        entry.modelId.toLocaleLowerCase().includes(normalized) ||
        entry.name?.toLocaleLowerCase().includes(normalized)
      );
    const current = entries.findIndex((entry) => entry.modelId === modal.currentModelId);
    const selected = current < 0 ? 0 : current;
    this.modal = {
      ...modal,
      query,
      entries,
      selected,
      top: modelWindowTop(selected, 0, entries.length),
    };
    this.renderModels();
  }

  private async toggleFavorite(): Promise<void> {
    const modal = this.modal;
    if (modal?.kind !== 'models') return;
    const entry = modal.entries[modal.selected];
    if (entry === undefined) return;
    const generation = this.generation;
    const sessionId = this.options.sessionId();
    const identity = `favorite:${crypto.randomUUID()}`;
    this.modal = { ...modal, savingFavorite: true };
    this.renderModels();
    try {
      const result = await this.options.client.modelFavorite({
        provider: modal.provider,
        modelId: entry.modelId,
        favorite: !entry.favorite,
      });
      const current = this.modal;
      if (generation !== this.generation || current?.kind !== 'models') return;
      const query = current.query.toLocaleLowerCase();
      const entries = result.models.filter((item) =>
        item.modelId.toLocaleLowerCase().includes(query) ||
        item.name?.toLocaleLowerCase().includes(query)
      );
      const selected = Math.max(
        0,
        entries.findIndex((item) => item.modelId === entry.modelId),
      );
      this.modal = {
        ...current,
        catalog: result.models,
        entries,
        selected,
        savingFavorite: false,
        top: modelWindowTop(selected, current.top, entries.length),
      };
      this.options.setNotice(undefined);
      this.renderModels();
    } catch {
      if (generation !== this.generation || this.modal?.kind !== 'models') {
        return;
      }
      this.modal = { ...this.modal, savingFavorite: false };
      this.options.retainNotice(
        sessionId,
        identity,
        `FAILED · model favorite · ${entry.modelId} · save failed`,
        'FAILED',
      );
      this.renderModels();
    }
  }

  private renderProviders(): void {
    const modal = this.modal;
    if (modal?.kind !== 'providers') return;
    this.options.renderer.renderChoicePicker([
      'provider picker · Up/Down select · Enter choose · Esc cancel',
      ...modal.entries.map((entry, index) =>
        `${
          index === modal.selected ? '>' : ' '
        } ${entry.provider} · default ${entry.defaultSelection.modelId} · ${entry.defaultSelection.effort}`
      ),
    ], ['↑/↓ select', 'Enter choose', 'Esc cancel']);
  }

  private renderModels(): void {
    const modal = this.modal;
    if (modal?.kind !== 'models') return;
    const visible = modal.entries.slice(modal.top, modal.top + 10);
    const window = modal.entries.length > visible.length
      ? ` · ${modal.top + 1}-${modal.top + visible.length} of ${modal.entries.length}`
      : '';
    const lines = [
      `model picker · ${modal.provider} · ${modal.entries.length} matches${window}`,
      'Up/Down move · Enter choose · Tab favorite · Esc cancel',
      `search> ${modal.query}`,
      ...(modal.metadataStatus === 'unavailable'
        ? ['effort metadata unavailable · using saved catalog']
        : []),
      ...(modal.savingFavorite ? ['saving favorite'] : []),
      ...visible.map((entry, offset) => {
        const index = modal.top + offset;
        return `${index === modal.selected ? '>' : ' '} ${
          entry.favorite ? '*' : ' '
        } ${entry.modelId}${
          entry.modelId === modal.currentModelId ? ' (current)' : ''
        } · ${entry.defaultEffort}${entry.name === undefined ? '' : ` · ${entry.name}`}`;
      }),
    ];
    if (modal.entries.length === 0) lines.push('no matching models');
    this.options.renderer.renderChoicePicker(lines, [
      'type search',
      '↑/↓ select',
      ...(modal.savingFavorite ? [] : ['Enter choose', 'Tab favorite']),
      'Esc cancel',
    ]);
  }

  private renderEfforts(): void {
    const modal = this.modal;
    if (modal?.kind !== 'efforts') return;
    this.options.renderer.renderChoicePicker([
      `effort picker · ${modal.provider} · ${modal.modelId} · Up/Down select · Enter choose · Esc cancel`,
      ...(modal.source === 'catalog'
        ? ['models.dev unavailable · saved catalog']
        : modal.source === 'unknown'
        ? ['effort metadata unavailable for this model']
        : []),
      ...modal.efforts.map((effort, index) => `${index === modal.selected ? '>' : ' '} ${effort}`),
    ], ['↑/↓ select', 'Enter choose', 'Esc cancel']);
  }

  private renderProfiles(): void {
    const modal = this.modal;
    if (modal?.kind !== 'profiles') return;
    this.options.renderer.renderChoicePicker([
      'credential registration · Up/Down select · Enter edit · Esc cancel',
      ...modal.entries.slice(modal.top, modal.top + 10).map(
        (profile, offset) => {
          const index = modal.top + offset;
          const presence = profilePresence(modal.presence, profile.authProfile);
          const label = profile.label ?? profile.authProfile;
          const details = profile.method === 'chatgpt'
            ? ''
            : ` · ${profile.providers.join(', ')} · ${presence?.status ?? 'unknown'}`;
          return `${index === modal.selected ? '>' : ' '} ${label}${details}`;
        },
      ),
    ], ['↑/↓ select', 'Enter edit', 'Esc cancel']);
  }

  private renderChatGPTAccounts(): void {
    const modal = this.modal;
    if (modal?.kind !== 'chatgpt-accounts') return;
    const lines = [
      'ChatGPT accounts · Up/Down select · Enter choose and close',
      ...(modal.notice === undefined ? [] : [modal.notice]),
      ...(modal.state.accounts.length === 0
        ? ['No connected ChatGPT accounts']
        : modal.state.accounts.map((account, index) =>
          `${index === modal.selected ? '>' : ' '} ${this.chatGPTAccountName(account)}${
            account.registrationId === modal.state.selectedRegistrationId ? ' · selected' : ''
          }${account.needsReauthentication ? ' · reauthentication needed' : ''}`
        )),
    ];
    this.options.renderer.renderChoicePicker(lines, [
      ...(modal.state.accounts.length === 0 ? ['Enter sign in'] : ['Enter select and close']),
      'a add account',
      ...(modal.state.accounts.length === 0 ? [] : ['r reauthenticate selected']),
      'm models',
      'Esc close',
    ]);
  }

  private renderChatGPTAuthorize(): void {
    const modal = this.modal;
    if (modal?.kind !== 'chatgpt-authorize') return;
    this.options.renderer.renderChoicePicker([
      'Sign in with ChatGPT',
      'Open this URL in a browser outside the VM and approve access:',
      modal.attempt.authorizationUrl,
      'After approval, copy the full callback URL from the browser address bar.',
      'Press Enter to paste the callback URL · Esc cancels sign-in',
    ], ['Enter paste callback URL', 'Esc cancel sign-in']);
  }

  private renderChatGPTCallback(): void {
    const modal = this.modal;
    if (modal?.kind !== 'chatgpt-callback') return;
    const masked = '*'.repeat([...modal.callbackUrl].length);
    this.options.renderer.renderChoicePicker([
      'Sign in with ChatGPT · paste the full callback URL from the browser address bar',
      'callback URL> ' + masked,
      'The callback URL is hidden while you type or paste it.',
      'Enter complete sign-in · Ctrl-U clear · Esc cancel sign-in',
    ], ['Enter complete sign-in', 'Ctrl-U clear', 'Esc cancel sign-in']);
  }

  private renderChatGPTModels(): void {
    const modal = this.modal;
    if (modal?.kind !== 'chatgpt-models') return;
    const visible = modal.entries.slice(modal.top, modal.top + 10);
    const window = modal.entries.length > visible.length
      ? ` · ${modal.top + 1}-${modal.top + visible.length} of ${modal.entries.length}`
      : '';
    const lines = [
      `ChatGPT models · ${modal.accountLabel} · read only${window}`,
      'Up/Down browse · Enter or Esc return to accounts',
      ...visible.map((entry, offset) =>
        `${modal.top + offset === modal.selected ? '>' : ' '} ${entry.modelId}${
          entry.name === undefined ? '' : ` · ${entry.name}`
        }`
      ),
    ];
    if (modal.entries.length === 0) {
      lines.push('No ChatGPT models are available');
    }
    this.options.renderer.renderChoicePicker(lines, [
      '↑/↓ browse',
      'Enter return to accounts',
      'Esc return to accounts',
    ]);
  }

  private renderCredentialInput(): void {
    const modal = this.modal;
    if (modal?.kind !== 'credential-input') return;
    const masked = '*'.repeat([...modal.value].length);
    this.options.renderer.renderChoicePicker([
      `credential input · ${modal.authProfile} · type or paste the key · Enter save · Esc cancel`,
      ...(modal.notice === undefined ? [] : [modal.notice]),
      `key> ${masked}`,
    ], ['Enter save', 'Ctrl-U clear', 'Esc cancel']);
  }

  private processCredentialInput(
    modal: Extract<CatalogModal, { kind: 'credential-input' }>,
    event: InputEvent,
  ): void {
    if (event.kind === 'backspace') {
      this.modal = { ...modal, value: [...modal.value].slice(0, -1).join('') };
      this.renderCredentialInput();
    } else if (event.kind === 'ctrl_u') {
      this.modal = { ...modal, value: '' };
      this.renderCredentialInput();
    } else if (event.kind === 'printable' || event.kind === 'paste') {
      if (!event.text.includes('\0')) {
        this.modal = { ...modal, value: `${modal.value}${event.text}` };
        this.renderCredentialInput();
      }
    } else if (event.kind === 'enter') {
      void this.saveCredential(modal.authProfile, modal.value);
    }
  }

  private async saveCredential(
    authProfile: string,
    value: string,
  ): Promise<void> {
    const sessionId = this.options.sessionId();
    const identity = `credential:${crypto.randomUUID()}`;
    this.modal = { kind: 'saving-credential', authProfile };
    this.options.renderer.renderChoicePicker([
      `saving credential · ${authProfile}`,
    ], ['saving']);
    let result: CredentialRegisterResult;
    try {
      result = await this.options.client.credentialRegister({
        authProfile,
        value,
      });
    } catch {
      result = { kind: 'rejected', reason: 'failed' };
    }
    if (this.modal?.kind !== 'saving-credential') return;
    if (result.kind === 'rejected') {
      const reason = result.reason === 'busy'
        ? 'credential registration requires an idle Session'
        : result.reason === 'invalid'
        ? 'credential registration rejected'
        : 'credential save failed';
      this.modal = {
        kind: 'credential-input',
        authProfile,
        value,
        notice: reason,
      };
      this.options.retainNotice(
        sessionId,
        identity,
        `REJECTED · credential.register · ${authProfile} · ${result.reason}`,
        'REJECTED',
      );
      this.renderCredentialInput();
      return;
    }
    this.modal = null;
    this.options.renderer.clearModal();
    try {
      const presence = await this.options.client.credentialPresenceRead();
      const profile = profilePresence(presence.profiles, authProfile);
      this.options.retainNotice(
        sessionId,
        identity,
        `Credential saved for ${authProfile} · ${profile?.status ?? result.status}`,
      );
    } catch {
      this.options.retainNotice(
        sessionId,
        identity,
        `Credential saved for ${authProfile} · presence refresh unavailable`,
      );
    }
  }
}
