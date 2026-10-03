import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import type {
  ExecutionEventInput,
  HistoryAppendResult,
  StoredExecutionEvent,
} from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import { renderConversationTimeline } from '../../v0/agent/history/history_view.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { ProviderEvidenceRuntimeEvent } from '../../v0/agent/provider/provider_evidence.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import {
  applyHistoryAppendResults,
  applyHistoryCommitDelta,
  historyExecutionMetadata,
  observationsFromAppendResults,
  replaySessionConversation,
} from '../../v0/conversation/history_adapter.ts';
import {
  applyObservation,
  createConversationNormalizer,
} from '../../v0/conversation/normalizer.ts';
import {
  createConversationState,
  orderedConversationEntities,
} from '../../v0/conversation/model.ts';

const findAssistant = (state: ReturnType<typeof createConversationState>, text: string) =>
  orderedConversationEntities(state).find((entity) =>
    entity.kind === 'message' && entity.role === 'assistant' && entity.text === text
  );

Deno.test('Increment 170 S1 save facts and first history replay share the conversation engine', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-s1-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  let handle: Awaited<ReturnType<typeof store.allocateWorker>> | undefined;
  try {
    await store.initialize();
    const definition = await builtinDefinitionRef('default', buildManifest());
    handle = await store.allocateWorker('default', definition);
    const createdAt = '2026-10-02T00:00:00.000Z';
    const record: StoredSessionRecord = {
      schemaVersion: 6,
      sessionId: handle.id,
      workspaceRoot,
      agent: 'default',
      createdAt,
      updatedAt: createdAt,
      title: null,
      stateRevision: 1,
      nextTurn: 1,
      transcript: [],
      definition,
      activeModel: ROOT_DEFAULT_MODEL_SELECTION,
      modelChanges: [{
        effectiveFromTurn: 1,
        changedAt: createdAt,
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      }],
      turnModels: [],
      turnExecutions: [],
    };
    handle.commit(record);
    handle.close();
    handle = undefined;

    const sessionId = record.sessionId;
    const executionId = '17000000-0000-4000-8000-000000000001';
    const taskId = '17000000-0000-4000-8000-000000000002';
    const input = {
      taskId,
      executionId,
      createdAt,
      sessionCorrelation: sessionId,
      canonicalSessionId: sessionId,
      turn: 1,
      task: 'look up the marker',
      baseStateRevision: record.stateRevision,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      definition,
    };
    await store.beginExecution({ ...input, sessionMode: 'persistent' });

    const state = createConversationState(sessionId);
    const normalizer = createConversationNormalizer();
    applyObservation(state, normalizer, {
      kind: 'execution',
      execution: historyExecutionMetadata(store.readExecution(executionId)),
      executionOrder: 0,
    });

    const correlation = {
      session: sessionId,
      instanceCorrelation: 'i170-s1-instance',
      workerGeneration: 'i170-s1-generation',
      baseStateRevision: record.stateRevision,
      command: 'i170-s1-task',
    };
    const provider = (
      sequence: number,
      event: ProviderEvidenceRuntimeEvent,
      turn = 1,
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
        turn,
        observation: { kind: 'runtime_event', event },
      },
    } as ExecutionEventInput);
    const agent = (sequence: number, event: AgentEvent): ExecutionEventInput => ({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: sequence,
      payload: {
        kind: 'runtime_event',
        correlation,
        sequence,
        event: { kind: 'agent_event', event },
      },
    } as ExecutionEventInput);
    const requestStart = (sequence: number, ordinal: number, modelStep: number) => ({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_request_start',
      workerSequence: sequence,
      payload: {
        kind: 'provider_observation',
        correlation,
        sequence,
        turn: 1,
        observation: {
          kind: 'request_start',
          request: {
            ordinal,
            lane: 'parent',
            modelStep,
            endpoint: 'https://provider.invalid/chat',
            method: 'POST',
            requestMetadata: {
              provider: 'test-provider',
              modelId: 'test-model',
              api: 'openai-chat-completions',
            },
          },
        },
      },
    } as ExecutionEventInput);

    const firstAppend = store.appendExecutionEventsWithSemanticIds([
      requestStart(1, 1, 1),
      agent(2, {
        kind: 'assistant_thinking',
        turn: 1,
        modelStep: 1,
        thinkingKind: 'text',
        text: 'Need the marker.',
        complete: false,
      }),
      agent(3, {
        kind: 'assistant_thinking',
        turn: 1,
        modelStep: 1,
        thinkingKind: 'text',
        text: 'Checked the marker.',
        complete: true,
      }),
      {
        executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'steer_requested',
        payload: { text: 'Use the marker.' },
      },
      {
        executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'steer_sent',
        payload: { text: 'Use the marker.' },
      },
      agent(4, {
        kind: 'steering_message',
        turn: 1,
        message: { role: 'user', content: { kind: 'text', text: 'Use the marker.' } },
      }),
      provider(5, {
        kind: 'assistant_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        text: 'Looking up the marker.',
      }),
    ]);
    applyHistoryAppendResults(state, normalizer, firstAppend);
    const partialAssistantId = findAssistant(state, 'Looking up the marker.')?.id;
    ok(partialAssistantId !== undefined);

    const declarationAppend = store.appendExecutionEventsWithSemanticIds([
      provider(6, {
        kind: 'model_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        result: {
          kind: 'tool_calls',
          text: 'Looking up the marker.',
          calls: [
            { callId: 'call-1', name: 'lookup', arguments: { key: 'marker' } },
            { callId: 'call-2', name: 'read_file', arguments: { path: 'notes.txt' } },
            { callId: 'call-3', name: 'search', arguments: { query: 'marker' } },
          ],
        },
      }),
    ]);
    applyHistoryAppendResults(state, normalizer, declarationAppend);
    const declaredToolBeforeStart = orderedConversationEntities(state).find((entity) =>
      entity.kind === 'tool' && entity.callId === 'call-1'
    );
    ok(declaredToolBeforeStart?.kind === 'tool');

    const startedToolAppend = store.appendExecutionEventsWithSemanticIds([
      provider(7, {
        kind: 'tool_call',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        call: { callId: 'call-1', name: 'lookup', arguments: { key: 'marker' } },
      } as unknown as ProviderEvidenceRuntimeEvent),
      requestStart(8, 2, 1),
      provider(9, {
        kind: 'tool_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        callId: 'call-1',
        name: 'lookup',
        text: 'reading',
      } as unknown as ProviderEvidenceRuntimeEvent),
      provider(10, {
        kind: 'tool_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        result: {
          kind: 'tool_result',
          callId: 'call-1',
          name: 'lookup',
          text: 'blue',
          outcome: 'success',
        },
      } as unknown as ProviderEvidenceRuntimeEvent),
      provider(11, {
        kind: 'tool_call',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        call: { callId: 'generic-call', name: 'external_tool', arguments: { file: 'x' } },
      } as unknown as ProviderEvidenceRuntimeEvent),
      provider(12, {
        kind: 'tool_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        callId: 'generic-call',
        name: 'external_tool',
        text: 'reading x',
      } as unknown as ProviderEvidenceRuntimeEvent),
      provider(13, {
        kind: 'tool_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        result: {
          kind: 'tool_result',
          callId: 'generic-call',
          name: 'external_tool',
          text: 'found x',
          outcome: 'success',
        },
      } as unknown as ProviderEvidenceRuntimeEvent),
      requestStart(14, 3, 2),
      provider(15, {
        kind: 'assistant_progress',
        modelStep: 2,
        lane: 'parent',
        requestOrdinal: 3,
        text: 'The marker starts with blue.',
      }),
    ]);
    applyHistoryAppendResults(state, normalizer, startedToolAppend);
    strictEqual(findAssistant(state, 'Looking up the marker.')?.id, partialAssistantId);
    const declaredTools = orderedConversationEntities(state).filter((entity) =>
      entity.kind === 'tool'
    );
    strictEqual(declaredTools.length, 4);
    const waitingTools = declaredTools.filter((entity) =>
      entity.kind === 'tool' && !entity.started
    );
    strictEqual(waitingTools.length, 2);
    strictEqual(waitingTools.every((entity) => entity.semanticOccurrenceId === undefined), true);
    strictEqual(
      declaredTools.filter((entity) => entity.kind === 'tool' && entity.started).length,
      2,
    );

    const partial = 'The marker says blue.';
    const secondAppend = store.appendExecutionEventsWithSemanticIds([
      provider(16, {
        kind: 'assistant_progress',
        modelStep: 2,
        lane: 'parent',
        requestOrdinal: 3,
        text: partial,
      }),
      provider(17, {
        kind: 'assistant_progress',
        modelStep: 2,
        lane: 'parent',
        requestOrdinal: 3,
        text: 'The marker says blue, which answers the question.',
      }),
      provider(18, {
        kind: 'model_result',
        modelStep: 2,
        lane: 'parent',
        requestOrdinal: 3,
        result: { kind: 'final', text: 'The marker says blue, which answers the question.' },
      }),
      requestStart(19, 4, 3),
      provider(20, {
        kind: 'assistant_progress',
        modelStep: 3,
        lane: 'parent',
        requestOrdinal: 4,
        text: 'A response that will be interrupted.',
      }),
      provider(21, {
        kind: 'assistant_progress',
        modelStep: 3,
        lane: 'parent',
        requestOrdinal: 4,
        text: 'A response still in progress.',
      }),
    ]);
    applyHistoryAppendResults(state, normalizer, secondAppend);
    const finishedId = findAssistant(state, 'The marker says blue, which answers the question.')
      ?.id;
    ok(finishedId !== undefined);
    strictEqual(findAssistant(state, 'Looking up the marker.')?.id, partialAssistantId);

    const outcome = {
      ok: false as const,
      task: input.task,
      outcome: 'cancelled' as const,
      stopReason: 'cancelled' as const,
      steps: 3,
      toolCallCount: 1,
      toolResultCount: 1,
      transcript: [{ role: 'user' as const, content: { kind: 'text' as const, text: input.task } }],
    };
    const terminal = store.settleNonCanonicalExecution({
      ...input,
      outcome,
    });
    ok(terminal.commitDelta !== undefined);
    const delta = terminal.commitDelta!;
    strictEqual(
      delta.occurrences.length,
      2,
      'terminal COMMIT returns flushed text and terminal facts',
    );
    applyHistoryCommitDelta(state, normalizer, delta);
    const settledExecution = orderedConversationEntities(state).find((entity) =>
      entity.kind === 'execution' && entity.executionId === executionId
    );
    ok(settledExecution?.kind === 'execution');
    strictEqual(
      settledExecution.execution.terminalSemanticOccurrenceId,
      delta.terminalSemanticOccurrenceId,
    );

    const beforeReplay = orderedConversationEntities(state);
    const replay = replaySessionConversation(
      sessionId,
      store.readSessionConversationFacts(sessionId),
    );
    deepStrictEqual(orderedConversationEntities(replay.state), beforeReplay);
    strictEqual(
      findAssistant(state, 'The marker says blue, which answers the question.')?.id,
      finishedId,
    );
    strictEqual(findAssistant(state, 'A response still in progress.')?.kind, 'message');
    const thinking = orderedConversationEntities(state).filter((entity) =>
      entity.kind === 'thinking'
    );
    strictEqual(thinking.length, 1);
    if (thinking[0]?.kind === 'thinking') {
      strictEqual(thinking[0].text, 'Checked the marker.');
      strictEqual(thinking[0].complete, true);
    }
    const tools = orderedConversationEntities(state).filter((entity) => entity.kind === 'tool');
    strictEqual(tools.length, 4);
    const completedTool = tools.find((entity) =>
      entity.kind === 'tool' && entity.callId === 'call-1'
    );
    if (completedTool?.kind === 'tool') {
      strictEqual(completedTool.started, true);
      strictEqual(completedTool.result?.text, 'blue');
      strictEqual(completedTool.progress, 'reading');
      strictEqual(completedTool.callIndex, 0);
      strictEqual(completedTool.requestKey.requestOrdinal, 1);
      strictEqual(
        completedTool.position.requestOrder,
        declaredToolBeforeStart.position.requestOrder,
      );
      deepStrictEqual(completedTool.arguments, { key: 'marker' });
    }
    const genericTool = tools.find((entity) =>
      entity.kind === 'tool' && entity.callId === 'generic-call'
    );
    ok(genericTool?.kind === 'tool');
    strictEqual(genericTool.name, 'external_tool');
    deepStrictEqual(genericTool.arguments, { file: 'x' });
    strictEqual(genericTool.requestKey.requestOrdinal, 1);
    strictEqual(genericTool.progress, 'reading x');
    strictEqual(genericTool.result?.text, 'found x');
    const appliedSteering = orderedConversationEntities(state).filter((entity) =>
      entity.kind === 'message' && entity.role === 'user' && entity.text === 'Use the marker.'
    );
    strictEqual(appliedSteering.length, 1);
    strictEqual(
      renderConversationTimeline(state).includes('assistant note> Looking up the marker.'),
      true,
    );
    strictEqual(renderConversationTimeline(state).includes('thinking> Checked the marker.'), true);
    strictEqual(
      renderConversationTimeline(state).includes('assistant~ A response still in progress.'),
      true,
    );
    strictEqual(renderConversationTimeline(state).includes('tool> lookup ✓'), true);

    const nextExecutionId = '17000000-0000-4000-8000-000000000003';
    const nextInput = {
      ...input,
      executionId: nextExecutionId,
      taskId: '17000000-0000-4000-8000-000000000004',
      createdAt: '2026-10-02T00:00:01.000Z',
      turn: 1,
      task: 'continue after replay',
      baseStateRevision: record.stateRevision,
    };
    await store.beginExecution({ ...nextInput, sessionMode: 'persistent' });
    applyObservation(replay.state, replay.normalizer, {
      kind: 'execution',
      execution: historyExecutionMetadata(store.readExecution(nextExecutionId)),
      executionOrder: 1,
    });
    const nextCorrelation = { ...correlation, command: 'i170-s1-follow-up' };
    const nextRequestStart: ExecutionEventInput = {
      executionId: nextExecutionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_request_start',
      workerSequence: 1,
      payload: {
        kind: 'provider_observation',
        correlation: nextCorrelation,
        sequence: 1,
        turn: 1,
        observation: {
          kind: 'request_start',
          request: {
            ordinal: 1,
            lane: 'parent',
            modelStep: 1,
            endpoint: 'https://provider.invalid/chat',
            method: 'POST',
            requestMetadata: {
              provider: 'test-provider',
              modelId: 'test-model',
              api: 'openai-chat-completions',
            },
          },
        },
      },
    };
    const nextProvider = (
      sequence: number,
      event: ProviderEvidenceRuntimeEvent,
    ): ExecutionEventInput => ({
      executionId: nextExecutionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: sequence,
      payload: {
        kind: 'provider_observation',
        correlation: nextCorrelation,
        sequence,
        turn: 1,
        observation: { kind: 'runtime_event', event },
      },
    } as ExecutionEventInput);
    const nextAppend = store.appendExecutionEventsWithSemanticIds([
      nextRequestStart,
      nextProvider(2, {
        kind: 'assistant_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        text: 'Follow-up persisted in history.',
      }),
      nextProvider(3, {
        kind: 'model_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        result: { kind: 'final', text: 'Follow-up persisted in history.' },
      }),
    ]);
    applyHistoryAppendResults(replay.state, replay.normalizer, nextAppend);
    const nextTranscript = [
      ...record.transcript,
      { role: 'user' as const, content: { kind: 'text' as const, text: nextInput.task } },
      {
        role: 'assistant' as const,
        content: { kind: 'text' as const, text: 'Follow-up persisted in history.' },
      },
    ];
    const committedRecord: StoredSessionRecord = {
      ...record,
      updatedAt: nextInput.createdAt,
      stateRevision: record.stateRevision + 1,
      nextTurn: 2,
      transcript: nextTranscript,
      turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
      turnExecutions: [{ turn: 1, build: buildManifest(), definition }],
    };
    const committed = store.commitCanonicalTurn({
      ...nextInput,
      record: committedRecord,
      outcome: {
        ok: true,
        task: nextInput.task,
        outcome: 'final',
        stopReason: 'final',
        finalText: 'Follow-up persisted in history.',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: nextTranscript,
      },
    });
    ok(committed.commitDelta !== undefined);
    strictEqual(committed.commitDelta?.committedRevision, committedRecord.stateRevision);
    applyHistoryCommitDelta(replay.state, replay.normalizer, committed.commitDelta!);
    const continuedReplay = replaySessionConversation(
      sessionId,
      store.readSessionConversationFacts(sessionId),
    );
    deepStrictEqual(
      orderedConversationEntities(continuedReplay.state),
      orderedConversationEntities(replay.state),
    );
    strictEqual(
      orderedConversationEntities(replay.state).some((entity) =>
        entity.kind === 'message' && entity.text === 'continue after replay'
      ),
      true,
    );

    const reconciledExecutionId = '17000000-0000-4000-8000-000000000005';
    const reconcileInput = {
      ...nextInput,
      executionId: reconciledExecutionId,
      taskId: '17000000-0000-4000-8000-000000000006',
      createdAt: '2026-10-02T00:00:02.000Z',
      turn: 2,
      task: 'reconcile after partial text',
      baseStateRevision: committedRecord.stateRevision,
    };
    await store.beginExecution({ ...reconcileInput, sessionMode: 'persistent' });
    applyObservation(continuedReplay.state, continuedReplay.normalizer, {
      kind: 'execution',
      execution: historyExecutionMetadata(store.readExecution(reconciledExecutionId)),
      executionOrder: 2,
    });
    const reconcileCorrelation = {
      ...nextCorrelation,
      baseStateRevision: committedRecord.stateRevision,
      command: 'i170-s1-reconcile',
    };
    const reconcileAppend = store.appendExecutionEventsWithSemanticIds([
      {
        executionId: reconciledExecutionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'provider_request_start',
        workerSequence: 1,
        payload: {
          kind: 'provider_observation',
          correlation: reconcileCorrelation,
          sequence: 1,
          turn: 2,
          observation: {
            kind: 'request_start',
            request: {
              ordinal: 1,
              lane: 'parent',
              modelStep: 1,
              endpoint: 'https://provider.invalid/chat',
              method: 'POST',
              requestMetadata: {
                provider: 'test-provider',
                modelId: 'test-model',
                api: 'openai-chat-completions',
              },
            },
          },
        },
      },
      {
        executionId: reconciledExecutionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: 2,
        payload: {
          kind: 'provider_observation',
          correlation: reconcileCorrelation,
          sequence: 2,
          turn: 2,
          observation: {
            kind: 'runtime_event',
            event: {
              kind: 'assistant_progress',
              modelStep: 1,
              lane: 'parent',
              requestOrdinal: 1,
              text: 'Saved before recovery.',
            },
          },
        },
      } as ExecutionEventInput,
    ]);
    applyHistoryAppendResults(
      continuedReplay.state,
      continuedReplay.normalizer,
      reconcileAppend,
    );
    const reconciliation = store.reconcileExecution({
      executionId: reconciledExecutionId,
      settlement: 'interrupted',
      settledAt: '2026-10-02T00:00:03.000Z',
    });
    ok(reconciliation !== undefined);
    strictEqual(reconciliation.occurrences.length, 2);
    applyHistoryCommitDelta(
      continuedReplay.state,
      continuedReplay.normalizer,
      reconciliation,
    );
    const reconciledReplay = replaySessionConversation(
      sessionId,
      store.readSessionConversationFacts(sessionId),
    );
    deepStrictEqual(
      orderedConversationEntities(reconciledReplay.state),
      orderedConversationEntities(continuedReplay.state),
    );

    const noTextInput = provider(99, {
      kind: 'model_result',
      modelStep: 4,
      lane: 'parent',
      requestOrdinal: 4,
      result: {
        kind: 'tool_calls',
        calls: [{ callId: 'declared-only', name: 'search', arguments: { query: 'marker' } }],
      },
    });
    const noTextAppendResult: HistoryAppendResult = {
      event: {
        ...noTextInput,
        ordinal: 99,
        observedAt: createdAt,
      } as StoredExecutionEvent,
      semanticOccurrenceId: `${executionId}:semantic:no-text-declaration`,
    };
    const noTextState = createConversationState(sessionId);
    const noTextNormalizer = createConversationNormalizer();
    for (const observation of observationsFromAppendResults([noTextAppendResult])) {
      applyObservation(noTextState, noTextNormalizer, observation);
    }
    const noTextTool = orderedConversationEntities(noTextState).find((entity) =>
      entity.kind === 'tool' && entity.callId === 'declared-only'
    );
    ok(noTextTool?.kind === 'tool');
    strictEqual(noTextTool.started, false);
    strictEqual(noTextTool.semanticOccurrenceId, undefined);
  } finally {
    handle?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
