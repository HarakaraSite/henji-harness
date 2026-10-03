import type { SessionControlSnapshot } from '../../api/contract.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import type { ApplicationQueryPort } from './application_port.ts';

/** Build only Core's small orientation and operation state. Conversation is encoded by Data. */
export const projectApplicationControl = (
  query: ApplicationQueryPort,
  cursor: { readonly coreEpoch: string; readonly revision: number },
): SessionControlSnapshot => {
  const current = query.currentSession();
  const selection = current.selection;
  const startup = current.workerStartup;
  return {
    schemaVersion: 2,
    cursor: { ...cursor, sessionId: current.sessionId },
    session: {
      id: current.sessionId,
      canonicalSessionId: current.persistence === 'none' ? null : current.sessionId,
      persistence: current.persistence === 'none' ? 'none' : 'persistent',
      position: current.position,
      selection: {
        provider: selection.provider,
        modelId: selection.modelId,
        effort: selection.effort,
      },
      startup: {
        ...current.startup,
        model: {
          provider: selection.provider,
          profileId: modelRouteProfileId(selection),
          modelId: selection.modelId,
          effort: selection.effort,
        },
        status: startup === undefined ? 'unevaluated' : 'evaluated',
        ...(startup === undefined ? {} : {
          instructions: {
            loaded: startup.instructionSource !== undefined,
            source: startup.instructionSource ?? 'none',
          },
          skills: { count: startup.skillNames.length, names: startup.skillNames, omitted: 0 },
        }),
      },
    },
    runtime: {
      active: current.runtime.active,
      activeSessionId: current.sessionId,
      phase: current.runtime.phase,
      execution: current.execution ?? null,
      operations: [],
      ...(current.effectiveConfig === undefined
        ? {}
        : { effectiveConfig: current.effectiveConfig }),
    },
    pending: current.pending ?? { kind: 'core-owned', followUps: [] },
    credentialAvailability: { status: current.credentialAvailability?.status ?? 'unknown' },
    context: {
      ...current.context,
      ...(current.position.checkpoint === undefined
        ? {}
        : { checkpoint: current.position.checkpoint }),
      ...(current.pendingRecall === undefined ? {} : { pendingRecall: current.pendingRecall }),
    },
  };
};
