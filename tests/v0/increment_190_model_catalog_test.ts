import { deepStrictEqual, strictEqual } from 'node:assert';
import { LiveModelCatalog } from '../../v0/agent/provider/live_model_catalog.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { credentialFileFor } from '../../v0/agent/provider/credential_file.ts';

Deno.test('Increment 190 filters gpt-6.1-sol from the Chat list and favorite updates, keeps Responses', async () => {
  const configRoot = await Deno.makeTempDir({ prefix: 'henji-increment-190-' });
  const inventory = ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-luna'];
  const savedChatCatalog = {
    favorites: ['gpt-6.1-sol'],
    models: { 'gpt-6.1-sol': { defaultEffort: 'high', efforts: ['auto', 'high'] } },
  };
  const fetcher: typeof fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/models') {
      return Promise.resolve(Response.json({ data: inventory.map((id) => ({ id })) }));
    }
    return Promise.resolve(Response.json({
      openai: {
        models: {
          'gpt-6.1-sol': { reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
        },
      },
    }));
  };
  try {
    await Deno.writeTextFile(credentialFileFor('openai-api-key', configRoot), 'dummy-190');
    await Deno.mkdir(`${configRoot}/model-catalogs`);
    const chatCatalogPath = `${configRoot}/model-catalogs/openai-chat.json`;
    await Deno.writeTextFile(chatCatalogPath, JSON.stringify(savedChatCatalog));
    const catalog = new LiveModelCatalog({
      configRoot,
      declarations: builtinProviderDeclarations(),
      fetcher,
    });
    const chat = await catalog.models('openai-chat');
    deepStrictEqual(chat.models.map((entry) => entry.modelId), inventory.slice(1));
    deepStrictEqual(JSON.parse(await Deno.readTextFile(chatCatalogPath)), savedChatCatalog);

    const favorited = await catalog.favorite('openai-chat', 'gpt-5.6-sol', true);
    deepStrictEqual(favorited.models.map((entry) => entry.modelId), inventory.slice(1));
    strictEqual(favorited.models[0].favorite, true);
    const unfavorited = await catalog.favorite('openai-chat', 'gpt-5.6-sol', false);
    deepStrictEqual(unfavorited.models.map((entry) => entry.modelId), inventory.slice(1));
    deepStrictEqual(
      JSON.parse(await Deno.readTextFile(chatCatalogPath)).models['gpt-6.1-sol'],
      savedChatCatalog.models['gpt-6.1-sol'],
    );

    const responses = await catalog.models('openai-responses');
    deepStrictEqual(new Set(responses.models.map((entry) => entry.modelId)), new Set(inventory));
    const sol = responses.models.find((entry) => entry.modelId === 'gpt-6.1-sol')!;
    deepStrictEqual(sol.efforts, ['auto', 'low', 'high']);
    const responseFavorite = await catalog.favorite('openai-responses', 'gpt-6.1-sol', true);
    strictEqual(
      responseFavorite.models.find((entry) => entry.modelId === 'gpt-6.1-sol')?.favorite,
      true,
    );
  } finally {
    await Deno.remove(configRoot, { recursive: true });
  }
});
