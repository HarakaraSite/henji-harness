import { ok, strictEqual } from 'node:assert';
import { ExecutionDataJournal } from '../../v0/agent/data/execution_data_journal.ts';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import type {
  WorkerCorrelation,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import type { ConversationMessageEntity } from '../../v0/conversation/model.ts';

Deno.test('Increment 170 Data journal waits for final data sequence and seals only its received prefix', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-data-journal-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const writer = new ConversationWriter(store);
  const sessionId = crypto.randomUUID();
  const executionId = crypto.randomUUID();
  const correlation: WorkerCorrelation = {
    session: sessionId,
    instanceCorrelation: crypto.randomUUID(),
    workerGeneration: crypto.randomUUID(),
    baseStateRevision: 1,
    command: 'turn-one',
  };
  const channel = new MessageChannel();
  let journal: ExecutionDataJournal | undefined;
  try {
    await store.initialize();
    const configuration = workerConfigurationFixture();
    await writer.beginExecution({
      executionId,
      taskId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      sessionCorrelation: sessionId,
      sessionMode: 'no_session',
      turn: 1,
      task: 'Keep the received prefix',
      baseStateRevision: 1,
      agent: 'default',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: 'test-command',
    });
    const notifications: number[] = [];
    const watch = writer.watchSession(
      sessionId,
      (delta) => notifications.push(delta.cut),
    );
    const failures: Error[] = [];
    journal = new ExecutionDataJournal({
      executionId,
      correlation,
      writer,
      history: store,
      onFailure: (error) => failures.push(error),
    });
    const statuses: string[] = [];
    channel.port2.onmessage = (event) => {
      const input = event.data as {
        executionId: string;
        sequence: number;
        message: WorkerToHostMessage;
      };
      statuses.push(journal!.receive(input));
      if (input.sequence === 3) {
        (input.message as unknown as {
          observation: { event: { text: string } };
        }).observation.event.text = 'mutated after Data accepted it';
      }
    };
    const messages: WorkerToHostMessage[] = [];
    const producer = new ProviderEvidenceRecorder(
      crypto.randomUUID(),
      1,
      new Date().toISOString(),
      (observation) => {
        messages.push({
          kind: 'provider_observation',
          correlation,
          sequence: 100 + messages.length + 1,
          turn: 1,
          observation,
        });
        return messages.length;
      },
      false,
    );
    producer.startRequestMetadata({
      lane: 'parent',
      modelStep: 1,
      endpoint: 'http://127.0.0.1/chat',
      method: 'POST',
      requestMetadata: {
        provider: 'test-provider',
        modelId: 'test-model',
        api: 'openai-chat-completions',
      },
    });
    producer.recordAssistantProgress('first', 1, 'parent');
    producer.recordAssistantProgress('latest', 1, 'parent');
    let barrierDone = false;
    const barrier = journal.flushThrough(3).then(() => barrierDone = true);
    strictEqual(barrierDone, false);
    for (const [index, message] of messages.entries()) {
      channel.port1.postMessage({ executionId, sequence: index + 1, message });
    }
    await barrier;
    strictEqual(journal.receivedSequence, 3);
    strictEqual(journal.durableSequence, 3);
    strictEqual(notifications.length, 1);
    const savedLatestProgress = store.listAssistantTextStates(executionId).find(
      (state) => state.key.modelStep === 1,
    );
    ok(savedLatestProgress);
    strictEqual(
      (savedLatestProgress.event.payload as unknown as {
        observation: { event: { text: string } };
      }).observation.event.text,
      'latest',
      'Data owns the event payload before the journal flushes it',
    );
    const snapshot = () =>
      JSON.parse(
        new TextDecoder().decode(writer.snapshotSession(sessionId).bytes),
      ) as {
        entities: Record<string, ConversationMessageEntity>;
      };
    const body = Object.values(snapshot().entities).find((entity) =>
      entity.kind === 'message' && entity.role === 'assistant'
    );
    ok(body);
    strictEqual(body.text, 'latest');
    strictEqual(body.complete, false);
    const cut = journal.seal();
    strictEqual(cut.receivedSequence, 3);
    strictEqual(cut.durableSequence, 3);
    const futureBarrier = journal.flushThrough(4).then(() => false, () => true);
    strictEqual(await futureBarrier, true);
    producer.recordAssistantProgress('in flight after seal', 1, 'parent');
    channel.port1.postMessage({
      executionId,
      sequence: 4,
      message: messages[3],
    });
    while (statuses.length < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    strictEqual(statuses[3], 'sealed');
    strictEqual(journal.receivedSequence, 3);
    writer.reconcileExecution({ executionId, settlement: 'interrupted' });
    const terminal = Object.values(snapshot().entities).find((entity) => entity.id === body.id);
    ok(terminal);
    strictEqual(terminal.text, 'latest');
    strictEqual(terminal.complete, false);
    ok(terminal.semanticOccurrenceId);
    strictEqual(terminal.position.eventOrdinal, body.position.eventOrdinal);
    strictEqual(
      store.readExecutionMetadata(executionId).outcome,
      'interrupted',
    );
    strictEqual(failures.length, 0);
    watch.unsubscribe();
  } finally {
    journal?.seal();
    channel.port1.close();
    channel.port2.close();
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
