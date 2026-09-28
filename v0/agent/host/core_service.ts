import { projectApplicationSession, projectExecutionView } from './api_projection.ts';
import type { ApplicationQueryPort } from './application_port.ts';
import { type ApplicationService, createApplicationService } from './application_service.ts';
import { renderCanonicalView, renderSessionTimeline } from '../history/history_view.ts';
import { SqliteHistoryV7ProductionStore } from '../history/sqlite_history_v7_production_store.ts';
import type {
  ApiSelection,
  ApiSessionListEntry,
  CatalogReadInput,
  CatalogReadResult,
  CommandResult,
  CommandState,
  CommandTarget,
  ContextReadResult,
  CoreCommandValue,
  CoreOperationName,
  CoreReadView,
  CoreRejection,
  CoreShutdownInput,
  CoreShutdownValue,
  CredentialPresenceReadResult,
  CredentialRegisterInput,
  CredentialRegisterResult,
  ExecutionCancelInput,
  ExecutionCancelValue,
  ExecutionReadResult,
  FollowUpQueueInput,
  FollowUpQueueValue,
  FollowUpReadResult,
  FollowUpRecord,
  HistoryReadInput,
  HistoryReadResult,
  PathReadResult,
  PendingView,
  RecallInput,
  RecallValue,
  SelectionChangeInput,
  SelectionChangeValue,
  SessionActivation,
  SessionChange,
  SessionOpenInput,
  SessionOpenResult,
  SessionRenameInput,
  SessionRenameValue,
  SessionsListResult,
  SessionSnapshot,
  SessionStreamFrame,
  SteeringSubmitInput,
  SteeringSubmitValue,
  TaskSubmitInput,
  TaskSubmitValue,
} from '../../api/contract.ts';
import { CORE_OPERATION_NAMES } from '../../api/contract.ts';
import { diffSessionSnapshots } from '../../api/reducer.ts';
import {
  isSessionId,
  launcherStateRoot,
  sessionPaths,
  SessionStoreError,
  type StoredSessionRecord,
} from '../session/session_store.ts';
import type { NavigationPosition } from '../session/session_navigation.ts';
import { resolveRequestedDefinition } from '../definitions/definition_selection.ts';
import { defaultModelSelectionFor } from '../provider/model_catalog.ts';
import {
  builtinProviderDeclarations,
  loadProviderDeclarations,
  type ProviderDeclarationV1,
  resolveProviderRegistry,
} from '../provider/provider_declaration.ts';
import { isReasoningEffort, type ModelSelection } from '../provider/model_selection.ts';
import {
  createCredentialRegistration,
  CredentialRegistrationError,
} from '../provider/credential_registration.ts';
import { credentialFileFor, credentialFilePresenceAt } from '../provider/credential_file.ts';
import { writeDefaultSelection } from '../provider/default_selection.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import { WorkerRecallSelectionError } from '../worker/worker_host_session.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import { projectRuntimeDisplayState } from '../runtime/startup_orientation.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import { restoreRecordMessages, type WorkerSessionOptions } from '../worker/worker_tui_session.ts';
import { buildWorkspacePathIndex, type WorkspacePathIndex } from '../../tui/file_reference.ts';

const IMPLEMENTED_OPERATIONS: readonly CoreOperationName[] = CORE_OPERATION_NAMES;

export class CoreServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'CoreServiceError';
  }
}

export type CoreInitialSession = Readonly<
  | { kind: 'new' | 'continue' | 'none' }
  | { kind: 'exact'; sessionId: string }
>;

export type CoreServiceOptions =
  & Omit<
    WorkerSessionOptions,
    'persistence' | 'sessionId' | 'lazyInitialHost'
  >
  & Readonly<{ initialSession?: CoreInitialSession }>;

export type CoreSessionFrameSink = (
  frame: SessionStreamFrame | undefined,
) => void;

export interface CoreSessionSubscription {
  readonly snapshot: SessionSnapshot;
  readonly unsubscribe: () => void;
}

export interface CoreService {
  readonly coreEpoch: string;
  beginShutdown(): void;
  coreRead(): CoreReadView;
  coreShutdown(
    input: CoreShutdownInput,
    onAccepted?: () => void,
  ): Promise<CommandResult<CoreShutdownValue>>;
  sessionsList(): Promise<SessionsListResult>;
  sessionRead(sessionId: string): Promise<SessionSnapshot>;
  sessionOpen(input: SessionOpenInput): Promise<SessionOpenResult>;
  sessionRename(
    sessionId: string,
    input: SessionRenameInput,
  ): Promise<CommandResult<SessionRenameValue>>;
  selectionChange(
    sessionId: string,
    input: SelectionChangeInput,
  ): Promise<CommandResult<SelectionChangeValue>>;
  catalogRead(input: CatalogReadInput): CatalogReadResult;
  credentialPresenceRead(): Promise<CredentialPresenceReadResult>;
  credentialRegister(
    input: CredentialRegisterInput,
  ): Promise<CredentialRegisterResult>;
  pathRead(prefix?: string): Promise<PathReadResult>;
  recall(
    sessionId: string,
    input: RecallInput,
  ): Promise<CommandResult<RecallValue>>;
  contextRead(sessionId: string): Promise<ContextReadResult>;
  taskSubmit(
    sessionId: string,
    input: TaskSubmitInput,
  ): Promise<CommandResult<TaskSubmitValue>>;
  executionCancel(
    sessionId: string,
    executionId: string,
    input: ExecutionCancelInput,
  ): Promise<CommandResult<ExecutionCancelValue>>;
  steeringSubmit(
    sessionId: string,
    executionId: string,
    input: SteeringSubmitInput,
  ): Promise<CommandResult<SteeringSubmitValue>>;
  followUpQueue(
    sessionId: string,
    input: FollowUpQueueInput,
  ): Promise<CommandResult<FollowUpQueueValue>>;
  followUpRead(sessionId: string, queueId: string): Promise<FollowUpReadResult>;
  commandRead(commandId: string): Promise<CommandState<CoreCommandValue>>;
  executionRead(executionId: string): Promise<ExecutionReadResult>;
  historyRead(input: HistoryReadInput): Promise<HistoryReadResult>;
  subscribeSession(
    sessionId: string,
    sink: CoreSessionFrameSink,
  ): Promise<CoreSessionSubscription>;
  close(): Promise<void>;
}

interface CoreSlot {
  readonly service: ApplicationService;
  snapshot: SessionSnapshot;
  readonly options: WorkerSessionOptions;
  unsubscribeObservations?: () => void;
}

interface TrackedCommand {
  readonly signature: string;
  state: CommandState<CoreCommandValue>;
  result: Promise<CommandResult<CoreCommandValue>>;
}

interface TrackedExecution {
  readonly sessionId: string;
  readonly submittedByCommandId: string;
  processSettlement: 'running' | 'complete';
}

const updateChanges = (
  before: SessionSnapshot,
  after: SessionSnapshot,
): readonly SessionChange[] => diffSessionSnapshots(before, after);

const currentSnapshot = (
  service: ApplicationService,
  coreEpoch: string,
  revision: number,
  executionStates: ReadonlyMap<string, {
    readonly submittedByCommandId?: string;
    readonly processSettlement?: import('../../api/contract.ts').ExecutionView['processSettlement'];
  }>,
): SessionSnapshot =>
  projectApplicationSession(service.query, {
    coreEpoch,
    revision,
  }, executionStates);

const publicSessionMode = (record: StoredSessionRecord) => {
  const selection = record.activeModel;
  return projectRuntimeDisplayState({
    productVersion: buildManifest().productVersion,
    workspaceRoot: record.workspaceRoot,
    agentId: record.agent === 'planner' ? 'planner' : 'default',
    profileId: modelRouteProfileId(selection),
    provider: selection.provider,
    modelId: selection.modelId,
    effort: selection.effort,
    sessionMode: 'session',
    skillNames: [],
  });
};

const positionFromRecord = (
  record: StoredSessionRecord,
  checkpoint: Awaited<
    ReturnType<SqliteHistoryV7ProductionStore['readCheckpoint']>
  >,
): NavigationPosition => ({
  sessionId: record.sessionId,
  createdAt: record.createdAt,
  ...(record.title === null ? {} : { title: record.title }),
  agent: record.agent,
  committedTurn: record.nextTurn - 1,
  messageCount: record.transcript.length,
  ...(checkpoint === undefined ? {} : {
    checkpoint: {
      coveredThroughTurn: checkpoint.coveredThroughTurn,
      retainedFromTurn: checkpoint.retainedFromTurn,
    },
  }),
});

const sessionNotFound = (): CoreServiceError =>
  new CoreServiceError(404, 'session_not_found', 'session not found');

const selectionForDeclaration = (
  declaration: ProviderDeclarationV1,
  modelId: string,
  effort: string,
): ModelSelection => ({
  provider: declaration.providerId,
  api: declaration.providerId === 'openrouter-chat'
    ? 'openrouter-chat-completions'
    : declaration.providerId === 'openrouter-responses'
    ? 'openrouter-responses'
    : declaration.protocol,
  authProfile: declaration.authProfile,
  modelId,
  effort,
} as ModelSelection);

const apiSelection = (selection: ModelSelection): ApiSelection => ({
  provider: selection.provider,
  modelId: selection.modelId,
  effort: selection.effort,
});

/** Core query and slot owner. It uses the existing SQLite history and Host composition. */
export const createCoreService = async (
  options: CoreServiceOptions,
): Promise<CoreService> => {
  const { initialSession, ...workerOptions } = options;
  const resolveManagedInstruction = workerOptions.physicalIoMode !== 'provider-free' ||
    workerOptions.dataRoot !== undefined ||
    workerOptions.configRoot !== undefined;
  const runtimePaths = resolveManagedInstruction && workerOptions.configRoot === undefined &&
      workerOptions.dataRoot === undefined
    ? resolveRuntimePaths()
    : undefined;
  const configRoot = workerOptions.configRoot ??
    (workerOptions.dataRoot === undefined
      ? runtimePaths?.configRoot
      : `${workerOptions.dataRoot}/config`);
  const providerDeclarations = workerOptions.providerDeclarations ??
    (resolveManagedInstruction && configRoot !== undefined
      ? resolveProviderRegistry(
        builtinProviderDeclarations(),
        await loadProviderDeclarations({ configRoot }),
      )
      : Object.freeze([] as const));
  const hostOptions = {
    ...workerOptions,
    ...(configRoot === undefined ? {} : { configRoot }),
    providerDeclarations,
  };
  const workspace = await resolveWorkspace(options.workspaceRoot);
  const stateRoot = options.stateRoot ?? launcherStateRoot();
  const statePaths = await sessionPaths(stateRoot, workspace.root);
  const databasePath = `${statePaths.root}/history-v7.sqlite3`;
  let databaseExists = await Deno.stat(databasePath).then((info) => info.isFile)
    .catch(() => false);
  const history = new SqliteHistoryV7ProductionStore(
    stateRoot,
    workspace.root,
    { readOnly: true },
  );
  let historyInitialized = false;
  const ensureHistory = async (): Promise<boolean> => {
    if (!databaseExists) return false;
    if (!historyInitialized) {
      await history.initialize();
      historyInitialized = true;
    }
    return true;
  };
  await ensureHistory();

  const coreEpoch = crypto.randomUUID().toLowerCase();
  let slot: CoreSlot | undefined;
  let closePromise: Promise<void> | undefined;
  let admissionClosed = false;
  let openingSlot = false;
  const commands = new Map<string, TrackedCommand>();
  const executions = new Map<string, TrackedExecution>();
  const knownServices = new Map<string, ApplicationService>();
  const allServices = new Set<ApplicationService>();
  const liveSubscriptions = new Set<() => void>();
  const credentialRegistrations = new Set<Promise<CredentialRegisterResult>>();
  const sessionSubscribers = new Map<string, Set<CoreSessionFrameSink>>();
  const sessionSnapshots = new Map<string, SessionSnapshot>();
  const providerById = new Map(
    providerDeclarations.map((
      declaration,
    ) => [declaration.providerId, declaration]),
  );
  const credentialRegistration = createCredentialRegistration({
    ...(configRoot === undefined ? {} : { configRoot }),
    providerDeclarations,
  });
  let workspacePathIndex: WorkspacePathIndex | undefined;
  let workspacePathIndexPromise: Promise<WorkspacePathIndex> | undefined;

  const beginShutdown = (): void => {
    if (admissionClosed) return;
    admissionClosed = true;
    for (const closeStream of [...liveSubscriptions]) closeStream();
  };

  const subscribersFor = (sessionId: string): Set<CoreSessionFrameSink> => {
    let subscribers = sessionSubscribers.get(sessionId);
    if (subscribers === undefined) {
      subscribers = new Set();
      sessionSubscribers.set(sessionId, subscribers);
    }
    return subscribers;
  };

  const publishSnapshot = (candidate: SessionSnapshot): SessionSnapshot => {
    const sessionId = candidate.session.id;
    const previous = sessionSnapshots.get(sessionId);
    if (previous === undefined) {
      sessionSnapshots.set(sessionId, candidate);
      return candidate;
    }
    const updated = {
      ...candidate,
      cursor: { ...candidate.cursor, revision: previous.cursor.revision + 1 },
    };
    const changes = updateChanges(previous, updated);
    if (changes.length === 0) return previous;
    sessionSnapshots.set(sessionId, updated);
    const frame: SessionStreamFrame = {
      kind: 'session.update',
      cursor: updated.cursor,
      previousRevision: previous.cursor.revision,
      changes,
    };
    for (const sink of [...subscribersFor(sessionId)]) sink(frame);
    return updated;
  };

  const pendingForSession = (
    sessionId: string,
    activeOwner?: ApplicationService,
  ): PendingView => {
    const active = activeOwner ??
      (slot?.snapshot.session.id === sessionId ? slot.service : undefined);
    const visible = active?.tasks.pendingView(sessionId) ?? {
      kind: 'core-owned' as const,
      followUps: [] as readonly FollowUpRecord[],
    };
    const retained = new Map<string, FollowUpRecord>();
    for (const owner of allServices) {
      const view = owner.tasks.pendingView(sessionId);
      for (const record of view.followUps) retained.set(record.queueId, record);
      if (owner !== active && view.followUp !== undefined) {
        retained.set(view.followUp.queueId, view.followUp);
      }
    }
    return {
      kind: 'core-owned',
      ...(visible.activeTask === undefined ? {} : { activeTask: visible.activeTask }),
      ...(visible.steering === undefined ? {} : { steering: visible.steering }),
      ...(visible.followUp === undefined ? {} : { followUp: visible.followUp }),
      followUps: [...retained.values()],
    };
  };

  const slotBusy = (target: CoreSlot): boolean =>
    target.service.tasks.isBusy() ||
    target.service.query.currentSession().runtime.active;

  const operations = (target?: CoreSlot): readonly CoreOperationName[] => {
    const result: CoreOperationName[] = CORE_OPERATION_NAMES.filter((name) =>
      name !== 'task.submit' && name !== 'execution.cancel' &&
      name !== 'execution.steer' && name !== 'followUp.queue' &&
      name !== 'session.open' &&
      name !== 'session.rename' && name !== 'recall.prepare' &&
      name !== 'recall.clear' &&
      name !== 'selection.change' && name !== 'credential.register' &&
      name !== 'core.shutdown'
    );
    if (!admissionClosed) result.push('core.shutdown');
    if (!openingSlot && (slot === undefined || !slotBusy(slot))) {
      result.push('session.open');
    }
    if (!openingSlot && (slot === undefined || !slotBusy(slot))) {
      result.push('credential.register');
    }
    if (target !== undefined && target === slot && !openingSlot) {
      if (!slotBusy(target) && target.service.session.isAvailable()) {
        result.push(
          'task.submit',
          'session.rename',
          'recall.prepare',
          'recall.clear',
          'selection.change',
        );
      }
      if (target.service.tasks.activeExecutionId() !== undefined) {
        result.push('execution.cancel');
        if (target.service.tasks.canSteer()) result.push('execution.steer');
        if (target.service.tasks.canQueueFollowUp()) {
          result.push('followUp.queue');
        }
      }
    }
    return result;
  };

  const refreshSlotSnapshot = (target: CoreSlot): void => {
    for (const [executionId, state] of target.service.tasks.executionStates()) {
      executions.set(executionId, state);
    }
    const previous = target.snapshot;
    const projected = currentSnapshot(
      target.service,
      coreEpoch,
      previous.cursor.revision + 1,
      executions,
    );
    const updated: SessionSnapshot = {
      ...projected,
      pending: pendingForSession(target.snapshot.session.id, target.service),
      runtime: {
        ...projected.runtime,
        operations: operations(target),
      },
    };
    target.snapshot = publishSnapshot(updated);
    for (const [sessionId, viewed] of sessionSnapshots) {
      if (sessionId === target.snapshot.session.id) continue;
      publishSnapshot({
        ...viewed,
        runtime: {
          active: false,
          activeSessionId: slot?.snapshot.session.id ?? null,
          phase: 'idle',
          execution: viewed.runtime.execution,
          operations: operations(),
        },
      });
    }
  };

  const makeSlot = async (
    selection: CoreInitialSession,
    activation: SessionActivation = {},
    fromSessionId?: string,
  ): Promise<CoreSlot> => {
    const inherited = fromSessionId === undefined ? hostOptions : (slot?.options ?? hostOptions);
    let initialModelSelection = inherited.initialModelSelection;
    if (fromSessionId !== undefined) {
      const source = slot?.snapshot.session.id === fromSessionId
        ? slot.service.query.currentSession().selection
        : (await history.readWorker(fromSessionId)).activeModel;
      initialModelSelection = structuredClone(source);
    }
    if (
      activation.rootProvider !== undefined &&
      (selection.kind === 'new' || selection.kind === 'none')
    ) {
      initialModelSelection = defaultModelSelectionFor(activation.rootProvider);
    }
    let definitionSelection = inherited.selection;
    let agent = inherited.agent;
    if (
      activation.agent !== undefined ||
      activation.definitionRevision !== undefined
    ) {
      definitionSelection = await resolveRequestedDefinition(
        activation.agent,
        activation.definitionRevision,
        options.dataRoot,
        options.configRoot,
      );
      agent = definitionSelection.id;
    } else if (selection.kind === 'exact') {
      const record = await history.readWorker(selection.sessionId);
      if (definitionSelection?.id !== record.agent) {
        definitionSelection = await resolveRequestedDefinition(
          record.agent === 'default' ? undefined : record.agent,
          undefined,
          options.dataRoot,
          options.configRoot,
        );
      }
      agent = record.agent;
    }
    const activationMetadata = {
      ...(inherited.activation ?? {}),
      ...activation,
    };
    if (activation.agent !== undefined) {
      delete activationMetadata.definitionRevision;
    }
    if (activation.definitionRevision !== undefined) {
      delete activationMetadata.agent;
    }
    if (selection.kind === 'exact' || selection.kind === 'continue') {
      delete activationMetadata.rootProvider;
    } else if (initialModelSelection !== undefined) {
      activationMetadata.rootProvider = initialModelSelection.provider;
    }
    const invocation: WorkerSessionOptions = {
      ...inherited,
      selection: definitionSelection,
      agent,
      initialModelSelection,
      rootMaxSteps: activation.maxSteps ?? inherited.rootMaxSteps,
      providerTimeoutMs: activation.providerTimeoutMs ??
        inherited.providerTimeoutMs,
      persistence: selection.kind === 'exact' ? 'session' : selection.kind,
      sessionId: selection.kind === 'exact' ? selection.sessionId : undefined,
      lazyInitialHost: true,
      activation: activationMetadata,
    };
    const service = await createApplicationService(invocation);
    const sessionId = service.query.currentSession().sessionId;
    const initial = currentSnapshot(
      service,
      coreEpoch,
      sessionSnapshots.get(sessionId)?.cursor.revision ?? 0,
      executions,
    );
    if (!sessionSnapshots.has(sessionId)) {
      sessionSnapshots.set(sessionId, initial);
    }
    const next: CoreSlot = {
      service,
      options: invocation,
      snapshot: initial,
    };
    knownServices.set(service.query.currentSession().sessionId, service);
    allServices.add(service);
    next.unsubscribeObservations = service.subscribe(() => refreshSlotSnapshot(next));
    return next;
  };

  const openSlot = async (
    selection: CoreInitialSession,
    activation?: SessionActivation,
    fromSessionId?: string,
  ): Promise<SessionSnapshot> => {
    if (selection.kind === 'exact' && !isSessionId(selection.sessionId)) {
      throw new CoreServiceError(
        400,
        'invalid_session_id',
        'invalid session id',
      );
    }
    if (
      selection.kind === 'exact' &&
      slot?.snapshot.session.id === selection.sessionId
    ) {
      return structuredClone(slot.snapshot);
    }
    const next = await makeSlot(selection, activation, fromSessionId);
    databaseExists = await Deno.stat(databasePath).then((info) => info.isFile)
      .catch(() => false);
    await ensureHistory();
    const previous = slot;
    slot = next;
    refreshSlotSnapshot(next);
    if (previous !== undefined) {
      previous.unsubscribeObservations?.();
      await previous.service.close();
    }
    return structuredClone(next.snapshot);
  };

  const sessionRead = async (sessionId: string): Promise<SessionSnapshot> => {
    if (!isSessionId(sessionId)) {
      throw new CoreServiceError(
        400,
        'invalid_session_id',
        'invalid session id',
      );
    }
    if (slot?.snapshot.session.id === sessionId) {
      return structuredClone(slot.snapshot);
    }
    if (!await ensureHistory()) throw sessionNotFound();
    let record: StoredSessionRecord;
    try {
      record = await history.readWorker(sessionId);
    } catch (error) {
      if (
        error instanceof SessionStoreError && error.code === 'session_not_found'
      ) {
        throw sessionNotFound();
      }
      throw error;
    }
    const checkpoint = await history.readCheckpoint(sessionId);
    const sessionHistory = history.readSessionHistory(sessionId);
    const storedExecutions = history.listExecutionsForSession(sessionId);
    const restored = restoreRecordMessages(record, history, sessionHistory);
    const query: ApplicationQueryPort = {
      currentSession: () => ({
        sessionId,
        persistence: 'session',
        position: positionFromRecord(record, checkpoint),
        selection: structuredClone(record.activeModel),
        startup: publicSessionMode(record),
        runtime: { active: false, phase: 'idle' },
        transcript: structuredClone(record.transcript),
        restored,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      }),
      sessionHistory: () => sessionHistory,
      executions: () => storedExecutions,
      executionEvents: (executionId) => history.listExecutionEvents(executionId),
      semanticOccurrences: (executionId) => history.listSemanticOccurrences(executionId),
      assistantTextStates: (executionId) => history.listAssistantTextStates(executionId),
      executionContext: (executionId) => history.listExecutionContext(executionId),
    };
    const projected = projectApplicationSession(query, {
      coreEpoch,
      revision: 0,
    }, executions);
    return publishSnapshot({
      ...projected,
      pending: pendingForSession(sessionId),
      runtime: {
        ...projected.runtime,
        active: false,
        activeSessionId: slot?.snapshot.session.id ?? null,
        phase: 'idle',
        operations: operations(),
      },
    });
  };

  const rejected = <T>(
    commandId: string,
    target: CommandTarget,
    reason: CoreRejection,
  ): CommandResult<T> => ({
    kind: 'rejected',
    commandId,
    target,
    reason,
    ...(target.kind === 'core' || slot?.snapshot.session.id !== target.sessionId
      ? {}
      : { cursor: structuredClone(slot.snapshot.cursor) }),
  });

  const registerCommand = <T extends CoreCommandValue>(
    commandId: string,
    signature: string,
    target: CommandTarget,
    work: () => Promise<CommandResult<T>>,
    onRegistered?: () => void,
  ): Promise<CommandResult<T>> => {
    const existing = commands.get(commandId);
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        throw new CoreServiceError(
          409,
          'command_id_conflict',
          'commandId was reused',
        );
      }
      return existing.result.then((value) => structuredClone(value) as CommandResult<T>);
    }
    if (admissionClosed) {
      return Promise.resolve(rejected(commandId, target, 'unavailable'));
    }
    let resolve!: (value: CommandResult<T>) => void;
    const result = new Promise<CommandResult<T>>((done) => resolve = done);
    const tracked: TrackedCommand = {
      signature,
      state: { kind: 'processing', commandId },
      result,
    };
    commands.set(commandId, tracked);
    onRegistered?.();
    // Register first; work reserves the slot synchronously before its first await.
    void work().then((value) => {
      tracked.state = value;
      resolve(value);
    }, () => {
      const value = rejected<T>(commandId, target, 'failed');
      tracked.state = value;
      resolve(value);
    });
    return result.then((value) => structuredClone(value));
  };

  const executionRead = async (
    executionId: string,
  ): Promise<ExecutionReadResult> => {
    const active = slot;
    const row =
      active?.service.query.executions().find((item) => item.executionId === executionId) ??
        (await ensureHistory()
          ? history.listExecutions().find((item) => item.executionId === executionId)
          : undefined);
    if (row === undefined) {
      throw new CoreServiceError(
        404,
        'execution_not_found',
        'execution not found',
      );
    }
    const query = row.sessionCorrelation === active?.snapshot.session.id
      ? active.service.query
      : undefined;
    const execution = projectExecutionView(
      row,
      query?.currentSession().runtime ?? { active: false, phase: 'idle' },
      executions.get(executionId),
      query?.executionEvents(executionId) ??
        history.listExecutionEvents(executionId),
    );
    return { execution: execution! };
  };

  const service: CoreService = {
    coreEpoch,
    beginShutdown,
    coreRead(): CoreReadView {
      return {
        apiVersion: 1,
        coreEpoch,
        build: buildManifest(),
        workspace: workspace.root,
        activeSessionId: slot?.snapshot.session.id ?? null,
        phase: slot?.snapshot.runtime.phase ?? 'idle',
        implementedOperations: IMPLEMENTED_OPERATIONS,
      };
    },
    coreShutdown(input, onAccepted): Promise<CommandResult<CoreShutdownValue>> {
      const target: CommandTarget = { kind: 'core', coreEpoch };
      return registerCommand(
        input.commandId,
        JSON.stringify({ kind: 'core.shutdown' }),
        target,
        async () =>
          await Promise.resolve({
            kind: 'accepted',
            commandId: input.commandId,
            target,
            value: { result: 'requested' },
          }),
        () => {
          beginShutdown();
          onAccepted?.();
        },
      );
    },
    catalogRead(input: CatalogReadInput): CatalogReadResult {
      if (input.kind === 'providers') {
        return {
          kind: 'providers',
          providers: providerDeclarations.map((declaration) => ({
            provider: declaration.providerId,
            defaultSelection: {
              provider: declaration.providerId,
              modelId: declaration.defaults.modelId,
              effort: declaration.defaults.effort,
            },
          })),
        };
      }
      if (input.kind === 'models') {
        const declaration = providerById.get(input.provider);
        if (declaration === undefined) {
          throw new CoreServiceError(
            404,
            'provider_not_found',
            'provider not found',
          );
        }
        return {
          kind: 'models',
          provider: input.provider,
          models: declaration.modelCatalog.entries.map((entry) => ({
            modelId: entry.modelId,
            defaultEffort: entry.defaultEffort,
            efforts: entry.efforts,
          })),
        };
      }
      if (input.kind === 'efforts') {
        const declaration = providerById.get(input.provider);
        if (declaration === undefined) {
          throw new CoreServiceError(
            404,
            'provider_not_found',
            'provider not found',
          );
        }
        const model = declaration.modelCatalog.entries.find((entry) =>
          entry.modelId === input.modelId
        );
        if (model === undefined) {
          throw new CoreServiceError(404, 'model_not_found', 'model not found');
        }
        return {
          kind: 'efforts',
          provider: input.provider,
          modelId: input.modelId,
          efforts: model.efforts,
        };
      }
      if (input.kind === 'credentials') {
        return {
          kind: 'credentials',
          profiles: credentialRegistration.targets(),
        };
      }
      throw new CoreServiceError(
        400,
        'invalid_catalog_kind',
        'invalid catalog kind',
      );
    },
    async credentialPresenceRead(): Promise<CredentialPresenceReadResult> {
      const profiles = await Promise.all(
        credentialRegistration.targets().map(async (profile) => ({
          ...profile,
          status: await credentialFilePresenceAt(
            credentialFileFor(profile.authProfile, configRoot),
          ),
        })),
      );
      const active = slot;
      if (active !== undefined) {
        await active.service.currentSession().refreshCredentialAvailability();
        if (slot === active) refreshSlotSnapshot(active);
      }
      return { profiles };
    },
    credentialRegister(
      input: CredentialRegisterInput,
    ): Promise<CredentialRegisterResult> {
      if (admissionClosed) {
        return Promise.reject(
          new CoreServiceError(503, 'core_stopping', 'Core is stopping'),
        );
      }
      const operation = (async (): Promise<CredentialRegisterResult> => {
        if (
          openingSlot || slot !== undefined && slotBusy(slot)
        ) return { kind: 'rejected', reason: 'busy' };
        const profile = credentialRegistration.targets().find((candidate) =>
          candidate.authProfile === input.authProfile
        );
        if (profile === undefined) {
          return { kind: 'rejected', reason: 'invalid' };
        }
        openingSlot = true;
        if (slot !== undefined) refreshSlotSnapshot(slot);
        try {
          await credentialRegistration.save(input.authProfile, input.value);
          const status = await credentialFilePresenceAt(
            credentialFileFor(input.authProfile, configRoot),
          );
          const active = slot;
          if (active !== undefined) {
            await active.service.currentSession().refreshCredentialAvailability();
            if (slot === active) refreshSlotSnapshot(active);
          }
          return { kind: 'registered', authProfile: input.authProfile, status };
        } catch (error) {
          return {
            kind: 'rejected',
            reason: error instanceof CredentialRegistrationError &&
                error.code !== 'credential_registration_write_failed'
              ? 'invalid'
              : 'failed',
          };
        } finally {
          openingSlot = false;
          if (slot !== undefined) refreshSlotSnapshot(slot);
        }
      })();
      credentialRegistrations.add(operation);
      void operation.then(
        () => credentialRegistrations.delete(operation),
        () => credentialRegistrations.delete(operation),
      );
      return operation;
    },
    async pathRead(prefix?: string): Promise<PathReadResult> {
      if (workspacePathIndex === undefined) {
        workspacePathIndexPromise ??= buildWorkspacePathIndex(workspace.root);
        try {
          workspacePathIndex = await workspacePathIndexPromise;
        } finally {
          workspacePathIndexPromise = undefined;
        }
      }
      const allPaths = workspacePathIndex.snapshot().candidates.map((
        candidate,
      ) => candidate.path);
      const normalizedPrefix = prefix?.startsWith('./') ? prefix.slice(2) : prefix;
      return {
        workspace: workspace.root,
        complete: workspacePathIndex.complete,
        paths: normalizedPrefix === undefined
          ? allPaths
          : allPaths.filter((path) => path.startsWith(normalizedPrefix)),
      };
    },
    async sessionsList(): Promise<SessionsListResult> {
      const listed = await ensureHistory()
        ? await history.listWorker()
        : { sessions: [], skippedInvalid: 0 };
      const byId = new Map<string, ApiSessionListEntry>();
      for (const item of listed.sessions) {
        byId.set(item.id, {
          id: item.id,
          agent: item.agent,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          ...(item.title === undefined ? {} : { title: item.title }),
          committedTurn: item.turnCount,
          messageCount: item.messageCount,
          persistence: 'persistent',
        });
      }
      if (slot !== undefined) {
        const snapshot = slot.snapshot;
        const position = snapshot.session.position;
        const existing = byId.get(snapshot.session.id);
        byId.set(snapshot.session.id, {
          id: snapshot.session.id,
          agent: position.agent,
          createdAt: position.createdAt,
          updatedAt: existing?.updatedAt ?? position.createdAt,
          ...(position.title === undefined ? {} : { title: position.title }),
          committedTurn: position.committedTurn,
          messageCount: position.messageCount,
          persistence: snapshot.session.persistence,
          runtime: snapshot.runtime,
        });
      }
      return { sessions: [...byId.values()] };
    },
    sessionRead,
    async sessionOpen(input: SessionOpenInput): Promise<SessionOpenResult> {
      const target: CommandTarget = { kind: 'core', coreEpoch };
      return await registerCommand(
        input.commandId,
        JSON.stringify({ kind: 'session.open', ...input }),
        target,
        async () => {
          const replacesCurrent = !(input.selection.kind === 'exact' &&
            slot?.snapshot.session.id === input.selection.sessionId);
          if (
            openingSlot ||
            replacesCurrent && slot !== undefined && slotBusy(slot)
          ) {
            return rejected(input.commandId, target, 'busy');
          }
          if (
            !replacesCurrent && Object.keys(input.activation ?? {}).length > 0
          ) {
            return rejected(input.commandId, target, 'invalid');
          }
          openingSlot = true;
          if (slot !== undefined) refreshSlotSnapshot(slot);
          try {
            let selection = input.selection;
            if (selection.kind === 'continue' && await ensureHistory()) {
              const latest = (await history.listWorker()).sessions[0];
              if (latest !== undefined) {
                selection = { kind: 'exact', sessionId: latest.id };
              }
            }
            if (
              selection.kind === 'exact' &&
              slot?.snapshot.session.id === selection.sessionId &&
              Object.keys(input.activation ?? {}).length > 0
            ) return rejected(input.commandId, target, 'invalid');
            await openSlot(selection, input.activation, input.fromSessionId);
            // A subscription follows its Session when that Session moves between
            // saved viewing and the execution slot. Rehydrate the read model at
            // this boundary; later observations use the same subscriber set.
            for (const [sessionId, subscribers] of sessionSubscribers) {
              if (subscribers.size === 0) continue;
              try {
                await sessionRead(sessionId);
              } catch (error) {
                if (
                  !(error instanceof CoreServiceError && error.status === 404)
                ) throw error;
                for (const sink of [...subscribers]) sink(undefined);
              }
            }
            openingSlot = false;
            refreshSlotSnapshot(slot!);
            return {
              kind: 'accepted',
              commandId: input.commandId,
              target,
              cursor: structuredClone(slot!.snapshot.cursor),
              value: { snapshot: structuredClone(slot!.snapshot) },
            };
          } catch (error) {
            const reason: CoreRejection = error instanceof SessionStoreError &&
                  error.code === 'session_not_found' ||
                error instanceof Error && error.message === 'session not found'
              ? 'notFound'
              : 'failed';
            return rejected(input.commandId, target, reason);
          } finally {
            openingSlot = false;
            if (slot !== undefined) refreshSlotSnapshot(slot);
          }
        },
      );
    },
    async sessionRename(
      sessionId,
      input,
    ): Promise<CommandResult<SessionRenameValue>> {
      const target: CommandTarget = { kind: 'session', sessionId };
      return await registerCommand(
        input.commandId,
        JSON.stringify({
          kind: 'session.rename',
          sessionId,
          title: input.title,
        }),
        target,
        async () => {
          const active = slot;
          if (
            active === undefined || active.snapshot.session.id !== sessionId
          ) {
            return rejected(
              input.commandId,
              target,
              'notFound',
            );
          }
          if (openingSlot || slotBusy(active)) {
            return rejected(input.commandId, target, 'busy');
          }
          openingSlot = true;
          refreshSlotSnapshot(active);
          try {
            const result = await active.service.session.renameTitle(
              input.title,
            );
            if (result === 'busy' || result === 'unavailable') {
              return rejected(
                input.commandId,
                target,
                result,
              );
            }
            openingSlot = false;
            refreshSlotSnapshot(active);
            return {
              kind: 'accepted',
              commandId: input.commandId,
              target,
              cursor: structuredClone(active.snapshot.cursor),
              value: { result },
            };
          } finally {
            openingSlot = false;
            refreshSlotSnapshot(active);
          }
        },
      );
    },
    async selectionChange(
      sessionId,
      input,
    ): Promise<CommandResult<SelectionChangeValue>> {
      const target: CommandTarget = { kind: 'session', sessionId };
      return await registerCommand(
        input.commandId,
        JSON.stringify({
          kind: 'selection.change',
          sessionId,
          selection: input.selection,
        }),
        target,
        async () => {
          const active = slot;
          if (
            active === undefined || active.snapshot.session.id !== sessionId
          ) {
            return rejected(input.commandId, target, 'notFound');
          }
          if (openingSlot || slotBusy(active)) {
            return rejected(input.commandId, target, 'busy');
          }
          const declaration = providerById.get(input.selection.provider);
          const model = declaration?.modelCatalog.entries.find((entry) =>
            entry.modelId === input.selection.modelId
          );
          if (
            declaration === undefined || model === undefined ||
            !isReasoningEffort(input.selection.effort) ||
            !model.efforts.includes(input.selection.effort)
          ) return rejected(input.commandId, target, 'invalid');
          const selection = selectionForDeclaration(
            declaration,
            input.selection.modelId,
            input.selection.effort,
          );
          openingSlot = true;
          refreshSlotSnapshot(active);
          try {
            const result = await active.service.currentSession().selectModel(
              selection,
            );
            if (result === 'busy' || result === 'unavailable') {
              return rejected(input.commandId, target, result);
            }
            if (configRoot !== undefined) {
              try {
                await writeDefaultSelection(configRoot, selection);
              } catch {
                // Session selection remains authoritative, matching the existing TUI path.
              }
            }
            openingSlot = false;
            refreshSlotSnapshot(active);
            return {
              kind: 'accepted',
              commandId: input.commandId,
              target,
              cursor: structuredClone(active.snapshot.cursor),
              value: { result, selection: apiSelection(selection) },
            };
          } finally {
            openingSlot = false;
            refreshSlotSnapshot(active);
          }
        },
      );
    },
    async recall(sessionId, input): Promise<CommandResult<RecallValue>> {
      const target: CommandTarget = { kind: 'session', sessionId };
      return await registerCommand(
        input.commandId,
        JSON.stringify({ kind: 'recall', sessionId, ...input }),
        target,
        async () => {
          const active = slot;
          if (
            active === undefined || active.snapshot.session.id !== sessionId
          ) {
            return rejected(
              input.commandId,
              target,
              'notFound',
            );
          }
          if (openingSlot || slotBusy(active)) {
            return rejected(input.commandId, target, 'busy');
          }
          openingSlot = true;
          refreshSlotSnapshot(active);
          try {
            const value: RecallValue = input.action === 'clear'
              ? {
                action: 'clear',
                cleared: active.service.session.clearPendingRecall(),
              }
              : {
                action: 'prepare',
                ...await active.service.session.prepareRecall(
                  input.executionId,
                ),
              };
            openingSlot = false;
            refreshSlotSnapshot(active);
            return {
              kind: 'accepted',
              commandId: input.commandId,
              target,
              cursor: structuredClone(active.snapshot.cursor),
              value,
            };
          } catch (error) {
            if (error instanceof WorkerRecallSelectionError) {
              return rejected(
                input.commandId,
                target,
                error.code === 'not_found' ? 'notFound' : error.code,
              );
            }
            throw error;
          } finally {
            openingSlot = false;
            refreshSlotSnapshot(active);
          }
        },
      );
    },
    async contextRead(sessionId): Promise<ContextReadResult> {
      return { context: (await sessionRead(sessionId)).context };
    },
    async taskSubmit(
      sessionId,
      input,
    ): Promise<CommandResult<TaskSubmitValue>> {
      const target: CommandTarget = { kind: 'session', sessionId };
      return await registerCommand(
        input.commandId,
        JSON.stringify({
          kind: 'task.submit',
          sessionId,
          text: input.text,
        }),
        target,
        async () => {
          const active = slot;
          if (
            active === undefined || active.snapshot.session.id !== sessionId
          ) {
            return rejected(input.commandId, target, 'notFound');
          }
          if (openingSlot || slotBusy(active)) {
            return rejected(input.commandId, target, 'busy');
          }
          if (!active.service.session.isAvailable()) {
            return rejected(
              input.commandId,
              target,
              'unavailable',
            );
          }
          let admission: Awaited<
            ReturnType<ApplicationService['tasks']['admit']>
          >;
          try {
            admission = await active.service.tasks.admit(
              input.text,
              input.commandId,
            );
          } catch {
            refreshSlotSnapshot(active);
            return rejected(input.commandId, target, 'admissionFailed');
          }
          refreshSlotSnapshot(active);
          return {
            kind: 'accepted',
            commandId: input.commandId,
            target,
            cursor: structuredClone(active.snapshot.cursor),
            value: { executionId: admission.executionId },
          };
        },
      );
    },
    async executionCancel(
      sessionId,
      executionId,
      input,
    ): Promise<CommandResult<ExecutionCancelValue>> {
      const target: CommandTarget = {
        kind: 'execution',
        sessionId,
        executionId,
      };
      return await registerCommand(
        input.commandId,
        JSON.stringify({
          kind: 'execution.cancel',
          sessionId,
          executionId,
        }),
        target,
        async () => {
          let found: ExecutionReadResult;
          try {
            found = await executionRead(executionId);
          } catch (error) {
            if (error instanceof CoreServiceError && error.status === 404) {
              return rejected(input.commandId, target, 'notFound');
            }
            throw error;
          }
          if (found.execution.sessionId !== sessionId) {
            return rejected(
              input.commandId,
              target,
              'notFound',
            );
          }
          const active = slot;
          const result = active?.snapshot.session.id === sessionId
            ? active.service.tasks.cancel(executionId)
            : 'idle';
          if (active !== undefined) refreshSlotSnapshot(active);
          return {
            kind: 'accepted',
            commandId: input.commandId,
            target,
            ...(active?.snapshot.session.id !== sessionId
              ? {}
              : { cursor: structuredClone(active.snapshot.cursor) }),
            value: { executionId, result },
          };
        },
      );
    },
    async steeringSubmit(
      sessionId,
      executionId,
      input,
    ): Promise<CommandResult<SteeringSubmitValue>> {
      const target: CommandTarget = {
        kind: 'execution',
        sessionId,
        executionId,
      };
      return await registerCommand(
        input.commandId,
        JSON.stringify({
          kind: 'execution.steer',
          sessionId,
          executionId,
          text: input.text,
        }),
        target,
        async () => {
          const owner = knownServices.get(sessionId);
          if (owner?.tasks.executionStates().has(executionId) !== true) {
            let found: ExecutionReadResult;
            try {
              found = await executionRead(executionId);
            } catch (error) {
              if (error instanceof CoreServiceError && error.status === 404) {
                return rejected<SteeringSubmitValue>(
                  input.commandId,
                  target,
                  'notFound',
                );
              }
              throw error;
            }
            if (found.execution.sessionId !== sessionId) {
              return rejected<SteeringSubmitValue>(
                input.commandId,
                target,
                'notFound',
              );
            }
          }
          if (owner === undefined) {
            return rejected<SteeringSubmitValue>(
              input.commandId,
              target,
              'idle',
            );
          }
          const accepted = owner.tasks.steer(
            executionId,
            input.text,
            input.commandId,
          );
          const current = slot?.service === owner ? slot : undefined;
          if (current !== undefined) refreshSlotSnapshot(current);
          if (accepted.kind === 'rejected') {
            return rejected<SteeringSubmitValue>(
              input.commandId,
              target,
              accepted.reason,
            );
          }
          return {
            kind: 'accepted',
            commandId: input.commandId,
            target,
            ...(current === undefined ? {} : { cursor: structuredClone(current.snapshot.cursor) }),
            value: { executionId },
          };
        },
      );
    },
    async followUpQueue(
      sessionId,
      input,
    ): Promise<CommandResult<FollowUpQueueValue>> {
      const target: CommandTarget = { kind: 'session', sessionId };
      return await registerCommand(
        input.commandId,
        JSON.stringify({
          kind: 'followUp.queue',
          sessionId,
          afterExecutionId: input.afterExecutionId,
          text: input.text,
        }),
        target,
        async () => {
          const owner = knownServices.get(sessionId);
          if (
            owner?.tasks.executionStates().has(input.afterExecutionId) !== true
          ) {
            let found: ExecutionReadResult;
            try {
              found = await executionRead(input.afterExecutionId);
            } catch (error) {
              if (error instanceof CoreServiceError && error.status === 404) {
                return rejected<FollowUpQueueValue>(
                  input.commandId,
                  target,
                  'notFound',
                );
              }
              throw error;
            }
            if (found.execution.sessionId !== sessionId) {
              return rejected<FollowUpQueueValue>(
                input.commandId,
                target,
                'notFound',
              );
            }
          }
          if (owner === undefined) {
            return rejected<FollowUpQueueValue>(
              input.commandId,
              target,
              'idle',
            );
          }
          const accepted = owner.tasks.queueFollowUp(
            input.afterExecutionId,
            input.text,
            input.commandId,
          );
          const current = slot?.service === owner ? slot : undefined;
          if (current !== undefined) refreshSlotSnapshot(current);
          if (accepted.kind === 'rejected') {
            return rejected<FollowUpQueueValue>(
              input.commandId,
              target,
              accepted.reason,
            );
          }
          return {
            kind: 'accepted',
            commandId: input.commandId,
            target,
            ...(current === undefined ? {} : { cursor: structuredClone(current.snapshot.cursor) }),
            value: { queueId: accepted.queueId },
          };
        },
      );
    },
    followUpRead(sessionId, queueId): Promise<FollowUpReadResult> {
      for (const owner of allServices) {
        const followUp = owner.tasks.followUpRead(queueId);
        if (followUp?.sessionId === sessionId) {
          return Promise.resolve({ followUp });
        }
      }
      return Promise.reject(
        new CoreServiceError(404, 'follow_up_not_found', 'follow-up not found'),
      );
    },
    commandRead(commandId): Promise<CommandState<CoreCommandValue>> {
      const command = commands.get(commandId);
      if (command === undefined) {
        return Promise.reject(
          new CoreServiceError(404, 'command_not_found', 'command not found'),
        );
      }
      return Promise.resolve(structuredClone(command.state));
    },
    executionRead,
    async historyRead(input: HistoryReadInput): Promise<HistoryReadResult> {
      if (
        input.latest === true && input.sessionRef !== undefined ||
        input.sessionRef !== undefined && input.sessionRef.length === 0
      ) {
        throw new CoreServiceError(
          400,
          'invalid_history_target',
          'invalid history target',
        );
      }
      const view = input.view;
      if (view !== 'session' && view !== 'canonical' && view !== 'detail') {
        throw new CoreServiceError(
          400,
          'invalid_history_view',
          'invalid history view',
        );
      }
      if (!await ensureHistory()) {
        if (input.sessionRef !== undefined) throw sessionNotFound();
        return { sessionId: null, view, text: '' };
      }
      const sessions = (await history.listWorker()).sessions;
      const targetRef = input.sessionRef?.toLowerCase();
      const matches = targetRef === undefined
        ? sessions.slice(0, 1)
        : sessions.filter((entry) => entry.id.startsWith(targetRef));
      if (matches.length === 0) {
        if (targetRef === undefined) return { sessionId: null, view, text: '' };
        throw sessionNotFound();
      }
      if (matches.length > 1) {
        throw new CoreServiceError(
          409,
          'ambiguous_session',
          'session reference is ambiguous',
        );
      }
      const sessionId = matches[0].id;
      if (view === 'detail') {
        const text = [...history.streamHumanHistoryExport(sessionId)].map((
          record,
        ) => `${JSON.stringify(record)}\n`).join('');
        return { sessionId, view, text };
      }
      if (view === 'session') {
        return {
          sessionId,
          view,
          text: renderSessionTimeline(history.readSessionHistory(sessionId)),
        };
      }
      const record = await history.readWorker(sessionId);
      return {
        sessionId,
        view,
        text: renderCanonicalView(record, workspace.root),
      };
    },
    async subscribeSession(
      sessionId: string,
      sink: CoreSessionFrameSink,
    ): Promise<CoreSessionSubscription> {
      if (admissionClosed) {
        throw new CoreServiceError(503, 'core_stopping', 'Core is stopping');
      }
      let closed = false;
      let detach = (): void => {};
      const release = (): void => {
        if (closed) return;
        closed = true;
        detach();
        liveSubscriptions.delete(closeStream);
      };
      const closeStream = (): void => {
        if (closed) return;
        try {
          sink(undefined);
        } finally {
          release();
        }
      };
      let snapshot = await sessionRead(sessionId);
      if (admissionClosed) {
        throw new CoreServiceError(503, 'core_stopping', 'Core is stopping');
      }
      liveSubscriptions.add(closeStream);
      const active = slot;
      if (active?.snapshot.session.id === sessionId) {
        snapshot = structuredClone(active.snapshot);
      }
      const subscribers = subscribersFor(sessionId);
      subscribers.add(sink);
      detach = () => {
        subscribers.delete(sink);
      };
      return { snapshot, unsubscribe: release };
    },
    async close(): Promise<void> {
      beginShutdown();
      if (closePromise !== undefined) return await closePromise;
      closePromise = (async () => {
        await Promise.all([...commands.values()].map((command) => command.result));
        await Promise.allSettled([...credentialRegistrations]);
        const active = slot;
        if (active !== undefined) {
          active.unsubscribeObservations?.();
          await active.service.close();
          if (slot === active) slot = undefined;
        }
        history.close();
      })();
      await closePromise;
    },
  };

  if (initialSession !== undefined) await openSlot(initialSession);
  return service;
};
