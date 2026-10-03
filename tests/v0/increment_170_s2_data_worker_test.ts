import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import {
  contextDigest,
  contextOccurrenceDigest,
} from '../../v0/agent/history/context_attribution.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { ContextReadResult, HistoryReadResult } from '../../v0/api/contract.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import type { WorkerCorrelation } from '../../v0/agent/worker/worker_protocol.ts';

const decode = <T>(bytes: Uint8Array<ArrayBuffer>): T =>
  JSON.parse(new TextDecoder().decode(bytes)) as T;

Deno.test('Increment 170 S2 Data Worker reads fresh history, context and execution metadata', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-s2-data-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  const empty = decode<HistoryReadResult>(
    (await data.historyRead({ view: 'session' })).bytes,
  );
  deepStrictEqual(empty, { sessionId: null, view: 'session', text: '' });

  const history = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let session: Awaited<ReturnType<typeof history.allocateWorker>> | undefined;
  try {
    await history.initialize();
    const createdAt = '2026-10-02T00:00:00.000Z';
    const configuration = workerConfigurationFixture();
    session = await history.allocateWorker('default', {});
    const sessionRecord: StoredSessionRecord = {
      schemaVersion: 1,
      sessionId: session.id,
      workspaceRoot,
      agent: 'default',
      createdAt,
      updatedAt: createdAt,
      title: 'Data worker test',
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
    session.commit(sessionRecord);
    session.installCheckpoint({
      contextSchemaVersion: 1,
      sessionId: session.id,
      createdAt,
      sourceProfileId: 'test-profile',
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
      summary: 'Persisted checkpoint summary.',
    });

    const executionId = '17000000-0000-4000-8000-000000000171';
    const taskId = '17000000-0000-4000-8000-000000000172';
    const execution = {
      taskId,
      executionId,
      createdAt,
      sessionCorrelation: session.id,
      canonicalSessionId: session.id,
      turn: 1,
      task: 'read current saved facts',
      baseStateRevision: sessionRecord.stateRevision,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configurationId: configuration.configurationId,
      configuration,
      maxSteps: 128,
      command: 'test-command',
    };
    await history.beginExecution({ ...execution, sessionMode: 'persistent' });
    const correlation: WorkerCorrelation = {
      session: session.id,
      instanceCorrelation: 'i170-s2-instance',
      workerGeneration: 'i170-s2-generation',
      baseStateRevision: sessionRecord.stateRevision,
      command: 'i170-s2-task',
    };
    const contextBytes = new TextEncoder().encode('system instruction');
    const content = {
      digest: await contextDigest(contextBytes),
      byteLength: contextBytes.byteLength,
      mediaType: 'text/plain; charset=utf-8' as const,
    };
    const contextOccurrence = {
      occurrenceId: 'request-context-1',
      kind: 'system' as const,
      content,
      sourceRelations: [],
    };
    const occurrenceDigest = await contextOccurrenceDigest(contextOccurrence);
    const storedEvents: ExecutionEventInput[] = [
      {
        executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'provider_request_start',
        workerSequence: 1,
        payload: {
          kind: 'provider_observation',
          correlation,
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
      },
      {
        executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'context_observation',
        workerSequence: 2,
        payload: {
          kind: 'context_observation',
          correlation,
          sequence: 2,
          observation: {
            kind: 'model_request_delta',
            delta: {
              schemaVersion: 2,
              requestOrdinal: 1,
              lane: 'parent',
              purpose: 'user_turn',
              modelStep: 1,
              revisionDigest:
                'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              resultItemCount: 1,
              splices: [{
                start: 0,
                deleteCount: 0,
                insertions: [{ occurrenceId: contextOccurrence.occurrenceId, occurrenceDigest }],
              }],
              occurrences: [{
                ...contextOccurrence,
                occurrenceDigest,
                bytesBase64: contextBytes.toBase64(),
              }],
            },
          },
        },
      },
      {
        executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: 3,
        payload: {
          kind: 'provider_observation',
          correlation,
          sequence: 3,
          turn: 1,
          observation: {
            kind: 'runtime_event',
            event: {
              kind: 'model_result',
              modelStep: 1,
              lane: 'parent',
              requestOrdinal: 1,
              result: { kind: 'final', text: 'Saved assistant answer.' },
            },
          },
        },
      },
    ] as ExecutionEventInput[];
    history.appendExecutionEventsWithSemanticIds(storedEvents);

    const historyRead = decode<HistoryReadResult>(
      (await data.historyRead({ sessionRef: session.id, view: 'session' })).bytes,
    );
    strictEqual(historyRead.sessionId, session.id);
    strictEqual(historyRead.view, 'session');
    ok(historyRead.text.includes('Saved assistant answer.'));

    const detail = decode<HistoryReadResult>(
      (await data.historyRead({ sessionRef: session.id, view: 'detail' })).bytes,
    );
    ok(detail.text.includes('provider_request_start'));

    const context = decode<ContextReadResult>(
      (await data.contextRead(session.id)).bytes,
    );
    deepStrictEqual(context.context.checkpoint, {
      summary: 'Persisted checkpoint summary.',
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
    });
    deepStrictEqual(context.context.latestRequest, {
      executionId,
      requestOrdinal: 1,
      lane: 'parent',
      purpose: 'user_turn',
      modelStep: 1,
      itemCount: 1,
    });

    const activeContext = decode<ContextReadResult>(
      (await data.contextRead('17000000-0000-4000-8000-000000000173', {
        sourceExecutionId: executionId,
        evidence: 'available',
      }, true)).bytes,
    );
    deepStrictEqual(activeContext, {
      context: {
        pendingRecall: { sourceExecutionId: executionId, evidence: 'available' },
      },
    });

    const executionRead = await data.executionRead(executionId);
    deepStrictEqual(executionRead.execution, {
      executionId,
      sessionId: session.id,
      task: 'read current saved facts',
      turn: 1,
      createdAt,
      lifecycle: 'active',
      outcome: 'unknown',
      adoption: 'non_canonical',
      processSettlement: 'unknown',
      requestCount: 1,
      durability: {
        acknowledgement: 'not_sent',
        generationAvailability: 'unknown',
        diagnosticCapture: 'none',
        artifactCapture: 'none',
        contextCapture: 'none',
      },
    });
  } finally {
    await data.close();
    await session?.close();
    history.close();
  }
});
