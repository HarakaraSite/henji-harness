import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { roleDefaultModelSelection } from '../../v0/agent/provider/model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import {
  type ProviderEvidenceObservation,
  ProviderEvidenceRecorder,
  type ProviderEvidenceV4,
  validateProviderEvidence,
} from '../../v0/agent/provider/provider_evidence.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import {
  type BeginExecutionInput,
  HistoryStoreError,
} from '../../v0/agent/history/history_store_contract.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import { resolveRecalledExecutionContext } from '../../v0/agent/worker/recalled_execution_context.ts';
import {
  workerBuiltinModulePath,
  type WorkerHostCapsule,
  WorkerHostSession,
} from '../../v0/agent/worker/worker_host.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { DatabaseSync } from 'node:sqlite';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};
const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
};

const definition = {
  schemaVersion: 1 as const,
  resourceKind: 'agent-definition' as const,
  resourceId: 'builtin/default',
  revision: { algorithm: 'sha256' as const, digest: 'a'.repeat(64) },
};

const manifest = {
  role: 'parent' as const,
  maxSteps: 8,
  profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
  resources: [],
  rootModel: ROOT_DEFAULT_MODEL_SELECTION,
  plannerModel: roleDefaultModelSelection('subagent:planner'),
};

const makeInput = (taskId: string, executionId: string) => ({
  taskId,
  executionId,
  createdAt: '2026-09-12T00:00:00.000Z',
  sessionCorrelation: '30000000-0000-4000-8000-000000000041',
  sessionMode: 'no_session' as const,
  turn: 1,
  task: 'durably observe this execution',
  baseStateRevision: 1,
  agent: 'default' as const,
  model: ROOT_DEFAULT_MODEL_SELECTION,
  build: buildManifest(),
  definition,
  manifest,
  instanceCorrelation: 'instance-1',
  workerGeneration: 'generation-1',
});

class MinimalCommitCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();
  turnDispatches = 0;
  beforeTurn?: () => void;

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      this.emit({
        kind: 'ready',
        correlation: command.correlation,
        manifest,
        startupSnapshot: { skillNames: [] },
        credentialAvailability: {
          authProfile: 'openrouter-api-key',
          status: 'unknown',
        },
      });
      return;
    }
    if (command.kind === 'turn') {
      this.beforeTurn?.();
      this.turnDispatches += 1;
      queueMicrotask(() =>
        this.emit({
          kind: 'commit_proposal',
          correlation: command.correlation,
          nextTurn: 2,
          transcript: [
            { role: 'user', content: { kind: 'text', text: command.task } },
            { role: 'assistant', content: { kind: 'text', text: 'committed' } },
          ],
        })
      );
      return;
    }
    if (command.kind === 'commit_acknowledgement' && command.accepted) {
      queueMicrotask(() =>
        this.emit({
          kind: 'runtime_event',
          correlation: command.correlation,
          sequence: 1,
          event: {
            kind: 'agent_event',
            event: {
              kind: 'turn_end',
              turn: 1,
              outcome: 'final',
              committed: true,
            },
          },
        })
      );
      return;
    }
    if (command.kind === 'close') {
      this.emit({ kind: 'closed', correlation: command.correlation });
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {}
}

const makePersistentFirstTurnInput = (
  taskId: string,
  executionId: string,
  sessionId: string,
  workspaceRoot: string,
): BeginExecutionInput => {
  const input = makeInput(taskId, executionId);
  const record: StoredSessionRecord = {
    schemaVersion: 6,
    sessionId,
    workspaceRoot,
    agent: 'default',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    title: null,
    stateRevision: input.baseStateRevision,
    nextTurn: input.turn,
    transcript: [],
    definition,
    activeModel: ROOT_DEFAULT_MODEL_SELECTION,
    modelChanges: [{
      effectiveFromTurn: 1,
      changedAt: input.createdAt,
      selection: ROOT_DEFAULT_MODEL_SELECTION,
    }],
    turnModels: [],
    turnExecutions: [],
  };
  return {
    ...input,
    sessionCorrelation: sessionId,
    canonicalSessionId: sessionId,
    sessionMode: 'persistent',
    sessionRecord: record,
  };
};

class AppendFailureHistory extends SqliteHistoryStore {
  constructor(
    stateRoot: string,
    workspaceRoot: string,
    private readonly failureKind: string,
  ) {
    super(stateRoot, workspaceRoot);
  }

  override appendExecutionEvent(
    input: Parameters<SqliteHistoryStore['appendExecutionEvent']>[0],
  ) {
    if (input.kind === this.failureKind) {
      throw new HistoryStoreError('history_io_failure');
    }
    return super.appendExecutionEvent(input);
  }
}

class BeginFailureHistory extends SqliteHistoryStore {
  constructor(
    stateRoot: string,
    workspaceRoot: string,
    private readonly failureCode:
      | 'history_busy'
      | 'history_invalid'
      | 'history_io_failure',
  ) {
    super(stateRoot, workspaceRoot);
  }

  override beginExecution(
    _input: Parameters<SqliteHistoryStore['beginExecution']>[0],
  ): Promise<void> {
    return Promise.reject(new HistoryStoreError(this.failureCode));
  }
}

const makeCompleteEvidence = (
  input: ReturnType<typeof makeInput>,
  evidenceId: string,
  includeRuntime = true,
): ProviderEvidenceV4 => {
  const recorder = new ProviderEvidenceRecorder(evidenceId, 1, input.createdAt);
  recorder.startRequest({
    lane: 'parent',
    phase: 'user_turn',
    modelStep: 1,
    endpoint: 'https://provider.invalid/v1/chat',
    method: 'POST',
    requestBody: '{}',
    requestMetadata: {
      provider: 'openrouter-chat',
      api: 'openrouter-chat-completions',
      modelId: input.model.modelId,
      effort: input.model.effort,
      protocol: 'sse',
    },
  });
  recorder.recordResponse({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  recorder.appendResponseBytes(new TextEncoder().encode('x'));
  if (includeRuntime) {
    const call = { callId: 'call-1', name: 'read_file', arguments: '{}' };
    recorder.recordAssistantProgress('latest assistant', 1, 'parent');
    recorder.recordToolCall(call, 1, 'parent');
    recorder.recordToolProgress(call, 'latest tool', 1, 'parent');
    recorder.recordToolResult(
      {
        kind: 'tool_result',
        callId: call.callId,
        name: call.name,
        text: 'done',
        outcome: 'success',
      },
      1,
      'parent',
    );
  }
  recorder.finalize({
    outcome: {
      ok: true,
      task: input.task,
      outcome: 'final',
      stopReason: 'final',
      steps: 1,
      toolCallCount: includeRuntime ? 1 : 0,
      toolResultCount: includeRuntime ? 1 : 0,
      transcript: [],
    },
  });
  return {
    ...recorder.snapshot(),
    schemaVersion: 4,
    sessionId: input.sessionCorrelation,
    build: input.build,
    definition: input.definition,
    capture: 'complete',
    normalizedOutcome: 'completed',
    outcome: 'final',
    ...(includeRuntime ? {} : { runtimeEvents: [] }),
  };
};

const appendProviderObservation = (
  store: SqliteHistoryStore,
  input: ReturnType<typeof makeInput>,
  executionId: string,
  sequence: number,
  observation: ProviderEvidenceObservation,
): void => {
  const kind = observation.kind === 'request_start'
    ? 'provider_request_start'
    : observation.kind === 'response_start'
    ? 'provider_response_start'
    : observation.kind === 'response_bytes'
    ? 'provider_response_bytes'
    : observation.kind === 'sse_event'
    ? 'provider_sse_event'
    : observation.kind === 'parser_transition'
    ? 'provider_parser_transition'
    : 'runtime_event';
  store.appendExecutionEvent({
    executionId,
    direction: 'worker_to_host',
    source: 'worker',
    kind,
    workerSequence: sequence,
    payload: {
      kind: 'provider_observation',
      correlation: {
        session: input.sessionCorrelation,
        instanceCorrelation: input.instanceCorrelation,
        workerGeneration: input.workerGeneration,
        baseStateRevision: input.baseStateRevision,
        command: 'turn-1',
      },
      sequence,
      turn: input.turn,
      observation,
    } as never,
  } as never);
};

Deno.test('Increment 41 distinguishes post-commit journal loss from canonical commit', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i41-post-commit-observation-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new AppendFailureHistory(
    stateRoot,
    workspaceRoot,
    'acknowledgement_requested',
  );
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const handle = await store.allocateWorker('default', definition);
    const capsule = new MinimalCommitCapsule();
    capsule.beforeTurn = () => {
      const admitted = store.listExecutions()[0];
      assert(admitted !== undefined);
      assertEquals(admitted.lifecycle, 'active');
    };
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      historyPersistence: store,
      providerEvidenceStore: store.providerEvidence,
      executionArtifactStore: store.executionArtifacts,
      durableCanonicalHistory: true,
      capsuleFactory: () => capsule,
    });
    const outcome = await host.submit('post-commit observation failure');
    assert(outcome.ok);
    assertEquals(outcome.executionObservationDurability, 'failed');
    assertEquals(
      outcome.executionObservationPersistenceError,
      'history_io_failure',
    );
    const row = store.listExecutions()[0];
    assert(row !== undefined);
    assertEquals({
      lifecycle: row.lifecycle,
      outcome: row.outcome,
      adoption: row.adoption,
      contextCapture: row.contextCapture,
    }, {
      lifecycle: 'settled',
      outcome: 'completed',
      adoption: 'canonical',
      contextCapture: 'failed',
    });
    const artifact = (await store.executionArtifacts.list())[0];
    if (artifact?.schemaVersion !== 6) throw new Error('expected v6 artifact');
    assertEquals(artifact?.contextCapture, 'failed');
    assertEquals(
      store.listExecutionEvents(row.executionId).filter((event) =>
        event.kind === 'execution_settled'
      ).length,
      1,
    );
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 preserves typed admission failure and never dispatches a turn', async () => {
  for (
    const [index, code] of (['history_busy', 'history_invalid', 'history_io_failure'] as const)
      .entries()
  ) {
    const root = await Deno.makeTempDir({
      prefix: `henji-i41-admission-${index}-`,
    });
    const workspaceRoot = `${root}/workspace`;
    const stateRoot = `${root}/state`;
    await Deno.mkdir(workspaceRoot);
    const store = new BeginFailureHistory(stateRoot, workspaceRoot, code);
    let host: WorkerHostSession | undefined;
    try {
      await store.initialize();
      const handle = await store.allocateWorker('default', definition);
      const capsule = new MinimalCommitCapsule();
      host = await WorkerHostSession.open({
        handle,
        workspaceRoot,
        agent: 'default',
        definition,
        modulePath: workerBuiltinModulePath('default'),
        physicalIoMode: 'provider-free',
        historyPersistence: store,
        durableCanonicalHistory: true,
        capsuleFactory: () => capsule,
      });
      const outcome = await host.submit(`admission ${code}`);
      assert(!outcome.ok);
      assertEquals(outcome.executionAdmissionDurability, 'failed');
      assertEquals(outcome.executionAdmissionPersistenceError, code);
      assertEquals(capsule.turnDispatches, 0);
      assertEquals(store.listExecutions(), []);
      assert(outcome.executionArtifactId === undefined);
    } finally {
      await host?.close();
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('Increment 41 admits before dispatch and appends live observations', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i41-journal-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const taskId = '10000000-0000-4000-8000-000000000041';
  const executionId = '20000000-0000-4000-8000-000000000041';
  try {
    await store.initialize();
    const input = makeInput(taskId, executionId);
    await store.beginExecution(input);
    assertEquals(store.readExecution(executionId), {
      executionId,
      taskId,
      task: input.task,
      sessionCorrelation: input.sessionCorrelation,
      turn: 1,
      createdAt: input.createdAt,
      lifecycle: 'active',
      outcome: 'unknown',
      adoption: 'non_canonical',
      baseRevision: 1,
      agent: 'default',
      model: input.model,
      build: input.build,
      definition,
      manifest,
      instanceCorrelation: input.instanceCorrelation,
      workerGeneration: input.workerGeneration,
      acknowledgement: 'not_sent',
      generationAvailability: 'unknown',
      evidenceCapture: 'unknown',
      diagnosticCapture: 'unknown',
      artifactCapture: 'unknown',
      contextCapture: 'none',
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'host_to_worker',
      source: 'host',
      kind: 'turn_dispatch_sent',
      payload: { kind: 'turn', task: input.task },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'effect_observation',
      workerSequence: 1,
      payload: {
        kind: 'effect_observation',
        correlation: {
          session: input.sessionCorrelation,
          instanceCorrelation: input.instanceCorrelation,
          workerGeneration: input.workerGeneration,
          baseStateRevision: input.baseStateRevision,
          command: 'turn-1',
        },
        sequence: 1,
        effect: {
          kind: 'tool_call',
          turn: 1,
          call: { callId: 'read-1', name: 'read_file', arguments: '{}' },
        },
      },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_request_start',
      workerSequence: 2,
      payload: {
        kind: 'provider_observation',
        correlation: {
          session: input.sessionCorrelation,
          instanceCorrelation: input.instanceCorrelation,
          workerGeneration: input.workerGeneration,
          baseStateRevision: input.baseStateRevision,
          command: 'turn-1',
        },
        sequence: 2,
        turn: input.turn,
        observation: {
          kind: 'request_start',
          request: {
            ordinal: 1,
            lane: 'parent',
            phase: 'user_turn',
            modelStep: 1,
            endpoint: 'https://provider.invalid/v1/chat',
            method: 'POST',
            requestBody: '{}',
            requestBodyBytes: 2,
            requestMetadata: {
              provider: 'openrouter-chat',
              api: 'openrouter-chat-completions',
              modelId: input.model.modelId,
              effort: input.model.effort,
              protocol: 'sse',
            },
          },
        },
      },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_response_start',
      workerSequence: 3,
      payload: {
        kind: 'provider_observation',
        correlation: {
          session: input.sessionCorrelation,
          instanceCorrelation: input.instanceCorrelation,
          workerGeneration: input.workerGeneration,
          baseStateRevision: input.baseStateRevision,
          command: 'turn-1',
        },
        sequence: 3,
        turn: input.turn,
        observation: {
          kind: 'response_start',
          requestOrdinal: 1,
          response: {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        },
      },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'provider_response_bytes',
      workerSequence: 4,
      payload: {
        kind: 'provider_observation',
        correlation: {
          session: input.sessionCorrelation,
          instanceCorrelation: input.instanceCorrelation,
          workerGeneration: input.workerGeneration,
          baseStateRevision: input.baseStateRevision,
          command: 'turn-1',
        },
        sequence: 4,
        turn: input.turn,
        observation: {
          kind: 'response_bytes',
          requestOrdinal: 1,
          offset: 1,
          bytesBase64: 'eA==',
        },
      },
    });
    const events = store.listExecutionEvents(executionId);
    assertEquals(events.map((event) => event.ordinal), [1, 2, 3, 4, 5, 6, 7]);
    assertEquals(
      events.filter((event) => event.workerSequence !== undefined)
        .map((event) => event.workerSequence),
      [1, 2, 3, 4],
    );
    assert(!JSON.stringify(events).toLowerCase().includes('authorization'));
    assertEquals(store.listExecutionEffects(executionId), [{
      executionId,
      callId: 'read-1',
      name: 'read_file',
      requestedEventOrdinal: 4,
      status: 'observed_requested',
    }]);

    store.reconcileExecution({ executionId, settlement: 'interrupted' });
    const row = store.readExecution(executionId);
    assertEquals({
      lifecycle: row.lifecycle,
      outcome: row.outcome,
      adoption: row.adoption,
    }, {
      lifecycle: 'settled',
      outcome: 'interrupted',
      adoption: 'non_canonical',
    });
    assertEquals(
      store.listExecutionEffects(executionId)[0]?.status,
      'outcome_unknown',
    );
    const evidence = (await store.providerEvidence.list())[0];
    assert(evidence?.schemaVersion === 5);
    assertEquals(evidence.capture, 'partial');
    assertEquals(evidence.settlement, 'interrupted');
    assertEquals(evidence.requests[0]?.response?.rawBodyBase64, 'eA==');
    const artifact = (await store.executionArtifacts.list())[0];
    assert(artifact?.schemaVersion === 6);
    assertEquals(artifact.settlement, 'interrupted');
    assertEquals(artifact.normalizedOutcome, 'interrupted');
    assertEquals(artifact.providerEvidenceId, evidence.evidenceId);
    const recalled = await resolveRecalledExecutionContext({
      sessionId: input.sessionCorrelation,
      executionId,
      providerEvidenceStore: store.providerEvidence,
      historyPersistence: store,
    });
    assert(recalled.schemaVersion === 2);
    assert(!Object.hasOwn(recalled, 'stopReason'));
    assertEquals(
      {
        outcome: recalled.outcome,
        capture: recalled.capture,
        journalEventCount: recalled.journalEventCount,
        effectStatus: recalled.effectObservations[0]?.status,
      },
      {
        outcome: 'interrupted',
        capture: 'partial',
        journalEventCount: 8,
        effectStatus: 'outcome_unknown',
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 rejects an event kind outside the journal contract', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i41-event-contract-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const taskId = '10000000-0000-4000-8000-000000000042';
  const executionId = '20000000-0000-4000-8000-000000000042';
  try {
    await store.initialize();
    await store.beginExecution(makeInput(taskId, executionId));
    let invalid = false;
    try {
      store.appendExecutionEvent({
        executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'not-a-journal-kind' as never,
        payload: {} as never,
      });
    } catch (error) {
      invalid = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(invalid);
    assertEquals(store.listExecutionEvents(executionId).length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 recall retains journal user/assistant/tool facts without replay', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i41-recall-journal-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const input = makeInput(
    '10000000-0000-4000-8000-000000000042',
    '20000000-0000-4000-8000-000000000042',
  );
  const correlation = {
    session: input.sessionCorrelation,
    instanceCorrelation: input.instanceCorrelation,
    workerGeneration: input.workerGeneration,
    baseStateRevision: input.baseStateRevision,
    command: 'turn-1',
  };
  let sequence = 0;
  const appendRuntime = (event: Record<string, unknown>): void => {
    sequence += 1;
    store.appendExecutionEvent({
      executionId: input.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: sequence,
      payload: {
        kind: 'runtime_event',
        correlation,
        sequence,
        event: { kind: 'agent_event', event },
      } as never,
    } as never);
  };
  const appendEffect = (effect: Record<string, unknown>): void => {
    sequence += 1;
    store.appendExecutionEvent({
      executionId: input.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'effect_observation',
      workerSequence: sequence,
      payload: {
        kind: 'effect_observation',
        correlation,
        sequence,
        effect,
      } as never,
    } as never);
  };
  try {
    await store.initialize();
    await store.beginExecution(input);
    appendRuntime({
      kind: 'user_message',
      turn: 1,
      message: {
        role: 'user',
        content: { kind: 'text', text: 'source request' },
      },
    });
    appendRuntime({
      kind: 'assistant_message',
      turn: 1,
      message: {
        role: 'assistant',
        content: { kind: 'text', text: 'visible answer' },
      },
    });
    const call = {
      callId: 'call-42',
      name: 'read_file',
      arguments: { path: 'notes.md' },
    };
    appendEffect({ kind: 'tool_call', turn: 1, call });
    appendEffect({
      kind: 'tool_progress',
      turn: 1,
      callId: call.callId,
      name: call.name,
      text: 'reading notes',
    });
    appendEffect({
      kind: 'tool_result',
      turn: 1,
      result: {
        kind: 'tool_result',
        callId: call.callId,
        name: call.name,
        text: 'contents',
        outcome: 'success',
      },
    });
    store.reconcileExecution({
      executionId: input.executionId,
      settlement: 'interrupted',
    });
    const recalled = await resolveRecalledExecutionContext({
      sessionId: input.sessionCorrelation,
      executionId: input.executionId,
      historyPersistence: store,
    });
    assert(recalled.schemaVersion === 2);
    assertEquals(
      recalled.journalObservations.map((observation) => observation.kind),
      [
        'user_message',
        'assistant_message',
        'tool_call',
        'tool_progress',
        'tool_result',
      ],
    );
    assertEquals(
      (recalled.journalObservations[0] as {
        readonly message: { readonly content: { readonly text: string } };
      }).message.content.text,
      'source request',
    );
    assertEquals(
      (recalled.journalObservations[2] as {
        readonly call: { readonly arguments: unknown };
      }).call.arguments,
      { path: 'notes.md' },
    );
    assertEquals(
      (recalled.journalObservations[4] as {
        readonly result: { readonly text: string };
      }).result.text,
      'contents',
    );
    assertEquals(recalled.effectObservations[0]?.status, 'completed');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 rejects complete evidence with missing provider/runtime observations', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i41-evidence-match-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const zeroInput = makeInput(
    '10000000-0000-4000-8000-000000000043',
    '20000000-0000-4000-8000-000000000043',
  );
  const liveInput = makeInput(
    '10000000-0000-4000-8000-000000000044',
    '20000000-0000-4000-8000-000000000044',
  );
  try {
    await store.initialize();
    const zeroEvidence = makeCompleteEvidence(
      zeroInput,
      '40000000-0000-4000-8000-000000000043',
      false,
    );
    await store.beginExecution(zeroInput);
    let rejected = false;
    try {
      store.settleNonCanonicalExecution({
        ...zeroInput,
        outcome: {
          ok: true,
          task: zeroInput.task,
          outcome: 'final',
          stopReason: 'final',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
        evidence: zeroEvidence,
      });
    } catch (error) {
      rejected = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(
      rejected,
      'complete requests without a live request row must be rejected',
    );
    store.reconcileExecution({
      executionId: zeroInput.executionId,
      settlement: 'unknown',
    });

    const liveEvidence = makeCompleteEvidence(
      liveInput,
      '40000000-0000-4000-8000-000000000044',
      false,
    );
    await store.beginExecution(liveInput);
    appendProviderObservation(store, liveInput, liveInput.executionId, 1, {
      kind: 'request_start',
      request: liveEvidence.requests[0].request,
    });
    appendProviderObservation(store, liveInput, liveInput.executionId, 2, {
      kind: 'response_start',
      requestOrdinal: 1,
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    });
    appendProviderObservation(store, liveInput, liveInput.executionId, 3, {
      kind: 'response_bytes',
      requestOrdinal: 1,
      offset: 1,
      bytesBase64: 'eA==',
    });
    appendProviderObservation(store, liveInput, liveInput.executionId, 4, {
      kind: 'runtime_event',
      requestOrdinal: 1,
      event: {
        kind: 'assistant_progress',
        requestOrdinal: 1,
        text: 'latest assistant',
        modelStep: 1,
        lane: 'parent',
      },
    });
    appendProviderObservation(store, liveInput, liveInput.executionId, 5, {
      kind: 'runtime_event',
      requestOrdinal: 1,
      event: {
        kind: 'tool_progress',
        requestOrdinal: 1,
        callId: 'call-1',
        name: 'read_file',
        text: 'latest tool',
        modelStep: 1,
        lane: 'parent',
      },
    });
    rejected = false;
    try {
      store.settleNonCanonicalExecution({
        ...liveInput,
        outcome: {
          ok: true,
          task: liveInput.task,
          outcome: 'final',
          stopReason: 'final',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
        evidence: liveEvidence,
      });
    } catch (error) {
      rejected = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(
      rejected,
      'complete evidence missing the last live progress must be rejected',
    );
    store.reconcileExecution({
      executionId: liveInput.executionId,
      settlement: 'interrupted',
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 validates V4 nested IDs, bytes, stream facts, and runtime shape', () => {
  const input = makeInput(
    '10000000-0000-4000-8000-000000000045',
    '20000000-0000-4000-8000-000000000045',
  );
  const valid = makeCompleteEvidence(
    input,
    '40000000-0000-4000-8000-000000000045',
  );
  assert(validateProviderEvidence(valid));
  const assertInvalid = (value: unknown): void => assert(!validateProviderEvidence(value));

  const extra = structuredClone(valid) as unknown as Record<string, unknown>;
  extra.unexpected = true;
  assertInvalid(extra);

  const badRequest = structuredClone(valid) as unknown as {
    requests: Array<{ request: { requestBodyBytes: number } }>;
  };
  badRequest.requests[0].request.requestBodyBytes += 1;
  assertInvalid(badRequest);

  const badResponse = structuredClone(valid) as unknown as {
    requests: Array<{ response: { rawBodyBase64: string } }>;
  };
  badResponse.requests[0].response.rawBodyBase64 = 'not-base64';
  assertInvalid(badResponse);

  const missingResponseBytes = structuredClone(valid) as unknown as {
    requests: Array<{ response: Record<string, unknown> }>;
  };
  delete missingResponseBytes.requests[0].response.rawBodyBase64;
  delete missingResponseBytes.requests[0].response.rawBody;
  assertInvalid(missingResponseBytes);

  const unknownCapture = structuredClone(valid) as unknown as {
    capture: string;
  };
  unknownCapture.capture = 'unknown';
  assertInvalid(unknownCapture);

  const stream = structuredClone(valid) as unknown as {
    requests: Array<{
      response: { rawBodyBytes: number };
      sseEvents: Array<Record<string, unknown>>;
      parserTransitions: Array<Record<string, unknown>>;
    }>;
  };
  stream.requests[0].sseEvents.push({
    ordinal: 1,
    data: 'x',
    rawFrame: 'data: x\n\n',
    rawFrameBytes: new TextEncoder().encode('data: x\n\n').byteLength,
    responseBodyOffset: stream.requests[0].response.rawBodyBytes,
  });
  stream.requests[0].parserTransitions.push({ ordinal: 1, kind: 'event' });
  assert(validateProviderEvidence(stream));
  const mutableStream = stream as unknown as {
    requests: Array<{ sseEvents: Array<Record<string, unknown>> }>;
  };
  mutableStream.requests[0].sseEvents[0].rawFrameBytes = 1;
  assertInvalid(mutableStream);

  const badRuntime = structuredClone(valid) as unknown as {
    runtimeEvents: Array<{ kind: string; text?: unknown }>;
  };
  const assistant = badRuntime.runtimeEvents.find((event) => event.kind === 'assistant_progress');
  assert(assistant !== undefined);
  (assistant as { text?: unknown }).text = { malformed: true };
  assertInvalid(badRuntime);
});

Deno.test('Increment 41 rejects malformed host, worker, tool, and provider journal facts', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i41-event-validation-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const input = makeInput(
    '10000000-0000-4000-8000-000000000046',
    '20000000-0000-4000-8000-000000000046',
  );
  const correlation = {
    session: input.sessionCorrelation,
    instanceCorrelation: input.instanceCorrelation,
    workerGeneration: input.workerGeneration,
    baseStateRevision: input.baseStateRevision,
    command: 'turn-1',
  };
  const rejected = (write: () => void): void => {
    let failed = false;
    try {
      write();
    } catch (error) {
      failed = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(failed);
  };
  try {
    await store.initialize();
    await store.beginExecution(input);
    rejected(() =>
      store.appendExecutionEvent({
        executionId: input.executionId,
        direction: 'host_to_worker',
        source: 'host',
        kind: 'turn_dispatch_sent',
        payload: { task: '' },
      })
    );
    rejected(() =>
      store.appendExecutionEvent({
        executionId: input.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'provider_request_start',
        payload: {
          kind: 'provider_observation',
          correlation,
          sequence: 1,
          turn: input.turn,
          observation: {
            kind: 'request_start',
            request: {
              ordinal: 1,
              lane: 'parent',
              modelStep: 1,
              endpoint: 'https://provider.invalid',
              method: 'POST',
              requestBody: '{}',
              requestBodyBytes: 1,
              requestMetadata: {},
            },
          },
        },
      } as never)
    );
    rejected(() =>
      store.appendExecutionEvent({
        executionId: input.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'effect_observation',
        workerSequence: 1,
        payload: {
          kind: 'effect_observation',
          correlation,
          sequence: 1,
          effect: {
            kind: 'tool_call',
            turn: 1,
            call: { callId: 'bad', arguments: '{}' },
          },
        },
      } as never)
    );
    rejected(() =>
      store.appendExecutionEvent({
        executionId: input.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: 1,
        payload: {
          kind: 'runtime_event',
          correlation,
          sequence: 1,
          event: {
            kind: 'agent_event',
            event: { kind: 'assistant_progress', turn: 1 },
          },
        },
      } as never)
    );
    rejected(() =>
      store.appendExecutionEvent({
        executionId: input.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        payload: {
          kind: 'commit_proposal',
          correlation,
          transcript: [{ role: 'not-a-message' }],
          nextTurn: 2,
        },
      } as never)
    );
    assertEquals(store.listExecutionEvents(input.executionId).length, 2);
    store.reconcileExecution({
      executionId: input.executionId,
      settlement: 'unknown',
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 refuses schema-v1 SQLite without compatibility reads', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i41-schema-v1-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  try {
    await Deno.mkdir(paths.root, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(`${paths.root}/history-v4.sqlite3`);
    db.exec('PRAGMA user_version = 1');
    db.close();
    let rejected = false;
    try {
      await new SqliteHistoryStore(stateRoot, workspaceRoot).initialize();
    } catch (error) {
      rejected = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(
      rejected,
      'schema-v1 evidence must not be read by the schema-v2 store',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 keeps a live no-session lock out of Session allocation and reconciles after release', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i41-no-session-lock-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const other = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const input = makeInput(
    '10000000-0000-4000-8000-000000000047',
    '20000000-0000-4000-8000-000000000047',
  );
  try {
    await store.initialize();
    await store.beginExecution(input);
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const lockNames: string[] = [];
    for await (const entry of Deno.readDir(`${paths.root}/locks-v4`)) {
      lockNames.push(entry.name);
    }
    assert(lockNames.includes(`.execution-${input.executionId}.lock`));
    assert(!lockNames.includes(`${input.executionId}.lock`));

    await other.initialize();
    assertEquals(other.readExecution(input.executionId).lifecycle, 'active');
    assertEquals(
      other.listExecutions().filter((row) => row.lifecycle === 'settled'),
      [],
    );

    store.reconcileExecution({
      executionId: input.executionId,
      settlement: 'unknown',
    });
    assertEquals(store.readExecution(input.executionId).outcome, 'unknown');
    await other.initialize();
    assertEquals(other.readExecution(input.executionId).lifecycle, 'settled');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 admits distinct no-session executions concurrently', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i41-distinct-executions-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const first = makeInput(
    '10000000-0000-4000-8000-000000000048',
    '20000000-0000-4000-8000-000000000048',
  );
  const second = makeInput(
    '10000000-0000-4000-8000-000000000049',
    '20000000-0000-4000-8000-000000000049',
  );
  const secondWithDistinctSession = {
    ...second,
    sessionCorrelation: '30000000-0000-4000-8000-000000000049',
    instanceCorrelation: 'i41-instance-2',
    workerGeneration: 'i41-generation-2',
  };
  try {
    await store.initialize();
    await Promise.all([
      store.beginExecution(first),
      store.beginExecution(secondWithDistinctSession),
    ]);
    assertEquals(
      store.listExecutions().filter((row) => row.lifecycle === 'active').map((
        row,
      ) => row.executionId).sort(),
      [first.executionId, second.executionId].sort(),
    );
    store.reconcileExecution({
      executionId: first.executionId,
      settlement: 'unknown',
    });
    store.reconcileExecution({
      executionId: second.executionId,
      settlement: 'unknown',
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 41 reopens a crashed persistent first turn without replaying dispatch', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i41-persistent-crash-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const reopenedStore = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const sessionId = '30000000-0000-4000-8000-000000000041';
  const input = makePersistentFirstTurnInput(
    '10000000-0000-4000-8000-000000000050',
    '20000000-0000-4000-8000-000000000050',
    sessionId,
    workspaceRoot,
  );
  try {
    await store.initialize();
    await store.beginExecution(input);
    assertEquals(store.readExecution(input.executionId).lifecycle, 'active');

    await reopenedStore.initialize();
    const handle = await reopenedStore.openExistingWorker(sessionId);
    try {
      assert(handle.record !== undefined);
      assertEquals(handle.record.sessionId, sessionId);
      assertEquals(
        reopenedStore.readExecution(input.executionId).outcome,
        'unknown',
      );
      assertEquals(
        reopenedStore.listExecutionEvents(input.executionId).map((event) => event.kind),
        ['execution_admitted', 'turn_dispatch_requested', 'execution_reconciled'],
      );
      assertEquals(
        reopenedStore.listExecutionEvents(input.executionId).some((event) =>
          event.kind === 'turn_dispatch_sent'
        ),
        false,
      );
    } finally {
      await handle.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
