import {
  LiveModelCatalog,
  type LiveModelCatalogFact,
} from '../../v0/agent/provider/live_model_catalog.ts';
import type { ProviderDeclarationV1 } from '../../v0/agent/provider/provider_declaration.ts';
import { credentialFileFor } from '../../v0/agent/provider/credential_file.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const withLoopback = async (
  handler: (request: Request) => Response | Promise<Response>,
  run: (origin: string) => Promise<void>,
): Promise<void> => {
  let resolveAddress!: (address: Deno.NetAddr) => void;
  const listening = new Promise<Deno.NetAddr>((resolve) => resolveAddress = resolve);
  const server = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    onListen: (address) => resolveAddress(address),
  }, handler);
  try {
    const address = await listening;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await server.shutdown();
  }
};

const withConfig = async (
  profile: string,
  run: (configRoot: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-157-' });
  const configRoot = `${root}/config/henji-harness`;
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeFile(
    credentialFileFor(profile, configRoot),
    new TextEncoder().encode('increment-157-dummy-credential'),
    { mode: 0o600 },
  );
  try {
    await run(configRoot);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

const declaration = (
  providerId: string,
  endpoint: string,
  profile: string,
  entries: ProviderDeclarationV1['modelCatalog']['entries'],
  additions: Partial<ProviderDeclarationV1> = {},
): ProviderDeclarationV1 => ({
  schemaVersion: 1,
  providerId,
  protocol: 'openai-chat-completions',
  endpoint,
  authProfile: profile,
  modelCatalog: { kind: 'fixed', entries },
  defaults: {
    modelId: entries[0]?.modelId ?? 'default-model',
    effort: entries[0]?.defaultEffort ?? 'auto',
  },
  ...additions,
});

const model = (
  catalog: Awaited<ReturnType<LiveModelCatalog['models']>>,
  modelId: string,
) => catalog.models.find((item) => item.modelId === modelId)!;

Deno.test('Increment 157 fetches the OpenRouter list and public metadata, seeds and orders favorites', async () => {
  await withLoopback((request) => {
    const url = new URL(request.url);
    if (url.pathname === '/metadata') {
      return Response.json({
        openrouter: {
          models: {
            'seed-old': {
              reasoning_options: [{
                type: 'effort',
                values: ['default', null, 'none', 'low', 'high'],
              }],
            },
            'seed-new': {
              reasoning_options: [{
                type: 'effort',
                values: ['medium', 'high'],
              }],
            },
            fresh: {
              reasoning_options: [{
                type: 'effort',
                values: ['low', 'high'],
                default: null,
              }],
            },
          },
        },
      });
    }
    assertEquals(url.pathname, '/v1/models');
    assertEquals(url.searchParams.get('sort'), 'newest');
    return Response.json({
      data: [
        { id: 'seed-old', name: 'Seed old', created: 10 },
        { id: 'fresh', name: 'Fresh model', created: 5 },
        { id: 'seed-new', name: 'Seed new', created: 20 },
        { id: 'recent', created: 30 },
        { id: 'unknown-date-a' },
        { id: 'unknown-date-b' },
      ],
    });
  }, async (origin) => {
    await withConfig('increment157-openrouter-key', async (configRoot) => {
      const requestFacts: Array<{ path: string; authorization?: string }> = [];
      const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        requestFacts.push({
          path: url.pathname,
          authorization: new Headers(init?.headers).get('authorization') ??
            undefined,
        });
        return await fetch(input, init);
      };
      const metadataUrl = `${origin}/metadata`;
      await Deno.writeTextFile(
        `${configRoot}/model-metadata.json`,
        JSON.stringify({ url: metadataUrl }),
      );
      const provider = declaration(
        'openrouter-chat',
        `${origin}/v1`,
        'increment157-openrouter-key',
        [
          {
            modelId: 'seed-old',
            defaultEffort: 'high',
            efforts: ['auto', 'low', 'high'],
          },
          {
            modelId: 'seed-new',
            defaultEffort: 'medium',
            efforts: ['auto', 'medium', 'high'],
          },
        ],
      );
      const catalog = new LiveModelCatalog({
        configRoot,
        declarations: [provider],
        fetcher,
      });
      const first = await catalog.models(provider.providerId);
      assertEquals(requestFacts.length, 2);
      assert(
        requestFacts.some((item) =>
          item.path === '/v1/models' &&
          item.authorization === 'Bearer increment-157-dummy-credential'
        ),
      );
      assert(
        requestFacts.some((item) => item.path === '/metadata' && item.authorization === undefined),
      );
      assertEquals(first.metadataStatus, 'loaded');
      assertEquals(first.models.map((item) => item.modelId), [
        'seed-new',
        'seed-old',
        'recent',
        'fresh',
        'unknown-date-a',
        'unknown-date-b',
      ]);
      assertEquals(model(first, 'seed-old').efforts, [
        'auto',
        'none',
        'low',
        'high',
      ]);
      assertEquals(model(first, 'seed-old').favorite, true);
      assertEquals(model(first, 'fresh').favorite, false);

      const initialFacts = catalog.facts;
      const modelFact = initialFacts.find((fact) => fact.api === 'models')!;
      const metadataFact = initialFacts.find((fact) => fact.api === 'models.dev')!;
      assert(modelFact.requestOrder !== metadataFact.requestOrder);
      assert(modelFact.occurredAt.includes('T'));
      assert(metadataFact.occurredAt.includes('T'));
      assert(
        initialFacts.every((fact: LiveModelCatalogFact) => !('authorization' in fact)),
      );

      const unknown = await catalog.efforts(
        provider.providerId,
        'private-alias',
        'low',
      );
      assertEquals(unknown.source, 'unknown');
      assertEquals(unknown.efforts, ['auto', 'low']);

      const favorited = await catalog.favorite(
        provider.providerId,
        'fresh',
        true,
      );
      assertEquals(model(favorited, 'fresh').favorite, true);
      assertEquals(model(favorited, 'fresh').efforts, ['auto', 'low', 'high']);
      const unfavorited = await catalog.favorite(
        provider.providerId,
        'seed-old',
        false,
      );
      assertEquals(model(unfavorited, 'seed-old').favorite, false);
      await catalog.remember(provider.providerId, 'fresh', 'high');
      assertEquals(
        await catalog.defaultEffort(provider.providerId, 'fresh'),
        'high',
      );
      assert(
        requestFacts.length === 2,
        'favorite and effort reads must reuse the prior snapshot',
      );

      const restartFetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/metadata') {
          return new Response('unavailable', { status: 503 });
        }
        return await fetch(input, init);
      };
      const restarted = new LiveModelCatalog({
        configRoot,
        declarations: [provider],
        fetcher: restartFetcher,
      });
      const afterRestart = await restarted.models(provider.providerId);
      assertEquals(afterRestart.metadataStatus, 'unavailable');
      assertEquals(model(afterRestart, 'fresh').favorite, true);
      assertEquals(model(afterRestart, 'seed-old').favorite, false);
      assertEquals(model(afterRestart, 'fresh').defaultEffort, 'high');
      const fallback = await restarted.efforts(provider.providerId, 'fresh');
      assertEquals(fallback.source, 'catalog');
      assertEquals(fallback.efforts, ['auto', 'low', 'high']);
    });
  });
});

Deno.test('Increment 157 maps an external provider to models.dev and honors its explicit effort override', async () => {
  await withLoopback((request) => {
    const url = new URL(request.url);
    if (url.pathname === '/metadata') {
      assertEquals(request.headers.get('authorization'), null);
      assertEquals(request.headers.get('x-session-id'), null);
      return Response.json({
        'external-catalog': {
          models: {
            fixed: { reasoning_options: [{ type: 'effort', values: ['low'] }] },
            dynamic: {
              reasoning_options: [{
                type: 'effort',
                values: ['medium', 'high'],
              }],
            },
          },
        },
      });
    }
    assertEquals(url.pathname, '/v1/models');
    assertEquals(request.headers.get('authorization'), null);
    assertEquals(request.headers.get('x-session-id'), 'session-157');
    assertEquals(
      request.headers.get('x-api-key'),
      'increment-157-dummy-credential',
    );
    return Response.json({
      data: [{ id: 'fixed', created: 1 }, { id: 'dynamic', created: 2 }],
    });
  }, async (origin) => {
    await withConfig('increment157-external-key', async (configRoot) => {
      const provider = declaration(
        'increment157-external',
        `${origin}/v1`,
        'increment157-external-key',
        [{ modelId: 'fixed', defaultEffort: 'high', efforts: ['high', 'low'] }],
        {
          catalogSource: 'external',
          modelsDevProviderId: 'external-catalog',
          headers: {
            'x-api-key': '{credential}',
            'x-session-id': '{sessionId}',
          },
        },
      );
      const catalog = new LiveModelCatalog({
        configRoot,
        declarations: [provider],
        metadataUrl: `${origin}/metadata`,
      });
      const listed = await catalog.models(provider.providerId, 'session-157');
      assertEquals(listed.metadataStatus, 'loaded');
      assertEquals(model(listed, 'fixed').efforts, ['auto', 'high', 'low']);
      assertEquals(model(listed, 'dynamic').efforts, [
        'auto',
        'medium',
        'high',
      ]);
      await catalog.remember(provider.providerId, 'fixed', 'none');
      await catalog.remember(provider.providerId, 'dynamic', 'none');
      const fixedEfforts = await catalog.efforts(
        provider.providerId,
        'fixed',
        'none',
      );
      const dynamicEfforts = await catalog.efforts(
        provider.providerId,
        'dynamic',
        'none',
      );
      assertEquals(fixedEfforts.source, 'override');
      assertEquals(fixedEfforts.efforts, ['auto', 'high', 'low']);
      assertEquals(dynamicEfforts.source, 'models.dev');
      assertEquals(dynamicEfforts.efforts, ['auto', 'medium', 'high']);
      const fixedReadback = await catalog.favorite(
        provider.providerId,
        'fixed',
        true,
      );
      const dynamicReadback = await catalog.favorite(
        provider.providerId,
        'dynamic',
        true,
      );
      assertEquals(model(fixedReadback, 'fixed').defaultEffort, 'none');
      assertEquals(model(fixedReadback, 'fixed').efforts, [
        'auto',
        'high',
        'low',
      ]);
      assertEquals(model(dynamicReadback, 'dynamic').defaultEffort, 'none');
      assertEquals(model(dynamicReadback, 'dynamic').efforts, [
        'auto',
        'medium',
        'high',
      ]);
    });
  });
});

Deno.test('E6 catalog read begun before another Core saves receives a complete JSON document', async () => {
  const configRoot = await Deno.makeTempDir({ prefix: 'henji-e6-shared-catalog-' });
  const declaration: ProviderDeclarationV1 = {
    schemaVersion: 1,
    providerId: 'shared-provider',
    protocol: 'openai-responses',
    endpoint: 'http://127.0.0.1/v1',
    authProfile: 'shared-key',
    modelCatalog: {
      kind: 'fixed',
      entries: [{
        modelId: 'shared-model',
        defaultEffort: 'low',
        efforts: ['auto', 'low', 'high'],
      }],
    },
    defaults: { modelId: 'shared-model', effort: 'low' },
  };
  const writer = new LiveModelCatalog({ configRoot, declarations: [declaration] });
  await writer.defaultEffort(declaration.providerId, 'shared-model');
  const path = `${configRoot}/model-catalogs/shared-provider.json`;
  const original = await Deno.readTextFile(path);
  const match = /"defaultEffort"\s*:\s*"low"/.exec(original)!;
  // Suspend the reader inside a value; a save must publish a whole document for other readers.
  const splitAt = match.index + match[0].indexOf('low') + 1;
  const file = await Deno.open(path, { read: true });
  const prefix = new Uint8Array(splitAt);
  try {
    let read = 0;
    while (read < prefix.length) read += (await file.read(prefix.subarray(read)))!;
    await writer.remember(declaration.providerId, 'shared-model', 'high');
    const pieces = [new TextDecoder().decode(prefix)];
    const buffer = new Uint8Array(1024);
    for (;;) {
      const length = await file.read(buffer);
      if (length === null) break;
      pieces.push(new TextDecoder().decode(buffer.subarray(0, length)));
    }
    const document = JSON.parse(pieces.join(''));
    assertEquals(document.models['shared-model'].defaultEffort, 'low');
    assertEquals(await writer.defaultEffort(declaration.providerId, 'shared-model'), 'high');
  } finally {
    file.close();
    await Deno.remove(configRoot, { recursive: true });
  }
});
