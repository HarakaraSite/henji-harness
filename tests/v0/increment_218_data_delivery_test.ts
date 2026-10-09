import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { DataConversationUpdate } from '../../v0/agent/data/data_contract.ts';
import type { Message } from '../../v0/agent/core/contracts.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { WorkerCorrelation } from '../../v0/agent/worker/worker_protocol.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const transcript: readonly Message[] = [
  { role: 'user', content: { kind: 'text', text: 'stream pressure' } },
  { role: 'assistant', content: { kind: 'text', text: 'accepted' } },
];

Deno.test('Increment 218 Data watch ACK bounds queued updates and resyncs to a finite snapshot', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-218-data-delivery-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  let port: ReturnType<typeof createAgentDataPortClient> | undefined;
  let releaseFirst: (() => void) | undefined;
  const updates: DataConversationUpdate[] = [];
  let resolveFirst!: () => void;
  const firstUpdate = new Promise<void>((resolve) => resolveFirst = resolve);
  let resolveResync!: (update: DataConversationUpdate) => void;
  const resyncUpdate = new Promise<DataConversationUpdate>((resolve) => {
    resolveResync = resolve;
  });
  try {
    const descriptor = await data.openSession({
      persistence: 'new',
      agent: 'default',
      agentChoice: {},
      initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    });
    const watched = await data.watchConversation(descriptor.id, (update) => {
      updates.push(update);
      if (updates.length === 1) {
        resolveFirst();
        return new Promise<void>((resolve) => releaseFirst = resolve);
      }
      if (update.snapshot === true) resolveResync(update);
    });
    const correlation: WorkerCorrelation = {
      session: descriptor.id,
      instanceCorrelation: 'increment-218-watch-pressure',
      workerGeneration: 'increment-218-watch-pressure',
      baseStateRevision: descriptor.stateRevision,
      command: 'increment-218-watch-pressure',
    };
    port = createAgentDataPortClient(
      await data.attachGeneration(descriptor.id, correlation),
    );
    await port.ready({
      kind: 'ready',
      correlation,
      configuration: workerConfigurationFixture(),
      manifest: {
        role: 'parent',
        maxSteps: 128,
        profileId: 'increment-218-watch-pressure',
        resources: [],
        rootModel: ROOT_DEFAULT_MODEL_SELECTION,
      },
    });
    const executionId = crypto.randomUUID().toLowerCase();
    await data.executionAdmit(descriptor.id, {
      executionId,
      taskId: crypto.randomUUID().toLowerCase(),
      task: 'stream pressure',
      correlation,
    });
    port.beginExecution(executionId, correlation);
    await firstUpdate;

    const assistantText = 'x'.repeat(2_048);
    for (let sequence = 1; sequence <= 1_200; sequence += 1) {
      port.observation({
        kind: 'provider_observation',
        correlation,
        sequence,
        turn: 1,
        observation: {
          kind: 'runtime_event',
          requestOrdinal: sequence,
          event: {
            kind: 'model_result',
            modelStep: sequence,
            lane: 'parent',
            requestOrdinal: sequence,
            result: { kind: 'final', text: `${sequence}:${assistantText}` },
          },
        },
      });
    }
    const proposal = port.sendProposal({
      kind: 'commit_proposal',
      correlation,
      transcript,
      nextTurn: 2,
    });
    const token = await data.prepareProposal(descriptor.id, {
      executionId,
      proposalId: proposal.proposalId,
      finalDataSequence: proposal.finalDataSequence,
    });
    await data.authorizeCommit(descriptor.id, token, { accepted: true });
    ok(releaseFirst);
    releaseFirst();

    const resync = await resyncUpdate;
    strictEqual(updates.length, 2);
    strictEqual(resync.snapshot, true);
    strictEqual(resync.deliverySequence, 2);
    strictEqual(resync.sessionId, descriptor.id);
    const encoded = JSON.parse(new TextDecoder().decode(resync.bytes)) as {
      readonly schemaVersion: number;
      readonly sessionId: string;
      readonly cut: number;
      readonly entities: Readonly<Record<string, unknown>>;
    };
    strictEqual(encoded.schemaVersion, 3);
    strictEqual(encoded.sessionId, descriptor.id);
    strictEqual(encoded.cut, resync.cut);
    ok(Object.keys(encoded.entities).length > 0);
    deepStrictEqual(
      await data.conversationSnapshot(descriptor.id).then((snapshot) => snapshot.cut),
      resync.cut,
    );
    watched.unsubscribe();
  } finally {
    releaseFirst?.();
    port?.close();
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});
