import {
  BUILTIN_PROVIDER_IDS,
  isStoredModelSelection,
  type ModelSelection,
  type ProviderId,
  type ReasoningEffort,
} from './model_selection.ts';
import type { ProviderCatalogEntryV1, ProviderDeclarationV1 } from './provider_declaration.ts';
import { activeProviderDeclarations, effectiveDeclarationFor } from './provider_runtime.ts';
import { bundledRoleDefaultFor } from './provider_defaults.ts';

export type { ModelSelection, ProviderId, ReasoningEffort } from './model_selection.ts';
export type ProviderModelCatalogEntry = ProviderCatalogEntryV1;

/** Built-in ids followed by declared provider ids. */
export const providerIdsForSelection = (): readonly string[] =>
  Object.freeze([
    ...BUILTIN_PROVIDER_IDS,
    ...new Set(
      activeProviderDeclarations().map((declaration) => declaration.providerId)
        .filter((id) => !BUILTIN_PROVIDER_IDS.includes(id)),
    ),
  ]);

const selectionFor = (
  declaration: ProviderDeclarationV1,
  modelId: string,
  effort: ReasoningEffort,
): ModelSelection => {
  const api = declaration.providerId === 'openrouter-chat'
    ? 'openrouter-chat-completions'
    : declaration.providerId === 'openrouter-responses'
    ? 'openrouter-responses'
    : declaration.protocol;
  return Object.freeze({
    provider: declaration.providerId,
    api,
    authProfile: declaration.authProfile,
    modelId,
    effort,
  }) as ModelSelection;
};

/** Current catalog validation; persisted decode remains independent of active declarations. */
export const isModelSelection = (value: unknown): value is ModelSelection => {
  if (!isStoredModelSelection(value)) return false;
  const declaration = effectiveDeclarationFor(value.provider);
  if (declaration === undefined) return false;
  const entry = declaration.modelCatalog.entries.find((item) => item.modelId === value.modelId);
  if (entry === undefined || !entry.efforts.includes(value.effort)) return false;
  const expected = selectionFor(declaration, value.modelId, value.effort);
  return value.api === expected.api && value.authProfile === expected.authProfile;
};

export const defaultModelSelectionFor = (provider: ProviderId): ModelSelection => {
  const declaration = effectiveDeclarationFor(provider);
  if (declaration === undefined) throw new RangeError(`unknown provider: ${provider}`);
  return selectionFor(declaration, declaration.defaults.modelId, declaration.defaults.effort);
};

export const modelCatalogEntryFor = (
  provider: ProviderId,
  modelId: string,
): ProviderModelCatalogEntry | undefined =>
  effectiveDeclarationFor(provider)?.modelCatalog.entries.find((entry) =>
    entry.modelId === modelId
  );

export const searchModelsFor = (
  provider: ProviderId,
  query: string,
): readonly ProviderModelCatalogEntry[] => {
  const entries = effectiveDeclarationFor(provider)?.modelCatalog.entries ?? [];
  const normalized = query.trim().toLocaleLowerCase();
  return Object.freeze(
    normalized.length === 0
      ? [...entries]
      : entries.filter((entry) => entry.modelId.toLocaleLowerCase().includes(normalized)),
  );
};

/** Resolve a bundled slot default against the active provider catalog. */
export const roleDefaultModelSelection = (slot: string): ModelSelection => {
  const bundled = bundledRoleDefaultFor(slot);
  if (bundled === undefined) throw new RangeError(`no bundled role default for slot: ${slot}`);
  return selectModelFor(bundled.providerId, bundled.modelId, bundled.effort);
};

export const selectModelFor = (
  provider: ProviderId,
  modelId: string,
  effort?: ReasoningEffort,
): ModelSelection => {
  const declaration = effectiveDeclarationFor(provider);
  if (declaration === undefined) throw new RangeError(`unknown provider: ${provider}`);
  const entry = declaration.modelCatalog.entries.find((candidate) => candidate.modelId === modelId);
  if (entry === undefined) throw new RangeError(`unknown model for ${provider}: ${modelId}`);
  const selected = effort ?? entry.defaultEffort;
  if (!entry.efforts.includes(selected)) {
    throw new RangeError(`unsupported effort for ${modelId}: ${selected}`);
  }
  return selectionFor(declaration, modelId, selected);
};
