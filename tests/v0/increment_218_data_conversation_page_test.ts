import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { canonicalJsonBytes } from '../../v0/agent/history/context_attribution.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import type { ConversationEntity, ConversationPageMetadata } from '../../v0/conversation/model.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const decode = (bytes: Uint8Array): Readonly<{
  schemaVersion: number;
  sessionId: string;
  cut: number;
  storeRevision: number;
  entities: Readonly<Record<string, ConversationEntity>>;
  order: readonly string[];
  page: ConversationPageMetadata;
}> => JSON.parse(new TextDecoder().decode(bytes));

Deno.test('Increment 218 latest conversation page is bounded and retains stable Session positions', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-218-conversation-page-',
  });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const writer = new ConversationWriter(store);
  const sessionId = `page:${crypto.randomUUID()}`;
  try {
    await store.initialize();
    const configuration = workerConfigurationFixture();
    for (let index = 0; index < 53; index += 1) {
      const executionId = crypto.randomUUID();
      await writer.beginExecution({
        sessionMode: 'no_session',
        sessionCorrelation: sessionId,
        executionId,
        taskId: crypto.randomUUID(),
        createdAt: new Date(Date.UTC(2026, 9, 9, 0, 0, index)).toISOString(),
        turn: index + 1,
        task: `page task ${index}`,
        baseStateRevision: 0,
        agent: 'default',
        model: ROOT_DEFAULT_MODEL_SELECTION,
        build: buildManifest(),
        configuration,
        configurationId: configuration.configurationId,
        maxSteps: 128,
        command: `page-command-${index}`,
      });
      writer.reconcileExecution({ executionId, settlement: 'interrupted' });
    }

    const latest = decode(writer.snapshotSession(sessionId).bytes);
    strictEqual(latest.schemaVersion, 3);
    const latestExecutions = Object.values(latest.entities)
      .filter((entity) => entity.kind === 'execution');
    strictEqual(latestExecutions.length, 50);
    deepStrictEqual(
      latestExecutions.map((entity) => entity.position.executionOrder).sort((
        a,
        b,
      ) => a - b),
      Array.from({ length: 50 }, (_, index) => index + 3),
    );
    strictEqual(latest.page.direction, 'latest');
    strictEqual(latest.page.lowerExecutionOrder, 3);
    strictEqual(latest.page.upperExecutionOrder, 52);
    strictEqual(latest.page.hasOlder, true);
    strictEqual(latest.page.hasNewer, false);

    const older = decode(writer.snapshotPage(sessionId, 3, 'older').bytes);
    deepStrictEqual(
      Object.values(older.entities)
        .filter((entity) => entity.kind === 'execution')
        .map((entity) => entity.position.executionOrder),
      [0, 1, 2],
    );
    strictEqual(older.page.direction, 'older');
    strictEqual(older.page.hasNewer, true);

    const newer = decode(writer.snapshotPage(sessionId, 2, 'newer').bytes);
    deepStrictEqual(
      Object.values(newer.entities)
        .filter((entity) => entity.kind === 'execution')
        .map((entity) => entity.position.executionOrder)
        .sort((a, b) => a - b),
      Array.from({ length: 50 }, (_, index) => index + 3),
    );
    strictEqual(newer.page.direction, 'newer');

    const liveDeltas: Uint8Array[] = [];
    const watch = writer.watchSession(
      sessionId,
      (delta) => liveDeltas.push(delta.bytes),
    );
    const watchedSnapshot = decode(watch.snapshot.bytes);
    const evictedExecution = Object.values(watchedSnapshot.entities).find((
      entity,
    ) => entity.kind === 'execution' && entity.position.executionOrder === 3);
    ok(evictedExecution?.kind === 'execution');
    const latestExecutionId = crypto.randomUUID();
    await writer.beginExecution({
      sessionMode: 'no_session',
      sessionCorrelation: sessionId,
      executionId: latestExecutionId,
      taskId: crypto.randomUUID(),
      createdAt: '2026-10-09T00:01:00.000Z',
      turn: 54,
      task: 'new latest execution',
      baseStateRevision: 0,
      agent: 'default',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: 'page-command-latest',
    });
    const activeView = decode(writer.snapshotSession(sessionId).bytes);
    strictEqual(
      Object.values(activeView.entities).filter((entity) => entity.kind === 'execution').length,
      51,
    );
    strictEqual(activeView.page.lowerExecutionOrder, 3);
    strictEqual(activeView.page.upperExecutionOrder, 53);
    writer.reconcileExecution({
      executionId: latestExecutionId,
      settlement: 'interrupted',
    });
    const terminalDelta = JSON.parse(
      new TextDecoder().decode(liveDeltas.at(-1)),
    ) as {
      schemaVersion: number;
      page: ConversationPageMetadata;
      changes: readonly { kind: string; id?: string }[];
    };
    strictEqual(terminalDelta.schemaVersion, 3);
    strictEqual(terminalDelta.page.lowerExecutionOrder, 4);
    ok(terminalDelta.changes.some((change) =>
      change.kind === 'remove' &&
      change.id ===
        `execution/${encodeURIComponent(evictedExecution.executionId)}`
    ));
    ok(terminalDelta.changes.some((change) =>
      change.kind === 'remove' &&
      change.id ===
        `message/task/${encodeURIComponent(evictedExecution.executionId)}`
    ));
    watch.unsubscribe();
  } finally {
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 218 conversation details preserve large task, message, and tool arguments as UTF-8 bytes', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-218-conversation-detail-',
  });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const writer = new ConversationWriter(store);
  const sessionId = `detail:${crypto.randomUUID()}`;
  const executionId = crypto.randomUUID();
  const task = `task🌱${'説明'.repeat(1800)}`;
  const assistantText = '葉🌱'.repeat(50_000);
  const argumentsValue = { zeta: '記録🌿'.repeat(800), alpha: 'first' };
  const correlation = {
    session: sessionId,
    instanceCorrelation: 'increment-218-detail-instance',
    workerGeneration: 'increment-218-detail-generation',
    baseStateRevision: 0,
    command: 'increment-218-detail-command',
  };
  try {
    await store.initialize();
    const configuration = workerConfigurationFixture();
    await writer.beginExecution({
      sessionMode: 'no_session',
      sessionCorrelation: sessionId,
      executionId,
      taskId: crypto.randomUUID(),
      createdAt: '2026-10-09T00:00:00.000Z',
      turn: 1,
      task,
      baseStateRevision: 0,
      agent: 'default',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: correlation.command,
    });

    const initial = decode(writer.snapshotSession(sessionId).bytes);
    const taskMessage = Object.values(initial.entities).find((entity) =>
      entity.kind === 'message' && entity.role === 'user'
    );
    ok(taskMessage?.kind === 'message');
    strictEqual(taskMessage.text.includes(task), false);
    const taskLocator = taskMessage.details?.[0];
    ok(taskLocator);
    strictEqual(taskLocator.field, 'task');
    strictEqual(taskLocator.cut, initial.cut);
    strictEqual(
      store.readConversationContent(taskLocator, 0, 64 * 1024).text,
      task,
    );

    const event = (
      sequence: number,
      runtimeEvent: Readonly<Record<string, unknown>>,
    ): ExecutionEventInput => ({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: sequence,
      payload: {
        kind: 'provider_observation',
        correlation,
        sequence,
        turn: 1,
        observation: { kind: 'runtime_event', event: runtimeEvent },
      },
    } as ExecutionEventInput);
    writer.appendExecutionEvents([
      event(1, {
        kind: 'model_result',
        result: { kind: 'final', text: assistantText },
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
      }),
      event(2, {
        kind: 'model_result',
        result: {
          kind: 'tool_calls',
          calls: [{
            callId: 'large-arguments',
            name: 'inspect',
            arguments: argumentsValue,
          }],
        },
        modelStep: 2,
        lane: 'parent',
        requestOrdinal: 2,
      }),
    ]);

    const projected = decode(writer.snapshotSession(sessionId).bytes);
    const assistant = Object.values(projected.entities).find((entity) =>
      entity.kind === 'message' && entity.role === 'assistant'
    );
    ok(assistant?.kind === 'message');
    strictEqual(assistant.text.includes(assistantText), false);
    const assistantLocator = assistant.details?.[0];
    ok(assistantLocator);
    const firstChunk = store.readConversationContent(
      assistantLocator,
      0,
      256 * 1024,
    );
    strictEqual(firstChunk.done, false);
    const secondChunk = store.readConversationContent(
      assistantLocator,
      firstChunk.nextOffset,
      256 * 1024,
    );
    strictEqual(secondChunk.done, true);
    strictEqual(firstChunk.text + secondChunk.text, assistantText);

    const tool = Object.values(projected.entities).find((entity) =>
      entity.kind === 'tool' && entity.callId === 'large-arguments'
    );
    ok(tool?.kind === 'tool');
    strictEqual(
      JSON.stringify(tool.arguments).includes(JSON.stringify(argumentsValue)),
      false,
    );
    const argumentsLocator = tool.details?.find((locator) => locator.field === 'tool_arguments');
    ok(argumentsLocator);
    strictEqual(
      store.readConversationContent(argumentsLocator, 0, 64 * 1024).text,
      new TextDecoder().decode(canonicalJsonBytes(argumentsValue)),
    );
    strictEqual(assistantLocator.cut, projected.cut);
    strictEqual(argumentsLocator.cut, projected.cut);
  } finally {
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 218 follow-up receipts preserve text, status, and bounded keyset pages', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-218-follow-up-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const writer = new ConversationWriter(store);
  const sessionId = `follow-up:${crypto.randomUUID()}`;
  const executionId = crypto.randomUUID();
  const coreEpoch = crypto.randomUUID();
  const priorCoreEpoch = crypto.randomUUID();
  try {
    await store.initialize();
    const configuration = workerConfigurationFixture();
    await writer.beginExecution({
      sessionMode: 'no_session',
      sessionCorrelation: sessionId,
      executionId,
      taskId: crypto.randomUUID(),
      createdAt: '2026-10-09T00:00:00.000Z',
      turn: 1,
      task: 'queue follow-up receipts',
      baseStateRevision: 0,
      agent: 'default',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: 'increment-218-follow-up-parent',
    });

    for (let index = 0; index < 40; index += 1) {
      store.writeFollowUpReceipt({
        coreEpoch: index >= 20 ? priorCoreEpoch : coreEpoch,
        sessionId,
        followUp: {
          queueId: `queue-${String(index).padStart(2, '0')}`,
          commandId: `command-${index}`,
          sessionId,
          afterExecutionId: executionId,
          text: `follow up ${index} 🌿`,
          status: 'queued',
        },
      });
    }
    store.writeFollowUpReceipt({
      coreEpoch,
      sessionId,
      followUp: {
        queueId: 'queue-10',
        commandId: 'command-10',
        sessionId,
        afterExecutionId: executionId,
        text: 'follow up 10 🌿',
        status: 'started',
        executionId,
      },
    });

    const first = store.readFollowUpPage(sessionId);
    strictEqual(first.followUps.length, 32);
    strictEqual(first.hasMore, true);
    ok(first.nextCursor);
    const second = store.readFollowUpPage(sessionId, first.nextCursor);
    strictEqual(second.followUps.length, 8);
    strictEqual(second.hasMore, false);
    strictEqual(second.nextCursor, undefined);
    const queueIds = [...first.followUps, ...second.followUps]
      .map((receipt) => receipt.followUp.queueId);
    strictEqual(new Set(queueIds).size, 40);
    const updated = store.readFollowUpReceipt('queue-10');
    ok(updated);
    strictEqual(updated.followUp.status, 'started');
    strictEqual(updated.followUp.text, 'follow up 10 🌿');
    strictEqual(updated.followUp.executionId, executionId);
    strictEqual(updated.sessionId, sessionId);
  } finally {
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
