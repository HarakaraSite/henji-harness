import { managedChildModule, managedChildRef } from './managed_child_fixture.ts';
import {
  type AsyncAgentRequest,
  type AsyncAgentResponse,
  createAsyncAgentTools,
} from '../../v0/agent/tools/async_agents.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import {
  bundledToolDefinitionLoadRequests,
} from '../../v0/agent/worker/worker_definition_revision.ts';
import type { WorkerSessionHandle } from '../../v0/agent/session/session_store_contract.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';

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

Deno.test('Increment 109 async agent tools expose a fixed four-operation surface', async () => {
  const requests: AsyncAgentRequest[] = [];
  const callIds: (string | undefined)[] = [];
  const rpc = (
    request: AsyncAgentRequest,
    callId?: string,
  ): Promise<AsyncAgentResponse> => {
    requests.push(request);
    callIds.push(callId);
    switch (request.kind) {
      case 'spawn':
        return Promise.resolve({ ok: true, kind: 'spawn', runId: 'run-1' });
      case 'status':
        return Promise.resolve({
          ok: true,
          kind: 'status',
          runId: request.runId,
          state: 'running',
        });
      case 'collect':
        return Promise.resolve({
          ok: true,
          kind: 'collect',
          result: {
            runId: request.runId,
            state: 'completed',
            finalText: 'child answer',
          },
        });
      case 'cancel':
        return Promise.resolve({
          ok: true,
          kind: 'cancel',
          runId: request.runId,
          state: 'cancelled',
        });
    }
  };
  const registry = new Registry([
    ...createAsyncAgentTools(['probe-child', 'researcher'], rpc),
  ]);
  assertEquals(
    registry.definitions().map((tool) => tool.name),
    [
      'cancel_subagent',
      'collect_subagent',
      'spawn_subagent',
      'subagent_status',
    ],
  );

  const spawned = await registry.dispatch(
    {
      callId: 'spawn-call-1',
      name: 'spawn_subagent',
      arguments: { agent: 'researcher', task: 'investigate X' },
    },
    { callId: 'spawn-call-1', signal: undefined },
  );
  assertEquals(JSON.parse(spawned.content.text), { ok: true, runId: 'run-1' });
  assertEquals(requests[0], {
    kind: 'spawn',
    agent: 'researcher',
    task: 'investigate X',
  });
  assertEquals(callIds[0], 'spawn-call-1');

  const status = await registry.dispatch({
    callId: 'status-1',
    name: 'subagent_status',
    arguments: { runId: 'run-1' },
  });
  assertEquals(JSON.parse(status.content.text), {
    ok: true,
    runId: 'run-1',
    state: 'running',
  });

  const collected = await registry.dispatch({
    callId: 'collect-1',
    name: 'collect_subagent',
    arguments: { runId: 'run-1' },
  });
  assertEquals(JSON.parse(collected.content.text), {
    ok: true,
    runId: 'run-1',
    state: 'completed',
    finalText: 'child answer',
  });

  const cancelled = await registry.dispatch({
    callId: 'cancel-1',
    name: 'cancel_subagent',
    arguments: { runId: 'run-1' },
  });
  assertEquals(JSON.parse(cancelled.content.text), {
    ok: true,
    runId: 'run-1',
    state: 'cancelled',
  });
});

Deno.test('Increment 109 spawn rejects an undeclared agent name', async () => {
  const registry = new Registry([
    ...createAsyncAgentTools(
      ['probe-child'],
      () => Promise.resolve({ ok: true, kind: 'spawn', runId: 'never' }),
    ),
  ]);
  const rejected = await registry.dispatch({
    callId: 'spawn-bad',
    name: 'spawn_subagent',
    arguments: { agent: 'researcher', task: 'x' },
  });
  assertEquals(rejected.content.outcome, 'error');
  assert(
    rejected.content.text.includes('agent must be one of'),
    'expected an undeclared-agent error result',
  );
});

Deno.test('Increment 109 child failure is reported without throwing', async () => {
  const registry = new Registry([
    ...createAsyncAgentTools(['probe-child'], (request) => {
      if (request.kind === 'collect') {
        return Promise.resolve({
          ok: true,
          kind: 'collect',
          result: {
            runId: request.runId,
            state: 'failed',
            error: 'child task failed',
          },
        });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    }),
  ]);
  const collected = await registry.dispatch({
    callId: 'collect-failed',
    name: 'collect_subagent',
    arguments: { runId: 'run-2' },
  });
  assertEquals(collected.content.outcome, 'success');
  assertEquals(JSON.parse(collected.content.text), {
    ok: true,
    runId: 'run-2',
    state: 'failed',
    error: 'child task failed',
  });
});

Deno.test('Increment 109 child run registry spawns, collects, and cancels a planner child', async () => {
  const plannerRef = managedChildRef();
  const handle: WorkerSessionHandle = {
    id: 'parent-session',
    commit: () => {},
    rollback: () => {},
    installCheckpoint: () => {},
    rollbackCheckpoint: () => {},
    close: () => Promise.resolve(),
  };
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-i109-durable-' });
  const workspaceRoot = `${stateRoot}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  await history.initialize();
  const registry = new ChildRunRegistry({
    options: {
      handle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition: plannerRef,
      physicalIoMode: 'provider-free',
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
    },
    catalog: [{ name: 'probe-child', ref: plannerRef }],
    resolveManagedModule: managedChildModule,
    history,
    build: buildManifest(),
  });
  registry.openParent('parent-execution-42');

  const spawned = await registry.handle(
    { kind: 'spawn', agent: 'probe-child', task: 'child planning task' },
    'spawn-call-9',
    'parent-execution-42',
  );
  assert(spawned.ok && spawned.kind === 'spawn', 'spawn should return a runId');
  const runId = spawned.runId;

  const collected = await registry.handle(
    { kind: 'collect', runId },
    undefined,
    'parent-execution-42',
  );
  assert(
    collected.ok && collected.kind === 'collect',
    'collect should succeed',
  );
  assertEquals(collected.result.state, 'completed');
  assert(
    collected.result.finalText === 'worker child result',
    `unexpected finalText: ${collected.result.finalText}`,
  );
  assertEquals(collected.result.parentExecutionId, 'parent-execution-42');
  assertEquals(collected.result.spawnCallId, 'spawn-call-9');

  const status = await registry.handle(
    { kind: 'status', runId },
    undefined,
    'parent-execution-42',
  );
  assert(status.ok && status.kind === 'status', 'status should succeed');
  assertEquals(status.state, 'completed');

  const unknown = await registry.handle(
    { kind: 'collect', runId: 'missing-run' },
    undefined,
    'parent-execution-42',
  );
  assert(!unknown.ok, 'collect of an unknown run should fail');

  const row = history.listExecutions().find((item) => item.executionId === runId);
  assert(row !== undefined, 'child execution evidence should be durable');
  assertEquals(row.parentExecutionId, 'parent-execution-42');
  assertEquals(row.spawnCallId, 'spawn-call-9');
  assertEquals(row.definition, plannerRef);
  assertEquals(row.lifecycle, 'settled');
  assertEquals(row.adoption, 'non_canonical');
  history.close();
  await Deno.remove(stateRoot, { recursive: true });
});

const makeParentHandle = (): WorkerSessionHandle => ({
  id: 'parent-session',
  commit: () => {},
  rollback: () => {},
  installCheckpoint: () => {},
  rollbackCheckpoint: () => {},
  close: () => Promise.resolve(),
});

const makePlannerRegistry = async (
  history?: SqliteHistoryV7ProductionStore,
): Promise<
  { registry: ChildRunRegistry; plannerRef: ReturnType<typeof managedChildRef> }
> => {
  const plannerRef = managedChildRef();
  const registry = new ChildRunRegistry({
    options: {
      handle: makeParentHandle(),
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition: plannerRef,
      physicalIoMode: 'provider-free',
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
    },
    catalog: [{ name: 'probe-child', ref: plannerRef }],
    resolveManagedModule: managedChildModule,
    ...(history === undefined ? {} : { history }),
    build: buildManifest(),
  });
  return { registry, plannerRef };
};

Deno.test('Increment 109 two child runs progress concurrently', async () => {
  const { registry } = await makePlannerRegistry();
  const parentExecutionId = 'parent-concurrent';
  registry.openParent(parentExecutionId);
  const channelName = `henji-i109-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  const startedLabels = new Set<string>();
  let resolveBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => resolveBothStarted = resolve);
  barrier.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as {
      readonly kind?: unknown;
      readonly label?: unknown;
    };
    if (message?.kind !== 'started' || typeof message.label !== 'string') {
      return;
    }
    startedLabels.add(message.label);
    if (startedLabels.size === 2) resolveBothStarted();
  };
  try {
    const [first, second] = await Promise.all([
      registry.handle(
        {
          kind: 'spawn',
          agent: 'probe-child',
          task: `barrier-child:${channelName}:A`,
        },
        undefined,
        parentExecutionId,
      ),
      registry.handle(
        {
          kind: 'spawn',
          agent: 'probe-child',
          task: `barrier-child:${channelName}:B`,
        },
        undefined,
        parentExecutionId,
      ),
    ]);
    assert(first.ok && first.kind === 'spawn');
    assert(second.ok && second.kind === 'spawn');
    assert(first.runId !== second.runId, 'children must have distinct runIds');
    await bothStarted;
    assertEquals([...startedLabels].sort(), ['A', 'B']);
    const firstStatus = await registry.handle(
      { kind: 'status', runId: first.runId },
      undefined,
      parentExecutionId,
    );
    const secondStatus = await registry.handle(
      { kind: 'status', runId: second.runId },
      undefined,
      parentExecutionId,
    );
    assert(firstStatus.ok && firstStatus.kind === 'status');
    assert(secondStatus.ok && secondStatus.kind === 'status');
    assertEquals(firstStatus.state, 'running');
    assertEquals(secondStatus.state, 'running');
    barrier.postMessage({ kind: 'release' });
    const [firstCollected, secondCollected] = await Promise.all([
      registry.handle(
        { kind: 'collect', runId: first.runId },
        undefined,
        parentExecutionId,
      ),
      registry.handle(
        { kind: 'collect', runId: second.runId },
        undefined,
        parentExecutionId,
      ),
    ]);
    assert(firstCollected.ok && firstCollected.kind === 'collect');
    assert(secondCollected.ok && secondCollected.kind === 'collect');
    assertEquals(firstCollected.result.state, 'completed');
    assertEquals(secondCollected.result.state, 'completed');
  } finally {
    barrier.postMessage({ kind: 'release' });
    barrier.close();
    await registry.cleanupParent(parentExecutionId);
  }
});

Deno.test('Increment 109 cancel targets only the requested child run', async () => {
  const { registry } = await makePlannerRegistry();
  const parentExecutionId = 'parent-cancel-one';
  registry.openParent(parentExecutionId);
  const kept = await registry.handle(
    { kind: 'spawn', agent: 'probe-child', task: 'slow child A' },
    undefined,
    parentExecutionId,
  );
  const cancelled = await registry.handle(
    {
      kind: 'spawn',
      agent: 'probe-child',
      task: 'cancel-child B',
    },
    undefined,
    parentExecutionId,
  );
  assert(kept.ok && kept.kind === 'spawn');
  assert(cancelled.ok && cancelled.kind === 'spawn');
  const cancelResponse = await registry.handle(
    { kind: 'cancel', runId: cancelled.runId },
    undefined,
    parentExecutionId,
  );
  assert(cancelResponse.ok && cancelResponse.kind === 'cancel');
  const cancelledResult = await registry.handle(
    { kind: 'collect', runId: cancelled.runId },
    undefined,
    parentExecutionId,
  );
  const keptResult = await registry.handle(
    { kind: 'collect', runId: kept.runId },
    undefined,
    parentExecutionId,
  );
  assert(cancelledResult.ok && cancelledResult.kind === 'collect');
  assert(keptResult.ok && keptResult.kind === 'collect');
  assertEquals(cancelledResult.result.state, 'cancelled');
  assertEquals(keptResult.result.state, 'completed');
});

Deno.test('Increment 109 parent cleanup settles unfinished children durably', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-i109-cancelall-' });
  const workspaceRoot = `${stateRoot}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  await history.initialize();
  try {
    const { registry } = await makePlannerRegistry(history);
    const parentExecutionId = 'parent-cleanup';
    registry.openParent(parentExecutionId);
    const spawned = await registry.handle(
      {
        kind: 'spawn',
        agent: 'probe-child',
        task: 'cancel-child task',
      },
      undefined,
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn');
    await registry.cleanupParent(parentExecutionId);
    const row = history.listExecutions().find((item) => item.executionId === spawned.runId);
    assert(row !== undefined, 'child execution should be durable');
    assertEquals(row.lifecycle, 'settled');
    assertEquals(row.outcome, 'cancelled');
  } finally {
    history.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
