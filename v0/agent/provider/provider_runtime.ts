import type { ProviderDeclarationV1 } from './provider_declaration.ts';

let activeDeclarations: readonly ProviderDeclarationV1[] = Object.freeze([]);

/**
 * Install the Host-resolved declarations for the current process. The Host sets this before it
 * builds the selection surface, and each Worker generation sets it from its start command.
 */
export const setActiveProviderDeclarations = (
  declarations: readonly ProviderDeclarationV1[],
): void => {
  activeDeclarations = Object.freeze([...declarations]);
};

export const activeProviderDeclarations = (): readonly ProviderDeclarationV1[] =>
  activeDeclarations;

export const declarationFor = (
  providerId: string,
): ProviderDeclarationV1 | undefined =>
  activeDeclarations.find((declaration) => declaration.providerId === providerId);
