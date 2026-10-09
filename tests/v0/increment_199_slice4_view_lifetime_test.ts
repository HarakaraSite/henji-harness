import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';

const decode = (bytes: Uint8Array): {
  readonly cut: number;
  readonly storeRevision: number;
  readonly entities: Readonly<
    Record<string, {
      readonly kind: string;
      readonly role?: string;
      readonly text?: string;
      readonly execution?: { readonly lifecycle: string };
    }>
  >;
  readonly changes?: readonly {
    readonly kind: string;
    readonly entity?: { readonly text?: string };
  }[];
} => JSON.parse(new TextDecoder().decode(bytes));

Deno.test('Increment 199 Slice 4 lazily builds conversation views and releases closed reads after use', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i199-s4-view-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const writer = new ConversationWriter(store);
  const sessionId = crypto.randomUUID();
  const executionId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const configuration = workerConfigurationFixture();
  const correlation = {
    session: sessionId,
    instanceCorrelation: 'i199-s4-instance',
    workerGeneration: 'i199-s4-generation',
    baseStateRevision: 1,
    command: 'i199-s4-headless',
  };
  const event = (
    workerSequence: number,
    text: string,
  ): ExecutionEventInput => ({
    executionId,
    direction: 'worker_to_host',
    source: 'worker',
    kind: 'runtime_event',
    workerSequence,
    payload: {
      kind: 'provider_observation',
      correlation,
      sequence: workerSequence,
      turn: 1,
      observation: {
        kind: 'runtime_event',
        event: {
          kind: 'assistant_progress',
          modelStep: 1,
          lane: 'parent',
          requestOrdinal: 1,
          text,
        },
      },
    },
  } as ExecutionEventInput);

  try {
    await store.initialize();
    const readPageFacts = store.readSessionConversationPageFacts.bind(store);
    let readCount = 0;
    store.readSessionConversationPageFacts = (...args) => {
      readCount += 1;
      return readPageFacts(...args);
    };

    writer.openSession(sessionId);
    const execution = {
      executionId,
      taskId,
      createdAt: '2026-10-06T00:00:00.000Z',
      sessionCorrelation: sessionId,
      sessionMode: 'no_session' as const,
      turn: 1,
      task: 'Report the saved marker',
      baseStateRevision: 1,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: 'i199-s4-test',
    };

    await writer.beginExecution(execution);
    writer.appendExecutionEvents([event(1, 'The marker is amber.')]);
    strictEqual(
      readCount,
      0,
      'headless admission and save do not replay history',
    );

    const updates: Uint8Array[] = [];
    const watch = writer.watchSession(
      sessionId,
      (delta) => updates.push(delta.bytes),
    );
    strictEqual(
      readCount,
      1,
      'the first conversation consumer builds one view',
    );
    const first = decode(watch.snapshot.bytes);
    strictEqual(first.cut, 2);
    ok(
      Object.values(first.entities).some((entity) =>
        entity.kind === 'message' && entity.role === 'assistant' &&
        entity.text === 'The marker is amber.'
      ),
    );

    writer.appendExecutionEvents([event(2, 'The marker is cobalt.')]);
    strictEqual(readCount, 1, 'an open Session reuses its materialized view');
    strictEqual(decode(updates.at(-1)!).cut, 3);
    ok(
      decode(updates.at(-1)!).changes?.some((change) =>
        change.kind === 'upsert' &&
        change.entity?.text === 'The marker is cobalt.'
      ),
    );

    writer.closeSession(sessionId);
    writer.appendExecutionEvents([event(3, 'The marker is violet.')]);
    strictEqual(
      readCount,
      1,
      'closing a Session leaves its active subscriber attached',
    );
    strictEqual(decode(updates.at(-1)!).cut, 4);
    watch.unsubscribe();

    const closedRead = writer.snapshotSession(sessionId);
    strictEqual(
      readCount,
      2,
      'a closed one-shot read rebuilds from saved facts',
    );
    strictEqual(closedRead.cut, 4);
    ok(
      Object.values(decode(closedRead.bytes).entities).some((entity) =>
        entity.kind === 'message' && entity.role === 'assistant' &&
        entity.text === 'The marker is violet.'
      ),
    );
    const repeatedClosedRead = writer.snapshotSession(sessionId);
    strictEqual(
      readCount,
      3,
      'the closed one-shot view was released after its response',
    );
    strictEqual(repeatedClosedRead.cut, 4);
    deepStrictEqual(repeatedClosedRead.bytes, closedRead.bytes);
  } finally {
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
