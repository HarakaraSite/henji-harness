import type { AgentEvent } from '../core/events.ts';
import type { LoopOutcomeMetadata, Message } from '../core/contracts.ts';

import type { WorkerCorrelation, WorkerRuntimeEventMessage } from './worker_protocol.ts';

export const sameCorrelation = (
  left: WorkerCorrelation,
  right: WorkerCorrelation,
): boolean =>
  left.session === right.session &&
  left.instanceCorrelation === right.instanceCorrelation &&
  left.workerGeneration === right.workerGeneration &&
  left.baseStateRevision === right.baseStateRevision &&
  left.command === right.command;

const textFromTranscript = (
  transcript: readonly Message[],
): string | undefined => {
  const message = transcript.at(-1);
  if (
    message?.role !== 'assistant' || typeof message.content !== 'object' ||
    message.content === null || Array.isArray(message.content)
  ) return undefined;
  const content = message.content as {
    readonly kind?: unknown;
    readonly text?: unknown;
  };
  return content.kind === 'text' && typeof content.text === 'string' ? content.text : undefined;
};

export const proposalOutcome = (
  task: string,
  transcript: readonly Message[],
  terminal: WorkerRuntimeEventMessage | undefined,
): LoopOutcomeMetadata => {
  const toolCallCount = transcript.reduce(
    (count, message) =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? count + message.content.length
        : count,
    0,
  );
  const toolResultCount = transcript.reduce(
    (count, message) => message.role === 'tool' ? count + message.content.length : count,
    0,
  );
  const stopReason = terminal?.event.kind === 'agent_event' &&
      terminal.event.event.kind === 'turn_end'
    ? terminal.event.event.outcome
    : 'final' as const;
  return {
    ok: true,
    task,
    outcome: stopReason === 'tool_terminal' ? 'final' : stopReason,
    stopReason,
    ...(textFromTranscript(transcript) === undefined
      ? {}
      : { finalText: textFromTranscript(transcript) }),
    steps: Math.max(1, toolResultCount),
    toolCallCount,
    toolResultCount,
  };
};

export const failedOutcome = (
  task: string,
  reason: string,
  cancelled = false,
): LoopOutcomeMetadata => ({
  ok: false,
  task,
  outcome: cancelled ? 'cancelled' : 'contract_failure',
  stopReason: cancelled ? 'cancelled' : 'contract_failure',
  ...(cancelled ? {} : { error: reason }),
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
});

export const interruptedOutcome = (
  task: string,
  reason: string,
): LoopOutcomeMetadata => ({
  ok: false,
  task,
  outcome: 'interrupted',
  stopReason: 'interrupted',
  error: reason,
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
});

export const turnEndFromOutcome = (
  turn: number,
  outcome: LoopOutcomeMetadata,
  committed: boolean,
): AgentEvent => ({
  kind: 'turn_end',
  turn,
  outcome: outcome.stopReason,
  committed,
  ...(outcome.turnProviderRequestCount === undefined ? {} : {
    turnProviderRequestCount: outcome.turnProviderRequestCount,
  }),
  ...(outcome.runtimeProviderRequestCount === undefined ? {} : {
    runtimeProviderRequestCount: outcome.runtimeProviderRequestCount,
  }),
  ...(outcome.executionArtifactId === undefined ? {} : {
    executionArtifactId: outcome.executionArtifactId,
  }),
  ...(outcome.recallableExecutionId === undefined ? {} : {
    recallableExecutionId: outcome.recallableExecutionId,
  }),
  ...(outcome.executionArtifactDurability === undefined ? {} : {
    executionArtifactDurability: outcome.executionArtifactDurability,
  }),
  ...(outcome.executionArtifactPersistenceError === undefined ? {} : {
    executionArtifactPersistenceError: outcome.executionArtifactPersistenceError,
  }),
  ...(outcome.executionAdmissionDurability === undefined ? {} : {
    executionAdmissionDurability: outcome.executionAdmissionDurability,
  }),
  ...(outcome.executionAdmissionPersistenceError === undefined ? {} : {
    executionAdmissionPersistenceError: outcome.executionAdmissionPersistenceError,
  }),
  ...(outcome.executionJournalDurability === undefined ? {} : {
    executionJournalDurability: outcome.executionJournalDurability,
  }),
  ...(outcome.executionJournalPersistenceError === undefined ? {} : {
    executionJournalPersistenceError: outcome.executionJournalPersistenceError,
  }),
  ...(outcome.executionObservationDurability === undefined ? {} : {
    executionObservationDurability: outcome.executionObservationDurability,
  }),
  ...(outcome.executionObservationPersistenceError === undefined ? {} : {
    executionObservationPersistenceError: outcome.executionObservationPersistenceError,
  }),
  ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
  ...(outcome.diagnosticDurability === undefined ? {} : {
    diagnosticDurability: outcome.diagnosticDurability,
  }),
  ...(outcome.diagnosticPersistenceError === undefined ? {} : {
    diagnosticPersistenceError: outcome.diagnosticPersistenceError,
  }),
});
