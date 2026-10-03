import type { CredentialSource, CredentialSourceContext } from './openrouter_contract.ts';
import {
  credentialFileFor,
  credentialFilePresenceAt,
  readCredentialFileAt,
} from './credential_file.ts';
import {
  type ChatGPTAuthFact,
  type ChatGPTAuthService,
  createChatGPTAuthService,
  resolveChatGPTCredential,
} from './chatgpt_auth.ts';
import type { AuthProfileId } from './model_selection.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const chatGPTRequestFactsPath = (configRoot: string): string =>
  `${configRoot}/chatgpt/requests.jsonl`;

const appendChatGPTRequestFact = async (
  configRoot: string,
  registrationId: string | undefined,
  context: CredentialSourceContext | undefined,
  fact: ChatGPTAuthFact,
): Promise<void> => {
  const kinds = ['request', 'response', 'failure', 'parse_failure'] as const;
  const row = {
    ...(typeof fact.kind === 'string' &&
        (kinds as readonly string[]).includes(fact.kind)
      ? { kind: fact.kind }
      : {}),
    provider: 'openai-chatgpt',
    ...(registrationId === undefined ? {} : { registrationId }),
    ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    ...(context?.modelId === undefined ? {} : { modelId: context.modelId }),
    ...(context?.modelStep === undefined ? {} : { modelStep: context.modelStep }),
    ...(typeof fact.api === 'string' ? { api: fact.api } : {}),
    ...(Number.isSafeInteger(fact.requestOrder) ? { requestOrder: fact.requestOrder } : {}),
    ...(typeof fact.method === 'string' ? { method: fact.method } : {}),
    ...(Number.isSafeInteger(fact.httpStatus) ? { httpStatus: fact.httpStatus } : {}),
    ...(typeof fact.error === 'string' ? { error: fact.error } : {}),
    ...(typeof fact.field === 'string' ? { field: fact.field } : {}),
    ...(typeof fact.valueShape === 'string' ? { valueShape: fact.valueShape } : {}),
  };
  const path = chatGPTRequestFactsPath(configRoot);
  const directory = path.slice(0, path.lastIndexOf('/'));
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await Deno.open(path, {
    append: true,
    create: true,
    write: true,
    mode: 0o600,
  });
  try {
    await Deno.chmod(path, 0o600);
    await file.lock(true);
    const bytes = new TextEncoder().encode(`${JSON.stringify(row)}\n`);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = await file.write(bytes.subarray(offset));
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error('chatgpt request fact write failed');
      }
      offset += written;
    }
  } finally {
    try {
      await file.unlock();
    } finally {
      file.close();
    }
  }
};

interface CredentialResolver {
  resolve(
    profile: AuthProfileId,
    registrationId?: string | null,
    context?: CredentialSourceContext,
  ): Promise<string | undefined>;
  presence(
    profile: AuthProfileId,
    registrationId?: string | null,
  ): Promise<'present' | 'missing' | 'unknown'>;
}

interface CredentialResolverOptions {
  /** Explicit Worker-local sources by auth profile; unlisted profiles use the fixed file default. */
  readonly sources?: Readonly<Record<string, CredentialSource>>;
  /** User config root shared with Core and every Worker. */
  readonly configRoot?: string;
  /** Shared auth service seam for isolated runtimes and tests. */
  readonly chatgptAuth?: ChatGPTAuthService;
  /** Isolated OAuth refresh transport; production uses the global fetch. */
  readonly chatgptFetcher?: typeof fetch;
}

/** Worker-local resolver. Callers name a non-secret profile; values never leave the adapter. */
export const createCredentialResolver = (
  options: CredentialResolverOptions = {},
): CredentialResolver => {
  const sources = options.sources ?? {};
  let chatgptAuth = options.chatgptAuth;
  const chatgpt = (): ChatGPTAuthService =>
    chatgptAuth ??= createChatGPTAuthService({
      ...(options.configRoot === undefined ? {} : { configRoot: options.configRoot }),
    });
  return Object.freeze({
    async resolve(
      profile: AuthProfileId,
      registrationId?: string | null,
      context?: CredentialSourceContext,
    ): Promise<string | undefined> {
      const source = sources[profile];
      if (source !== undefined) {
        try {
          return await source();
        } catch {
          return undefined;
        }
      }
      if (profile === 'openai-chatgpt') {
        if (registrationId === null) return undefined;
        if (options.chatgptAuth !== undefined) {
          return (await options.chatgptAuth.resolve(registrationId))
            .accessToken;
        }
        const selectedRegistrationId = registrationId ??
          await chatgpt().selectedRegistrationId();
        const configRoot = options.configRoot ??
          resolveRuntimePaths().configRoot;
        return (await resolveChatGPTCredential({
          configRoot,
          ...(options.chatgptFetcher === undefined ? {} : { fetcher: options.chatgptFetcher }),
          ...(selectedRegistrationId === undefined
            ? {}
            : { registrationId: selectedRegistrationId }),
          reportFact: (fact) =>
            appendChatGPTRequestFact(
              configRoot,
              selectedRegistrationId,
              context,
              fact,
            ),
        })).accessToken;
      }
      try {
        return await readCredentialFileAt(
          credentialFileFor(profile, options.configRoot),
        );
      } catch {
        return undefined;
      }
    },
    async presence(
      profile: AuthProfileId,
      registrationId?: string | null,
    ): Promise<'present' | 'missing' | 'unknown'> {
      if (sources[profile] !== undefined) return 'unknown';
      if (profile === 'openai-chatgpt') {
        if (registrationId === null) return 'missing';
        return await chatgpt().presence(registrationId);
      }
      return await credentialFilePresenceAt(
        credentialFileFor(profile, options.configRoot),
      );
    },
  });
};
