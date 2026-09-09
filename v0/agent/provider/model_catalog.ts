import {
  isOpenRouterModelSelection,
  ROOT_DEFAULT_MODEL_SELECTION,
} from './openrouter_model_catalog.ts';
import { isOpenAIModelSelection, OPENAI_DEFAULT_MODEL_SELECTION } from './openai_model_catalog.ts';
import type { ModelSelection, ProviderId } from './model_selection.ts';

export const isModelSelection = (value: unknown): value is ModelSelection =>
  isOpenRouterModelSelection(value) || isOpenAIModelSelection(value);

export const defaultModelSelectionFor = (provider: ProviderId): ModelSelection =>
  provider === 'openai' ? OPENAI_DEFAULT_MODEL_SELECTION : ROOT_DEFAULT_MODEL_SELECTION;
