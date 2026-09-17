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
import type { ModelSelection, ProviderId, ReasoningEffort } from './model_selection.ts';
import type { ProviderCatalogEntryV1 } from './provider_declaration.ts';
import { declarationFor } from './provider_runtime.ts';

type ImportedProviderCatalogEntry = ProviderCatalogEntryV1;

export type { ModelSelection, ProviderId, ReasoningEffort } from './model_selection.ts';

export type ProviderModelCatalogEntry = OpenRouterModelCatalogEntry | OpenAIModelCatalogEntry;

export const PROVIDERS: readonly ProviderId[] = Object.freeze(
  [
    'openrouter',
    'openrouter-responses',
    'openai',
  ] as const,
);

export const isModelSelection = (value: unknown): value is ModelSelection =>
  isOpenRouterModelSelection(value) || isOpenRouterResponsesModelSelection(value) ||
  isOpenAIModelSelection(value);

export const defaultModelSelectionFor = (provider: ProviderId): ModelSelection => {
  if (provider === 'openai') return OPENAI_DEFAULT_MODEL_SELECTION;
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
  return ROOT_DEFAULT_MODEL_SELECTION;
};

const declaredResponsesEntries = ():
  | readonly ImportedProviderCatalogEntry[]
  | undefined => declarationFor('openrouter-responses')?.modelCatalog.entries;

export const modelCatalogEntryFor = (
  provider: ProviderId,
  modelId: string,
): ProviderModelCatalogEntry | undefined => {
  if (provider === 'openai') return openAIModelCatalogEntry(modelId);
  if (provider === 'openrouter-responses') {
    const declared = declaredResponsesEntries();
    if (declared !== undefined) {
      return declared.find((entry) => entry.modelId === modelId);
    }
  }
  return openRouterCatalogEntry(modelId);
};

export const searchModelsFor = (
  provider: ProviderId,
  query: string,
): readonly ProviderModelCatalogEntry[] => {
  if (provider === 'openai') return searchOpenAIModels(query);
  if (provider === 'openrouter-responses') {
    const declared = declaredResponsesEntries();
    if (declared !== undefined) {
      const normalized = query.trim().toLocaleLowerCase();
      return Object.freeze(
        normalized.length === 0
          ? [...declared]
          : declared.filter((entry) => entry.modelId.toLocaleLowerCase().includes(normalized)),
      );
    }
  }
  return searchOpenRouterModels(query);
};

export const selectModelFor = (
  provider: ProviderId,
  modelId: string,
  effort?: ReasoningEffort,
): ModelSelection => {
  if (provider === 'openai') return selectOpenAIModel(modelId, effort);
  if (provider === 'openrouter-responses') {
    return selectOpenRouterResponsesModel(modelId, effort);
  }
  return selectOpenRouterModel(modelId, effort);
};
