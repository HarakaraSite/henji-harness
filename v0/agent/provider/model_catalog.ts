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
    return selectOpenRouterResponsesModel(ROOT_DEFAULT_MODEL_ID, ROOT_DEFAULT_EFFORT);
  }
  return ROOT_DEFAULT_MODEL_SELECTION;
};

export const modelCatalogEntryFor = (
  provider: ProviderId,
  modelId: string,
): ProviderModelCatalogEntry | undefined =>
  provider === 'openai' ? openAIModelCatalogEntry(modelId) : openRouterCatalogEntry(modelId);

export const searchModelsFor = (
  provider: ProviderId,
  query: string,
): readonly ProviderModelCatalogEntry[] =>
  provider === 'openai' ? searchOpenAIModels(query) : searchOpenRouterModels(query);

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
