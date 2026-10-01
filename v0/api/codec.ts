import type {
  CatalogReadResult,
  ChatGPTAuthResult,
  CommandResult,
  CommandState,
  ContextReadResult,
  ContextView,
  CoreCommandValue,
  CoreReadView,
  CoreShutdownValue,
  CredentialPresenceReadResult,
  CredentialRegisterResult,
  EffectiveRuntimeConfig,
  ExecutionReadResult,
  ExecutionView,
  FollowUpReadResult,
  FollowUpRecord,
  HistoryReadResult,
  PendingView,
  RecallValue,
  SelectionChangeValue,
  SessionChange,
  SessionDeleteValue,
  SessionOpenValue,
  SessionRenameValue,
  SessionsListResult,
  SessionSnapshot,
  SessionStreamFrame,
} from './contract.ts';

export class ApiCodecError extends Error {
  constructor() {
    super('invalid API value');
    this.name = 'ApiCodecError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string';
const isApiSelection = (value: unknown): value is {
  readonly provider: string;
  readonly modelId: string;
  readonly effort: string;
} =>
  isRecord(value) && isText(value.provider) && isText(value.modelId) &&
  isText(value.effort);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isApiJson = (value: unknown): boolean => {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isApiJson);
  return isRecord(value) && Object.values(value).every(isApiJson);
};

const isContextView = (value: unknown): value is ContextView =>
  isRecord(value) &&
  (value.checkpoint === undefined || isRecord(value.checkpoint) &&
      (value.checkpoint.summary === undefined ||
        isText(value.checkpoint.summary)) &&
      isCount(value.checkpoint.coveredThroughTurn) &&
      isCount(value.checkpoint.retainedFromTurn)) &&
  (value.pendingRecall === undefined || isRecord(value.pendingRecall) &&
      isText(value.pendingRecall.sourceExecutionId) &&
      ['available', 'unavailable'].includes(
        String(value.pendingRecall.evidence),
      )) &&
  (value.latestRequest === undefined || isRecord(value.latestRequest) &&
      isText(value.latestRequest.executionId) &&
      isCount(value.latestRequest.requestOrdinal) &&
      ['parent', 'planner'].includes(String(value.latestRequest.lane)) &&
      isText(value.latestRequest.purpose) &&
      isCount(value.latestRequest.modelStep) &&
      isCount(value.latestRequest.itemCount));

const isEffectiveRuntimeConfig = (
  value: unknown,
): value is EffectiveRuntimeConfig =>
  isRecord(value) && isApiJson(value.definition) &&
  (value.maxSteps === null || isCount(value.maxSteps)) &&
  ['activation', 'definition', 'unevaluated'].includes(
    String(value.maxStepsSource),
  ) &&
  isCount(value.providerTimeoutMs) && isRecord(value.activation) &&
  (value.activation.agent === undefined || isText(value.activation.agent)) &&
  (value.activation.definitionRevision === undefined ||
    isText(value.activation.definitionRevision)) &&
  (value.activation.maxSteps === undefined ||
    isCount(value.activation.maxSteps)) &&
  (value.activation.providerTimeoutMs === undefined ||
    isCount(value.activation.providerTimeoutMs)) &&
  (value.activation.rootProvider === undefined ||
    isText(value.activation.rootProvider));

const isExecutionView = (value: unknown): value is ExecutionView =>
  isRecord(value) && isText(value.executionId) && isText(value.sessionId) &&
  isText(value.task) && isCount(value.turn) && isText(value.createdAt) &&
  (value.submittedByCommandId === undefined ||
    isText(value.submittedByCommandId)) &&
  (value.lifecycle === 'active' || value.lifecycle === 'settled') &&
  ['unknown', 'completed', 'cancelled', 'failed', 'interrupted'].includes(
    String(value.outcome),
  ) && (value.stopReason === undefined || isText(value.stopReason)) &&
  (value.diagnostic === undefined ||
    isRecord(value.diagnostic) && isText(value.diagnostic.code) &&
      isText(value.diagnostic.stage)) &&
  ['canonical', 'non_canonical'].includes(String(value.adoption)) &&
  (value.committedRevision === undefined || isCount(value.committedRevision)) &&
  ['running', 'settling', 'complete', 'unknown'].includes(
    String(value.processSettlement),
  ) && isCount(value.requestCount) && isRecord(value.durability) &&
  isText(value.durability.acknowledgement) &&
  isText(value.durability.generationAvailability) &&
  isText(value.durability.diagnosticCapture) &&
  isText(value.durability.artifactCapture) &&
  ['none', 'partial', 'complete', 'failed'].includes(
    String(value.durability.contextCapture),
  ) && (value.diagnosticId === undefined || isText(value.diagnosticId));

const isCommandTarget = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === 'core' && isText(value.coreEpoch) ||
    value.kind === 'session' && isText(value.sessionId) ||
    value.kind === 'execution' && isText(value.sessionId) &&
      isText(value.executionId));

const isCoreRejection = (value: unknown): boolean =>
  [
    'busy',
    'idle',
    'unavailable',
    'alreadyAccepted',
    'invalid',
    'notFound',
    'failed',
    'admissionFailed',
    'ambiguous',
  ].includes(String(value));

const isFollowUpRecord = (value: unknown): value is FollowUpRecord =>
  isRecord(value) && isText(value.queueId) && isText(value.commandId) &&
  isText(value.sessionId) && isText(value.afterExecutionId) &&
  isText(value.text) &&
  ['queued', 'started', 'discarded', 'startRejected'].includes(
    String(value.status),
  ) &&
  (value.executionId === undefined || isText(value.executionId)) &&
  (value.reason === undefined || isText(value.reason));

const isPendingView = (value: unknown): value is PendingView =>
  isRecord(value) && value.kind === 'core-owned' &&
  (value.activeTask === undefined || isRecord(value.activeTask) &&
      isText(value.activeTask.executionId) &&
      isText(value.activeTask.commandId) &&
      isText(value.activeTask.text)) &&
  (value.steering === undefined || isRecord(value.steering) &&
      isText(value.steering.executionId) && isText(value.steering.commandId) &&
      isText(value.steering.text)) &&
  (value.followUp === undefined || isFollowUpRecord(value.followUp)) &&
  Array.isArray(value.followUps) && value.followUps.every(isFollowUpRecord);

export const decodeCommandResult = <T>(
  value: unknown,
  decodeValue: (value: unknown) => T,
): CommandResult<T> => {
  if (
    !isRecord(value) || !isText(value.commandId) ||
    !isCommandTarget(value.target) ||
    (value.cursor !== undefined && (!isRecord(value.cursor) ||
      !isText(value.cursor.coreEpoch) || !isText(value.cursor.sessionId) ||
      !isCount(value.cursor.revision)))
  ) throw new ApiCodecError();
  if (value.kind === 'accepted') {
    try {
      return { ...value, value: decodeValue(value.value) } as CommandResult<T>;
    } catch {
      throw new ApiCodecError();
    }
  }
  if (value.kind === 'rejected' && isCoreRejection(value.reason)) {
    return value as CommandResult<T>;
  }
  throw new ApiCodecError();
};

export const decodeCommandState = <T>(
  value: unknown,
  decodeValue: (value: unknown) => T,
): CommandState<T> => {
  if (
    isRecord(value) && value.kind === 'processing' && isText(value.commandId)
  ) {
    return value as CommandState<T>;
  }
  return decodeCommandResult(value, decodeValue);
};

export const decodeCoreCommandValue = (value: unknown): CoreCommandValue => {
  if (!isRecord(value)) throw new ApiCodecError();
  if ('deleted' in value) return decodeSessionDeleteValue(value);
  if (value.result === 'requested') return decodeCoreShutdownValue(value);
  if ('snapshot' in value) return decodeSessionOpenValue(value);
  if ('selection' in value) return decodeSelectionChangeValue(value);
  if (value.result === 'renamed' || value.result === 'unchanged') {
    return { result: value.result } satisfies SessionRenameValue;
  }
  if (
    value.action === 'prepare' && isText(value.sourceExecutionId) &&
    ['available', 'unavailable'].includes(String(value.evidence))
  ) {
    return {
      action: 'prepare',
      sourceExecutionId: value.sourceExecutionId,
      evidence: value.evidence as 'available' | 'unavailable',
    } satisfies RecallValue;
  }
  if (value.action === 'clear' && typeof value.cleared === 'boolean') {
    return { action: 'clear', cleared: value.cleared } satisfies RecallValue;
  }
  if (isText(value.queueId)) return { queueId: value.queueId };
  if (!isText(value.executionId)) throw new ApiCodecError();
  if (value.result === undefined) return { executionId: value.executionId };
  if (
    !['requested', 'already_requested', 'idle'].includes(String(value.result))
  ) {
    throw new ApiCodecError();
  }
  return {
    executionId: value.executionId,
    result: value.result as 'requested' | 'already_requested' | 'idle',
  };
};

export const decodeCoreShutdownValue = (
  value: unknown,
): CoreShutdownValue => {
  if (!isRecord(value) || value.result !== 'requested') {
    throw new ApiCodecError();
  }
  return { result: 'requested' };
};

export const decodeSessionOpenValue = (value: unknown): SessionOpenValue => {
  if (!isRecord(value) || !('snapshot' in value)) throw new ApiCodecError();
  return { snapshot: decodeSessionSnapshot(value.snapshot) };
};

export const decodeSessionDeleteValue = (value: unknown): SessionDeleteValue => {
  if (!isRecord(value) || !isText(value.deleted)) throw new ApiCodecError();
  return { deleted: value.deleted };
};

export const decodeSessionRenameValue = (
  value: unknown,
): SessionRenameValue => {
  if (
    !isRecord(value) ||
    value.result !== 'renamed' && value.result !== 'unchanged'
  ) {
    throw new ApiCodecError();
  }
  return value as unknown as SessionRenameValue;
};

export const decodeSelectionChangeValue = (
  value: unknown,
): SelectionChangeValue => {
  if (
    !isRecord(value) ||
    (value.result !== 'selected' && value.result !== 'unchanged') ||
    !isApiSelection(value.selection)
  ) throw new ApiCodecError();
  return value as unknown as SelectionChangeValue;
};

export const decodeCatalogReadResult = (value: unknown): CatalogReadResult => {
  if (!isRecord(value)) throw new ApiCodecError();
  if (
    value.kind === 'providers' && Array.isArray(value.providers) &&
    value.providers.every((item) =>
      isRecord(item) && isText(item.provider) &&
      isApiSelection(item.defaultSelection)
    )
  ) {
    return value as unknown as CatalogReadResult;
  }
  if (
    value.kind === 'models' && isText(value.provider) &&
    (value.metadataStatus === 'loaded' || value.metadataStatus === 'unavailable') &&
    Array.isArray(value.models) &&
    value.models.every((item) =>
      isRecord(item) && isText(item.modelId) && typeof item.favorite === 'boolean' &&
      (item.name === undefined || isText(item.name)) &&
      (item.created === undefined || typeof item.created === 'number') &&
      isText(item.defaultEffort) && Array.isArray(item.efforts) &&
      item.efforts.every(isText)
    )
  ) {
    return value as unknown as CatalogReadResult;
  }
  if (
    value.kind === 'efforts' && isText(value.provider) &&
    ['models.dev', 'catalog', 'unknown', 'override'].includes(value.source as string) &&
    isText(value.modelId) &&
    Array.isArray(value.efforts) && value.efforts.every(isText)
  ) {
    return value as unknown as CatalogReadResult;
  }
  if (
    value.kind === 'credentials' && Array.isArray(value.profiles) &&
    value.profiles.every((item) =>
      isRecord(item) && isText(item.authProfile) &&
      Array.isArray(item.providers) && item.providers.every(isText)
    )
  ) {
    return value as unknown as CatalogReadResult;
  }
  throw new ApiCodecError();
};

export const decodeChatGPTAuthResult = (value: unknown): ChatGPTAuthResult => {
  if (!isRecord(value)) throw new ApiCodecError();
  if (value.kind === 'rejected' && isText(value.reason)) {
    return value as unknown as ChatGPTAuthResult;
  }
  const state = value.state;
  const attempt = value.attempt;
  if (
    value.kind !== 'chatgpt' || !isRecord(state) ||
    (state.selectedRegistrationId !== undefined && !isText(state.selectedRegistrationId)) ||
    !Array.isArray(state.accounts) ||
    !state.accounts.every((account) =>
      isRecord(account) && isText(account.registrationId) && isText(account.label) &&
      typeof account.needsReauthentication === 'boolean'
    ) ||
    (attempt !== undefined &&
      (!isRecord(attempt) || !isText(attempt.attemptId) || !isText(attempt.registrationId) ||
        !isText(attempt.authorizationUrl)))
  ) throw new ApiCodecError();
  return value as unknown as ChatGPTAuthResult;
};

export const decodeCredentialPresenceReadResult = (
  value: unknown,
): CredentialPresenceReadResult => {
  if (
    !isRecord(value) || !Array.isArray(value.profiles) ||
    !value.profiles.every((item) =>
      isRecord(item) && isText(item.authProfile) &&
      Array.isArray(item.providers) && item.providers.every(isText) &&
      ['present', 'missing', 'unknown'].includes(String(item.status))
    )
  ) {
    throw new ApiCodecError();
  }
  return value as unknown as CredentialPresenceReadResult;
};

export const decodeCredentialRegisterResult = (
  value: unknown,
): CredentialRegisterResult => {
  if (
    isRecord(value) && value.kind === 'registered' &&
    isText(value.authProfile) &&
    ['present', 'missing', 'unknown'].includes(String(value.status))
  ) return value as unknown as CredentialRegisterResult;
  if (
    isRecord(value) && value.kind === 'rejected' &&
    ['busy', 'invalid', 'failed'].includes(String(value.reason))
  ) {
    return value as unknown as CredentialRegisterResult;
  }
  throw new ApiCodecError();
};

export const decodeRecallValue = (value: unknown): RecallValue => {
  if (
    isRecord(value) && value.action === 'prepare' &&
    isText(value.sourceExecutionId) &&
    (value.evidence === 'available' || value.evidence === 'unavailable')
  ) {
    return value as unknown as RecallValue;
  }
  if (
    isRecord(value) && value.action === 'clear' &&
    typeof value.cleared === 'boolean'
  ) {
    return value as unknown as RecallValue;
  }
  throw new ApiCodecError();
};

export const decodeContextReadResult = (value: unknown): ContextReadResult => {
  if (!isRecord(value) || !isContextView(value.context)) {
    throw new ApiCodecError();
  }
  return value as unknown as ContextReadResult;
};

export const decodeFollowUpReadResult = (
  value: unknown,
): FollowUpReadResult => {
  if (!isRecord(value) || !isFollowUpRecord(value.followUp)) {
    throw new ApiCodecError();
  }
  return value as unknown as FollowUpReadResult;
};

export const decodeExecutionReadResult = (
  value: unknown,
): ExecutionReadResult => {
  if (!isRecord(value) || !isExecutionView(value.execution)) {
    throw new ApiCodecError();
  }
  return value as unknown as ExecutionReadResult;
};

export const encodeSessionSnapshot = (snapshot: SessionSnapshot): string =>
  JSON.stringify(snapshot);

export const decodeSessionSnapshot = (value: unknown): SessionSnapshot => {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new ApiCodecError();
  const cursor = value.cursor;
  const session = value.session;
  const runtime = value.runtime;
  const conversation = value.conversation;
  if (
    !isRecord(cursor) || !isText(cursor.coreEpoch) ||
    !isText(cursor.sessionId) ||
    !isCount(cursor.revision) || !isRecord(session) || !isText(session.id) ||
    (session.canonicalSessionId !== null &&
      !isText(session.canonicalSessionId)) ||
    (session.persistence !== 'persistent' && session.persistence !== 'none') ||
    !isRecord(session.selection) || !isText(session.selection.provider) ||
    !isText(session.selection.modelId) || !isText(session.selection.effort) ||
    !isRecord(session.position) || !isText(session.position.sessionId) ||
    !isText(session.position.createdAt) || !isText(session.position.agent) ||
    !isCount(session.position.committedTurn) ||
    !isCount(session.position.messageCount) ||
    !isRecord(runtime) || typeof runtime.active !== 'boolean' ||
    (runtime.activeSessionId !== null && !isText(runtime.activeSessionId)) ||
    !['idle', 'preparing', 'running', 'cancelling', 'settling', 'unavailable']
      .includes(
        String(runtime.phase),
      ) ||
    !(runtime.execution === null || isExecutionView(runtime.execution)) ||
    !Array.isArray(runtime.operations) ||
    !runtime.operations.every((item) => typeof item === 'string') ||
    (runtime.effectiveConfig !== undefined &&
      !isEffectiveRuntimeConfig(runtime.effectiveConfig)) ||
    !isRecord(conversation) || !Array.isArray(conversation.messages) ||
    !Array.isArray(conversation.tools) ||
    !Array.isArray(conversation.thinking) ||
    !Array.isArray(conversation.requests) || !isPendingView(value.pending) ||
    !isRecord(value.credentialAvailability) ||
    !['present', 'missing', 'unknown'].includes(
      String(value.credentialAvailability.status),
    ) ||
    !isContextView(value.context)
  ) throw new ApiCodecError();
  return value as unknown as SessionSnapshot;
};

export const decodeSessionSnapshotJson = (json: string): SessionSnapshot => {
  try {
    return decodeSessionSnapshot(JSON.parse(json));
  } catch (error) {
    if (error instanceof ApiCodecError) throw error;
    throw new ApiCodecError();
  }
};

const isRuntimePhase = (value: unknown): boolean =>
  ['idle', 'preparing', 'running', 'cancelling', 'settling', 'unavailable']
    .includes(
      String(value),
    );

const isBuildView = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1 && isText(value.productVersion) &&
    isText(value.buildId) && isText(value.sourceRevision) &&
    typeof value.sourceDirty === 'boolean' && isText(value.denoVersion) &&
    isText(value.target) && isText(value.embeddedRuntimeSha256) &&
    Array.isArray(value.supportedAgentDefinitionApiContracts) &&
    Array.isArray(value.supportedToolDefinitionApiContracts);
};

export const decodeCoreReadView = (value: unknown): CoreReadView => {
  if (
    !isRecord(value) || value.apiVersion !== 1 || !isText(value.coreEpoch) ||
    !isBuildView(value.build) || !isText(value.workspace) ||
    (value.activeSessionId !== null && !isText(value.activeSessionId)) ||
    !isRuntimePhase(value.phase) ||
    !Array.isArray(value.implementedOperations) ||
    !value.implementedOperations.every((item) => typeof item === 'string')
  ) throw new ApiCodecError();
  return value as unknown as CoreReadView;
};

export const decodeSessionsListResult = (
  value: unknown,
): SessionsListResult => {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new ApiCodecError();
  }
  for (const item of value.sessions) {
    if (
      !isRecord(item) || !isText(item.id) || !isText(item.createdAt) ||
      !isText(item.updatedAt) ||
      (item.agent !== 'default' && item.agent !== 'planner' &&
        item.agent !== 'generic') ||
      !isCount(item.committedTurn) || !isCount(item.messageCount) ||
      (item.persistence !== 'persistent' && item.persistence !== 'none')
    ) throw new ApiCodecError();
  }
  return value as unknown as SessionsListResult;
};

export const decodeHistoryReadResult = (value: unknown): HistoryReadResult => {
  if (
    !isRecord(value) ||
    (value.sessionId !== null && !isText(value.sessionId)) ||
    (value.view !== 'session' && value.view !== 'canonical' &&
      value.view !== 'detail') ||
    !isText(value.text)
  ) throw new ApiCodecError();
  return value as unknown as HistoryReadResult;
};

const validChange = (value: unknown): value is SessionChange => {
  if (!isRecord(value) || !isText(value.kind)) return false;
  switch (value.kind) {
    case 'session.replace':
    case 'runtime.replace':
    case 'credentialAvailability.replace':
    case 'context.replace':
      return isRecord(
        value.session ?? value.runtime ?? value.pending ??
          value.credentialAvailability ?? value.context,
      );
    case 'pending.replace':
      return isPendingView(value.pending);
    case 'message.upsert':
    case 'tool.upsert':
    case 'thinking.upsert':
    case 'request.upsert':
      return isRecord(
        value.message ?? value.tool ?? value.thinking ?? value.request,
      );
    case 'message.remove':
      return isText(value.id);
    case 'tool.remove':
      return isText(value.toolOccurrenceId);
    case 'thinking.remove':
    case 'request.remove':
      return isRecord(value.requestKey);
    case 'conversation.omitted.replace':
      return isCount(value.omitted);
    default:
      return false;
  }
};

export const decodeSessionStreamFrame = (
  value: unknown,
): SessionStreamFrame => {
  if (!isRecord(value) || !isText(value.kind)) throw new ApiCodecError();
  if (value.kind === 'session.snapshot') {
    return {
      kind: 'session.snapshot',
      snapshot: decodeSessionSnapshot(value.snapshot),
    };
  }
  if (
    value.kind !== 'session.update' || !isRecord(value.cursor) ||
    !isText(value.cursor.coreEpoch) || !isText(value.cursor.sessionId) ||
    !isCount(value.cursor.revision) || !isCount(value.previousRevision) ||
    !Array.isArray(value.changes) || !value.changes.every(validChange)
  ) throw new ApiCodecError();
  return value as unknown as SessionStreamFrame;
};

export const encodeSessionStreamFrame = (frame: SessionStreamFrame): string =>
  JSON.stringify(frame);
