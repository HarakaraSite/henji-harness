import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import type { Message } from '../../v0/agent/core/contracts.ts';
import { createDataService } from '../../v0/agent/data/data_service.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import {
  renderCanonicalView,
  renderConversationTimeline,
} from '../../v0/agent/history/history_view.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import { replaySessionConversation } from '../../v0/conversation/history_adapter.ts';

const bytesOf = (parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const collect = async (
  data: Awaited<ReturnType<typeof createDataService>>,
  streamId: string,
  initialParts: readonly Uint8Array[] = [],
): Promise<string> => {
  const parts: Uint8Array[] = [...initialParts];
  for (;;) {
    const chunk = await data.historyStreamRead(streamId);
    ok(chunk.bytes.byteLength <= 256 * 1024);
    parts.push(chunk.bytes);
    if (chunk.done) break;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(parts));
};

const user = (text: string): Message => ({
  role: 'user',
  content: { kind: 'text', text },
});

const assistant = (text: string): Message => ({
  role: 'assistant',
  content: { kind: 'text', text },
});

Deno.test('Increment 218 history streams preserve render output, snapshot cut, and leave executions alone', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-218-history-stream-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let data: Awaited<ReturnType<typeof createDataService>> | undefined;
  let activeExecutionId: string | undefined;
  try {
    await store.initialize();
    const createdAt = '2026-10-09T01:00:00.000Z';
    const configuration = workerConfigurationFixture();
    const handle = await store.allocateWorker('default', {});
    const initial: StoredSessionRecord = {
      schemaVersion: 1,
      sessionId: handle.id,
      workspaceRoot,
      agent: 'default',
      createdAt,
      updatedAt: createdAt,
      title: 'Stream fixture',
      stateRevision: 1,
      nextTurn: 1,
      transcript: [],
      agentChoice: {},
      activeModel: ROOT_DEFAULT_MODEL_SELECTION,
      modelChanges: [{
        effectiveFromTurn: 1,
        changedAt: createdAt,
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      }],
      turnModels: [],
      turnExecutions: [],
    };
    handle.saveMetadata({
      sessionId: initial.sessionId,
      workspaceRoot,
      agentChoice: initial.agentChoice,
      createdAt,
      updatedAt: createdAt,
      title: initial.title,
      stateRevision: 1,
      nextTurn: 1,
      activeModel: initial.activeModel,
      modelChangesToAppend: initial.modelChanges,
    });
    handle.close();

    const writePath = 'folder/'.repeat(18) + 'out.txt';
    const writeArguments = { content: 'original file contents '.repeat(200), path: writePath };
    const commitTurn = async (
      turn: number,
      assistantText: string,
    ): Promise<string> => {
      const executionId = crypto.randomUUID().toLowerCase();
      const taskId = crypto.randomUUID().toLowerCase();
      const task = `history stream turn ${turn}`;
      const turnAt = new Date(Date.parse(createdAt) + turn * 1000).toISOString();
      const execution = {
        taskId,
        executionId,
        createdAt: turnAt,
        sessionCorrelation: initial.sessionId,
        canonicalSessionId: initial.sessionId,
        command: `history-stream-command-${turn}`,
        turn,
        task,
        baseStateRevision: turn,
        agent: 'default',
        model: ROOT_DEFAULT_MODEL_SELECTION,
        build: buildManifest(),
        configurationId: configuration.configurationId,
        configuration,
        maxSteps: 32,
      } as const;
      const messages = [user(task), assistant(assistantText)];
      await store.beginExecution({ ...execution, sessionMode: 'persistent' });
      if (turn === 1) {
        const call = { callId: 'write-original', name: 'write', arguments: writeArguments };
        const event = (
          sequence: number,
          value: Readonly<Record<string, unknown>>,
        ): ExecutionEventInput => ({
          executionId,
          direction: 'worker_to_host',
          source: 'worker',
          kind: 'runtime_event',
          workerSequence: sequence,
          payload: {
            kind: 'provider_observation',
            sequence,
            turn,
            correlation: {
              session: initial.sessionId,
              instanceCorrelation: 'stream-fixture',
              workerGeneration: 'stream-fixture',
              baseStateRevision: turn,
              command: execution.command,
            },
            observation: { kind: 'runtime_event', event: value },
          },
        } as ExecutionEventInput);
        store.appendExecutionEvents([
          event(1, {
            kind: 'model_result',
            result: { kind: 'tool_calls', calls: [call] },
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
          }),
          event(2, {
            kind: 'tool_call',
            call,
            callIndex: 0,
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
          }),
        ]);
      }
      store.commitCanonicalTurn({
        ...execution,
        messageSuffix: messages,
        updatedAt: turnAt,
        outcome: {
          ok: true,
          task,
          outcome: 'final',
          stopReason: 'final',
          finalText: assistantText,
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
        },
      });
      return executionId;
    };

    const firstText = `古いsnapshot🌿 ${'確認🌱'.repeat(55_000)}`;
    const firstExecutionId = await commitTurn(1, firstText);
    const expectedCanonicalBeforeWrite = renderCanonicalView(
      await store.readWorker(initial.sessionId),
      workspaceRoot,
    );
    data = await createDataService({ stateRoot, workspaceRoot });

    const stableCanonical = await data.historyStreamOpen({
      sessionRef: initial.sessionId,
      view: 'canonical',
    });
    strictEqual(stableCanonical.sessionId, initial.sessionId);
    const secondExecutionId = await commitTurn(2, '次のターン🌱');
    const canonicalText = await collect(data, stableCanonical.streamId);
    strictEqual(canonicalText, expectedCanonicalBeforeWrite);

    const sessionExpected = renderConversationTimeline(
      replaySessionConversation(
        initial.sessionId,
        store.readSessionConversationFacts(initial.sessionId),
        0,
        { includeFullText: true },
      ).state,
    );
    const detailExpected = [...store.streamHumanHistoryExport(initial.sessionId)]
      .map((record) => `${JSON.stringify(record)}\n`).join('');
    for (const view of ['session', 'detail'] as const) {
      const opened = await data.historyStreamOpen({
        sessionRef: initial.sessionId,
        view,
      });
      const rendered = await collect(data, opened.streamId);
      strictEqual(
        rendered,
        view === 'session' ? sessionExpected : detailExpected,
      );
    }
    ok(canonicalText.includes(firstText));
    ok(sessionExpected.includes(secondExecutionId));
    ok(
      sessionExpected.includes('tool> write folder/'),
      sessionExpected.split('\n').filter((line) => line.startsWith('tool>')).join('\n'),
    );
    const exportProjection = replaySessionConversation(
      initial.sessionId,
      store.readSessionConversationFacts(initial.sessionId),
      0,
      { includeFullText: true },
    ).state;
    const fullCalls = [...exportProjection.entities.values()].filter((entity) =>
      entity.kind === 'tool'
    );
    ok(fullCalls.length > 0);
    for (const call of fullCalls) {
      ok(call.kind === 'tool');
      deepStrictEqual(call.arguments, writeArguments);
      strictEqual(call.details, undefined);
    }
    ok(detailExpected.includes(firstText));

    const taskId = crypto.randomUUID().toLowerCase();
    activeExecutionId = crypto.randomUUID().toLowerCase();
    await store.beginExecution({
      taskId,
      executionId: activeExecutionId,
      createdAt: '2026-10-09T01:01:00.000Z',
      sessionCorrelation: initial.sessionId,
      canonicalSessionId: initial.sessionId,
      command: 'history-stream-still-active',
      turn: 3,
      task: 'keep running while history reader closes',
      baseStateRevision: 3,
      agent: 'default',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configurationId: configuration.configurationId,
      configuration,
      maxSteps: 32,
      sessionMode: 'persistent',
    });
    const interruptedReader = await data.historyStreamOpen({
      sessionRef: initial.sessionId,
      view: 'detail',
    });
    const firstChunk = await data.historyStreamRead(interruptedReader.streamId);
    ok(firstChunk.bytes.byteLength > 0);
    await data.historyStreamClose(interruptedReader.streamId);
    strictEqual(store.readExecution(activeExecutionId).lifecycle, 'active');

    const stableDetail = await data.historyStreamOpen({
      sessionRef: initial.sessionId,
      view: 'detail',
    });
    const beforeControlUpdate = await data.historyStreamRead(stableDetail.streamId);
    ok(!beforeControlUpdate.done);
    store.appendExecutionControlEvents([{
      executionId: activeExecutionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'acknowledgement_sent',
      payload: { accepted: true },
    }, {
      executionId: activeExecutionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'process_cleanup_finished',
      payload: { result: 'complete', controlSequence: 1 },
    }]);
    const stableText = await collect(data, stableDetail.streamId, [beforeControlUpdate.bytes]);
    const stableRecords = stableText
      .trim().split('\n').map((line) => JSON.parse(line));
    const stableExecution = stableRecords.find((record) =>
      record.kind === 'execution' && record.identity === activeExecutionId
    );
    ok(stableExecution);
    strictEqual(stableExecution.value.lifecycle, 'active');
    strictEqual(stableExecution.value.acknowledgement, 'not_sent');
    strictEqual(stableExecution.value.generationAvailability, 'unknown');
    const currentExecution = store.readExecution(activeExecutionId);
    strictEqual(currentExecution.acknowledgement, 'accepted_sent');
    strictEqual(currentExecution.generationAvailability, 'available');

    strictEqual(store.readExecution(firstExecutionId).outcome, 'completed');
    strictEqual(store.readExecution(secondExecutionId).outcome, 'completed');
    deepStrictEqual((await store.readWorker(initial.sessionId)).turnExecutions.length, 2);
  } finally {
    if (activeExecutionId !== undefined) {
      store.reconcileExecution({
        executionId: activeExecutionId,
        settlement: 'interrupted',
      });
    }
    await data?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
