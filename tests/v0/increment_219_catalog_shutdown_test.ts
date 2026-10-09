import { strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';

const within = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('catalog shutdown did not complete')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

Deno.test('Increment 219 Core shutdown cancels catalog HTTP waits before draining operations', async (t) => {
  for (const phase of ['response headers', 'response body'] as const) {
    await t.step(phase, async () => {
      const root = await Deno.makeTempDir({ prefix: 'henji-219-catalog-shutdown-' });
      const credentialRoot = `${root}/credentials`;
      await Deno.mkdir(credentialRoot);
      await Deno.writeTextFile(`${credentialRoot}/openrouter-api-key`, 'localhost-test-key');
      const held = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      let pendingHeaders = 0;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const provider = Deno.serve(
        { hostname: '127.0.0.1', port: 0, onListen() {} },
        async (request) => {
          const metadata = new URL(request.url).pathname === '/metadata';
          if (phase === 'response headers') {
            if (++pendingHeaders === 2) started.resolve();
            await held.promise;
          } else if (metadata) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  bodyController = controller;
                  controller.enqueue(new TextEncoder().encode('{'));
                },
                cancel() {
                  bodyController = undefined;
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          }
          return Response.json(metadata ? {} : { data: [{ id: 'localhost-model' }] });
        },
      );
      const origin = `http://127.0.0.1:${(provider.addr as Deno.NetAddr).port}`;
      let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
      let catalog: Promise<void> | undefined;
      try {
        const core = await createCoreService({
          workspaceRoot: root,
          configRoot: `${root}/config`,
          dataRoot: `${root}/data`,
          stateRoot: `${root}/state`,
          credentialRoot,
          physicalIoMode: 'provider-free',
          providerDeclarations: builtinProviderDeclarations().map((declaration) =>
            declaration.providerId === 'openrouter-chat'
              ? { ...declaration, endpoint: origin }
              : declaration
          ),
          modelsMetadataUrl: `${origin}/metadata`,
          catalogFetcher: async (input, init) => {
            const response = await fetch(input, init);
            if (phase === 'response body' && String(input).endsWith('/metadata')) {
              started.resolve();
            }
            return response;
          },
        });
        server = await startCoreServer(core);
        const client = new HenjiApiClient(server.url);
        let catalogSettled = false;
        catalog = client.catalogRead({ kind: 'models', provider: 'openrouter-chat' })
          .then(() => {}, () => {})
          .then(() => {
            catalogSettled = true;
          });
        await within(started.promise);
        strictEqual(catalogSettled, false);
        const shutdown = await within(client.coreShutdown({ commandId: crypto.randomUUID() }));
        strictEqual(shutdown.kind, 'accepted');
        await within(server.finished);
        await within(catalog);
        strictEqual(catalogSettled, true);
      } finally {
        // Release the localhost responses only after testing Core completion.
        held.resolve();
        bodyController?.close();
        await server?.shutdown();
        await catalog;
        await provider.shutdown();
        await Deno.remove(root, { recursive: true });
      }
    });
  }
});
