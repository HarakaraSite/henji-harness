import { WorkerSupervisor } from '../../../v0/agent/worker/worker_host_supervisor.ts';
import { builtinDefinitionRef } from '../../../v0/agent/definitions/managed_resource_ref.ts';
import { buildManifest } from '../../../v0/agent/runtime/build_manifest.ts';
import { createIncrement170FoundationDataHarness } from '../helpers/increment_170_foundation_data.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../../v0/agent/provider/openrouter_model_catalog.ts';

const harness = await createIncrement170FoundationDataHarness({
  prefix: 'henji-i170-startup-recovery-',
  definition: await builtinDefinitionRef('generic', buildManifest()),
});
const supervisor = new WorkerSupervisor({
  options: {
    data: harness.data,
    descriptor: harness.descriptor,
    workspaceRoot: harness.workspaceRoot,
    modulePath: '/tmp/henji-i138-missing-definition-' + crypto.randomUUID() + '.ts',
    physicalIoMode: 'provider-free',
  },
  projection: () => ({
    stateRevision: 1,
    modelSelection: ROOT_DEFAULT_MODEL_SELECTION,
  }),
  attachGeneration: (correlation) =>
    harness.data.attachGeneration(harness.descriptor.id, correlation),
  handleWorkerMessage: () => {},
  onGenerationReplaced: () => {},
});

try {
  await supervisor.start();
  throw new Error('missing Definition unexpectedly started');
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
  console.log('definition_not_found');
} finally {
  await supervisor.terminate();
  await harness.close();
}
await new Promise((resolve) => setTimeout(resolve, 0));
console.log('next_operation_reached');
