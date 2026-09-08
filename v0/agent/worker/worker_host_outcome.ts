import type { AgentEvent } from '../core/events.ts';
import type { LoopOutcome, Message } from '../core/contracts.ts';
import type { DefinitionRevisionRef } from '../session/session_store.ts';
import type { FailureDiagnosticPersistenceErrorCode } from '../session/failure_diagnostic.ts';
import type { ProviderEvidencePersistenceErrorCode } from '../provider/provider_evidence.ts';
import type { WorkerCorrelation, WorkerRuntimeEventMessage } from './worker_protocol.ts';

export const sameRef = (
  left: DefinitionRevisionRef,
  right: DefinitionRevisionRef,
): boolean =>
  left.kind === right.kind &&
  (left.kind !== 'builtin' ||
    right.kind !== 'external' && left.id === right.id) &&
  left.canonicalSpecifier === right.canonicalSpecifier &&
  left.entrySha256 === right.entrySha256 &&
  left.sourceBytes === right.sourceBytes;

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
): LoopOutcome => {
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
    outcome: stopReason,
    stopReason,
    ...(textFromTranscript(transcript) === undefined
      ? {}
      : { finalText: textFromTranscript(transcript) }),
    steps: Math.max(1, toolResultCount),
    toolCallCount,
    toolResultCount,
    transcript: structuredClone(transcript),
  };
};

export const failedOutcome = (
  task: string,
  transcript: readonly Message[],
  reason: string,
  cancelled = false,
): LoopOutcome => ({
  ok: false,
  task,
  outcome: cancelled ? 'cancelled' : 'contract_failure',
  stopReason: cancelled ? 'cancelled' : 'contract_failure',
  ...(cancelled ? {} : { error: reason }),
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: structuredClone(transcript),
});

export const persistenceCode = <T extends string>(
  error: unknown,
  allowed: readonly T[],
  fallback: T,
): T => {
  const code = typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === 'string' && allowed.includes(code as T) ? code as T : fallback;
};

export const diagnosticPersistenceCodes: readonly FailureDiagnosticPersistenceErrorCode[] = [
  'diagnostic_not_found',
  'diagnostic_busy',
  'diagnostic_invalid',
  'diagnostic_capacity',
  'diagnostic_io_failure',
];

export const evidencePersistenceCodes: readonly ProviderEvidencePersistenceErrorCode[] = [
  'provider_evidence_not_found',
  'provider_evidence_invalid',
  'provider_evidence_io_failure',
];

export const turnEndFromOutcome = (
  turn: number,
  outcome: LoopOutcome,
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
  ...(outcome.providerEvidenceId === undefined ? {} : {
    providerEvidenceId: outcome.providerEvidenceId,
  }),
  ...(outcome.providerEvidenceDurability === undefined ? {} : {
    providerEvidenceDurability: outcome.providerEvidenceDurability,
  }),
  ...(outcome.providerEvidencePersistenceError === undefined ? {} : {
    providerEvidencePersistenceError: outcome.providerEvidencePersistenceError,
  }),
  ...(outcome.executionArtifactId === undefined ? {} : {
    executionArtifactId: outcome.executionArtifactId,
  }),
  ...(outcome.executionArtifactDurability === undefined ? {} : {
    executionArtifactDurability: outcome.executionArtifactDurability,
  }),
  ...(outcome.executionArtifactPersistenceError === undefined ? {} : {
    executionArtifactPersistenceError: outcome.executionArtifactPersistenceError,
  }),
  ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
  ...(outcome.diagnosticDurability === undefined ? {} : {
    diagnosticDurability: outcome.diagnosticDurability,
  }),
  ...(outcome.diagnosticPersistenceError === undefined ? {} : {
    diagnosticPersistenceError: outcome.diagnosticPersistenceError,
  }),
});
