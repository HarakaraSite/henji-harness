import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { roleDefaultModelSelection } from '../../v0/agent/provider/model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { HistoryStoreError } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import {
  workerBuiltinModulePath,
  type WorkerHostCapsule,
  WorkerHostSession,
} from '../../v0/agent/worker/worker_host.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};
const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
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

const makeInput = (
  taskId: string,
  executionId: string,
  sessionCorrelation: string,
) => ({
  taskId,
  executionId,
  createdAt: '2026-09-19T00:00:00.000Z',
  sessionCorrelation,
  sessionMode: 'no_session' as const,
  turn: 1,
  task: 'batch journal',
  baseStateRevision: 1,
  agent: 'default' as const,
  model: ROOT_DEFAULT_MODEL_SELECTION,
  build: buildManifest(),
  definition,
  manifest,
  instanceCorrelation: 'instance-1',
  workerGeneration: 'generation-1',
});

const begin = async (
  prefix: string,
  taskId: string,
  executionId: string,
  sessionCorrelation: string,
): Promise<{ store: SqliteHistoryStore; executionId: string }> => {
  const root = await Deno.makeTempDir({ prefix });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  await store.initialize();
  await store.beginExecution(makeInput(taskId, executionId, sessionCorrelation));
  return { store, executionId };
};

const acknowledgement = (executionId: string, accepted: boolean) => ({
  executionId,
  direction: 'host_to_worker' as const,
  source: 'host' as const,
  kind: 'acknowledgement_requested' as const,
  payload: { accepted },
});

Deno.test('Increment 86 appends a batch with sequential ordinals in one transaction', async () => {
  const executionId = '50000000-0000-4000-8000-000000000086';
  const { store } = await begin(
    'henji-i86-batch-',
    '51000000-0000-4000-8000-000000000086',
    executionId,
    '30000000-0000-4000-8000-000000000086',
  );
  const batch = [
    acknowledgement(executionId, false),
    acknowledgement(executionId, true),
    acknowledgement(executionId, false),
  ];
  assert(batch.every((event) => store.validateExecutionEvent(event as never)));
  const before = store.listExecutionEvents(executionId).length;
  const stored = store.appendExecutionEvents(batch as never);
  assertEquals(
    stored.map((event) => event.ordinal),
    [before + 1, before + 2, before + 3],
  );
  const listed = store.listExecutionEvents(executionId);
  assertEquals(listed.length, before + 3);
  assertEquals(
    listed.slice(before).map((event) => event.kind),
    [
      'acknowledgement_requested',
      'acknowledgement_requested',
      'acknowledgement_requested',
    ],
  );
  const single = store.appendExecutionEvent(
    acknowledgement(executionId, true) as never,
  );
  assertEquals(single.ordinal, before + 4);
});

Deno.test('Increment 86 rejects a contract-invalid event and rolls back the whole batch', async () => {
  const executionId = '50000000-0000-4000-8000-000000000087';
  const { store } = await begin(
    'henji-i86-invalid-',
    '51000000-0000-4000-8000-000000000086',
    executionId,
    '30000000-0000-4000-8000-000000000087',
  );
  const invalid = {
    executionId,
    direction: 'host_to_worker' as const,
    source: 'host' as const,
    kind: 'acknowledgement_requested' as const,
    payload: { accepted: 'no' },
  };
  assert(!store.validateExecutionEvent(invalid as never));
  const before = store.listExecutionEvents(executionId).length;
  let rejected = false;
  try {
    store.appendExecutionEvents([
      acknowledgement(executionId, true) as never,
      invalid as never,
    ]);
  } catch (error) {
    rejected = error instanceof HistoryStoreError;
  }
  assert(rejected);
  assertEquals(store.listExecutionEvents(executionId).length, before);
});

class CountingStore extends SqliteHistoryStore {
  batchCalls = 0;
  singleCalls = 0;

  override appendExecutionEvents(
    inputs: Parameters<SqliteHistoryStore['appendExecutionEvents']>[0],
  ) {
    this.batchCalls += 1;
    return super.appendExecutionEvents(inputs);
  }

  override appendExecutionEvent(
    input: Parameters<SqliteHistoryStore['appendExecutionEvent']>[0],
  ) {
    this.singleCalls += 1;
    return super.appendExecutionEvent(input);
  }
}

class BurstCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<(message: WorkerToHostMessage) => void>();

  constructor(private readonly burst: number) {}

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
      queueMicrotask(() => {
        for (let sequence = 1; sequence <= this.burst; sequence += 1) {
          this.emit({
            kind: 'runtime_event',
            correlation: command.correlation,
            sequence,
            event: { kind: 'echo', payload: sequence },
          } as never);
        }
        this.emit({
          kind: 'commit_proposal',
          correlation: command.correlation,
          nextTurn: 2,
          transcript: [
            { role: 'user', content: { kind: 'text', text: command.task } },
            { role: 'assistant', content: { kind: 'text', text: 'done' } },
          ],
        } as never);
      });
      return;
    }
    if (command.kind === 'commit_acknowledgement' && command.accepted) {
      queueMicrotask(() =>
        this.emit({
          kind: 'runtime_event',
          correlation: command.correlation,
          sequence: this.burst + 1,
          event: {
            kind: 'agent_event',
            event: { kind: 'turn_end', turn: 1, outcome: 'final', committed: true },
          },
        } as never)
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

Deno.test('Increment 86 flushes a worker observation burst through the batch API', async () => {
  const burst = 600;
  const root = await Deno.makeTempDir({ prefix: 'henji-i86-burst-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new CountingStore(`${root}/state`, workspaceRoot);
  await store.initialize();
  const handle = await store.allocateWorker('default', definition);
  const host = await WorkerHostSession.open({
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
    capsuleFactory: () => new BurstCapsule(burst),
  });
  const outcome = await host.submit('burst');
  assert(outcome.ok, 'turn commits');
  assert(store.batchCalls >= 1, 'batch API is used for worker observations');
  assert(store.singleCalls < burst, `single appends: ${store.singleCalls}`);
  const row = store.listExecutions()[0];
  assert(row !== undefined);
  const events = store.listExecutionEvents(row.executionId);
  assertEquals(
    events.map((event) => event.ordinal),
    events.map((_, index) => index + 1),
  );
  const echoes = events.filter((event) => event.kind === 'runtime_event');
  assert(echoes.length >= burst, `runtime events: ${echoes.length}`);
  await host.close();
});
