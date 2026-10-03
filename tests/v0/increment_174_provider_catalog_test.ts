import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient, HenjiApiError } from '../../v0/api/client.ts';

Deno.test('Increment 174 HTTP lists and selects providers before ChatGPT registration', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-174-catalog-' });
  const declarations = builtinProviderDeclarations();
  let providerRequests = 0;
  const noProviderRequests: typeof fetch = () => {
    providerRequests += 1;
    throw new Error('provider discovery does not require a provider request');
  };
  const core = await createCoreService({
    workspaceRoot: root,
    configRoot: `${root}/config`,
    dataRoot: `${root}/data`,
    stateRoot: `${root}/state`,
    physicalIoMode: 'production',
    initialSession: { kind: 'new' },
    providerDeclarations: declarations,
    catalogFetcher: noProviderRequests,
    chatgptFetcher: noProviderRequests,
  });
  const server = await startCoreServer(core);
  const client = new HenjiApiClient(server.url);
  try {
    const providers = await client.catalogRead({ kind: 'providers' });
    strictEqual(providers.kind, 'providers');
    if (providers.kind !== 'providers') throw new Error('Provider catalog expected');
    deepStrictEqual(
      providers.providers.map((entry) => entry.provider),
      declarations.map((entry) => entry.providerId),
    );
    const chatgpt = declarations.find((entry) => entry.providerId === 'openai-chatgpt')!;
    deepStrictEqual(
      providers.providers.find((entry) => entry.provider === chatgpt.providerId)?.defaultSelection,
      {
        provider: chatgpt.providerId,
        modelId: chatgpt.defaults.modelId,
        effort: chatgpt.modelCatalog.entries.find((entry) =>
          entry.modelId === chatgpt.defaults.modelId
        )!.defaultEffort,
      },
    );
    ok(providers.providers.some((entry) => entry.provider === 'openai-responses'));
    const status = await client.chatgptAuth({ kind: 'status' });
    if (status.kind !== 'chatgpt') throw new Error('ChatGPT account state expected');
    deepStrictEqual(status.state.accounts, []);
    await rejects(
      () => client.catalogRead({ kind: 'models', provider: 'openai-chatgpt' }),
      (error: unknown) =>
        error instanceof HenjiApiError &&
        error.status === 502 && error.message === 'chatgpt_selection_missing',
    );
    const sessionId = core.coreRead().activeSessionId!;
    const selection = providers.providers.find((entry) =>
      entry.provider === chatgpt.providerId
    )!.defaultSelection;
    const selected = await client.selectionChange(sessionId, {
      commandId: crypto.randomUUID(),
      selection,
    });
    strictEqual(selected.kind, 'accepted', JSON.stringify(selected));
    const snapshot = await client.sessionRead(sessionId);
    deepStrictEqual(snapshot.session.selection, selection);
    strictEqual(snapshot.credentialAvailability.status, 'missing');
    const openai = providers.providers.find((entry) => entry.provider === 'openai-responses')!;
    strictEqual(
      (await client.selectionChange(sessionId, {
        commandId: crypto.randomUUID(),
        selection: openai.defaultSelection,
      })).kind,
      'accepted',
    );
    deepStrictEqual(
      (await client.sessionRead(sessionId)).session.selection,
      openai.defaultSelection,
    );
    strictEqual(providerRequests, 0);
    const catalogs = [...Deno.readDirSync(`${root}/config/model-catalogs`)];
    ok(!catalogs.some((entry) => entry.name.startsWith('openai-chatgpt')));
  } finally {
    await server.shutdown();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
