import type { CredentialSource } from './openrouter_contract.ts';
import { readCredentialFile, readOpenAICredentialFile } from './credential_file.ts';
import type { AuthProfileId } from './model_selection.ts';

export interface CredentialResolver {
  resolve(profile: AuthProfileId): Promise<string | undefined>;
}

export interface CredentialResolverOptions {
  readonly openRouter?: CredentialSource;
  readonly openAI?: CredentialSource;
}

/** Worker-local resolver. Callers name a non-secret profile; values never leave the adapter. */
export const createCredentialResolver = (
  options: CredentialResolverOptions = {},
): CredentialResolver => {
  const sources: Readonly<Record<AuthProfileId, CredentialSource>> = Object.freeze({
    'openrouter-api-key': options.openRouter ?? readCredentialFile,
    'openai-api-key': options.openAI ?? readOpenAICredentialFile,
  });
  return Object.freeze({
    async resolve(profile: AuthProfileId): Promise<string | undefined> {
      try {
        return await sources[profile]();
      } catch {
        return undefined;
      }
    },
  });
};
