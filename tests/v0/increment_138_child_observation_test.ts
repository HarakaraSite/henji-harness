import { deepStrictEqual as equal } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import { LIVE_UPDATE_MIN_INTERVAL_MS } from '../../v0/agent/core/loop.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import { bundledToolDefinitionLoadRequests } from '../../v0/agent/worker/worker_definition_revision.ts';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { setActiveProviderDeclarations } from '../../v0/agent/provider/provider_runtime.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import type { AsyncAgentProgress } from '../../v0/agent/tools/async_agents.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => resolve = accept);
  return { promise, resolve };
};
const call = (id: string, name: string, args: unknown) => ({
  type: 'function_call',
  id: `function-${id}`,
  status: 'completed',
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
const sse = (output: unknown[], text = '') => {
  const events: unknown[] = text ? [{ type: 'response.output_text.delta', delta: text }] : [];
  events.push({ type: 'response.completed', response: { id: crypto.randomUUID(), output } });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
};
const final = (text: string) =>
  sse([{
    type: 'message',
    id: crypto.randomUUID(),
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }], text);
const results = (input: Record<string, unknown>[]) =>
  input.filter((item) => item.type === 'function_call_output');
const toolJson = (input: Record<string, unknown>[], id: string) => {
  const item = results(input).find((item) => item.call_id === id);
  assert(item, `missing result ${id}`);
  return JSON.parse(item.output as string);
};

const withLocalProvider = async (
  handler: (request: Request) => Response | Promise<Response>,
  run: (context: {
    root: string;
    workspaceRoot: string;
    configRoot: string;
    stateRoot: string;
    declarations: ReturnType<typeof builtinProviderDeclarations>;
    url: string;
  }) => Promise<void>,
) => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i138-' });
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
  const stateRoot = `${environment.XDG_STATE_HOME}/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'local-i138-key', { mode: 0o600 });
  await Deno.writeTextFile(`${workspaceRoot}/marker.txt`, 'independent parent check');
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler);
  const url = `http://127.0.0.1:${server.addr.port}`;
  const declarations = builtinProviderDeclarations().map((entry) =>
    entry.providerId === 'openrouter-responses' ? { ...entry, endpoint: `${url}/v1` } : entry
  );
  try {
    await run({ root, workspaceRoot, configRoot, stateRoot, declarations, url });
  } finally {
    await server.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    setActiveProviderDeclarations([]);
    await Deno.remove(root, { recursive: true });
  }
};

Deno.test('Increment 138 parent works, reads live child status, collects, and exports child facts', async () => {
  const modelStarted = deferred();
  const allowModel = deferred();
  const toolStarted = deferred();
  const allowTool = deferred();
  let baseUrl = '';
  let parentStep = 0;
  let childStep = 0;
  let runId = '';
  const snapshots: { agent: string; state: string; progress: AsyncAgentProgress }[] = [];
  const order: string[] = [];
  await withLocalProvider(async (request) => {
    if (new URL(request.url).pathname === '/child-work') {
      toolStarted.resolve();
      await allowTool.promise;
      return new Response('child source', { headers: { 'content-type': 'text/plain' } });
    }
    const body = await request.json();
    const input = body.input as Record<string, unknown>[];
    if (
      input.some((item) =>
        item.role === 'user' && JSON.stringify(item.content).includes('I138-CHILD-TASK')
      )
    ) {
      childStep += 1;
      if (childStep === 1) {
        modelStarted.resolve();
        await allowModel.promise;
        return sse([call('child-fetch', 'web_fetch', { url: `${baseUrl}/child-work` })]);
      }
      equal(childStep, 2);
      order.push('child-final');
      return final('child finished');
    }
    parentStep += 1;
    if (parentStep === 1) {
      return sse([call('spawn', 'spawn_subagent', { agent: 'generic', task: 'I138-CHILD-TASK' })]);
    }
    if (parentStep === 2) {
      runId = toolJson(input, 'spawn').runId;
      await modelStarted.promise;
      return sse([
        call('parent-read', 'read', { path: 'marker.txt' }),
        call('status-model', 'subagent_status', { runId }),
      ]);
    }
    if (parentStep === 3) {
      assert(results(input).some((item) => item.output === 'independent parent check'));
      order.push('parent-check');
      snapshots.push(toolJson(input, 'status-model'));
      allowModel.resolve();
      await toolStarted.promise;
      return sse([
        call('status-tool-1', 'subagent_status', { runId }),
        call('status-tool-2', 'subagent_status', { runId }),
      ]);
    }
    if (parentStep === 4) {
      snapshots.push(toolJson(input, 'status-tool-1'), toolJson(input, 'status-tool-2'));
      return sse(
        [call('collect', 'collect_subagent', { runId })],
        'The child is fetching a source.',
      );
    }
    if (parentStep === 5) {
      const collected = toolJson(input, 'collect');
      equal([collected.state, collected.finalText, collected.providerRequestCount], [
        'completed',
        'child finished',
        2,
      ]);
      return sse([call('status-settled', 'subagent_status', { runId })]);
    }
    equal(parentStep, 6);
    const settled = toolJson(input, 'status-settled');
    equal([settled.state, settled.progress.phase, settled.progress.modelStep], [
      'completed',
      'settled',
      2,
    ]);
    equal(settled.progress.lastTool, {
      name: 'web_fetch',
      callId: 'child-fetch',
      state: 'completed',
      outcome: 'success',
    });
    order.push('parent-final');
    return final('parent finished');
  }, async (context) => {
    baseUrl = context.url;
    const created = await createWorkerSession({
      ...context,
      dataRoot: `${context.root}/data/henji-harness`,
      persistence: 'new',
      physicalIoMode: 'production',
      initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
      providerDeclarations: context.declarations,
      eventSink: (event) => {
        if (event.kind === 'tool_call' && event.call.name === 'collect_subagent') {
          order.push('collect-start');
          allowTool.resolve();
        }
      },
    });
    const sessionId = created.session.sessionId;
    try {
      const outcome = await created.session.submit('I138-PARENT-TASK');
      assert(outcome.ok, JSON.stringify(outcome));
      equal(outcome.finalText, 'parent finished');
      equal(
        snapshots.map((snapshot) => [snapshot.agent, snapshot.state, snapshot.progress.phase]),
        [['generic', 'running', 'model'], ['generic', 'running', 'tool'], [
          'generic',
          'running',
          'tool',
        ]],
      );
      equal(snapshots[0].progress.modelStep, 1);
      equal(snapshots[0].progress.requestOrdinal, 1);
      equal(snapshots[1].progress.lastTool, {
        name: 'web_fetch',
        callId: 'child-fetch',
        state: 'running',
      });
      equal(snapshots[1].progress, snapshots[2].progress);
      equal(order, ['parent-check', 'collect-start', 'child-final', 'parent-final']);
    } finally {
      allowModel.resolve();
      allowTool.resolve();
      await created.close();
    }
    const store = new SqliteHistoryV7ProductionStore(context.stateRoot, context.workspaceRoot, {
      readOnly: true,
    });
    await store.initialize();
    try {
      const records = [...store.streamHumanHistoryExport(sessionId)];
      const executions = records.filter((record) => record.kind === 'execution');
      equal(executions.length, 2);
      const child = store.readExecution(runId);
      assert(child.parentExecutionId);
      equal(child.spawnCallId, 'spawn');
      const header = records.find((record) => record.kind === 'header')!;
      equal((header.value as { tail: unknown }).tail, { executionId: child.parentExecutionId });
      const events = store.listExecutionEvents(runId);
      const requests = events.filter((event) => event.kind === 'provider_request_start');
      equal(
        requests.map((event) => {
          const payload = event.payload as {
            observation: { request: { ordinal: number; modelStep: number } };
          };
          return [payload.observation.request.ordinal, payload.observation.request.modelStep];
        }),
        [[1, 1], [2, 2]],
      );
      equal(events.filter((event) => event.kind === 'provider_response_start').length, 2);
      equal(
        records.filter((record) =>
          record.kind === 'semantic_occurrence' &&
          (record.value as { executionId?: string }).executionId === runId &&
          (record.value as { kind?: string }).kind === 'tool_call'
        ).length,
        1,
      );
      assert(!JSON.stringify(records).includes('local-i138-key'));
      assert(!JSON.stringify(records).includes('Authorization'));
      equal(store.readSessionHistory(sessionId).length, 1);
    } finally {
      store.close();
    }
  });
});

const childRegistry = async (context: {
  workspaceRoot: string;
  declarations: ReturnType<typeof builtinProviderDeclarations>;
}, history: SqliteHistoryV7ProductionStore) => {
  const ref = await builtinDefinitionRef('generic', buildManifest());
  return new ChildRunRegistry({
    options: {
      handle: {
        id: 'i138-parent',
        commit() {},
        rollback() {},
        installCheckpoint() {},
        rollbackCheckpoint() {},
        close: () => Promise.resolve(),
      },
      workspaceRoot: context.workspaceRoot,
      agent: 'default',
      definition: ref,
      physicalIoMode: 'production',
      initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
      providerDeclarations: context.declarations,
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
    },
    catalog: [{ name: 'generic', ref }],
    history,
  });
};

Deno.test('Increment 138 child HTTP and parse failures retain per-request facts', async () => {
  await withLocalProvider(async (request) => {
    const body = await request.json();
    if (JSON.stringify(body.input).includes('HTTP-FAILURE')) {
      return new Response('unavailable', { status: 503 });
    }
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { output: null } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }, async (context) => {
    const store = new SqliteHistoryV7ProductionStore(context.stateRoot, context.workspaceRoot);
    await store.initialize();
    const registry = await childRegistry(context, store);
    registry.openParent('failures-parent');
    try {
      for (const task of ['HTTP-FAILURE', 'PARSE-FAILURE']) {
        const spawned = await registry.handle(
          { kind: 'spawn', agent: 'generic', task },
          undefined,
          'failures-parent',
        );
        assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
        const collected = await registry.handle(
          { kind: 'collect', runId: spawned.runId },
          undefined,
          'failures-parent',
        );
        assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
        equal([collected.result.state, collected.result.providerRequestCount], ['failed', 1]);
        const events = store.listExecutionEvents(spawned.runId);
        equal(events.filter((event) => event.kind === 'provider_request_start').length, 1);
        equal(events.filter((event) => event.kind === 'provider_request_failure').length, 1);
        const status = await registry.handle(
          { kind: 'status', runId: spawned.runId },
          undefined,
          'failures-parent',
        );
        assert(status.ok && status.kind === 'status');
        equal(status.progress.phase, 'settled');
        if (task === 'HTTP-FAILURE') {
          assert(JSON.stringify(events).includes('503'));
          assert(JSON.stringify(events).includes('http_error'));
        } else {
          const parser = events.find((event) => event.kind === 'provider_parser_transition');
          assert(parser);
          const value = parser.payload as { observation: { transition: unknown } };
          equal(value.observation.transition, {
            ordinal: 1,
            kind: 'failure',
            reason: 'unsupported_response_shape',
            field: 'response.output',
            expectedShape: 'array',
            actualShape: 'null',
          });
        }
      }
    } finally {
      await registry.cleanupAll();
      store.close();
    }
  });
});

Deno.test('Increment 138 cancelling an unfinished child retains its last text and request prefix', async () => {
  await withLocalProvider(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const delta of ['first ', 'latest child text\n']) {
            controller.enqueue(new TextEncoder().encode(`data: ${
              JSON.stringify({
                type: 'response.output_text.delta',
                delta,
              })
            }\n\n`));
            await new Promise((resolve) => setTimeout(resolve, LIVE_UPDATE_MIN_INTERVAL_MS + 50));
          }
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ), async (context) => {
    const store = new SqliteHistoryV7ProductionStore(context.stateRoot, context.workspaceRoot);
    await store.initialize();
    const registry = await childRegistry(context, store);
    const db = new DatabaseSync(
      `${(await sessionPaths(context.stateRoot, context.workspaceRoot)).root}/history-v7.sqlite3`,
      { readOnly: true },
    );
    registry.openParent('cancel-parent');
    try {
      const spawned = await registry.handle(
        { kind: 'spawn', agent: 'generic', task: 'unfinished text' },
        undefined,
        'cancel-parent',
      );
      assert(spawned.ok && spawned.kind === 'spawn');
      // Wait for the normal journal cadence to commit text while the provider stream stays open.
      const deadline = Date.now() + 10_000;
      while (
        !JSON.stringify(
          db.prepare('SELECT event_json FROM assistant_text_states WHERE execution_id=?').all(
            spawned.runId,
          ),
        ).includes(
          'first latest child text',
        )
      ) {
        assert(Date.now() < deadline, 'child text was not saved while streaming');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const status = await registry.handle(
        { kind: 'status', runId: spawned.runId },
        undefined,
        'cancel-parent',
      );
      assert(status.ok && status.kind === 'status');
      equal([status.state, status.progress.phase, status.progress.requestOrdinal], [
        'running',
        'model',
        1,
      ]);
      const cancelled = await registry.handle(
        { kind: 'cancel', runId: spawned.runId },
        undefined,
        'cancel-parent',
      );
      assert(cancelled.ok && cancelled.kind === 'cancel', JSON.stringify(cancelled));
      equal(cancelled.state, 'cancelled');
      const events = store.listExecutionEvents(spawned.runId);
      equal(events.filter((event) => event.kind === 'provider_request_start').length, 1);
      equal(events.filter((event) => event.kind === 'provider_response_start').length, 1);
      const text = events.filter((event) =>
        JSON.stringify(event).includes('first latest child text')
      );
      equal(text.length, 1);
      assert(
        !events.some((event) => {
          const payload = event.payload as { observation?: { event?: { kind?: string } } };
          return payload.observation?.event?.kind === 'model_result';
        }),
        'cancellation must not invent a completed model result',
      );
    } finally {
      await registry.cleanupAll();
      db.close();
      store.close();
    }
  });
});
