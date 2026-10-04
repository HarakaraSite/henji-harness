import { deepStrictEqual, strictEqual } from 'node:assert';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import {
  buildManifest,
  type BuildManifestV1,
  installBuildManifest,
} from '../../v0/agent/runtime/build_manifest.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import type { WorkerCorrelation } from '../../v0/agent/worker/worker_protocol.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const buildWithDistinctSourceRevision = async (): Promise<BuildManifestV1> => {
  const current = buildManifest();
  const identity: Omit<BuildManifestV1, 'buildId'> = {
    schemaVersion: current.schemaVersion,
    productVersion: current.productVersion,
    sourceRevision: 'increment-181-data-worker-forwarding-test',
    sourceDirty: current.sourceDirty,
    denoVersion: current.denoVersion,
    target: current.target,
    embeddedRuntimeSha256: current.embeddedRuntimeSha256,
    agentConfigurationSchemaVersion: current.agentConfigurationSchemaVersion,
    supportedToolApiContracts: current.supportedToolApiContracts,
    supportedHookApiContracts: current.supportedHookApiContracts,
  };
  const bytes = new TextEncoder().encode(
    `henji-build-v1\0${JSON.stringify(identity)}`,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes),
  );
  const buildId = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { ...identity, buildId };
};

Deno.test('Increment 181 passes the Host build identity through Data Worker initialization into execution history', async () => {
  const expectedBuild = await buildWithDistinctSourceRevision();
  installBuildManifest(expectedBuild);

  const root = await Deno.makeTempDir({ prefix: 'henji-181-data-build-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  let port: ReturnType<typeof createAgentDataPortClient> | undefined;
  let executionId: string | undefined;
  try {
    const descriptor = await data.openSession({
      persistence: 'new',
      agent: 'default',
      agentChoice: {},
    });
    const correlation: WorkerCorrelation = {
      session: descriptor.id,
      instanceCorrelation: crypto.randomUUID(),
      workerGeneration: crypto.randomUUID(),
      baseStateRevision: descriptor.stateRevision,
      command: 'increment-181-build-forwarding',
    };
    port = createAgentDataPortClient(
      await data.attachGeneration(descriptor.id, correlation),
    );
    await port.ready({
      kind: 'ready',
      correlation,
      configuration: workerConfigurationFixture(),
      manifest: {
        role: 'parent',
        maxSteps: 1,
        profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
        resources: [],
        rootModel: ROOT_DEFAULT_MODEL_SELECTION,
      },
    });

    executionId = crypto.randomUUID().toLowerCase();
    await data.executionAdmit(descriptor.id, {
      executionId,
      taskId: crypto.randomUUID().toLowerCase(),
      task: 'persist the Host build identity',
      correlation,
    });
    port.beginExecution(executionId, correlation);
    const terminal = await data.sealGeneration(descriptor.id, {
      executionId,
      decision: 'interrupted',
      reason: 'finish build identity readback test',
    });
    strictEqual(terminal.durable, true);
  } finally {
    port?.close();
    await data.close();
  }

  try {
    const store = new SqliteHistoryStore(stateRoot, workspaceRoot, { readOnly: true });
    await store.initialize();
    try {
      if (executionId === undefined) throw new Error('execution was not admitted');
      deepStrictEqual(store.readExecution(executionId).build, expectedBuild);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
