import { deepStrictEqual as equal } from 'node:assert';
import { LIVE_UPDATE_MIN_INTERVAL_MS } from '../../v0/agent/core/loop.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import type { AgentDataPortRequest } from '../../v0/agent/data/agent_data_contract.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerReadyMessage,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { setActiveProviderDeclarations } from '../../v0/agent/provider/provider_runtime.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { createDataService } from '../../v0/agent/data/data_service.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import { createChildDataTestRegistry } from './helpers/increment_170_child_data.ts';
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
  const workerControlMessages: WorkerToHostMessage[] = [];
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
      capsuleFactory: (url): WorkerHostCapsule => {
        const capsule = new WorkerCapsule(url);
        capsule.subscribe((message) => workerControlMessages.push(message));
        return capsule;
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
      const childControls = workerControlMessages.filter((message) =>
        'correlation' in message && message.correlation !== undefined &&
        message.correlation.command === 'async-child'
      );
      const childProgress = childControls.filter((message) => message.kind === 'child_progress');
      assert(childProgress.length > 0, 'child progress did not use Worker control markers');
      for (const message of childProgress) {
        assert(!('text' in message.progress));
        assert(!('arguments' in message.progress));
        assert(!('result' in message.progress));
        assert(
          Object.keys(message.progress).every((key) =>
            ['phase', 'modelStep', 'requestOrdinal', 'lastTool'].includes(key)
          ),
        );
        if (message.progress.lastTool !== undefined) {
          assert(
            Object.keys(message.progress.lastTool).every((key) =>
              ['name', 'callId', 'state', 'outcome'].includes(key)
            ),
          );
        }
      }
      assert(
        !childControls.some((message) =>
          [
            'runtime_event',
            'effect_observation',
            'provider_observation',
            'context_observation',
            'commit_proposal',
            'turn_failed',
          ].includes(message.kind)
        ),
        'full Agent event or terminal payload crossed the child control channel',
      );
      const serializedChildControls = JSON.stringify(childControls);
      assert(!serializedChildControls.includes('child source'));
      assert(!serializedChildControls.includes('child finished'));
      assert(!serializedChildControls.includes('I138-CHILD-TASK'));
    } finally {
      allowModel.resolve();
      allowTool.resolve();
      await created.close();
    }
    const store = new SqliteHistoryStore(context.stateRoot, context.workspaceRoot, {
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
  stateRoot: string;
  configRoot: string;
  declarations: ReturnType<typeof builtinProviderDeclarations>;
  store: SqliteHistoryStore;
}) => {
  return await createChildDataTestRegistry({
    workspaceRoot: context.workspaceRoot,
    store: context.store,
    options: {
      configRoot: context.configRoot,
      physicalIoMode: 'production',
      providerDeclarations: context.declarations,
      initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
    },
    currentCatalog: () => ['generic'],
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
    const store = new SqliteHistoryStore(context.stateRoot, context.workspaceRoot);
    await store.initialize();
    const { registry, data, seedParentExecution } = await childRegistry({
      ...context,
      store,
    });
    await seedParentExecution('failures-parent');
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
      await data.close();
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
    const store = new SqliteHistoryStore(context.stateRoot, context.workspaceRoot);
    await store.initialize();
    const { registry, data, seedParentExecution } = await childRegistry({
      ...context,
      store,
    });
    await seedParentExecution('cancel-parent');
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
          store.readSessionConversationFacts(
            store.readExecutionMetadata(spawned.runId).sessionCorrelation,
          ).find((fact) => fact.execution.executionId === spawned.runId)
            ?.assistantTextStates,
        ).includes('first latest child text')
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
      await data.close();
      store.close();
    }
  });
});

Deno.test('Increment 170 child cancel seals a proposal marker whose Data payload is still pending', async () => {
  const settlementStarted = deferred();
  await withLocalProvider(() => final('child proposal held before Data'), async (context) => {
    const store = new SqliteHistoryStore(context.stateRoot, context.workspaceRoot);
    await store.initialize();
    const data = await createDataService({
      stateRoot: context.stateRoot,
      workspaceRoot: context.workspaceRoot,
    });
    const descriptor = await data.openSession({
      persistence: 'none',
      agent: 'default',
      agentChoice: {},
      initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
    });
    const configRoot = context.configRoot;
    const ports: MessagePort[] = [];
    const settleChildExecution = data.settleChildExecution.bind(data);
    data.settleChildExecution = (sessionId, input) => {
      settlementStarted.resolve();
      return settleChildExecution(sessionId, input);
    };
    const registry = new ChildRunRegistry({
      options: {
        data,
        descriptor,
        workspaceRoot: context.workspaceRoot,
        configRoot,
        agentChoice: {},
        physicalIoMode: 'production',
        providerDeclarations: context.declarations,
        cancelSettlementGraceMs: 100,
        capsuleFactory: (url): WorkerHostCapsule => {
          const capsule = new WorkerCapsule(url);
          return {
            send(command, transfer) {
              if (command.kind !== 'start' || command.dataPort === undefined) {
                capsule.send(command, transfer);
                return;
              }
              const servicePort = command.dataPort;
              const relay = new MessageChannel();
              ports.push(servicePort, relay.port1, relay.port2);
              servicePort.onmessage = (event) => relay.port1.postMessage(event.data);
              relay.port1.onmessage = (event: MessageEvent<AgentDataPortRequest>) => {
                if (event.data.kind === 'proposal') return;
                servicePort.postMessage(event.data);
              };
              servicePort.start();
              relay.port1.start();
              capsule.send({ ...command, dataPort: relay.port2 }, [relay.port2]);
            },
            subscribe: (listener) => capsule.subscribe(listener),
            terminate: () => capsule.terminate(),
          };
        },
      },
      currentCatalog: () => ['generic'],
    });
    const parentExecutionId = 'i170-child-pending-proposal-parent';
    let parentReady: WorkerReadyMessage | undefined;
    const parentSession = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot: context.workspaceRoot,
      configRoot,
      agentChoice: {},
      physicalIoMode: 'provider-free',
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        capsule.subscribe((message) => {
          if (message.kind === 'ready') parentReady = message;
        });
        return capsule;
      },
    });
    assert(parentReady, 'parent Worker must be ready before child start');
    await data.executionAdmit(descriptor.id, {
      executionId: parentExecutionId,
      taskId: 'i170-parent-task',
      task: 'parent fixture execution',
      correlation: parentReady.correlation,
    });
    registry.openParent(parentExecutionId);
    try {
      const spawned = await registry.handle(
        { kind: 'spawn', agent: 'generic', task: 'proposal payload pending' },
        undefined,
        parentExecutionId,
      );
      assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
      await settlementStarted.promise;

      const cancelled = await registry.handle(
        { kind: 'cancel', runId: spawned.runId },
        undefined,
        parentExecutionId,
      );
      assert(cancelled.ok && cancelled.kind === 'cancel', JSON.stringify(cancelled));
      equal(cancelled.state, 'interrupted');
      const collected = await registry.handle(
        { kind: 'collect', runId: spawned.runId },
        undefined,
        parentExecutionId,
      );
      assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
      equal(collected.result.state, 'interrupted');
      equal(
        store.listExecutionEvents(spawned.runId).filter((event) =>
          event.kind === 'provider_request_start'
        ).length,
        1,
      );
    } finally {
      await registry.cleanupAll();
      await parentSession.close();
      for (const port of ports) port.close();
      await data.close();
      store.close();
    }
  });
});
