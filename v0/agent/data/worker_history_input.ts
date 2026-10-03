import type { WorkerToHostMessage } from '../worker/worker_protocol.ts';
import type {
  ExecutionEventInput,
  ExecutionEventPayloadByKind,
  HistoryPersistencePort,
} from '../history/history_store_contract.ts';

/** The shared semantic projection; callers own buffering and execution lifetime. */
export const workerObservationInput = (
  executionId: string,
  message: WorkerToHostMessage,
  history?: Pick<HistoryPersistencePort, 'prepareWorkerObservationForHistory'>,
): ExecutionEventInput | undefined => {
  if (
    message.kind === 'ready' || message.kind === 'model_selected' ||
    message.kind === 'closed' || message.kind === 'checkpoint_proposal' ||
    message.kind === 'async_agent_request'
  ) return undefined;
  const workerSequence = message.kind === 'runtime_event' ||
      message.kind === 'effect_observation' ||
      message.kind === 'provider_observation' ||
      message.kind === 'context_observation' ||
      message.kind === 'cancel_received'
    ? message.sequence
    : undefined;
  const kind = message.kind === 'runtime_event'
    ? 'runtime_event'
    : message.kind === 'effect_observation'
    ? 'effect_observation'
    : message.kind === 'provider_observation'
    ? message.observation.kind === 'request_start'
      ? 'provider_request_start' as const
      : message.observation.kind === 'response_start'
      ? 'provider_response_start' as const
      : message.observation.kind === 'parser_transition'
      ? 'provider_parser_transition' as const
      : message.observation.kind === 'request_failure'
      ? 'provider_request_failure' as const
      : 'runtime_event' as const
    : message.kind === 'context_observation'
    ? 'context_observation' as const
    : message.kind === 'cancel_received'
    ? 'cancel_received' as const
    : 'runtime_event' as const;
  const historyMessage = history
    ?.prepareWorkerObservationForHistory?.(message) ?? message;
  return {
    executionId: executionId,
    direction: 'worker_to_host',
    source: 'worker',
    kind,
    ...(workerSequence === undefined ? {} : { workerSequence }),
    payload: structuredClone(
      historyMessage,
    ) as unknown as ExecutionEventPayloadByKind[typeof kind],
  } as ExecutionEventInput;
};
