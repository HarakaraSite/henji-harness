import { ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { AgentDataPortRequest } from '../../v0/agent/data/agent_data_contract.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';

Deno.test('Increment 176 real Worker turn exception retains its facts through Host sealing and Data Worker persistence', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i176-worker-failure-' });
  const data = await createDataClient({ stateRoot: `${root}/state`, workspaceRoot: root });
  const descriptor = await data.openSession({
    persistence: 'none',
    agent: 'default',
    definition: {
      schemaVersion: 1,
      resourceKind: 'agent-definition',
      resourceId: 'test/failure-details',
      revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
    },
  });
  const ports: MessagePort[] = [];
  const reader = new SqliteHistoryV7ProductionStore(`${root}/state`, root, { readOnly: true });
  let session: WorkerHostSession | undefined;
  try {
    session = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot: root,
      physicalIoMode: 'provider-free',
      modulePath:
        new URL('./fixtures/increment_133_process_definition.ts', import.meta.url).pathname,
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        let failTurnContext = false;
        return {
          subscribe: (listener) => capsule.subscribe(listener),
          terminate: () => capsule.terminate(),
          send(command, transfer) {
            if (command.kind === 'turn') failTurnContext = true;
            if (command.kind !== 'start' || command.dataPort === undefined) {
              capsule.send(command, transfer);
              return;
            }
            const original = command.dataPort;
            const relay = new MessageChannel();
            ports.push(original, relay.port1);
            original.onmessage = (event) => relay.port1.postMessage(event.data);
            relay.port1.onmessage = (event: MessageEvent<AgentDataPortRequest>) => {
              if (failTurnContext && event.data.kind === 'generation_context') {
                failTurnContext = false;
                relay.port1.postMessage({
                  kind: 'error',
                  requestId: event.data.requestId,
                  error: {
                    status: 500,
                    code: 'context_read_failed',
                    message: 'Context read failed',
                  },
                });
              } else original.postMessage(event.data);
            };
            original.start();
            relay.port1.start();
            capsule.send({ ...command, dataPort: relay.port2 }, [relay.port2]);
          },
        };
      },
    });
    const outcome = await session.submit('fail before model entry');
    strictEqual(outcome.ok, false);
    await reader.initialize();
    const rows = reader.listExecutionsForSession(descriptor.id);
    strictEqual(rows.length, 1);
    ok(rows[0].diagnosticId);
    const diagnostic = await reader.diagnostics.read(rows[0].diagnosticId);
    strictEqual(diagnostic.code, 'worker_error');
    strictEqual(diagnostic.details?.operation, 'worker_turn');
    strictEqual(diagnostic.details?.exceptionType, 'AgentDataPortError');
    strictEqual(diagnostic.details?.errorCode, 'context_read_failed');
    strictEqual(diagnostic.providerRequestCount, 0);
  } finally {
    await session?.close();
    await data.close();
    reader.close();
    for (const port of ports) port.close();
    await Deno.remove(root, { recursive: true });
  }
});
