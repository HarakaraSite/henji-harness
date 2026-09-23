import type { JsonValue, Message } from '../core/contracts.ts';
import { MAX_REPLAY_MESSAGE_TEXT_BYTES, MAX_REPLAY_PLANNER_RESULT_BYTES } from './replay_value.ts';
import {
  CONTEXT_CHECKPOINT_SCHEMA_VERSION,
  type DefinitionRevisionRef,
  isSessionId,
  isSessionTitle,
  MAX_CONTEXT_CHECKPOINT_FILE_BYTES,
  MAX_CONTEXT_SUMMARY_BYTES,
  MAX_RESTORED_DISPLAY_BYTES,
  MAX_RESTORED_DISPLAY_MESSAGES,
  MAX_SESSION_FILE_BYTES,
  type SemanticContextCheckpointV1,
  type SessionMetadata,
  type SessionRecord,
  type SessionRecordV5,
  type SessionRecordV6,
  SessionStoreError,
  type StoredSessionRecord,
  type WorkerSessionMetadata,
} from './session_store_contract.ts';
import { canonicalAbsolutePath } from './session_store_paths.ts';
import { isStoredModelSelection, type ModelSelection } from '../provider/model_selection.ts';
import { isDefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';
import { type BuildManifestV1, isBuildManifest } from '../runtime/build_manifest.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ownKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
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
  const common = ownKeys(result, ['kind', 'callId', 'name', 'text', 'outcome']) ||
    ownKeys(result, ['kind', 'callId', 'name', 'text', 'outcome', 'terminal']);
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
    return ownKeys(message, ['role', 'content']) &&
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
    const replayItems = stateRecord?.replayItems;
    if (hasProviderState) {
      if (stateRecord === undefined) return false;
      if (Object.hasOwn(stateRecord, 'reasoningDetails')) {
        if (
          typeof stateRecord.provider !== 'string' || stateRecord.provider.length === 0 ||
          !ownKeys(stateRecord, ['provider', 'reasoningDetails']) ||
          !Array.isArray(reasoningDetails) || reasoningDetails.length === 0 ||
          !reasoningDetails.every(isFiniteJson)
        ) return false;
      } else {
        const keys = Object.keys(stateRecord);
        const allowed = ['provider', 'replayItems', 'model'];
        if (
          typeof stateRecord.provider !== 'string' || stateRecord.provider.length === 0 ||
          !keys.includes('replayItems') || !keys.every((key) => allowed.includes(key)) ||
          !Array.isArray(replayItems) || replayItems.length === 0 ||
          !replayItems.every(isFiniteJson) ||
          (stateRecord.model !== undefined &&
            (typeof stateRecord.model !== 'string' || stateRecord.model.length === 0))
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
      (!hasText || typeof message.text === 'string' && message.text.length > 0 &&
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
 * A user after a nonterminal tool result is the one legal intra-turn steering message. It is
 * deliberately consumed by this parser rather than counted as a new parent turn. The optional
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
    if (transcript[index].role !== 'user') {
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
): value is SessionRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    !ownKeys(record, [
      'schemaVersion',
      'sessionId',
      'workspaceRoot',
      'agent',
      'createdAt',
      'updatedAt',
      'nextTurn',
      'transcript',
    ])
  ) return false;
  if (
    record.schemaVersion !== 1 || !isSessionId(record.sessionId) ||
    typeof record.workspaceRoot !== 'string' ||
    canonicalAbsolutePath(record.workspaceRoot) === undefined ||
    record.workspaceRoot.trim() !== record.workspaceRoot ||
    (record.agent !== 'default' && record.agent !== 'planner') ||
    !canonicalTimestamp(record.createdAt) ||
    !canonicalTimestamp(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    !Number.isSafeInteger(record.nextTurn) || (record.nextTurn as number) < 2 ||
    !Array.isArray(record.transcript) || record.transcript.length === 0 ||
    record.transcript.length > MAX_SESSION_FILE_BYTES ||
    !record.transcript.every(validateMessage) ||
    parseCausalTranscript(record.transcript) === undefined
  ) {
    return false;
  }
  const completedParentTurns = parseCausalTranscript(record.transcript);
  return completedParentTurns !== undefined &&
    record.nextTurn === completedParentTurns + 1;
};

export const validRevisionRef = (
  value: unknown,
): value is DefinitionRevisionRef => isDefinitionRevisionRef(value);

const sameSelection = (left: ModelSelection, right: ModelSelection): boolean => {
  return left.provider === right.provider && left.modelId === right.modelId &&
    left.effort === right.effort && left.api === right.api &&
    left.authProfile === right.authProfile;
};

const validateModelSessionRecord = (
  value: unknown,
): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    !ownKeys(
      record,
      [
        'schemaVersion',
        'sessionId',
        'workspaceRoot',
        'agent',
        'createdAt',
        'updatedAt',
        'title',
        'stateRevision',
        'nextTurn',
        'transcript',
        'definition',
        'activeModel',
        'modelChanges',
        'turnModels',
      ],
    ) || record.schemaVersion !== 5 ||
    (record.title !== null && !isSessionTitle(record.title)) ||
    !isStoredModelSelection(record.activeModel) ||
    !Array.isArray(record.modelChanges) || record.modelChanges.length === 0 ||
    !Array.isArray(record.turnModels)
  ) return false;
  if (
    !validRevisionRef(record.definition) || !Number.isSafeInteger(record.stateRevision) ||
    (record.stateRevision as number) < 1
  ) return false;
  const base: SessionRecord = {
    schemaVersion: 1,
    sessionId: record.sessionId as string,
    workspaceRoot: record.workspaceRoot as string,
    agent: record.agent as SessionRecord['agent'],
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
    nextTurn: record.nextTurn as number,
    transcript: record.transcript as readonly Message[],
  };
  const emptyBeforeFirstTurn = isSessionId(base.sessionId) &&
    typeof base.workspaceRoot === 'string' &&
    canonicalAbsolutePath(base.workspaceRoot) !== undefined &&
    base.workspaceRoot.trim() === base.workspaceRoot &&
    (base.agent === 'default' || base.agent === 'planner') &&
    canonicalTimestamp(base.createdAt) && canonicalTimestamp(base.updatedAt) &&
    Date.parse(base.updatedAt) >= Date.parse(base.createdAt) &&
    base.nextTurn === 1 && Array.isArray(base.transcript) && base.transcript.length === 0;
  if (!emptyBeforeFirstTurn && !validateSessionRecord(base)) return false;
  let previousEffectiveTurn = 0;
  let latestSelection: ModelSelection | undefined;
  for (const value of record.modelChanges) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const change = value as Record<string, unknown>;
    if (
      !ownKeys(change, ['effectiveFromTurn', 'changedAt', 'selection']) ||
      !Number.isSafeInteger(change.effectiveFromTurn) ||
      (change.effectiveFromTurn as number) < previousEffectiveTurn ||
      (change.effectiveFromTurn as number) < 1 ||
      (change.effectiveFromTurn as number) > base.nextTurn ||
      !canonicalTimestamp(change.changedAt) ||
      !isStoredModelSelection(change.selection)
    ) return false;
    previousEffectiveTurn = change.effectiveFromTurn as number;
    latestSelection = change.selection;
  }
  if (latestSelection === undefined || !sameSelection(latestSelection, record.activeModel)) {
    return false;
  }
  let previousAttributedTurn = 0;
  for (const value of record.turnModels) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const attribution = value as Record<string, unknown>;
    if (
      !ownKeys(attribution, ['turn', 'selection']) ||
      !Number.isSafeInteger(attribution.turn) ||
      (attribution.turn as number) <= previousAttributedTurn ||
      (attribution.turn as number) < 1 ||
      (attribution.turn as number) >= base.nextTurn ||
      !isStoredModelSelection(attribution.selection)
    ) return false;
    previousAttributedTurn = attribution.turn as number;
  }
  return true;
};

const validateSessionRecordV5 = (
  value: unknown,
): value is SessionRecordV5 => validateModelSessionRecord(value);

const validBuildManifest = (value: unknown): value is BuildManifestV1 => {
  return isBuildManifest(value);
};

export const validateSessionRecordV6 = (
  value: unknown,
): value is SessionRecordV6 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    !ownKeys(record, [
      'schemaVersion',
      'sessionId',
      'workspaceRoot',
      'agent',
      'createdAt',
      'updatedAt',
      'title',
      'stateRevision',
      'nextTurn',
      'transcript',
      'definition',
      'activeModel',
      'modelChanges',
      'turnModels',
      'turnExecutions',
    ]) || record.schemaVersion !== 6 || !Array.isArray(record.turnExecutions)
  ) return false;
  const base: SessionRecordV5 = {
    schemaVersion: 5,
    sessionId: record.sessionId as string,
    workspaceRoot: record.workspaceRoot as string,
    agent: record.agent as SessionRecord['agent'],
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
    title: record.title as string | null,
    stateRevision: record.stateRevision as number,
    nextTurn: record.nextTurn as number,
    transcript: record.transcript as readonly Message[],
    definition: record.definition as DefinitionRevisionRef,
    activeModel: record.activeModel as ModelSelection,
    modelChanges: record.modelChanges as SessionRecordV5['modelChanges'],
    turnModels: record.turnModels as SessionRecordV5['turnModels'],
  };
  if (!validateSessionRecordV5(base)) return false;
  let previous = 0;
  for (const value of record.turnExecutions) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const attribution = value as Record<string, unknown>;
    if (
      !ownKeys(attribution, ['turn', 'build', 'definition']) ||
      !Number.isSafeInteger(attribution.turn) || (attribution.turn as number) <= previous ||
      (attribution.turn as number) < 1 || (attribution.turn as number) >= base.nextTurn ||
      !validBuildManifest(attribution.build) || !validRevisionRef(attribution.definition)
    ) {
      return false;
    }
    previous = attribution.turn as number;
  }
  const turnModels = record.turnModels as SessionRecordV5['turnModels'];
  return record.turnExecutions.length === turnModels.length &&
    record.turnExecutions.every((item, index) => item.turn === turnModels[index].turn);
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
  ...metadataFromRecord({
    schemaVersion: 1,
    sessionId: record.sessionId,
    workspaceRoot: record.workspaceRoot,
    agent: record.agent,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextTurn: record.nextTurn,
    transcript: record.transcript,
  }),
  ...(record.title === null ? {} : { title: record.title }),
  definition: structuredClone(record.definition),
  modelSelection: structuredClone(record.activeModel),
});

export const restoredMessages = (
  transcript: readonly Message[],
): { readonly messages: readonly Message[]; readonly omitted: number } => {
  const selected: Message[] = [];
  let used = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_RESTORED_DISPLAY_MESSAGES) break;
    const size = encoder.encode(JSON.stringify(transcript[index])).byteLength;
    if (size > MAX_RESTORED_DISPLAY_BYTES) {
      // The newest oversize message leaves no coherent tail; a later oversize message ends the
      // suffix because skipping it would make the displayed transcript non-contiguous.
      break;
    }
    if (used + size > MAX_RESTORED_DISPLAY_BYTES) break;
    selected.push(structuredClone(transcript[index]));
    used += size;
  }
  selected.reverse();
  return { messages: selected, omitted: transcript.length - selected.length };
};
