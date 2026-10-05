import { deepStrictEqual, strictEqual } from 'node:assert';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryCore } from '../../v0/agent/history/sqlite_history_core.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { replaySessionConversation } from '../../v0/conversation/history_adapter.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

Deno.test('195 replay reads each payload on demand in source order from one Session snapshot', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-195-replay-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const sessionId = crypto.randomUUID();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const configuration = workerConfigurationFixture();
  const progress = (text: string, sequence: number): ExecutionEventInput => ({
    executionId: firstId,
    direction: 'worker_to_host',
    source: 'worker',
    kind: 'runtime_event',
    workerSequence: sequence,
    payload: {
      kind: 'provider_observation',
      turn: 1,
      observation: {
        kind: 'runtime_event',
        event: {
          kind: 'assistant_progress',
          text,
          modelStep: 1,
          requestOrdinal: 1,
          lane: 'parent',
        },
      },
    },
  } as ExecutionEventInput);
  const steer = (executionId: string, text: string): ExecutionEventInput => ({
    executionId,
    direction: 'host_to_worker',
    source: 'host',
    kind: 'steer_requested',
    payload: { text },
  });
  const originalRead = SqliteHistoryCore.prototype.readOccurrence;
  let payloadReads = 0;
  let facts: ReturnType<typeof store.readSessionConversationFacts> | undefined;
  try {
    await store.initialize();
    for (const [index, executionId] of [firstId, secondId].entries()) {
      await store.beginExecution({
        sessionMode: 'no_session',
        sessionCorrelation: sessionId,
        executionId,
        taskId: crypto.randomUUID(),
        createdAt: `2026-10-05T00:00:0${index}.000Z`,
        turn: index + 1,
        task: `task ${index + 1}`,
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
    store.appendExecutionEventsWithSemanticIds([
      progress('partial', 1),
      steer(firstId, 'first steering'),
      progress('saved partial', 2),
      steer(firstId, 'second steering'),
      steer(secondId, 'later execution'),
    ]);
    SqliteHistoryCore.prototype.readOccurrence = function (id, db) {
      payloadReads++;
      return originalRead.call(this, id, db);
    };
    facts = store.readSessionConversationFacts(sessionId);
    const first = facts.next();
    strictEqual(first.done, false);
    strictEqual(first.value.execution.executionId, firstId);
    strictEqual(payloadReads, 0, 'execution metadata must not decode source payloads');

    // Commits after metadata was read must not change either execution's replay cut.
    store.appendExecutionEventsWithSemanticIds([
      progress('updated after snapshot', 3),
      steer(secondId, 'new later event'),
    ]);
    const events = first.value.events[Symbol.iterator]();
    strictEqual(events.next().value.event.kind, 'execution_admitted');
    strictEqual(payloadReads, 1);
    const partial = events.next();
    strictEqual(partial.done, false);
    strictEqual(partial.value.event.firstEventOrdinal, 2);
    strictEqual(partial.value.event.ordinal, 4);
    strictEqual(JSON.stringify(partial.value.event).includes('saved partial'), true);
    strictEqual(JSON.stringify(partial.value.event).includes('updated after snapshot'), false);
    strictEqual(partial.value.semanticOccurrenceId, undefined);
    strictEqual(payloadReads, 1);
    const steering = events.next();
    strictEqual(steering.value.event.ordinal, 3);
    strictEqual(typeof steering.value.semanticOccurrenceId, 'string');
    strictEqual(payloadReads, 2, 'advancing one event must read only that payload');
    strictEqual(events.next().value.event.ordinal, 5);
    strictEqual(events.next().done, true);
    strictEqual(payloadReads, 3);
    const second = facts.next();
    strictEqual(second.value.execution.executionId, secondId);
    deepStrictEqual([...second.value.events].map((item) => item.event.ordinal), [1, 2]);
    strictEqual(payloadReads, 5);
    strictEqual(facts.next().done, true);

    const reopened = replaySessionConversation(
      sessionId,
      store.readSessionConversationFacts(sessionId),
    );
    const entities = JSON.stringify([...reopened.state.entities.values()]);
    strictEqual(entities.includes('updated after snapshot'), true);
    strictEqual(entities.includes('new later event'), true);
    deepStrictEqual([...reopened.normalizer.executionOrders], [[firstId, 0], [secondId, 1]]);
  } finally {
    facts?.return?.();
    SqliteHistoryCore.prototype.readOccurrence = originalRead;
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
