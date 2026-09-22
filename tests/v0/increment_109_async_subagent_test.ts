import {
  type AsyncAgentRequest,
  type AsyncAgentResponse,
  createAsyncAgentTools,
} from '../../v0/agent/tools/async_agents.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import {
  bundledToolDefinitionLoadRequests,
  readDefinitionRevision,
} from '../../v0/agent/worker/worker_definition_revision.ts';
import type { WorkerSessionHandle } from '../../v0/agent/session/session_store_contract.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
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
    ...createAsyncAgentTools(['planner', 'researcher'], rpc),
  ]);
  assertEquals(
    registry.definitions().map((tool) => tool.name),
    ['cancel_subagent', 'collect_subagent', 'spawn_subagent', 'subagent_status'],
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
  assertEquals(requests[0], { kind: 'spawn', agent: 'researcher', task: 'investigate X' });
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
      ['planner'],
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
    ...createAsyncAgentTools(['planner'], (request) => {
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
  const plannerRef = await readDefinitionRevision('', 'builtin', 'planner');
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
    catalog: [{ name: 'planner', ref: plannerRef }],
    history,
    build: buildManifest(),
  });

  const spawned = await registry.handle(
    { kind: 'spawn', agent: 'planner', task: 'child planning task' },
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
  assert(collected.ok && collected.kind === 'collect', 'collect should succeed');
  assertEquals(collected.result.state, 'completed');
  assert(
    collected.result.finalText === 'worker planner result',
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

Deno.test('Increment 109 parent spawns and collects an async planner child', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i109-e2e-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const created = await createWorkerSession({
    workspaceRoot,
    stateRoot: `${root}/state`,
    dataRoot: `${root}/data`,
    configRoot: `${root}/config`,
    persistence: 'new',
    physicalIoMode: 'provider-free',
  });
  try {
    const outcome = await created.session.submit('async-spawn planner turn');
    assert(outcome.ok, JSON.stringify(outcome));
    assert(
      outcome.finalText?.includes('async child: worker planner result') === true,
      `unexpected finalText: ${outcome.finalText}`,
    );
  } finally {
    await created.close();
    await Deno.remove(root, { recursive: true });
  }
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
  { registry: ChildRunRegistry; plannerRef: Awaited<ReturnType<typeof readDefinitionRevision>> }
> => {
  const plannerRef = await readDefinitionRevision('', 'builtin', 'planner');
  const registry = new ChildRunRegistry({
    options: {
      handle: makeParentHandle(),
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition: plannerRef,
      physicalIoMode: 'provider-free',
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
    },
    catalog: [{ name: 'planner', ref: plannerRef }],
    ...(history === undefined ? {} : { history }),
    build: buildManifest(),
  });
  return { registry, plannerRef };
};

Deno.test('Increment 109 parent continues after one child fails', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i109-fail-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const created = await createWorkerSession({
    workspaceRoot,
    stateRoot: `${root}/state`,
    dataRoot: `${root}/data`,
    configRoot: `${root}/config`,
    persistence: 'new',
    physicalIoMode: 'provider-free',
  });
  try {
    const outcome = await created.session.submit('async-child-fail turn');
    assert(outcome.ok, JSON.stringify(outcome));
    assert(
      outcome.finalText?.includes('child failed:') === true &&
        outcome.finalText.includes('child task failed on purpose'),
      `unexpected finalText: ${outcome.finalText}`,
    );
  } finally {
    await created.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 109 two child runs progress concurrently', async () => {
  const { registry } = await makePlannerRegistry();
  const parentExecutionId = 'parent-concurrent';
  const channelName = `henji-i109-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  const startedLabels = new Set<string>();
  let resolveBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => resolveBothStarted = resolve);
  barrier.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as { readonly kind?: unknown; readonly label?: unknown };
    if (message?.kind !== 'started' || typeof message.label !== 'string') return;
    startedLabels.add(message.label);
    if (startedLabels.size === 2) resolveBothStarted();
  };
  try {
    const [first, second] = await Promise.all([
      registry.handle(
        {
          kind: 'spawn',
          agent: 'planner',
          task: `barrier-child:${channelName}:A`,
        },
        undefined,
        parentExecutionId,
      ),
      registry.handle(
        {
          kind: 'spawn',
          agent: 'planner',
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
  const kept = await registry.handle(
    { kind: 'spawn', agent: 'planner', task: 'slow child A' },
    undefined,
    parentExecutionId,
  );
  const cancelled = await registry.handle(
    {
      kind: 'spawn',
      agent: 'planner',
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
    const spawned = await registry.handle(
      {
        kind: 'spawn',
        agent: 'planner',
        task: 'cancel-child task',
      },
      undefined,
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn');
    await registry.cleanupParent(parentExecutionId);
    let row = history.listExecutions().find((item) => item.executionId === spawned.runId);
    for (let attempt = 0; attempt < 200 && row?.lifecycle !== 'settled'; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      row = history.listExecutions().find((item) => item.executionId === spawned.runId);
    }
    assert(row !== undefined, 'child execution should be durable');
    assertEquals(row.lifecycle, 'settled');
    assertEquals(row.outcome, 'cancelled');
  } finally {
    history.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
