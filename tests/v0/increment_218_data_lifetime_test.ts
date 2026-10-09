import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import { DataSessionOwner } from '../../v0/agent/data/session_data_owner.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import type { ConversationEntity } from '../../v0/conversation/model.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const decode = (bytes: Uint8Array): Readonly<{
  cut: number;
  entities: Readonly<Record<string, ConversationEntity>>;
}> => JSON.parse(new TextDecoder().decode(bytes));

Deno.test('Increment 218 inactive Data Sessions restore bounded cursors after watch churn', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-218-data-lifetime-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  const firstSession = { id: '', cut: -1, sequence: -1 };
  let stage = 'open';
  try {
    for (let index = 0; index < 40; index += 1) {
      stage = `open ${index}`;
      const descriptor = await data.openSession({
        persistence: 'new',
        agent: 'default',
        agentChoice: {},
        initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
      });
      const sessionId = descriptor.id;
      await data.updateTitle(sessionId, `Saved Session ${index}`);
      stage = `watch ${index}`;
      const conversationWatch = await data.watchConversation(sessionId, () => {});
      const descriptorWatch = await data.watchSessionDescriptor(
        sessionId,
        () => {},
      );
      const cut = decode(conversationWatch.snapshot.bytes).cut;
      const sequence = descriptorWatch.snapshot.sequence;
      if (index === 0) Object.assign(firstSession, { id: sessionId, cut, sequence });
      strictEqual(cut, 0);

      stage = `close ${index}`;
      await data.closeSession(sessionId);
      descriptorWatch.unsubscribe();
      conversationWatch.unsubscribe();
      await data.closeSession(sessionId);

      stage = `reopen ${index}`;
      const reopened = await data.openSession({
        persistence: 'session',
        sessionId,
        agent: 'default',
        agentChoice: {},
      });
      strictEqual(reopened.id, sessionId);
      const resumedDescriptor = await data.watchSessionDescriptor(
        sessionId,
        () => {},
      );
      const resumedConversation = await data.watchConversation(
        sessionId,
        () => {},
      );
      strictEqual(decode(resumedConversation.snapshot.bytes).cut >= cut, true);
      strictEqual(resumedDescriptor.snapshot.sequence >= sequence, true);
      resumedDescriptor.unsubscribe();
      resumedConversation.unsubscribe();
      await data.closeSession(sessionId);
    }

    strictEqual((await data.sessionsList()).sessions.length, 40);

    // The first cursor has aged out of the 32-entry in-memory cache and must be
    // restored by its dataInstanceId/session key from SQLite.
    const latest = await data.conversationSnapshot(firstSession.id);
    strictEqual(decode(latest.bytes).cut >= firstSession.cut, true);
    const descriptorWatch = await data.watchSessionDescriptor(
      firstSession.id,
      () => {},
    );
    strictEqual(descriptorWatch.snapshot.sequence >= firstSession.sequence, true);
    descriptorWatch.unsubscribe();

    const coreEpoch = crypto.randomUUID();
    strictEqual(await data.coreSessionCursorRead(coreEpoch, firstSession.id), null);
    await data.coreSessionCursorSave(coreEpoch, firstSession.id, 11);
    strictEqual(await data.coreSessionCursorRead(coreEpoch, firstSession.id), 11);
    await data.coreSessionCursorSave(coreEpoch, firstSession.id, 14);
    strictEqual(await data.coreSessionCursorRead(coreEpoch, firstSession.id), 14);
    strictEqual(
      await data.coreSessionCursorRead(crypto.randomUUID(), firstSession.id),
      null,
    );
  } catch (error) {
    throw new Error(`Data Session lifetime failed during ${stage}`, {
      cause: error,
    });
  } finally {
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 218 ConversationWriter releases and restores only a Session cursor', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-218-writer-release-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const writer = new ConversationWriter(store);
  const sessionId = crypto.randomUUID();
  const configuration = workerConfigurationFixture();
  const beginExecution = (executionId: string, turn: number) => ({
    sessionMode: 'no_session' as const,
    sessionCorrelation: sessionId,
    executionId,
    taskId: crypto.randomUUID(),
    createdAt: new Date(Date.UTC(2026, 9, 9, 0, 0, turn)).toISOString(),
    turn,
    task: `cursor execution ${turn}`,
    baseStateRevision: 0,
    agent: 'default',
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    configuration,
    configurationId: configuration.configurationId,
    maxSteps: 128,
    command: `cursor-command-${turn}`,
  });

  try {
    await store.initialize();
    writer.openSession(sessionId);
    const first = crypto.randomUUID();
    await writer.beginExecution(beginExecution(first, 1));
    const beforeRelease = writer.sessionCursorState(sessionId);
    ok(beforeRelease);
    const cursor = {
      dataInstanceId: crypto.randomUUID(),
      sessionCorrelation: sessionId,
      cut: beforeRelease.cut,
      storeRevision: beforeRelease.storeRevision,
      descriptorSequence: 17,
      anchor: {
        persistence: 'persistent',
        stateRevision: 0,
        nextTurn: 1,
        privateStateFromTurn: 1,
      },
      latestExecutionId: first,
    };
    store.writeDataSessionReadCursor(cursor);
    deepStrictEqual(
      store.readDataSessionReadCursor(cursor.dataInstanceId, sessionId),
      cursor,
    );

    writer.releaseSession(sessionId);
    strictEqual(writer.sessionCursorState(sessionId), undefined);
    writer.restoreSessionCursor(sessionId, cursor.cut, cursor.storeRevision);
    const deltas: Uint8Array[] = [];
    const watch = writer.watchSession(sessionId, (delta) => deltas.push(delta.bytes));
    strictEqual(decode(watch.snapshot.bytes).cut, cursor.cut);

    const second = crypto.randomUUID();
    await writer.beginExecution(beginExecution(second, 2));
    strictEqual(deltas.length, 1);
    const updated = JSON.parse(new TextDecoder().decode(deltas[0]!)) as {
      cut: number;
      changes: readonly { kind: string; entity?: ConversationEntity }[];
    };
    strictEqual(updated.cut, cursor.cut + 1);
    ok(updated.changes.some((change) =>
      change.kind === 'upsert' &&
      change.entity?.kind === 'execution' &&
      change.entity.executionId === second
    ));
    watch.unsubscribe();
  } finally {
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 218 terminal execution indexes retain the latest consumer and restore old Session from SQLite', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-218-execution-lifetime-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const writer = new ConversationWriter(store);
  let owner: DataSessionOwner | undefined;
  const firstExecutionId = crypto.randomUUID();
  const secondExecutionId = crypto.randomUUID();

  try {
    await store.initialize();
    owner = await DataSessionOwner.open({
      store,
      writer,
      workspaceRoot,
      persistence: 'none',
      agent: 'default',
      agentChoice: {},
    });
    const configuration = workerConfigurationFixture();
    const admitAndInterrupt = async (executionId: string, suffix: string) => {
      const correlation = {
        session: owner!.sessionId,
        instanceCorrelation: `increment-218-${suffix}`,
        workerGeneration: `generation-${suffix}`,
        baseStateRevision: owner!.descriptor().stateRevision,
        command: `command-${suffix}`,
      };
      await owner!.admit({
        executionId,
        taskId: crypto.randomUUID(),
        task: `retained execution ${suffix}`,
        correlation,
        createdAt: '2026-10-09T00:00:00.000Z',
        configuration,
        maxSteps: 128,
      });
      await owner!.sealGeneration({
        executionId,
        decision: 'interrupted',
        reason: 'execution lifetime test',
      });
    };

    await admitAndInterrupt(firstExecutionId, 'first');
    strictEqual(owner.hasRetainedExecution(firstExecutionId), true);
    await admitAndInterrupt(secondExecutionId, 'second');
    strictEqual(owner.hasRetainedExecution(firstExecutionId), false);
    strictEqual(owner.hasRetainedExecution(secondExecutionId), true);

    writer.appendPostSettlementSemanticEvent({
      semanticKind: 'context_update',
      event: {
        executionId: firstExecutionId,
        observedAt: '2026-10-09T00:00:01.000Z',
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: 1,
        payload: { kind: 'retained-execution-readback' },
      },
    });
    strictEqual(
      store.listExecutionEvents(firstExecutionId).at(-1)?.workerSequence,
      1,
    );
  } finally {
    await owner?.close();
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
