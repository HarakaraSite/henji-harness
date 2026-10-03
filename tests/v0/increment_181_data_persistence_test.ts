import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { workspaceDigest } from '../../v0/agent/session/session_store_paths.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { Message } from '../../v0/agent/core/contracts.ts';
import type { WorkerCorrelation } from '../../v0/agent/worker/worker_protocol.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

Deno.test('181 production Data preserves configuration and canonical conversation across noncanonical settlement and reopen', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-data-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const workspaceState = `${stateRoot}/${await workspaceDigest(workspaceRoot)}`;
  await Deno.mkdir(workspaceState, { recursive: true, mode: 0o700 });
  const oldPath = `${workspaceState}/history-v7.sqlite3`;
  const oldSentinel = 'old test data stays untouched';
  await Deno.writeTextFile(oldPath, oldSentinel);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  const ports: ReturnType<typeof createAgentDataPortClient>[] = [];
  try {
    const descriptor = await data.openSession({
      persistence: 'new',
      agent: 'default',
      agentChoice: {},
      initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    });
    const sessionId = descriptor.id;
    const before = workerConfigurationFixture();
    const after = workerConfigurationFixture({
      systemInstruction: 'same revision, changed instruction',
    });
    strictEqual(before.agent.revision, after.agent.revision);
    const transcript: Message[] = [{
      role: 'user',
      content: { kind: 'text', text: 'canonical task' },
    }, { role: 'assistant', content: { kind: 'text', text: 'canonical answer' } }];
    const begin = async (configuration: typeof before, baseStateRevision: number, task: string) => {
      const correlation: WorkerCorrelation = {
        session: sessionId,
        instanceCorrelation: crypto.randomUUID(),
        workerGeneration: crypto.randomUUID(),
        baseStateRevision,
        command: 'turn',
      };
      const port = createAgentDataPortClient(await data.attachGeneration(sessionId, correlation));
      ports.push(port);
      await port.ready({
        kind: 'ready',
        correlation,
        configuration,
        manifest: {
          role: 'parent',
          maxSteps: 128,
          profileId: 'data-fixture',
          resources: [],
          rootModel: ROOT_DEFAULT_MODEL_SELECTION,
        },
      });
      const executionId = crypto.randomUUID();
      await data.executionAdmit(sessionId, {
        executionId,
        taskId: crypto.randomUUID(),
        task,
        correlation,
      });
      port.beginExecution(executionId, correlation);
      return { port, correlation, executionId };
    };
    const first = await begin(before, 1, 'canonical task');
    const proposal = first.port.sendProposal({
      kind: 'commit_proposal',
      correlation: first.correlation,
      transcript,
      nextTurn: 2,
    });
    const token = await data.prepareProposal(sessionId, {
      executionId: first.executionId,
      proposalId: proposal.proposalId,
      finalDataSequence: proposal.finalDataSequence,
    });
    const terminal = await data.authorizeCommit(sessionId, token, { accepted: true });
    strictEqual(terminal.canonical, true);
    strictEqual(terminal.stateRevision, 2);
    const second = await begin(after, 2, 'cancelled task');
    second.port.observation({
      kind: 'provider_observation',
      correlation: second.correlation,
      sequence: 1,
      turn: 2,
      observation: {
        kind: 'runtime_event',
        event: {
          kind: 'assistant_progress',
          text: 'cancelled partial',
          modelStep: 1,
          lane: 'parent',
          requestOrdinal: 1,
        },
      },
    });
    await data.sealGeneration(sessionId, {
      executionId: second.executionId,
      decision: 'cancelled',
      reason: 'test user cancellation',
    });
    const unchanged = await data.sessionDescriptor(sessionId);
    strictEqual(unchanged.stateRevision, 2);
    strictEqual(unchanged.nextTurn, 2);
    for (const port of ports) port.close();
    await data.close();
    const store = new SqliteHistoryStore(stateRoot, workspaceRoot, { readOnly: true });
    try {
      await store.initialize();
      const record = await store.readWorker(sessionId);
      deepStrictEqual(record.transcript, transcript);
      deepStrictEqual(record.agentChoice, {});
      strictEqual(record.turnExecutions[0].executionId, first.executionId);
      strictEqual(record.turnExecutions[0].configurationId, before.configurationId);
      strictEqual(
        store.readExecution(first.executionId).configuration.systemInstruction,
        before.systemInstruction,
      );
      strictEqual(
        store.readExecution(second.executionId).configuration.systemInstruction,
        after.systemInstruction,
      );
      strictEqual(store.readExecution(second.executionId).adoption, 'non_canonical');
      strictEqual(store.readExecution(second.executionId).outcome, 'cancelled');
      ok(
        JSON.stringify(store.readSessionConversationFacts(sessionId)).includes('cancelled partial'),
      );
      const exported = [...store.streamHumanHistoryExport(sessionId)];
      ok(JSON.stringify(exported).includes(before.configurationId));
      ok(JSON.stringify(exported).includes(after.configurationId));
    } finally {
      store.close();
    }
    strictEqual(await Deno.readTextFile(oldPath), oldSentinel);
    await Deno.stat(`${workspaceState}/history.sqlite3`);
  } finally {
    for (const port of ports) port.close();
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});
