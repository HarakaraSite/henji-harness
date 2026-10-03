import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import type {
  WorkerCorrelation,
  WorkerReadyMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import type { WorkerExecutionTraceEntry } from '../../v0/agent/worker/worker_execution_artifact.ts';

const readyFor = (correlation: WorkerCorrelation): WorkerReadyMessage => ({
  kind: 'ready',
  correlation,
  manifest: {
    role: 'parent',
    maxSteps: 4,
    profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
    resources: [],
    rootModel: ROOT_DEFAULT_MODEL_SELECTION,
  },
});

const openExecution = async (root: string, suffix: string) => {
  const stateRoot = `${root}/state`;
  const data = await createDataClient({ stateRoot, workspaceRoot: root });
  const definition = await builtinDefinitionRef('default', buildManifest());
  const descriptor = await data.openSession({
    persistence: 'new',
    agent: 'default',
    definition,
    initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
  });
  const executionId = crypto.randomUUID().toLowerCase();
  const correlation: WorkerCorrelation = {
    session: descriptor.id,
    instanceCorrelation: `i170-s3-terminal-${suffix}-instance`,
    workerGeneration: `i170-s3-terminal-${suffix}-generation`,
    baseStateRevision: descriptor.stateRevision,
    command: `i170-s3-terminal-${suffix}`,
  };
  const port = createAgentDataPortClient(
    await data.attachGeneration(descriptor.id, correlation),
  );
  await port.ready(readyFor(correlation));
  await data.executionAdmit(descriptor.id, {
    executionId,
    taskId: crypto.randomUUID().toLowerCase(),
    task: `terminal ${suffix}`,
    correlation,
    createdAt: new Date().toISOString(),
  });
  port.beginExecution(executionId, correlation);
  const trace: WorkerExecutionTraceEntry = {
    direction: 'host_to_worker',
    kind: 'turn',
    semanticSubtype: 'turn',
    sequence: 1,
    correlation,
  };
  await data.updateExecutionArtifactMetadata(descriptor.id, executionId, {
    protocolTrace: [trace],
  });
  return { data, descriptor, executionId, correlation, port, stateRoot };
};

const readSaved = async (
  stateRoot: string,
  workspaceRoot: string,
  executionId: string,
) => {
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, {
    readOnly: true,
  });
  await store.initialize();
  try {
    return {
      row: store.readExecutionMetadata(executionId),
      events: store.listExecutionEvents(executionId),
      artifact: await store.executionArtifacts.read(executionId),
    };
  } finally {
    store.close();
  }
};

Deno.test('Increment 170 S3 persists a noncanonical failure artifact and late control facts', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i170-s3-failure-control-',
  });
  const run = await openExecution(root, 'failure');
  try {
    const barrier = run.port.sendFailure({
      kind: 'turn_failed',
      correlation: run.correlation,
      outcome: {
        ok: false,
        task: 'terminal failure',
        outcome: 'contract_failure',
        stopReason: 'contract_failure',
        error: 'provider response failed',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
    });
    const terminal = await run.data.settleFailure(run.descriptor.id, {
      executionId: run.executionId,
      finalDataSequence: barrier.finalDataSequence,
    });
    strictEqual(terminal.durable, true);
    strictEqual(terminal.accepted, false);
    for (
      const input of [
        {
          controlSequence: 1,
          kind: 'turn_settled' as const,
          correlation: run.correlation,
          observedAt: '2026-10-03T00:00:01.000Z',
        },
        {
          controlSequence: 2,
          kind: 'process_cleanup_finished' as const,
          result: 'complete' as const,
          observedAt: '2026-10-03T00:00:02.000Z',
        },
        {
          controlSequence: 3,
          kind: 'post_commit_turn_end' as const,
          correlation: run.correlation,
          turn: 1,
          outcome: 'contract_failure' as const,
          committed: false,
          generationUnavailable: false,
          observedAt: '2026-10-03T00:00:03.000Z',
        },
      ]
    ) {
      await run.data.recordExecutionControl(
        run.descriptor.id,
        run.executionId,
        input,
      );
    }
    const live = (await run.data.executionRead(run.executionId)).execution;
    strictEqual(live.processSettlement, 'complete');
    strictEqual(live.durability.acknowledgement, 'not_sent');
  } finally {
    run.port.close();
    await run.data.close();
  }
  try {
    const saved = await readSaved(run.stateRoot, root, run.executionId);
    strictEqual(saved.row.artifactCapture, 'yes');
    ok(saved.artifact.schemaVersion === 7);
    strictEqual(saved.artifact.storeResult, 'not_attempted');
    strictEqual(saved.artifact.acknowledgement, 'not_sent');
    strictEqual(saved.artifact.settlement, 'uncommitted');
    strictEqual(saved.artifact.adoption, 'non_canonical');
    deepStrictEqual(saved.artifact.protocolTrace[0], {
      direction: 'host_to_worker',
      kind: 'turn',
      semanticSubtype: 'turn',
      sequence: 1,
      correlation: run.correlation,
    });
    const controls = saved.events.filter((event) =>
      event.kind === 'turn_settled' ||
      event.kind === 'process_cleanup_finished' ||
      event.kind === 'post_commit_turn_end'
    );
    deepStrictEqual(
      controls.map((event) => {
        const payload = event.payload;
        if (
          typeof payload !== 'object' || payload === null ||
          Array.isArray(payload)
        ) {
          throw new Error('control fact payload must be an object');
        }
        return [
          event.kind,
          (payload as Record<string, unknown>).controlSequence,
          event.observedAt,
        ];
      }),
      [
        ['turn_settled', 1, '2026-10-03T00:00:01.000Z'],
        ['process_cleanup_finished', 2, '2026-10-03T00:00:02.000Z'],
        ['post_commit_turn_end', 3, '2026-10-03T00:00:03.000Z'],
      ],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 170 S3 saves cancelled prefix artifact with sequenced cancel and cleanup facts', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i170-s3-cancel-control-',
  });
  const run = await openExecution(root, 'cancel');
  try {
    const terminal = await run.data.sealGeneration(run.descriptor.id, {
      executionId: run.executionId,
      decision: 'cancelled',
      reason: 'cancelled after the saved prefix',
    });
    strictEqual(terminal.durable, true);
    strictEqual(terminal.accepted, false);
    const controls = [
      {
        controlSequence: 1,
        kind: 'cancel_requested' as const,
        observedAt: '2026-10-03T00:00:01.000Z',
      },
      {
        controlSequence: 2,
        kind: 'cancel_sent' as const,
        observedAt: '2026-10-03T00:00:02.000Z',
      },
      {
        controlSequence: 3,
        kind: 'cancel_received' as const,
        correlation: run.correlation,
        workerSequence: 2,
        result: 'requested' as const,
        observedAt: '2026-10-03T00:00:03.456Z',
      },
      {
        controlSequence: 4,
        kind: 'process_cleanup_finished' as const,
        result: 'complete' as const,
        observedAt: '2026-10-03T00:00:04.000Z',
      },
      {
        controlSequence: 5,
        kind: 'post_commit_turn_end' as const,
        correlation: run.correlation,
        turn: 1,
        outcome: 'cancelled' as const,
        committed: false,
        generationUnavailable: true,
        observedAt: '2026-10-03T00:00:05.000Z',
      },
    ];
    for (const input of controls) {
      await run.data.recordExecutionControl(
        run.descriptor.id,
        run.executionId,
        input,
      );
    }
    const live = (await run.data.executionRead(run.executionId)).execution;
    strictEqual(live.processSettlement, 'complete');
  } finally {
    run.port.close();
    await run.data.close();
  }
  try {
    const saved = await readSaved(run.stateRoot, root, run.executionId);
    strictEqual(saved.row.artifactCapture, 'yes');
    ok(saved.artifact.schemaVersion === 7);
    strictEqual(saved.artifact.outcome?.stopReason, 'cancelled');
    strictEqual(saved.artifact.settlement, 'uncommitted');
    strictEqual(saved.artifact.adoption, 'non_canonical');
    ok(saved.artifact.protocolTrace.length === 1);
    const controls = saved.events.filter((event) =>
      event.kind === 'cancel_requested' || event.kind === 'cancel_sent' ||
      event.kind === 'cancel_received' ||
      event.kind === 'process_cleanup_finished' ||
      event.kind === 'post_commit_turn_end'
    );
    deepStrictEqual(
      controls.map((event) => {
        const payload = event.payload;
        if (
          typeof payload !== 'object' || payload === null ||
          Array.isArray(payload)
        ) {
          throw new Error('control fact payload must be an object');
        }
        return [
          event.kind,
          (payload as Record<string, unknown>).controlSequence,
          event.observedAt,
          (payload as Record<string, unknown>).observedAt,
        ];
      }),
      [
        ['cancel_requested', 1, '2026-10-03T00:00:01.000Z', undefined],
        ['cancel_sent', 2, '2026-10-03T00:00:02.000Z', undefined],
        [
          'cancel_received',
          3,
          '2026-10-03T00:00:03.456Z',
          '2026-10-03T00:00:03.456Z',
        ],
        [
          'process_cleanup_finished',
          4,
          '2026-10-03T00:00:04.000Z',
          undefined,
        ],
        [
          'post_commit_turn_end',
          5,
          '2026-10-03T00:00:05.000Z',
          undefined,
        ],
      ],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
