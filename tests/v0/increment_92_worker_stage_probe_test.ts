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
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_host.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { createProductionPhysicalIo } from '../../v0/agent/worker/worker_physical_io.ts';
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
  private auxiliaryStageGapMs: number | undefined;
  private activeTurn: Extract<WorkerHostCommand, { kind: 'turn' }> | undefined;
  private agentData: ReturnType<typeof createAgentDataPortClient> | undefined;
  private startup: Promise<void> | undefined;

  constructor(
    private readonly delta: ContextModelRequestDelta,
    private readonly emitProviderStart = false,
    private readonly settleOnCancel = true,
  ) {}

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      this.stageBuffer = command.diagnosticStageBuffer;
      this.auxiliaryStageGapMs = command.auxiliaryStageGapMs;
      this.startup = (async () => {
        if (command.dataPort === undefined) {
          throw new Error('Core did not transfer the Agent Data port');
        }
        const data = createAgentDataPortClient(command.dataPort);
        this.agentData = data;
        const basis = await data.generationContext(command.correlation);
        const rootModel = command.modelSelection ?? basis.modelSelection ??
          ROOT_DEFAULT_MODEL_SELECTION;
        const ready = {
          kind: 'ready',
          correlation: command.correlation,
          manifest: {
            role: 'parent',
            maxSteps: command.rootMaxSteps ?? 8,
            profileId: modelRouteProfileId(rootModel),
            resources: [],
            rootModel,
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
            authProfile: rootModel.authProfile,
            status: 'unknown',
          },
        } as const;
        await data.ready(ready);
        this.emit(ready);
      })();
      void this.startup.catch((error) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: error instanceof Error ? error.message : String(error),
        })
      );
      return;
    }
    if (command.kind === 'turn') {
      this.activeTurn = command;
      void (async () => {
        await this.startup;
        const data = this.agentData;
        if (data === undefined || command.executionId === undefined) {
          throw new Error('Agent Data execution identity is unavailable');
        }
        data.beginExecution(
          command.executionId,
          command.correlation,
          this.stageBuffer,
          this.auxiliaryStageGapMs,
        );
        assert(this.stageBuffer !== undefined);
        const contextSequence = this.emitProviderStart ? 1 : 7;
        const expectedProviderSequence = this.emitProviderStart ? 2 : 8;
        // The first direct DataPort message has Data sequence 1 while the Worker
        // observation sequence is 7; stage snapshots must preserve the latter axis.
        recordWorkerStage(
          this.stageBuffer,
          'aux_context_post_entered',
          contextSequence,
        );
        data.observation({
          kind: 'context_observation',
          correlation: command.correlation,
          sequence: contextSequence,
          observation: { kind: 'model_request_delta', delta: this.delta },
        });
        recordWorkerStage(
          this.stageBuffer,
          'aux_context_post_returned',
          contextSequence,
        );
        recordWorkerStage(this.stageBuffer, 'aux_context_await_resumed');
        recordWorkerStage(this.stageBuffer, 'evidence_start_entered');
        recordWorkerStage(
          this.stageBuffer,
          'provider_start_post_entered',
          expectedProviderSequence,
        );
        recordWorkerStage(
          this.stageBuffer,
          'provider_start_post_returned',
          expectedProviderSequence,
        );
        if (this.emitProviderStart) {
          data.observation({
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
                requestMetadata: {
                  origin: 'web_search',
                  responseMode: 'json',
                },
              },
            },
          });
          recordWorkerStage(this.stageBuffer, 'aux_request_provider_entered');
          this.sendCancelledFailure(command, data);
        }
      })().catch((error) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'turn',
          message: error instanceof Error ? error.message : String(error),
        })
      );
      return;
    }
    if (command.kind === 'cancel' && this.activeTurn !== undefined) {
      this.emit({
        kind: 'cancel_received',
        correlation: command.correlation,
        sequence: 3,
        observedAt: new Date().toISOString(),
        result: 'requested',
      });
      const turn = this.activeTurn;
      void this.startup?.then(() => {
        const data = this.agentData;
        if (data === undefined || turn.executionId === undefined) return;
        if (this.settleOnCancel) this.sendCancelledFailure(turn, data);
      });
      return;
    }
    if (command.kind === 'close') {
      this.emit({ kind: 'closed', correlation: command.correlation });
      return;
    }
    if (command.kind === 'commit_acknowledgement') {
      if (!command.accepted && this.activeTurn !== undefined) {
        this.agentData?.observation({
          kind: 'runtime_event',
          correlation: command.correlation,
          sequence: 4,
          event: {
            kind: 'agent_event',
            event: {
              kind: 'turn_end',
              turn: 1,
              outcome: 'cancelled',
              committed: false,
            },
          },
        });
      }
      queueMicrotask(() => this.emit({ kind: 'turn_settled', correlation: command.correlation }));
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.agentData?.close();
  }

  private sendCancelledFailure(
    command: Extract<WorkerHostCommand, { kind: 'turn' }>,
    data: ReturnType<typeof createAgentDataPortClient>,
  ): void {
    const barrier = data.sendFailure({
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
    this.emit({
      kind: 'failure_ready',
      executionId: command.executionId!,
      correlation: command.correlation,
      finalDataSequence: barrier.finalDataSequence,
    });
  }
}

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
    credentialSources: {
      'openrouter-api-key': () => Promise.resolve('test-credential'),
    },
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

Deno.test('Increment 92 emits no auxiliary evidence before credential and cancellation checks pass', async () => {
  for (const mode of ['missing', 'cancelled'] as const) {
    let fetches = 0;
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
    );
    const io = createProductionPhysicalIo(undefined, {
      credentialSources: {
        'openrouter-api-key': () => mode === 'missing' ? undefined : 'test-credential',
      },
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
        },
      });
    } catch {
      failed = true;
    }
    assert(failed);
    assertEquals(fetches, 0);
    assertEquals(evidence.snapshot().requests.length, 0);
  }
});

Deno.test('Increment 92 persists an auxiliary gap with receive buffer and durable cursors', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-increment-92-' });
  const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
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
    assertEquals(snapshot.expectedWorkerSequence, 8);
    assertEquals(snapshot.lastWorkerSequenceReceived, 7);
    assertEquals(snapshot.lastWorkerSequenceBuffered, 7);
    assertEquals(snapshot.lastWorkerSequenceDurable, 7);
    assertEquals(
      classifyWorkerStageSnapshot(snapshot),
      'worker_message_delivery',
    );

    assertEquals(created.session.cancelActiveTurn(), 'requested');
    assertEquals((await pending).stopReason, 'cancelled');
    const settledEvents = history.listExecutionEvents(row.executionId);
    assert(
      settledEvents.some((event) =>
        event.kind === 'worker_stage_snapshot' &&
        (event.payload as { trigger?: string }).trigger === 'cancel_requested'
      ),
    );
    assert(
      settledEvents.some((event) =>
        event.kind === 'worker_stage_snapshot' &&
        (event.payload as { trigger?: string }).trigger === 'terminal'
      ),
    );
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 92 cancels the gap watchdog when provider start reaches Host', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-92-normal-',
  });
  const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
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
    const events = history.listExecutionEvents(row.executionId);
    assert(events.some((event) => event.kind === 'provider_request_start'));
    const coordinator = Reflect.get(created.session, 'coordinator') as object;
    const supervisor = Reflect.get(coordinator, 'supervisor') as object;
    const messages = Reflect.get(supervisor, 'messages') as object;
    const queued = Reflect.get(messages, 'queue') as WorkerToHostMessage[];
    assertEquals(queued.length, 0);
    assert(
      !events.some((event) =>
        event.kind === 'worker_stage_snapshot' &&
        (event.payload as { trigger?: string }).trigger === 'auxiliary_gap'
      ),
    );
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 92 persists escalation and terminal stage snapshots', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-92-escalation-',
  });
  const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    const delta = await auxiliaryDelta();
    created = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 10,
      auxiliaryStageGapMs: 10,
      capsuleFactory: () => new AuxiliaryGapCapsule(delta, false, false),
    });
    const pending = created.session.submit('stage probe escalation');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assertEquals(created.session.cancelActiveTurn(), 'requested');
    assertEquals((await pending).stopReason, 'interrupted');

    await history.initialize();
    const row = history.listExecutionsForSession(created.session.sessionId)[0];
    assert(row !== undefined);
    const events = history.listExecutionEvents(row.executionId);
    for (const trigger of ['cancel_requested', 'cancel_escalated', 'terminal']) {
      assert(
        events.some((event) =>
          event.kind === 'worker_stage_snapshot' &&
          (event.payload as { trigger?: string }).trigger === trigger
        ),
        `missing ${trigger} stage snapshot`,
      );
    }
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
