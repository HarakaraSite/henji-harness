import { deepStrictEqual, throws } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import type { LoopOutcome } from '../../v0/agent/core/contracts.ts';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import type { ProviderEvidenceRuntimeEvent } from '../../v0/agent/provider/provider_evidence.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import {
  recalledExecutionProjectionText,
  resolveRecalledExecutionContext,
} from '../../v0/agent/worker/recalled_execution_context.ts';
import type { HistoryV7AssistantTextState } from '../../v0/agent/history/history_v7_model.ts';

const executionId = '13400000-0000-4000-8000-000000000001';
const input = {
  executionId,
  taskId: '13400000-0000-4000-8000-000000000002',
  createdAt: '2026-09-26T14:40:00.000Z',
  sessionCorrelation: 'text-production',
  turn: 1,
  task: 'retain completed work and latest partial text',
  baseStateRevision: 0,
  agent: 'default' as const,
  model: ROOT_DEFAULT_MODEL_SELECTION,
  build: buildManifest(),
  definition: {
    schemaVersion: 1 as const,
    resourceKind: 'agent-definition' as const,
    resourceId: 'builtin/default',
    revision: { algorithm: 'sha256' as const, digest: '1'.repeat(64) },
  },
};
const observation = (
  event: ProviderEvidenceRuntimeEvent,
  sequence: number,
  session = input.sessionCorrelation,
  baseStateRevision = input.baseStateRevision,
): ExecutionEventInput => ({
  executionId,
  direction: 'worker_to_host',
  source: 'worker',
  kind: 'runtime_event',
  workerSequence: sequence,
  payload: {
    kind: 'provider_observation',
    correlation: {
      session,
      instanceCorrelation: 'instance-text',
      workerGeneration: 'generation-text',
      baseStateRevision,
      command: 'turn-text',
    },
    sequence,
    turn: 1,
    observation: { kind: 'runtime_event', event },
  },
});
const progress = (text: string, step = 1): ProviderEvidenceRuntimeEvent => ({
  kind: 'assistant_progress',
  text,
  modelStep: step,
  requestOrdinal: step,
  lane: 'parent',
});
const outcome = (stopReason: 'cancelled' | 'contract_failure'): LoopOutcome => ({
  ok: false,
  task: input.task,
  outcome: stopReason,
  stopReason,
  steps: 2,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});
const rowCount = (db: DatabaseSync, table: string): number =>
  Number(
    db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,
  );

Deno.test('Increment 134 production keeps completed result and only latest cancelled text', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i134-production-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  try {
    await store.beginExecution({ ...input, sessionMode: 'no_session' });
    const path = `${(await sessionPaths(stateRoot, workspaceRoot)).root}/history-v7.sqlite3`;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      store.appendExecutionEvents([
        observation(progress('H'), 1),
        observation(progress('Hello'), 2),
      ]);
      deepStrictEqual(rowCount(db, 'assistant_text_states'), 1);
      deepStrictEqual(rowCount(db, 'semantic_occurrences'), 1); // admission only
      const saved = JSON.parse(
        String(db.prepare('SELECT event_json FROM assistant_text_states').get()!.event_json),
      );
      deepStrictEqual(saved.payload.observation.event.text, 'Hello');
      deepStrictEqual(
        db.prepare('SELECT first_event_ordinal FROM assistant_text_states').get()!
          .first_event_ordinal,
        2,
      );
      store.appendExecutionEvents([
        observation(progress('Hello world'), 3),
        observation({
          kind: 'model_result',
          modelStep: 1,
          requestOrdinal: 1,
          lane: 'parent',
          result: { kind: 'final', text: 'Hello world' },
        }, 4),
      ]);
      deepStrictEqual(rowCount(db, 'assistant_text_states'), 0);
      deepStrictEqual(rowCount(db, 'semantic_occurrences'), 2);
      store.appendExecutionEvents([
        observation(progress('Second', 2), 5),
        observation(progress('Second partial', 2), 6),
      ]);
      store.appendExecutionEvent({
        executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'steer_requested',
        payload: { text: 'request a change while generating' },
      });
      const last = store.appendExecutionEvent(observation(progress('Second latest', 2), 7));
      store.settleNonCanonicalExecution({ ...input, outcome: outcome('cancelled') });
      deepStrictEqual(rowCount(db, 'assistant_text_states'), 0);
      deepStrictEqual(rowCount(db, 'semantic_occurrences'), 5); // admission, result, steer, partial, terminal
      const events = store.listExecutionEvents(executionId);
      const providerEvents = events.filter((event) => event.kind === 'runtime_event');
      deepStrictEqual(providerEvents.map((event) => event.payload), [
        observation({
          kind: 'model_result',
          modelStep: 1,
          requestOrdinal: 1,
          lane: 'parent',
          result: { kind: 'final', text: 'Hello world' },
        }, 4).payload,
        last.payload,
      ]);
      deepStrictEqual(providerEvents[1].ordinal, last.ordinal);
      deepStrictEqual(providerEvents[1].firstEventOrdinal, 6);
      deepStrictEqual(store.readExecution(executionId).outcome, 'cancelled');
      deepStrictEqual(
        events.findIndex((event) => event.firstEventOrdinal === 6) <
          events.findIndex((event) => event.kind === 'steer_requested'),
        true,
      );
      const recall = await resolveRecalledExecutionContext({
        sessionId: input.sessionCorrelation,
        executionId,
        historyPersistence: store,
      });
      deepStrictEqual(recall.observations.map((item) => item.kind), [
        'assistant_completed',
        'assistant_incomplete',
      ]);
      if (recall.schemaVersion !== 2) throw new Error('expected semantic recall');
      deepStrictEqual(
        recall.journalObservations.filter((item) => item.kind === 'assistant_progress'),
        [],
      );
      deepStrictEqual(recalledExecutionProjectionText(recall).match(/Second latest/g)?.length, 1);
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 134 active detail retains one text snapshot across later model completion', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i134-detail-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  const reader = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, { readOnly: true });
  const sessionId = '13400000-0000-4000-8000-000000000003';
  try {
    await store.beginExecution({
      ...input,
      canonicalSessionId: sessionId,
      sessionCorrelation: sessionId,
      sessionMode: 'persistent',
      baseStateRevision: 1,
      sessionRecord: {
        schemaVersion: 6,
        sessionId,
        workspaceRoot,
        agent: 'default',
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        title: null,
        stateRevision: 1,
        nextTurn: 1,
        transcript: [],
        definition: input.definition,
        activeModel: input.model,
        modelChanges: [{
          effectiveFromTurn: 1,
          changedAt: input.createdAt,
          selection: input.model,
        }],
        turnModels: [],
        turnExecutions: [],
      },
    });
    store.appendExecutionEvents([
      observation(progress('detail'), 1, sessionId, 1),
      observation(progress('detail latest'), 2, sessionId, 1),
    ]);
    await reader.initialize();
    const iterator = reader.streamHumanHistoryExport(sessionId)[Symbol.iterator]();
    try {
      const header = iterator.next(); // establishes the export read snapshot
      deepStrictEqual(header.done, false);
      store.appendExecutionEvent(observation(
        {
          kind: 'model_result',
          modelStep: 1,
          requestOrdinal: 1,
          lane: 'parent',
          result: { kind: 'final', text: 'detail completed' },
        },
        3,
        sessionId,
        1,
      ));
      const remaining = Array.from({ [Symbol.iterator]: () => iterator });
      const states = remaining.filter((entry) => entry.kind === 'assistant_text_state');
      deepStrictEqual(states.length, 1);
      const textState = states[0].value as unknown as HistoryV7AssistantTextState;
      deepStrictEqual(
        textState.event.payload,
        observation(progress('detail latest'), 2, sessionId, 1).payload,
      );
      deepStrictEqual(remaining.filter((entry) => entry.kind === 'semantic_occurrence').length, 1);
      const after = [...reader.streamHumanHistoryExport(sessionId)];
      deepStrictEqual(after.filter((entry) => entry.kind === 'assistant_text_state'), []);
      deepStrictEqual(after.filter((entry) => entry.kind === 'semantic_occurrence').length, 2);
      deepStrictEqual(store.readExecution(executionId).lifecycle, 'active');
    } finally {
      iterator.return?.();
    }
  } finally {
    reader.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 134 failed settlement retains latest text for restart reconciliation', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i134-restart-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, {
    fault: () => {
      throw new Error('settlement interrupted');
    },
  });
  try {
    await store.beginExecution({ ...input, sessionMode: 'no_session' });
    const latest = store.appendExecutionEvent(observation(progress('saved before failure'), 1));
    throws(() =>
      store.settleNonCanonicalExecution({ ...input, outcome: outcome('contract_failure') })
    );
    const path = `${(await sessionPaths(stateRoot, workspaceRoot)).root}/history-v7.sqlite3`;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      deepStrictEqual(rowCount(db, 'assistant_text_states'), 1);
      deepStrictEqual(rowCount(db, 'semantic_occurrences'), 1);
      deepStrictEqual(store.readExecution(executionId).lifecycle, 'active');
    } finally {
      db.close();
    }
    store.close();
    const reopened = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
    try {
      await reopened.initialize();
      deepStrictEqual(reopened.readExecution(executionId).outcome, 'interrupted');
      const events = reopened.listExecutionEvents(executionId);
      deepStrictEqual(
        events.filter((event) => event.kind === 'runtime_event').map((event) => event.payload),
        [latest.payload],
      );
      deepStrictEqual(events.at(-1)!.kind, 'execution_reconciled');
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        deepStrictEqual(rowCount(db, 'assistant_text_states'), 0);
        deepStrictEqual(rowCount(db, 'semantic_occurrences'), 3);
      } finally {
        db.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
