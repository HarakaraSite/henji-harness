import type { LoopOutcome } from '../core/contracts.ts';
import type { AgentEventSink } from '../core/events.ts';
import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { WorkerHostCapsule } from './worker_host_contract.ts';
import { createWorkerSession } from './worker_tui_session.ts';

export interface HeadlessWorkerRun {
  readonly outcome: Omit<LoopOutcome, 'transcript'>;
  readonly requestCount: number;
}

export interface HeadlessWorkerRunOptions {
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
  readonly dataRoot?: string;
  readonly configRoot?: string;
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  readonly eventSink?: AgentEventSink;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
}

/** Run one nonpersistent turn through the same Host/Worker path as the terminal Surface. */
export const runHeadlessWorker = async (
  task: string,
  agentChoice: AgentConfigurationChoice,
  options: HeadlessWorkerRunOptions = {},
): Promise<HeadlessWorkerRun> => {
  const created = await createWorkerSession({
    workspaceRoot: options.workspaceRoot,
    stateRoot: options.stateRoot,
    dataRoot: options.dataRoot,
    configRoot: options.configRoot,
    persistence: 'none',
    agentChoice,
    physicalIoMode: options.physicalIoMode ?? 'production',
    rootMaxSteps: options.rootMaxSteps,
    providerTimeoutMs: options.providerTimeoutMs,
    eventSink: options.eventSink,
    capsuleFactory: options.capsuleFactory,
  });
  try {
    const outcome = await created.session.submit(task);
    return { outcome, requestCount: created.requestCount() };
  } finally {
    await created.close();
  }
};
