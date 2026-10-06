import { deepStrictEqual, strictEqual } from 'node:assert';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import { DataSessionOwner } from '../../v0/agent/data/session_data_owner.ts';
import { contextRevisionDigest } from '../../v0/agent/history/context_attribution.ts';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryCore } from '../../v0/agent/history/sqlite_history_core.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

Deno.test('196 saved Session metadata preserves latest request and count without reading thinking history', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-196-metadata-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const writer = new ConversationWriter(store);
  const originalRead = SqliteHistoryCore.prototype.readOccurrence;
  const decodedKinds: string[] = [];
  let owner: DataSessionOwner | undefined;
  try {
    await store.initialize();
    owner = await DataSessionOwner.open({
      store,
      writer,
      workspaceRoot,
      persistence: 'new',
      agent: 'default',
      agentChoice: {},
      initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    });
    const sessionId = owner.sessionId;
    // Persist the new Session before creating the saved execution facts.
    owner.handle.saveMetadata(owner.authority.initialMetadataWrite()!);
    await owner.close();
    owner = undefined;
    const configuration = workerConfigurationFixture();
    const earlierId = crypto.randomUUID();
    const newerId = crypto.randomUUID();
    for (const [index, executionId] of [earlierId, newerId].entries()) {
      await store.beginExecution({
        sessionMode: 'persistent',
        sessionCorrelation: sessionId,
        canonicalSessionId: sessionId,
        executionId,
        taskId: crypto.randomUUID(),
        createdAt: `2026-10-05T00:00:0${index}.000Z`,
        turn: 1,
        task: `saved execution ${index + 1}`,
        baseStateRevision: 1,
        agent: 'default',
        model: ROOT_DEFAULT_MODEL_SELECTION,
        build: buildManifest(),
        configuration,
        configurationId: configuration.configurationId,
        maxSteps: 128,
        command: 'test-command',
      });
    }
    const request = async (
      executionId: string,
      ordinal: number,
      lane: 'parent' | 'planner' = 'parent',
    ) => {
      const revision = { lane, purpose: 'user_turn' as const, resultItemCount: 0, splices: [] };
      store.appendExecutionEventsWithSemanticIds([{
        executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'provider_request_start',
        payload: {
          kind: 'provider_observation',
          observation: {
            kind: 'request_start',
            request: { ordinal, lane, modelStep: ordinal },
          },
        },
      }, {
        executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'context_observation',
        payload: {
          kind: 'context_observation',
          observation: {
            kind: 'model_request_delta',
            delta: {
              schemaVersion: 2,
              requestOrdinal: ordinal,
              modelStep: ordinal,
              ...revision,
              revisionDigest: await contextRevisionDigest(revision),
              occurrences: [],
            },
          },
        },
      }] as ExecutionEventInput[]);
    };
    await request(earlierId, 1);
    store.appendExecutionEventsWithSemanticIds([{
      executionId: earlierId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      payload: {
        kind: 'runtime_event',
        event: {
          kind: 'agent_event',
          event: {
            kind: 'assistant_thinking',
            turn: 1,
            modelStep: 1,
            thinkingKind: 'text',
            text: 'saved thinking '.repeat(1024),
            complete: false,
          },
        },
      },
    }] as ExecutionEventInput[]);
    await request(earlierId, 2);
    SqliteHistoryCore.prototype.readOccurrence = function (id, db) {
      const result = originalRead.call(this, id, db);
      decodedKinds.push(result.kind);
      return result;
    };
    const reopen = async () => {
      await owner?.close();
      decodedKinds.length = 0;
      owner = await DataSessionOwner.open({
        store,
        writer,
        workspaceRoot,
        persistence: 'session',
        sessionId,
        agent: 'default',
        agentChoice: {},
      });
      strictEqual(
        decodedKinds.length,
        0,
        'latest request metadata is projected without occurrence hydration',
      );
      return owner.descriptor();
    };
    // The newest execution has no request yet, so context keeps the earlier execution's latest.
    const emptyNewer = await reopen();
    deepStrictEqual(emptyNewer.context.latestRequest, {
      executionId: earlierId,
      requestOrdinal: 2,
      lane: 'parent',
      purpose: 'user_turn',
      modelStep: 2,
      itemCount: 0,
    });
    strictEqual(emptyNewer.latestExecution?.executionId, newerId);
    strictEqual(emptyNewer.latestExecution?.requestCount, 0);
    strictEqual(store.readExecutionRequestCount(earlierId), 2);

    await request(newerId, 1);
    const firstNewer = await reopen();
    strictEqual(firstNewer.context.latestRequest?.executionId, newerId);
    strictEqual(firstNewer.context.latestRequest?.requestOrdinal, 1);
    strictEqual(firstNewer.latestExecution?.requestCount, 1);

    await request(newerId, 2, 'planner');
    const secondNewer = await reopen();
    deepStrictEqual(secondNewer.context.latestRequest, {
      executionId: newerId,
      requestOrdinal: 2,
      lane: 'planner',
      purpose: 'user_turn',
      modelStep: 2,
      itemCount: 0,
    });
    strictEqual(secondNewer.latestExecution?.requestCount, 2);
  } finally {
    SqliteHistoryCore.prototype.readOccurrence = originalRead;
    await owner?.close();
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
