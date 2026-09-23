import type { OpenAIModelSelection, ReasoningEffort } from './model_selection.ts';
import {
  isModelSelection,
  modelCatalogEntryFor,
  searchModelsFor,
  selectModelFor,
} from './model_catalog.ts';
import { bundledDefaultDeclarationFor } from './provider_defaults.ts';

export interface OpenAIModelCatalogEntry {
  readonly modelId: string;
  readonly defaultEffort: ReasoningEffort;
  readonly efforts: readonly ReasoningEffort[];
}

const bundledOpenAI = bundledDefaultDeclarationFor('openai-responses')!;

export const OPENAI_MODEL_CATALOG: readonly OpenAIModelCatalogEntry[] =
  bundledOpenAI.modelCatalog.entries;

export const OPENAI_DEFAULT_MODEL_SELECTION: OpenAIModelSelection = Object.freeze({
  provider: 'openai-responses',
  api: 'openai-responses',
  authProfile: 'openai-api-key',
  modelId: bundledOpenAI.defaults.modelId,
  effort: bundledOpenAI.defaults.effort,
});

export const openAIModelCatalogEntry = (
  modelId: string,
): OpenAIModelCatalogEntry | undefined => modelCatalogEntryFor('openai-responses', modelId);

export const isOpenAIModelSelection = (
  value: unknown,
): value is OpenAIModelSelection => {
  return isModelSelection(value) && value.provider === 'openai-responses';
};

export const selectOpenAIModel = (
  modelId: string,
  effort?: ReasoningEffort,
): OpenAIModelSelection => {
  return selectModelFor('openai-responses', modelId, effort) as OpenAIModelSelection;
};

export const searchOpenAIModels = (
  query: string,
): readonly OpenAIModelCatalogEntry[] => {
  return searchModelsFor('openai-responses', query);
};
