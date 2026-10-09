import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import type { Message } from '../../v0/agent/core/contracts.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { ProviderEvidenceRuntimeEvent } from '../../v0/agent/provider/provider_evidence.ts';
import type {
  WorkerCorrelation,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { replaySessionConversation } from '../../v0/conversation/history_adapter.ts';
import { orderedConversationEntities } from '../../v0/conversation/model.ts';
import {
  ConversationWriter,
  type ConversationWriterDelta,
} from '../../v0/agent/data/conversation_writer.ts';
import { DataSessionOwner } from '../../v0/agent/data/session_data_owner.ts';

const decode = (bytes: Uint8Array): {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly cut: number;
  readonly storeRevision: number;
  readonly entities: Readonly<
    Record<string, {
      readonly id: string;
      readonly kind: string;
      readonly execution?: {
        readonly lifecycle: string;
        readonly outcome: string;
        readonly adoption: string;
      };
      readonly role?: string;
      readonly text?: string;
      readonly position?: unknown;
    }>
  >;
  readonly order: readonly string[];
} => JSON.parse(new TextDecoder().decode(bytes));

const entitiesOf = (value: ReturnType<typeof decode>) => Object.values(value.entities);

const userMessage = (text: string): Message => ({
  role: 'user',
  content: { kind: 'text', text },
});

const assistantMessage = (text: string): Message => ({
  role: 'assistant',
  content: { kind: 'text', text },
});

const runtimeInput = (
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

const correlationFor = (
  sessionId: string,
  revision: number,
  command: string,
): WorkerCorrelation => ({
  session: sessionId,
  instanceCorrelation: `instance-${command}`,
  workerGeneration: `generation-${command}`,
  baseStateRevision: revision,
  command,
});

Deno.test('Increment 170 S3 Data Session owner prepares, settles, and restores canonical context from SQLite', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i170-s3-session-data-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let writer: ConversationWriter | undefined;
  let reopenedWriter: ConversationWriter | undefined;
  let owner: DataSessionOwner | undefined;
  let reopened: DataSessionOwner | undefined;
  let unsubscribeWriter: (() => void) | undefined;
  const notifications: ConversationWriterDelta[] = [];
  const configuration = workerConfigurationFixture();
  try {
    await store.initialize();
    writer = new ConversationWriter(store);
    owner = await DataSessionOwner.open({
      store,
      writer,
      workspaceRoot,
      persistence: 'new',
      agent: 'default',
      agentChoice: {},
    });
    const sessionId = owner.sessionId;
    const snapshot = () => writer!.snapshotSession(sessionId);
    unsubscribeWriter = writer.watchSession(
      sessionId,
      (delta) => notifications.push(delta),
    ).unsubscribe;
    const initial = decode(snapshot().bytes);
    strictEqual(initial.schemaVersion, 3);
    strictEqual(initial.sessionId, sessionId);
    strictEqual(initial.cut, 0);
    strictEqual(Object.keys(initial.entities).length, 0);

    const firstTask = 'A proposal that cannot advance this Session';
    const firstExecutionId = '17000000-0000-4000-8000-000000000171';
    const firstCorrelation = correlationFor(sessionId, 1, 'prepare-rejection');
    await owner.admit({
      executionId: firstExecutionId,
      taskId: '17000000-0000-4000-8000-000000000172',
      task: firstTask,
      correlation: firstCorrelation,
      createdAt: '2026-10-03T00:00:01.000Z',
      configuration,
      maxSteps: 128,
    });
    const firstEvent = runtimeInput(firstCorrelation, 1, {
      kind: 'assistant_progress',
      modelStep: 1,
      lane: 'parent',
      requestOrdinal: 1,
      text: 'The rejected proposal still has a saved prefix.',
    });
    strictEqual(
      owner.receiveData({
        executionId: firstExecutionId,
        sequence: 1,
        message: firstEvent,
      }),
      'accepted',
    );
    await rejects(
      owner.prepareProposal({
        proposalId: 'proposal-invalid-turn',
        executionId: firstExecutionId,
        finalDataSequence: 1,
        message: {
          kind: 'commit_proposal',
          correlation: firstCorrelation,
          transcript: [
            userMessage(firstTask),
            assistantMessage('Must remain uncommitted'),
          ],
          nextTurn: 1,
        },
      }),
      /commit proposal invalid/,
    );
    const cancelled = owner.sealGeneration({
      executionId: firstExecutionId,
      decision: 'cancelled',
      reason: 'Core cancelled before canonical authorization',
    });
    strictEqual(cancelled.durable, true);
    strictEqual(cancelled.canonical, false);
    strictEqual(cancelled.stateRevision, 1);
    strictEqual(cancelled.nextTurn, 1);
    strictEqual(cancelled.outcome.stopReason, 'cancelled');
    strictEqual('transcript' in cancelled.outcome, false);
    strictEqual(
      store.readExecutionMetadata(firstExecutionId).outcome,
      'cancelled',
    );
    deepStrictEqual(notifications.map((delta) => delta.cut), [1, 2, 3]);

    // A cancelled first execution leaves a valid empty canonical Session. Reopen it before
    // the first accepted turn to cover the persisted-owner path with zero transcript turns.
    await owner.close();
    owner = undefined;
    unsubscribeWriter?.();
    unsubscribeWriter = undefined;
    writer.close();
    writer = undefined;
    writer = new ConversationWriter(store);
    owner = await DataSessionOwner.open({
      store,
      writer,
      workspaceRoot,
      persistence: 'session',
      sessionId,
      agent: 'default',
      agentChoice: {},
    });
    const resumedEmpty = owner.generationContext(
      correlationFor(sessionId, 1, 'after-empty-reopen'),
    );
    deepStrictEqual(resumedEmpty.initialTranscript, []);
    strictEqual(resumedEmpty.nextTurn, 1);
    strictEqual(resumedEmpty.stateRevision, 1);

    const nextContextCorrelation = correlationFor(
      sessionId,
      1,
      'after-rejection',
    );
    const beforeCommit = owner.generationContext(nextContextCorrelation);
    strictEqual(beforeCommit.initialTranscript.length, 0);
    strictEqual(beforeCommit.nextTurn, 1);
    strictEqual(beforeCommit.stateRevision, 1);

    const task = 'Read and report the persisted marker';
    const executionId = '17000000-0000-4000-8000-000000000173';
    const correlation = correlationFor(sessionId, 1, 'authorized-commit');
    await owner.admit({
      executionId,
      taskId: '17000000-0000-4000-8000-000000000174',
      task,
      correlation,
      createdAt: '2026-10-03T00:00:02.000Z',
      configuration,
      maxSteps: 128,
    });
    const partial = runtimeInput(correlation, 1, {
      kind: 'assistant_progress',
      modelStep: 1,
      lane: 'parent',
      requestOrdinal: 1,
      text: 'The saved marker is amber.',
    });
    owner.receiveData({ executionId, sequence: 1, message: partial });
    owner.getJournal(executionId).flush();
    const partialEntity = entitiesOf(decode(snapshot().bytes)).find((
      entity,
    ) =>
      entity.kind === 'message' && entity.role === 'assistant' &&
      entity.text === 'The saved marker is amber.'
    );
    ok(partialEntity);
    const final = runtimeInput(correlation, 2, {
      kind: 'model_result',
      modelStep: 1,
      lane: 'parent',
      requestOrdinal: 1,
      result: { kind: 'final', text: 'The saved marker is amber.' },
    });
    owner.receiveData({ executionId, sequence: 2, message: final });

    const providerState = {
      provider: 'openrouter-chat',
      model: ROOT_DEFAULT_MODEL_SELECTION.modelId,
      reasoning: {
        field: 'reasoning_content' as const,
        text: 'Persist this provider state.',
      },
    };
    const transcript = [
      userMessage(task),
      {
        ...assistantMessage('The saved marker is amber.'),
        providerState,
      },
    ];
    const token = await owner.prepareProposal({
      proposalId: 'proposal-authorized-commit',
      executionId,
      finalDataSequence: 2,
      message: {
        kind: 'commit_proposal',
        correlation,
        transcript,
        nextTurn: 2,
      },
    });
    strictEqual(token.proposalId, 'proposal-authorized-commit');
    strictEqual(token.baseStateRevision, 1);
    strictEqual(token.finalDataSequence, 2);
    const committed = owner.authorizeCommit(token, { accepted: true });
    strictEqual(committed.durable, true);
    strictEqual(committed.canonical, true);
    strictEqual(committed.stateRevision, 2);
    strictEqual(committed.nextTurn, 2);
    strictEqual(committed.outcome.stopReason, 'final');
    strictEqual('transcript' in committed.outcome, false);
    const storedTranscript = (await store.readWorker(sessionId)).transcript;
    deepStrictEqual(storedTranscript, transcript);
    deepStrictEqual(
      storedTranscript[1]?.role === 'assistant' ? storedTranscript[1].providerState : undefined,
      providerState,
    );
    const saved = decode(snapshot().bytes);
    const partialFinal = entitiesOf(saved).find((entity) =>
      entity.kind === 'message' && entity.role === 'assistant' &&
      entity.text === 'The saved marker is amber.'
    );
    ok(partialFinal);
    strictEqual(
      partialFinal.id,
      partialEntity.id,
      'partial and terminal text keep one message identity',
    );
    deepStrictEqual(partialFinal.position, partialEntity.position);
    const firstRow = entitiesOf(saved).find((entity) =>
      entity.kind === 'execution' &&
      entity.id.includes(encodeURIComponent(firstExecutionId))
    );
    const committedRow = entitiesOf(saved).find((entity) =>
      entity.kind === 'execution' &&
      entity.id.includes(encodeURIComponent(executionId))
    );
    ok(firstRow?.execution);
    ok(committedRow?.execution);
    strictEqual(firstRow.execution.outcome, 'cancelled');
    strictEqual(firstRow.execution.adoption, 'non_canonical');
    strictEqual(committedRow.execution.outcome, 'completed');
    strictEqual(committedRow.execution.adoption, 'canonical');
    ok(saved.order.indexOf(firstRow.id) < saved.order.indexOf(committedRow.id));
    const cutBeforeLateSeal = saved.cut;
    const lateSeal = owner.sealGeneration({
      executionId,
      decision: 'interrupted',
      reason: 'late physical cleanup observation',
    });
    strictEqual(lateSeal, committed, 'authorized terminal result is reused');
    strictEqual(snapshot().cut, cutBeforeLateSeal);
    strictEqual(store.readExecutionMetadata(executionId).outcome, 'completed');

    const nextGeneration = owner.generationContext(
      correlationFor(sessionId, 2, 'next-turn'),
    );
    deepStrictEqual(nextGeneration.initialTranscript, []);
    strictEqual(nextGeneration.nextTurn, 2);
    strictEqual(nextGeneration.stateRevision, 2);
    strictEqual(nextGeneration.privateStateFromTurn, 1);
    const firstRange = await owner.readContextTurn(
      correlationFor(sessionId, 2, 'next-turn-range'),
      nextGeneration.nextTurn,
    );
    ok(firstRange);
    strictEqual(firstRange.turn, 1);
    strictEqual(firstRange.messageStart, 0);
    strictEqual(firstRange.source, 'canonical');
    deepStrictEqual(firstRange.messages, transcript);

    // Worker proposals carry one complete new turn; SQLite appends it to the prior prefix.
    const secondTask = 'Append a second canonical task';
    const secondExecutionId = '17000000-0000-4000-8000-000000000175';
    const secondCorrelation = correlationFor(
      sessionId,
      2,
      'second-authorized-commit',
    );
    await owner.admit({
      executionId: secondExecutionId,
      taskId: '17000000-0000-4000-8000-000000000176',
      task: secondTask,
      correlation: secondCorrelation,
      createdAt: '2026-10-03T00:00:03.000Z',
      configuration,
      maxSteps: 128,
    });
    const secondTurn = [
      userMessage(secondTask),
      assistantMessage('The second answer is saved.'),
    ];
    const secondTranscript = [...transcript, ...secondTurn];
    const secondToken = await owner.prepareProposal({
      proposalId: 'proposal-second-authorized-commit',
      executionId: secondExecutionId,
      finalDataSequence: 0,
      message: {
        kind: 'commit_proposal',
        correlation: secondCorrelation,
        transcript: secondTurn,
        nextTurn: 3,
      },
    });
    const secondCommitted = owner.authorizeCommit(secondToken, {
      accepted: true,
    });
    strictEqual(secondCommitted.canonical, true);
    strictEqual(secondCommitted.stateRevision, 3);
    strictEqual(secondCommitted.nextTurn, 3);
    deepStrictEqual(
      (await store.readWorker(sessionId)).transcript,
      secondTranscript,
    );

    await owner.close();
    owner = undefined;
    writer.close();
    writer = undefined;
    reopenedWriter = new ConversationWriter(store);
    reopened = await DataSessionOwner.open({
      store,
      writer: reopenedWriter,
      workspaceRoot,
      persistence: 'session',
      sessionId,
      agent: 'default',
      agentChoice: {},
    });
    const restored = reopened.generationContext(
      correlationFor(sessionId, 3, 'reopened-next-turn'),
    );
    deepStrictEqual(restored.initialTranscript, []);
    strictEqual(restored.nextTurn, 3);
    strictEqual(restored.stateRevision, 3);
    const restoredRange = await reopened.readContextTurn(
      correlationFor(sessionId, 3, 'reopened-next-turn-range'),
      restored.nextTurn,
    );
    ok(restoredRange);
    strictEqual(restoredRange.turn, 2);
    strictEqual(restoredRange.messageStart, 2);
    strictEqual(restoredRange.source, 'canonical');
    deepStrictEqual(restoredRange.messages, secondTurn);
    const reopenedSnapshot = decode(
      reopenedWriter!.snapshotSession(sessionId).bytes,
    );
    const replay = replaySessionConversation(
      sessionId,
      store.readSessionConversationFacts(sessionId),
    );
    deepStrictEqual(
      entitiesOf(reopenedSnapshot),
      orderedConversationEntities(replay.state),
    );
    strictEqual(reopenedSnapshot.cut, 0);
    strictEqual(reopenedSnapshot.storeRevision, 3);
  } finally {
    unsubscribeWriter?.();
    await reopened?.close();
    await owner?.close();
    reopenedWriter?.close();
    writer?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
