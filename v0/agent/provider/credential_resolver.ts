import type { CredentialSource } from './openrouter_contract.ts';
import { readCredentialFileFor } from './credential_file.ts';
import type { AuthProfileId } from './model_selection.ts';

export interface CredentialResolver {
  resolve(profile: AuthProfileId): Promise<string | undefined>;
}

export interface CredentialResolverOptions {
  /** Explicit Worker-local sources by auth profile; unlisted profiles use the fixed file default. */
  readonly sources?: Readonly<Record<string, CredentialSource>>;
}

/** Worker-local resolver. Callers name a non-secret profile; values never leave the adapter. */
export const createCredentialResolver = (
  options: CredentialResolverOptions = {},
): CredentialResolver => {
  const sources = options.sources ?? {};
  return Object.freeze({
    async resolve(profile: AuthProfileId): Promise<string | undefined> {
      try {
        const source = sources[profile];
        return source === undefined ? await readCredentialFileFor(profile) : await source();
      } catch {
        return undefined;
      }
    },
  });
};
