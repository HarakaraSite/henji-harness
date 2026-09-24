import type { LoopOutcome } from '../core/contracts.ts';
import type { AgentEventSink } from '../core/events.ts';
import type { HostDefinitionSelection } from '../definitions/definition_selection.ts';
import type { BuiltinAgentSelection } from '../definitions/agent_catalog.ts';
import type { FailureDiagnosticPersister } from '../session/failure_diagnostic.ts';
import type { WorkerHostCapsule } from './worker_host_contract.ts';
import type { WorkerExecutionArtifactStore } from './worker_execution_artifact_store.ts';
import { createWorkerSession } from './worker_tui_session.ts';

export interface HeadlessWorkerRun {
  readonly outcome: LoopOutcome;
  readonly requestCount: number;
}

export interface HeadlessWorkerRunOptions {
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
  readonly dataRoot?: string;
  readonly configRoot?: string;
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly eventSink?: AgentEventSink;
  readonly diagnosticPersistence?: FailureDiagnosticPersister;
  readonly executionArtifactStore?: WorkerExecutionArtifactStore;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
}

/** Run one nonpersistent turn through the same Host/Worker path as the terminal Surface. */
export const runHeadlessWorker = async (
  task: string,
  selection: HostDefinitionSelection | BuiltinAgentSelection,
  options: HeadlessWorkerRunOptions = {},
): Promise<HeadlessWorkerRun> => {
  const created = await createWorkerSession({
    workspaceRoot: options.workspaceRoot,
    stateRoot: options.stateRoot,
    dataRoot: options.dataRoot,
    configRoot: options.configRoot,
    persistence: 'none',
    ...('kind' in selection ? { selection } : { agent: selection.id }),
    physicalIoMode: options.physicalIoMode ?? 'production',
    rootMaxSteps: options.rootMaxSteps,
    eventSink: options.eventSink,
    diagnosticPersistence: options.diagnosticPersistence,
    executionArtifactStore: options.executionArtifactStore,
    capsuleFactory: options.capsuleFactory,
  });
  try {
    const outcome = await created.session.submit(task);
    return { outcome, requestCount: created.requestCount() };
  } finally {
    await created.close();
  }
};
