import { WorkerSupervisor } from '../../../v0/agent/worker/worker_host_supervisor.ts';
import { builtinDefinitionRef } from '../../../v0/agent/definitions/managed_resource_ref.ts';
import { buildManifest } from '../../../v0/agent/runtime/build_manifest.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../../v0/agent/provider/openrouter_model_catalog.ts';

const supervisor = new WorkerSupervisor({
  options: {
    handle: {
      id: crypto.randomUUID(),
      commit: () => {},
      rollback: () => {},
      installCheckpoint: () => {},
      rollbackCheckpoint: () => {},
      close: () => Promise.resolve(),
    },
    workspaceRoot: Deno.cwd(),
    agent: 'default',
    definition: await builtinDefinitionRef('generic', buildManifest()),
    modulePath: '/tmp/henji-i138-missing-definition-' + crypto.randomUUID() + '.ts',
    physicalIoMode: 'provider-free',
  },
  projection: () => ({
    transcript: [],
    nextTurn: 1,
    stateRevision: 1,
    modelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    privateStateFromTurn: 1,
  }),
  handleWorkerMessage: () => {},
  onGenerationReplaced: () => {},
});

try {
  await supervisor.start(() => {});
  throw new Error('missing Definition unexpectedly started');
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
  console.log('definition_not_found');
} finally {
  await supervisor.terminate();
}
await new Promise((resolve) => setTimeout(resolve, 0));
console.log('next_operation_reached');
