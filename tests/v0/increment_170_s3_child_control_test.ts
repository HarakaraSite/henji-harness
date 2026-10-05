import { deepStrictEqual, strictEqual } from 'node:assert';
import { createDataService } from '../../v0/agent/data/data_service.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import type { StoredExecutionEvent } from '../../v0/agent/history/history_store_contract.ts';
import type { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import { seedDataServiceParentExecution } from './helpers/increment_170_child_data.ts';

const assert: (value: unknown, message?: string) => asserts value = (
  value,
  message = 'assertion failed',
) => {
  if (!value) throw new Error(message);
};

const controlEvents = (
  events: readonly StoredExecutionEvent[],
): readonly StoredExecutionEvent[] =>
  events.filter((event) =>
    event.kind === 'cancel_requested' ||
    event.kind === 'cancel_sent' ||
    event.kind === 'cancel_failed' ||
    event.kind === 'cancel_received' ||
    event.kind === 'acknowledgement_requested' ||
    event.kind === 'acknowledgement_sent' ||
    event.kind === 'acknowledgement_failed' ||
    event.kind === 'process_cleanup_finished'
  );

const controlPayload = (
  event: StoredExecutionEvent,
): Record<string, unknown> => {
  assert(typeof event.payload === 'object' && event.payload !== null);
  return event.payload as Record<string, unknown>;
};

Deno.test('Increment 170 child cancel and ACK control facts are saved with Data terminals', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-child-control-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(stateRoot, { recursive: true });

  const data = await createDataService({ stateRoot, workspaceRoot });
  const descriptor = await data.openSession({
    persistence: 'none',
    agent: 'default',
    agentChoice: {},
    sessionId: `i170-child-control-parent-${crypto.randomUUID()}`,
    initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
  });
  const registry = new ChildRunRegistry({
    options: {
      data,
      descriptor,
      workspaceRoot,
      configRoot: `${root}/config`,
      agentChoice: {},
      physicalIoMode: 'provider-free',
    },
    currentCatalog: () => ['generic'],
  });
  const parentExecutionId = 'i170-child-control-parent-execution';
  let parentSession: WorkerHostSession | undefined;
  let completedRunId: string | undefined;
  let cancelledRunId: string | undefined;
  const channelName = `i170-child-control-${crypto.randomUUID()}`;
  const barrier = new BroadcastChannel(channelName);
  let resolveChildStarted!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    resolveChildStarted = resolve;
  });
  barrier.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as {
      readonly kind?: unknown;
      readonly label?: unknown;
    };
    if (message?.kind === 'started' && message.label === 'C') {
      resolveChildStarted();
    }
  };
  try {
    parentSession = await seedDataServiceParentExecution({
      data,
      descriptor,
      workspaceRoot,
      configRoot: `${root}/config`,
      agentChoice: {},
      executionId: parentExecutionId,
    });
    registry.openParent(parentExecutionId);
    const spawned = await registry.handle(
      { kind: 'spawn', agent: 'generic', task: 'finish child control run' },
      undefined,
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    completedRunId = spawned.runId;
    const collected = await registry.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(
      collected.ok && collected.kind === 'collect',
      JSON.stringify(collected),
    );
    strictEqual(collected.result.state, 'completed');
    strictEqual(collected.result.finalText, 'worker child result');

    const cancelling = await registry.handle(
      {
        kind: 'spawn',
        agent: 'generic',
        task: `barrier-child:${channelName}:C`,
      },
      undefined,
      parentExecutionId,
    );
    assert(
      cancelling.ok && cancelling.kind === 'spawn',
      JSON.stringify(cancelling),
    );
    cancelledRunId = cancelling.runId;
    await childStarted;

    const cancelled = await registry.handle(
      { kind: 'cancel', runId: cancelling.runId },
      undefined,
      parentExecutionId,
    );
    assert(
      cancelled.ok && cancelled.kind === 'cancel',
      JSON.stringify(cancelled),
    );
    strictEqual(cancelled.state, 'cancelled');
  } finally {
    barrier.postMessage({ kind: 'release' });
    barrier.close();
    await registry.cleanupAll();
    await parentSession?.close();
    await data.close();
  }

  const store = new SqliteHistoryStore(stateRoot, workspaceRoot, {
    readOnly: true,
  });
  await store.initialize();
  try {
    assert(completedRunId !== undefined);
    assert(cancelledRunId !== undefined);
    const completed = controlEvents(store.listExecutionEvents(completedRunId));
    deepStrictEqual(
      completed.map((
        event,
      ) => [event.kind, controlPayload(event).controlSequence]),
      [
        ['acknowledgement_requested', 1],
        ['acknowledgement_sent', 2],
        ['process_cleanup_finished', 3],
      ],
    );
    strictEqual(controlPayload(completed[1]!).accepted, true);
    strictEqual(controlPayload(completed[2]!).result, 'complete');

    const cancelled = controlEvents(store.listExecutionEvents(cancelledRunId));
    deepStrictEqual(
      cancelled.map((
        event,
      ) => [event.kind, controlPayload(event).controlSequence]),
      [
        ['cancel_requested', 1],
        ['cancel_sent', 2],
        ['cancel_received', 3],
        ['acknowledgement_requested', 4],
        ['acknowledgement_sent', 5],
        ['process_cleanup_finished', 6],
      ],
    );
    const cancelReceived = cancelled[2]!;
    const cancelPayload = controlPayload(cancelReceived);
    strictEqual(cancelReceived.observedAt, cancelPayload.observedAt);
    strictEqual(cancelReceived.workerSequence, cancelPayload.sequence);
    strictEqual(cancelPayload.result, 'requested');
    strictEqual(
      (cancelPayload.correlation as { readonly command: string }).command,
      'async-child',
    );
    strictEqual(controlPayload(cancelled[5]!).result, 'complete');

    const serializedControls = JSON.stringify([...completed, ...cancelled]);
    assert(!serializedControls.includes('finish child control run'));
    assert(!serializedControls.includes('cancel-child after request start'));
    assert(!serializedControls.includes('worker child result'));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
