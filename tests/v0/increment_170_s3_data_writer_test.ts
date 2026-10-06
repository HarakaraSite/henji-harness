import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import type { ProviderEvidenceRuntimeEvent } from '../../v0/agent/provider/provider_evidence.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { replaySessionConversation } from '../../v0/conversation/history_adapter.ts';
import {
  type ConversationEntity,
  orderedConversationEntities,
} from '../../v0/conversation/model.ts';
import {
  ConversationWriter,
  type ConversationWriterDelta,
} from '../../v0/agent/data/conversation_writer.ts';

const decode = (bytes: Uint8Array): {
  schemaVersion: number;
  sessionId: string;
  cut: number;
  storeRevision?: number;
  entities: Readonly<Record<string, ConversationEntity>>;
  order?: string[];
  changes?: readonly ({ kind: string; id?: string; entity?: ConversationEntity })[];
} => JSON.parse(new TextDecoder().decode(bytes));

const entitiesOf = (value: ReturnType<typeof decode>): ConversationEntity[] =>
  Object.values(value.entities);

const userMessage = (text: string) => ({
  role: 'user' as const,
  content: { kind: 'text' as const, text },
});

Deno.test('Increment 170 S3 Data writer commits, cuts, and watches one shared conversation state', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-s3-writer-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let handle: Awaited<ReturnType<typeof store.allocateWorker>> | undefined;
  let writer: ConversationWriter | undefined;
  try {
    await store.initialize();
    const configuration = workerConfigurationFixture();
    handle = await store.allocateWorker('default', {});
    const createdAt = '2026-10-02T00:00:00.000Z';
    const record: StoredSessionRecord = {
      schemaVersion: 1,
      sessionId: handle.id,
      workspaceRoot,
      agent: 'default',
      createdAt,
      updatedAt: createdAt,
      title: null,
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
      sessionId: record.sessionId,
      workspaceRoot: record.workspaceRoot,
      agentChoice: record.agentChoice,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      title: record.title,
      stateRevision: record.stateRevision,
      nextTurn: record.nextTurn,
      activeModel: record.activeModel,
      modelChangesToAppend: record.modelChanges,
    });
    handle.close();
    handle = undefined;

    const sessionId = record.sessionId;
    const initialRead = store.readSessionConversationFacts.bind(store);
    let rawSessionReads = 0;
    store.readSessionConversationFacts = (id) => {
      rawSessionReads += 1;
      return initialRead(id);
    };

    writer = new ConversationWriter(store);
    const notifications: ConversationWriterDelta[] = [];
    const watch = writer.watchSession(
      sessionId,
      (delta) => notifications.push(delta),
    );
    const initialSnapshot = decode(watch.snapshot.bytes);
    strictEqual(initialSnapshot.schemaVersion, 2);
    strictEqual(initialSnapshot.sessionId, sessionId);
    strictEqual(initialSnapshot.cut, 0);

    const executionId = '17000000-0000-4000-8000-000000000101';
    const execution = {
      taskId: '17000000-0000-4000-8000-000000000102',
      executionId,
      createdAt: '2026-10-02T00:00:01.000Z',
      sessionCorrelation: sessionId,
      canonicalSessionId: sessionId,
      turn: 1,
      task: 'Find the marker',
      baseStateRevision: 1,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configurationId: configuration.configurationId,
      configuration,
      maxSteps: 128,
      command: 'test-command',
    };
    const admission = await writer.beginExecution({
      ...execution,
      sessionMode: 'persistent',
    });
    strictEqual(admission.deltas.length, 1);
    strictEqual(admission.deltas[0].cut, 1);

    const correlation = {
      session: sessionId,
      instanceCorrelation: 'i170-s3-writer-instance',
      workerGeneration: 'i170-s3-writer-generation',
      baseStateRevision: 1,
      command: 'i170-s3-writer-task',
    };
    const provider = (
      sequence: number,
      event: ProviderEvidenceRuntimeEvent,
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
        observation: { kind: 'runtime_event', event },
      },
    } as ExecutionEventInput);
    const requestStart = (
      sequence: number,
      ordinal: number,
      modelStep: number,
    ): ExecutionEventInput => ({
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

    const firstAppend = writer.appendExecutionEvents([
      requestStart(1, 1, 1),
      provider(2, {
        kind: 'assistant_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        text: 'Checking the marker.',
      }),
      provider(3, {
        kind: 'assistant_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        text: 'The marker is in the report.',
      }),
    ]);
    strictEqual(firstAppend.result.length, 3);
    strictEqual(firstAppend.deltas.length, 1);
    strictEqual(firstAppend.deltas[0].cut, 2);
    const firstDelta = notifications.find((delta) => delta.cut === firstAppend.deltas[0].cut);
    ok(firstDelta);
    const firstChanges = decode(firstDelta.bytes).changes ?? [];
    const firstAssistantChanges = firstChanges.filter((change) =>
      change.kind === 'upsert' && change.entity?.kind === 'message' &&
      change.entity.role === 'assistant'
    );
    strictEqual(
      firstAssistantChanges.length,
      1,
      'one batch coalesces repeated entity values',
    );
    const afterProgress = decode(writer.snapshotSession(sessionId).bytes);
    const partial = entitiesOf(afterProgress).find((entity) =>
      entity.kind === 'message' && entity.role === 'assistant' &&
      entity.text === 'The marker is in the report.'
    );
    ok(partial?.kind === 'message');
    const partialPosition = partial.position;

    const secondAppend = writer.appendExecutionEvents([
      provider(4, {
        kind: 'model_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        result: {
          kind: 'tool_calls',
          text: 'The marker is in the report.',
          calls: [{
            callId: 'external-call-1',
            name: 'workspace/report-reader',
            arguments: { file: 'marker.txt' },
          }],
        },
      }),
      provider(5, {
        kind: 'tool_call',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        callIndex: 0,
        call: {
          callId: 'external-call-1',
          name: 'workspace/report-reader',
          arguments: { file: 'marker.txt' },
        },
      }),
      requestStart(6, 2, 1),
      provider(7, {
        kind: 'tool_progress',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        callIndex: 0,
        callId: 'external-call-1',
        name: 'workspace/report-reader',
        text: 'Reading marker.txt',
      }),
      provider(8, {
        kind: 'tool_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        callIndex: 0,
        result: {
          kind: 'tool_result',
          callId: 'external-call-1',
          name: 'workspace/report-reader',
          text: 'marker value is blue',
          outcome: 'success',
        },
      }),
      provider(9, {
        kind: 'model_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 2,
        result: { kind: 'final', text: 'The marker value is blue.' },
      }),
    ]);
    strictEqual(secondAppend.result.length, 6);
    strictEqual(secondAppend.deltas.length, 1);
    strictEqual(secondAppend.deltas[0].cut, 3);
    const afterTools = decode(writer.snapshotSession(sessionId).bytes);
    const finalFirstRequest = entitiesOf(afterTools).find((entity) =>
      entity.kind === 'message' && entity.role === 'assistant' &&
      entity.text === 'The marker is in the report.'
    );
    ok(finalFirstRequest?.kind === 'message');
    strictEqual(
      finalFirstRequest.id,
      partial.id,
      'partial and final text retain one identity',
    );
    deepStrictEqual(finalFirstRequest.position, partialPosition);
    const externalTool = entitiesOf(afterTools).find((entity) =>
      entity.kind === 'tool' && entity.callId === 'external-call-1'
    );
    ok(externalTool?.kind === 'tool');
    strictEqual(externalTool.name, 'workspace/report-reader');
    strictEqual(externalTool.started, true);
    strictEqual(externalTool.progress, 'Reading marker.txt');
    strictEqual(externalTool.result?.text, 'marker value is blue');
    strictEqual(externalTool.requestKey.requestOrdinal, 1);
    ok(externalTool.declarationOccurrenceId !== undefined);
    ok(externalTool.semanticOccurrenceId !== undefined);

    const terminal = writer.settleNonCanonicalExecution({
      ...execution,
      outcome: {
        ok: false,
        task: execution.task,
        outcome: 'cancelled',
        stopReason: 'cancelled',
        steps: 1,
        toolCallCount: 1,
        toolResultCount: 1,
      },
      messageSuffix: [userMessage(execution.task)],
    });
    strictEqual(terminal.deltas.length, 1);
    strictEqual(terminal.deltas[0].cut, 4);
    ok(terminal.result.commitDelta !== undefined);
    const afterTerminal = decode(writer.snapshotSession(sessionId).bytes);
    const settled = entitiesOf(afterTerminal).find((entity) =>
      entity.kind === 'execution' && entity.executionId === executionId
    );
    ok(settled?.kind === 'execution');
    strictEqual(settled.execution.lifecycle, 'settled');
    strictEqual(settled.execution.outcome, 'cancelled');
    strictEqual(settled.execution.adoption, 'non_canonical');
    strictEqual(
      settled.execution.terminalSemanticOccurrenceId,
      terminal.result.commitDelta.terminalSemanticOccurrenceId,
    );

    const nextExecutionId = '17000000-0000-4000-8000-000000000103';
    const nextInput = {
      ...execution,
      executionId: nextExecutionId,
      taskId: '17000000-0000-4000-8000-000000000104',
      createdAt: '2026-10-02T00:00:02.000Z',
      task: 'Continue after cancellation',
    };
    const nextAdmission = await writer.beginExecution({
      ...nextInput,
      sessionMode: 'persistent',
    });
    strictEqual(nextAdmission.deltas[0].cut, 5);
    const nextCorrelation = {
      ...correlation,
      command: 'i170-s3-writer-next-task',
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
    const nextAppend = writer.appendExecutionEvents([
      requestStartFor(nextExecutionId, nextCorrelation, 1, 1, 1),
      nextProvider(2, {
        kind: 'model_result',
        modelStep: 1,
        lane: 'parent',
        requestOrdinal: 1,
        result: { kind: 'final', text: 'The follow-up is saved.' },
      }),
    ]);
    strictEqual(nextAppend.deltas.length, 1);
    strictEqual(nextAppend.deltas[0].cut, 6);

    const canonicalTranscript = [
      userMessage(nextInput.task),
      {
        role: 'assistant' as const,
        content: { kind: 'text' as const, text: 'The follow-up is saved.' },
      },
    ];
    const committedRecord: StoredSessionRecord = {
      ...record,
      updatedAt: nextInput.createdAt,
      stateRevision: 2,
      nextTurn: 2,
      transcript: canonicalTranscript,
      turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
      turnExecutions: [{
        turn: 1,
        executionId: nextExecutionId,
        build: buildManifest(),
        configurationId: configuration.configurationId,
      }],
    };
    const canonical = writer.commitCanonicalTurn({
      ...nextInput,
      messageSuffix: canonicalTranscript.slice(record.transcript.length),
      updatedAt: committedRecord.updatedAt,
      outcome: {
        ok: true,
        task: nextInput.task,
        outcome: 'final',
        stopReason: 'final',
        finalText: 'The follow-up is saved.',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
      },
    });
    strictEqual(canonical.deltas.length, 1);
    strictEqual(canonical.deltas[0].cut, 7);
    strictEqual(canonical.result.commitDelta?.committedRevision, 2);

    const snapshot = decode(writer.snapshotSession(sessionId).bytes);
    strictEqual(snapshot.cut, 7);
    strictEqual(snapshot.storeRevision, 2);
    const executions = entitiesOf(snapshot).filter((entity) => entity.kind === 'execution');
    strictEqual(executions.length, 2);
    const firstOrder = snapshot.order!.indexOf(
      `execution/${encodeURIComponent(executionId)}`,
    );
    const nextOrder = snapshot.order!.indexOf(
      `execution/${encodeURIComponent(nextExecutionId)}`,
    );
    ok(
      firstOrder >= 0 && nextOrder > firstOrder,
      'the follow-up execution remains after the first',
    );
    deepStrictEqual(notifications.map((delta) => delta.cut), [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
    ]);
    strictEqual(
      notifications.length,
      7,
      'each saved batch has one watch notification',
    );
    strictEqual(
      rawSessionReads,
      1,
      'live writes reuse the one initial raw replay',
    );
    strictEqual(
      watch.snapshot.cut,
      0,
      'the initial cut stays paired with its snapshot',
    );

    const replay = replaySessionConversation(sessionId, initialRead(sessionId));
    deepStrictEqual(
      entitiesOf(snapshot),
      orderedConversationEntities(replay.state),
    );
    watch.unsubscribe();
    strictEqual(notifications.length, 7);
  } finally {
    writer?.close();
    handle?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 170 S3 Data writer notifies each affected Session once for a shared append batch', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i170-s3-multi-session-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let writer: ConversationWriter | undefined;
  const handles: Awaited<ReturnType<typeof store.allocateWorker>>[] = [];
  try {
    await store.initialize();
    const configuration = workerConfigurationFixture();
    const createdAt = '2026-10-02T00:00:00.000Z';
    const createSession = async (suffix: string) => {
      const handle = await store.allocateWorker('default', {});
      handles.push(handle);
      const record: StoredSessionRecord = {
        schemaVersion: 1,
        sessionId: handle.id,
        workspaceRoot,
        agent: 'default',
        createdAt,
        updatedAt: createdAt,
        title: null,
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
        sessionId: record.sessionId,
        workspaceRoot: record.workspaceRoot,
        agentChoice: record.agentChoice,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        title: record.title,
        stateRevision: record.stateRevision,
        nextTurn: record.nextTurn,
        activeModel: record.activeModel,
        modelChangesToAppend: record.modelChanges,
      });
      handle.close();
      return {
        sessionId: handle.id,
        executionId: `17000000-0000-4000-8000-00000000020${suffix}`,
        taskId: `17000000-0000-4000-8000-00000000030${suffix}`,
      };
    };
    const first = await createSession('1');
    const second = await createSession('2');
    writer = new ConversationWriter(store);
    const firstNotifications: ConversationWriterDelta[] = [];
    const secondNotifications: ConversationWriterDelta[] = [];
    const firstWatch = writer.watchSession(
      first.sessionId,
      (delta) => firstNotifications.push(delta),
    );
    const secondWatch = writer.watchSession(
      second.sessionId,
      (delta) => secondNotifications.push(delta),
    );

    const makeExecution = (session: typeof first, order: number) => ({
      taskId: session.taskId,
      executionId: session.executionId,
      createdAt: `2026-10-02T00:00:0${order}.000Z`,
      sessionCorrelation: session.sessionId,
      canonicalSessionId: session.sessionId,
      turn: 1,
      task: `task ${order}`,
      baseStateRevision: 1,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configurationId: configuration.configurationId,
      configuration,
      maxSteps: 128,
      command: 'test-command',
    });
    await writer.beginExecution({
      ...makeExecution(first, 1),
      sessionMode: 'persistent',
    });
    await writer.beginExecution({
      ...makeExecution(second, 2),
      sessionMode: 'persistent',
    });

    const correlation = (sessionId: string, command: string) => ({
      session: sessionId,
      instanceCorrelation: `instance-${command}`,
      workerGeneration: `generation-${command}`,
      baseStateRevision: 1,
      command,
    });
    const batch = writer.appendExecutionEvents([
      requestStartFor(
        first.executionId,
        correlation(first.sessionId, 'first'),
        1,
        1,
        1,
      ),
      requestStartFor(
        second.executionId,
        correlation(second.sessionId, 'second'),
        1,
        1,
        1,
      ),
    ]);
    strictEqual(batch.result.length, 2);
    strictEqual(batch.deltas.length, 2);
    deepStrictEqual(
      new Set(batch.deltas.map((delta) => delta.sessionId)),
      new Set([first.sessionId, second.sessionId]),
    );
    strictEqual(firstNotifications.length, 2);
    strictEqual(secondNotifications.length, 2);
    deepStrictEqual(firstNotifications.map((delta) => delta.cut), [1, 2]);
    deepStrictEqual(secondNotifications.map((delta) => delta.cut), [1, 2]);
    strictEqual(decode(firstWatch.snapshot.bytes).cut, 0);
    strictEqual(decode(secondWatch.snapshot.bytes).cut, 0);
    strictEqual(decode(writer.snapshotSession(first.sessionId).bytes).cut, 2);
    strictEqual(decode(writer.snapshotSession(second.sessionId).bytes).cut, 2);
    firstWatch.unsubscribe();
    secondWatch.unsubscribe();
  } finally {
    writer?.close();
    for (const handle of handles) handle.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

const requestStartFor = (
  executionId: string,
  correlation: Readonly<Record<string, string | number>>,
  sequence: number,
  ordinal: number,
  modelStep: number,
): ExecutionEventInput => ({
  executionId,
  direction: 'worker_to_host',
  source: 'worker',
  kind: 'provider_request_start',
  workerSequence: sequence,
  payload: {
    kind: 'provider_observation',
    correlation: correlation as never,
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

Deno.test('Increment 170 admission keeps a watch registered while SQLite admission is pending', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-pending-watch-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(
    `${root}/state`,
    workspaceRoot,
  );
  const writer = new ConversationWriter(store);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => entered = resolve);
  const gate = new Promise<void>((resolve) => release = resolve);
  const originalBegin = store.beginExecution.bind(store);
  store.beginExecution = async (input) => {
    entered();
    await gate;
    await originalBegin(input);
  };
  try {
    await store.initialize();
    const sessionId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const configuration = workerConfigurationFixture();
    const input = {
      sessionMode: 'no_session' as const,
      sessionCorrelation: sessionId,
      executionId,
      taskId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      turn: 1,
      task: 'Observe pending admission',
      baseStateRevision: 1,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: 'test-command',
    };
    const admission = writer.beginExecution(input);
    await pending;
    const notifications: ConversationWriterDelta[] = [];
    const watch = writer.watchSession(
      sessionId,
      (delta) => notifications.push(delta),
    );
    strictEqual(Object.keys(decode(watch.snapshot.bytes).entities).length, 0);
    release();
    await admission;
    strictEqual(notifications.length, 1);
    strictEqual(notifications[0].cut, watch.snapshot.cut + 1);
    ok(
      decode(notifications[0].bytes).changes?.some((change) =>
        change.entity?.kind === 'execution' &&
        change.entity.executionId === executionId
      ),
    );
    writer.reconcileExecution({ executionId, settlement: 'interrupted' });
    strictEqual(notifications.length, 2);
    strictEqual(notifications[1].cut, notifications[0].cut + 1);
    watch.unsubscribe();
  } finally {
    release();
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
