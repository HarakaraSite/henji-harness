import { writeProbeAgentConfiguration } from './managed_child_fixture.ts';
import {
  type AsyncAgentRequest,
  type AsyncAgentResponse,
  createAsyncAgentTools,
} from '../../v0/agent/tools/async_agents.ts';
import { isTurnCancelledError, TurnCancelledError } from '../../v0/agent/core/cancellation.ts';
import type { LoopOutcome } from '../../v0/agent/core/contracts.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import type { DataService } from '../../v0/agent/data/data_contract.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import type { WorkerHostSessionOptions } from '../../v0/agent/worker/worker_host_contract.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type { WorkerHostCommand } from '../../v0/agent/worker/worker_protocol.ts';
import type { StoredWorkerExecutionArtifact } from '../../v0/agent/worker/worker_execution_artifact.ts';
import {
  childDataTest,
  closeChildDataTests,
  createChildDataTestRegistry,
} from './helpers/increment_170_child_data.ts';
import { createIncrement170FoundationDataHarness } from './helpers/increment_170_foundation_data.ts';

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

type RegistryDataOverrides = {
  readonly executionAdmit?: (
    base: DataService['executionAdmit'],
    ...args: Parameters<DataService['executionAdmit']>
  ) => ReturnType<DataService['executionAdmit']>;
  readonly settleChildExecution?: (
    base: DataService['settleChildExecution'],
    ...args: Parameters<DataService['settleChildExecution']>
  ) => ReturnType<DataService['settleChildExecution']>;
  readonly sealGeneration?: (
    base: DataService['sealGeneration'],
    ...args: Parameters<DataService['sealGeneration']>
  ) => ReturnType<DataService['sealGeneration']>;
};

const parentSeeders = new WeakMap<
  ChildRunRegistry,
  (executionId: string) => Promise<void>
>();

const seedParentExecution = async (
  registry: ChildRunRegistry,
  executionId: string,
): Promise<void> => {
  const seed = parentSeeders.get(registry);
  if (seed === undefined) {
    throw new Error('child test parent seeder is unavailable');
  }
  await seed(executionId);
};

const registryWithOptions = async (input: {
  readonly childName?: string;
  readonly dataOverrides?: RegistryDataOverrides;
  readonly store?: SqliteHistoryStore;
  readonly cancelSettlementGraceMs?: number;
  readonly capsuleFactory?: WorkerHostSessionOptions['capsuleFactory'];
  readonly setupConfiguration?: (configRoot: string) => Promise<void>;
}): Promise<ChildRunRegistry> => {
  const overrides = input.dataOverrides ?? {};
  const transformData = (baseData: DataService): DataService =>
    new Proxy(baseData, {
      get(target, property) {
        if (
          property === 'executionAdmit' &&
          overrides.executionAdmit !== undefined
        ) {
          const base = target.executionAdmit.bind(target);
          return (...args: Parameters<DataService['executionAdmit']>) =>
            overrides.executionAdmit!(base, ...args);
        }
        if (
          property === 'settleChildExecution' &&
          overrides.settleChildExecution !== undefined
        ) {
          const base = target.settleChildExecution.bind(target);
          return (...args: Parameters<DataService['settleChildExecution']>) =>
            overrides.settleChildExecution!(base, ...args);
        }
        if (
          property === 'sealGeneration' &&
          overrides.sealGeneration !== undefined
        ) {
          const base = target.sealGeneration.bind(target);
          return (...args: Parameters<DataService['sealGeneration']>) =>
            overrides.sealGeneration!(base, ...args);
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const result = await createChildDataTestRegistry({
    options: {
      physicalIoMode: 'provider-free',
      ...(input.capsuleFactory === undefined ? {} : { capsuleFactory: input.capsuleFactory }),
      ...(input.cancelSettlementGraceMs === undefined
        ? {}
        : { cancelSettlementGraceMs: input.cancelSettlementGraceMs }),
    },
    currentCatalog: () => [input.childName ?? 'probe-child'],
    setupConfiguration: input.setupConfiguration ?? (async (configRoot) => {
      await writeProbeAgentConfiguration(
        configRoot,
        input.childName ?? 'probe-child',
      );
    }),
    ...(input.store === undefined ? {} : { store: input.store }),
    ...(input.dataOverrides === undefined ? {} : { transformData }),
  });
  parentSeeders.set(result.registry, result.seedParentExecution);
  return result.registry;
};

const builtinRegistry = async (
  dataOverrides: RegistryDataOverrides = {},
  cancelSettlementGraceMs?: number,
  childName = 'probe-child',
  store?: SqliteHistoryStore,
): Promise<ChildRunRegistry> => {
  return await registryWithOptions({
    dataOverrides,
    childName,
    ...(store === undefined ? {} : { store }),
    ...(cancelSettlementGraceMs === undefined ? {} : { cancelSettlementGraceMs }),
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

childDataTest(
  'Increment 110 loads the selected external JSON Tool inside its child Worker',
  async () => {
    const root = await Deno.makeTempDir({
      prefix: 'henji-i110-managed-planner-',
    });
    try {
      const registry = await registryWithOptions({
        setupConfiguration: async (configRoot) => {
          await writeProbeAgentConfiguration(configRoot, 'probe-child', {
            name: 'probe-child',
            revision: 'external-tool-fixture',
            instruction: 'Use the selected read tool.',
            tools: ['read'],
            agents: [],
          });
          const folder = `${configRoot}/tools/bound-read`;
          await Deno.mkdir(folder, { recursive: true });
          await Deno.writeTextFile(
            `${configRoot}/tools.json`,
            JSON.stringify({
              schemaVersion: 1,
              tools: { read: 'tools/bound-read' },
            }),
          );
          await Deno.writeTextFile(
            `${folder}/tool.json`,
            JSON.stringify({
              name: 'read',
              revision: 'external-fixture',
              apiContract: 'henji-tool/v1',
              entry: 'index.js',
            }),
          );
          await Deno.writeTextFile(
            `${folder}/index.js`,
            `export default () => ({
              name: 'read',
              description: 'bound read fixture',
              inputSchema: { type: 'object' },
              terminal: true,
              execute: () => ({ kind: 'terminate', text: 'BOUND_READ', finalText: 'BOUND_READ', terminalKind: 'json_result' }),
            });\n`,
          );
        },
      });
      try {
        const parentExecutionId = 'parent-external-tool';
        await seedParentExecution(registry, parentExecutionId);
        registry.openParent(parentExecutionId);
        const spawned = await registry.handle(
          { kind: 'spawn', agent: 'probe-child', task: 'read bound tool' },
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
        await registry.cleanupParent(parentExecutionId);
      } finally {
        await registry.cleanupAll();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

childDataTest(
  'Increment 110 cleanup joins in-flight durable admission',
  async () => {
    const root = await Deno.makeTempDir({
      prefix: 'henji-i110-admission-join-',
    });
    const workspaceRoot = `${root}/workspace`;
    await Deno.mkdir(workspaceRoot);
    const history = new SqliteHistoryStore(
      `${root}/state`,
      workspaceRoot,
    );
    let releaseAdmission!: () => void;
    let markAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => markAdmissionStarted = resolve);
    const admissionBarrier = new Promise<void>((resolve) => releaseAdmission = resolve);
    let turnDispatches = 0;
    const registry = await registryWithOptions({
      childName: 'researcher',
      store: history,
      cancelSettlementGraceMs: 25,
      dataOverrides: {
        executionAdmit: async (base, ...args) => {
          markAdmissionStarted();
          await admissionBarrier;
          return await base(...args);
        },
      },
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        return {
          send(command, transfer) {
            if (command.kind === 'turn') turnDispatches += 1;
            capsule.send(command, transfer);
          },
          subscribe(listener) {
            return capsule.subscribe(listener);
          },
          terminate() {
            capsule.terminate();
          },
        };
      },
    });
    const parentExecutionId = 'parent-admission-barrier';
    await seedParentExecution(registry, parentExecutionId);
    registry.openParent(parentExecutionId);
    const spawn = registry.handle(
      { kind: 'spawn', agent: 'researcher', task: 'never start' },
      'admission-call',
      parentExecutionId,
    );
    try {
      await withTimeout(admissionStarted, 'Data execution admission start');
      let cleanupSettled = false;
      const cleanup = registry.cleanupParent(parentExecutionId).then(
        (value) => {
          cleanupSettled = true;
          return value;
        },
      );
      await Promise.resolve();
      assert(!cleanupSettled, 'cleanup must join the in-flight admission');
      releaseAdmission();
      const [spawned, observation] = await Promise.all([spawn, cleanup]);
      assert(!spawned.ok, 'late admission must not return spawn success');
      assertEquals(turnDispatches, 0);
      assertEquals(
        observation?.runs.map((run) => [run.state, run.durability]),
        [
          ['cancelled', 'yes'],
        ],
      );
      await history.initialize();
      const rows = history.listExecutions().filter((row) =>
        row.parentExecutionId === parentExecutionId
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].lifecycle, 'settled');
      assertEquals(rows[0].outcome, 'cancelled');
    } finally {
      releaseAdmission();
      await closeChildDataTests(history);
      history.close();
      await Deno.remove(root, { recursive: true });
    }
  },
);

childDataTest(
  'Increment 110 hides a terminal result when durable settlement fails',
  async () => {
    const registry = await builtinRegistry({
      settleChildExecution: () => {
        throw new Error('settlement unavailable');
      },
    });
    try {
      const parentExecutionId = 'parent-settlement-failure';
      await seedParentExecution(registry, parentExecutionId);
      registry.openParent(parentExecutionId);
      const spawned = await registry.handle(
        {
          kind: 'spawn',
          agent: 'probe-child',
          task: 'child terminal durability',
        },
        undefined,
        parentExecutionId,
      );
      assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
      const collected = await registry.handle(
        { kind: 'collect', runId: spawned.runId },
        undefined,
        parentExecutionId,
      );
      assert(
        !collected.ok && collected.error.includes('settlement unavailable'),
      );
      const status = await registry.handle(
        { kind: 'status', runId: spawned.runId },
        undefined,
        parentExecutionId,
      );
      assert(!status.ok && status.error.includes('settlement unavailable'));
      const cleanup = await registry.cleanupParent(parentExecutionId);
      assertEquals(cleanup?.runs[0].durability, 'failed');
    } finally {
      await registry.cleanupAll();
    }
  },
);

childDataTest(
  'Increment 110 fences child addressability to its parent execution',
  async () => {
    const registry = await builtinRegistry();
    try {
      const parentExecutionId = 'parent-fence-a';
      await seedParentExecution(registry, parentExecutionId);
      registry.openParent(parentExecutionId);
      const spawned = await registry.handle(
        { kind: 'spawn', agent: 'probe-child', task: 'parent fenced child' },
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
    } finally {
      await registry.cleanupAll();
    }
  },
);

childDataTest(
  'Increment 110 releases completed parent scopes without retaining tombstones',
  async () => {
    const registry = await builtinRegistry();
    try {
      const parentExecutionId = 'parent-reusable-scope';
      for (let index = 0; index < 3; index += 1) {
        registry.openParent(parentExecutionId);
        await registry.cleanupParent(parentExecutionId);
        const closed = await registry.handle(
          { kind: 'spawn', agent: 'probe-child', task: 'must remain closed' },
          undefined,
          parentExecutionId,
        );
        assert(!closed.ok);
        registry.releaseParent(parentExecutionId);
      }
    } finally {
      await registry.cleanupAll();
    }
  },
);

childDataTest(
  'Increment 110 cancels a child during Worker startup before execution admission',
  async () => {
    const root = await Deno.makeTempDir({
      prefix: 'henji-i110-parent-cleanup-resolution-',
    });
    const workspaceRoot = `${root}/workspace`;
    await Deno.mkdir(workspaceRoot);
    const history = new SqliteHistoryStore(
      `${root}/state`,
      workspaceRoot,
    );
    let markStartSent!: () => void;
    const startSent = new Promise<void>((resolve) => markStartSent = resolve);
    let startCommand: WorkerHostCommand | undefined;
    let startTransfer: Transferable[] | undefined;
    let startCapsule: WorkerCapsule | undefined;
    let released = false;
    const pending: { command: WorkerHostCommand; transfer?: Transferable[] }[] = [];
    let admissions = 0;
    let turnDispatches = 0;
    const registry = await registryWithOptions({
      store: history,
      childName: 'probe-child',
      cancelSettlementGraceMs: 25,
      dataOverrides: {
        executionAdmit: async (base, ...args) => {
          admissions += 1;
          return await base(...args);
        },
      },
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        startCapsule = capsule;
        return {
          send(command, transfer) {
            if (command.kind === 'start' && !released) {
              startCommand = command;
              startTransfer = transfer;
              markStartSent();
              return;
            }
            if (command.kind === 'turn') turnDispatches += 1;
            if (!released) {
              pending.push({
                command,
                ...(transfer === undefined ? {} : { transfer }),
              });
              return;
            }
            capsule.send(command, transfer);
          },
          subscribe(listener) {
            return capsule.subscribe(listener);
          },
          terminate() {
            capsule.terminate();
          },
        };
      },
    });
    const releaseStart = () => {
      if (released) return;
      released = true;
      if (startCommand === undefined) {
        throw new Error('child Worker start was not queued');
      }
      startCapsule!.send(startCommand, startTransfer);
      for (const entry of pending) {
        startCapsule!.send(entry.command, entry.transfer);
      }
      pending.length = 0;
    };
    try {
      const parentExecutionId = 'parent-ref-resolution';
      await seedParentExecution(registry, parentExecutionId);
      registry.openParent(parentExecutionId);
      const spawn = registry.handle(
        { kind: 'spawn', agent: 'probe-child', task: 'must not start' },
        undefined,
        parentExecutionId,
      );
      await withTimeout(startSent, 'child Worker start command');
      const cleanup = registry.cleanupParent(parentExecutionId);
      await Promise.resolve();
      releaseStart();
      const [response, observation] = await Promise.all([spawn, cleanup]);
      assertEquals(
        observation?.runs.map((run) => [run.state, run.durability]),
        [
          ['cancelled', 'yes'],
        ],
      );
      assertEquals(response, {
        ok: false,
        error: 'Worker host session closed',
      });
      assertEquals(turnDispatches, 0);
      await history.initialize();
      const rows = history.listExecutions().filter((row) =>
        row.parentExecutionId === parentExecutionId
      );
      assertEquals(rows.length, 0);
      assertEquals(admissions, 0);
      registry.releaseParent(parentExecutionId);
      assertEquals(
        (Reflect.get(registry, 'runs') as Map<string, unknown>).size,
        0,
      );
    } finally {
      if (startCommand !== undefined) releaseStart();
      await closeChildDataTests(history);
      history.close();
      await Deno.remove(root, { recursive: true });
    }
  },
);

childDataTest(
  'Increment 110 rejects a malformed child Agent before Data execution admission',
  async () => {
    const root = await Deno.makeTempDir({
      prefix: 'henji-i110-startup-failure-',
    });
    const workspaceRoot = `${root}/workspace`;
    await Deno.mkdir(workspaceRoot);
    const history = new SqliteHistoryStore(
      `${root}/state`,
      workspaceRoot,
    );
    const registry = await registryWithOptions({
      childName: 'researcher',
      store: history,
      setupConfiguration: async (configRoot) => {
        const file = await writeProbeAgentConfiguration(
          configRoot,
          'researcher',
        );
        await Deno.writeTextFile(file, '{');
      },
    });
    try {
      const parentExecutionId = 'parent-startup-failure';
      await seedParentExecution(registry, parentExecutionId);
      registry.openParent(parentExecutionId);
      const spawned = await registry.handle(
        { kind: 'spawn', agent: 'researcher', task: 'cannot start' },
        'startup-call',
        parentExecutionId,
      );
      assert(!spawned.ok && spawned.error.includes('researcher'));
      await history.initialize();
      const rows = history.listExecutions().filter((row) =>
        row.parentExecutionId === parentExecutionId
      );
      assertEquals(rows.length, 0);
      await registry.cleanupParent(parentExecutionId);
    } finally {
      await closeChildDataTests(history);
      history.close();
      await Deno.remove(root, { recursive: true });
    }
  },
);

childDataTest(
  'Increment 110 terminates and durably interrupts a child after cleanup deadline',
  async () => {
    const root = await Deno.makeTempDir({
      prefix: 'henji-i110-child-timeout-',
    });
    const workspaceRoot = `${root}/workspace`;
    await Deno.mkdir(workspaceRoot);
    const history = new SqliteHistoryStore(
      `${root}/state`,
      workspaceRoot,
    );
    const registry = await builtinRegistry(
      {},
      25,
      'probe-child',
      history,
    );
    const channelName = `henji-i110-timeout-${crypto.randomUUID()}`;
    const barrier = new BroadcastChannel(channelName);
    try {
      const started = waitForChannelKind(barrier, 'started');
      const parentExecutionId = 'parent-child-timeout';
      await seedParentExecution(registry, parentExecutionId);
      registry.openParent(parentExecutionId);
      const spawned = await registry.handle(
        {
          kind: 'spawn',
          agent: 'probe-child',
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
      await history.initialize();
      const row = history.readExecution(spawned.runId);
      assertEquals(row.lifecycle, 'settled');
      assertEquals(row.outcome, 'interrupted');
    } finally {
      barrier.postMessage({ kind: 'release' });
      barrier.close();
      await closeChildDataTests(history);
      history.close();
      await Deno.remove(root, { recursive: true });
    }
  },
);

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
  const tools = new Registry(createAsyncAgentTools(['probe-child'], rpc));
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
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const channelName = `henji-i110-collect-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  try {
    const started = waitForChannelKind(barrier, 'started');
    await writeProbeAgentConfiguration(`${root}/config`, 'probe-child');
    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
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
      const history = new SqliteHistoryStore(
        stateRoot,
        workspaceRoot,
      );
      await history.initialize();
      try {
        const record = await history.readWorker(created.session.sessionId);
        assertEquals(record.nextTurn, 1);
        assertEquals(record.transcript, []);
      } finally {
        history.close();
      }
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
  readonly outcome: Omit<LoopOutcome, 'transcript'>;
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
    await writeProbeAgentConfiguration(`${root}/config`, 'probe-child');
    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot: `${root}/data`,
      configRoot: `${root}/config`,
      persistence: 'new',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 1_000,
    });
    let outcome!: Omit<LoopOutcome, 'transcript'>;
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
    const history = new SqliteHistoryStore(
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
    parent !== undefined && parent.schemaVersion === 1 &&
      parent.childCleanup !== undefined,
    `parent artifact must retain child cleanup: ${
      JSON.stringify(
        artifacts.map((value) => ({
          executionId: value.executionId,
          agent: value.agent,
          task: value.command.task,
          finalText: value.outcome?.finalText,
          childCleanup: value.childCleanup,
          state: value.normalizedOutcome,
        })),
      )
    }`,
  );
  assertEquals(
    parent.childCleanup.runs.map((run) => [run.state, run.durability]),
    [
      ['cancelled', 'yes'],
    ],
  );
});

Deno.test('Increment 110 rejects a parent proposal when child terminal commit is unavailable', async () => {
  const harness = await createIncrement170FoundationDataHarness({
    persistence: 'none',
    agent: 'default',
    prefix: 'henji-i110-cleanup-failure-',
  });
  const childExecutionIds = new Set<string>();
  const data: DataService = new Proxy(harness.data, {
    get(target, property) {
      if (property === 'executionAdmit') {
        const base = target.executionAdmit.bind(target);
        return async (...args: Parameters<DataService['executionAdmit']>) => {
          if (args[1].parentExecutionId !== undefined) {
            childExecutionIds.add(args[1].executionId);
          }
          return await base(...args);
        };
      }
      if (property === 'settleChildExecution') {
        const base = target.settleChildExecution.bind(target);
        return async (
          ...args: Parameters<DataService['settleChildExecution']>
        ) => {
          if (childExecutionIds.has(args[1].executionId)) {
            throw new Error('child settlement unavailable');
          }
          return await base(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const channelName = `henji-i110-cleanup-failure-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let history: SqliteHistoryStore | undefined;
  try {
    await writeProbeAgentConfiguration(`${harness.root}/config`, 'probe-child');
    created = await createWorkerSession({
      workspaceRoot: harness.workspaceRoot,
      stateRoot: harness.stateRoot,
      dataRoot: `${harness.root}/data`,
      configRoot: `${harness.root}/config`,
      data,
      persistence: 'new',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 1_000,
    });
    const cancelObserved = waitForChannelKind(barrier, 'cancel_observed');
    const submitted = created.session.submit(
      `async-spawn-uncollected:${channelName}`,
    );
    await cancelObserved;
    barrier.postMessage({ kind: 'release' });
    const outcome = await withTimeout(
      submitted,
      'cleanup failure parent result',
    );
    assert(!outcome.ok, JSON.stringify(outcome));
    assertEquals(outcome.stopReason, 'contract_failure');
    assertEquals(outcome.error, 'child cleanup failed');
    assertEquals(created.session.currentPosition().committedTurn, 0);
    history = new SqliteHistoryStore(
      harness.stateRoot,
      harness.workspaceRoot,
    );
    await history.initialize();
    const parentRows = history.listExecutionsForSession(
      created.session.sessionId,
    );
    assertEquals(parentRows.length, 1);
    const parentRow = parentRows[0];
    assert(parentRow !== undefined);
    assertEquals(parentRow.lifecycle, 'settled');
    assertEquals(parentRow.outcome, 'failed');
    assertEquals(parentRow.adoption, 'non_canonical');
    assertEquals(parentRow.committedRevision, undefined);
    const canonical = await history.readWorker(created.session.sessionId);
    assertEquals(canonical.nextTurn, 1);
    assertEquals(canonical.transcript, []);
    const parentEvents = history.listExecutionEvents(parentRow.executionId);
    const parentAck = parentEvents.find((event) => event.kind === 'acknowledgement_sent');
    assert(parentAck !== undefined);
    assertEquals(
      (parentAck.payload as { readonly accepted?: unknown }).accepted,
      false,
    );
    const childRows = history.listExecutions().filter((row) =>
      row.parentExecutionId === parentRow.executionId
    );
    assertEquals(childRows.length, 1);
    const childRow = childRows[0];
    assert(childRow !== undefined);
    assertEquals(childRow.lifecycle, 'active');
    assertEquals(childRow.outcome, 'unknown');
    assert(
      !history.listExecutionEvents(childRow.executionId).some((
        event,
      ) => event.kind === 'acknowledgement_sent'),
    );
    const artifacts = await history.executionArtifacts.list();
    const parent = artifacts.find((value) => value.executionId === parentRow.executionId);
    assert(
      parent !== undefined && parent.schemaVersion === 1 &&
        parent.childCleanup !== undefined,
      `noncanonical parent artifact must retain the child commit failure: ${
        JSON.stringify(artifacts)
      }`,
    );
    assertEquals(parent.normalizedOutcome, 'failed');
    assertEquals(parent.adoption, 'non_canonical');
    assertEquals(parent.storeResult, 'not_attempted');
    assertEquals(
      parent.childCleanup.runs.map((
        run,
      ) => [run.state, run.durability, run.error]),
      [
        ['interrupted', 'failed', 'child settlement unavailable'],
      ],
    );
  } finally {
    barrier.postMessage({ kind: 'release' });
    barrier.close();
    try {
      await created?.close();
    } finally {
      try {
        history?.close();
      } finally {
        await harness.close();
      }
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
