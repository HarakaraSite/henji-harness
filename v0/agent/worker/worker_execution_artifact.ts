import type { LoopOutcome } from '../core/contracts.ts';
import type { DefinitionRevisionRef } from '../session/session_store.ts';
import type {
  WorkerCorrelation,
  WorkerHostCommand,
  WorkerReadyMessage,
  WorkerToHostMessage,
} from './worker_protocol.ts';

/** Additive, Host-owned record of one admitted Worker turn. */
export const WORKER_EXECUTION_ARTIFACT_SCHEMA_VERSION = 1 as const;

export type WorkerExecutionStoreResult =
  | 'not_attempted'
  | 'failed'
  | 'committed';
export type WorkerExecutionAcknowledgement =
  | 'not_sent'
  | 'rejected_sent'
  | 'accepted_sent'
  | 'delivery_failed';
export type WorkerExecutionSettlement =
  | 'uncommitted'
  | 'committed'
  | 'committed_generation_unavailable';

export type WorkerExecutionArtifactPersistenceErrorCode =
  | 'worker_execution_artifact_io_failure'
  | 'worker_execution_artifact_invalid';

export type WorkerExecutionTraceDirection = 'host_to_worker' | 'worker_to_host';

export interface WorkerExecutionTraceEntry {
  readonly direction: WorkerExecutionTraceDirection;
  /** The top-level data-only protocol envelope kind. */
  readonly kind: WorkerHostCommand['kind'] | WorkerToHostMessage['kind'];
  /** Semantic subtype retained without duplicating the protocol payload. */
  readonly semanticSubtype: string;
  readonly sequence: number;
  readonly correlation: WorkerCorrelation;
  readonly ackAccepted?: boolean;
}

export interface WorkerExecutionTurnCommand {
  readonly kind: 'turn';
  readonly correlation: WorkerCorrelation;
  readonly task: string;
}

export interface WorkerExecutionOutcome {
  readonly ok: boolean;
  readonly outcome: LoopOutcome['outcome'];
  readonly stopReason: LoopOutcome['stopReason'];
  readonly finalText?: string;
  readonly terminalKind?: 'json_result';
  readonly error?: string;
  readonly steps: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly turnProviderRequestCount?: number;
  readonly runtimeProviderRequestCount?: number;
}

export interface WorkerExecutionArtifactV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly createdAt: string;
  readonly settledAt: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly agent: 'default' | 'planner';
  readonly instanceCorrelation: string;
  readonly workerGeneration: string;
  readonly definition: DefinitionRevisionRef;
  readonly manifest: NonNullable<WorkerReadyMessage['manifest']>;
  readonly command: WorkerExecutionTurnCommand;
  readonly baseStateRevision: number;
  readonly proposedStateRevision?: number;
  readonly committedStateRevision?: number;
  readonly protocolTrace: readonly WorkerExecutionTraceEntry[];
  readonly providerEvidenceId?: string;
  readonly providerEvidenceDurability?: 'yes' | 'failed' | 'unknown';
  readonly providerEvidencePersistenceError?: string;
  readonly storeResult: WorkerExecutionStoreResult;
  readonly storeError?: 'session_io_failure' | 'session_invalid';
  readonly acknowledgement: WorkerExecutionAcknowledgement;
  readonly settlement: WorkerExecutionSettlement;
  readonly outcome: WorkerExecutionOutcome;
  readonly effectCommitRelation: 'not_transactional';
  readonly automaticReplay: false;
  readonly artifactPersistenceError?: WorkerExecutionArtifactPersistenceErrorCode;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const ownKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
};

const validText = (value: unknown, nonEmpty = false): value is string =>
  typeof value === 'string' && (!nonEmpty || value.length > 0) &&
  !value.includes('\0') && ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });

const validTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
};

const validCorrelation = (value: unknown): value is WorkerCorrelation => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ownKeys(record, [
    'session',
    'instanceCorrelation',
    'workerGeneration',
    'baseStateRevision',
    'command',
  ]) && validText(record.session, true) &&
    validText(record.instanceCorrelation, true) &&
    validText(record.workerGeneration, true) &&
    Number.isSafeInteger(record.baseStateRevision) &&
    (record.baseStateRevision as number) >= 1 &&
    validText(record.command, true);
};

const validDefinition = (value: unknown): value is DefinitionRevisionRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const common = ['canonicalSpecifier', 'entrySha256', 'sourceBytes'];
  if (
    typeof record.canonicalSpecifier !== 'string' ||
    !record.canonicalSpecifier.startsWith('file:///') ||
    typeof record.entrySha256 !== 'string' ||
    !SHA256.test(record.entrySha256) ||
    !Number.isSafeInteger(record.sourceBytes) ||
    (record.sourceBytes as number) <= 0
  ) return false;
  if (record.kind === 'builtin') {
    return ownKeys(record, ['kind', 'id', ...common]) &&
      (record.id === 'default' || record.id === 'planner');
  }
  return record.kind === 'external' && ownKeys(record, ['kind', ...common]);
};

const validManifest = (
  value: unknown,
): value is NonNullable<WorkerReadyMessage['manifest']> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const manifest = value as Record<string, unknown>;
  return ownKeys(manifest, ['role', 'maxSteps', 'profileId', 'resources']) &&
    (manifest.role === 'parent' || manifest.role === 'planner') &&
    Number.isSafeInteger(manifest.maxSteps) &&
    (manifest.maxSteps as number) > 0 &&
    validText(manifest.profileId, true) && Array.isArray(manifest.resources) &&
    manifest.resources.every((resource) => validText(resource, true));
};

const validOutcome = (value: unknown): value is WorkerExecutionOutcome => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const outcome = value as Record<string, unknown>;
  const optional = [
    ...(Object.hasOwn(outcome, 'finalText') ? ['finalText'] : []),
    ...(Object.hasOwn(outcome, 'terminalKind') ? ['terminalKind'] : []),
    ...(Object.hasOwn(outcome, 'error') ? ['error'] : []),
  ];
  if (
    !ownKeys(outcome, [
      'ok',
      'outcome',
      'stopReason',
      ...optional,
      'steps',
      'toolCallCount',
      'toolResultCount',
      ...(Object.hasOwn(outcome, 'turnProviderRequestCount') ? ['turnProviderRequestCount'] : []),
      ...(Object.hasOwn(outcome, 'runtimeProviderRequestCount')
        ? ['runtimeProviderRequestCount']
        : []),
    ])
  ) return false;
  const stops = [
    'final',
    'tool_terminal',
    'max_steps',
    'contract_failure',
    'cancelled',
  ];
  return typeof outcome.ok === 'boolean' &&
    stops.includes(String(outcome.outcome)) &&
    stops.includes(String(outcome.stopReason)) &&
    (outcome.outcome === outcome.stopReason) &&
    (!Object.hasOwn(outcome, 'finalText') || validText(outcome.finalText)) &&
    (!Object.hasOwn(outcome, 'terminalKind') ||
      outcome.terminalKind === 'json_result') &&
    (!Object.hasOwn(outcome, 'error') || validText(outcome.error)) &&
    Number.isSafeInteger(outcome.steps) && (outcome.steps as number) >= 0 &&
    Number.isSafeInteger(outcome.toolCallCount) &&
    (outcome.toolCallCount as number) >= 0 &&
    Number.isSafeInteger(outcome.toolResultCount) &&
    (outcome.toolResultCount as number) >= 0 &&
    (!Object.hasOwn(outcome, 'turnProviderRequestCount') ||
      Number.isSafeInteger(outcome.turnProviderRequestCount) &&
        (outcome.turnProviderRequestCount as number) >= 0) &&
    (!Object.hasOwn(outcome, 'runtimeProviderRequestCount') ||
      Number.isSafeInteger(outcome.runtimeProviderRequestCount) &&
        (outcome.runtimeProviderRequestCount as number) >= 0);
};

const validTrace = (value: unknown): value is WorkerExecutionTraceEntry => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const trace = value as Record<string, unknown>;
  const keys = [
    'direction',
    'kind',
    'semanticSubtype',
    'sequence',
    'correlation',
    ...(Object.hasOwn(trace, 'ackAccepted') ? ['ackAccepted'] : []),
  ];
  return ownKeys(trace, keys) &&
    (trace.direction === 'host_to_worker' ||
      trace.direction === 'worker_to_host') &&
    validText(trace.kind, true) && validText(trace.semanticSubtype, true) &&
    Number.isSafeInteger(trace.sequence) && (trace.sequence as number) > 0 &&
    validCorrelation(trace.correlation) &&
    (!Object.hasOwn(trace, 'ackAccepted') ||
      typeof trace.ackAccepted === 'boolean');
};

const validExecutionId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V4.test(value);

/** Validate the additive artifact without reading any provider/session payload. */
export const validateWorkerExecutionArtifact = (
  value: unknown,
): value is WorkerExecutionArtifactV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const artifact = value as Record<string, unknown>;
  const stateOptional = [
    ...(Object.hasOwn(artifact, 'proposedStateRevision') ? ['proposedStateRevision'] : []),
    ...(Object.hasOwn(artifact, 'committedStateRevision') ? ['committedStateRevision'] : []),
  ];
  const providerOptional = [
    ...(Object.hasOwn(artifact, 'providerEvidenceId') ? ['providerEvidenceId'] : []),
    ...(Object.hasOwn(artifact, 'providerEvidenceDurability')
      ? ['providerEvidenceDurability']
      : []),
    ...(Object.hasOwn(artifact, 'providerEvidencePersistenceError')
      ? ['providerEvidencePersistenceError']
      : []),
  ];
  const storeOptional = Object.hasOwn(artifact, 'storeError') ? ['storeError'] : [];
  const artifactOptional = [
    ...(Object.hasOwn(artifact, 'artifactPersistenceError') ? ['artifactPersistenceError'] : []),
  ];
  if (
    !ownKeys(artifact, [
      'schemaVersion',
      'executionId',
      'createdAt',
      'settledAt',
      'sessionId',
      'turn',
      'agent',
      'instanceCorrelation',
      'workerGeneration',
      'definition',
      'manifest',
      'command',
      'baseStateRevision',
      ...stateOptional,
      'protocolTrace',
      ...providerOptional,
      'storeResult',
      ...storeOptional,
      'acknowledgement',
      'settlement',
      'outcome',
      'effectCommitRelation',
      'automaticReplay',
      ...artifactOptional,
    ])
  ) return false;
  const command = artifact.command as Record<string, unknown>;
  const trace = artifact.protocolTrace;
  const valid = artifact.schemaVersion === 1 &&
    validExecutionId(artifact.executionId) &&
    validTimestamp(artifact.createdAt) && validTimestamp(artifact.settledAt) &&
    Date.parse(artifact.settledAt as string) >=
      Date.parse(artifact.createdAt as string) &&
    validText(artifact.sessionId, true) &&
    Number.isSafeInteger(artifact.turn) &&
    (artifact.turn as number) > 0 &&
    (artifact.agent === 'default' || artifact.agent === 'planner') &&
    validText(artifact.instanceCorrelation, true) &&
    validText(artifact.workerGeneration, true) &&
    validDefinition(artifact.definition) && validManifest(artifact.manifest) &&
    ownKeys(command, ['kind', 'correlation', 'task']) &&
    command.kind === 'turn' &&
    validCorrelation(command.correlation) && validText(command.task) &&
    Number.isSafeInteger(artifact.baseStateRevision) &&
    (artifact.baseStateRevision as number) >= 1 &&
    (!Object.hasOwn(artifact, 'proposedStateRevision') ||
      Number.isSafeInteger(artifact.proposedStateRevision) &&
        (artifact.proposedStateRevision as number) >= 1) &&
    (!Object.hasOwn(artifact, 'committedStateRevision') ||
      Number.isSafeInteger(artifact.committedStateRevision) &&
        (artifact.committedStateRevision as number) >= 1) &&
    Array.isArray(trace) && trace.length > 0 && trace.every(validTrace) &&
    trace.every((entry, index) => entry.sequence === index + 1) &&
    (!Object.hasOwn(artifact, 'providerEvidenceId') ||
      validExecutionId(artifact.providerEvidenceId)) &&
    (!Object.hasOwn(artifact, 'providerEvidenceDurability') ||
      artifact.providerEvidenceDurability === 'yes' ||
      artifact.providerEvidenceDurability === 'failed' ||
      artifact.providerEvidenceDurability === 'unknown') &&
    (!Object.hasOwn(artifact, 'providerEvidencePersistenceError') ||
      validText(artifact.providerEvidencePersistenceError, true)) &&
    (artifact.storeResult === 'not_attempted' ||
      artifact.storeResult === 'failed' ||
      artifact.storeResult === 'committed') &&
    (!Object.hasOwn(artifact, 'storeError') ||
      artifact.storeError === 'session_io_failure' ||
      artifact.storeError === 'session_invalid') &&
    (artifact.acknowledgement === 'not_sent' ||
      artifact.acknowledgement === 'rejected_sent' ||
      artifact.acknowledgement === 'accepted_sent' ||
      artifact.acknowledgement === 'delivery_failed') &&
    (artifact.settlement === 'uncommitted' ||
      artifact.settlement === 'committed' ||
      artifact.settlement === 'committed_generation_unavailable') &&
    validOutcome(artifact.outcome) &&
    artifact.effectCommitRelation === 'not_transactional' &&
    artifact.automaticReplay === false &&
    (!Object.hasOwn(artifact, 'artifactPersistenceError') ||
      artifact.artifactPersistenceError ===
        'worker_execution_artifact_io_failure' ||
      artifact.artifactPersistenceError ===
        'worker_execution_artifact_invalid');
  return valid;
};

export const encodeWorkerExecutionArtifact = (
  value: WorkerExecutionArtifactV1,
): string => {
  if (!validateWorkerExecutionArtifact(value)) {
    throw new TypeError('invalid Worker execution artifact');
  }
  return JSON.stringify(value);
};

export class WorkerExecutionArtifactCodecError extends Error {
  constructor() {
    super('invalid Worker execution artifact');
    this.name = 'WorkerExecutionArtifactCodecError';
  }
}

export const decodeWorkerExecutionArtifact = (
  bytes: Uint8Array | string,
): WorkerExecutionArtifactV1 => {
  try {
    const text = typeof bytes === 'string'
      ? bytes
      : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw new WorkerExecutionArtifactCodecError();
    const body = text.slice(0, -1);
    const value: unknown = JSON.parse(body);
    if (
      !validateWorkerExecutionArtifact(value) ||
      encodeWorkerExecutionArtifact(value) !== body
    ) {
      throw new WorkerExecutionArtifactCodecError();
    }
    return structuredClone(value);
  } catch {
    throw new WorkerExecutionArtifactCodecError();
  }
};

export const workerExecutionOutcome = (
  outcome: LoopOutcome,
): WorkerExecutionOutcome => {
  const result: WorkerExecutionOutcome = {
    ok: outcome.ok,
    outcome: outcome.outcome,
    stopReason: outcome.stopReason,
    ...(outcome.finalText === undefined ? {} : { finalText: outcome.finalText }),
    ...(outcome.terminalKind === undefined ? {} : { terminalKind: outcome.terminalKind }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    steps: outcome.steps,
    toolCallCount: outcome.toolCallCount,
    toolResultCount: outcome.toolResultCount,
    ...(outcome.turnProviderRequestCount === undefined ? {} : {
      turnProviderRequestCount: outcome.turnProviderRequestCount,
    }),
    ...(outcome.runtimeProviderRequestCount === undefined ? {} : {
      runtimeProviderRequestCount: outcome.runtimeProviderRequestCount,
    }),
  };
  return result;
};

export const workerHostCommandSubtype = (
  command: WorkerHostCommand,
): {
  readonly kind: WorkerHostCommand['kind'];
  readonly semanticSubtype: string;
  readonly ackAccepted?: boolean;
} => ({
  kind: command.kind,
  semanticSubtype: command.kind,
  ...(command.kind === 'commit_acknowledgement' ||
      command.kind === 'checkpoint_acknowledgement'
    ? { ackAccepted: command.accepted }
    : {}),
});

export const workerMessageSubtype = (
  message: WorkerToHostMessage,
): {
  readonly kind: WorkerToHostMessage['kind'];
  readonly semanticSubtype: string;
} => {
  if (message.kind === 'runtime_event') {
    return {
      kind: message.kind,
      semanticSubtype: message.event.kind === 'agent_event'
        ? message.event.event.kind
        : message.event.kind,
    };
  }
  if (message.kind === 'effect_observation') {
    return { kind: message.kind, semanticSubtype: message.effect.kind };
  }
  if (message.kind === 'worker_error') {
    return { kind: message.kind, semanticSubtype: message.stage };
  }
  return { kind: message.kind, semanticSubtype: message.kind };
};
