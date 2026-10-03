import {
  childDataTest,
  closeChildDataTests,
  createChildDataTestRegistry,
} from './helpers/increment_170_child_data.ts';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { selectModelFor } from '../../v0/agent/provider/model_catalog.ts';
import { setActiveProviderDeclarations } from '../../v0/agent/provider/provider_runtime.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';

childDataTest(
  'E6 uncataloged model runs in production children by inheritance and explicit selection',
  async () => {
    const root = await Deno.makeTempDir({ prefix: 'henji-e6-child-' });
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_DATA_HOME: `${root}/data`,
      XDG_STATE_HOME: `${root}/state`,
    };
    const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
    for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
    const workspaceRoot = `${root}/workspace`;
    const configRoot = `${environment.XDG_CONFIG_HOME}/henji-harness`;
    await Deno.mkdir(workspaceRoot);
    await Deno.mkdir(configRoot, { recursive: true });
    await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'local-e6-key', { mode: 0o600 });
    const bodies: Record<string, unknown>[] = [];
    const provider = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen() {} },
      async (request) => {
        bodies.push(await request.json());
        return new Response(
          `data: ${
            JSON.stringify({ type: 'response.output_text.delta', delta: 'E6 child completed' })
          }\n\ndata: ${
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: crypto.randomUUID(),
                output: [{
                  type: 'message',
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'E6 child completed', annotations: [] }],
                }],
              },
            })
          }\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );
    const declarations = builtinProviderDeclarations().map((entry) =>
      entry.providerId === 'openrouter-responses'
        ? { ...entry, endpoint: `http://127.0.0.1:${provider.addr.port}/v1` }
        : entry
    );
    setActiveProviderDeclarations(declarations);
    const selection = selectModelFor('openrouter-responses', 'new-not-a-favorite');
    strictEqual(selection.effort, 'auto');
    const history = new SqliteHistoryStore(`${root}/history`, workspaceRoot);
    await history.initialize();
    const { registry, seedParentExecution } = await createChildDataTestRegistry({
      options: {
        configRoot,
        physicalIoMode: 'production',
        providerDeclarations: declarations,
      },
      currentModelSelection: () => selection,
      currentCatalog: () => ['generic'],
      store: history,
    });
    await seedParentExecution('e6-parent');
    registry.openParent('e6-parent');
    try {
      for (
        const model of [undefined, {
          provider: selection.provider,
          modelId: selection.modelId,
          effort: 'auto',
        }]
      ) {
        const spawned = await registry.handle(
          {
            kind: 'spawn',
            agent: 'generic',
            task: 'Reply briefly.',
            ...(model === undefined ? {} : { model }),
          },
          undefined,
          'e6-parent',
        );
        ok(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
        const result = await registry.handle(
          { kind: 'collect', runId: spawned.runId },
          undefined,
          'e6-parent',
        );
        ok(result.ok && result.kind === 'collect', JSON.stringify(result));
        strictEqual(result.result.state, 'completed', JSON.stringify(result));
      }
      deepStrictEqual(bodies.map((body) => [body.model, body.reasoning]), [[
        'new-not-a-favorite',
        { summary: 'auto' },
      ], ['new-not-a-favorite', { summary: 'auto' }]]);
    } finally {
      await registry.cleanupAll();
      await closeChildDataTests(history);
      history.close();
      await provider.shutdown();
      setActiveProviderDeclarations([]);
      for (const [key, value] of previous) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
);
