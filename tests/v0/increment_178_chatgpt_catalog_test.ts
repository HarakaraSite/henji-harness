import { deepStrictEqual, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { createChatGPTAuthService } from '../../v0/agent/provider/chatgpt_auth.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { createMockChatGPTIssuer } from './helpers/increment_163_chatgpt_issuer.ts';

Deno.test('Increment 178 HTTP selects pinned ChatGPT models with official efforts from an existing account catalog', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-178-' });
  const configRoot = `${root}/config`;
  const issuer = await createMockChatGPTIssuer();
  const auth = createChatGPTAuthService({ configRoot, fetcher: issuer.fetcher });
  const attempt = await auth.begin();
  const authorization = new URL(attempt.authorizationUrl);
  await issuer.setNextLogin({
    clientId: 'increment-178-client',
    nonce: authorization.searchParams.get('nonce')!,
    codeChallenge: authorization.searchParams.get('code_challenge')!,
  });
  const callback = new URL(authorization.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({
    code: 'increment-178-mock-code',
    state: authorization.searchParams.get('state')!,
    client_id: 'increment-178-client',
  }).toString();
  const state = await auth.complete(attempt.attemptId, callback.href);
  const registrationId = state.accounts[0].registrationId;
  await auth.close();
  await Deno.mkdir(`${configRoot}/model-catalogs`, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/model-catalogs/openai-chatgpt-${encodeURIComponent(registrationId)}.json`,
    JSON.stringify({ favorites: ['gpt-5.6-sol'], models: {} }),
  );
  // Visible inventory observed on 2026-10-03, before either directly usable model appeared.
  const inventory = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
  let listedSol = false;
  const catalogFetcher: typeof fetch = (input) => {
    if (new URL(String(input)).pathname.endsWith('/models')) {
      const visible = listedSol ? [inventory[0], 'gpt-6.1-sol', ...inventory.slice(1)] : inventory;
      return Promise.resolve(Response.json({
        models: visible.map((slug) => ({ slug, display_name: slug, visibility: 'list' })),
      }));
    }
    return Promise.resolve(Response.json({
      openai: {
        models: {
          'gpt-6.1-sol': { reasoning_options: [{ type: 'effort', values: ['low', 'medium'] }] },
        },
      },
    }));
  };
  const core = await createCoreService({
    workspaceRoot: root,
    configRoot,
    dataRoot: `${root}/data`,
    stateRoot: `${root}/state`,
    physicalIoMode: 'production',
    initialSession: { kind: 'new' },
    providerDeclarations: builtinProviderDeclarations(),
    catalogFetcher,
    chatgptFetcher: issuer.fetcher,
  });
  const server = await startCoreServer(core);
  const client = new HenjiApiClient(server.url);
  try {
    const models = await client.catalogRead({ kind: 'models', provider: 'openai-chatgpt' });
    if (models.kind !== 'models') throw new Error('ChatGPT models expected');
    deepStrictEqual(models.models.map((entry) => entry.modelId), [
      ...inventory,
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]);
    const sessionId = core.coreRead().activeSessionId!;
    for (
      const [modelId, efforts] of [
        ['gpt-6.1-sol', ['auto', 'low', 'medium', 'high', 'xhigh', 'max']],
        ['gpt-6-luna', ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ] as const
    ) {
      const entry: (typeof models.models)[number] = models.models.find((candidate) =>
        candidate.modelId === modelId
      )!;
      strictEqual(entry.defaultEffort, 'medium');
      deepStrictEqual(entry.efforts, efforts);
      const effortCatalog = await client.catalogRead({
        kind: 'efforts',
        provider: 'openai-chatgpt',
        modelId,
      });
      if (effortCatalog.kind !== 'efforts') throw new Error('Efforts expected');
      strictEqual(effortCatalog.source, 'override');
      deepStrictEqual(effortCatalog.efforts, efforts);
      const selection = { provider: 'openai-chatgpt', modelId, effort: entry.defaultEffort };
      strictEqual(
        (await client.selectionChange(sessionId, { commandId: crypto.randomUUID(), selection }))
          .kind,
        'accepted',
      );
      deepStrictEqual((await client.sessionRead(sessionId)).session.selection, selection);
      const favorite = await client.modelFavorite({
        provider: 'openai-chatgpt',
        modelId,
        favorite: true,
      });
      strictEqual(favorite.models.find((entry) => entry.modelId === modelId)?.favorite, true);
      const changed = { ...selection, effort: 'max' };
      strictEqual(
        (await client.selectionChange(sessionId, {
          commandId: crypto.randomUUID(),
          selection: changed,
        })).kind,
        'accepted',
      );
      deepStrictEqual((await client.sessionRead(sessionId)).session.selection, changed);
    }
    listedSol = true;
    const refreshed = await client.catalogRead({ kind: 'models', provider: 'openai-chatgpt' });
    if (refreshed.kind !== 'models') throw new Error('ChatGPT models expected');
    deepStrictEqual(refreshed.models.map((entry) => entry.modelId), [
      inventory[0],
      'gpt-6.1-sol',
      ...inventory.slice(1),
      'gpt-6-luna',
    ]);
    strictEqual(
      refreshed.models.find((entry) => entry.modelId === 'gpt-6-luna')?.defaultEffort,
      'max',
    );
  } finally {
    await server.shutdown();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
