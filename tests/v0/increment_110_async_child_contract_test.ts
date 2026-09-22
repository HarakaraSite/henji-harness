import {
  type AsyncAgentRequest,
  type AsyncAgentResponse,
  createAsyncAgentTools,
} from '../../v0/agent/tools/async_agents.ts';
import { isTurnCancelledError, TurnCancelledError } from '../../v0/agent/core/cancellation.ts';
import type { LoopOutcome } from '../../v0/agent/core/contracts.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import {
  bundledToolDefinitionLoadRequests,
  readDefinitionRevision,
  workerBuiltinModulePath,
} from '../../v0/agent/worker/worker_definition_revision.ts';
import { readWorkerModuleRevision } from '../../v0/agent/worker/worker_capsule.ts';
import type {
  WorkerDefinitionLoadRequest,
  WorkerToolDefinitionLoadRequest,
} from '../../v0/agent/worker/worker_protocol.ts';
import type { WorkerSessionHandle } from '../../v0/agent/session/session_store_contract.ts';
import type { DefinitionRevisionRef } from '../../v0/agent/session/session_store.ts';
import type {
  HistoryPersistencePort,
  NonCanonicalExecutionInput,
} from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import type { StoredWorkerExecutionArtifact } from '../../v0/agent/worker/worker_execution_artifact.ts';
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

const handle = (): WorkerSessionHandle => ({
  id: crypto.randomUUID().toLowerCase(),
  commit: () => {},
  rollback: () => {},
  installCheckpoint: () => {},
  rollbackCheckpoint: () => {},
  close: () => Promise.resolve(),
});

const managedRef = (resourceId: string): DefinitionRevisionRef => ({
  schemaVersion: 1,
  resourceKind: 'agent-definition',
  resourceId,
  revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
});

const builtinRegistry = async (
  history?: HistoryPersistencePort,
  cancelSettlementGraceMs?: number,
): Promise<ChildRunRegistry> => {
  const plannerRef = await readDefinitionRevision('', 'builtin', 'planner');
  return new ChildRunRegistry({
    options: {
      handle: handle(),
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition: plannerRef,
      physicalIoMode: 'provider-free',
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
      ...(cancelSettlementGraceMs === undefined ? {} : { cancelSettlementGraceMs }),
    },
    catalog: [{ name: 'planner', ref: plannerRef }],
    ...(history === undefined ? {} : { history }),
    build: buildManifest(),
  });
};

const withTimeout = async <T>(
  promise: Promise<T>,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out: ${label}`)),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const waitForChannelKind = (
  channel: BroadcastChannel,
  kind: string,
): Promise<Record<string, unknown>> =>
  withTimeout(
    new Promise<Record<string, unknown>>((resolve) => {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (
          typeof message === 'object' && message !== null &&
          (message as { readonly kind?: unknown }).kind === kind
        ) resolve(message as Record<string, unknown>);
      };
    }),
    `BroadcastChannel ${kind}`,
  );

Deno.test('Increment 110 uses managed planner provenance and exact tool binding', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i110-managed-planner-',
  });
  try {
    const toolPath = `${root}/bound_read.ts`;
    await Deno.writeTextFile(
      toolPath,
      `export default () => ({
        identity: 'tool:read',
        materialize: () => ({
          name: 'read',
          description: 'bound read fixture',
          inputSchema: { type: 'object' },
          terminal: true,
          execute: () => ({
            kind: 'terminate',
            text: 'BOUND_READ',
            finalText: 'BOUND_READ',
            terminalKind: 'json_result',
          }),
        }),
      });\n`,
    );
    const exactToolRef = {
      schemaVersion: 1 as const,
      resourceKind: 'tool-definition' as const,
      resourceId: 'test/bound-read',
      revision: { algorithm: 'sha256' as const, digest: 'b'.repeat(64) },
    };
    const toolModule = await readWorkerModuleRevision(toolPath);
    const toolDefinitions: WorkerToolDefinitionLoadRequest[] = (
      await bundledToolDefinitionLoadRequests()
    ).map((request) =>
      request.toolIdentity === 'tool:read'
        ? { toolIdentity: 'tool:read', ref: exactToolRef, module: toolModule }
        : request
    );
    const ref = managedRef('test/managed-planner');
    const definitionModule = await readWorkerModuleRevision(
      workerBuiltinModulePath('default'),
    );
    const resolverRefs: DefinitionRevisionRef[] = [];
    const registry = new ChildRunRegistry({
      options: {
        handle: handle(),
        workspaceRoot: Deno.cwd(),
        agent: 'default',
        definition: ref,
        physicalIoMode: 'provider-free',
        toolDefinitions,
      },
      catalog: [{ name: 'planner', ref }],
      resolveManagedModule: (
        requested,
      ): Promise<WorkerDefinitionLoadRequest> => {
        resolverRefs.push(structuredClone(requested));
        return Promise.resolve(definitionModule);
      },
      build: buildManifest(),
    });
    const parentExecutionId = 'parent-managed-planner';
    registry.openParent(parentExecutionId);
    const spawned = await registry.handle(
      { kind: 'spawn', agent: 'planner', task: 'read bound tool' },
      'managed-planner-call',
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await registry.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(
      collected.ok && collected.kind === 'collect',
      JSON.stringify(collected),
    );
    assertEquals(collected.result.finalText, 'BOUND_READ');
    assertEquals(
      collected.result.definitionRef,
      `${ref.resourceId}@sha256:${ref.revision.digest}`,
    );
    assertEquals(resolverRefs, [ref]);
    await registry.cleanupParent(parentExecutionId);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 110 cleanup joins in-flight durable admission', async () => {
  let releaseAdmission!: () => void;
  let markAdmissionStarted!: () => void;
  const admissionStarted = new Promise<void>((resolve) => markAdmissionStarted = resolve);
  const admissionBarrier = new Promise<void>((resolve) => releaseAdmission = resolve);
  const history = {
    beginExecution: async () => {
      markAdmissionStarted();
      await admissionBarrier;
    },
    settleNonCanonicalExecution: () => ({}),
  } as unknown as HistoryPersistencePort;
  const ref = managedRef('test/admission-barrier');
  let resolverCalls = 0;
  const registry = new ChildRunRegistry({
    options: {
      handle: handle(),
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition: ref,
      physicalIoMode: 'provider-free',
    },
    catalog: [{ name: 'researcher', ref }],
    resolveManagedModule: () => {
      resolverCalls += 1;
      throw new Error('resolver must not run after parent cleanup');
    },
    history,
    build: buildManifest(),
  });
  const parentExecutionId = 'parent-admission-barrier';
  registry.openParent(parentExecutionId);
  const spawn = registry.handle(
    { kind: 'spawn', agent: 'researcher', task: 'never start' },
    'admission-call',
    parentExecutionId,
  );
  await admissionStarted;
  let cleanupSettled = false;
  const cleanup = registry.cleanupParent(parentExecutionId).then((value) => {
    cleanupSettled = true;
    return value;
  });
  await Promise.resolve();
  assert(!cleanupSettled, 'cleanup must join the in-flight admission');
  releaseAdmission();
  const [spawned, observation] = await Promise.all([spawn, cleanup]);
  assert(!spawned.ok, 'late admission must not return spawn success');
  assertEquals(resolverCalls, 0);
  assertEquals(observation?.runs.map((run) => [run.state, run.durability]), [
    ['cancelled', 'yes'],
  ]);
});

Deno.test('Increment 110 hides a terminal result when durable settlement fails', async () => {
  const history = {
    beginExecution: () => {},
    settleNonCanonicalExecution: () => {
      throw new Error('settlement unavailable');
    },
  } as unknown as HistoryPersistencePort;
  const registry = await builtinRegistry(history);
  const parentExecutionId = 'parent-settlement-failure';
  registry.openParent(parentExecutionId);
  const spawned = await registry.handle(
    { kind: 'spawn', agent: 'planner', task: 'child terminal durability' },
    undefined,
    parentExecutionId,
  );
  assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
  const collected = await registry.handle(
    { kind: 'collect', runId: spawned.runId },
    undefined,
    parentExecutionId,
  );
  assert(!collected.ok && collected.error.includes('settlement unavailable'));
  const status = await registry.handle(
    { kind: 'status', runId: spawned.runId },
    undefined,
    parentExecutionId,
  );
  assert(!status.ok && status.error.includes('settlement unavailable'));
  const cleanup = await registry.cleanupParent(parentExecutionId);
  assertEquals(cleanup?.runs[0].durability, 'failed');
});

Deno.test('Increment 110 fences child addressability to its parent execution', async () => {
  const registry = await builtinRegistry();
  const parentExecutionId = 'parent-fence-a';
  registry.openParent(parentExecutionId);
  const spawned = await registry.handle(
    { kind: 'spawn', agent: 'planner', task: 'parent fenced child' },
    undefined,
    parentExecutionId,
  );
  assert(spawned.ok && spawned.kind === 'spawn');
  const wrongParent = await registry.handle(
    { kind: 'status', runId: spawned.runId },
    undefined,
    'parent-fence-b',
  );
  assert(!wrongParent.ok);
  const collected = await registry.handle(
    { kind: 'collect', runId: spawned.runId },
    undefined,
    parentExecutionId,
  );
  assert(collected.ok && collected.kind === 'collect');
  await registry.cleanupParent(parentExecutionId);
  const closedParent = await registry.handle(
    { kind: 'collect', runId: spawned.runId },
    undefined,
    parentExecutionId,
  );
  assert(
    !closedParent.ok,
    'settled parent must not become a cross-turn mailbox',
  );
});

Deno.test('Increment 110 releases completed parent scopes without retaining tombstones', async () => {
  const registry = await builtinRegistry();
  const parentExecutionId = 'parent-reusable-scope';
  for (let index = 0; index < 3; index += 1) {
    registry.openParent(parentExecutionId);
    await registry.cleanupParent(parentExecutionId);
    const closed = await registry.handle(
      { kind: 'spawn', agent: 'planner', task: 'must remain closed' },
      undefined,
      parentExecutionId,
    );
    assert(!closed.ok);
    registry.releaseParent(parentExecutionId);
  }
});

Deno.test('Increment 110 records startup failure as interrupted', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-i110-startup-failure-',
  });
  const workspaceRoot = `${stateRoot}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  await history.initialize();
  try {
    const ref = managedRef('test/startup-failure');
    const registry = new ChildRunRegistry({
      options: {
        handle: handle(),
        workspaceRoot,
        agent: 'default',
        definition: ref,
        physicalIoMode: 'provider-free',
      },
      catalog: [{ name: 'researcher', ref }],
      resolveManagedModule: () => Promise.reject(new Error('managed module unavailable')),
      history,
      build: buildManifest(),
    });
    const parentExecutionId = 'parent-startup-failure';
    registry.openParent(parentExecutionId);
    const spawned = await registry.handle(
      { kind: 'spawn', agent: 'researcher', task: 'cannot start' },
      'startup-call',
      parentExecutionId,
    );
    assert(!spawned.ok && spawned.error.includes('managed module unavailable'));
    const rows = history.listExecutions().filter((row) =>
      row.parentExecutionId === parentExecutionId
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].lifecycle, 'settled');
    assertEquals(rows[0].outcome, 'interrupted');
    assertEquals(rows[0].definition, ref);
    await registry.cleanupParent(parentExecutionId);
  } finally {
    history.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 110 terminates and durably interrupts a child after cleanup deadline', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-i110-child-timeout-',
  });
  const workspaceRoot = `${stateRoot}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  await history.initialize();
  const channelName = `henji-i110-timeout-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  try {
    const started = waitForChannelKind(barrier, 'started');
    const registry = await builtinRegistry(history, 25);
    const parentExecutionId = 'parent-child-timeout';
    registry.openParent(parentExecutionId);
    const spawned = await registry.handle(
      {
        kind: 'spawn',
        agent: 'planner',
        task: `stubborn-barrier-child:${channelName}:T`,
      },
      undefined,
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn');
    await started;
    const cleanup = await withTimeout(
      registry.cleanupParent(parentExecutionId),
      'child cleanup deadline',
    );
    assertEquals(cleanup?.runs.map((run) => [run.state, run.durability]), [
      ['interrupted', 'yes'],
    ]);
    const row = history.readExecution(spawned.runId);
    assertEquals(row.lifecycle, 'settled');
    assertEquals(row.outcome, 'interrupted');
  } finally {
    barrier.postMessage({ kind: 'release' });
    barrier.close();
    history.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 110 propagates async RPC abort as turn cancellation', async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => markStarted = resolve);
  const rpc = (
    _request: AsyncAgentRequest,
    _callId?: string,
    signal?: AbortSignal,
  ): Promise<AsyncAgentResponse> =>
    new Promise((_resolve, reject) => {
      markStarted();
      signal?.addEventListener(
        'abort',
        () => reject(new TurnCancelledError()),
        { once: true },
      );
    });
  const tools = new Registry(createAsyncAgentTools(['planner'], rpc));
  const cancellation = new AbortController();
  const dispatched = tools.dispatch(
    {
      callId: 'collect-abort',
      name: 'collect_subagent',
      arguments: { runId: 'run-abort' },
    },
    { signal: cancellation.signal },
  );
  await started;
  cancellation.abort();
  const error = await dispatched.then(
    () => undefined,
    (value: unknown) => value,
  );
  assert(isTurnCancelledError(error), 'abort must remain a turn cancellation');
});

Deno.test('Increment 110 parent cancel releases a pending collect RPC', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i110-collect-cancel-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const channelName = `henji-i110-collect-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  try {
    const started = waitForChannelKind(barrier, 'started');
    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot: `${root}/state`,
      dataRoot: `${root}/data`,
      configRoot: `${root}/config`,
      persistence: 'new',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 500,
    });
    try {
      const submitted = created.session.submit(
        `async-spawn-barrier:${channelName}`,
      );
      await started;
      assertEquals(created.session.cancelActiveTurn(), 'requested');
      const outcome = await withTimeout(
        submitted,
        'pending collect cancellation',
      );
      assertEquals(outcome.stopReason, 'cancelled');
      assertEquals(created.session.transcriptSnapshot(), []);
    } finally {
      barrier.postMessage({ kind: 'release' });
      await created.close();
    }
  } finally {
    barrier.close();
    await Deno.remove(root, { recursive: true });
  }
});

const runUncollectedBarrierTurn = async (
  cancelParent: boolean,
): Promise<{
  readonly outcome: LoopOutcome;
  readonly artifacts: readonly StoredWorkerExecutionArtifact[];
}> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i110-precommit-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const stateRoot = `${root}/state`;
  const channelName = `henji-i110-precommit-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  try {
    const cancelObserved = waitForChannelKind(barrier, 'cancel_observed');
    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot: `${root}/data`,
      configRoot: `${root}/config`,
      persistence: 'new',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 1_000,
    });
    let outcome!: LoopOutcome;
    try {
      const submitted = created.session.submit(
        `async-spawn-uncollected:${channelName}`,
      );
      await cancelObserved;
      if (cancelParent) {
        assertEquals(created.session.cancelActiveTurn(), 'requested');
      }
      barrier.postMessage({ kind: 'release' });
      outcome = await withTimeout(submitted, 'pre-commit child cleanup');
    } finally {
      barrier.postMessage({ kind: 'release' });
      await created.close();
    }
    const history = new SqliteHistoryV7ProductionStore(
      stateRoot,
      workspaceRoot,
    );
    await history.initialize();
    try {
      const artifacts = await history.executionArtifacts.list();
      return { outcome, artifacts };
    } finally {
      history.close();
    }
  } finally {
    barrier.close();
    await Deno.remove(root, { recursive: true });
  }
};

Deno.test('Increment 110 records normal uncollected-child cleanup before commit', async () => {
  const { outcome, artifacts } = await runUncollectedBarrierTurn(false);
  assert(outcome.ok, JSON.stringify(outcome));
  const parent = artifacts.find((value) =>
    value.outcome?.finalText === 'parent proposal with uncollected child'
  );
  assert(
    parent !== undefined && parent.schemaVersion === 7 &&
      parent.childCleanup !== undefined,
    'parent artifact must retain child cleanup',
  );
  assertEquals(
    parent.childCleanup.runs.map((run) => [run.state, run.durability]),
    [
      ['cancelled', 'yes'],
    ],
  );
});

Deno.test('Increment 110 retains a valid parent result when child settlement fails', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i110-cleanup-failure-',
  });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const history = new SqliteHistoryV7ProductionStore(
    `${root}/state`,
    workspaceRoot,
  );
  await history.initialize();
  const historyPort = new Proxy(history, {
    get(target, property) {
      if (property === 'settleNonCanonicalExecution') {
        return (input: NonCanonicalExecutionInput) => {
          if (input.parentExecutionId !== undefined) {
            throw new Error('child settlement unavailable');
          }
          return target.settleNonCanonicalExecution(input);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as HistoryPersistencePort;
  const channelName = `henji-i110-cleanup-failure-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  let session: WorkerHostSession | undefined;
  try {
    const rootDefinition = await readDefinitionRevision(
      '',
      'builtin',
      'default',
    );
    const plannerDefinition = await readDefinitionRevision(
      '',
      'builtin',
      'planner',
    );
    session = await WorkerHostSession.open({
      handle: handle(),
      workspaceRoot,
      agent: 'default',
      definition: rootDefinition,
      modulePath: workerBuiltinModulePath('default'),
      asyncAgents: [{ name: 'planner', ref: plannerDefinition }],
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
      physicalIoMode: 'provider-free',
      historyPersistence: historyPort,
      cancelSettlementGraceMs: 1_000,
    });
    const cancelObserved = waitForChannelKind(barrier, 'cancel_observed');
    const submitted = session.submit(`async-spawn-uncollected:${channelName}`);
    await cancelObserved;
    barrier.postMessage({ kind: 'release' });
    const outcome = await withTimeout(
      submitted,
      'cleanup failure parent result',
    );
    assert(outcome.ok, JSON.stringify(outcome));
    assertEquals(outcome.finalText, 'parent proposal with uncollected child');
    const artifacts = await history.executionArtifacts.list();
    const parent = artifacts.find((value) =>
      value.outcome?.finalText === 'parent proposal with uncollected child'
    );
    assert(
      parent !== undefined && parent.schemaVersion === 7 &&
        parent.childCleanup !== undefined,
      'parent artifact must retain failed child cleanup',
    );
    assertEquals(
      parent.childCleanup.runs.map((
        run,
      ) => [run.state, run.durability, run.error]),
      [
        ['cancelled', 'failed', 'child settlement unavailable'],
      ],
    );
  } finally {
    barrier.postMessage({ kind: 'release' });
    barrier.close();
    try {
      if (session !== undefined) await session.close();
    } finally {
      history.close();
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('Increment 110 rejects a stale proposal cancelled during pre-commit cleanup', async () => {
  const { outcome, artifacts } = await runUncollectedBarrierTurn(true);
  assertEquals(outcome.stopReason, 'cancelled');
  const canonicalStale = artifacts.find((value) =>
    'adoption' in value && value.adoption === 'canonical' &&
    value.outcome?.finalText === 'parent proposal with uncollected child'
  );
  assert(
    canonicalStale === undefined,
    'cancelled stale proposal must not be canonical',
  );
});
