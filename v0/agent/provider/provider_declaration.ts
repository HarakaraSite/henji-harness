import { type AuthProfileId, type ReasoningEffort } from './model_selection.ts';
import { bundledDefaultDeclarations } from './provider_defaults.ts';

export const PROVIDER_DECLARATION_SCHEMA_VERSION = 1 as const;
export const PROVIDER_DECLARATION_DIRECTORY = 'providers' as const;

export type ProviderProtocol = 'openai-chat-completions' | 'openai-responses';

/** Built-in route identities that a declaration may not redefine. */
export const RESERVED_PROVIDER_IDS: readonly string[] = Object.freeze([]);

/**
 * Built-in provider ids whose declaration may override the model catalog and defaults. The protocol,
 * endpoint, and auth profile must stay identical so a declaration cannot silently change the vendor.
 */
export const OVERRIDABLE_PROVIDER_IDS: readonly string[] = Object.freeze([
  'openrouter',
  'openai',
  'openrouter-responses',
]);

export interface ProviderCatalogEntryV1 {
  readonly modelId: string;
  readonly defaultEffort: ReasoningEffort;
  readonly efforts: readonly ReasoningEffort[];
}

export interface ProviderDeclarationV1 {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly endpoint: string;
  readonly authProfile: AuthProfileId;
  readonly modelCatalog: {
    readonly kind: 'fixed';
    readonly entries: readonly ProviderCatalogEntryV1[];
  };
  readonly defaults: {
    readonly modelId: string;
    readonly effort: ReasoningEffort;
  };
}

export type ProviderDeclarationErrorCode =
  | 'provider_declaration_not_found'
  | 'provider_declaration_invalid'
  | 'provider_declaration_duplicate'
  | 'provider_declaration_reserved'
  | 'provider_declaration_io_failure';

export class ProviderDeclarationError extends Error {
  constructor(
    readonly code: ProviderDeclarationErrorCode,
    message: string,
    readonly providerId?: string,
  ) {
    super(message);
    this.name = 'ProviderDeclarationError';
  }
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const EFFORTS: readonly ReasoningEffort[] = Object.freeze([
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const AUTH_PROFILES: readonly AuthProfileId[] = Object.freeze([
  'openrouter-api-key',
  'openai-api-key',
]);
const PROTOCOLS: readonly ProviderProtocol[] = Object.freeze([
  'openai-chat-completions',
  'openai-responses',
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

const isEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);

const parseCatalogEntry = (value: unknown): ProviderCatalogEntryV1 => {
  if (
    !isRecord(value) || !exactKeys(value, ['modelId', 'defaultEffort', 'efforts']) ||
    typeof value.modelId !== 'string' || value.modelId.length === 0 ||
    !isEffort(value.defaultEffort) || !Array.isArray(value.efforts) ||
    value.efforts.length === 0 || !value.efforts.every(isEffort)
  ) {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider catalog entry is invalid',
    );
  }
  if (!value.efforts.includes(value.defaultEffort)) {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider default effort is not in its efforts',
    );
  }
  return Object.freeze({
    modelId: value.modelId,
    defaultEffort: value.defaultEffort,
    efforts: Object.freeze([...value.efforts]),
  });
};

const parseEndpoint = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider endpoint is invalid',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider endpoint is invalid',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider endpoint protocol is unsupported',
    );
  }
  return value.replace(/\/+$/u, '');
};

/** Validate one parsed declaration object; reserved built-in identities are rejected here. */
export const validateProviderDeclaration = (value: unknown): ProviderDeclarationV1 => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'providerId',
      'protocol',
      'endpoint',
      'authProfile',
      'modelCatalog',
      'defaults',
    ]) ||
    value.schemaVersion !== PROVIDER_DECLARATION_SCHEMA_VERSION ||
    typeof value.providerId !== 'string' || !PROVIDER_ID.test(value.providerId) ||
    typeof value.protocol !== 'string' ||
    !(PROTOCOLS as readonly string[]).includes(value.protocol) ||
    typeof value.authProfile !== 'string' ||
    !(AUTH_PROFILES as readonly string[]).includes(value.authProfile)
  ) {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider declaration is invalid',
      isRecord(value) && typeof value.providerId === 'string' ? value.providerId : undefined,
    );
  }
  const endpoint = parseEndpoint(value.endpoint);
  if (
    !isRecord(value.modelCatalog) || value.modelCatalog.kind !== 'fixed' ||
    !Array.isArray(value.modelCatalog.entries) || value.modelCatalog.entries.length === 0
  ) {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider model catalog is invalid',
      value.providerId,
    );
  }
  const entries = value.modelCatalog.entries.map(parseCatalogEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.modelId)) {
      throw new ProviderDeclarationError(
        'provider_declaration_invalid',
        'provider catalog contains a duplicate model',
        value.providerId,
      );
    }
    seen.add(entry.modelId);
  }
  const defaults = value.defaults;
  if (
    !isRecord(defaults) ||
    typeof defaults.modelId !== 'string' ||
    !isEffort(defaults.effort)
  ) {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider defaults are invalid',
      value.providerId,
    );
  }
  const defaultModelId = defaults.modelId;
  const defaultEffort = defaults.effort;
  const defaultEntry = entries.find((entry) => entry.modelId === defaultModelId);
  if (defaultEntry === undefined || !defaultEntry.efforts.includes(defaultEffort)) {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider default model or effort is not in its catalog',
      value.providerId,
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    providerId: value.providerId,
    protocol: value.protocol as ProviderProtocol,
    endpoint,
    authProfile: value.authProfile as AuthProfileId,
    modelCatalog: Object.freeze({ kind: 'fixed' as const, entries: Object.freeze(entries) }),
    defaults: Object.freeze({
      modelId: defaultModelId,
      effort: defaultEffort,
    }),
  });
};

/** Parse one declaration JSON text and validate it. */
export const parseProviderDeclaration = (text: string): ProviderDeclarationV1 => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderDeclarationError(
      'provider_declaration_invalid',
      'provider declaration is not valid JSON',
    );
  }
  return validateProviderDeclaration(parsed);
};

export interface ProviderRegistry {
  readonly declarations: readonly ProviderDeclarationV1[];
  readonly get: (providerId: string) => ProviderDeclarationV1 | undefined;
}

const freezeRegistry = (
  declarations: readonly ProviderDeclarationV1[],
): ProviderRegistry => {
  const map = new Map(declarations.map((declaration) => [declaration.providerId, declaration]));
  return Object.freeze({
    declarations: Object.freeze([...declarations]),
    get: (providerId: string) => map.get(providerId),
  });
};

/** Merge declarations over built-in defaults; new ids are added, overridable ids are replaced. */
export const resolveProviderRegistry = (
  builtins: readonly ProviderDeclarationV1[],
  declarations: readonly ProviderDeclarationV1[],
): ProviderRegistry => {
  const byId = new Map(builtins.map((declaration) => [declaration.providerId, declaration]));
  for (const declaration of declarations) {
    const existing = byId.get(declaration.providerId);
    if (existing !== undefined) {
      if (!OVERRIDABLE_PROVIDER_IDS.includes(declaration.providerId)) {
        throw new ProviderDeclarationError(
          'provider_declaration_duplicate',
          'provider declaration conflicts with an existing provider',
          declaration.providerId,
        );
      }
      if (
        existing.protocol !== declaration.protocol ||
        existing.endpoint !== declaration.endpoint ||
        existing.authProfile !== declaration.authProfile
      ) {
        throw new ProviderDeclarationError(
          'provider_declaration_invalid',
          'provider override must keep protocol, endpoint, and authProfile',
          declaration.providerId,
        );
      }
    }
    byId.set(declaration.providerId, declaration);
  }
  return freezeRegistry([...byId.values()]);
};

export interface ProviderDeclarationFileSystem {
  readonly readDirectory: (path: string) => Promise<readonly string[]>;
  readonly readTextFile: (path: string) => Promise<string>;
}

const productionFileSystem: ProviderDeclarationFileSystem = {
  async readDirectory(path) {
    const names: string[] = [];
    for await (const entry of Deno.readDir(path)) {
      if (entry.isFile && entry.name.endsWith('.json')) names.push(entry.name);
    }
    return names.sort();
  },
  readTextFile: (path) => Deno.readTextFile(path),
};

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;

export interface LoadProviderDeclarationsOptions {
  readonly configRoot: string;
  readonly fileSystem?: ProviderDeclarationFileSystem;
}

/**
 * Load and validate `$XDG_CONFIG_HOME/henji-harness/providers/*.json`.
 * Duplicate providerIds across files are rejected instead of being silently resolved.
 */
export const loadProviderDeclarations = async (
  options: LoadProviderDeclarationsOptions,
): Promise<readonly ProviderDeclarationV1[]> => {
  const fileSystem = options.fileSystem ?? productionFileSystem;
  const root = `${options.configRoot}/${PROVIDER_DECLARATION_DIRECTORY}`;
  let names: readonly string[];
  try {
    names = await fileSystem.readDirectory(root);
  } catch (error) {
    if (isNotFound(error)) return Object.freeze([]);
    throw new ProviderDeclarationError(
      'provider_declaration_io_failure',
      'provider declaration directory could not be listed',
    );
  }
  const declarations: ProviderDeclarationV1[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    let text: string;
    try {
      text = await fileSystem.readTextFile(`${root}/${name}`);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw new ProviderDeclarationError(
        'provider_declaration_io_failure',
        'provider declaration could not be read',
      );
    }
    const declaration = parseProviderDeclaration(text);
    if (seen.has(declaration.providerId)) {
      throw new ProviderDeclarationError(
        'provider_declaration_duplicate',
        'provider declaration is duplicated across files',
        declaration.providerId,
      );
    }
    seen.add(declaration.providerId);
    declarations.push(declaration);
  }
  return Object.freeze(declarations);
};

/** Bundled default declarations, validated on first use. */
export const builtinProviderDeclarations = (): readonly ProviderDeclarationV1[] =>
  Object.freeze(
    bundledDefaultDeclarations().map((declaration) => validateProviderDeclaration(declaration)),
  );
