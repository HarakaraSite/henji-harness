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
import { bundledDefaultDeclarationFor } from './provider_defaults.ts';

export type OpenRouterReasoningEffort = ReasoningEffort;

export type OpenRouterExplicitReasoningEffort = Exclude<OpenRouterReasoningEffort, 'auto'>;

export type { ModelSelection, OpenRouterModelSelection } from './model_selection.ts';

export interface OpenRouterModelCatalogEntry {
  readonly modelId: string;
  readonly defaultEffort: OpenRouterReasoningEffort;
  readonly efforts: readonly OpenRouterReasoningEffort[];
}

const bundledOpenRouter = bundledDefaultDeclarationFor('openrouter')!;

/** Bundled default catalog; no provider request is needed to open the picker. */
export const OPENROUTER_MODEL_CATALOG: readonly OpenRouterModelCatalogEntry[] =
  bundledOpenRouter.modelCatalog.entries;

export const ROOT_DEFAULT_MODEL_ID = bundledOpenRouter.defaults.modelId;
export const ROOT_DEFAULT_EFFORT: OpenRouterReasoningEffort = bundledOpenRouter.defaults.effort;

export const ROOT_DEFAULT_MODEL_SELECTION: OpenRouterModelSelection = Object.freeze({
  provider: 'openrouter',
  api: 'openrouter-chat-completions',
  authProfile: 'openrouter-api-key',
  modelId: ROOT_DEFAULT_MODEL_ID,
  effort: ROOT_DEFAULT_EFFORT,
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

/** Profile for a declared OpenAI-compatible Chat Completions provider. */
export const openRouterProfileForDeclaredChat = (
  providerId: string,
  modelId: string,
  effort: ReasoningEffort,
  endpoint: string,
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
