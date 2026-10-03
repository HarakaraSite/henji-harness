import {
  childDataTest,
  closeChildDataTests,
  createChildDataTestRegistry,
} from './helpers/increment_170_child_data.ts';
import { writeProbeAgentConfiguration } from './managed_child_fixture.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';

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

const registry = async (
  history: SqliteHistoryStore,
  rootMaxSteps?: number,
): Promise<Awaited<ReturnType<typeof createChildDataTestRegistry>>> => {
  return await createChildDataTestRegistry({
    options: {
      physicalIoMode: 'provider-free',
      ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
    },
    currentCatalog: () => ['probe-child'],
    setupConfiguration: async (configRoot) => {
      await writeProbeAgentConfiguration(configRoot);
    },
    store: history,
  });
};

const withStore = async (
  name: string,
  run: (store: SqliteHistoryStore) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: `henji-i111-${name}-` });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(
    `${root}/state`,
    workspaceRoot,
  );
  await store.initialize();
  try {
    await run(store);
  } finally {
    await closeChildDataTests(store);
    store.close();
    await Deno.remove(root, { recursive: true });
  }
};

childDataTest('Increment 111 persists completed child outcome', async () => {
  await withStore('completed', async (store) => {
    const fixture = await registry(store);
    const { registry: children } = fixture;
    const parentExecutionId = 'parent-i111-completed';
    await fixture.seedParentExecution(parentExecutionId);
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      { kind: 'spawn', agent: 'probe-child', task: 'summarize the child task' },
      'spawn-i111-completed',
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(
      collected.ok && collected.kind === 'collect',
      JSON.stringify(collected),
    );
    assertEquals(collected.result.state, 'completed');
    assertEquals(collected.result.stopReason, 'final');
    assertEquals(collected.result.providerRequestCount, 0);
    assertEquals(collected.result.contextDurability, 'complete');

    const row = store.readExecution(spawned.runId);
    assertEquals(row.outcomeJson?.stopReason, 'final');
    assertEquals(row.outcomeJson?.steps, 1);
    assertEquals(row.outcomeJson?.turnProviderRequestCount, 0);
    await children.cleanupParent(parentExecutionId);
  });
});

childDataTest(
  'Increment 111 preserves max-steps counts and structured diagnostic',
  async () => {
    await withStore('max-steps', async (store) => {
      const fixture = await registry(store, 2);
      const { registry: children } = fixture;
      const parentExecutionId = 'parent-i111-max-steps';
      await fixture.seedParentExecution(parentExecutionId);
      children.openParent(parentExecutionId);
      const spawned = await children.handle(
        { kind: 'spawn', agent: 'probe-child', task: 'ten-step child task' },
        undefined,
        parentExecutionId,
      );
      assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
      const collected = await children.handle(
        { kind: 'collect', runId: spawned.runId },
        undefined,
        parentExecutionId,
      );
      assert(
        collected.ok && collected.kind === 'collect',
        JSON.stringify(collected),
      );
      assertEquals(collected.result.state, 'failed');
      assertEquals(collected.result.stopReason, 'max_steps');
      assertEquals(collected.result.providerRequestCount, 0);
      assertEquals(collected.result.diagnosticCode, 'model_step_limit');
      assertEquals(collected.result.diagnosticDurability, 'yes');

      const row = store.readExecution(spawned.runId);
      assertEquals(row.outcomeJson?.stopReason, 'max_steps');
      assertEquals(row.outcomeJson?.steps, 2);
      assertEquals(row.outcomeJson?.toolCallCount, 2);
      assertEquals(row.outcomeJson?.toolResultCount, 2);
      assertEquals(row.outcomeJson?.turnProviderRequestCount, 0);
      assertEquals(row.diagnosticId, collected.result.diagnosticId);
      const diagnostic = await store.diagnostics.read(row.diagnosticId!);
      assertEquals(diagnostic.code, 'model_step_limit');
      await children.cleanupParent(parentExecutionId);
    });
  },
);

childDataTest(
  'Increment 111 preserves the Worker failure instead of a generic child error',
  async () => {
    await withStore('worker-failure', async (store) => {
      const fixture = await registry(store);
      const { registry: children } = fixture;
      const parentExecutionId = 'parent-i111-worker-failure';
      await fixture.seedParentExecution(parentExecutionId);
      children.openParent(parentExecutionId);
      const spawned = await children.handle(
        { kind: 'spawn', agent: 'probe-child', task: 'child-fail task' },
        undefined,
        parentExecutionId,
      );
      assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
      const collected = await children.handle(
        { kind: 'collect', runId: spawned.runId },
        undefined,
        parentExecutionId,
      );
      assert(
        collected.ok && collected.kind === 'collect',
        JSON.stringify(collected),
      );
      assertEquals(collected.result.state, 'failed');
      assertEquals(collected.result.stopReason, 'contract_failure');
      assertEquals(
        collected.result.error,
        'model contract failure: child task failed on purpose',
      );
      assertEquals(collected.result.diagnosticCode, 'unknown_code');
      assertEquals(collected.result.diagnosticDurability, 'yes');

      const row = store.readExecution(spawned.runId);
      assertEquals(row.outcomeJson?.error, collected.result.error);
      assertEquals(row.outcomeJson?.steps, 1);
      assertEquals(row.outcomeJson?.turnProviderRequestCount, 0);
      assertEquals(
        (await store.diagnostics.read(row.diagnosticId!)).code,
        'unknown_code',
      );
      await children.cleanupParent(parentExecutionId);
    });
  },
);

childDataTest(
  'Increment 111 does not fabricate evidence for pre-start cancellation',
  async () => {
    await withStore('pre-start', async (store) => {
      let releaseStart!: () => void;
      let markStartSent!: () => void;
      const startGate = new Promise<void>((resolve) => releaseStart = resolve);
      const startSent = new Promise<void>((resolve) => markStartSent = resolve);
      const fixture = await createChildDataTestRegistry({
        options: {
          physicalIoMode: 'provider-free',
          capsuleFactory: (url) => {
            const capsule = new WorkerCapsule(url);
            return {
              send(command, transfer) {
                if (command.kind === 'start') {
                  markStartSent();
                  void startGate.then(() => capsule.send(command, transfer));
                } else capsule.send(command, transfer);
              },
              subscribe(listener) {
                return capsule.subscribe(listener);
              },
              terminate() {
                capsule.terminate();
              },
            };
          },
        },
        currentCatalog: () => ['probe-child'],
        setupConfiguration: async (configRoot) => {
          await writeProbeAgentConfiguration(configRoot);
        },
        store,
      });
      const { registry: children } = fixture;
      const parentExecutionId = 'parent-i111-pre-start-cancel';
      await fixture.seedParentExecution(parentExecutionId);
      children.openParent(parentExecutionId);
      const spawning = children.handle(
        { kind: 'spawn', agent: 'probe-child', task: 'never dispatched' },
        undefined,
        parentExecutionId,
      );
      await startSent;
      const cleanup = children.cleanupParent(parentExecutionId);
      releaseStart();
      const [spawned, cleaned] = await Promise.all([spawning, cleanup]);
      assert(!spawned.ok);
      assertEquals(cleaned?.runs[0].state, 'cancelled');
      const rows = store.listExecutions().filter((row) =>
        row.parentExecutionId === parentExecutionId
      );
      assertEquals(rows.length, 0);
    });
  },
);
