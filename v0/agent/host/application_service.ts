import type { FollowUpRecord } from '../../api/contract.ts';
import { ApplicationTaskService } from './task_service.ts';
import type { ApplicationObservation, ApplicationObservationSink } from './application_port.ts';
import {
  createWorkerSession,
  type WorkerSessionOptions,
  type WorkerSessionResult,
} from '../worker/worker_tui_session.ts';

export interface ApplicationService extends WorkerSessionResult {
  readonly tasks: ApplicationTaskService;
  subscribe(listener: ApplicationObservationSink): () => void;
}

/** Composition owner for one in-process Host Session and its query/observation ports. */
export const createApplicationService = async (
  options: WorkerSessionOptions & {
    readonly persistFollowUp?: (record: FollowUpRecord) => Promise<void>;
    readonly persistTaskCompletion?: (control: {
      readonly executionId: string;
      readonly sessionId: string;
      readonly submittedByCommandId: string;
      readonly processSettlement: 'running' | 'complete';
    }) => Promise<void>;
  },
): Promise<ApplicationService> => {
  const listeners = new Set<ApplicationObservationSink>();
  const upstream = options.applicationObservationSink;
  const taskOwner: { current?: ApplicationTaskService } = {};
  const publish = (observation: ApplicationObservation): void => {
    taskOwner.current?.observe(observation);
    try {
      upstream?.(observation);
    } catch {
      // An observer cannot interrupt the existing Worker and history path.
    }
    for (const listener of listeners) {
      try {
        listener(structuredClone(observation));
      } catch {
        // One view cannot interrupt other views or the application service.
      }
    }
  };
  const runtime = await createWorkerSession({
    ...options,
    applicationObservationSink: publish,
  });
  const owner = new ApplicationTaskService(
    runtime.currentSession,
    (executionChanges = []) => {
      publish({
        kind: 'task_state',
        sessionId: runtime.currentSession().sessionId,
        executionChanges,
      });
    },
    options.persistTaskCompletion,
    options.persistFollowUp,
  );
  taskOwner.current = owner;
  return {
    ...runtime,
    tasks: owner,
    close: () => owner.close(runtime.close),
    query: {
      ...runtime.query,
      currentSession() {
        const current = runtime.query.currentSession();
        return {
          ...current,
          pending: owner.pendingView(current.sessionId),
          runtime: {
            active: current.runtime.active || owner.isBusy(),
            phase: owner.isPreparing()
              ? 'preparing'
              : current.runtime.phase === 'idle' && owner.isBusy()
              ? 'settling'
              : current.runtime.phase,
          },
        };
      },
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
