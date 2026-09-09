import type {
  PresentationPosition,
  PresentationProjection,
  PresentationStartupState,
} from './contract.ts';

/** Build the neutral retained-screen projection from the runtime's already-resolved facts. */
export const presentationProjectionFromStartup = (
  startup: PresentationStartupState,
  position: PresentationPosition | undefined,
  capabilities: PresentationProjection['capabilities'] = {
    canNavigate: false,
    canHistory: false,
    canCompact: false,
  },
): PresentationProjection =>
  Object.freeze({
    lifecycle: 'starting',
    agentId: startup.agentId,
    sessionId: position?.sessionId,
    committedTurn: position?.committedTurn ?? 0,
    workspace: startup.workspace,
    model: Object.freeze({
      provider: startup.model.provider,
      modelId: startup.model.modelId,
      effort: startup.model.effort,
    }),
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    checkpoint: position?.checkpoint,
    pending: Object.freeze([]),
    capabilities: Object.freeze({ ...capabilities }),
    generation: 0,
  });
