import { createFailureDiagnostic } from '../../v0/agent/session/failure_diagnostic.ts';
import { failedOutcome } from '../../v0/agent/worker/worker_host_outcome.ts';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import { ExecutionDataJournal } from '../../v0/agent/data/execution_data_journal.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import {
  encodedSessionSnapshot,
  encodedSessionUpdate,
} from '../../v0/agent/host/encoded_public_frame.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { projectRuntimeDisplayState } from '../../v0/agent/runtime/startup_orientation.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { decodeSessionSnapshot, decodeSessionStreamFrame } from '../../v0/api/codec.ts';
import type { SessionControlSnapshot } from '../../v0/api/contract.ts';
import { initialSessionClientState, reduceSessionStreamFrame } from '../../v0/api/reducer.ts';

Deno.test('Increment 170 public entity frames apply saved Data batches without replacing old entity or order stores', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-public-entity-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  const writer = new ConversationWriter(store);
  const sessionId = crypto.randomUUID();
  const executionId = crypto.randomUUID();
  const configuration = workerConfigurationFixture();
  let journal: ExecutionDataJournal | undefined;
  try {
    await store.initialize();
    const execution = {
      executionId,
      taskId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      sessionCorrelation: sessionId,
      sessionMode: 'no_session' as const,
      turn: 1,
      task: 'Show the latest body',
      baseStateRevision: 1,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configuration,
      configurationId: configuration.configurationId,
      maxSteps: 128,
      command: 'test-command',
    };
    await writer.beginExecution(execution);
    const selection = ROOT_DEFAULT_MODEL_SELECTION;
    const control: SessionControlSnapshot = {
      schemaVersion: 3,
      cursor: { coreEpoch: crypto.randomUUID(), sessionId, revision: 0 },
      session: {
        id: sessionId,
        canonicalSessionId: null,
        persistence: 'none',
        position: {
          sessionId,
          createdAt: new Date().toISOString(),
          agent: 'default',
          committedTurn: 0,
          messageCount: 0,
        },
        selection,
        startup: {
          ...projectRuntimeDisplayState({
            productVersion: buildManifest().productVersion,
            workspaceRoot,
            agentId: 'default',
            profileId: modelRouteProfileId(selection),
            provider: selection.provider,
            modelId: selection.modelId,
            effort: selection.effort,
            sessionMode: 'none',
            skillNames: [],
          }),
          status: 'evaluated',
        },
      },
      runtime: {
        active: true,
        activeSessionId: sessionId,
        phase: 'running',
        execution: null,
        operations: [],
      },
      pending: { kind: 'core-owned', followUps: [] },
      credentialAvailability: { status: 'unknown' },
      context: {},
    };
    const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
    let state = initialSessionClientState(decodeSessionSnapshot(decode(
      encodedSessionSnapshot(control, writer.snapshotSession(sessionId).bytes),
    )));
    const entities = state.snapshot.conversation.entities;
    const order = state.snapshot.conversation.order;
    const user = Object.values(entities).find((entity) =>
      entity.kind === 'message' && entity.role === 'user'
    );
    ok(user);
    let revision = 0;
    const watch = writer.watchSession(sessionId, (delta) => {
      const next = ++revision;
      state = reduceSessionStreamFrame(
        state,
        decodeSessionStreamFrame(decode(
          encodedSessionUpdate({ ...control.cursor, revision: next }, next - 1, [], delta.bytes),
        )),
      );
    });
    const correlation = {
      session: sessionId,
      instanceCorrelation: crypto.randomUUID(),
      workerGeneration: crypto.randomUUID(),
      baseStateRevision: 1,
      command: 'task',
    };
    journal = new ExecutionDataJournal({
      executionId,
      correlation,
      writer,
      history: store,
      onFailure: (error) => {
        throw error;
      },
    });
    let sequence = 0;
    const producer = new ProviderEvidenceRecorder(
      crypto.randomUUID(),
      1,
      new Date().toISOString(),
      (observation) => {
        journal!.receive({
          executionId,
          sequence: ++sequence,
          message: {
            kind: 'provider_observation',
            correlation,
            sequence,
            turn: 1,
            observation,
          },
        });
        return sequence;
      },
      false,
    );
    producer.startRequestMetadata({
      lane: 'parent',
      modelStep: 1,
      endpoint: 'http://127.0.0.1/chat',
      method: 'POST',
      requestMetadata: { provider: 'local', modelId: 'model', api: 'openai-chat-completions' },
    });
    producer.recordAssistantProgress('first', 1, 'parent');
    journal.flush();
    const firstBody = Object.values(entities).find((entity) =>
      entity.kind === 'message' && entity.role === 'assistant'
    );
    ok(firstBody && firstBody.kind === 'message');
    producer.recordAssistantProgress('latest', 1, 'parent');
    journal.flush();
    strictEqual(state.snapshot.conversation.entities, entities);
    strictEqual(state.snapshot.conversation.order, order);
    strictEqual(entities[user.id], user);
    const body = entities[firstBody.id];
    ok(body.kind === 'message');
    strictEqual(body.text, 'latest');
    deepStrictEqual([...state.dirtyEntityIds], [body.id]);
    strictEqual(state.structureChanged, false);
    const restored = decodeSessionSnapshot(
      decode(
        encodedSessionSnapshot(
          { ...control, cursor: { ...control.cursor, revision } },
          writer.snapshotSession(sessionId).bytes,
        ),
      ),
    );
    deepStrictEqual(restored.conversation, state.snapshot.conversation);
    journal.seal();
    const diagnostic = createFailureDiagnostic({
      stage: 'response_parse',
      code: 'response_error',
      parseReason: 'invalid_sse_json',
      httpStatus: 200,
      providerRequestCount: 1,
      turnNumber: 1,
      modelStep: 1,
    });
    writer.settleNonCanonicalExecution({
      ...execution,
      messageSuffix: [],
      outcome: { ...failedOutcome(execution.task, 'provider response invalid'), diagnostic },
      diagnostic,
    });
    const terminal = Object.values(state.snapshot.conversation.entities).find((entity) =>
      entity.kind === 'execution'
    );
    ok(terminal && terminal.kind === 'execution');
    strictEqual(terminal.execution.stopReason, 'contract_failure');
    deepStrictEqual(terminal.execution.diagnostic, {
      code: 'response_error',
      stage: 'response_parse',
    });
    const savedOutcome = store.readExecutionMetadata(executionId).outcomeJson;
    strictEqual(savedOutcome?.stopReason, terminal.execution.stopReason);
    strictEqual(savedOutcome?.diagnostic?.code, terminal.execution.diagnostic?.code);
    strictEqual(savedOutcome?.diagnostic?.stage, terminal.execution.diagnostic?.stage);
    watch.unsubscribe();
  } finally {
    journal?.seal();
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
