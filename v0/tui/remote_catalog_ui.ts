import type {
  ApiSelection,
  CatalogReadResult,
  CredentialPresenceReadResult,
  CredentialRegisterResult,
  SelectionChangeValue,
} from '../api/contract.ts';
import { HenjiApiClient } from '../api/client.ts';
import type { CommandResult, CoreCommandValue } from '../api/contract.ts';
import type { InputEvent } from './input.ts';
import type { TuiEditor } from './input.ts';
import { WorkspacePathIndex } from './file_reference.ts';
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

type CatalogModal =
  | {
    readonly kind: 'loading';
    readonly title: string;
    readonly generation: number;
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
    readonly entries: readonly ProfileChoice[];
    readonly presence: CredentialPresenceReadResult['profiles'];
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
    | 'pathRead'
  >;
  readonly renderer: Pick<
    TuiRenderer,
    'renderChoicePicker' | 'clearModal' | 'setEditorSnapshot'
  >;
  readonly sessionId: () => string;
  readonly selection: () => ApiSelection;
  readonly selectionChanged: (selection: ApiSelection) => void;
  readonly canChangeSelection: () => boolean;
  readonly canRegisterCredential: () => boolean;
  readonly setNotice: (notice?: string) => void;
  readonly credentialPresenceRead: (
    result: CredentialPresenceReadResult,
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
): Promise<CommandResult<CoreCommandValue>> => {
  const commandId = crypto.randomUUID();
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

/** Core-backed selection, credential, and workspace completion interactions for the remote TUI. */
export class RemoteCatalogUi {
  private modal: CatalogModal | null = null;
  private generation = 0;
  private pathIndex: WorkspacePathIndex | undefined;
  private pathIndexRead: Promise<WorkspacePathIndex> | undefined;

  constructor(private readonly options: RemoteCatalogUiOptions) {}

  get isOpen(): boolean {
    return this.modal !== null;
  }

  async openProviders(): Promise<void> {
    if (!this.requireSelectionReady('/provider')) return;
    const generation = this.beginLoading('providers');
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
    const generation = this.beginLoading('models');
    try {
      const result = await this.options.client.catalogRead({
        kind: 'models',
        provider: selection.provider,
        sessionId: this.options.sessionId(),
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
    const generation = this.beginLoading('efforts');
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
    if (!this.options.canRegisterCredential()) {
      this.options.setNotice('busy; /login registers credentials when idle');
      return;
    }
    const generation = this.beginLoading('credentials');
    try {
      const [catalog, presence] = await Promise.all([
        this.options.client.catalogRead({ kind: 'credentials' }),
        this.options.client.credentialPresenceRead(),
      ]);
      if (!this.current(generation)) return;
      if (catalog.kind !== 'credentials') {
        throw new TypeError('credential catalog unavailable');
      }
      this.options.credentialPresenceRead(presence);
      if (catalog.profiles.length === 0) {
        this.closeWithNotice('no credential profiles are available');
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

  async completePath(editor: TuiEditor): Promise<void> {
    const original = editor.snapshot();
    const generation = ++this.generation;
    this.options.setNotice('reading Core workspace paths');
    let index: WorkspacePathIndex;
    try {
      index = await this.readPathIndex();
    } catch {
      if (this.generation === generation) {
        this.options.setNotice('path index unavailable');
      }
      return;
    }
    if (this.generation !== generation) return;
    if (
      editor.text !== original.text ||
      editor.cursorScalar !== original.cursorScalar
    ) {
      this.options.setNotice(
        'draft changed while reading Core workspace paths',
      );
      return;
    }
    const completion = remotePathCompletionAtCursor(
      editor.text,
      editor.cursorScalar,
      index,
    );
    if (completion.kind === 'inserted') {
      if (
        !editor.setSnapshot({
          text: completion.text,
          cursorScalar: completion.cursorScalar,
          byteLength: new TextEncoder().encode(completion.text).byteLength,
        })
      ) {
        this.options.setNotice('path replacement too long');
      } else {
        this.options.renderer.setEditorSnapshot(editor.snapshot());
        this.options.setNotice(undefined);
      }
      return;
    }
    this.options.setNotice(
      completion.kind === 'ambiguous'
        ? `path match ambiguous (${completion.count})`
        : completion.kind === 'incomplete'
        ? 'path index unavailable'
        : 'no path match',
    );
  }

  private async readPathIndex(): Promise<WorkspacePathIndex> {
    if (this.pathIndex !== undefined) return this.pathIndex;
    if (this.pathIndexRead !== undefined) return await this.pathIndexRead;
    const operation = this.options.client.pathRead().then((result) =>
      result.complete
        ? WorkspacePathIndex.fromCandidates(result.paths)
        : WorkspacePathIndex.incomplete()
    );
    this.pathIndexRead = operation;
    try {
      const index = await operation;
      this.pathIndex = index;
      return index;
    } finally {
      if (this.pathIndexRead === operation) this.pathIndexRead = undefined;
    }
  }

  process(event: InputEvent): void {
    const modal = this.modal;
    if (modal === null) return;
    if (
      modal.kind === 'saving-credential' || modal.kind === 'saving-selection'
    ) return;
    if (
      event.kind === 'escape' || event.kind === 'ctrl_c' ||
      event.kind === 'ctrl_d'
    ) {
      this.closeWithNotice();
      return;
    }
    if (modal.kind === 'loading') return;
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
        this.modal = {
          kind: 'credential-input',
          authProfile: profile.authProfile,
          value: '',
        };
        this.renderCredentialInput();
      }
    }
  }

  close(): void {
    ++this.generation;
    this.modal = null;
    this.options.renderer.clearModal();
    this.options.setNotice(undefined);
  }

  private requireSelectionReady(command: string): boolean {
    if (this.options.canChangeSelection()) return true;
    this.options.setNotice(
      command === '/login'
        ? 'busy; /login registers credentials when idle'
        : `busy; ${command} waits for ready`,
    );
    return false;
  }

  private beginLoading(
    kind: 'providers' | 'models' | 'efforts' | 'credentials',
  ): number {
    const generation = ++this.generation;
    this.modal = { kind: 'loading', title: catalogTitle(kind), generation };
    this.options.setNotice(this.modal.title);
    if (kind !== 'models') {
      this.options.renderer.renderChoicePicker([
        this.modal.title,
        'Esc cancels',
      ]);
    }
    return generation;
  }

  private current(generation: number): boolean {
    return this.generation === generation && this.modal?.kind === 'loading' &&
      this.modal.generation === generation;
  }

  private failCatalog(generation: number, notice: string): void {
    if (!this.current(generation)) return;
    this.modal = null;
    this.options.renderer.clearModal();
    this.options.setNotice(notice);
  }

  private closeWithNotice(notice?: string): void {
    ++this.generation;
    this.modal = null;
    this.options.renderer.clearModal();
    this.options.setNotice(notice);
  }

  private async applySelection(selection: ApiSelection): Promise<void> {
    this.modal = { kind: 'saving-selection' };
    this.options.renderer.renderChoicePicker([
      'saving provider/model selection',
    ]);
    try {
      const command = await runSelectionCommand(
        this.options.client,
        this.options.sessionId(),
        selection,
      );
      if (this.modal?.kind !== 'saving-selection') return;
      if (command.kind === 'rejected') {
        this.closeWithNotice(
          command.reason === 'busy'
            ? 'provider/model selection requires an idle active Session'
            : `provider/model selection rejected: ${command.reason}`,
        );
        return;
      }
      const effective = acceptedSelection(command);
      if (effective === undefined) {
        this.closeWithNotice('provider/model selection unconfirmed');
        return;
      }
      this.options.selectionChanged(effective);
      this.closeWithNotice(
        `selection ${effective.provider} · ${effective.modelId} · effort ${effective.effort}`,
      );
    } catch {
      if (this.modal?.kind === 'saving-selection') {
        this.closeWithNotice('provider/model selection response unknown');
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
      this.options.setNotice('favorite save failed');
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
    ]);
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
    this.options.renderer.renderChoicePicker(lines);
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
    ]);
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
          return `${index === modal.selected ? '>' : ' '} ${profile.authProfile} · ${
            profile.providers.join(', ')
          } · ${presence?.status ?? 'unknown'}`;
        },
      ),
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
    ]);
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
    this.modal = { kind: 'saving-credential', authProfile };
    this.options.renderer.renderChoicePicker([
      `saving credential · ${authProfile}`,
    ]);
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
      this.modal = {
        kind: 'credential-input',
        authProfile,
        value,
        notice: result.reason === 'busy'
          ? 'credential registration requires an idle Session'
          : result.reason === 'invalid'
          ? 'credential registration rejected'
          : 'credential save failed',
      };
      this.renderCredentialInput();
      return;
    }
    this.modal = null;
    this.options.renderer.clearModal();
    try {
      const presence = await this.options.client.credentialPresenceRead();
      this.options.credentialPresenceRead(presence);
      const profile = profilePresence(presence.profiles, authProfile);
      this.options.setNotice(
        `credential saved: ${authProfile} · ${profile?.status ?? result.status}`,
      );
    } catch {
      this.options.setNotice(
        `credential saved: ${authProfile} · presence refresh unavailable`,
      );
    }
  }
}

export type RemotePathCompletion =
  | {
    readonly kind: 'inserted';
    readonly text: string;
    readonly cursorScalar: number;
  }
  | { readonly kind: 'ambiguous'; readonly count: number }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'none' };

/** Apply Core-supplied path candidates to the same token/cursor range as the local editor. */
export const remotePathCompletionAtCursor = (
  text: string,
  cursorScalar: number,
  index: WorkspacePathIndex,
): RemotePathCompletion => {
  const points = [...text];
  let start = cursorScalar;
  while (start > 0 && !/[ \t\n]/u.test(points[start - 1])) start -= 1;
  const fragment = points.slice(start, cursorScalar).join('');
  const completion = index.completePath(fragment);
  if (completion.kind !== 'inserted') return completion;
  points.splice(start, cursorScalar - start, ...[...completion.text]);
  return {
    kind: 'inserted',
    text: points.join(''),
    cursorScalar: start + [...completion.text].length,
  };
};
