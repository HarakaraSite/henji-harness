import type { ProviderDeclarationV1 } from './provider_declaration.ts';
import { builtinProviderDeclarations } from './provider_declaration.ts';

const providers = builtinProviderDeclarations();

export const bundledDefaultDeclarationFor = (
  providerId: string,
): ProviderDeclarationV1 | undefined =>
  providers.find((declaration) => declaration.providerId === providerId);
