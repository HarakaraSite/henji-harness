import type { EffortCatalogResult, ModelCatalogResult } from '../../api/contract.ts';
import { credentialFileFor, parseCredentialBytes } from './credential_file.ts';
import {
  ChatGPTAuthError,
  type ChatGPTAuthService,
  createChatGPTAuthService,
} from './chatgpt_auth.ts';
import { isReasoningEffort, type ReasoningEffort } from './model_selection.ts';
import type { ProviderDeclarationV1 } from './provider_declaration.ts';
import { substituteRequestHeaders, usesCredentialHeader } from './provider_request_headers.ts';

const DEFAULT_METADATA_URL = 'https://models.dev/api.json';
const CATALOG_DIRECTORY = 'model-catalogs';

export type LiveModelCatalogFact = Readonly<{
  provider: string;
  api: 'models' | 'models.dev';
  requestOrder: number;
  occurredAt: string;
  httpStatus?: number;
  error?: string;
  field?: string;
  valueShape?: string;
}>;

type LiveModelCatalogErrorCode =
  | 'unknown_provider'
  | 'credential_unavailable'
  | 'models_unavailable'
  | 'models_response_invalid'
  | 'catalog_read_failed'
  | 'catalog_write_failed'
  | 'models_not_loaded';

export class LiveModelCatalogError extends Error {
  constructor(
    readonly code: LiveModelCatalogErrorCode,
    readonly authCode?: string,
  ) {
    super(code);
    this.name = 'LiveModelCatalogError';
  }
}

interface LiveModelCatalogOptions {
  readonly configRoot: string;
  /** Credential root shared with the request-time reader; kept separate from the config root. */
  readonly credentialRoot: string;
  readonly declarations: readonly ProviderDeclarationV1[];
  readonly metadataUrl?: string;
  readonly fetcher?: typeof fetch;
  /** Shared Core auth service; omitted callers use the same persisted auth module locally. */
  readonly chatgptAuth?: ChatGPTAuthService;
}

interface CatalogModel {
  defaultEffort?: ReasoningEffort;
  efforts?: ReasoningEffort[];
}

interface StoredCatalog {
  favorites: string[];
  models: Record<string, CatalogModel>;
}

interface ProviderModel {
  readonly modelId: string;
  readonly name?: string;
  readonly created?: number;
}

const withPinnedModels = (
  declaration: ProviderDeclarationV1,
  models: readonly ProviderModel[],
): readonly ProviderModel[] => {
  const listed = new Set(models.map((model) => model.modelId));
  return [
    ...models,
    ...declaration.modelCatalog.entries
      .filter((entry) => entry.pinned && !listed.has(entry.modelId))
      .map(({ modelId }) => ({ modelId })),
  ];
};

interface MetadataSnapshot {
  readonly status: 'loaded' | 'unavailable';
  readonly models: ReadonlyMap<string, readonly ReasoningEffort[]>;
}

interface ModelSnapshot {
  readonly models: readonly ProviderModel[];
  readonly metadata: MetadataSnapshot;
}

interface FactContext {
  readonly requestOrder: number;
  readonly occurredAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const valueShape = (value: unknown): string => {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === 'string') return `string(length=${value.length})`;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? 'number' : 'nonfinite_number';
  }
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
};

const uniqueEfforts = (
  values: readonly ReasoningEffort[],
): ReasoningEffort[] => {
  const result: ReasoningEffort[] = ['auto'];
  for (const value of values) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
};

const mapMetadataEffort = (value: unknown): ReasoningEffort | undefined => {
  if (value === null || value === 'default') return 'auto';
  return isReasoningEffort(value) ? value : undefined;
};

const parseMetadataSnapshot = (
  providerId: string,
  value: unknown,
  addFact: (
    fact: Omit<
      LiveModelCatalogFact,
      'provider' | 'api' | 'requestOrder' | 'occurredAt'
    >,
  ) => void,
): MetadataSnapshot => {
  if (!isRecord(value)) {
    addFact({
      error: 'response_parse_failed',
      field: '$',
      valueShape: valueShape(value),
    });
    return { status: 'unavailable', models: new Map() };
  }
  const provider = value[providerId];
  if (!isRecord(provider) || !isRecord(provider.models)) {
    return { status: 'loaded', models: new Map() };
  }

  const models = new Map<string, readonly ReasoningEffort[]>();
  for (const [modelId, rawModel] of Object.entries(provider.models)) {
    if (!isRecord(rawModel) || !Object.hasOwn(rawModel, 'reasoning_options')) {
      continue;
    }
    const options = rawModel.reasoning_options;
    if (!Array.isArray(options)) {
      addFact({
        error: 'response_parse_failed',
        field: `${providerId}.models.${modelId}.reasoning_options`,
        valueShape: valueShape(options),
      });
      continue;
    }
    const efforts: ReasoningEffort[] = [];
    let foundEffortOption = false;
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option = options[optionIndex];
      if (!isRecord(option) || option.type !== 'effort') continue;
      foundEffortOption = true;
      const values = option.values;
      if (Array.isArray(values)) {
        for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
          const mapped = mapMetadataEffort(values[valueIndex]);
          if (mapped !== undefined) efforts.push(mapped);
          else {
            addFact({
              error: 'unsupported_effort_value',
              field:
                `${providerId}.models.${modelId}.reasoning_options[${optionIndex}].values[${valueIndex}]`,
              valueShape: valueShape(values[valueIndex]),
            });
          }
        }
      } else if (values === null) {
        efforts.push('auto');
      } else {
        addFact({
          error: 'response_parse_failed',
          field: `${providerId}.models.${modelId}.reasoning_options[${optionIndex}].values`,
          valueShape: valueShape(values),
        });
      }
      if (Object.hasOwn(option, 'default')) {
        const mappedDefault = mapMetadataEffort(option.default);
        if (mappedDefault !== undefined) efforts.push(mappedDefault);
        else if (option.default !== undefined) {
          addFact({
            error: 'unsupported_effort_value',
            field: `${providerId}.models.${modelId}.reasoning_options[${optionIndex}].default`,
            valueShape: valueShape(option.default),
          });
        }
      }
    }
    if (foundEffortOption) {
      models.set(modelId, Object.freeze(uniqueEfforts(efforts)));
    }
  }
  return { status: 'loaded', models };
};

const validateStoredCatalog = (value: unknown): StoredCatalog => {
  if (
    !isRecord(value) || !Array.isArray(value.favorites) ||
    !isRecord(value.models)
  ) {
    throw new LiveModelCatalogError('catalog_read_failed');
  }
  if (!value.favorites.every((modelId) => typeof modelId === 'string')) {
    throw new LiveModelCatalogError('catalog_read_failed');
  }
  const models: Record<string, CatalogModel> = {};
  for (const [modelId, rawModel] of Object.entries(value.models)) {
    if (!isRecord(rawModel)) {
      throw new LiveModelCatalogError('catalog_read_failed');
    }
    const model: CatalogModel = {};
    if (rawModel.defaultEffort !== undefined) {
      if (!isReasoningEffort(rawModel.defaultEffort)) {
        throw new LiveModelCatalogError('catalog_read_failed');
      }
      model.defaultEffort = rawModel.defaultEffort;
    }
    if (rawModel.efforts !== undefined) {
      if (
        !Array.isArray(rawModel.efforts) ||
        !rawModel.efforts.every(isReasoningEffort)
      ) {
        throw new LiveModelCatalogError('catalog_read_failed');
      }
      model.efforts = [...rawModel.efforts];
    }
    models[modelId] = model;
  }
  return { favorites: [...value.favorites], models };
};

const sortedModels = (
  models: readonly ProviderModel[],
  favorites: ReadonlySet<string>,
): ProviderModel[] =>
  models.map((model, index) => ({ model, index })).sort((left, right) => {
    const favoriteOrder = Number(favorites.has(right.model.modelId)) -
      Number(favorites.has(left.model.modelId));
    if (favoriteOrder !== 0) return favoriteOrder;
    const leftCreated = left.model.created;
    const rightCreated = right.model.created;
    if (
      leftCreated !== undefined && rightCreated !== undefined &&
      leftCreated !== rightCreated
    ) {
      return rightCreated - leftCreated;
    }
    if (leftCreated !== undefined && rightCreated === undefined) return -1;
    if (leftCreated === undefined && rightCreated !== undefined) return 1;
    return left.index - right.index;
  }).map(({ model }) => model);

export class LiveModelCatalog {
  readonly #configRoot: string;
  readonly #credentialRoot: string;
  readonly #declarations: readonly ProviderDeclarationV1[];
  readonly #metadataUrl?: string;
  readonly #fetcher: typeof fetch;
  readonly #chatgptAuth: ChatGPTAuthService;
  readonly #requestCancellation = new AbortController();
  readonly #snapshots = new Map<string, ModelSnapshot>();
  readonly #requestFacts: LiveModelCatalogFact[] = [];
  #nextRequestOrder = 0;

  constructor(options: LiveModelCatalogOptions) {
    this.#configRoot = options.configRoot;
    this.#credentialRoot = options.credentialRoot;
    this.#declarations = options.declarations;
    this.#metadataUrl = options.metadataUrl;
    this.#fetcher = options.fetcher ?? fetch;
    this.#chatgptAuth = options.chatgptAuth ?? createChatGPTAuthService({
      credentialRoot: options.credentialRoot,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
  }

  get facts(): readonly LiveModelCatalogFact[] {
    return Object.freeze([...this.#requestFacts]);
  }

  /** Stop catalog HTTP requests and response-body reads before Core drains its operations. */
  close(): void {
    this.#requestCancellation.abort();
  }

  async models(
    provider: string,
    sessionId?: string,
    registrationId?: string,
  ): Promise<ModelCatalogResult> {
    const declaration = this.#declaration(provider);
    if (declaration.modelListSource === 'catalog') {
      const snapshot = this.#declaredSnapshot(declaration);
      const catalog = await this.#readCatalog(declaration);
      this.#snapshots.set(provider, snapshot);
      return this.#compose(declaration, snapshot, catalog);
    }
    if (provider === 'openai-chatgpt') {
      let credential: Awaited<ReturnType<ChatGPTAuthService['resolve']>>;
      try {
        credential = await this.#chatgptAuth.resolve(registrationId);
      } catch (error) {
        const authCode = error instanceof ChatGPTAuthError ? error.code : undefined;
        this.#recordFact(provider, 'models', {
          error: authCode ?? 'credential_unavailable',
        });
        throw new LiveModelCatalogError('credential_unavailable', authCode);
      }
      const [providerResult, metadataResult, catalogResult] = await Promise.allSettled([
        this.#fetchChatGPTModels(declaration, credential.accessToken),
        this.#fetchMetadata(declaration),
        this.#readCatalog(declaration, credential.registrationId),
      ]);
      if (catalogResult.status === 'rejected') {
        throw catalogResult.reason instanceof LiveModelCatalogError
          ? catalogResult.reason
          : new LiveModelCatalogError('catalog_read_failed');
      }
      if (providerResult.status === 'rejected') {
        throw providerResult.reason instanceof LiveModelCatalogError
          ? providerResult.reason
          : new LiveModelCatalogError('models_unavailable');
      }
      const metadata = metadataResult.status === 'fulfilled'
        ? metadataResult.value
        : { status: 'unavailable' as const, models: new Map() };
      const snapshot = { models: withPinnedModels(declaration, providerResult.value), metadata };
      this.#snapshots.set(this.#snapshotKey(provider, credential.registrationId), snapshot);
      return this.#compose(declaration, snapshot, catalogResult.value);
    }
    const [providerResult, metadataResult, catalogResult] = await Promise
      .allSettled([
        this.#fetchProviderModels(declaration, sessionId),
        this.#fetchMetadata(declaration),
        this.#readCatalog(declaration),
      ]);
    if (catalogResult.status === 'rejected') {
      throw catalogResult.reason instanceof LiveModelCatalogError
        ? catalogResult.reason
        : new LiveModelCatalogError('catalog_read_failed');
    }
    if (providerResult.status === 'rejected') {
      throw providerResult.reason instanceof LiveModelCatalogError
        ? providerResult.reason
        : new LiveModelCatalogError('models_unavailable');
    }
    const metadata = metadataResult.status === 'fulfilled'
      ? metadataResult.value
      : { status: 'unavailable' as const, models: new Map() };
    const snapshot = { models: withPinnedModels(declaration, providerResult.value), metadata };
    this.#snapshots.set(this.#snapshotKey(provider), snapshot);
    return this.#compose(declaration, snapshot, catalogResult.value);
  }

  async favorite(
    provider: string,
    modelId: string,
    favorite: boolean,
    registrationId?: string,
  ): Promise<ModelCatalogResult> {
    const declaration = this.#declaration(provider);
    const accountId = await this.#catalogRegistrationId(declaration, registrationId);
    const snapshot = this.#snapshots.get(this.#snapshotKey(provider, accountId));
    if (snapshot === undefined) {
      throw new LiveModelCatalogError('models_not_loaded');
    }
    const catalog = await this.#readCatalog(declaration, accountId);
    const favorites = new Set(catalog.favorites);
    if (favorite) favorites.add(modelId);
    else favorites.delete(modelId);
    catalog.favorites = [...favorites];

    const model = snapshot.models.find((candidate) => candidate.modelId === modelId);
    if (favorite && model !== undefined) {
      const storedModel = catalog.models[modelId] ?? {};
      const fixed = declaration.modelCatalog.entries.find((entry) => entry.modelId === modelId);
      const known = (fixed?.pinned === true || declaration.catalogSource === 'external' ||
          declaration.modelListSource === 'catalog') && fixed !== undefined
        ? fixed.efforts
        : snapshot.metadata.models.get(modelId);
      if (known !== undefined) storedModel.efforts = [...uniqueEfforts(known)];
      if (storedModel.defaultEffort === undefined) {
        storedModel.defaultEffort = fixed?.defaultEffort ?? 'auto';
      }
      catalog.models[modelId] = storedModel;
    }
    await this.#writeCatalog(declaration, catalog, accountId);
    const readback = await this.#readCatalog(declaration, accountId);
    return this.#compose(declaration, snapshot, readback);
  }

  async efforts(
    provider: string,
    modelId: string,
    currentEffort?: ReasoningEffort,
    registrationId?: string,
  ): Promise<EffortCatalogResult> {
    const declaration = this.#declaration(provider);
    const accountId = await this.#catalogRegistrationId(declaration, registrationId);
    const key = this.#snapshotKey(provider, accountId);
    let snapshot = this.#snapshots.get(key);
    if (snapshot === undefined) {
      snapshot = declaration.modelListSource === 'catalog'
        ? this.#declaredSnapshot(declaration)
        : { models: [], metadata: await this.#fetchMetadata(declaration) };
      this.#snapshots.set(key, snapshot);
    }
    const catalog = await this.#readCatalog(declaration, accountId);
    const fixed = declaration.modelCatalog.entries.find((entry) => entry.modelId === modelId);
    let source: EffortCatalogResult['source'];
    let choices: readonly ReasoningEffort[];
    if (
      (fixed?.pinned === true || declaration.catalogSource === 'external' ||
        declaration.modelListSource === 'catalog') &&
      fixed !== undefined
    ) {
      source = 'override';
      choices = fixed.efforts;
    } else if (snapshot.metadata.status === 'loaded') {
      const metadataChoices = snapshot.metadata.models.get(modelId);
      if (metadataChoices === undefined) {
        source = 'unknown';
        choices = ['auto'];
      } else {
        source = 'models.dev';
        choices = metadataChoices;
      }
    } else {
      const savedChoices = catalog.models[modelId]?.efforts;
      if (savedChoices === undefined) {
        source = 'unknown';
        choices = ['auto'];
      } else {
        source = 'catalog';
        choices = savedChoices;
      }
    }
    const defaultEffort = catalog.models[modelId]?.defaultEffort ??
      fixed?.defaultEffort ?? 'auto';
    const values = [...uniqueEfforts(choices)];
    if (source === 'catalog' || source === 'unknown') {
      for (const effort of [currentEffort, defaultEffort]) {
        if (effort !== undefined && !values.includes(effort)) {
          values.push(effort);
        }
      }
    }
    return Object.freeze({
      kind: 'efforts',
      provider,
      modelId,
      efforts: Object.freeze(values),
      source,
    });
  }

  async remember(
    provider: string,
    modelId: string,
    effort: ReasoningEffort,
    registrationId?: string,
  ): Promise<void> {
    const declaration = this.#declaration(provider);
    const accountId = declaration.providerId === 'openai-chatgpt'
      ? registrationId ?? await this.#chatgptAuth.selectedRegistrationId()
      : undefined;
    // Session/default selection can be saved before an account catalog exists.
    if (declaration.providerId === 'openai-chatgpt' && accountId === undefined) return;
    const catalog = await this.#readCatalog(declaration, accountId);
    const model = catalog.models[modelId] ?? {};
    model.defaultEffort = effort;
    catalog.models[modelId] = model;
    await this.#writeCatalog(declaration, catalog, accountId);
  }

  async defaultEffort(
    provider: string,
    modelId: string,
    registrationId?: string,
  ): Promise<ReasoningEffort> {
    const declaration = this.#declaration(provider);
    const declaredEffort =
      declaration.modelCatalog.entries.find((entry) => entry.modelId === modelId)?.defaultEffort ??
        'auto';
    const accountId = declaration.providerId === 'openai-chatgpt'
      ? registrationId ?? await this.#chatgptAuth.selectedRegistrationId()
      : undefined;
    // Provider discovery is available before sign-in; account settings only exist after it.
    if (declaration.providerId === 'openai-chatgpt' && accountId === undefined) {
      return declaredEffort;
    }
    const catalog = await this.#readCatalog(declaration, accountId);
    return catalog.models[modelId]?.defaultEffort ?? declaredEffort;
  }

  #declaration(provider: string): ProviderDeclarationV1 {
    const declaration = this.#declarations.find((item) => item.providerId === provider);
    if (declaration === undefined) {
      throw new LiveModelCatalogError('unknown_provider');
    }
    return declaration;
  }

  #snapshotKey(provider: string, registrationId?: string): string {
    return registrationId === undefined ? provider : `${provider}:${registrationId}`;
  }

  async #catalogRegistrationId(
    declaration: ProviderDeclarationV1,
    registrationId?: string,
  ): Promise<string | undefined> {
    if (declaration.providerId !== 'openai-chatgpt') return undefined;
    const resolved = registrationId ?? await this.#chatgptAuth.selectedRegistrationId();
    if (resolved === undefined) throw new LiveModelCatalogError('credential_unavailable');
    return resolved;
  }

  #recordFact(
    provider: string,
    api: LiveModelCatalogFact['api'],
    fact: Omit<
      LiveModelCatalogFact,
      'provider' | 'api' | 'requestOrder' | 'occurredAt'
    >,
    context?: FactContext,
  ): void {
    this.#requestFacts.push(Object.freeze({
      provider,
      api,
      requestOrder: context?.requestOrder ?? this.#nextRequestOrder++,
      occurredAt: context?.occurredAt ?? new Date().toISOString(),
      ...fact,
    }));
  }

  #requestContext(): FactContext {
    return Object.freeze({
      requestOrder: this.#nextRequestOrder++,
      occurredAt: new Date().toISOString(),
    });
  }

  async #fetchProviderModels(
    declaration: ProviderDeclarationV1,
    sessionId?: string,
  ): Promise<readonly ProviderModel[]> {
    let credential: string;
    try {
      credential = parseCredentialBytes(
        await Deno.readFile(
          credentialFileFor(declaration.authProfile, this.#credentialRoot),
        ),
      );
    } catch {
      this.#recordFact(declaration.providerId, 'models', {
        error: 'credential_unavailable',
      });
      throw new LiveModelCatalogError('credential_unavailable');
    }

    let headers: Readonly<Record<string, string>>;
    try {
      const declaredHeaders = declaration.headers;
      const base: Record<string, string> = {};
      if (!usesCredentialHeader(declaredHeaders)) {
        base.authorization = `Bearer ${credential}`;
      }
      headers = Object.freeze({
        ...base,
        ...substituteRequestHeaders(declaredHeaders, { credential, sessionId }),
      });
    } catch {
      this.#recordFact(declaration.providerId, 'models', {
        error: 'request_headers_invalid',
      });
      throw new LiveModelCatalogError('models_unavailable');
    }

    let url: URL;
    try {
      url = new URL(`${declaration.endpoint.replace(/\/+$/u, '')}/models`);
      if (declaration.providerId.startsWith('openrouter-')) {
        url.searchParams.set('sort', 'newest');
      }
    } catch {
      this.#recordFact(declaration.providerId, 'models', {
        error: 'request_url_invalid',
      });
      throw new LiveModelCatalogError('models_unavailable');
    }

    const requestContext = this.#requestContext();
    let response: Response;
    try {
      response = await this.#fetcher(url, {
        method: 'GET',
        headers,
        signal: this.#requestCancellation.signal,
      });
    } catch {
      this.#recordFact(declaration.providerId, 'models', {
        error: 'network_error',
      }, requestContext);
      throw new LiveModelCatalogError('models_unavailable');
    }
    if (!response.ok) {
      this.#recordFact(declaration.providerId, 'models', {
        httpStatus: response.status,
        error: 'http_error',
      }, requestContext);
      throw new LiveModelCatalogError('models_unavailable');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.#recordFact(declaration.providerId, 'models', {
        httpStatus: response.status,
        error: 'invalid_json',
      }, requestContext);
      throw new LiveModelCatalogError('models_response_invalid');
    }
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      this.#recordFact(declaration.providerId, 'models', {
        httpStatus: response.status,
        error: 'response_parse_failed',
        field: 'data',
        valueShape: valueShape(isRecord(payload) ? payload.data : payload),
      }, requestContext);
      throw new LiveModelCatalogError('models_response_invalid');
    }
    const models: ProviderModel[] = [];
    for (let index = 0; index < payload.data.length; index += 1) {
      const rawModel = payload.data[index];
      if (
        !isRecord(rawModel) || typeof rawModel.id !== 'string' ||
        rawModel.id.length === 0
      ) {
        const value = isRecord(rawModel) ? rawModel.id : rawModel;
        this.#recordFact(declaration.providerId, 'models', {
          httpStatus: response.status,
          error: 'response_parse_failed',
          field: `data[${index}].id`,
          valueShape: valueShape(value),
        }, requestContext);
        continue;
      }
      if (
        Object.hasOwn(rawModel, 'name') && typeof rawModel.name !== 'string'
      ) {
        this.#recordFact(declaration.providerId, 'models', {
          httpStatus: response.status,
          error: 'response_parse_failed',
          field: `data[${index}].name`,
          valueShape: valueShape(rawModel.name),
        }, requestContext);
      }
      if (
        Object.hasOwn(rawModel, 'created') &&
        (typeof rawModel.created !== 'number' ||
          !Number.isFinite(rawModel.created))
      ) {
        this.#recordFact(declaration.providerId, 'models', {
          httpStatus: response.status,
          error: 'response_parse_failed',
          field: `data[${index}].created`,
          valueShape: valueShape(rawModel.created),
        }, requestContext);
      }
      models.push(Object.freeze({
        modelId: rawModel.id,
        ...(typeof rawModel.name === 'string' ? { name: rawModel.name } : {}),
        ...(typeof rawModel.created === 'number' &&
            Number.isFinite(rawModel.created)
          ? { created: rawModel.created }
          : {}),
      }));
    }
    this.#recordFact(
      declaration.providerId,
      'models',
      { httpStatus: response.status },
      requestContext,
    );
    return Object.freeze(models);
  }

  async #fetchChatGPTModels(
    declaration: ProviderDeclarationV1,
    accessToken: string,
  ): Promise<readonly ProviderModel[]> {
    const requestContext = this.#requestContext();
    let response: Response;
    try {
      response = await this.#fetcher(
        `${declaration.endpoint.replace(/\/+$/u, '')}/models`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${accessToken}` },
          signal: this.#requestCancellation.signal,
        },
      );
    } catch {
      this.#recordFact(declaration.providerId, 'models', {
        error: 'network_error',
      }, requestContext);
      throw new LiveModelCatalogError('models_unavailable');
    }
    if (!response.ok) {
      this.#recordFact(declaration.providerId, 'models', {
        httpStatus: response.status,
        error: 'http_error',
      }, requestContext);
      throw new LiveModelCatalogError('models_unavailable');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.#recordFact(declaration.providerId, 'models', {
        httpStatus: response.status,
        error: 'invalid_json',
      }, requestContext);
      throw new LiveModelCatalogError('models_response_invalid');
    }
    const rawModels = isRecord(payload) ? payload.models : undefined;
    if (!Array.isArray(rawModels)) {
      this.#recordFact(declaration.providerId, 'models', {
        httpStatus: response.status,
        error: 'response_parse_failed',
        field: 'models',
        valueShape: valueShape(rawModels),
      }, requestContext);
      throw new LiveModelCatalogError('models_response_invalid');
    }
    const models: ProviderModel[] = [];
    for (let index = 0; index < rawModels.length; index += 1) {
      const rawModel = rawModels[index];
      if (!isRecord(rawModel)) {
        this.#recordFact(declaration.providerId, 'models', {
          httpStatus: response.status,
          error: 'response_parse_failed',
          field: `models[${index}]`,
          valueShape: valueShape(rawModel),
        }, requestContext);
        continue;
      }
      if (rawModel.visibility !== 'list') continue;
      if (typeof rawModel.slug !== 'string' || rawModel.slug.length === 0) {
        this.#recordFact(declaration.providerId, 'models', {
          httpStatus: response.status,
          error: 'response_parse_failed',
          field: `models[${index}].slug`,
          valueShape: valueShape(rawModel.slug),
        }, requestContext);
        continue;
      }
      if (typeof rawModel.display_name !== 'string' || rawModel.display_name.length === 0) {
        this.#recordFact(declaration.providerId, 'models', {
          httpStatus: response.status,
          error: 'response_parse_failed',
          field: `models[${index}].display_name`,
          valueShape: valueShape(rawModel.display_name),
        }, requestContext);
        continue;
      }
      models.push(Object.freeze({
        modelId: rawModel.slug,
        name: rawModel.display_name,
      }));
    }
    this.#recordFact(
      declaration.providerId,
      'models',
      { httpStatus: response.status },
      requestContext,
    );
    return Object.freeze(models);
  }

  async #resolveMetadataUrl(): Promise<string> {
    if (this.#metadataUrl !== undefined) return this.#metadataUrl;
    try {
      const value: unknown = JSON.parse(
        await Deno.readTextFile(`${this.#configRoot}/model-metadata.json`),
      );
      if (!isRecord(value) || typeof value.url !== 'string') {
        throw new LiveModelCatalogError('catalog_read_failed');
      }
      return value.url;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return DEFAULT_METADATA_URL;
      throw error;
    }
  }

  #modelsDevProviderId(declaration: ProviderDeclarationV1): string {
    if (declaration.modelsDevProviderId !== undefined) {
      return declaration.modelsDevProviderId;
    }
    if (
      declaration.providerId === 'openai-responses' ||
      declaration.providerId === 'openai-chatgpt'
    ) {
      return 'openai';
    }
    if (
      declaration.providerId === 'openrouter-chat' ||
      declaration.providerId === 'openrouter-responses'
    ) return 'openrouter';
    return declaration.providerId;
  }

  async #fetchMetadata(
    declaration: ProviderDeclarationV1,
  ): Promise<MetadataSnapshot> {
    let url: URL;
    try {
      url = new URL(await this.#resolveMetadataUrl());
    } catch {
      this.#recordFact(declaration.providerId, 'models.dev', {
        error: 'metadata_url_invalid',
      });
      return { status: 'unavailable', models: new Map() };
    }
    const requestContext = this.#requestContext();
    let response: Response;
    try {
      // Public metadata is deliberately fetched without the provider credential or headers.
      response = await this.#fetcher(url, {
        method: 'GET',
        signal: this.#requestCancellation.signal,
      });
    } catch {
      this.#recordFact(
        declaration.providerId,
        'models.dev',
        { error: 'network_error' },
        requestContext,
      );
      return { status: 'unavailable', models: new Map() };
    }
    if (!response.ok) {
      this.#recordFact(declaration.providerId, 'models.dev', {
        httpStatus: response.status,
        error: 'http_error',
      }, requestContext);
      return { status: 'unavailable', models: new Map() };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.#recordFact(declaration.providerId, 'models.dev', {
        httpStatus: response.status,
        error: 'invalid_json',
      }, requestContext);
      return { status: 'unavailable', models: new Map() };
    }
    const snapshot = parseMetadataSnapshot(
      this.#modelsDevProviderId(declaration),
      payload,
      (fact) =>
        this.#recordFact(declaration.providerId, 'models.dev', {
          httpStatus: response.status,
          ...fact,
        }, requestContext),
    );
    this.#recordFact(
      declaration.providerId,
      'models.dev',
      { httpStatus: response.status },
      requestContext,
    );
    return snapshot;
  }

  #catalogPath(declaration: ProviderDeclarationV1, registrationId?: string): string {
    const accountSuffix = declaration.providerId === 'openai-chatgpt' &&
        registrationId !== undefined
      ? `-${encodeURIComponent(registrationId)}`
      : '';
    return `${this.#configRoot}/${CATALOG_DIRECTORY}/${declaration.providerId}${accountSuffix}.json`;
  }

  #seedCatalog(declaration: ProviderDeclarationV1): StoredCatalog {
    const models: Record<string, CatalogModel> = {};
    const favorites: string[] = [];
    for (const entry of declaration.modelCatalog.entries) {
      favorites.push(entry.modelId);
      models[entry.modelId] = {
        defaultEffort: entry.defaultEffort,
        efforts: [...entry.efforts],
      };
    }
    return { favorites, models };
  }

  async #readCatalog(
    declaration: ProviderDeclarationV1,
    registrationId?: string,
  ): Promise<StoredCatalog> {
    const path = this.#catalogPath(declaration, registrationId);
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new LiveModelCatalogError('catalog_read_failed');
      }
      const seeded = this.#seedCatalog(declaration);
      await this.#writeCatalog(declaration, seeded, registrationId);
      return seeded;
    }
    try {
      return validateStoredCatalog(JSON.parse(text));
    } catch {
      throw new LiveModelCatalogError('catalog_read_failed');
    }
  }

  async #writeCatalog(
    declaration: ProviderDeclarationV1,
    catalog: StoredCatalog,
    registrationId?: string,
  ): Promise<void> {
    const directory = `${this.#configRoot}/${CATALOG_DIRECTORY}`;
    const path = this.#catalogPath(declaration, registrationId);
    const staging = `${path}.staging-${crypto.randomUUID().toLowerCase()}`;
    try {
      await Deno.mkdir(directory, { recursive: true });
      await Deno.writeTextFile(staging, `${JSON.stringify(catalog, null, 2)}\n`);
      await Deno.rename(staging, path);
    } catch {
      throw new LiveModelCatalogError('catalog_write_failed');
    } finally {
      try {
        await Deno.remove(staging);
      } catch {
        // A successful rename already published the completed catalog.
      }
    }
  }

  #declaredSnapshot(declaration: ProviderDeclarationV1): ModelSnapshot {
    return {
      models: declaration.modelCatalog.entries.map(({ modelId }) => ({ modelId })),
      metadata: {
        status: 'loaded',
        models: new Map(
          declaration.modelCatalog.entries.map(({ modelId, efforts }) => [modelId, efforts]),
        ),
      },
    };
  }

  #compose(
    declaration: ProviderDeclarationV1,
    snapshot: ModelSnapshot,
    catalog: StoredCatalog,
  ): ModelCatalogResult {
    const favorites = new Set(catalog.favorites);
    const orderedModels = declaration.providerId === 'openai-chatgpt'
      ? snapshot.models
      : sortedModels(snapshot.models, favorites);
    const models = orderedModels.map((model) => {
      const fixed = declaration.modelCatalog.entries.find((entry) =>
        entry.modelId === model.modelId
      );
      let known: readonly ReasoningEffort[] | undefined;
      let source: EffortCatalogResult['source'];
      if (
        (fixed?.pinned === true || declaration.catalogSource === 'external' ||
          declaration.modelListSource === 'catalog') &&
        fixed !== undefined
      ) {
        source = 'override';
        known = fixed.efforts;
      } else if (snapshot.metadata.status === 'loaded') {
        known = snapshot.metadata.models.get(model.modelId);
        source = known === undefined ? 'unknown' : 'models.dev';
      } else {
        known = catalog.models[model.modelId]?.efforts;
        source = known === undefined ? 'unknown' : 'catalog';
      }
      const efforts = uniqueEfforts(known ?? ['auto']);
      const defaultEffort = catalog.models[model.modelId]?.defaultEffort ??
        fixed?.defaultEffort ?? 'auto';
      if (
        (source === 'catalog' || source === 'unknown') &&
        !efforts.includes(defaultEffort)
      ) efforts.push(defaultEffort);
      return Object.freeze({
        modelId: model.modelId,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.created === undefined ? {} : { created: model.created }),
        favorite: favorites.has(model.modelId),
        defaultEffort,
        efforts: Object.freeze(efforts),
      });
    });
    return Object.freeze({
      kind: 'models',
      provider: declaration.providerId,
      metadataStatus: snapshot.metadata.status,
      models: Object.freeze(models),
    });
  }
}
