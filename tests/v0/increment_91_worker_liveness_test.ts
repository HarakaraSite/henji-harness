import { isTurnCancelledError } from '../../v0/agent/core/cancellation.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { createProductionPhysicalIo } from '../../v0/agent/worker/worker_physical_io.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { selectModelFor } from '../../v0/agent/provider/model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
import { foundationProposal } from './helpers/increment_170_foundation_data.ts';

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

const canonicalRecord = async (
  stateRoot: string,
  workspaceRoot: string,
  sessionId: string,
) => {
  const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  try {
    await history.initialize();
    return await history.readWorker(sessionId);
  } finally {
    history.close();
  }
};

abstract class ProbeCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();
  terminated = false;
  protected agentData: ReturnType<typeof createAgentDataPortClient> | undefined;
  private startup: Promise<void> | undefined;

  protected emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  protected ready(
    command: Extract<WorkerHostCommand, { readonly kind: 'start' }>,
  ): Promise<void> {
    this.startup = (async () => {
      if (command.dataPort === undefined) {
        throw new Error('Core did not transfer the Agent Data port');
      }
      const agentData = createAgentDataPortClient(command.dataPort);
      this.agentData = agentData;
      const basis = await agentData.generationContext(command.correlation);
      const rootModel = command.modelSelection ?? basis.modelSelection ??
        ROOT_DEFAULT_MODEL_SELECTION;
      const message = {
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
      await agentData.ready(message);
      this.emit(message);
    })();
    return this.startup;
  }

  protected async beginTurn(
    command: Extract<WorkerHostCommand, { readonly kind: 'turn' }>,
  ): Promise<NonNullable<ProbeCapsule['agentData']>> {
    await this.startup;
    const agentData = this.agentData;
    if (agentData === undefined || command.executionId === undefined) {
      throw new Error('Agent Data execution identity is unavailable');
    }
    agentData.beginExecution(command.executionId, command.correlation);
    return agentData;
  }

  abstract send(command: WorkerHostCommand): void;

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
    this.agentData?.close();
  }
}

class NoCancelReceiptCapsule extends ProbeCapsule {
  turnStarted!: () => void;
  readonly sawTurn = new Promise<void>((resolve) => this.turnStarted = resolve);
  sentClose = false;

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      void this.ready(command).catch((error) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: error instanceof Error ? error.message : String(error),
        })
      );
    } else if (command.kind === 'turn') {
      void this.beginTurn(command).then(() => this.turnStarted()).catch((
        error,
      ) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'turn',
          message: error instanceof Error ? error.message : String(error),
        })
      );
    } else if (command.kind === 'close') this.sentClose = true;
  }
}

class NoPostCommitSettlementCapsule extends ProbeCapsule {
  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      void this.ready(command).catch((error) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: error instanceof Error ? error.message : String(error),
        })
      );
      return;
    }
    if (command.kind !== 'turn') return;
    void this.beginTurn(command).then((data) => {
      for (let ordinal = 1; ordinal <= 7; ordinal += 1) {
        data.observation({
          kind: 'provider_observation',
          correlation: command.correlation,
          sequence: ordinal,
          turn: 1,
          observation: {
            kind: 'request_start',
            request: {
              ordinal,
              lane: 'parent',
              phase: 'user_turn',
              modelStep: ordinal,
              endpoint: 'https://example.invalid/provider',
              method: 'POST',
              requestMetadata: {
                origin: 'root_model',
                responseMode: 'json',
              },
            },
          },
        });
        this.emit({
          kind: 'request_started',
          correlation: command.correlation,
          sequence: ordinal,
          requestOrdinal: ordinal,
          modelStep: ordinal,
        });
      }
      const proposal = foundationProposal({
        correlation: command.correlation,
        task: command.task,
        turn: 1,
        transcript: [
          { role: 'user', content: { kind: 'text', text: command.task } },
          {
            role: 'assistant',
            content: {
              kind: 'text',
              text: 'committed before settlement timeout',
            },
          },
        ],
        outcome: {
          ok: true,
          outcome: 'final',
          stopReason: 'final',
          finalText: 'committed before settlement timeout',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          runtimeProviderRequestCount: 7,
        },
      });
      const barrier = data.sendProposal(proposal);
      this.emit({
        kind: 'proposal_ready',
        correlation: command.correlation,
        proposalId: barrier.proposalId,
        finalDataSequence: barrier.finalDataSequence,
      });
    }).catch((error) =>
      this.emit({
        kind: 'worker_error',
        correlation: command.correlation,
        stage: 'turn',
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

class NoModelSelectionReplyCapsule extends ProbeCapsule {
  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      void this.ready(command).catch((error) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
}

class PartialObservationCapsule extends ProbeCapsule {
  turnStarted!: () => void;
  readonly sawTurn = new Promise<void>((resolve) => this.turnStarted = resolve);
  private turnCommand:
    | Extract<WorkerHostCommand, { readonly kind: 'turn' }>
    | undefined;

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      void this.ready(command).catch((error) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: error instanceof Error ? error.message : String(error),
        })
      );
      return;
    }
    if (command.kind !== 'turn') return;
    this.turnCommand = command;
    void this.beginTurn(command).then((data) => {
      data.observation({
        kind: 'effect_observation',
        correlation: command.correlation,
        sequence: 1,
        effect: {
          kind: 'tool_call',
          turn: 1,
          call: {
            callId: 'stalled-web-search',
            name: 'web_search',
            arguments: { query: 'durable partial observation' },
          },
        },
      });
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
            modelStep: 1,
            endpoint: 'https://example.invalid/search',
            method: 'POST',
            requestMetadata: {
              origin: 'web_search',
              responseMode: 'json',
            },
          },
        },
      });
      this.turnStarted();
    }).catch((error) =>
      this.emit({
        kind: 'worker_error',
        correlation: command.correlation,
        stage: 'turn',
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }

  emitLateProposal(): void {
    const command = this.turnCommand;
    if (command === undefined) return;
    this.emit({
      kind: 'proposal_ready',
      correlation: command.correlation,
      proposalId: 'stale-proposal-after-generation-close',
      finalDataSequence: 2,
    });
  }
}

Deno.test('Increment 91 applies the provider deadline to auxiliary fetch and body read', async () => {
  let started!: () => void;
  const fetchStarted = new Promise<void>((resolve) => started = resolve);
  const io = createProductionPhysicalIo(undefined, {
    credentialSources: {
      'openrouter-api-key': () => Promise.resolve('test-credential'),
    },
    providerTimeoutMs: 15,
    fetcher: (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  });
  assert(io.requestProvider !== undefined);
  const pending = io.requestProvider({
    authProfile: 'openrouter-api-key',
    endpoint: 'https://example.invalid/provider',
    method: 'POST',
  });
  await fetchStarted;
  let observed: unknown;
  try {
    await pending;
  } catch (error) {
    observed = error;
  }
  assert(observed instanceof Error);
  assertEquals(observed.message, 'provider deadline exceeded');
});

Deno.test('Increment 91 keeps the provider deadline active while reading an auxiliary response body', async () => {
  const io = createProductionPhysicalIo(undefined, {
    credentialSources: {
      'openrouter-api-key': () => Promise.resolve('test-credential'),
    },
    providerTimeoutMs: 15,
    fetcher: (_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            },
          }),
        ),
      ),
  });
  assert(io.requestProvider !== undefined);
  let observed: unknown;
  try {
    await io.requestProvider({
      authProfile: 'openrouter-api-key',
      endpoint: 'https://example.invalid/provider',
      method: 'POST',
    });
  } catch (error) {
    observed = error;
  }
  assert(observed instanceof Error);
  assertEquals(observed.message, 'provider deadline exceeded');
});

Deno.test('Increment 91 keeps user cancellation authoritative for auxiliary provider I/O', async () => {
  const turn = new AbortController();
  let started!: () => void;
  const fetchStarted = new Promise<void>((resolve) => started = resolve);
  const io = createProductionPhysicalIo(undefined, {
    credentialSources: {
      'openrouter-api-key': () => Promise.resolve('test-credential'),
    },
    providerTimeoutMs: 5_000,
    fetcher: (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  });
  assert(io.requestProvider !== undefined);
  const pending = io.requestProvider({
    authProfile: 'openrouter-api-key',
    endpoint: 'https://example.invalid/provider',
    method: 'POST',
    signal: turn.signal,
  });
  await fetchStarted;
  turn.abort('user cancelled');
  let observed: unknown;
  try {
    await pending;
  } catch (error) {
    observed = error;
  }
  assert(isTurnCancelledError(observed));
});

Deno.test('Increment 91 preserves graceful cancellation within the settlement grace', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-91-graceful-',
  });
  const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
  let progress!: () => void;
  const sawProgress = new Promise<void>((resolve) => progress = resolve);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 500,
      eventSink: (event) => {
        if (event.kind === 'assistant_progress') progress();
      },
    });
    const cancelled = created.session.submit('slow graceful cancellation');
    await sawProgress;
    assertEquals(created.session.cancelActiveTurn(), 'requested');
    const outcome = await cancelled;
    assertEquals(outcome.stopReason, 'cancelled');
    assert(created.session.isAvailable());

    const next = await created.session.submit('after graceful cancellation');
    assert(next.ok);

    await history.initialize();
    const rows = history.listExecutionsForSession(created.session.sessionId);
    assertEquals(rows.map((row) => row.outcome), ['cancelled', 'completed']);
    assertEquals(rows[0].workerGeneration, rows[1].workerGeneration);
    const kinds = history.listExecutionEvents(rows[0].executionId).map((
      event,
    ) => event.kind);
    assert(kinds.includes('cancel_requested'));
    assert(kinds.includes('cancel_received'));
    assert(!kinds.includes('cancel_escalated'));
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 91 force-interrupts an uncooperative turn and replaces its generation', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-increment-91-' });
  const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
  let progress!: () => void;
  const sawProgress = new Promise<void>((resolve) => progress = resolve);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 20,
      eventSink: (event) => {
        if (event.kind === 'assistant_progress') progress();
      },
    });
    const interrupted = created.session.submit('very-slow turn');
    await sawProgress;
    assertEquals(created.session.cancelActiveTurn(), 'requested');
    assertEquals(created.session.cancelActiveTurn(), 'already_requested');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assertEquals(created.session.cancelActiveTurn(), 'already_requested');
    const outcome = await interrupted;
    assertEquals(outcome.stopReason, 'interrupted');
    assert(!outcome.ok);
    assert(created.session.isAvailable());
    const interruptedRecord = await canonicalRecord(
      stateRoot,
      Deno.cwd(),
      created.session.sessionId,
    );
    assertEquals(interruptedRecord.nextTurn, 1);
    assertEquals(interruptedRecord.stateRevision, 1);
    assertEquals(interruptedRecord.transcript, []);

    const next = await created.session.submit('after forced interruption');
    assert(next.ok);
    assertEquals(next.stopReason, 'final');
    assertEquals(next.finalText, 'worker answer: after forced interruption');
    const committedRecord = await canonicalRecord(
      stateRoot,
      Deno.cwd(),
      created.session.sessionId,
    );
    assertEquals(committedRecord.nextTurn, 2);
    assertEquals(committedRecord.transcript.length, 2);

    await history.initialize();
    const rows = history.listExecutionsForSession(created.session.sessionId);
    assertEquals(rows.map((row) => row.outcome), ['interrupted', 'completed']);
    const events = history.listExecutionEvents(rows[0].executionId);
    const kinds = events.map((event) => event.kind);
    assert(kinds.includes('cancel_requested'));
    assert(kinds.includes('cancel_sent'));
    assert(kinds.includes('cancel_received'));
    assert(kinds.includes('cancel_escalated'));
    assertEquals(kinds.at(-1), 'post_commit_turn_end');
    const artifact = (await history.executionArtifacts.list()).find((value) =>
      value.executionId === rows[0].executionId
    );
    assert(artifact !== undefined && artifact.schemaVersion === 7);
    assertEquals(artifact.normalizedOutcome, 'interrupted');
    assertEquals(artifact.outcome?.stopReason, 'interrupted');
  } finally {
    await created?.close();
    history.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 91 escalates when the Worker cannot acknowledge cancel', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-91-no-ack-',
  });
  let first: NoCancelReceiptCapsule | undefined;
  let generation = 0;
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 20,
      capsuleFactory: (url) => {
        generation += 1;
        if (generation === 1) {
          first = new NoCancelReceiptCapsule();
          return first;
        }
        return new WorkerCapsule(url);
      },
    });
    const pending = created.session.submit(
      'turn whose Worker stops receiving messages',
    );
    await first?.sawTurn;
    assertEquals(created.session.cancelActiveTurn(), 'requested');
    const outcome = await pending;
    assertEquals(outcome.stopReason, 'interrupted');
    assert(first?.terminated);
    const next = await created.session.submit(
      'replacement after no cancel receipt',
    );
    assert(next.ok);

    const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
    await history.initialize();
    const firstRow = history.listExecutionsForSession(created.session.sessionId)[0];
    const kinds = history.listExecutionEvents(firstRow.executionId).map((
      event,
    ) => event.kind);
    assert(!kinds.includes('cancel_received'));
    assert(kinds.includes('cancel_escalated'));
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 91 closes a terminated generation without waiting for a Worker reply', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-91-close-terminated-',
  });
  let first: NoCancelReceiptCapsule | undefined;
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      persistence: 'none',
      agent: 'default',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 20,
      capsuleFactory: () => {
        first = new NoCancelReceiptCapsule();
        return first;
      },
    });
    const pending = created.session.submit('turn stopped before close');
    await first?.sawTurn;
    assertEquals(created.session.cancelActiveTurn(), 'requested');
    assertEquals((await pending).stopReason, 'interrupted');
    await created.close();
    assert(!first?.sentClose);
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 91 retains partial facts and fences a terminated generation', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-91-partial-',
  });
  let first: PartialObservationCapsule | undefined;
  let generation = 0;
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 20,
      capsuleFactory: (url) => {
        generation += 1;
        if (generation === 1) {
          first = new PartialObservationCapsule();
          return first;
        }
        return new WorkerCapsule(url);
      },
    });
    const pending = created.session.submit(
      'partial observations before interruption',
    );
    await first?.sawTurn;
    assertEquals(created.session.cancelActiveTurn(), 'requested');
    assertEquals((await pending).stopReason, 'interrupted');
    const interruptedRecord = await canonicalRecord(
      stateRoot,
      Deno.cwd(),
      created.session.sessionId,
    );
    assertEquals(interruptedRecord.nextTurn, 1);
    assertEquals(interruptedRecord.stateRevision, 1);
    assertEquals(interruptedRecord.transcript, []);

    const next = await created.session.submit(
      'canonical turn after partial interruption',
    );
    assert(next.ok);
    const canonical = await canonicalRecord(
      stateRoot,
      Deno.cwd(),
      created.session.sessionId,
    );
    assertEquals(canonical.nextTurn, 2);
    assertEquals(canonical.transcript.length, 2);
    first?.emitLateProposal();
    await Promise.resolve();
    assertEquals(
      await canonicalRecord(stateRoot, Deno.cwd(), created.session.sessionId),
      canonical,
    );

    const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
    await history.initialize();
    const interrupted = history.listExecutionsForSession(created.session.sessionId)[0];
    assertEquals(interrupted.contextCapture, 'partial');
    assertEquals(history.listExecutionEffects(interrupted.executionId), [{
      executionId: interrupted.executionId,
      callId: 'stalled-web-search',
      name: 'web_search',
      requestedEventOrdinal: 2,
      status: 'outcome_unknown',
    }]);
    const artifact = (await history.executionArtifacts.list()).find((value) =>
      value.executionId === interrupted.executionId
    );
    assert(artifact !== undefined && artifact.schemaVersion === 7);
    assertEquals(artifact.normalizedOutcome, 'interrupted');
    assertEquals(artifact.outcome?.stopReason, 'interrupted');
    history.close();
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 91 preserves a canonical commit when post-commit settlement times out', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-91-post-commit-',
  });
  let generation = 0;
  let first: NoPostCommitSettlementCapsule | undefined;
  const created = await createWorkerSession({
    stateRoot,
    persistence: 'new',
    agent: 'default',
    physicalIoMode: 'provider-free',
    workerResponseTimeoutMs: 20,
    capsuleFactory: (url) => {
      generation += 1;
      if (generation === 1) {
        first = new NoPostCommitSettlementCapsule();
        return first;
      }
      return new WorkerCapsule(url);
    },
  });
  try {
    const committed = await created.session.submit('commit then stop');
    assert(committed.ok);
    assertEquals(committed.finalText, 'committed before settlement timeout');
    assertEquals(committed.runtimeProviderRequestCount, 7);
    assertEquals(created.session.requestCount(), 7);
    assert(first?.terminated);
    const committedRecord = await canonicalRecord(
      stateRoot,
      Deno.cwd(),
      created.session.sessionId,
    );
    assertEquals(committedRecord.nextTurn, 2);
    assertEquals(committedRecord.transcript.length, 2);
    assertEquals(committedRecord.transcript.at(-1)?.role, 'assistant');
    assertEquals(
      committedRecord.transcript.at(-1)?.content,
      { kind: 'text', text: 'committed before settlement timeout' },
    );
    const next = await created.session.submit('turn after post-commit timeout');
    assert(next.ok);
    assertEquals(next.runtimeProviderRequestCount, 7);
    assertEquals(created.session.requestCount(), 7);
    const resumed = await canonicalRecord(
      stateRoot,
      Deno.cwd(),
      created.session.sessionId,
    );
    assertEquals(resumed.nextTurn, 3);
  } finally {
    await created.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 91 rolls back an unacknowledged model selection and replaces the generation', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-91-model-',
  });
  let generation = 0;
  let first: NoModelSelectionReplyCapsule | undefined;
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    const seed = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
    });
    assert(
      (await seed.session.submit('materialize model rollback session')).ok,
    );
    const sessionId = seed.session.sessionId;
    await seed.close();
    created = await createWorkerSession({
      stateRoot,
      persistence: 'session',
      sessionId,
      agent: 'default',
      physicalIoMode: 'provider-free',
      workerResponseTimeoutMs: 20,
      capsuleFactory: (url) => {
        generation += 1;
        if (generation === 1) {
          first = new NoModelSelectionReplyCapsule();
          return first;
        }
        return new WorkerCapsule(url);
      },
    });
    assertEquals(
      await created.session.selectModel(
        selectModelFor('openai-responses', 'gpt-5.6-terra', 'high'),
      ),
      'unavailable',
    );
    assert(first?.terminated);
    assertEquals(
      created.session.modelSelectionSnapshot(),
      ROOT_DEFAULT_MODEL_SELECTION,
    );
    const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
    await history.initialize();
    assertEquals(
      (await history.readWorker(created.session.sessionId)).activeModel,
      ROOT_DEFAULT_MODEL_SELECTION,
    );
    const next = await created.session.submit(
      'turn after model selection timeout',
    );
    assert(next.ok);
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
