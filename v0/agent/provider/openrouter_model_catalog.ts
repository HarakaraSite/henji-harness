import type { OpenRouterAgentProfile } from './openrouter_contract.ts';
import {
  type OpenRouterModelSelection,
  type OpenRouterResponsesModelSelection,
  openRouterResponsesStoredSelection,
  openRouterStoredSelection,
  type ReasoningEffort,
} from './model_selection.ts';
import { MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS } from '../../resource_limits.ts';
import { declarationFor } from './provider_runtime.ts';

export type OpenRouterReasoningEffort = ReasoningEffort;

export type OpenRouterExplicitReasoningEffort = Exclude<OpenRouterReasoningEffort, 'auto'>;

export type { ModelSelection, OpenRouterModelSelection } from './model_selection.ts';

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
  entry('deepseek/deepseek-v4.1-flash', 'high', ['auto', 'max', 'high', 'low']),
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

export const ROOT_DEFAULT_MODEL_ID = 'deepseek/deepseek-v4.1-flash';
export const ROOT_DEFAULT_EFFORT: OpenRouterReasoningEffort = 'high';
export const PLANNER_DEFAULT_MODEL_ID = 'deepseek/deepseek-v4.1-flash';
export const PLANNER_DEFAULT_EFFORT: OpenRouterReasoningEffort = 'high';

export const ROOT_DEFAULT_MODEL_SELECTION: OpenRouterModelSelection = Object.freeze({
  provider: 'openrouter',
  api: 'openrouter-chat-completions',
  authProfile: 'openrouter-api-key',
  modelId: ROOT_DEFAULT_MODEL_ID,
  effort: ROOT_DEFAULT_EFFORT,
});

export const PLANNER_DEFAULT_MODEL_SELECTION: OpenRouterModelSelection = Object.freeze({
  provider: 'openrouter',
  api: 'openrouter-chat-completions',
  authProfile: 'openrouter-api-key',
  modelId: PLANNER_DEFAULT_MODEL_ID,
  effort: PLANNER_DEFAULT_EFFORT,
});

const openRouterEntries = (): readonly OpenRouterModelCatalogEntry[] =>
  declarationFor('openrouter')?.modelCatalog.entries ?? OPENROUTER_MODEL_CATALOG;

export const openRouterCatalogEntry = (
  modelId: string,
): OpenRouterModelCatalogEntry | undefined =>
  openRouterEntries().find((candidate) => candidate.modelId === modelId);

export const isOpenRouterModelSelection = (
  value: unknown,
): value is OpenRouterModelSelection => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (
    Object.keys(selection).length !== 5 || selection.provider !== 'openrouter' ||
    selection.api !== 'openrouter-chat-completions' ||
    selection.authProfile !== 'openrouter-api-key' ||
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
  return openRouterStoredSelection(modelId, selectedEffort);
};

const responsesCatalogEntry = (
  modelId: string,
): OpenRouterModelCatalogEntry | undefined => {
  const declaration = declarationFor('openrouter-responses');
  if (declaration !== undefined) {
    return declaration.modelCatalog.entries.find((entry) => entry.modelId === modelId);
  }
  return openRouterCatalogEntry(modelId);
};

export const isOpenRouterResponsesModelSelection = (
  value: unknown,
): value is OpenRouterResponsesModelSelection => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (
    Object.keys(selection).length !== 5 || selection.provider !== 'openrouter-responses' ||
    selection.api !== 'openrouter-responses' ||
    selection.authProfile !== 'openrouter-api-key' ||
    typeof selection.modelId !== 'string' || typeof selection.effort !== 'string'
  ) return false;
  const catalog = responsesCatalogEntry(selection.modelId);
  return catalog !== undefined &&
    catalog.efforts.includes(selection.effort as OpenRouterReasoningEffort);
};

export const selectOpenRouterResponsesModel = (
  modelId: string,
  effort?: OpenRouterReasoningEffort,
): OpenRouterResponsesModelSelection => {
  const catalog = responsesCatalogEntry(modelId);
  if (catalog === undefined) throw new RangeError(`unknown OpenRouter model: ${modelId}`);
  const selectedEffort = effort ?? catalog.defaultEffort;
  if (!catalog.efforts.includes(selectedEffort)) {
    throw new RangeError(`unsupported effort for ${modelId}: ${selectedEffort}`);
  }
  return openRouterResponsesStoredSelection(modelId, selectedEffort);
};

export const searchOpenRouterModels = (
  query: string,
): readonly OpenRouterModelCatalogEntry[] => {
  const entries = openRouterEntries();
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return entries;
  return Object.freeze(
    entries.filter((candidate) => candidate.modelId.toLocaleLowerCase().includes(normalized)),
  );
};

const profileComponent = (value: string): string =>
  value.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '-');

export const openRouterProfileFor = (
  selection: OpenRouterModelSelection,
  maxCompletionTokens = MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS,
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
