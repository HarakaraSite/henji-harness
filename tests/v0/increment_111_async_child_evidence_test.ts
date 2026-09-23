import type { WorkerSessionHandle } from '../../v0/agent/session/session_store_contract.ts';
import type {
  HistoryPersistencePort,
  NonCanonicalExecutionInput,
} from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import {
  bundledToolDefinitionLoadRequests,
  readDefinitionRevision,
} from '../../v0/agent/worker/worker_definition_revision.ts';
import { historyCaptureProfileFor } from '../../v0/agent/worker/worker_tui_session.ts';
import { attributeProviderEvidenceV5 } from '../../v0/agent/worker/worker_history_projection.ts';
import type { ProviderEvidenceV1 } from '../../v0/agent/provider/provider_evidence.ts';
import type { LoopOutcome } from '../../v0/agent/core/contracts.ts';

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

Deno.test('provider evidence attribution preserves request data and its source', async () => {
  const evidence: ProviderEvidenceV1 = {
    schemaVersion: 1,
    evidenceId: 'evidence-1',
    turnNumber: 1,
    createdAt: '2026-09-23T00:00:00.000Z',
    requests: [{
      request: {
        ordinal: 1,
        lane: 'parent',
        modelStep: 1,
        endpoint: 'https://example.com/model',
        method: 'POST',
        requestBody: '{}',
        requestBodyBytes: 2,
        requestMetadata: { responseMode: 'sse' },
      },
      response: { status: 200, headers: {}, rawBody: 'data: done', rawBodyBytes: 10 },
      sseEvents: [],
      parserTransitions: [],
    }],
    runtimeEvents: [],
  };
  const original = structuredClone(evidence);
  const definition = await readDefinitionRevision('', 'builtin', 'planner');
  const attributed = attributeProviderEvidenceV5({
    evidence,
    outcome: { stopReason: 'final' } as LoopOutcome,
    sessionId: '00000000-0000-4000-8000-000000000001',
    build: buildManifest(),
    definition,
    hasContextBasis: false,
  });
  assertEquals(evidence, original);
  assertEquals(attributed.requests[0].request.contextRequestOrdinal, 1);
  assertEquals(attributed.requests[0].response?.rawBody, 'data: done');
  assert(attributed.requests[0] !== evidence.requests[0]);
  assert(attributed.requests[0].request !== evidence.requests[0].request);
});

const handle = (): WorkerSessionHandle => ({
  id: crypto.randomUUID().toLowerCase(),
  commit: () => {},
  rollback: () => {},
  installCheckpoint: () => {},
  rollbackCheckpoint: () => {},
  close: () => Promise.resolve(),
});

const registry = async (
  history: HistoryPersistencePort,
  rootMaxSteps?: number,
): Promise<ChildRunRegistry> => {
  const plannerRef = await readDefinitionRevision('', 'builtin', 'planner');
  return new ChildRunRegistry({
    options: {
      handle: handle(),
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition: plannerRef,
      physicalIoMode: 'provider-free',
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
      ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
    },
    catalog: [{ name: 'planner', ref: plannerRef }],
    history,
    build: buildManifest(),
  });
};

const withStore = async (
  name: string,
  run: (
    store: SqliteHistoryV7ProductionStore,
    workspaceRoot: string,
  ) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: `henji-i111-${name}-` });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(`${root}/state`, workspaceRoot, {
    captureProfile: 'diagnostic-v1',
  });
  await store.initialize();
  try {
    await run(store, workspaceRoot);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
};

Deno.test('Increment 111 persists completed child outcome and provider evidence', async () => {
  await withStore('completed', async (store) => {
    const children = await registry(store);
    const parentExecutionId = 'parent-i111-completed';
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      { kind: 'spawn', agent: 'planner', task: 'summarize the child task' },
      'spawn-i111-completed',
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    assertEquals(collected.result.state, 'completed');
    assertEquals(collected.result.stopReason, 'final');
    assertEquals(collected.result.providerRequestCount, 0);
    assertEquals(collected.result.providerEvidenceDurability, 'yes');
    assertEquals(collected.result.contextDurability, 'complete');
    assert(typeof collected.result.providerEvidenceId === 'string');

    const row = store.readExecution(spawned.runId);
    assertEquals(row.outcomeJson?.stopReason, 'final');
    assertEquals(row.outcomeJson?.steps, 1);
    assertEquals(row.outcomeJson?.turnProviderRequestCount, 0);
    assertEquals(row.providerEvidenceId, collected.result.providerEvidenceId);
    const evidence = await store.providerEvidence.read(row.providerEvidenceId!);
    assertEquals(evidence.schemaVersion, 5);
    assertEquals(evidence.sessionId, spawned.runId);
    assertEquals(evidence.definition, row.definition);
    await children.cleanupParent(parentExecutionId);
  });
});

Deno.test('Increment 111 preserves max-steps counts and structured diagnostic', async () => {
  await withStore('max-steps', async (store) => {
    const children = await registry(store, 2);
    const parentExecutionId = 'parent-i111-max-steps';
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      { kind: 'spawn', agent: 'planner', task: 'ten-step child task' },
      undefined,
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    assertEquals(collected.result.state, 'failed');
    assertEquals(collected.result.stopReason, 'max_steps');
    assertEquals(collected.result.providerRequestCount, 0);
    assertEquals(collected.result.diagnosticCode, 'model_step_limit');
    assertEquals(collected.result.providerEvidenceDurability, 'yes');
    assertEquals(collected.result.diagnosticDurability, 'yes');

    const row = store.readExecution(spawned.runId);
    assertEquals(row.outcomeJson?.stopReason, 'max_steps');
    assertEquals(row.outcomeJson?.steps, 2);
    assertEquals(row.outcomeJson?.toolCallCount, 2);
    assertEquals(row.outcomeJson?.toolResultCount, 2);
    assertEquals(row.outcomeJson?.turnProviderRequestCount, 0);
    assertEquals(row.diagnosticId, collected.result.diagnosticId);
    const diagnostic = await store.diagnostics.read(row.diagnosticId!);
    assertEquals(diagnostic.code, 'model_step_limit');
    assertEquals(
      await store.providerEvidence.readDiagnosticLink(row.diagnosticId!),
      row.providerEvidenceId,
    );
    await children.cleanupParent(parentExecutionId);
  });
});

Deno.test('Increment 111 preserves the Worker failure instead of a generic child error', async () => {
  await withStore('worker-failure', async (store) => {
    const children = await registry(store);
    const parentExecutionId = 'parent-i111-worker-failure';
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      { kind: 'spawn', agent: 'planner', task: 'child-fail task' },
      undefined,
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    assertEquals(collected.result.state, 'failed');
    assertEquals(collected.result.stopReason, 'contract_failure');
    assertEquals(
      collected.result.error,
      'model contract failure: child task failed on purpose',
    );
    assertEquals(collected.result.diagnosticCode, 'unknown_code');
    assertEquals(collected.result.providerEvidenceDurability, 'yes');
    assertEquals(collected.result.diagnosticDurability, 'yes');

    const row = store.readExecution(spawned.runId);
    assertEquals(row.outcomeJson?.error, collected.result.error);
    assertEquals(row.outcomeJson?.steps, 1);
    assertEquals(row.outcomeJson?.turnProviderRequestCount, 0);
    assertEquals((await store.diagnostics.read(row.diagnosticId!)).code, 'unknown_code');
    await children.cleanupParent(parentExecutionId);
  });
});

Deno.test('Increment 111 reports capture failure without changing semantic completion', async () => {
  await withStore('capture-failure', async (store) => {
    const history = new Proxy(store, {
      get(target, property) {
        if (property === 'settleNonCanonicalExecution') {
          return (input: NonCanonicalExecutionInput) => {
            const { evidence: _evidence, ...withoutEvidence } = input;
            target.settleNonCanonicalExecution(withoutEvidence);
            return {
              evidenceDurability: 'failed' as const,
              evidencePersistenceError: 'provider_evidence_invalid' as const,
            };
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as HistoryPersistencePort;
    const children = await registry(history);
    const parentExecutionId = 'parent-i111-capture-failure';
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      { kind: 'spawn', agent: 'planner', task: 'complete despite capture failure' },
      undefined,
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    assertEquals(collected.result.state, 'completed');
    assertEquals(collected.result.stopReason, 'final');
    assertEquals(collected.result.providerEvidenceDurability, 'failed');
    assertEquals(
      collected.result.providerEvidencePersistenceError,
      'provider_evidence_invalid',
    );
    assertEquals(store.readExecution(spawned.runId).outcome, 'completed');
    await children.cleanupParent(parentExecutionId);
  });
});

Deno.test('Increment 111 does not fabricate evidence for pre-start cancellation', async () => {
  let releaseAdmission!: () => void;
  let admissionStarted!: () => void;
  const barrier = new Promise<void>((resolve) => releaseAdmission = resolve);
  const started = new Promise<void>((resolve) => admissionStarted = resolve);
  let settlement: NonCanonicalExecutionInput | undefined;
  const history = {
    beginExecution: async () => {
      admissionStarted();
      await barrier;
    },
    settleNonCanonicalExecution: (input: NonCanonicalExecutionInput) => {
      settlement = input;
      return {};
    },
  } as unknown as HistoryPersistencePort;
  const children = await registry(history);
  const parentExecutionId = 'parent-i111-pre-start-cancel';
  children.openParent(parentExecutionId);
  const spawning = children.handle(
    { kind: 'spawn', agent: 'planner', task: 'never dispatched' },
    undefined,
    parentExecutionId,
  );
  await started;
  const cleanup = children.cleanupParent(parentExecutionId);
  releaseAdmission();
  const [spawned, cleaned] = await Promise.all([spawning, cleanup]);
  assert(!spawned.ok);
  assertEquals(cleaned?.runs[0].state, 'cancelled');
  assertEquals(settlement?.outcome.stopReason, 'cancelled');
  assertEquals(settlement?.evidence, undefined);
  assertEquals(settlement?.diagnostic, undefined);
});

Deno.test('Increment 111 defaults production to diagnostic capture and preserves overrides', () => {
  assertEquals(historyCaptureProfileFor('production'), 'diagnostic-v1');
  assertEquals(historyCaptureProfileFor('production', 'normal-v1'), 'normal-v1');
  assertEquals(historyCaptureProfileFor('provider-free'), undefined);
  assertEquals(historyCaptureProfileFor('provider-free', 'diagnostic-v1'), 'diagnostic-v1');
});
