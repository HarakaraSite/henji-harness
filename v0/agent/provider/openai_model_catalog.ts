import type { ModelSelection, OpenAIModelSelection, ReasoningEffort } from './model_selection.ts';
import { declarationFor } from './provider_runtime.ts';
import { bundledDefaultDeclarationFor } from './provider_defaults.ts';

export interface OpenAIModelCatalogEntry {
  readonly modelId: string;
  readonly defaultEffort: ReasoningEffort;
  readonly efforts: readonly ReasoningEffort[];
}

const bundledOpenAI = bundledDefaultDeclarationFor('openai')!;

export const OPENAI_MODEL_CATALOG: readonly OpenAIModelCatalogEntry[] =
  bundledOpenAI.modelCatalog.entries;

export const OPENAI_DEFAULT_MODEL_SELECTION: OpenAIModelSelection = Object.freeze({
  provider: 'openai',
  api: 'openai-responses',
  authProfile: 'openai-api-key',
  modelId: bundledOpenAI.defaults.modelId,
  effort: bundledOpenAI.defaults.effort,
});

const openAIEntries = (): readonly OpenAIModelCatalogEntry[] =>
  declarationFor('openai')?.modelCatalog.entries ?? OPENAI_MODEL_CATALOG;

export const openAIModelCatalogEntry = (
  modelId: string,
): OpenAIModelCatalogEntry | undefined =>
  openAIEntries().find((candidate) => candidate.modelId === modelId);

export const isOpenAIModelSelection = (
  value: unknown,
): value is OpenAIModelSelection => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const selection = value as Partial<ModelSelection>;
  if (
    selection.provider !== 'openai' || selection.api !== 'openai-responses' ||
    selection.authProfile !== 'openai-api-key' || typeof selection.modelId !== 'string' ||
    typeof selection.effort !== 'string'
  ) return false;
  const catalog = openAIModelCatalogEntry(selection.modelId);
  return catalog !== undefined && catalog.efforts.includes(selection.effort as ReasoningEffort);
};

export const selectOpenAIModel = (
  modelId: string,
  effort?: ReasoningEffort,
): OpenAIModelSelection => {
  const catalog = openAIModelCatalogEntry(modelId);
  if (catalog === undefined) throw new RangeError(`unknown OpenAI model: ${modelId}`);
  const selectedEffort = effort ?? catalog.defaultEffort;
  if (!catalog.efforts.includes(selectedEffort)) {
    throw new RangeError(`unsupported effort for ${modelId}: ${selectedEffort}`);
  }
  return Object.freeze({
    provider: 'openai',
    api: 'openai-responses',
    authProfile: 'openai-api-key',
    modelId,
    effort: selectedEffort,
  });
};

export const searchOpenAIModels = (
  query: string,
): readonly OpenAIModelCatalogEntry[] => {
  const entries = openAIEntries();
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return entries;
  return Object.freeze(
    entries.filter((candidate) => candidate.modelId.toLocaleLowerCase().includes(normalized)),
  );
};
