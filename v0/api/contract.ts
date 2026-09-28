/** Shared, data-only state contract used by the in-process TUI and later clients. */
export type CoreCursor = Readonly<{
  coreEpoch: string;
  sessionId: string;
  revision: number;
}>;

export type ApiSelection = Readonly<{
  provider: string;
  modelId: string;
  effort: string;
}>;

export type ApiCheckpoint = Readonly<{
  summary?: string;
  coveredThroughTurn: number;
  retainedFromTurn: number;
}>;

export type SessionActivation = Readonly<{
  agent?: string;
  definitionRevision?: string;
  maxSteps?: number;
  providerTimeoutMs?: number;
  rootProvider?: string;
}>;

export type EffectiveRuntimeConfig = Readonly<{
  definition: ApiJson;
  maxSteps: number | null;
  maxStepsSource: 'activation' | 'definition' | 'unevaluated';
  providerTimeoutMs: number;
  activation: SessionActivation;
}>;

export type ContextView = Readonly<{
  checkpoint?: ApiCheckpoint;
  pendingRecall?: Readonly<{
    sourceExecutionId: string;
    evidence: 'available' | 'unavailable';
  }>;
  latestRequest?: Readonly<{
    executionId: string;
    requestOrdinal: number;
    lane: 'parent' | 'planner';
    purpose: string;
    modelStep: number;
    itemCount: number;
  }>;
}>;

export type ApiPosition = Readonly<{
  sessionId: string;
  createdAt: string;
  title?: string;
  agent: 'default' | 'planner' | 'generic';
  committedTurn: number;
  messageCount: number;
  checkpoint?: ApiCheckpoint;
}>;

export type ApiJson = null | boolean | number | string | readonly ApiJson[] | {
  readonly [key: string]: ApiJson;
};

export type RequestKey = Readonly<{
  executionId: string;
  lane?: 'parent' | 'planner';
  modelStep: number;
  requestOrdinal?: number;
}>;

export type ApiMessage = Readonly<{
  id: string;
  executionId: string;
  turn: number;
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  requestKey?: RequestKey;
  toolOccurrenceIds?: readonly string[];
}>;

export type ApiToolOccurrence = Readonly<{
  toolOccurrenceId: string;
  executionId: string;
  turn: number;
  requestKey?: RequestKey;
  name: string;
  arguments: ApiJson;
  progress?: string;
  result?: Readonly<{
    text: string;
    outcome: 'success' | 'error';
    terminal?: 'json_result';
  }>;
}>;

export type ApiThinking = Readonly<{
  requestKey: RequestKey;
  turn: number;
  thinkingKind: 'text' | 'summary';
  text: string;
  complete: boolean;
  beforeMessageIndex?: number;
}>;

export type ApiRequestText = Readonly<{
  requestKey: RequestKey;
  turn: number;
  text: string;
}>;

export type ApiRuntimePhase =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'cancelling'
  | 'settling'
  | 'unavailable';

export const CORE_OPERATION_NAMES = [
  'core.read',
  'core.shutdown',
  'session.list',
  'session.open',
  'session.rename',
  'session.read',
  'session.subscribe',
  'history.read',
  'task.submit',
  'execution.cancel',
  'execution.steer',
  'followUp.queue',
  'followUp.read',
  'recall.prepare',
  'recall.clear',
  'context.read',
  'execution.read',
  'command.read',
  'catalog.read',
  'selection.change',
  'path.read',
  'credential.readPresence',
  'credential.register',
] as const;
export type CoreOperationName = typeof CORE_OPERATION_NAMES[number];

export type CommandTarget = Readonly<
  | { kind: 'core'; coreEpoch: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'execution'; sessionId: string; executionId: string }
>;

export type CoreRejection =
  | 'busy'
  | 'idle'
  | 'unavailable'
  | 'alreadyAccepted'
  | 'invalid'
  | 'notFound'
  | 'failed'
  | 'admissionFailed'
  | 'ambiguous';

export type CommandResult<T> = Readonly<
  | {
    kind: 'accepted';
    commandId: string;
    target: CommandTarget;
    cursor?: CoreCursor;
    value: T;
  }
  | {
    kind: 'rejected';
    commandId: string;
    target: CommandTarget;
    reason: CoreRejection;
    cursor?: CoreCursor;
  }
>;

export type CommandState<T> = Readonly<
  | { kind: 'processing'; commandId: string }
  | CommandResult<T>
>;

export type TaskSubmitInput = Readonly<{ commandId: string; text: string }>;
export type TaskSubmitValue = Readonly<{ executionId: string }>;
export type CoreShutdownInput = Readonly<{ commandId: string }>;
export type CoreShutdownValue = Readonly<{ result: 'requested' }>;
export type SelectionChangeInput = Readonly<{
  commandId: string;
  selection: ApiSelection;
}>;
export type SelectionChangeValue = Readonly<{
  result: 'selected' | 'unchanged';
  selection: ApiSelection;
}>;
export type CatalogReadInput = Readonly<
  | { kind: 'providers' }
  | { kind: 'models'; provider: string }
  | { kind: 'efforts'; provider: string; modelId: string }
  | { kind: 'credentials' }
>;
export type ProviderCatalogResult = Readonly<{
  kind: 'providers';
  providers: readonly Readonly<
    { provider: string; defaultSelection: ApiSelection }
  >[];
}>;
export type ModelCatalogResult = Readonly<{
  kind: 'models';
  provider: string;
  models: readonly Readonly<{
    modelId: string;
    defaultEffort: string;
    efforts: readonly string[];
  }>[];
}>;
export type EffortCatalogResult = Readonly<{
  kind: 'efforts';
  provider: string;
  modelId: string;
  efforts: readonly string[];
}>;
export type CredentialCatalogResult = Readonly<{
  kind: 'credentials';
  profiles: readonly Readonly<
    { authProfile: string; providers: readonly string[] }
  >[];
}>;
export type CatalogReadResult =
  | ProviderCatalogResult
  | ModelCatalogResult
  | EffortCatalogResult
  | CredentialCatalogResult;
export type CredentialPresenceReadResult = Readonly<{
  profiles: readonly Readonly<{
    authProfile: string;
    providers: readonly string[];
    status: 'present' | 'missing' | 'unknown';
  }>[];
}>;
export type CredentialRegisterInput = Readonly<
  { authProfile: string; value: string }
>;
export type CredentialRegisterResult = Readonly<
  | {
    kind: 'registered';
    authProfile: string;
    status: 'present' | 'missing' | 'unknown';
  }
  | { kind: 'rejected'; reason: 'busy' | 'invalid' | 'failed' }
>;
export type PathReadInput = Readonly<{ prefix?: string }>;
export type PathReadResult = Readonly<{
  workspace: string;
  complete: boolean;
  paths: readonly string[];
}>;
export type ExecutionCancelInput = Readonly<{ commandId: string }>;
export type ExecutionCancelValue = Readonly<{
  executionId: string;
  result: 'requested' | 'already_requested' | 'idle';
}>;
export type SteeringSubmitInput = Readonly<{ commandId: string; text: string }>;
export type SteeringSubmitValue = Readonly<{ executionId: string }>;
export type FollowUpQueueInput = Readonly<{
  commandId: string;
  afterExecutionId: string;
  text: string;
}>;
export type FollowUpQueueValue = Readonly<{ queueId: string }>;
export type FollowUpRecord = Readonly<{
  queueId: string;
  commandId: string;
  sessionId: string;
  afterExecutionId: string;
  text: string;
  status: 'queued' | 'started' | 'discarded' | 'startRejected';
  executionId?: string;
  reason?: string;
}>;
export type PendingView = Readonly<{
  kind: 'core-owned';
  activeTask?: Readonly<
    { executionId: string; commandId: string; text: string }
  >;
  steering?: Readonly<{ executionId: string; commandId: string; text: string }>;
  followUp?: FollowUpRecord;
  followUps: readonly FollowUpRecord[];
}>;
export type FollowUpReadResult = Readonly<{ followUp: FollowUpRecord }>;
export type SessionOpenValue = Readonly<{ snapshot: SessionSnapshot }>;
export type SessionRenameInput = Readonly<{ commandId: string; title: string }>;
export type SessionRenameValue = Readonly<{ result: 'renamed' | 'unchanged' }>;
export type RecallInput = Readonly<{
  commandId: string;
  action: 'prepare' | 'clear';
  executionId?: string;
}>;
export type RecallValue = Readonly<
  | {
    action: 'prepare';
    sourceExecutionId: string;
    evidence: 'available' | 'unavailable';
  }
  | { action: 'clear'; cleared: boolean }
>;
export type ContextReadResult = Readonly<{ context: ContextView }>;
export type CoreCommandValue =
  | CoreShutdownValue
  | SessionOpenValue
  | SessionRenameValue
  | SelectionChangeValue
  | RecallValue
  | TaskSubmitValue
  | ExecutionCancelValue
  | SteeringSubmitValue
  | FollowUpQueueValue;

export type ExecutionView = Readonly<{
  executionId: string;
  sessionId: string;
  task: string;
  turn: number;
  createdAt: string;
  submittedByCommandId?: string;
  lifecycle: 'active' | 'settled';
  outcome: 'unknown' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  adoption: 'canonical' | 'non_canonical';
  committedRevision?: number;
  /** The coordinator completion Promise includes Worker and child process cleanup. */
  processSettlement: 'running' | 'settling' | 'complete' | 'unknown';
  requestCount: number;
  durability: Readonly<{
    acknowledgement: string;
    generationAvailability: string;
    diagnosticCapture: string;
    artifactCapture: string;
    contextCapture: 'none' | 'partial' | 'complete' | 'failed';
  }>;
  diagnosticId?: string;
}>;

export type ExecutionReadResult = Readonly<{ execution: ExecutionView }>;

export type CoreReadView = Readonly<{
  apiVersion: 1;
  coreEpoch: string;
  build: import('../agent/runtime/build_manifest.ts').BuildManifestV1;
  workspace: string;
  activeSessionId: string | null;
  phase: ApiRuntimePhase;
  implementedOperations: readonly CoreOperationName[];
}>;

export type ApiSessionListEntry = Readonly<{
  id: string;
  agent: 'default' | 'planner' | 'generic';
  createdAt: string;
  updatedAt: string;
  title?: string;
  committedTurn: number;
  messageCount: number;
  persistence: 'persistent' | 'none';
  runtime?: Readonly<{ active: boolean; phase: ApiRuntimePhase }>;
}>;

export type SessionsListResult = Readonly<
  { sessions: readonly ApiSessionListEntry[] }
>;

export type SessionOpenSelection = Readonly<
  | { kind: 'new' | 'continue' | 'none' }
  | { kind: 'exact'; sessionId: string }
>;

export type SessionOpenInput = Readonly<{
  commandId: string;
  selection: SessionOpenSelection;
  activation?: SessionActivation;
  fromSessionId?: string;
}>;

export type SessionOpenResult = CommandResult<SessionOpenValue>;

export type HistoryReadInput = Readonly<{
  sessionRef?: string;
  latest?: boolean;
  view: 'session' | 'canonical' | 'detail';
}>;

export type HistoryReadResult = Readonly<{
  sessionId: string | null;
  view: 'session' | 'canonical' | 'detail';
  text: string;
}>;

/** Slice 1 publishes only state that the current Host already owns. */
export type SessionSnapshot = Readonly<{
  schemaVersion: 1;
  cursor: CoreCursor;
  session: Readonly<{
    id: string;
    canonicalSessionId: string | null;
    persistence: 'persistent' | 'none';
    position: ApiPosition;
    selection: ApiSelection;
    startup: ApiJson;
  }>;
  runtime: Readonly<{
    active: boolean;
    activeSessionId: string | null;
    phase: ApiRuntimePhase;
    execution: ExecutionView | null;
    operations: readonly CoreOperationName[];
    effectiveConfig?: EffectiveRuntimeConfig;
  }>;
  conversation: Readonly<{
    messages: readonly ApiMessage[];
    tools: readonly ApiToolOccurrence[];
    thinking: readonly ApiThinking[];
    requests: readonly ApiRequestText[];
    omitted: number;
  }>;
  pending: PendingView;
  credentialAvailability: Readonly<
    { status: 'present' | 'missing' | 'unknown' }
  >;
  context: ContextView;
}>;

export type SessionChange =
  | Readonly<{ kind: 'session.replace'; session: SessionSnapshot['session'] }>
  | Readonly<{ kind: 'runtime.replace'; runtime: SessionSnapshot['runtime'] }>
  | Readonly<{ kind: 'pending.replace'; pending: SessionSnapshot['pending'] }>
  | Readonly<{
    kind: 'credentialAvailability.replace';
    credentialAvailability: SessionSnapshot['credentialAvailability'];
  }>
  | Readonly<{ kind: 'context.replace'; context: SessionSnapshot['context'] }>
  | Readonly<{ kind: 'message.upsert'; message: ApiMessage }>
  | Readonly<{ kind: 'message.remove'; id: string }>
  | Readonly<{ kind: 'tool.upsert'; tool: ApiToolOccurrence }>
  | Readonly<{ kind: 'tool.remove'; toolOccurrenceId: string }>
  | Readonly<{ kind: 'thinking.upsert'; thinking: ApiThinking }>
  | Readonly<{
    kind: 'thinking.remove';
    requestKey: RequestKey;
    thinkingKind: ApiThinking['thinkingKind'];
  }>
  | Readonly<{ kind: 'request.upsert'; request: ApiRequestText }>
  | Readonly<{ kind: 'request.remove'; requestKey: RequestKey }>
  | Readonly<{ kind: 'conversation.omitted.replace'; omitted: number }>;

export type SessionStreamFrame =
  | Readonly<{ kind: 'session.snapshot'; snapshot: SessionSnapshot }>
  | Readonly<{
    kind: 'session.update';
    cursor: CoreCursor;
    previousRevision: number;
    changes: readonly SessionChange[];
  }>;

export type SessionReadEvent =
  | Readonly<{ kind: 'snapshot'; snapshot: SessionSnapshot }>
  | Readonly<{
    kind: 'runtime_state';
    sessionId: string;
    active: boolean;
    phase: ApiRuntimePhase;
  }>
  | Readonly<{
    kind: 'user_message';
    id: string;
    executionId: string;
    turn: number;
    text: string;
  }>
  | Readonly<{
    kind: 'assistant_text';
    requestKey: RequestKey;
    turn: number;
    text: string;
  }>
  | Readonly<{
    kind: 'assistant_message';
    id: string;
    executionId: string;
    requestKey: RequestKey;
    turn: number;
    text?: string;
    toolOccurrenceIds?: readonly string[];
  }>
  | Readonly<{
    kind: 'assistant_thinking';
    requestKey: RequestKey;
    turn: number;
    thinkingKind: 'text' | 'summary';
    text: string;
    complete: boolean;
  }>
  | Readonly<{
    kind: 'tool_call';
    toolOccurrenceId: string;
    executionId: string;
    turn: number;
    requestKey?: RequestKey;
    name: string;
    arguments: ApiJson;
  }>
  | Readonly<{
    kind: 'tool_progress';
    toolOccurrenceId: string;
    text: string;
  }>
  | Readonly<{
    kind: 'tool_result';
    toolOccurrenceId: string;
    result: NonNullable<ApiToolOccurrence['result']>;
  }>;
