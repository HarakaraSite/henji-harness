import rawDefaults from './defaults/provider-defaults.json' with { type: 'json' };
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
