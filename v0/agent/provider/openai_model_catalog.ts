import type { ModelSelection, OpenAIModelSelection, ReasoningEffort } from './model_selection.ts';

export interface OpenAIModelCatalogEntry {
  readonly modelId: string;
  readonly defaultEffort: ReasoningEffort;
  readonly efforts: readonly ReasoningEffort[];
}

export const OPENAI_MODEL_CATALOG: readonly OpenAIModelCatalogEntry[] = Object.freeze([
  Object.freeze({
    modelId: 'gpt-5.6-sol',
    defaultEffort: 'medium',
    efforts: Object.freeze(['none', 'low', 'medium', 'high', 'xhigh'] as const),
  }),
  Object.freeze({
    modelId: 'gpt-5.6-luna',
    defaultEffort: 'medium',
    efforts: Object.freeze(['none', 'low', 'medium', 'high', 'xhigh'] as const),
  }),
]);

export const OPENAI_DEFAULT_MODEL_SELECTION: OpenAIModelSelection = Object.freeze({
  provider: 'openai',
  api: 'openai-responses',
  authProfile: 'openai-api-key',
  modelId: OPENAI_MODEL_CATALOG[0].modelId,
  effort: OPENAI_MODEL_CATALOG[0].defaultEffort,
});

export const openAIModelCatalogEntry = (
  modelId: string,
): OpenAIModelCatalogEntry | undefined =>
  OPENAI_MODEL_CATALOG.find((candidate) => candidate.modelId === modelId);

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
