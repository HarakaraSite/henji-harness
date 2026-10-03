import { ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
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

Deno.test('Increment 170 rejected ACK keeps Core busy until correlated Worker idle marker', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i170-rejected-ack-idle-',
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
  let heldTurnSettled = false;
  let cancelReceived = false;
  let rejectedAcknowledgementSent = false;
  let releaseProposal: (() => void) | undefined;
  let releaseTurnSettled: (() => void) | undefined;
  let allowTurnSettled = false;
  let session: WorkerHostSession | undefined;
  try {
    session = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot: root,
      configRoot,
      agentChoice: processProbeChoice,
      physicalIoMode: 'provider-free',
      capsuleFactory: (url): WorkerHostCapsule => {
        const capsule = new WorkerCapsule(url);
        return {
          send(command: WorkerHostCommand, transfer?: Transferable[]) {
            if (
              command.kind === 'commit_acknowledgement' && !command.accepted
            ) rejectedAcknowledgementSent = true;
            capsule.send(command, transfer);
          },
          subscribe(listener) {
            return capsule.subscribe((message: WorkerToHostMessage) => {
              if (message.kind === 'proposal_ready' && !heldProposal) {
                heldProposal = true;
                releaseProposal = () => listener(message);
                return;
              }
              if (message.kind === 'cancel_received') cancelReceived = true;
              if (message.kind === 'turn_settled' && !allowTurnSettled) {
                heldTurnSettled = true;
                releaseTurnSettled = () => listener(message);
                return;
              }
              listener(message);
            });
          },
          terminate: () => capsule.terminate(),
        };
      },
    });

    const admission = await session.admit(processProbeCall('answer'));
    let completionSettled = false;
    void admission.completion.then(
      () => completionSettled = true,
      () => completionSettled = true,
    );
    await waitFor(() => heldProposal);
    strictEqual(session.cancelActiveTurn(), 'requested');
    await waitFor(() => cancelReceived);
    releaseProposal?.();
    await waitFor(() => rejectedAcknowledgementSent && heldTurnSettled);

    const stored = (await data.executionRead(admission.executionId)).execution;
    strictEqual(stored.lifecycle, 'settled');
    strictEqual(stored.outcome, 'cancelled');
    strictEqual(stored.adoption, 'non_canonical');
    strictEqual(completionSettled, false);

    let nextTaskWasBusy = false;
    try {
      await session.admit('must wait for Worker idle');
    } catch (error) {
      nextTaskWasBusy = error instanceof Error &&
        error.message.includes('busy');
    }
    ok(nextTaskWasBusy);

    allowTurnSettled = true;
    releaseTurnSettled?.();
    const outcome = await admission.completion;
    strictEqual(outcome.ok, false);
    strictEqual(outcome.stopReason, 'cancelled');
    const followup = await session.submit(processProbeCall('answer'));
    strictEqual(followup.ok, true);
  } finally {
    allowTurnSettled = true;
    releaseProposal?.();
    releaseTurnSettled?.();
    await session?.close();
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});
