import {
  type ContextModelRequestDelta,
  contextOccurrenceDigest,
  contextRevisionDigest,
  textBlob,
} from '../../v0/agent/history/context_attribution.ts';
import {
  ParentTurnExecutionContext,
  TurnRequestBudget,
} from '../../v0/agent/core/execution_context.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import type { ProviderExactRequestObservation } from '../../v0/agent/core/contracts.ts';
import {
  type ExecutionEventInput,
  HistoryStoreError,
} from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryV6ProductionStore } from '../../v0/agent/history/sqlite_history_v6_production_store.ts';
import { SqliteHistoryV6Store } from '../../v0/agent/history/sqlite_history_v6_store.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { roleDefaultModelSelection } from '../../v0/agent/provider/model_catalog.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import {
  createWorkerSession,
  workerBuiltinModulePath,
  WorkerHostSession,
} from '../../v0/agent/worker/worker_host.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { createProductionPhysicalIo } from '../../v0/agent/worker/worker_physical_io.ts';
import { OpenRouterSonarWebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import {
  beginWorkerStageProbeEpoch,
  classifyWorkerStageSnapshot,
  createWorkerStageProbeBuffer,
  readWorkerStageSnapshot,
  recordWorkerStage,
  type WorkerStageHistorySnapshot,
  type WorkerStageName,
} from '../../v0/agent/worker/worker_stage_probe.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const auxiliaryDelta = async (): Promise<ContextModelRequestDelta> => {
  const blob = await textBlob('{"query":"stage probe"}', 'application/json');
  const occurrenceBase = {
    occurrenceId: 'stage-probe-provider-body',
    kind: 'provider_wire_body' as const,
    content: {
      digest: blob.digest,
      byteLength: blob.byteLength,
      mediaType: blob.mediaType,
    },
    sourceRelations: [{
      stage: 'projected' as const,
      resourceKind: 'provider_wire_body' as const,
      logicalIdentity: 'tool-call:stage-probe',
      callId: 'stage-probe',
      lane: 'parent' as const,
      modelStep: 1,
      contentDigest: blob.digest,
    }],
  };
  const occurrence = {
    ...occurrenceBase,
    occurrenceDigest: await contextOccurrenceDigest(occurrenceBase),
    bytesBase64: blob.bytes.toBase64(),
  };
  const splices = [{
    start: 0,
    deleteCount: 0,
    insertions: [{
      occurrenceId: occurrence.occurrenceId,
      occurrenceDigest: occurrence.occurrenceDigest,
    }],
  }];
  return {
    schemaVersion: 2,
    requestOrdinal: 1,
    lane: 'parent',
    purpose: 'web_search',
    modelStep: 1,
    sourceCallId: 'stage-probe',
    revisionDigest: await contextRevisionDigest({
      lane: 'parent',
      purpose: 'web_search',
      resultItemCount: 1,
      splices,
    }),
    resultItemCount: 1,
    splices,
    occurrences: [occurrence],
  };
};

class AuxiliaryGapCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();
  private stageBuffer: SharedArrayBuffer | undefined;
  private activeTurn: Extract<WorkerHostCommand, { kind: 'turn' }> | undefined;

  constructor(
    private readonly delta: ContextModelRequestDelta,
    private readonly emitProviderStart = false,
  ) {}

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      this.stageBuffer = command.diagnosticStageBuffer;
      this.emit({
        kind: 'ready',
        correlation: command.correlation,
        manifest: {
          role: 'parent',
          maxSteps: 8,
          profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
          resources: [],
          rootModel: ROOT_DEFAULT_MODEL_SELECTION,
          plannerModel: roleDefaultModelSelection('subagent:planner'),
          ...(command.baseInstruction === undefined ? {} : {
            baseInstruction: {
              slot: command.baseInstruction.slot,
              selectionSource: command.baseInstruction.selectionSource,
              ref: command.baseInstruction.ref,
              contentDigest: command.baseInstruction.contentDigest,
            },
          }),
        },
        startupSnapshot: { skillNames: [] },
        credentialAvailability: {
          authProfile: 'openrouter-api-key',
          status: 'unknown',
        },
      });
      return;
    }
    if (command.kind === 'turn') {
      this.activeTurn = command;
      assert(this.stageBuffer !== undefined);
      recordWorkerStage(this.stageBuffer, 'aux_context_post_entered', 1);
      this.emit({
        kind: 'context_observation',
        correlation: command.correlation,
        sequence: 1,
        observation: { kind: 'model_request_delta', delta: this.delta },
      });
      recordWorkerStage(this.stageBuffer, 'aux_context_post_returned', 1);
      recordWorkerStage(this.stageBuffer, 'aux_context_await_resumed');
      recordWorkerStage(this.stageBuffer, 'evidence_start_entered');
      recordWorkerStage(this.stageBuffer, 'provider_start_post_entered', 2);
      recordWorkerStage(this.stageBuffer, 'provider_start_post_returned', 2);
      if (this.emitProviderStart) {
        this.emit({
          kind: 'provider_observation',
          correlation: command.correlation,
          sequence: 2,
          turn: 1,
          observation: {
            kind: 'request_start',
            request: {
              ordinal: 1,
              contextRequestOrdinal: 1,
              lane: 'parent',
              phase: 'user_turn',
              modelStep: 1,
              endpoint: 'https://example.invalid/provider',
              method: 'POST',
              requestBody: '',
              requestBodyBytes: 0,
              requestMetadata: {
                origin: 'web_search',
                responseMode: 'json',
              },
            },
          },
        });
        recordWorkerStage(this.stageBuffer, 'aux_request_provider_entered');
        this.emit({
          kind: 'turn_failed',
          correlation: command.correlation,
          outcome: {
            ok: false,
            task: command.task,
            outcome: 'cancelled',
            stopReason: 'cancelled',
            steps: 0,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
          },
        });
      }
      return;
    }
    if (command.kind === 'cancel' && this.activeTurn !== undefined) {
      this.emit({
        kind: 'cancel_received',
        correlation: command.correlation,
        sequence: 3,
        result: 'requested',
      });
      this.emit({
        kind: 'turn_failed',
        correlation: this.activeTurn.correlation,
        outcome: {
          ok: false,
          task: this.activeTurn.task,
          outcome: 'cancelled',
          stopReason: 'cancelled',
          steps: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
      });
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

const journalDefinition = {
  schemaVersion: 1 as const,
  resourceKind: 'agent-definition' as const,
  resourceId: 'builtin/default',
  revision: { algorithm: 'sha256' as const, digest: '9'.repeat(64) },
};

type JournalCapsuleMode = 'silent' | 'effect' | 'proposal' | 'failed';

class JournalFailureCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();
  terminated = false;
  turnDispatches = 0;

  constructor(private readonly mode: JournalCapsuleMode) {}

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      this.emit({
        kind: 'ready',
        correlation: command.correlation,
        manifest: {
          role: 'parent',
          maxSteps: 8,
          profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
          resources: [],
          rootModel: ROOT_DEFAULT_MODEL_SELECTION,
          plannerModel: roleDefaultModelSelection('subagent:planner'),
        },
        startupSnapshot: { skillNames: [] },
        credentialAvailability: {
          authProfile: 'openrouter-api-key',
          status: 'unknown',
        },
      });
      return;
    }
    if (command.kind === 'turn') {
      this.turnDispatches += 1;
      if (this.mode === 'effect') {
        queueMicrotask(() =>
          this.emit({
            kind: 'effect_observation',
            correlation: command.correlation,
            sequence: 1,
            effect: {
              kind: 'tool_progress',
              turn: 1,
              callId: 'journal-failure-tool',
              name: 'web_search',
              text: 'buffered before journal failure',
            },
          })
        );
      } else if (this.mode === 'proposal') {
        queueMicrotask(() =>
          this.emit({
            kind: 'commit_proposal',
            correlation: command.correlation,
            nextTurn: 2,
            transcript: [
              { role: 'user', content: { kind: 'text', text: command.task } },
              {
                role: 'assistant',
                content: { kind: 'text', text: 'must not commit' },
              },
            ],
          })
        );
      } else if (this.mode === 'failed') {
        queueMicrotask(() =>
          this.emit({
            kind: 'turn_failed',
            correlation: command.correlation,
            outcome: {
              ok: false,
              task: command.task,
              outcome: 'cancelled',
              stopReason: 'cancelled',
              steps: 0,
              toolCallCount: 0,
              toolResultCount: 0,
              transcript: [],
            },
          })
        );
      }
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

  terminate(): void {
    this.terminated = true;
  }
}

class InjectedJournalFailureStore extends SqliteHistoryV6ProductionStore {
  private failed = false;

  constructor(
    stateRoot: string,
    workspaceRoot: string,
    private readonly code:
      | 'history_busy'
      | 'history_invalid'
      | 'history_io_failure',
    private readonly failureKind: ExecutionEventInput['kind'],
  ) {
    super(stateRoot, workspaceRoot);
  }

  private shouldFail(input: ExecutionEventInput): boolean {
    if (this.failed || input.kind !== this.failureKind) return false;
    if (
      input.kind === 'worker_stage_snapshot' &&
      (input.payload as { trigger?: string }).trigger !== 'terminal'
    ) return false;
    this.failed = true;
    return true;
  }

  override appendExecutionEvent(input: ExecutionEventInput) {
    if (this.shouldFail(input)) throw new HistoryStoreError(this.code);
    return super.appendExecutionEvent(input);
  }

  override appendExecutionEvents(inputs: readonly ExecutionEventInput[]) {
    if (inputs.some((input) => this.shouldFail(input))) {
      throw new HistoryStoreError(this.code);
    }
    return super.appendExecutionEvents(inputs);
  }
}

class InvalidObservationStore extends SqliteHistoryV6ProductionStore {
  override validateExecutionEvent(input: ExecutionEventInput): boolean {
    return input.kind === 'effect_observation' ? false : super.validateExecutionEvent(input);
  }
}

const openJournalFailureHost = async (
  store: SqliteHistoryV6ProductionStore,
  workspaceRoot: string,
  capsules: JournalFailureCapsule[],
  events: AgentEvent[],
): Promise<WorkerHostSession> => {
  await store.initialize();
  const handle = await store.allocateWorker('default', journalDefinition);
  let generation = 0;
  return await WorkerHostSession.open({
    handle,
    workspaceRoot,
    agent: 'default',
    definition: journalDefinition,
    modulePath: workerBuiltinModulePath('default'),
    physicalIoMode: 'provider-free',
    historyPersistence: store,
    providerEvidenceStore: store.providerEvidence,
    executionArtifactStore: store.executionArtifacts,
    durableCanonicalHistory: true,
    eventSink: (event) => events.push(event),
    capsuleFactory: () => capsules[Math.min(generation++, capsules.length - 1)],
  });
};

Deno.test('Increment 92 reads Worker atomic stages without a return message', async () => {
  const source = `
    import { recordWorkerStage } from ${
    JSON.stringify(
      new URL('../../v0/agent/worker/worker_stage_probe.ts', import.meta.url)
        .href,
    )
  };
    onmessage = (event) => recordWorkerStage(
      event.data,
      'provider_start_post_returned',
      23,
    );
  `;
  const worker = new Worker(
    new URL(`data:application/javascript,${encodeURIComponent(source)}`),
    { type: 'module' },
  );
  const buffer = createWorkerStageProbeBuffer();
  beginWorkerStageProbeEpoch(buffer, 7);
  worker.postMessage(buffer);
  const deadline = Date.now() + 2_000;
  let snapshot = readWorkerStageSnapshot(buffer);
  while (
    snapshot.stage !== 'provider_start_post_returned' && Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    snapshot = readWorkerStageSnapshot(buffer);
  }
  worker.terminate();
  assertEquals(snapshot.epoch, 7);
  assertEquals(snapshot.stage, 'provider_start_post_returned');
  assertEquals(snapshot.expectedWorkerSequence, 23);
});

Deno.test('Increment 92 classifies each observed source-to-durability boundary', () => {
  const snapshot = (
    stage: WorkerStageName,
    expectedWorkerSequence = 2,
    received = 1,
    buffered = 1,
    durable = 1,
  ): WorkerStageHistorySnapshot => ({
    schemaVersion: 1,
    trigger: 'auxiliary_gap',
    workerGeneration: '00000000-0000-4000-8000-000000000001',
    epoch: 1,
    stageOrdinal: 2,
    stage,
    expectedWorkerSequence,
    lastWorkerSequenceReceived: received,
    lastWorkerSequenceBuffered: buffered,
    lastWorkerSequenceDurable: durable,
  });
  assertEquals(
    classifyWorkerStageSnapshot(snapshot('aux_context_post_returned')),
    'worker_microtask_resume',
  );
  assertEquals(
    classifyWorkerStageSnapshot(snapshot('provider_start_post_entered')),
    'worker_message_enqueue',
  );
  assertEquals(
    classifyWorkerStageSnapshot(snapshot('provider_start_post_returned')),
    'worker_message_delivery',
  );
  assertEquals(
    classifyWorkerStageSnapshot(
      snapshot('provider_start_post_returned', 2, 2, 1, 1),
    ),
    'host_validation_or_buffer',
  );
  assertEquals(
    classifyWorkerStageSnapshot(
      snapshot('provider_start_post_returned', 2, 2, 2, 1),
    ),
    'history_flush_or_persistence',
  );
  assertEquals(
    classifyWorkerStageSnapshot(
      snapshot('credential_resolve_entered', 0, 2, 2, 2),
    ),
    'credential_resolution',
  );
  assertEquals(
    classifyWorkerStageSnapshot(snapshot('fetch_entered', 0, 2, 2, 2)),
    'provider_fetch',
  );
  assertEquals(
    classifyWorkerStageSnapshot(snapshot('fetch_call_returned', 0, 2, 2, 2)),
    'provider_fetch',
  );
  assertEquals(
    classifyWorkerStageSnapshot(
      snapshot('response_body_read_entered', 0, 2, 2, 2),
    ),
    'provider_response_body',
  );
});

Deno.test('Increment 92 records production auxiliary I/O stage order without payloads', async () => {
  const stages: WorkerStageName[] = [];
  const io = createProductionPhysicalIo(undefined, {
    credentialSource: () => Promise.resolve('test-credential'),
    reportAuxiliaryStage: (stage) => stages.push(stage),
    fetcher: () => Promise.resolve(new Response('ok')),
  });
  assert(io.requestProvider !== undefined);
  const response = await io.requestProvider({
    authProfile: 'openrouter-api-key',
    endpoint: 'https://example.invalid/provider',
    method: 'POST',
  });
  assertEquals(new TextDecoder().decode(response.bytes), 'ok');
  assertEquals(stages, [
    'aux_request_provider_entered',
    'credential_resolve_entered',
    'credential_resolve_returned',
    'fetch_entered',
    'fetch_call_returned',
    'response_headers_received',
    'response_body_read_entered',
    'response_body_read_returned',
  ]);
});

Deno.test('Increment 92 captures the exact auxiliary body before fetching the same bytes', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i92-exact-auxiliary-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV6ProductionStore(stateRoot, workspaceRoot);
  await store.initialize();
  const executionId = '92000000-0000-4000-8000-000000000092';
  const taskId = '92000000-0000-4000-8000-000000000093';
  const admitted = {
    taskId,
    executionId,
    createdAt: '2026-09-21T00:00:00.000Z',
    sessionCorrelation: 'increment-92-exact-auxiliary',
    turn: 1,
    task: 'capture exact auxiliary body',
    baseStateRevision: 1,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    definition: journalDefinition,
  };
  await store.beginExecution({ ...admitted, sessionMode: 'no_session' });
  const order: string[] = [];
  let observed: ProviderExactRequestObservation | undefined;
  let fetched: Uint8Array | undefined;
  let workerSequence = 0;
  const correlation = {
    session: admitted.sessionCorrelation,
    instanceCorrelation: 'increment-92-instance',
    workerGeneration: 'increment-92-generation',
    baseStateRevision: 1,
    command: 'turn-1',
  } as const;
  const evidence = new ProviderEvidenceRecorder(
    '92000000-0000-4000-8000-000000000001',
    1,
    '2026-09-21T00:00:00.000Z',
    undefined,
    (observation) => {
      if (observation.kind !== 'request_start') return undefined;
      workerSequence += 1;
      store.appendExecutionEvent({
        executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'provider_request_start',
        workerSequence,
        payload: {
          kind: 'provider_observation',
          correlation,
          sequence: workerSequence,
          turn: 1,
          observation,
        },
      });
      return workerSequence;
    },
  );
  const execution = new ParentTurnExecutionContext(
    1,
    new TurnRequestBudget(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    evidence,
    undefined,
    undefined,
    undefined,
    () => 1,
    undefined,
    undefined,
    undefined,
    (observation) => {
      order.push('exact');
      observed = observation;
      workerSequence += 1;
      store.appendExactRequestObservation({
        executionId,
        workerSequence,
        observation,
      });
    },
  );
  const io = createProductionPhysicalIo(undefined, {
    credentialSource: () => Promise.resolve('test-credential'),
    fetcher: (_input, init) => {
      order.push('fetch');
      assert(init?.body instanceof Uint8Array);
      fetched = init.body;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: 'captured answer',
                annotations: [{
                  type: 'url_citation',
                  url_citation: {
                    title: 'Captured source',
                    url: 'https://example.invalid/source',
                  },
                }],
              },
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  });
  assert(io.requestProvider !== undefined);
  const backend = new OpenRouterSonarWebSearchBackend({
    requestProvider: io.requestProvider,
    endpoint: 'https://example.invalid/search',
  });
  const result = await backend.search('exact auxiliary bytes', {
    modelExecution: execution,
    modelStep: 2,
    callId: 'exact-auxiliary',
  });

  assertEquals(result.answer, 'captured answer');
  assertEquals(order, ['exact', 'fetch']);
  assert(observed !== undefined);
  assert(
    fetched === observed.bytes,
    'fetch did not receive the observed byte instance',
  );
  assertEquals(
    observed.captureBoundary,
    'openrouter-chat:auxiliary-http-body-v1',
  );
  assertEquals(observed.serializerVersion, 'json-stringify-utf8-v1');
  assert(
    new TextDecoder().decode(observed.bytes).includes('exact auxiliary bytes'),
  );
  assertEquals(evidence.snapshot().requests[0].request.requestBody, '');
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const db = new DatabaseSync(`${paths.root}/history-v6.sqlite3`, { readOnly: true });
  const stream = db.prepare(
    'SELECT stream_id FROM byte_streams WHERE execution_id = ?',
  ).get(executionId) as { stream_id: string } | undefined;
  db.close();
  assert(stream !== undefined, 'v6 did not retain the auxiliary byte stream');
  const durableEvents = JSON.stringify(store.listExecutionEvents(executionId));
  assert(!durableEvents.includes('test-credential'));
  assert(!durableEvents.toLowerCase().includes('authorization'));
  const exactStore = new SqliteHistoryV6Store(`${paths.root}/history-v6.sqlite3`);
  try {
    assertEquals(await exactStore.readByteStream(stream.stream_id), observed.bytes);
  } finally {
    exactStore.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 92 emits no auxiliary evidence before credential and cancellation checks pass', async () => {
  for (const mode of ['missing', 'cancelled'] as const) {
    let fetches = 0;
    let exactCaptures = 0;
    const evidence = new ProviderEvidenceRecorder(
      mode === 'missing'
        ? '92000000-0000-4000-8000-000000000002'
        : '92000000-0000-4000-8000-000000000003',
      1,
      '2026-09-21T00:00:00.000Z',
    );
    const controller = new AbortController();
    if (mode === 'cancelled') controller.abort('cancel before dispatch');
    const execution = new ParentTurnExecutionContext(
      1,
      new TurnRequestBudget(),
      controller.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      evidence,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => exactCaptures += 1,
    );
    const io = createProductionPhysicalIo(undefined, {
      credentialSource: () => mode === 'missing' ? undefined : 'test-credential',
      fetcher: () => {
        fetches += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    assert(io.requestProvider !== undefined);
    let failed = false;
    try {
      await io.requestProvider({
        authProfile: 'openrouter-api-key',
        endpoint: 'https://example.invalid/search',
        method: 'POST',
        body: new TextEncoder().encode('{}'),
        signal: controller.signal,
        evidence: {
          execution,
          phase: 'user_turn',
          modelStep: 1,
          requestMetadata: { origin: 'web_search' },
          captureBoundary: 'test-boundary',
          serializerVersion: 'test-v1',
        },
      });
    } catch {
      failed = true;
    }
    assert(failed);
    assertEquals(fetches, 0);
    assertEquals(exactCaptures, 0);
    assertEquals(evidence.snapshot().requests.length, 0);
  }
});

Deno.test('Increment 92 persists an auxiliary gap with receive buffer and durable cursors', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-increment-92-' });
  const history = new SqliteHistoryV6ProductionStore(stateRoot, Deno.cwd());
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    const delta = await auxiliaryDelta();
    created = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      auxiliaryStageGapMs: 10,
      capsuleFactory: () => new AuxiliaryGapCapsule(delta),
    });
    const pending = created.session.submit('stage probe gap');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    await history.initialize();
    const row = history.listExecutionsForSession(created.session.sessionId)[0];
    assert(row !== undefined);
    const gap = history.listExecutionEvents(row.executionId).find((event) =>
      event.kind === 'worker_stage_snapshot' &&
      (event.payload as { trigger?: string }).trigger === 'auxiliary_gap'
    );
    assert(gap !== undefined);
    const snapshot = gap.payload as unknown as WorkerStageHistorySnapshot;
    assertEquals(snapshot.stage, 'provider_start_post_returned');
    assertEquals(snapshot.expectedWorkerSequence, 2);
    assertEquals(snapshot.lastWorkerSequenceReceived, 1);
    assertEquals(snapshot.lastWorkerSequenceBuffered, 1);
    assertEquals(snapshot.lastWorkerSequenceDurable, 1);
    assertEquals(
      classifyWorkerStageSnapshot(snapshot),
      'worker_message_delivery',
    );

    assertEquals(created.session.cancelActiveTurn(), 'requested');
    assertEquals((await pending).stopReason, 'cancelled');
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 92 cancels the gap watchdog when provider start reaches Host', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-92-normal-',
  });
  const history = new SqliteHistoryV6ProductionStore(stateRoot, Deno.cwd());
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    const delta = await auxiliaryDelta();
    created = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      auxiliaryStageGapMs: 10,
      capsuleFactory: () => new AuxiliaryGapCapsule(delta, true),
    });
    const pending = created.session.submit('normal provider start');
    assertEquals((await pending).stopReason, 'cancelled');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    await history.initialize();
    const row = history.listExecutionsForSession(created.session.sessionId)[0];
    assert(row !== undefined);
    assert(
      !history.listExecutionEvents(row.executionId).some((event) =>
        event.kind === 'worker_stage_snapshot' &&
        (event.payload as { trigger?: string }).trigger === 'auxiliary_gap'
      ),
    );
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

const withinOneSecond = async <T>(pending: Promise<T>): Promise<T> =>
  await Promise.race([
    pending,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error('execution did not settle within one second')),
        1_000,
      )
    ),
  ]);

Deno.test('Increment 92 latches pre-wait journal failures and replaces the generation', async () => {
  for (
    const [index, code] of (['history_busy', 'history_invalid', 'history_io_failure'] as const)
      .entries()
  ) {
    const root = await Deno.makeTempDir({
      prefix: `henji-i92-prewait-${index}-`,
    });
    const workspaceRoot = `${root}/workspace`;
    await Deno.mkdir(workspaceRoot);
    const store = new InjectedJournalFailureStore(
      `${root}/state`,
      workspaceRoot,
      code,
      'turn_dispatch_sent',
    );
    const first = new JournalFailureCapsule('silent');
    const replacement = new JournalFailureCapsule('failed');
    const events: AgentEvent[] = [];
    let host: WorkerHostSession | undefined;
    try {
      host = await openJournalFailureHost(store, workspaceRoot, [
        first,
        replacement,
      ], events);
      const outcome = await withinOneSecond(host.submit(`pre-wait ${code}`));
      assert(!outcome.ok);
      assertEquals(outcome.executionJournalDurability, 'failed');
      assertEquals(outcome.executionJournalPersistenceError, code);
      assert(first.terminated);
      assertEquals(
        events.filter((event) => event.kind === 'turn_end').length,
        1,
      );
      const turnEnd = events.find((event) => event.kind === 'turn_end');
      assert(turnEnd?.kind === 'turn_end');
      assertEquals(turnEnd.executionJournalDurability, 'failed');
      assertEquals(turnEnd.executionJournalPersistenceError, code);
      const firstArtifact = (await store.executionArtifacts.list()).find((artifact) =>
        artifact.outcome?.executionJournalPersistenceError === code
      );
      assert(firstArtifact !== undefined, 'typed journal failure was not retained in v6');

      const next = await withinOneSecond(
        host.submit('replacement generation turn'),
      );
      assertEquals(next.stopReason, 'cancelled');
      assertEquals(replacement.turnDispatches, 1);
      const rows = store.listExecutionsForSession(host.sessionId);
      assertEquals(rows[0].adoption, 'non_canonical');
      assertEquals(rows[0].lifecycle, 'settled');
    } finally {
      await host?.close();
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('Increment 92 wakes an existing waiter when a buffered append fails', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i92-buffer-failure-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new InjectedJournalFailureStore(
    `${root}/state`,
    workspaceRoot,
    'history_io_failure',
    'effect_observation',
  );
  const capsule = new JournalFailureCapsule('effect');
  const events: AgentEvent[] = [];
  let host: WorkerHostSession | undefined;
  try {
    host = await openJournalFailureHost(
      store,
      workspaceRoot,
      [capsule],
      events,
    );
    const outcome = await withinOneSecond(host.submit('buffer append failure'));
    assertEquals(outcome.executionJournalDurability, 'failed');
    assertEquals(
      outcome.executionJournalPersistenceError,
      'history_io_failure',
    );
    assert(capsule.terminated);
    assertEquals(events.filter((event) => event.kind === 'turn_end').length, 1);
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 92 blocks canonical commit when the terminal snapshot append fails', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i92-terminal-failure-',
  });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new InjectedJournalFailureStore(
    `${root}/state`,
    workspaceRoot,
    'history_busy',
    'worker_stage_snapshot',
  );
  const capsule = new JournalFailureCapsule('proposal');
  const events: AgentEvent[] = [];
  let host: WorkerHostSession | undefined;
  try {
    host = await openJournalFailureHost(
      store,
      workspaceRoot,
      [capsule],
      events,
    );
    const outcome = await withinOneSecond(
      host.submit('terminal snapshot failure'),
    );
    assertEquals(outcome.executionJournalDurability, 'failed');
    assertEquals(outcome.executionJournalPersistenceError, 'history_busy');
    const row = store.listExecutionsForSession(host.sessionId)[0];
    assertEquals(row.adoption, 'non_canonical');
    assertEquals(row.lifecycle, 'settled');
    assertEquals(events.filter((event) => event.kind === 'turn_end').length, 1);
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 92 converts validation false into a typed journal failure', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i92-validation-failure-',
  });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new InvalidObservationStore(`${root}/state`, workspaceRoot);
  const capsule = new JournalFailureCapsule('effect');
  const events: AgentEvent[] = [];
  let host: WorkerHostSession | undefined;
  try {
    host = await openJournalFailureHost(
      store,
      workspaceRoot,
      [capsule],
      events,
    );
    const outcome = await withinOneSecond(host.submit('invalid observed fact'));
    assertEquals(outcome.executionJournalDurability, 'failed');
    assertEquals(outcome.executionJournalPersistenceError, 'history_invalid');
    assert(capsule.terminated);
    assertEquals(events.filter((event) => event.kind === 'turn_end').length, 1);
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});
import { DatabaseSync } from 'node:sqlite';
