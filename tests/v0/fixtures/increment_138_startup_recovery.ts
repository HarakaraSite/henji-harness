import { WorkerSupervisor } from '../../../v0/agent/worker/worker_host_supervisor.ts';
import { WorkerHostStartupError } from '../../../v0/agent/worker/worker_host_supervisor.ts';
import { createIncrement170FoundationDataHarness } from '../helpers/increment_170_foundation_data.ts';

const harness = await createIncrement170FoundationDataHarness({
  prefix: 'henji-i170-startup-recovery-',
  agent: 'missing-agent',
  agentChoice: { name: 'missing-agent' },
});
const supervisorRef: { current?: WorkerSupervisor } = {};
const supervisor = new WorkerSupervisor({
  options: {
    data: harness.data,
    descriptor: harness.descriptor,
    workspaceRoot: harness.workspaceRoot,
    configRoot: `${harness.root}/config`,
    agentChoice: { name: 'missing-agent' },
    physicalIoMode: 'provider-free',
  },
  projection: () => ({
    stateRevision: 1,
    modelSelection: harness.descriptor.modelSelection,
  }),
  attachGeneration: (correlation) =>
    harness.data.attachGeneration(harness.descriptor.id, correlation),
  handleWorkerMessage: (message) => supervisorRef.current?.messages.publish(message),
  onGenerationReplaced: () => {},
});
supervisorRef.current = supervisor;

try {
  await supervisor.start();
  throw new Error('missing Agent unexpectedly started');
} catch (error) {
  if (!(error instanceof WorkerHostStartupError)) throw error;
  if (error.code !== 'configuration_rejected') throw error;
  console.log(error.code);
} finally {
  await supervisor.terminate();
  await harness.close();
}
await new Promise((resolve) => setTimeout(resolve, 0));
console.log('next_operation_reached');
