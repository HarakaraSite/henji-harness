import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import {
  isCancellationCleanupError,
  isTurnCancelledError,
} from '../../v0/agent/core/cancellation.ts';
import {
  OpenRouterAgentModel,
  type OpenRouterAgentProfile,
} from '../../v0/agent/provider/openrouter_model.ts';
import { readResponseBody } from '../../v0/agent/provider/openrouter_response.ts';
import { readSseResponse } from '../../v0/agent/provider/openrouter_sse.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { roleDefaultModelSelection } from '../../v0/agent/provider/model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_host.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';

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

const request: ModelRequest = {
  transcript: [{ role: 'user', content: { kind: 'text', text: 'cancel streaming response' } }],
  tools: [],
};

const profile: OpenRouterAgentProfile = {
  id: 'increment-39-test',
  model: 'test/model',
  origin: 'https://openrouter.ai',
  path: '/api/v1/chat/completions',
  method: 'POST',
  secretEnv: 'HENJI_INCREMENT_39_TEST_KEY',
  maxCompletionTokens: 128,
  stream: false,
};

Deno.test('Increment 39 treats abort-error SSE read rejection as settled cancellation', async () => {
  const encoder = new TextEncoder();
  const turn = new AbortController();
  let progress!: () => void;
  const sawProgress = new Promise<void>((resolve) => {
    progress = resolve;
  });
  let requests = 0;
  const model = new OpenRouterAgentModel({
    profile,
    responseMode: 'sse',
    credential: 'dummy-test-credential',
    fetcher: (_input, init) => {
      requests += 1;
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"id":"cancel-stream","choices":[{"index":0,"delta":{"role":"assistant","content":"working"},"finish_reason":null}]}\n\n',
          ));
          signal?.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    },
  });

  const pending = model.generate(request, {
    signal: turn.signal,
    reportAssistantProgress: () => progress(),
  });
  await sawProgress;
  turn.abort('user cancelled');
  let observed: unknown;
  try {
    await pending;
  } catch (error) {
    observed = error;
  }
  assert(isTurnCancelledError(observed));
  assertEquals(requests, 1);
});

Deno.test('Increment 39 preserves a real active-reader cleanup failure', async () => {
  const encoder = new TextEncoder();
  let cancelAttempted = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: not-json\n\n'));
    },
    cancel() {
      cancelAttempted = true;
      throw new Error('simulated active reader cleanup failure');
    },
  });
  let observed: unknown;
  try {
    await readSseResponse(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
      undefined,
      () => true,
      () => false,
    );
  } catch (error) {
    observed = error;
  }
  assert(cancelAttempted);
  assert(isCancellationCleanupError(observed));
});

Deno.test('Increment 39 treats bounded body read rejection as terminally settled', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    },
  });
  assertEquals(await readResponseBody(new Response(body)), {
    kind: 'stream_error',
    cleanupFailed: false,
  });
});

class CleanupFailureCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<(message: WorkerToHostMessage) => void>();
  terminated = false;

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
      this.emit({
        kind: 'turn_failed',
        correlation: command.correlation,
        outcome: {
          ok: false,
          task: command.task,
          outcome: 'contract_failure',
          stopReason: 'contract_failure',
          error: 'cancellation cleanup failed',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
          diagnostic: {
            schemaVersion: 1,
            diagnosticId: '39393939-3939-4939-8939-393939393939',
            stage: 'cancellation_cleanup',
            code: 'cleanup_error',
            lane: 'parent',
            providerRequestCount: 1,
            occurredAt: '2026-09-12T00:00:00.000Z',
            turnNumber: 1,
            modelStep: 0,
            retryCount: 0,
          },
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

  terminate(): void {
    this.terminated = true;
  }
}

Deno.test('Increment 39 makes a genuine Worker cleanup failure unavailable after persistence', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-increment-39-worker-' });
  const history = new SqliteHistoryV7ProductionStore(stateRoot, Deno.cwd());
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let capsule: CleanupFailureCapsule | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      capsuleFactory: () => {
        capsule = new CleanupFailureCapsule();
        return capsule;
      },
    });
    const outcome = await created.session.submit('cleanup failure turn');
    assert(!outcome.ok);
    assertEquals(outcome.diagnostic?.stage, 'cancellation_cleanup');
    assert(!created.session.isAvailable());
    assert(capsule?.terminated);
    await history.initialize();
    const retained = history.listExecutions()[0];
    assertEquals(retained?.adoption, 'non_canonical');
    assertEquals(retained?.outcome, 'failed');
    assertEquals(retained?.outcomeJson?.error, 'cancellation cleanup failed');
    let retryRejected = false;
    try {
      await created.session.submit('must not reuse failed generation');
    } catch {
      retryRejected = true;
    }
    assert(retryRejected);
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
