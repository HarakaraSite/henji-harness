import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { createApplicationService } from '../../v0/agent/host/application_service.ts';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';

Deno.test('Session delete HTTP removes saved Session and its execution history using the existing transaction, and retains open Session', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i161-delete-' });
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${root}/config/henji-harness`;
  const stateRoot = `${root}/state`;
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'localhost-test-key', {
    mode: 0o600,
  });
  let requests = 0;
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      await request.json();
      requests += 1;
      return new Response(
        `data: ${
          JSON.stringify({ type: 'response.output_text.delta', delta: 'Saved history to delete' })
        }\n\ndata: ${
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'i161-local',
              output: [{
                type: 'message',
                id: 'i161-message',
                role: 'assistant',
                status: 'completed',
                content: [{
                  type: 'output_text',
                  text: 'Saved history to delete',
                  annotations: [],
                }],
              }],
            },
          })
        }\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  const options = {
    workspaceRoot,
    configRoot,
    stateRoot,
    dataRoot: `${root}/data`,
    physicalIoMode: 'production' as const,
    agent: 'default' as const,
    initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
    providerDeclarations: builtinProviderDeclarations().map((entry) =>
      entry.providerId === 'openrouter-responses'
        ? { ...entry, endpoint: `http://127.0.0.1:${provider.addr.port}/v1` }
        : entry
    ),
  };
  let seeded: Awaited<ReturnType<typeof createApplicationService>> | undefined;
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  try {
    seeded = await createApplicationService({ ...options, persistence: 'new' });
    const savedId = seeded.session.sessionId;
    const task = await seeded.session.submit('Save this result');
    ok(task.ok, JSON.stringify(task));
    await seeded.close();
    seeded = undefined;
    const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, { readOnly: true });
    await store.initialize();
    const executions = store.listExecutionsForSession(savedId);
    ok(executions.length > 0);
    ok(store.listExecutionEvents(executions[0].executionId).length > 0);
    core = await createCoreService({ ...options, initialSession: { kind: 'new' } });
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const activeId = (await client.coreRead()).activeSessionId!;
    const busy = await client.sessionDelete(activeId, { commandId: crypto.randomUUID() });
    strictEqual(busy.kind, 'rejected');
    if (busy.kind === 'rejected') strictEqual(busy.reason, 'busy');
    await client.sessionRead(savedId);
    const input = { commandId: crypto.randomUUID() };
    const deleted = await client.sessionDelete(savedId, input);
    strictEqual(deleted.kind, 'accepted', JSON.stringify(deleted));
    if (deleted.kind === 'accepted') deepStrictEqual(deleted.value, { deleted: savedId });
    deepStrictEqual(await client.sessionDelete(savedId, input), deleted);
    deepStrictEqual(await client.commandRead(input.commandId), deleted);
    strictEqual((await client.sessionsList()).sessions.some((item) => item.id === savedId), false);
    strictEqual((await client.coreRead()).activeSessionId, activeId);
    strictEqual((await fetch(`${server.url}/api/v1/sessions/${savedId}`)).status, 404);
    strictEqual(store.listExecutionsForSession(savedId).length, 0);
    for (const execution of executions) {
      throws(() => store.listExecutionEvents(execution.executionId), {
        name: 'HistoryStoreError',
        message: 'history_invalid',
      });
      throws(() => store.listSemanticOccurrences(execution.executionId), {
        name: 'HistoryStoreError',
        message: 'history_invalid',
      });
    }
    strictEqual(requests, 1);
  } finally {
    await seeded?.close();
    await server?.shutdown();
    await core?.close();
    await provider.shutdown();
    await Deno.remove(root, { recursive: true });
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
