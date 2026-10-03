import {
  childDataTest,
  closeChildDataTests,
  createChildDataTestRegistry,
} from './helpers/increment_170_child_data.ts';
import type { DataService } from '../../v0/agent/data/data_contract.ts';
import { managedChildModule, managedChildRef } from './managed_child_fixture.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import type { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import {
  bundledToolDefinitionLoadRequests,
} from '../../v0/agent/worker/worker_definition_revision.ts';

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
  history: SqliteHistoryV7ProductionStore,
  rootMaxSteps?: number,
): Promise<ChildRunRegistry> => {
  const plannerRef = managedChildRef();
  const { registry } = await createChildDataTestRegistry({
    options: {
      physicalIoMode: 'provider-free',
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
      ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
    },
    catalog: [{ name: 'probe-child', ref: plannerRef }],
    resolveManagedModule: managedChildModule,
    store: history,
  });
  return registry;
};

const withStore = async (
  name: string,
  run: (store: SqliteHistoryV7ProductionStore) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: `henji-i111-${name}-` });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(
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
    const children = await registry(store);
    const parentExecutionId = 'parent-i111-completed';
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

childDataTest('Increment 111 preserves max-steps counts and structured diagnostic', async () => {
  await withStore('max-steps', async (store) => {
    const children = await registry(store, 2);
    const parentExecutionId = 'parent-i111-max-steps';
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
});

childDataTest(
  'Increment 111 preserves the Worker failure instead of a generic child error',
  async () => {
    await withStore('worker-failure', async (store) => {
      const children = await registry(store);
      const parentExecutionId = 'parent-i111-worker-failure';
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

childDataTest('Increment 111 does not fabricate evidence for pre-start cancellation', async () => {
  await withStore('pre-start', async (store) => {
    let releaseAdmission!: () => void;
    let admissionStarted!: () => void;
    const barrier = new Promise<void>((resolve) => releaseAdmission = resolve);
    const started = new Promise<void>((resolve) => admissionStarted = resolve);
    const { registry: children } = await createChildDataTestRegistry({
      options: {
        physicalIoMode: 'provider-free',
        toolDefinitions: await bundledToolDefinitionLoadRequests(),
      },
      catalog: [{ name: 'probe-child', ref: managedChildRef() }],
      resolveManagedModule: managedChildModule,
      store,
      transformData: (data) =>
        new Proxy(data, {
          get(target, key) {
            if (key === 'executionAdmit') {
              return async (...args: Parameters<DataService['executionAdmit']>) => {
                admissionStarted();
                await barrier;
                return await target.executionAdmit(...args);
              };
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    });
    const parentExecutionId = 'parent-i111-pre-start-cancel';
    children.openParent(parentExecutionId);
    const spawning = children.handle(
      { kind: 'spawn', agent: 'probe-child', task: 'never dispatched' },
      undefined,
      parentExecutionId,
    );
    await started;
    const cleanup = children.cleanupParent(parentExecutionId);
    releaseAdmission();
    const [spawned, cleaned] = await Promise.all([spawning, cleanup]);
    assert(!spawned.ok);
    assertEquals(cleaned?.runs[0].state, 'cancelled');
    const rows = store.listExecutions();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, 'cancelled');
    assertEquals(rows[0].outcomeJson?.steps, 0);
    assertEquals(
      store.listExecutionEvents(rows[0].executionId).filter((event) =>
        event.kind === 'provider_request_start'
      ).length,
      0,
    );
    assertEquals(rows[0].diagnosticId, undefined);
  });
});
