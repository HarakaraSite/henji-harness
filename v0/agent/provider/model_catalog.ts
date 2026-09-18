import {
  isOpenRouterModelSelection,
  isOpenRouterResponsesModelSelection,
  openRouterCatalogEntry,
  type OpenRouterModelCatalogEntry,
  ROOT_DEFAULT_EFFORT,
  ROOT_DEFAULT_MODEL_ID,
  ROOT_DEFAULT_MODEL_SELECTION,
  searchOpenRouterModels,
  selectOpenRouterModel,
  selectOpenRouterResponsesModel,
} from './openrouter_model_catalog.ts';
import {
  isOpenAIModelSelection,
  OPENAI_DEFAULT_MODEL_SELECTION,
  type OpenAIModelCatalogEntry,
  openAIModelCatalogEntry,
  searchOpenAIModels,
  selectOpenAIModel,
} from './openai_model_catalog.ts';
import {
  BUILTIN_PROVIDER_IDS,
  type DeclaredChatModelSelection,
  type DeclaredProviderModelSelection,
  isStoredModelSelection,
  type ModelSelection,
  type ProviderId,
  type ReasoningEffort,
} from './model_selection.ts';
import type { ProviderDeclarationV1 } from './provider_declaration.ts';
import { activeProviderDeclarations, declarationFor } from './provider_runtime.ts';
import { bundledDefaultDeclarationFor, bundledRoleDefaultFor } from './provider_defaults.ts';

export type { ModelSelection, ProviderId, ReasoningEffort } from './model_selection.ts';

export type ProviderModelCatalogEntry = OpenRouterModelCatalogEntry | OpenAIModelCatalogEntry;

const declaredProviderIds = (): readonly string[] => {
  const seen = new Set<string>();
  return Object.freeze(
    activeProviderDeclarations()
      .filter((declaration) =>
        (declaration.protocol === 'openai-responses' ||
          declaration.protocol === 'openai-chat-completions') &&
        !BUILTIN_PROVIDER_IDS.includes(declaration.providerId)
      )
      .map((declaration) => declaration.providerId)
      .filter((id) => seen.has(id) ? false : (seen.add(id), true)),
  );
};

/** Built-in ids followed by declared provider ids. */
export const providerIdsForSelection = (): readonly string[] =>
  Object.freeze([...BUILTIN_PROVIDER_IDS, ...declaredProviderIds()]);

const declaredSelection = (
  declaration: ProviderDeclarationV1,
  modelId: string,
  effort: ReasoningEffort,
): DeclaredProviderModelSelection | DeclaredChatModelSelection =>
  declaration.protocol === 'openai-chat-completions'
    ? Object.freeze({
      provider: declaration.providerId,
      api: 'openai-chat-completions' as const,
      authProfile: declaration.authProfile,
      modelId,
      effort,
    })
    : Object.freeze({
      provider: declaration.providerId,
      api: 'openai-responses' as const,
      authProfile: declaration.authProfile,
      modelId,
      effort,
    });

const declaredEntriesFor = (
  provider: ProviderId,
): readonly ProviderModelCatalogEntry[] | undefined => {
  const declaration = declarationFor(provider) ?? bundledDefaultDeclarationFor(provider);
  if (declaration === undefined) return undefined;
  // openrouter/openai overrides are resolved by their override-aware catalog helpers; other built-ins
  // and declared ids use the declaration entries directly.
  if (
    BUILTIN_PROVIDER_IDS.includes(provider) &&
    provider !== 'openrouter-responses' && provider !== 'openai-chat'
  ) {
    return undefined;
  }
  return declaration.modelCatalog.entries;
};

/** Catalog membership validation that includes Host-resolved declarations. */
export const isModelSelection = (value: unknown): value is ModelSelection => {
  if (!isStoredModelSelection(value)) return false;
  const declared = declaredEntriesFor(value.provider);
  if (declared !== undefined) {
    return declared.some((entry) =>
      entry.modelId === value.modelId && entry.efforts.includes(value.effort)
    );
  }
  return isOpenRouterModelSelection(value) || isOpenRouterResponsesModelSelection(value) ||
    isOpenAIModelSelection(value);
};

export const defaultModelSelectionFor = (provider: ProviderId): ModelSelection => {
  if (provider === 'openai-responses') {
    const declaration = declarationFor('openai-responses');
    return declaration === undefined
      ? OPENAI_DEFAULT_MODEL_SELECTION
      : selectOpenAIModel(declaration.defaults.modelId, declaration.defaults.effort);
  }
  if (provider === 'openrouter-chat') {
    const declaration = declarationFor('openrouter-chat');
    return declaration === undefined
      ? ROOT_DEFAULT_MODEL_SELECTION
      : selectOpenRouterModel(declaration.defaults.modelId, declaration.defaults.effort);
  }
  if (provider === 'openrouter-responses') {
    const declaration = declarationFor('openrouter-responses');
    if (declaration !== undefined) {
      return selectOpenRouterResponsesModel(
        declaration.defaults.modelId,
        declaration.defaults.effort,
      );
    }
    return selectOpenRouterResponsesModel(ROOT_DEFAULT_MODEL_ID, ROOT_DEFAULT_EFFORT);
  }
  const declaration = declarationFor(provider) ?? bundledDefaultDeclarationFor(provider);
  if (declaration !== undefined) {
    return declaredSelection(
      declaration,
      declaration.defaults.modelId,
      declaration.defaults.effort,
    );
  }
  throw new RangeError(`unknown provider: ${provider}`);
};

export const modelCatalogEntryFor = (
  provider: ProviderId,
  modelId: string,
): ProviderModelCatalogEntry | undefined => {
  if (provider === 'openai-responses') return openAIModelCatalogEntry(modelId);
  const declared = declaredEntriesFor(provider);
  if (declared !== undefined) return declared.find((entry) => entry.modelId === modelId);
  return openRouterCatalogEntry(modelId);
};

export const searchModelsFor = (
  provider: ProviderId,
  query: string,
): readonly ProviderModelCatalogEntry[] => {
  if (provider === 'openai-responses') return searchOpenAIModels(query);
  const declared = declaredEntriesFor(provider);
  if (declared !== undefined) {
    const normalized = query.trim().toLocaleLowerCase();
    return Object.freeze(
      normalized.length === 0
        ? [...declared]
        : declared.filter((entry) => entry.modelId.toLocaleLowerCase().includes(normalized)),
    );
  }
  return searchOpenRouterModels(query);
};

/**
 * Resolve one bundled slot default to a model selection against the active provider catalog.
 * The planner default is supplied by bundled `roleDefaults` data, not a code constant.
 */
export const roleDefaultModelSelection = (slot: string): ModelSelection => {
  const bundled = bundledRoleDefaultFor(slot);
  if (bundled === undefined) {
    throw new RangeError(`no bundled role default for slot: ${slot}`);
  }
  return selectModelFor(bundled.providerId, bundled.modelId, bundled.effort);
};

export const selectModelFor = (
  provider: ProviderId,
  modelId: string,
  effort?: ReasoningEffort,
): ModelSelection => {
  if (provider === 'openai-responses') return selectOpenAIModel(modelId, effort);
  if (provider === 'openrouter-chat') return selectOpenRouterModel(modelId, effort);
  if (provider === 'openrouter-responses') {
    return selectOpenRouterResponsesModel(modelId, effort);
  }
  const declaration = declarationFor(provider) ?? bundledDefaultDeclarationFor(provider);
  if (declaration !== undefined) {
    const entry = declaration.modelCatalog.entries.find((candidate) =>
      candidate.modelId === modelId
    );
    if (entry === undefined) throw new RangeError(`unknown model for ${provider}: ${modelId}`);
    const selected = effort ?? entry.defaultEffort;
    if (!entry.efforts.includes(selected)) {
      throw new RangeError(`unsupported effort for ${modelId}: ${selected}`);
    }
    return declaredSelection(declaration, modelId, selected);
  }
  throw new RangeError(`unknown provider: ${provider}`);
};
