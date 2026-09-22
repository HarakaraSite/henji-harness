import rawDefaults from './defaults/provider-defaults.json' with { type: 'json' };
import { type ReasoningEffort } from './model_selection.ts';
import type { ProviderDeclarationV1 } from './provider_declaration.ts';

const providers = Object.freeze(
  (rawDefaults as unknown as { readonly providers: readonly ProviderDeclarationV1[] }).providers,
);

/** Bundled default provider declarations shipped as data with the binary. */
export const bundledDefaultDeclarations = (): readonly ProviderDeclarationV1[] => providers;

export const bundledDefaultDeclarationFor = (
  providerId: string,
): ProviderDeclarationV1 | undefined =>
  providers.find((declaration) => declaration.providerId === providerId);

/**
 * One bundled slot default (model route) for a named agent lane. This is the data source for
 * role defaults; it is independent of the root provider `defaults` and limited to known providers.
 */
export interface BundledRoleDefaultV1 {
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: ReasoningEffort;
}

const EFFORTS: readonly ReasoningEffort[] = Object.freeze([
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const isRoleDefault = (value: unknown): value is BundledRoleDefaultV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 3 &&
    typeof entry.providerId === 'string' && entry.providerId.length > 0 &&
    typeof entry.modelId === 'string' && entry.modelId.length > 0 &&
    typeof entry.effort === 'string' && EFFORTS.includes(entry.effort as ReasoningEffort);
};

const parseRoleDefaults = (value: unknown): Readonly<Record<string, BundledRoleDefaultV1>> => {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('bundled roleDefaults is not an object');
  }
  const result: Record<string, BundledRoleDefaultV1> = {};
  for (const [slot, entry] of Object.entries(value)) {
    if (!isRoleDefault(entry)) {
      throw new Error(`bundled roleDefaults entry is invalid: ${slot}`);
    }
    result[slot] = Object.freeze({
      providerId: entry.providerId,
      modelId: entry.modelId,
      effort: entry.effort,
    });
  }
  return Object.freeze(result);
};

const roleDefaults = parseRoleDefaults(
  (rawDefaults as unknown as { readonly roleDefaults?: unknown }).roleDefaults,
);

export const bundledRoleDefaultFor = (slot: string): BundledRoleDefaultV1 | undefined =>
  roleDefaults[slot];
