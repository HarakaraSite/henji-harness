import type { StoredExecutionEffect, StoredExecutionEvent } from './history_store_contract.ts';

/** Project tool lifecycle facts from the ordered journal events already in hand. */
export const executionEffectsFromEvents = (
  executionId: string,
  outcome: 'unknown' | 'completed' | 'cancelled' | 'failed' | 'interrupted',
  events: readonly StoredExecutionEvent[],
): readonly StoredExecutionEffect[] => {
  const effects = new Map<string, StoredExecutionEffect>();
  for (const event of events) {
    if (
      event.kind !== 'effect_observation' && event.kind !== 'runtime_event'
    ) continue;
    const payload = event.payload as Record<string, unknown>;
    const providerObservation = payload.kind === 'provider_observation' &&
        typeof payload.observation === 'object' &&
        payload.observation !== null
      ? payload.observation as Record<string, unknown>
      : undefined;
    const providerEvent = providerObservation?.kind === 'runtime_event' &&
        typeof providerObservation.event === 'object' &&
        providerObservation.event !== null
      ? providerObservation.event as Record<string, unknown>
      : undefined;
    const effect = providerEvent ??
      (typeof payload.effect === 'object' && payload.effect !== null
        ? payload.effect as Record<string, unknown>
        : payload);
    const phase = String(effect.kind ?? '');
    const nested = phase === 'tool_call'
      ? effect.call
      : phase === 'tool_result'
      ? effect.result
      : effect;
    if (typeof nested !== 'object' || nested === null) continue;
    const value = nested as Record<string, unknown>;
    if (typeof value.callId !== 'string') continue;
    const prior = effects.get(value.callId);
    const completed = phase === 'tool_result';
    const progress = phase === 'tool_progress';
    effects.set(value.callId, {
      executionId,
      callId: value.callId,
      name: String(value.name ?? prior?.name ?? ''),
      ...(phase === 'tool_call'
        ? { requestedEventOrdinal: event.ordinal }
        : prior?.requestedEventOrdinal === undefined
        ? {}
        : { requestedEventOrdinal: prior.requestedEventOrdinal }),
      ...(progress
        ? { progressEventOrdinal: event.ordinal }
        : prior?.progressEventOrdinal === undefined
        ? {}
        : { progressEventOrdinal: prior.progressEventOrdinal }),
      ...(completed
        ? { completedEventOrdinal: event.ordinal }
        : prior?.completedEventOrdinal === undefined
        ? {}
        : { completedEventOrdinal: prior.completedEventOrdinal }),
      ...(completed &&
          (value.outcome === 'success' || value.outcome === 'error')
        ? { resultOutcome: value.outcome }
        : prior?.resultOutcome === undefined
        ? {}
        : { resultOutcome: prior.resultOutcome }),
      status: completed ? 'completed' : progress ? 'observed_progress' : 'observed_requested',
    });
  }
  return [...effects.values()].map((effect) =>
    effect.completedEventOrdinal === undefined &&
      (outcome === 'interrupted' || outcome === 'unknown')
      ? { ...effect, status: 'outcome_unknown' as const }
      : effect
  );
};
