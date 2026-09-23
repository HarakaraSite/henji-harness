import type { OpenRouterAgentProfile } from './openrouter_contract.ts';
import {
  type OpenRouterModelSelection,
  type OpenRouterResponsesModelSelection,
  type ReasoningEffort,
} from './model_selection.ts';
import { MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS } from '../../resource_limits.ts';
import {
  isModelSelection,
  modelCatalogEntryFor,
  searchModelsFor,
  selectModelFor,
} from './model_catalog.ts';
import { bundledDefaultDeclarationFor } from './provider_defaults.ts';

export type OpenRouterReasoningEffort = ReasoningEffort;

export type OpenRouterExplicitReasoningEffort = Exclude<OpenRouterReasoningEffort, 'auto'>;

export type { ModelSelection, OpenRouterModelSelection } from './model_selection.ts';

export interface OpenRouterModelCatalogEntry {
  readonly modelId: string;
  readonly defaultEffort: OpenRouterReasoningEffort;
  readonly efforts: readonly OpenRouterReasoningEffort[];
}

const bundledOpenRouter = bundledDefaultDeclarationFor('openrouter-chat')!;

/** Bundled default catalog; no provider request is needed to open the picker. */
export const OPENROUTER_MODEL_CATALOG: readonly OpenRouterModelCatalogEntry[] =
  bundledOpenRouter.modelCatalog.entries;

export const ROOT_DEFAULT_MODEL_ID = bundledOpenRouter.defaults.modelId;
export const ROOT_DEFAULT_EFFORT: OpenRouterReasoningEffort = bundledOpenRouter.defaults.effort;

export const ROOT_DEFAULT_MODEL_SELECTION: OpenRouterModelSelection = Object.freeze({
  provider: 'openrouter-chat',
  api: 'openrouter-chat-completions',
  authProfile: 'openrouter-api-key',
  modelId: ROOT_DEFAULT_MODEL_ID,
  effort: ROOT_DEFAULT_EFFORT,
});

export const openRouterCatalogEntry = (
  modelId: string,
): OpenRouterModelCatalogEntry | undefined => modelCatalogEntryFor('openrouter-chat', modelId);

export const isOpenRouterModelSelection = (
  value: unknown,
): value is OpenRouterModelSelection => {
  return isModelSelection(value) && value.provider === 'openrouter-chat';
};

export const selectOpenRouterModel = (
  modelId: string,
  effort?: OpenRouterReasoningEffort,
): OpenRouterModelSelection => {
  return selectModelFor('openrouter-chat', modelId, effort) as OpenRouterModelSelection;
};

export const isOpenRouterResponsesModelSelection = (
  value: unknown,
): value is OpenRouterResponsesModelSelection => {
  return isModelSelection(value) && value.provider === 'openrouter-responses';
};

export const selectOpenRouterResponsesModel = (
  modelId: string,
  effort?: OpenRouterReasoningEffort,
): OpenRouterResponsesModelSelection => {
  return selectModelFor(
    'openrouter-responses',
    modelId,
    effort,
  ) as OpenRouterResponsesModelSelection;
};

export const searchOpenRouterModels = (
  query: string,
): readonly OpenRouterModelCatalogEntry[] => {
  return searchModelsFor('openrouter-chat', query);
};

const profileComponent = (value: string): string =>
  value.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '-');

/** Profile for a declared OpenAI-compatible Chat Completions provider. */
export const openRouterProfileForDeclaredChat = (
  providerId: string,
  modelId: string,
  effort: ReasoningEffort,
  endpoint: string,
  headers?: Readonly<Record<string, string>>,
  maxCompletionTokens = MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS,
): OpenRouterAgentProfile =>
  Object.freeze({
    id: `${profileComponent(providerId)}-${profileComponent(modelId)}-${effort}-v1`,
    model: modelId,
    origin: endpoint.replace(/\/+$/u, ''),
    path: '/chat/completions',
    method: 'POST',
    secretEnv: 'HENJI_OPENROUTER_API_KEY',
    maxCompletionTokens,
    stream: false,
    reasoningEffortField: 'reasoning_effort',
    ...(effort === 'auto' ? {} : { reasoningEffort: effort }),
    ...(headers === undefined ? {} : { requestHeaders: headers }),
  });

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
