import { ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { AgentDataPortRequest } from '../../v0/agent/data/agent_data_contract.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type { WorkerToHostMessage } from '../../v0/agent/worker/worker_protocol.ts';
import {
  processProbeCall,
  processProbeChoice,
  writeProcessProbeConfiguration,
} from './helpers/increment_133_process_probe.ts';

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Worker control');
};

for (const cancelBeforeMarker of [false, true]) {
  Deno.test(`Increment 170 ${cancelBeforeMarker ? 'cancel before marker' : 'marker before cancel'} seals held proposal data and permits the next generation`, async () => {
    const root = await Deno.makeTempDir({
      prefix: 'henji-i170-forced-prefix-',
    });
    const data = await createDataClient({
      stateRoot: `${root}/state`,
      workspaceRoot: root,
    });
    const configRoot = `${root}/config`;
    await writeProcessProbeConfiguration(configRoot);
    const descriptor = await data.openSession({
      persistence: 'none',
      agent: processProbeChoice.name,
      agentChoice: processProbeChoice,
    });
    let heldProposal = false;
    let prepareEntered = false;
    let cancelReceived = false;
    let markerReceived = false;
    let holdNextProposal = true;
    const ports: MessagePort[] = [];
    let session: WorkerHostSession | undefined;
    let firstExecutionId: string | undefined;
    const prepareProposal = data.prepareProposal.bind(data);
    data.prepareProposal = (sessionId, input) => {
      prepareEntered = true;
      return prepareProposal(sessionId, input);
    };
    try {
      session = await WorkerHostSession.open({
        data,
        descriptor,
        workspaceRoot: root,
        configRoot,
        agentChoice: processProbeChoice,
        physicalIoMode: 'provider-free',
        cancelSettlementGraceMs: 100,
        capsuleFactory: (url): WorkerHostCapsule => {
          const capsule = new WorkerCapsule(url);
          const firstGeneration = holdNextProposal;
          const control: {
            message: WorkerToHostMessage;
            deliver: (message: WorkerToHostMessage) => void;
          }[] = [];
          capsule.subscribe((message) => {
            if (message.kind === 'proposal_ready') markerReceived = true;
            if (message.kind === 'cancel_received') {
              cancelReceived = true;
              for (const pending of control.splice(0)) {
                pending.deliver(pending.message);
              }
            }
          });
          return {
            send(command, transfer) {
              if (command.kind !== 'start' || command.dataPort === undefined) {
                capsule.send(command, transfer);
                return;
              }
              // Hold only the final Data proposal; the real Core marker and other Data facts pass.
              const original = command.dataPort;
              const relay = new MessageChannel();
              ports.push(original, relay.port1);
              original.onmessage = (event) => relay.port1.postMessage(event.data);
              relay.port1.onmessage = (
                event: MessageEvent<AgentDataPortRequest>,
              ) => {
                if (event.data.kind === 'proposal' && holdNextProposal) {
                  holdNextProposal = false;
                  heldProposal = true;
                  return;
                }
                original.postMessage(event.data);
              };
              original.start();
              relay.port1.start();
              capsule.send({ ...command, dataPort: relay.port2 }, [
                relay.port2,
              ]);
            },
            subscribe: (listener) =>
              capsule.subscribe((message) => {
                if (
                  firstGeneration && cancelBeforeMarker &&
                  message.kind === 'proposal_ready'
                ) {
                  control.push({ message, deliver: listener });
                } else listener(message);
              }),
            terminate: () => capsule.terminate(),
          };
        },
      });
      const admission = await session.admit(processProbeCall('answer'));
      firstExecutionId = admission.executionId;
      let settled = false;
      void admission.completion.then(
        () => settled = true,
        () => settled = true,
      );
      await waitFor(() => heldProposal && (cancelBeforeMarker ? markerReceived : prepareEntered));
      strictEqual(settled, false);
      strictEqual(session.cancelActiveTurn(), 'requested');
      await waitFor(() => cancelReceived && prepareEntered);
      strictEqual(
        settled,
        false,
        'cancel control waited for the missing Data proposal',
      );
      await waitFor(() => settled);
      const outcome = await admission.completion;
      strictEqual(outcome.ok, false);
      const retained = (await data.executionRead(admission.executionId)).execution;
      strictEqual(retained.lifecycle, 'settled');
      strictEqual(retained.outcome, 'interrupted');
      strictEqual(retained.adoption, 'non_canonical');
      const snapshot = JSON.parse(
        new TextDecoder().decode(
          (await data.conversationSnapshot(descriptor.id)).bytes,
        ),
      );
      ok(
        Object.values(snapshot.entities).some((value) => {
          const entity = value as { kind: string; text?: string };
          return entity.kind === 'message' &&
            entity.text === 'process probe finished';
        }),
        'forced seal lost the already received assistant fact',
      );
      const next = await session.submit(processProbeCall('answer'));
      strictEqual(next.ok, true);
      strictEqual(next.finalText, 'process probe finished');
    } finally {
      if (firstExecutionId !== undefined) {
        await data.sealGeneration(descriptor.id, {
          executionId: firstExecutionId,
          decision: 'interrupted',
          reason: 'test teardown',
        }).catch(() => undefined);
      }
      await session?.close();
      for (const port of ports) port.close();
      await data.close();
      await Deno.remove(root, { recursive: true });
    }
  });
}
