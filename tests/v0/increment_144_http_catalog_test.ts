import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { defaultSelectionPath } from '../../v0/agent/provider/default_selection.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient, HenjiApiError } from '../../v0/api/client.ts';
import type { CommandResult, SessionOpenValue } from '../../v0/api/contract.ts';

const encoder = new TextEncoder();
const frame = (value: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const opened = async (client: HenjiApiClient, result: CommandResult<SessionOpenValue>) => {
  strictEqual(result.kind, 'accepted', JSON.stringify(result));
  if (result.kind !== 'accepted') throw new Error('Session was not opened');
  return await client.sessionRead(result.value.sessionId);
};
const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Slice 6 Core operation');
};
const readStartupStatus = (
  snapshot: Awaited<ReturnType<HenjiApiClient['sessionRead']>>,
) => {
  const startup = snapshot.session.startup;
  ok(
    typeof startup === 'object' && startup !== null && !Array.isArray(startup),
  );
  ok('status' in startup);
  return startup.status;
};

Deno.test('Increment 144 HTTP serves Core catalogs, selection, and credentials', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-slice6-http-' });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) {
    Deno.env.set(key, value);
  }
  const workspaceRoot = `${root}/core-workspace`;
  const configRoot = `${environment.XDG_CONFIG_HOME}/henji-harness`;
  const stateRoot = `${environment.XDG_STATE_HOME}/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(configRoot, { recursive: true });

  let releaseProvider = (): void => {};
  const providerBodies: unknown[] = [];
  let provider: Deno.HttpServer | undefined;
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  try {
    provider = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen() {} },
      async (request) => {
        if (request.method === 'GET') {
          if (new URL(request.url).pathname.endsWith('/models')) {
            return Response.json({
              data: [
                { id: 'new-live-model', name: 'New live model', created: 200 },
                { id: 'deepseek/deepseek-v4.1-flash', created: 100 },
              ],
            });
          }
          return Response.json({
            openrouter: {
              models: {
                'new-live-model': {
                  reasoning_options: [{ type: 'effort', values: [null, 'default', 'low', 'high'] }],
                },
                'deepseek/deepseek-v4.1-flash': {
                  reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
                },
              },
            },
          });
        }
        providerBodies.push(await request.json());
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame({
                type: 'response.output_text.delta',
                delta: 'Slice 6 local Responses result',
              }));
              releaseProvider = () => {
                releaseProvider = () => {};
                controller.enqueue(frame({
                  type: 'response.completed',
                  response: {
                    id: crypto.randomUUID(),
                    output: [{
                      type: 'message',
                      id: crypto.randomUUID(),
                      role: 'assistant',
                      status: 'completed',
                      content: [{
                        type: 'output_text',
                        text: 'Slice 6 local Responses result',
                        annotations: [],
                      }],
                    }],
                  },
                }));
                controller.close();
              };
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );
    const providerDeclarations = builtinProviderDeclarations().map((
      declaration,
    ) =>
      declaration.providerId === 'openrouter-responses'
        ? {
          ...declaration,
          endpoint: `http://127.0.0.1:${(provider!.addr as Deno.NetAddr).port}/v1`,
        }
        : declaration
    );
    const options = {
      workspaceRoot,
      configRoot,
      dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
      stateRoot,
      physicalIoMode: 'production' as const,
      providerDeclarations,
      modelsMetadataUrl: `http://127.0.0.1:${(provider!.addr as Deno.NetAddr).port}/metadata`,
    };
    core = await createCoreService(options);
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);

    const providers = await client.catalogRead({ kind: 'providers' });
    strictEqual(providers.kind, 'providers');
    const openrouter = providers.providers.find((item) => item.provider === 'openrouter-responses');
    ok(openrouter);
    await client.credentialRegister({
      authProfile: 'openrouter-api-key',
      value: 'initial-local-catalog-key',
    });
    const models = await client.catalogRead({
      kind: 'models',
      provider: openrouter.provider,
    });
    strictEqual(models.kind, 'models');
    const defaultModel = models.models.find((item) =>
      item.modelId === openrouter.defaultSelection.modelId
    );
    ok(defaultModel);
    const selectedModel = models.models.find((item) => item.modelId === 'new-live-model')!;
    ok(selectedModel);
    strictEqual(selectedModel.favorite, false);
    strictEqual(selectedModel.defaultEffort, 'auto');
    const selectedEffort = selectedModel.efforts.find((effort) =>
      effort === 'low' && effort !== openrouter.defaultSelection.effort
    ) ?? selectedModel.efforts.find((effort) =>
      effort !== openrouter.defaultSelection.effort
    );
    ok(selectedEffort);
    const efforts = await client.catalogRead({
      kind: 'efforts',
      provider: openrouter.provider,
      modelId: selectedModel.modelId,
    });
    strictEqual(efforts.kind, 'efforts');
    ok(efforts.efforts.includes(selectedEffort));
    const credentials = await client.catalogRead({ kind: 'credentials' });
    strictEqual(credentials.kind, 'credentials');
    ok(
      credentials.profiles.some((profile) => profile.authProfile === 'openai-api-key'),
    );
    strictEqual(providerBodies.length, 0);

    const removedPathRead = await fetch(
      `${server.url}/api/v1/workspace/paths`,
    );
    strictEqual(removedPathRead.status, 404);

    const openedSession = await opened(
      client,
      await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'new' },
        activation: { rootProvider: 'openrouter-responses' },
      }),
    );
    const sessionId = openedSession.session.id;
    strictEqual(readStartupStatus(openedSession), 'unevaluated');
    const firstKey = 'slice6-local-openrouter-key';
    const firstRegistration = await client.credentialRegister({
      authProfile: 'openrouter-api-key',
      value: firstKey,
    });
    strictEqual(firstRegistration.kind, 'registered');
    if (firstRegistration.kind === 'registered') {
      strictEqual(firstRegistration.status, 'present');
    }
    const presence = await client.credentialPresenceRead();
    ok(
      presence.profiles.some((profile) =>
        profile.authProfile === 'openrouter-api-key' &&
        profile.status === 'present'
      ),
    );
    const stillLazy = await client.sessionRead(sessionId);
    strictEqual(readStartupStatus(stillLazy), 'unevaluated');
    strictEqual(stillLazy.credentialAvailability.status, 'present');
    strictEqual(providerBodies.length, 0);

    const secondKey = 'slice6-local-openai-key';
    const secondRegistration = await client.credentialRegister({
      authProfile: 'openai-api-key',
      value: secondKey,
    });
    strictEqual(secondRegistration.kind, 'registered');
    strictEqual(
      readStartupStatus(await client.sessionRead(sessionId)),
      'unevaluated',
    );
    for (const commandId of [firstKey, secondKey, 'openai-api-key']) {
      try {
        await client.commandRead(commandId);
        throw new Error('credential material entered generic command state');
      } catch (error) {
        ok(error instanceof HenjiApiError);
        strictEqual(error.status, 404);
      }
    }
    const noSecretSnapshot = JSON.stringify(
      await client.sessionRead(sessionId),
    );
    ok(!noSecretSnapshot.includes(firstKey));
    ok(!noSecretSnapshot.includes(secondKey));

    const changed = await client.selectionChange(sessionId, {
      commandId: 'slice6-selection-command',
      selection: {
        provider: openrouter.provider,
        modelId: selectedModel.modelId,
        effort: selectedEffort,
      },
    });
    strictEqual(changed.kind, 'accepted', JSON.stringify(changed));
    strictEqual(providerBodies.length, 0);
    const selected = await client.sessionRead(sessionId);
    strictEqual(selected.session.selection.provider, 'openrouter-responses');
    strictEqual(selected.session.selection.modelId, selectedModel.modelId);
    const savedDefault = JSON.parse(
      await Deno.readTextFile(defaultSelectionPath(configRoot)),
    ) as {
      provider: string;
      modelId: string;
      effort: string;
      authProfile: string;
    };
    strictEqual(savedDefault.provider, 'openrouter-responses');
    strictEqual(savedDefault.modelId, selectedModel.modelId);
    strictEqual(savedDefault.effort, selectedEffort);
    strictEqual(savedDefault.authProfile, 'openrouter-api-key');
    const selectionReceipt = await client.commandRead(
      'slice6-selection-command',
    );
    ok(
      selectionReceipt.kind === 'accepted' &&
        'selection' in selectionReceipt.value,
    );

    const task = await client.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Use the selected OpenRouter Responses model',
    });
    strictEqual(task.kind, 'accepted');
    if (task.kind !== 'accepted') throw new Error('task was rejected');
    await waitFor(() => providerBodies.length > 0);
    strictEqual(providerBodies.length, 1);
    const activeBodies = JSON.stringify(providerBodies[0]);
    ok(activeBodies.includes('Use the selected OpenRouter Responses model'));
    ok(activeBodies.includes(selectedModel.modelId));
    ok(activeBodies.includes(selectedEffort));

    const busySelection = await client.selectionChange(sessionId, {
      commandId: 'slice6-busy-selection-command',
      selection: {
        provider: openrouter.provider,
        modelId: defaultModel.modelId,
        effort: openrouter.defaultSelection.effort,
      },
    });
    strictEqual(busySelection.kind, 'rejected');
    if (busySelection.kind === 'rejected') {
      strictEqual(busySelection.reason, 'busy');
    }
    const busyRegistration = await client.credentialRegister({
      authProfile: 'openrouter-api-key',
      value: 'slice6-busy-replacement-key',
    });
    strictEqual(busyRegistration.kind, 'rejected');
    if (busyRegistration.kind === 'rejected') {
      strictEqual(busyRegistration.reason, 'busy');
    }
    strictEqual(
      await Deno.readTextFile(`${configRoot}/openrouter-api-key`),
      firstKey,
    );
    strictEqual(
      (await client.sessionRead(sessionId)).session.selection.provider,
      'openrouter-responses',
    );

    releaseProvider();
    await waitFor(async () =>
      (await client.executionRead(task.value.executionId)).execution
        .processSettlement ===
        'complete'
    );
    const completedSnapshot = await client.sessionRead(sessionId);
    strictEqual(
      completedSnapshot.session.selection.provider,
      'openrouter-responses',
    );
    const history = await client.historyRead({
      sessionRef: sessionId,
      view: 'detail',
    });
    ok(!history.text.includes(firstKey));
    ok(!history.text.includes(secondKey));
    strictEqual(providerBodies.length, 1);

    // A provider-specific new Session uses the remembered effort for its default model.
    const remembered = await client.selectionChange(sessionId, {
      commandId: crypto.randomUUID(),
      selection: {
        provider: openrouter.provider,
        modelId: defaultModel.modelId,
        effort: selectedEffort,
      },
    });
    strictEqual(remembered.kind, 'accepted');
    const explicitProviderSession = await opened(
      client,
      await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'new' },
        activation: { rootProvider: openrouter.provider },
      }),
    );
    strictEqual(explicitProviderSession.session.selection.modelId, defaultModel.modelId);
    strictEqual(explicitProviderSession.session.selection.effort, selectedEffort);
    const restoredDefault = await client.selectionChange(explicitProviderSession.session.id, {
      commandId: crypto.randomUUID(),
      selection: {
        provider: openrouter.provider,
        modelId: selectedModel.modelId,
        effort: selectedEffort,
      },
    });
    strictEqual(restoredDefault.kind, 'accepted');
    strictEqual(providerBodies.length, 1);

    await server.shutdown();
    server = undefined;
    await core.close();
    core = undefined;
    core = await createCoreService(options);
    server = await startCoreServer(core);
    const reconnected = new HenjiApiClient(server.url);
    strictEqual(
      (await reconnected.sessionRead(sessionId)).session.selection.provider,
      'openrouter-responses',
    );
    const nextSession = await opened(
      reconnected,
      await reconnected.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'new' },
      }),
    );
    strictEqual(nextSession.session.selection.provider, 'openrouter-responses');
    strictEqual(
      nextSession.session.selection.modelId,
      selectedModel.modelId,
    );
    strictEqual(nextSession.session.selection.effort, selectedEffort);
    strictEqual(providerBodies.length, 1);
  } finally {
    releaseProvider();
    await server?.shutdown();
    await core?.close();
    await provider?.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
