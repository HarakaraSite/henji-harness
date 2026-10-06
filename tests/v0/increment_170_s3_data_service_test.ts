import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { Message } from '../../v0/agent/core/contracts.ts';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
import type {
  DataConversationUpdate,
  DataSessionDescriptorUpdate,
} from '../../v0/agent/data/data_contract.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { ProviderEvidenceRuntimeEvent } from '../../v0/agent/provider/provider_evidence.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import type { ConversationEntity } from '../../v0/conversation/model.ts';
import type {
  WorkerCorrelation,
  WorkerReadyMessage,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';

const decode = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

const userMessage = (text: string): Message => ({
  role: 'user',
  content: { kind: 'text', text },
});

const assistantMessage = (text: string): Message => ({
  role: 'assistant',
  content: { kind: 'text', text },
});

const waitForUpdate = async (
  updates: readonly DataConversationUpdate[],
  waiters: {
    readonly index: number;
    readonly resolve: (value: DataConversationUpdate) => void;
  }[],
  index: number,
): Promise<DataConversationUpdate> => {
  const current = updates[index];
  if (current !== undefined) return current;
  return await new Promise<DataConversationUpdate>((resolve) => {
    waiters.push({ index, resolve });
  });
};

const waitForDescriptorUpdate = async (
  updates: readonly DataSessionDescriptorUpdate[],
  waiters: {
    readonly index: number;
    readonly resolve: (value: DataSessionDescriptorUpdate) => void;
  }[],
  index: number,
): Promise<DataSessionDescriptorUpdate> => {
  const current = updates[index];
  if (current !== undefined) return current;
  return await new Promise<DataSessionDescriptorUpdate>((resolve) => {
    waiters.push({ index, resolve });
  });
};

const waitForAgentEvent = async (
  events: readonly unknown[],
  waiters: { readonly resolve: (value: unknown) => void }[],
): Promise<unknown> => {
  if (events.length > 0) return events[0];
  return await new Promise<unknown>((resolve) => waiters.push({ resolve }));
};

const correlationFor = (
  sessionId: string,
  baseStateRevision: number,
  command: string,
): WorkerCorrelation => ({
  session: sessionId,
  instanceCorrelation: `i170-data-service-instance-${command}`,
  workerGeneration: `i170-data-service-generation-${command}`,
  baseStateRevision,
  command,
});

const readyFor = (correlation: WorkerCorrelation): WorkerReadyMessage => ({
  kind: 'ready',
  correlation,
  configuration: workerConfigurationFixture(),
  manifest: {
    role: 'parent',
    maxSteps: 4,
    profileId: 'increment-170-s3-data-service',
    resources: [],
    rootModel: ROOT_DEFAULT_MODEL_SELECTION,
  },
});

const observation = (
  correlation: WorkerCorrelation,
  sequence: number,
  event: ProviderEvidenceRuntimeEvent,
): WorkerToHostMessage => ({
  kind: 'provider_observation',
  correlation,
  sequence,
  turn: correlation.baseStateRevision,
  observation: { kind: 'runtime_event', event },
});

const entityValues = (snapshot: Uint8Array): ConversationEntity[] => {
  const decoded = decode<{
    readonly entities?: Record<string, ConversationEntity>;
    readonly changes?: readonly {
      readonly kind: string;
      readonly entity?: ConversationEntity;
    }[];
  }>(snapshot);
  if (decoded.entities !== undefined) return Object.values(decoded.entities);
  return (decoded.changes ?? []).flatMap((change) =>
    change.kind === 'upsert' && change.entity !== undefined ? [change.entity] : []
  );
};

Deno.test('Increment 170 S3 Data Worker owns the conversation cut, admission and terminal commit boundary', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i170-s3-data-service-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  const updates: DataConversationUpdate[] = [];
  const updateWaiters: {
    readonly index: number;
    readonly resolve: (value: DataConversationUpdate) => void;
  }[] = [];
  const descriptorUpdates: DataSessionDescriptorUpdate[] = [];
  const descriptorUpdateWaiters: {
    readonly index: number;
    readonly resolve: (value: DataSessionDescriptorUpdate) => void;
  }[] = [];
  const agentEvents: unknown[] = [];
  const eventWaiters: { readonly resolve: (value: unknown) => void }[] = [];
  let agentEventSessionId: string | undefined;
  const unsubscribeEvents = data.subscribeAgentEvents((sessionId, bytes) => {
    agentEventSessionId = sessionId;
    const event = decode<unknown>(bytes);
    agentEvents.push(event);
    for (const waiter of eventWaiters.splice(0)) waiter.resolve(event);
  });
  let unsubscribeWatch: (() => void) | undefined;
  let unsubscribeDescriptorWatch: (() => void) | undefined;
  const ports: ReturnType<typeof createAgentDataPortClient>[] = [];

  try {
    const descriptor = await data.openSession({
      persistence: 'new',
      agent: 'default',
      agentChoice: {},
      initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    });
    const sessionId = descriptor.id;
    const watchedDescriptor = await data.watchSessionDescriptor(
      sessionId,
      (update) => {
        descriptorUpdates.push(update);
        for (let index = descriptorUpdateWaiters.length - 1; index >= 0; index -= 1) {
          const waiter = descriptorUpdateWaiters[index]!;
          if (descriptorUpdates[waiter.index] !== undefined) {
            descriptorUpdateWaiters.splice(index, 1);
            waiter.resolve(descriptorUpdates[waiter.index]!);
          }
        }
      },
    );
    unsubscribeDescriptorWatch = watchedDescriptor.unsubscribe;
    strictEqual(watchedDescriptor.snapshot.descriptor.id, sessionId);
    const watched = await data.watchConversation(sessionId, (update) => {
      updates.push(update);
      for (let index = updateWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = updateWaiters[index]!;
        if (updates[waiter.index] !== undefined) {
          updateWaiters.splice(index, 1);
          waiter.resolve(updates[waiter.index]!);
        }
      }
    });
    unsubscribeWatch = watched.unsubscribe;
    const initialSnapshot = decode<{
      readonly schemaVersion: number;
      readonly sessionId: string;
      readonly cut: number;
      readonly entities: Record<string, ConversationEntity>;
    }>(watched.snapshot.bytes);
    strictEqual(initialSnapshot.schemaVersion, 2);
    strictEqual(initialSnapshot.sessionId, sessionId);
    strictEqual(initialSnapshot.cut, 0);
    strictEqual(Object.keys(initialSnapshot.entities).length, 0);

    // This read is ordered after the opt-in RPC, so the next Agent event exercises the
    // Data Worker eventBytes bridge rather than the conversation-only notification path.
    await data.sessionDescriptor(sessionId);

    const task = 'Read the report and return its marker';
    const executionId = '17000000-0000-4000-8000-000000000181';
    const correlation = correlationFor(
      sessionId,
      descriptor.stateRevision,
      'data-service-turn-one',
    );
    const port = createAgentDataPortClient(
      await data.attachGeneration(sessionId, correlation),
    );
    ports.push(port);
    const basis = await port.generationContext(correlation);
    strictEqual(basis.nextTurn, 1);
    strictEqual(basis.stateRevision, 1);
    await port.ready(readyFor(correlation));
    const admission = await data.executionAdmit(sessionId, {
      executionId,
      taskId: '17000000-0000-4000-8000-000000000182',
      task,
      correlation,
      createdAt: '2026-10-03T01:00:00.000Z',
    });
    strictEqual(admission.descriptor.latestExecution?.executionId, executionId);
    strictEqual(admission.descriptor.latestExecution?.lifecycle, 'active');
    const admittedDescriptor = await waitForDescriptorUpdate(
      descriptorUpdates,
      descriptorUpdateWaiters,
      0,
    );
    strictEqual(
      admittedDescriptor.descriptor.latestExecution?.executionId,
      executionId,
    );
    strictEqual(
      admittedDescriptor.descriptor.latestExecution?.lifecycle,
      'active',
    );
    ok(admittedDescriptor.sequence > watchedDescriptor.snapshot.sequence);
    const admittedUpdate = await waitForUpdate(updates, updateWaiters, 0);
    strictEqual(admittedUpdate.cut, 1);
    strictEqual(
      admittedUpdate.descriptor.latestExecution?.executionId,
      executionId,
    );
    strictEqual(admittedUpdate.descriptor.latestExecution?.lifecycle, 'active');

    port.beginExecution(executionId, correlation);
    const callId = 'external-report-call-181';
    const call = {
      callId,
      name: 'workspace/report-reader',
      arguments: { file: 'marker.txt' },
    };
    const finalText = 'The marker value is blue.';
    const partialText = finalText;
    const events: ProviderEvidenceRuntimeEvent[] = [
      {
        kind: 'assistant_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        text: partialText,
      },
      {
        kind: 'model_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        result: { kind: 'tool_calls', text: partialText, calls: [call] },
      },
      {
        kind: 'tool_call',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        callIndex: 0,
        call,
      },
      {
        kind: 'tool_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        callIndex: 0,
        callId,
        name: call.name,
        text: 'Reading marker.txt',
      },
      {
        kind: 'tool_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        callIndex: 0,
        result: {
          kind: 'tool_result',
          callId,
          name: call.name,
          text: 'marker value is blue',
          outcome: 'success',
        },
      },
      {
        kind: 'model_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        result: { kind: 'final', text: finalText },
      },
    ];
    events.forEach((event, index) => {
      port.observation(observation(correlation, index + 1, event));
    });
    const liveEvent = await waitForAgentEvent(agentEvents, eventWaiters);
    strictEqual(agentEventSessionId, sessionId);
    deepStrictEqual(liveEvent, {
      kind: 'assistant_progress',
      turn: 1,
      text: partialText,
      requestKey: {
        executionId,
        lane: 'parent',
        modelStep: 1,
        requestOrdinal: 1,
      },
    });

    const transcript = [userMessage(task), assistantMessage(finalText)];
    const proposal = port.sendProposal({
      kind: 'commit_proposal',
      correlation,
      transcript,
      nextTurn: 2,
    });
    const token = await data.prepareProposal(sessionId, {
      proposalId: proposal.proposalId,
      executionId,
      finalDataSequence: proposal.finalDataSequence,
    });
    strictEqual(token.finalDataSequence, proposal.finalDataSequence);
    const afterData = await waitForUpdate(updates, updateWaiters, 1);
    strictEqual(afterData.cut, 2);
    const partial = entityValues(afterData.bytes).find((entity) =>
      entity.kind === 'message' && entity.role === 'assistant' &&
      entity.text === partialText
    );
    ok(partial?.kind === 'message');
    const externalTool = entityValues(afterData.bytes).find((entity) =>
      entity.kind === 'tool' && entity.callId === callId
    );
    ok(externalTool?.kind === 'tool');
    strictEqual(externalTool.name, call.name);
    strictEqual(externalTool.progress, 'Reading marker.txt');
    strictEqual(externalTool.result?.text, 'marker value is blue');
    strictEqual(externalTool.requestKey.requestOrdinal, 1);
    ok(externalTool.declarationOccurrenceId !== undefined);

    const terminal = await data.authorizeCommit(sessionId, token, {
      accepted: true,
    });
    strictEqual(terminal.accepted, true);
    strictEqual(terminal.canonical, true);
    strictEqual(terminal.stateRevision, 2);
    strictEqual(terminal.nextTurn, 2);
    strictEqual(terminal.descriptor.latestExecution?.executionId, executionId);
    strictEqual(terminal.descriptor.latestExecution?.lifecycle, 'settled');
    strictEqual(terminal.descriptor.latestExecution?.outcome, 'completed');
    strictEqual(terminal.currentPosition.committedTurn, 1);
    await data.recordExecutionControl(sessionId, executionId, {
      controlSequence: 1,
      kind: 'acknowledgement_requested',
      accepted: true,
    });
    await data.recordExecutionControl(sessionId, executionId, {
      controlSequence: 2,
      kind: 'acknowledgement_sent',
      accepted: true,
    });
    await data.recordExecutionControl(sessionId, executionId, {
      controlSequence: 3,
      kind: 'turn_settled',
      correlation,
    });
    await data.recordExecutionControl(sessionId, executionId, {
      controlSequence: 4,
      kind: 'post_commit_turn_end',
      correlation,
      turn: 1,
      outcome: 'final',
      committed: true,
      generationUnavailable: false,
    });
    const afterCleanup = await data.recordExecutionControl(
      sessionId,
      executionId,
      {
        controlSequence: 5,
        kind: 'process_cleanup_finished',
        result: 'complete',
      },
    );
    strictEqual(
      afterCleanup.latestExecution?.durability.acknowledgement,
      'accepted_sent',
    );
    strictEqual(afterCleanup.latestExecution?.processSettlement, 'complete');
    const terminalUpdate = await waitForUpdate(updates, updateWaiters, 2);
    strictEqual(terminalUpdate.cut, 3);
    strictEqual(terminalUpdate.descriptor.stateRevision, 2);
    strictEqual(
      terminalUpdate.descriptor.latestExecution?.lifecycle,
      'settled',
    );
    const terminalSnapshot = await data.conversationSnapshot(sessionId);
    const afterTerminal = decode<{
      readonly cut: number;
      readonly storeRevision: number;
      readonly entities: Record<string, ConversationEntity>;
      readonly order: readonly string[];
    }>(terminalSnapshot.bytes);
    strictEqual(afterTerminal.cut, 3);
    const finalPartial = Object.values(afterTerminal.entities).find((entity) =>
      entity.kind === 'message' && entity.role === 'assistant' &&
      entity.text === partialText
    );
    ok(finalPartial?.kind === 'message');
    strictEqual(finalPartial.id, partial.id);
    deepStrictEqual(finalPartial.position, partial.position);
    ok(afterTerminal.order.includes(finalPartial.id));
    strictEqual(afterTerminal.storeRevision, terminal.descriptor.stateRevision);

    const secondCorrelation = correlationFor(
      sessionId,
      2,
      'data-service-turn-two',
    );
    const secondPort = createAgentDataPortClient(
      await data.attachGeneration(sessionId, secondCorrelation),
    );
    ports.push(secondPort);
    const nextBasis = await secondPort.generationContext(secondCorrelation);
    deepStrictEqual(nextBasis.initialTranscript, transcript);
    strictEqual(nextBasis.nextTurn, 2);
    strictEqual(nextBasis.stateRevision, 2);
    const secondExecutionId = '17000000-0000-4000-8000-000000000183';
    await secondPort.ready(readyFor(secondCorrelation));
    const secondAdmission = await data.executionAdmit(sessionId, {
      executionId: secondExecutionId,
      taskId: '17000000-0000-4000-8000-000000000184',
      task: 'Prepare and seal while the proposal is still pending',
      correlation: secondCorrelation,
      createdAt: '2026-10-03T01:00:01.000Z',
    });
    strictEqual(
      secondAdmission.descriptor.latestExecution?.executionId,
      secondExecutionId,
    );
    await waitForUpdate(updates, updateWaiters, 3);
    const pendingPrepare = data.prepareProposal(sessionId, {
      proposalId: 'proposal-never-sent-183',
      executionId: secondExecutionId,
      finalDataSequence: 1,
    });
    const sealed = await data.sealGeneration(sessionId, {
      executionId: secondExecutionId,
      decision: 'interrupted',
      reason: 'seal wins while Data waits for the proposal payload',
    });
    strictEqual(sealed.accepted, false);
    strictEqual(sealed.canonical, false);
    strictEqual(sealed.outcome.stopReason, 'interrupted');
    const rejectedPrepare = await pendingPrepare.then(
      () => false,
      () => true,
    );
    strictEqual(rejectedPrepare, true);
    const sealedUpdate = await waitForUpdate(updates, updateWaiters, 4);
    strictEqual(sealedUpdate.cut, 5);
    strictEqual(
      sealedUpdate.descriptor.latestExecution?.executionId,
      secondExecutionId,
    );
    strictEqual(sealedUpdate.descriptor.latestExecution?.lifecycle, 'settled');
    strictEqual(
      sealedUpdate.descriptor.latestExecution?.outcome,
      'interrupted',
    );

    const synchronizedSnapshot = await data.conversationSnapshot(sessionId);
    strictEqual(synchronizedSnapshot.cut, sealedUpdate.cut);
    strictEqual(synchronizedSnapshot.storeRevision, sealedUpdate.storeRevision);
    strictEqual(updates.length, 5);
    deepStrictEqual(updates.map((update) => update.cut), [1, 2, 3, 4, 5]);

    // Closing the active owner keeps the Data service's Session watch and writer cut alive.
    await data.closeSession(sessionId);
    const reopened = await data.openSession({
      persistence: 'session',
      sessionId,
      agent: 'default',
      agentChoice: {},
    });
    strictEqual(reopened.stateRevision, 2);
    strictEqual(reopened.nextTurn, 2);
    strictEqual(reopened.latestExecution?.executionId, secondExecutionId);
    strictEqual(reopened.latestExecution?.outcome, 'interrupted');
    const reopenedSnapshot = await data.conversationSnapshot(sessionId);
    strictEqual(reopenedSnapshot.cut, synchronizedSnapshot.cut);
    deepStrictEqual(
      decode<
        {
          readonly entities: Record<string, ConversationEntity>;
          readonly order: readonly string[];
        }
      >(
        reopenedSnapshot.bytes,
      ),
      decode<
        {
          readonly entities: Record<string, ConversationEntity>;
          readonly order: readonly string[];
        }
      >(
        synchronizedSnapshot.bytes,
      ),
    );
    const persisted = new SqliteHistoryStore(
      stateRoot,
      workspaceRoot,
    );
    try {
      await persisted.initialize();
      deepStrictEqual(
        (await persisted.readWorker(sessionId)).transcript,
        transcript,
      );
      strictEqual(
        persisted.readExecutionMetadata(executionId).outcome,
        'completed',
      );
      const artifact = await persisted.executionArtifacts.read(executionId);
      strictEqual(artifact.adoption, 'canonical');
      strictEqual(artifact.acknowledgement, 'accepted_sent');
      strictEqual(artifact.settlement, 'committed');
      strictEqual(
        persisted.readExecutionMetadata(secondExecutionId).outcome,
        'interrupted',
      );
    } finally {
      persisted.close();
    }
  } finally {
    unsubscribeWatch?.();
    unsubscribeDescriptorWatch?.();
    unsubscribeEvents();
    for (const port of ports) port.close();
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});
