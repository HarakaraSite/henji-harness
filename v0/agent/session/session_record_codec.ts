import { validateFailureDetails } from '../core/failure_details.ts';
import type { JsonValue, Message } from '../core/contracts.ts';
import { MAX_REPLAY_MESSAGE_TEXT_BYTES, MAX_REPLAY_PLANNER_RESULT_BYTES } from './replay_value.ts';
import {
  CONTEXT_CHECKPOINT_SCHEMA_VERSION,
  isSessionId,
  isSessionTitle,
  MAX_CONTEXT_CHECKPOINT_FILE_BYTES,
  MAX_CONTEXT_SUMMARY_BYTES,
  MAX_SESSION_FILE_BYTES,
  type SemanticContextCheckpointV1,
  SESSION_SCHEMA_VERSION,
  type SessionMetadata,
  type SessionRecord,
  type SessionRecordV1,
  SessionStoreError,
  type SessionTurnExecutionAttribution,
  type StoredSessionRecord,
  type WorkerSessionMetadata,
} from './session_store_contract.ts';
import { canonicalAbsolutePath } from './session_store_paths.ts';
import { isStoredModelSelection, type ModelSelection } from '../provider/model_selection.ts';
import { type BuildManifestV1, isBuildManifest } from '../runtime/build_manifest.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ownKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
};
const hasExactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  const expectedSet = new Set(expected);
  return keys.length === expected.length &&
    expectedSet.size === expected.length &&
    keys.every((key) => expectedSet.has(key));
};

const isFiniteJson = (value: unknown): value is JsonValue => {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item, index) => Object.hasOwn(value, index) && isFiniteJson(item));
  }
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isFiniteJson);
};

const validString = (value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\0') &&
  ![...value].some((c) => {
    const code = c.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });

const validMessageText = (
  value: unknown,
  max = MAX_REPLAY_MESSAGE_TEXT_BYTES,
): value is string => validString(value) && encoder.encode(value).byteLength <= max;

const validateToolCall = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const call = value as Record<string, unknown>;
  return ownKeys(call, ['kind', 'callId', 'name', 'arguments']) &&
    call.kind === 'tool_call' &&
    validString(call.callId) && call.callId.length > 0 &&
    validString(call.name) &&
    call.name.length > 0 && isFiniteJson(call.arguments);
};

const validateToolResult = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  const common = ownKeys(result, [
    'kind',
    'callId',
    'name',
    'text',
    'outcome',
    ...(Object.hasOwn(result, 'terminal') ? ['terminal'] : []),
    ...(Object.hasOwn(result, 'failure') ? ['failure'] : []),
  ]);
  if (result.failure !== undefined && !validateFailureDetails(result.failure)) {
    return false;
  }
  if (
    !common || result.kind !== 'tool_result' || !validString(result.callId) ||
    result.callId.length === 0 || !validString(result.name) ||
    result.name.length === 0 ||
    !(result.name === 'delegate_to_planner'
      ? validMessageText(result.text, MAX_REPLAY_PLANNER_RESULT_BYTES)
      : validString(result.text))
  ) return false;
  if (result.outcome !== 'success' && result.outcome !== 'error') return false;
  if (Object.hasOwn(result, 'terminal')) {
    return result.outcome === 'success' && result.terminal === 'json_result';
  }
  return result.outcome === 'success' || result.outcome === 'error';
};

const validateMessage = (value: unknown): value is Message => {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.role === 'user') {
    const content = message.content;
    return ownKeys(message, [
      'role',
      'content',
      ...(Object.hasOwn(message, 'steering') ? ['steering'] : []),
    ]) &&
      (!Object.hasOwn(message, 'steering') || message.steering === true) &&
      typeof content === 'object' &&
      content !== null &&
      ownKeys(content, ['kind', 'text']) &&
      (content as Record<string, unknown>).kind === 'text' &&
      validMessageText((content as Record<string, unknown>).text);
  }
  if (message.role === 'assistant') {
    const hasProviderState = Object.hasOwn(message, 'providerState');
    const hasText = Object.hasOwn(message, 'text');
    const state = message.providerState;
    const stateRecord = typeof state === 'object' && state !== null && !Array.isArray(state)
      ? state as Record<string, unknown>
      : undefined;
    const reasoningDetails = stateRecord?.reasoningDetails;
    const reasoning = stateRecord?.reasoning;
    const replayItems = stateRecord?.replayItems;
    if (hasProviderState) {
      if (stateRecord === undefined) return false;
      if (!Object.hasOwn(stateRecord, 'replayItems')) {
        const reasoningRecord = typeof reasoning === 'object' && reasoning !== null &&
            !Array.isArray(reasoning)
          ? reasoning as Record<string, unknown>
          : undefined;
        if (
          typeof stateRecord.provider !== 'string' ||
          stateRecord.provider.length === 0 ||
          !ownKeys(stateRecord, [
            'provider',
            ...(Object.hasOwn(stateRecord, 'model') ? ['model'] : []),
            ...(Object.hasOwn(stateRecord, 'reasoning') ? ['reasoning'] : []),
            ...(Object.hasOwn(stateRecord, 'reasoningDetails') ? ['reasoningDetails'] : []),
          ]) ||
          (stateRecord.model !== undefined &&
            (typeof stateRecord.model !== 'string' ||
              stateRecord.model.length === 0)) ||
          (reasoning === undefined && reasoningDetails === undefined) ||
          (reasoning !== undefined &&
            (reasoningRecord === undefined ||
              !ownKeys(reasoningRecord, ['field', 'text']) ||
              (reasoningRecord.field !== 'reasoning' &&
                reasoningRecord.field !== 'reasoning_content') ||
              typeof reasoningRecord.text !== 'string' ||
              reasoningRecord.text.length === 0)) ||
          (reasoningDetails !== undefined &&
            (!Array.isArray(reasoningDetails) ||
              reasoningDetails.length === 0 ||
              !reasoningDetails.every(isFiniteJson)))
        ) return false;
      } else {
        const keys = Object.keys(stateRecord);
        const allowed = ['provider', 'replayItems', 'model'];
        if (
          typeof stateRecord.provider !== 'string' ||
          stateRecord.provider.length === 0 ||
          !keys.includes('replayItems') || !keys.every((key) => allowed.includes(key)) ||
          !Array.isArray(replayItems) || replayItems.length === 0 ||
          !replayItems.every(isFiniteJson) ||
          (stateRecord.model !== undefined &&
            (typeof stateRecord.model !== 'string' ||
              stateRecord.model.length === 0))
        ) return false;
      }
    }
    const messageKeys = [
      'role',
      'content',
      ...(hasText ? ['text'] : []),
      ...(hasProviderState ? ['providerState'] : []),
    ];
    const content = message.content;
    if (
      typeof content === 'object' && content !== null && !Array.isArray(content)
    ) {
      return !hasText && ownKeys(message, messageKeys) &&
        ownKeys(content, ['kind', 'text']) &&
        (content as Record<string, unknown>).kind === 'text' &&
        validMessageText((content as Record<string, unknown>).text);
    }
    return ownKeys(message, messageKeys) &&
      (!hasText ||
        typeof message.text === 'string' && message.text.length > 0 &&
          validMessageText(message.text)) &&
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(validateToolCall);
  }
  if (message.role === 'tool') {
    return ownKeys(message, ['role', 'content']) &&
      Array.isArray(message.content) &&
      message.content.length > 0 && message.content.every(validateToolResult);
  }
  return false;
};

export interface CausalTranscriptTurn {
  readonly turn: number;
  readonly start: number;
  readonly end: number;
}

export interface CausalTranscriptIndex {
  readonly turns: readonly CausalTranscriptTurn[];
  readonly messageCount: number;
}

/**
 * Scan the schema-v1 causal grammar once and retain only message ranges.
 *
 * A marked steering user after an assistant answer, or a user after a nonterminal tool result,
 * continues the current turn once rather than starting a new parent turn. The optional
 * prefix mode is used for a live request draft: a final incomplete turn is ignored, while every
 * completed turn and all earlier validation remain strict.
 */
const indexCausalTranscript = (
  transcript: readonly Message[],
  allowIncompleteTail: boolean,
): CausalTranscriptIndex | undefined => {
  if (transcript.length === 0 || transcript[0].role !== 'user') {
    return undefined;
  }
  const turns: CausalTranscriptTurn[] = [];
  let index = 0;
  let turn = 1;
  while (index < transcript.length) {
    const start = index;
    const first = transcript[index];
    if (first.role !== 'user' || first.steering === true) {
      return allowIncompleteTail ? { turns, messageCount: transcript.length } : undefined;
    }
    index += 1;
    let completed = false;
    let steeringUsed = false;
    while (index < transcript.length && !completed) {
      const assistant = transcript[index];
      if (assistant.role !== 'assistant') {
        return allowIncompleteTail ? { turns, messageCount: transcript.length } : undefined;
      }
      index += 1;
      if (!Array.isArray(assistant.content)) {
        const next = transcript[index];
        if (next?.role === 'user' && next.steering === true) {
          if (steeringUsed) {
            return allowIncompleteTail ? { turns, messageCount: transcript.length } : undefined;
          }
          steeringUsed = true;
          index += 1;
          continue;
        }
        completed = true;
        break;
      }
      if (index >= transcript.length || transcript[index].role !== 'tool') {
        return allowIncompleteTail ? { turns, messageCount: transcript.length } : undefined;
      }
      const tool = transcript[index++];
      if (
        tool.role !== 'tool' || tool.content.length !== assistant.content.length
      ) {
        return allowIncompleteTail ? { turns, messageCount: transcript.length } : undefined;
      }
      for (
        let resultIndex = 0;
        resultIndex < tool.content.length;
        resultIndex += 1
      ) {
        const call = assistant.content[resultIndex];
        const result = tool.content[resultIndex];
        if (call.callId !== result.callId || call.name !== result.name) {
          return allowIncompleteTail ? { turns, messageCount: transcript.length } : undefined;
        }
      }
      if (tool.content.some((result) => 'terminal' in result)) {
        completed = true;
        break;
      }
      if (index < transcript.length && transcript[index].role === 'user') {
        if (steeringUsed) {
          return allowIncompleteTail ? { turns, messageCount: transcript.length } : undefined;
        }
        steeringUsed = true;
        index += 1;
      }
    }
    if (!completed) {
      return allowIncompleteTail ? { turns, messageCount: transcript.length } : undefined;
    }
    turns.push({ turn, start, end: index });
    turn += 1;
  }
  return { turns, messageCount: transcript.length };
};

/** Strict schema-v1 causal ranges shared by persistence, history, and semantic views. */
export const causalTranscriptIndex = (
  transcript: readonly Message[],
): CausalTranscriptIndex | undefined => indexCausalTranscript(transcript, false);

/** Completed-turn prefix ranges for a live request with one trailing draft. */
export const causalTranscriptPrefixIndex = (
  transcript: readonly Message[],
): CausalTranscriptIndex | undefined => indexCausalTranscript(transcript, true);

/** Parse the schema-v1 causal grammar and return completed parent-turn count. */
export const parseCausalTranscript = (
  transcript: readonly Message[],
): number | undefined => causalTranscriptIndex(transcript)?.turns.length;

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

export const validateSessionRecord = (
  value: unknown,
): value is StoredSessionRecord => validateStoredSessionRecord(value);

const sameSelection = (
  left: ModelSelection,
  right: ModelSelection,
): boolean => {
  return left.provider === right.provider && left.modelId === right.modelId &&
    left.effort === right.effort && left.api === right.api &&
    left.authProfile === right.authProfile;
};

const validBuildManifest = (value: unknown): value is BuildManifestV1 => {
  return isBuildManifest(value);
};

const validAgentChoice = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const choice = value as Record<string, unknown>;
  const keys = Object.keys(choice);
  return keys.length <= 2 &&
    keys.every((key) => key === 'name' || key === 'file') &&
    (!Object.hasOwn(choice, 'name') ||
      validString(choice.name) && choice.name.trim().length > 0) &&
    (!Object.hasOwn(choice, 'file') ||
      validString(choice.file) && choice.file.trim().length > 0);
};

const validUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );

const validateTurnExecution = (
  value: unknown,
): value is SessionTurnExecutionAttribution => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const attribution = value as Record<string, unknown>;
  return hasExactKeys(attribution, [
    'turn',
    'executionId',
    'build',
    'configurationId',
  ]) &&
    Number.isSafeInteger(attribution.turn) &&
    (attribution.turn as number) > 0 &&
    validUuid(attribution.executionId) &&
    validBuildManifest(attribution.build) &&
    validUuid(attribution.configurationId);
};

export const validateStoredSessionRecord = (
  value: unknown,
): value is StoredSessionRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      'schemaVersion',
      'sessionId',
      'workspaceRoot',
      'agent',
      'agentChoice',
      'createdAt',
      'updatedAt',
      'title',
      'stateRevision',
      'nextTurn',
      'transcript',
      'activeModel',
      'modelChanges',
      'turnModels',
      'turnExecutions',
    ]) || record.schemaVersion !== SESSION_SCHEMA_VERSION ||
    !Array.isArray(record.turnExecutions)
  ) return false;
  if (
    !isSessionId(record.sessionId) ||
    typeof record.workspaceRoot !== 'string' ||
    canonicalAbsolutePath(record.workspaceRoot) === undefined ||
    record.workspaceRoot.trim() !== record.workspaceRoot ||
    !validString(record.agent) || record.agent.trim().length === 0 ||
    !validAgentChoice(record.agentChoice) ||
    !canonicalTimestamp(record.createdAt) ||
    !canonicalTimestamp(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    (record.title !== null && !isSessionTitle(record.title)) ||
    !Number.isSafeInteger(record.stateRevision) ||
    (record.stateRevision as number) < 1 ||
    !Number.isSafeInteger(record.nextTurn) || (record.nextTurn as number) < 1 ||
    !Array.isArray(record.transcript) ||
    record.transcript.length > MAX_SESSION_FILE_BYTES ||
    !record.transcript.every(validateMessage) ||
    !isStoredModelSelection(record.activeModel) ||
    !Array.isArray(record.modelChanges) || record.modelChanges.length === 0 ||
    !Array.isArray(record.turnModels) || !record.turnModels.every((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return false;
      }
      const attribution = item as Record<string, unknown>;
      return ownKeys(attribution, ['turn', 'selection']) &&
        Number.isSafeInteger(attribution.turn) &&
        (attribution.turn as number) > 0 &&
        (attribution.turn as number) < (record.nextTurn as number) &&
        isStoredModelSelection(attribution.selection);
    }) ||
    !record.turnExecutions.every(validateTurnExecution)
  ) return false;

  let previousEffectiveTurn = 0;
  let latestSelection: ModelSelection | undefined;
  for (const item of record.modelChanges) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return false;
    }
    const change = item as Record<string, unknown>;
    if (
      !ownKeys(change, ['effectiveFromTurn', 'changedAt', 'selection']) ||
      !Number.isSafeInteger(change.effectiveFromTurn) ||
      (change.effectiveFromTurn as number) < previousEffectiveTurn ||
      (change.effectiveFromTurn as number) < 1 ||
      (change.effectiveFromTurn as number) > (record.nextTurn as number) ||
      !canonicalTimestamp(change.changedAt) ||
      !isStoredModelSelection(change.selection)
    ) return false;
    previousEffectiveTurn = change.effectiveFromTurn as number;
    latestSelection = change.selection;
  }
  if (
    latestSelection === undefined ||
    !sameSelection(latestSelection, record.activeModel)
  ) {
    return false;
  }

  const completedTurns = record.transcript.length === 0
    ? record.nextTurn === 1 ? 0 : undefined
    : parseCausalTranscript(record.transcript);
  if (completedTurns === undefined || record.nextTurn !== completedTurns + 1) {
    return false;
  }
  const turnModels = record.turnModels as SessionRecordV1['turnModels'];
  const turnExecutions = record
    .turnExecutions as SessionRecordV1['turnExecutions'];
  return turnModels.length === completedTurns &&
    turnExecutions.length === turnModels.length &&
    turnModels.every((item, index) =>
      item.turn === index + 1 && turnExecutions[index]?.turn === item.turn
    );
};

const validCheckpointString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() === value && value.length > 0 &&
  !value.includes('\0') && ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });

const checkpointKeys = [
  'contextSchemaVersion',
  'sessionId',
  'createdAt',
  'sourceProfileId',
  'coveredThroughTurn',
  'retainedFromTurn',
  'summary',
] as const;

export const validateSemanticContextCheckpoint = (
  value: unknown,
): value is SemanticContextCheckpointV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const checkpoint = value as Record<string, unknown>;
  if (!ownKeys(checkpoint, checkpointKeys)) return false;
  if (
    checkpoint.contextSchemaVersion !== CONTEXT_CHECKPOINT_SCHEMA_VERSION ||
    !isSessionId(checkpoint.sessionId) ||
    !canonicalTimestamp(checkpoint.createdAt) ||
    !validCheckpointString(checkpoint.sourceProfileId) ||
    checkpoint.sourceProfileId.length > 256 ||
    !Number.isSafeInteger(checkpoint.coveredThroughTurn) ||
    (checkpoint.coveredThroughTurn as number) < 1 ||
    !Number.isSafeInteger(checkpoint.retainedFromTurn) ||
    checkpoint.retainedFromTurn !==
      (checkpoint.coveredThroughTurn as number) + 1 ||
    !validCheckpointString(checkpoint.summary) ||
    encoder.encode(checkpoint.summary).byteLength > MAX_CONTEXT_SUMMARY_BYTES
  ) return false;
  return true;
};

export const encodeSemanticContextCheckpoint = (
  checkpoint: SemanticContextCheckpointV1,
): Uint8Array => {
  if (!validateSemanticContextCheckpoint(checkpoint)) {
    throw new SessionStoreError('session_invalid');
  }
  const bytes = encoder.encode(`${JSON.stringify(checkpoint)}\n`);
  if (bytes.byteLength > MAX_CONTEXT_CHECKPOINT_FILE_BYTES) {
    throw new SessionStoreError('session_limit');
  }
  return bytes;
};

export const decodeSemanticContextCheckpoint = (
  bytes: Uint8Array,
): SemanticContextCheckpointV1 => {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_CONTEXT_CHECKPOINT_FILE_BYTES ||
    bytes.includes(0) ||
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  ) throw new SessionStoreError('session_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new SessionStoreError('session_invalid');
  }
  if (!validateSemanticContextCheckpoint(parsed)) {
    throw new SessionStoreError('session_invalid');
  }
  const canonical = encoder.encode(`${JSON.stringify(parsed)}\n`);
  if (
    canonical.byteLength !== bytes.byteLength ||
    canonical.some((byte, index) => byte !== bytes[index])
  ) throw new SessionStoreError('session_invalid');
  return structuredClone(parsed);
};

export const metadataFromRecord = (record: SessionRecord): SessionMetadata => ({
  id: record.sessionId,
  agent: record.agent,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  turnCount: record.nextTurn - 1,
  messageCount: record.transcript.length,
});

export const metadataFromStoredRecord = (
  record: StoredSessionRecord,
): WorkerSessionMetadata => ({
  id: record.sessionId,
  agent: record.agent,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  turnCount: record.nextTurn - 1,
  messageCount: record.transcript.length,
  ...(record.title === null ? {} : { title: record.title }),
  agentChoice: structuredClone(record.agentChoice),
  modelSelection: structuredClone(record.activeModel),
});
