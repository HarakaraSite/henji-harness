import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import type { LoopOutcome, Message } from '../../v0/agent/core/contracts.ts';
import {
  contextDigest,
  type ContextModelRequestDelta,
  contextOccurrenceDigest,
  type ContextOccurrenceInput,
  contextRevisionDigest,
  createExecutionContextManifest,
} from '../../v0/agent/history/context_attribution.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { workspaceDigest } from '../../v0/agent/session/session_store_paths.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const timestamp = '2026-10-04T00:00:00.000Z';

const makeSessionRecord = (
  sessionId: string,
  workspaceRoot: string,
): StoredSessionRecord => ({
  schemaVersion: 1,
  sessionId,
  workspaceRoot,
  agent: 'generic',
  agentChoice: { name: 'generic' },
  createdAt: timestamp,
  updatedAt: timestamp,
  title: null,
  stateRevision: 1,
  nextTurn: 1,
  transcript: [],
  activeModel: ROOT_DEFAULT_MODEL_SELECTION,
  modelChanges: [{
    effectiveFromTurn: 1,
    changedAt: timestamp,
    selection: ROOT_DEFAULT_MODEL_SELECTION,
  }],
  turnModels: [],
  turnExecutions: [],
});

const userMessage = (text: string): Message => ({
  role: 'user',
  content: { kind: 'text', text },
});

const assistantMessage = (text: string): Message => ({
  role: 'assistant',
  content: { kind: 'text', text },
});

const successfulOutcome = (
  task: string,
  transcript: readonly Message[],
): LoopOutcome => ({
  ok: true,
  task,
  outcome: 'final',
  stopReason: 'final',
  finalText: 'Saved answer',
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript,
});

Deno.test('Increment 181 production store settles canonical and detached executions from schema-v1 rows', async () => {
  const root = await Deno.makeTempDir({ prefix: 'increment-181-store-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const workspaceState = `${stateRoot}/${await workspaceDigest(workspaceRoot)}`;
  await Deno.mkdir(workspaceState, { recursive: true });
  await Deno.chmod(workspaceState, 0o700);
  const oldDbPath = `${workspaceState}/history-v7.sqlite3`;
  const oldDbSentinel = 'preserve existing v7 bytes exactly';
  await Deno.writeTextFile(oldDbPath, oldDbSentinel);

  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let handle: Awaited<ReturnType<typeof store.allocateWorker>> | undefined;
  try {
    await store.initialize();
    handle = await store.allocateWorker('generic', { name: 'generic' });
    // The allocated id is the persistent Session identity used by the real store.
    const initial = {
      ...makeSessionRecord(handle.id, workspaceRoot),
      sessionId: handle.id,
    };
    const build = buildManifest();
    const firstConfiguration = workerConfigurationFixture({
      systemInstruction: 'Original instruction at revision one.',
    });
    const secondConfiguration = workerConfigurationFixture({
      systemInstruction: 'Changed instruction at the same revision.',
    });
    strictEqual(
      firstConfiguration.agent.revision,
      secondConfiguration.agent.revision,
    );
    ok(
      firstConfiguration.configurationId !==
        secondConfiguration.configurationId,
    );
    const firstExecutionId = '18100000-0000-4000-8000-000000000101';
    const firstTask = 'Save the first answer';
    const firstCorrelation = {
      session: handle.id,
      instanceCorrelation: '181-instance-first',
      workerGeneration: '181-generation-first',
      baseStateRevision: 1,
      command: '181-command-first',
    };
    const messages = [userMessage(firstTask), assistantMessage('Saved answer')];

    const contextBytes = new TextEncoder().encode(
      JSON.stringify(userMessage(firstTask)),
    );
    const contentDigest = await contextDigest(contextBytes);
    const partialOccurrence = {
      occurrenceId: '181-context-message-1',
      kind: 'message' as const,
      content: {
        digest: contentDigest,
        byteLength: contextBytes.byteLength,
        mediaType: 'application/vnd.henji.message+json' as const,
      },
      sourceRelations: [{
        stage: 'projected' as const,
        resourceKind: 'message' as const,
        logicalIdentity: 'current-task:turn-1',
        lane: 'parent' as const,
        modelStep: 1,
      }],
      bytesBase64: contextBytes.toBase64(),
    };
    const contextOccurrence: ContextOccurrenceInput = {
      ...partialOccurrence,
      occurrenceDigest: await contextOccurrenceDigest(partialOccurrence),
    };
    const splices = [{
      start: 0,
      deleteCount: 0,
      insertions: [{
        occurrenceId: contextOccurrence.occurrenceId,
        occurrenceDigest: contextOccurrence.occurrenceDigest,
      }],
    }];
    const revisionDigest = await contextRevisionDigest({
      lane: 'parent',
      purpose: 'user_turn',
      resultItemCount: 1,
      splices,
    });
    const contextDelta: ContextModelRequestDelta = {
      schemaVersion: 2,
      requestOrdinal: 1,
      lane: 'parent',
      purpose: 'user_turn',
      modelStep: 1,
      revisionDigest,
      resultItemCount: 1,
      splices,
      occurrences: [contextOccurrence],
    };
    const contextManifest = await createExecutionContextManifest(
      [contextDelta],
      [{
        stage: 'observed',
        resourceKind: 'runtime_fact',
        logicalIdentity: 'workspace-cwd',
        sourceLocator: workspaceRoot,
      }],
    );

    await store.beginExecution({
      taskId: '181-task-first',
      executionId: firstExecutionId,
      createdAt: timestamp,
      sessionCorrelation: handle.id,
      canonicalSessionId: handle.id,
      command: firstCorrelation.command,
      turn: 1,
      task: firstTask,
      baseStateRevision: 1,
      agent: 'generic',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build,
      configurationId: firstConfiguration.configurationId,
      configuration: firstConfiguration,
      maxSteps: 11,
      instanceCorrelation: firstCorrelation.instanceCorrelation,
      workerGeneration: firstCorrelation.workerGeneration,
      contextManifest,
      sessionMode: 'persistent',
      sessionRecord: initial,
    });
    handle.acceptCommitted?.(initial);
    store.appendExecutionEvent({
      executionId: firstExecutionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'context_observation',
      workerSequence: 1,
      payload: {
        kind: 'context_observation',
        correlation: firstCorrelation,
        sequence: 1,
        observation: { kind: 'model_request_delta', delta: contextDelta },
      },
    });
    const canonicalRecord: StoredSessionRecord = {
      ...initial,
      updatedAt: '2026-10-04T00:00:01.000Z',
      stateRevision: 2,
      nextTurn: 2,
      transcript: messages,
      turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
      turnExecutions: [{
        turn: 1,
        executionId: firstExecutionId,
        build,
        configurationId: firstConfiguration.configurationId,
      }],
    };
    const canonicalCapture = store.commitCanonicalTurn({
      taskId: '181-task-first',
      executionId: firstExecutionId,
      createdAt: timestamp,
      sessionCorrelation: handle.id,
      canonicalSessionId: handle.id,
      command: firstCorrelation.command,
      turn: 1,
      task: firstTask,
      baseStateRevision: 1,
      agent: 'generic',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build,
      configurationId: firstConfiguration.configurationId,
      configuration: firstConfiguration,
      maxSteps: 11,
      instanceCorrelation: firstCorrelation.instanceCorrelation,
      workerGeneration: firstCorrelation.workerGeneration,
      contextManifest,
      record: canonicalRecord,
      outcome: successfulOutcome(firstTask, messages),
    });
    strictEqual(canonicalCapture.commitDelta?.committedRevision, 2);
    handle.acceptCommitted?.(canonicalRecord);

    const recalledContext = {
      schemaVersion: 1 as const,
      sourceExecutionId: firstExecutionId,
      sessionId: handle.id,
      turn: 1,
      settlement: 'uncommitted' as const,
      stopReason: 'final' as const,
      task: firstTask,
      evidence: 'unavailable' as const,
      observations: [],
      effectCommitRelation: 'not_transactional' as const,
      automaticReplay: false as const,
    };
    const secondExecutionId = '18100000-0000-4000-8000-000000000102';
    const secondCorrelation = {
      session: handle.id,
      instanceCorrelation: '181-instance-second',
      workerGeneration: '181-generation-second',
      baseStateRevision: 2,
      command: '181-command-second',
    };
    const secondTask = 'Stop after partial progress';
    await store.beginExecution({
      taskId: '181-task-second',
      executionId: secondExecutionId,
      createdAt: '2026-10-04T00:00:02.000Z',
      sessionCorrelation: handle.id,
      command: secondCorrelation.command,
      turn: 2,
      task: secondTask,
      baseStateRevision: 2,
      agent: 'generic',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build,
      configurationId: secondConfiguration.configurationId,
      configuration: secondConfiguration,
      maxSteps: 13,
      instanceCorrelation: secondCorrelation.instanceCorrelation,
      workerGeneration: secondCorrelation.workerGeneration,
      recalledContext,
      sessionMode: 'no_session',
    });
    store.appendExecutionEvent({
      executionId: secondExecutionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 1,
      payload: {
        kind: 'provider_observation',
        correlation: secondCorrelation,
        sequence: 1,
        turn: 2,
        observation: {
          kind: 'runtime_event',
          event: {
            kind: 'assistant_progress',
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
            text: 'Partial response before cancellation.',
          },
        },
      },
    });
    const nonCanonicalOutcome: LoopOutcome = {
      ok: false,
      task: secondTask,
      outcome: 'cancelled',
      stopReason: 'cancelled',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [
        userMessage(secondTask),
        assistantMessage('Partial response before cancellation.'),
      ],
    };
    const nonCanonicalCapture = store.settleNonCanonicalExecution({
      taskId: '181-task-second',
      executionId: secondExecutionId,
      createdAt: '2026-10-04T00:00:02.000Z',
      sessionCorrelation: handle.id,
      command: secondCorrelation.command,
      turn: 2,
      task: secondTask,
      baseStateRevision: 2,
      agent: 'generic',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build,
      configurationId: secondConfiguration.configurationId,
      configuration: secondConfiguration,
      maxSteps: 13,
      instanceCorrelation: secondCorrelation.instanceCorrelation,
      workerGeneration: secondCorrelation.workerGeneration,
      recalledContext,
      outcome: nonCanonicalOutcome,
    });
    ok(nonCanonicalCapture.commitDelta);
    handle.close();
    handle = undefined;
    store.close();

    const reader = new SqliteHistoryStore(stateRoot, workspaceRoot, {
      readOnly: true,
    });
    try {
      await reader.initialize();
      const session = await reader.readWorker(initial.sessionId);
      strictEqual(session.stateRevision, 2);
      strictEqual(session.nextTurn, 2);
      deepStrictEqual(session.transcript, messages);
      deepStrictEqual(
        session.turnExecutions.map((item) => item.configurationId),
        [firstConfiguration.configurationId],
      );
      const first = reader.readExecution(firstExecutionId);
      strictEqual(first.configurationId, firstConfiguration.configurationId);
      strictEqual(
        first.configuration.systemInstruction,
        firstConfiguration.systemInstruction,
      );
      strictEqual(first.maxSteps, 11);
      strictEqual(first.adoption, 'canonical');
      const second = reader.readExecution(secondExecutionId);
      strictEqual(second.configurationId, secondConfiguration.configurationId);
      strictEqual(
        second.configuration.systemInstruction,
        secondConfiguration.systemInstruction,
      );
      strictEqual(second.maxSteps, 13);
      strictEqual(second.adoption, 'non_canonical');
      strictEqual(second.outcome, 'cancelled');
      deepStrictEqual(
        second.outcomeJson?.transcript,
        nonCanonicalOutcome.transcript,
      );
      strictEqual(
        (await reader.readWorker(initial.sessionId)).stateRevision,
        2,
      );
      const context = reader.listExecutionContext(firstExecutionId);
      strictEqual(context.requests.length, 1);
      deepStrictEqual(context.requests[0].request?.transcript, [
        userMessage(firstTask),
      ]);
      strictEqual(
        context.relations.some((relation) => relation.logicalIdentity === 'workspace-cwd'),
        true,
      );
      strictEqual(reader.listRecallRelations(secondExecutionId).length, 1);
      const recalled = await reader.executionArtifacts.read(secondExecutionId);
      strictEqual(
        recalled.command.correlation.command,
        secondCorrelation.command,
      );
      strictEqual(recalled.recall?.sourceExecutionId, firstExecutionId);
      strictEqual(
        recalled.configurationId,
        secondConfiguration.configurationId,
      );
      strictEqual(recalled.maxSteps, 13);
      const exportRecords = [
        ...reader.streamHumanHistoryExport(initial.sessionId),
      ];
      ok(
        exportRecords.some((item) =>
          item.kind === 'configuration' &&
          item.identity === firstConfiguration.configurationId
        ),
      );
      ok(
        exportRecords.some((item) =>
          item.kind === 'configuration' &&
          item.identity === secondConfiguration.configurationId
        ),
      );
      ok(
        exportRecords.some((item) => item.kind === 'execution_context_manifest'),
      );
      ok(exportRecords.some((item) => item.kind === 'recall_relation'));
    } finally {
      reader.close();
    }
    const deleter = new SqliteHistoryStore(stateRoot, workspaceRoot);
    try {
      await deleter.initialize();
      const childExecutionId = crypto.randomUUID();
      await deleter.beginExecution({
        executionId: childExecutionId,
        taskId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        sessionCorrelation: crypto.randomUUID(),
        parentExecutionId: firstExecutionId,
        spawnCallId: 'delete-child',
        turn: 1,
        task: 'child delete regression',
        baseStateRevision: 1,
        agent: 'generic',
        model: ROOT_DEFAULT_MODEL_SELECTION,
        build: buildManifest(),
        configuration: firstConfiguration,
        configurationId: firstConfiguration.configurationId,
        maxSteps: 11,
        command: 'delete-child-command',
        sessionMode: 'no_session',
      });
      await deleter.delete(initial.sessionId);
      strictEqual((await deleter.listWorker()).sessions.length, 0);
      strictEqual(deleter.listExecutions().length, 0);
    } finally {
      deleter.close();
    }
    strictEqual(await Deno.readTextFile(oldDbPath), oldDbSentinel);
    await Deno.stat(`${workspaceState}/history.sqlite3`);
  } finally {
    handle?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
