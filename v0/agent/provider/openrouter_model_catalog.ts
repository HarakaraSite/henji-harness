import type { OpenRouterAgentProfile } from './openrouter_contract.ts';

export type OpenRouterReasoningEffort =
  | 'auto'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type OpenRouterExplicitReasoningEffort = Exclude<OpenRouterReasoningEffort, 'auto'>;

export interface OpenRouterModelSelection {
  readonly provider: 'openrouter';
  readonly modelId: string;
  readonly effort: OpenRouterReasoningEffort;
}

export interface OpenRouterModelCatalogEntry {
  readonly modelId: string;
  readonly defaultEffort: OpenRouterReasoningEffort;
  readonly efforts: readonly OpenRouterReasoningEffort[];
}

const entry = (
  modelId: string,
  defaultEffort: OpenRouterReasoningEffort,
  efforts: readonly OpenRouterReasoningEffort[],
): OpenRouterModelCatalogEntry =>
  Object.freeze({
    modelId,
    defaultEffort,
    efforts: Object.freeze([...efforts]),
  });

/** Repository-owned Increment 12 catalog; no provider request is needed to open the picker. */
export const OPENROUTER_MODEL_CATALOG: readonly OpenRouterModelCatalogEntry[] = Object.freeze([
  entry('qwen/qwen3.8-max-0902', 'xhigh', [
    'auto',
    'xhigh',
    'high',
    'medium',
    'low',
    'minimal',
  ]),
  entry('qwen/qwen3.8-flash', 'auto', ['auto']),
  entry('deepseek/deepseek-v4-pro-0813', 'high', ['auto', 'max', 'high', 'low']),
  entry('deepseek/deepseek-v4-flash-0731', 'high', ['auto', 'max', 'high', 'low']),
  entry('openai/gpt-5.6-sol', 'medium', [
    'auto',
    'max',
    'xhigh',
    'high',
    'medium',
    'low',
    'none',
  ]),
  entry('openai/gpt-5.6-luna', 'medium', [
    'auto',
    'max',
    'xhigh',
    'high',
    'medium',
    'low',
    'none',
  ]),
  entry('z-ai/glm-5.3', 'max', ['auto', 'max', 'high', 'low']),
  entry('z-ai/glm-5.3-flash', 'max', ['auto', 'max', 'high', 'low']),
  entry('google/gemini-3.8-flash', 'medium', ['auto', 'high', 'medium', 'low']),
  entry('meta/muse-spark-1.3', 'medium', [
    'auto',
    'max',
    'xhigh',
    'high',
    'medium',
    'low',
    'minimal',
  ]),
  entry('x-ai/grok-4.6', 'high', ['auto', 'xhigh', 'high', 'medium', 'low']),
]);

export const ROOT_DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-pro-0813';
export const ROOT_DEFAULT_EFFORT: OpenRouterReasoningEffort = 'high';
export const PLANNER_DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-pro-0813';
export const PLANNER_DEFAULT_EFFORT: OpenRouterReasoningEffort = 'high';

export const ROOT_DEFAULT_MODEL_SELECTION: OpenRouterModelSelection = Object.freeze({
  provider: 'openrouter',
  modelId: ROOT_DEFAULT_MODEL_ID,
  effort: ROOT_DEFAULT_EFFORT,
});

export const PLANNER_DEFAULT_MODEL_SELECTION: OpenRouterModelSelection = Object.freeze({
  provider: 'openrouter',
  modelId: PLANNER_DEFAULT_MODEL_ID,
  effort: PLANNER_DEFAULT_EFFORT,
});

export const openRouterCatalogEntry = (
  modelId: string,
): OpenRouterModelCatalogEntry | undefined =>
  OPENROUTER_MODEL_CATALOG.find((candidate) => candidate.modelId === modelId);

export const isOpenRouterModelSelection = (
  value: unknown,
): value is OpenRouterModelSelection => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (
    Object.keys(selection).length !== 3 || selection.provider !== 'openrouter' ||
    typeof selection.modelId !== 'string' || typeof selection.effort !== 'string'
  ) return false;
  const catalog = openRouterCatalogEntry(selection.modelId);
  return catalog !== undefined &&
    catalog.efforts.includes(selection.effort as OpenRouterReasoningEffort);
};

export const selectOpenRouterModel = (
  modelId: string,
  effort?: OpenRouterReasoningEffort,
): OpenRouterModelSelection => {
  const catalog = openRouterCatalogEntry(modelId);
  if (catalog === undefined) throw new RangeError(`unknown OpenRouter model: ${modelId}`);
  const selectedEffort = effort ?? catalog.defaultEffort;
  if (!catalog.efforts.includes(selectedEffort)) {
    throw new RangeError(`unsupported effort for ${modelId}: ${selectedEffort}`);
  }
  return Object.freeze({ provider: 'openrouter', modelId, effort: selectedEffort });
};

export const searchOpenRouterModels = (
  query: string,
): readonly OpenRouterModelCatalogEntry[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return OPENROUTER_MODEL_CATALOG;
  return Object.freeze(
    OPENROUTER_MODEL_CATALOG.filter((candidate) =>
      candidate.modelId.toLocaleLowerCase().includes(normalized)
    ),
  );
};

const profileComponent = (value: string): string =>
  value.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '-');

export const openRouterProfileFor = (
  selection: OpenRouterModelSelection,
  maxCompletionTokens = 65_536,
): OpenRouterAgentProfile => {
  if (!isOpenRouterModelSelection(selection)) throw new RangeError('invalid OpenRouter selection');
  return Object.freeze({
    id: `openrouter-${profileComponent(selection.modelId)}-${selection.effort}-v1`,
    model: selection.modelId,
    origin: 'https://openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    secretEnv: 'HENJI_OPENROUTER_API_KEY',
    maxCompletionTokens,
    stream: false,
    ...(selection.effort === 'auto' ? {} : { reasoningEffort: selection.effort }),
  });
};
