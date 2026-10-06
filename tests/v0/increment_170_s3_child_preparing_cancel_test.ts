import { strictEqual } from 'node:assert';
import { createDataService } from '../../v0/agent/data/data_service.ts';
import type { AgentDataPortRequest } from '../../v0/agent/data/agent_data_contract.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerCancelReceivedMessage,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import type { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import { seedDataServiceParentExecution } from './helpers/increment_170_child_data.ts';

const within = async <T>(promise: Promise<T>, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

Deno.test('Increment 170 child cancellation during Data context preparation starts no provider request', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i170-child-preparing-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(stateRoot, { recursive: true });

  const data = await createDataService({ stateRoot, workspaceRoot });
  const descriptor = await data.openSession({
    persistence: 'none',
    agent: 'default',
    agentChoice: {},
    sessionId: `i170-child-preparing-parent-${crypto.randomUUID()}`,
    initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
  });
  const ports: MessagePort[] = [];
  let resolveTurnContext!: (
    request: Extract<AgentDataPortRequest, { kind: 'generation_context' }>,
  ) => void;
  const turnContextRequested = new Promise<
    Extract<AgentDataPortRequest, { kind: 'generation_context' }>
  >((resolve) => resolveTurnContext = resolve);
  let resolveCancelReceived!: (message: WorkerCancelReceivedMessage) => void;
  const cancelReceived = new Promise<WorkerCancelReceivedMessage>(
    (resolve) => resolveCancelReceived = resolve,
  );
  let releaseContext!: () => void;
  const contextGate = new Promise<void>((resolve) => releaseContext = resolve);
  const registry = new ChildRunRegistry({
    options: {
      data,
      descriptor,
      workspaceRoot,
      configRoot: `${root}/config`,
      credentialRoot: `${root}/credentials`,
      agentChoice: {},
      physicalIoMode: 'provider-free',
      capsuleFactory: (url): WorkerHostCapsule => {
        const capsule = new WorkerCapsule(url);
        return {
          send(command, transfer) {
            if (command.kind !== 'start' || command.dataPort === undefined) {
              capsule.send(command, transfer);
              return;
            }
            const dataPort = command.dataPort;
            const relay = new MessageChannel();
            ports.push(dataPort, relay.port1, relay.port2);
            relay.port1.onmessage = (event: MessageEvent<unknown>) => {
              const request = event.data as AgentDataPortRequest;
              if (
                request.kind === 'generation_context' &&
                request.correlation.command === 'async-child'
              ) {
                resolveTurnContext(request);
                void contextGate.then(() => dataPort.postMessage(request));
                return;
              }
              dataPort.postMessage(request);
            };
            dataPort.onmessage = (event: MessageEvent<unknown>) => {
              relay.port1.postMessage(event.data);
            };
            relay.port1.start();
            dataPort.start();
            capsule.send({ ...command, dataPort: relay.port2 }, [relay.port2]);
          },
          subscribe(listener) {
            return capsule.subscribe((message: WorkerToHostMessage) => {
              if (message.kind === 'cancel_received') {
                resolveCancelReceived(message);
              }
              listener(message);
            });
          },
          terminate: () => capsule.terminate(),
        };
      },
    },
    currentCatalog: () => ['generic'],
  });
  const parentExecutionId = `i170-child-preparing-${crypto.randomUUID()}`;
  let parentSession: WorkerHostSession | undefined;
  let runId: string | undefined;

  try {
    parentSession = await seedDataServiceParentExecution({
      data,
      descriptor,
      workspaceRoot,
      configRoot: `${root}/config`,
      credentialRoot: `${root}/credentials`,
      agentChoice: {},
      executionId: parentExecutionId,
    });
    registry.openParent(parentExecutionId);
    const spawned = await registry.handle(
      {
        kind: 'spawn',
        agent: 'generic',
        task: 'no model request before cancel',
      },
      undefined,
      parentExecutionId,
    );
    if (!spawned.ok || spawned.kind !== 'spawn') {
      throw new Error(JSON.stringify(spawned));
    }
    runId = spawned.runId;
    const contextRequest = await within(
      turnContextRequested,
      'child did not request its turn context',
    );
    strictEqual(contextRequest.correlation.command, 'async-child');

    const cancelling = registry.handle(
      { kind: 'cancel', runId },
      undefined,
      parentExecutionId,
    );
    const received = await within(
      cancelReceived,
      'Worker did not receive the cancellation during context preparation',
    );
    strictEqual(received.result, 'requested');
    releaseContext();
    const cancelled = await within(
      cancelling,
      'child cancellation did not settle',
    );
    if (!cancelled.ok || cancelled.kind !== 'cancel') {
      throw new Error(JSON.stringify(cancelled));
    }
    strictEqual(cancelled.state, 'cancelled');
  } finally {
    releaseContext();
    await registry.cleanupAll();
    await parentSession?.close();
    for (const port of ports) port.close();
    await data.close();
  }

  const store = new SqliteHistoryStore(stateRoot, workspaceRoot, {
    readOnly: true,
  });
  await store.initialize();
  try {
    strictEqual(runId !== undefined, true);
    const execution = store.readExecution(runId!);
    strictEqual(execution.lifecycle, 'settled');
    strictEqual(execution.outcome, 'cancelled');
    strictEqual(
      store.listExecutionEvents(runId!).filter((event) => event.kind === 'provider_request_start')
        .length,
      0,
    );
    const cancelFact = store.listExecutionEvents(runId!).find((event) =>
      event.kind === 'cancel_received'
    );
    strictEqual(cancelFact !== undefined, true);
    const payload = cancelFact!.payload as { readonly result?: unknown };
    strictEqual(payload.result, 'requested');
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
