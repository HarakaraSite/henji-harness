import { projectApplicationControl } from './api_projection.ts';
import { type ApplicationService, createApplicationService } from './application_service.ts';
import { createDataClient, DataServiceError, type EncodedDataReply } from '../data/client.ts';
import type { DataSessionDescriptor } from '../data/session_data_owner.ts';
import { encodedSessionSnapshot, encodedSessionUpdate } from './encoded_public_frame.ts';
import type {
  ApiSelection,
  CatalogReadInput,
  CatalogReadResult,
  ChatGPTAuthResult,
  ChatGPTOperation,
  CommandResult,
  CommandState,
  CommandTarget,
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
  ModelCatalogResult,
  ModelFavoriteInput,
  PendingView,
  RecallInput,
  RecallValue,
  SelectionChangeInput,
  SelectionChangeValue,
  SessionActivation,
  SessionChange,
  SessionControlSnapshot,
  SessionDeleteInput,
  SessionDeleteValue,
  SessionOpenInput,
  SessionOpenResult,
  SessionRenameInput,
  SessionRenameValue,
  SessionsListResult,
  SteeringSubmitInput,
  SteeringSubmitValue,
  TaskSubmitInput,
  TaskSubmitValue,
} from '../../api/contract.ts';
import { CORE_OPERATION_NAMES } from '../../api/contract.ts';
import {
  isSessionId,
  launcherStateRoot,
  sessionPaths,
  SessionStoreError,
} from '../session/session_store.ts';
import { resolveRequestedDefinition } from '../definitions/definition_selection.ts';
import { LiveModelCatalog, LiveModelCatalogError } from '../provider/live_model_catalog.ts';
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
import {
  builtinCredentialDeclarations,
  loadCredentialDeclarations,
} from '../provider/credential_declaration.ts';
import { credentialFileFor, credentialFilePresenceAt } from '../provider/credential_file.ts';
import { ChatGPTAuthError, createChatGPTAuthService } from '../provider/chatgpt_auth.ts';
import { writeDefaultSelection } from '../provider/default_selection.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import { WorkerRecallSelectionError } from '../worker/worker_host_session.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import { projectRuntimeDisplayState } from '../runtime/startup_orientation.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import { type WorkerSessionOptions } from '../worker/worker_tui_session.ts';

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
  & Readonly<
    {
      initialSession?: CoreInitialSession;
      coreEpoch?: string;
      modelsMetadataUrl?: string;
      catalogFetcher?: typeof fetch;
      chatgptFetcher?: typeof fetch;
    }
  >;

export type CoreSessionFrameSink = (
  frame: Uint8Array<ArrayBuffer> | undefined,
) => void;

export interface CoreSessionSubscription {
  readonly snapshot: EncodedDataReply;
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
  sessionRead(sessionId: string): Promise<EncodedDataReply>;
  sessionOpen(input: SessionOpenInput): Promise<SessionOpenResult>;
  sessionDelete(
    sessionId: string,
    input: SessionDeleteInput,
  ): Promise<CommandResult<SessionDeleteValue>>;
  sessionRename(
    sessionId: string,
    input: SessionRenameInput,
  ): Promise<CommandResult<SessionRenameValue>>;
  selectionChange(
    sessionId: string,
    input: SelectionChangeInput,
  ): Promise<CommandResult<SelectionChangeValue>>;
  catalogRead(input: CatalogReadInput): Promise<CatalogReadResult>;
  modelFavorite(input: ModelFavoriteInput): Promise<ModelCatalogResult>;
  credentialPresenceRead(): Promise<CredentialPresenceReadResult>;
  chatgptAuth(input: ChatGPTOperation): Promise<ChatGPTAuthResult>;
  credentialRegister(
    input: CredentialRegisterInput,
  ): Promise<CredentialRegisterResult>;
  recall(
    sessionId: string,
    input: RecallInput,
  ): Promise<CommandResult<RecallValue>>;
  contextRead(sessionId: string): Promise<EncodedDataReply>;
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
  historyRead(input: HistoryReadInput): Promise<EncodedDataReply>;
  subscribeSession(
    sessionId: string,
    sink: CoreSessionFrameSink,
  ): Promise<CoreSessionSubscription>;
  close(): Promise<void>;
}

interface CoreSlot {
  readonly service: ApplicationService;
  snapshot: SessionControlSnapshot;
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

const currentSnapshot = (
  service: ApplicationService,
  coreEpoch: string,
  revision: number,
): SessionControlSnapshot => projectApplicationControl(service.query, { coreEpoch, revision });

const savedControl = (
  descriptor: DataSessionDescriptor,
  coreEpoch: string,
  revision: number,
  workspaceRoot: string,
): SessionControlSnapshot => {
  const selection = descriptor.modelSelection;
  return projectApplicationControl({
    currentSession: () => ({
      sessionId: descriptor.id,
      persistence: descriptor.persistence === 'none' ? 'none' : 'session',
      position: descriptor.currentPosition,
      selection,
      startup: projectRuntimeDisplayState({
        productVersion: buildManifest().productVersion,
        workspaceRoot,
        agentId: descriptor.agent,
        profileId: modelRouteProfileId(selection),
        provider: selection.provider,
        modelId: selection.modelId,
        effort: selection.effort,
        sessionMode: descriptor.persistence === 'none' ? 'none' : 'session',
        skillNames: [],
      }),
      runtime: { active: false, phase: 'idle' },
      execution: descriptor.latestExecution,
      context: descriptor.context,
    }),
  }, { coreEpoch, revision });
};

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

/** Core owns control state; Data owns Session history and encoded conversation state. */
export const createCoreService = async (
  options: CoreServiceOptions,
): Promise<CoreService> => {
  const {
    initialSession,
    coreEpoch: requestedCoreEpoch,
    modelsMetadataUrl,
    catalogFetcher,
    chatgptFetcher,
    ...workerOptions
  } = options;
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
  const credentialDeclarations = configRoot === undefined
    ? Object.freeze([] as const)
    : Object.freeze([
      ...builtinCredentialDeclarations(),
      ...await loadCredentialDeclarations({ configRoot }),
    ]);
  const hostOptions = {
    ...workerOptions,
    ...(configRoot === undefined ? {} : { configRoot }),
    providerDeclarations,
  };
  const workspace = await resolveWorkspace(options.workspaceRoot);
  const stateRoot = options.stateRoot ?? launcherStateRoot();
  const statePaths = await sessionPaths(stateRoot, workspace.root);
  const coreEpoch = requestedCoreEpoch ?? crypto.randomUUID().toLowerCase();
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
  const chatgptOperations = new Set<Promise<ChatGPTAuthResult>>();
  const sessionSubscribers = new Map<string, Set<CoreSessionFrameSink>>();
  const sessionSnapshots = new Map<string, SessionControlSnapshot>();
  const providerById = new Map(
    providerDeclarations.map((
      declaration,
    ) => [declaration.providerId, declaration]),
  );
  const modelCatalog = new LiveModelCatalog({
    configRoot: configRoot ?? `${stateRoot}/config`,
    declarations: providerDeclarations,
    ...(modelsMetadataUrl === undefined ? {} : { metadataUrl: modelsMetadataUrl }),
    ...(catalogFetcher === undefined ? {} : { fetcher: catalogFetcher }),
  });
  let catalogFactCursor = 0;
  const persistCatalogFacts = async (): Promise<void> => {
    const facts = modelCatalog.facts;
    const fresh = facts.slice(catalogFactCursor);
    catalogFactCursor = facts.length;
    if (fresh.length === 0) return;
    await data.persistCatalogFacts(fresh);
  };
  const credentialRegistration = createCredentialRegistration({
    ...(configRoot === undefined ? {} : { configRoot }),
    providerDeclarations,
    credentialDeclarations,
  });
  const chatgpt = createChatGPTAuthService({
    configRoot: configRoot ?? `${stateRoot}/config`,
    ...(chatgptFetcher === undefined ? {} : { fetcher: chatgptFetcher }),
    reportFact: async (fact) => {
      await Deno.mkdir(statePaths.root, { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(
        `${statePaths.root}/chatgpt-auth-requests.jsonl`,
        `${JSON.stringify(fact)}\n`,
        { append: true },
      );
    },
  });
  const beginShutdown = (): void => {
    if (admissionClosed) return;
    admissionClosed = true;
    const executionId = slot?.service.tasks.activeExecutionId();
    if (executionId !== undefined) slot!.service.tasks.cancel(executionId);
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

  const watchedSessions = new Map<string, Promise<void>>();
  const dataWatches = new Map<string, () => void>();

  const publishSnapshot = (
    candidate: SessionControlSnapshot,
    dataDelta?: Uint8Array<ArrayBuffer>,
  ): SessionControlSnapshot => {
    const execution = candidate.runtime.execution;
    const tracked = execution === null ? undefined : executions.get(execution.executionId);
    if (execution !== null && tracked !== undefined) {
      candidate = {
        ...candidate,
        runtime: {
          ...candidate.runtime,
          execution: {
            ...execution,
            submittedByCommandId: tracked.submittedByCommandId,
            processSettlement: tracked.processSettlement === 'running' &&
                candidate.runtime.active && candidate.runtime.phase === 'settling'
              ? 'settling'
              : tracked.processSettlement,
          },
        },
      };
    }
    const sessionId = candidate.session.id;
    const previous = sessionSnapshots.get(sessionId);
    if (previous === undefined) {
      sessionSnapshots.set(sessionId, candidate);
      return candidate;
    }
    const changes: SessionChange[] = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(previous.session, candidate.session)) {
      changes.push({ kind: 'session.replace', session: candidate.session });
    }
    if (!same(previous.runtime, candidate.runtime)) {
      changes.push({ kind: 'runtime.replace', runtime: candidate.runtime });
    }
    if (!same(previous.pending, candidate.pending)) {
      changes.push({ kind: 'pending.replace', pending: candidate.pending });
    }
    if (!same(previous.credentialAvailability, candidate.credentialAvailability)) {
      changes.push({
        kind: 'credentialAvailability.replace',
        credentialAvailability: candidate.credentialAvailability,
      });
    }
    if (!same(previous.context, candidate.context)) {
      changes.push({ kind: 'context.replace', context: candidate.context });
    }
    if (changes.length === 0 && dataDelta === undefined) return previous;
    const updated = {
      ...candidate,
      cursor: { ...candidate.cursor, revision: previous.cursor.revision + 1 },
    };
    sessionSnapshots.set(sessionId, updated);
    const bytes = encodedSessionUpdate(
      updated.cursor,
      previous.cursor.revision,
      changes,
      dataDelta,
    );
    for (const sink of [...subscribersFor(sessionId)]) sink(bytes);
    return updated;
  };

  const ensureWatch = async (sessionId: string): Promise<void> => {
    let pending = watchedSessions.get(sessionId);
    if (pending === undefined) {
      pending = data.watchSession(sessionId, (delta) => {
        const previous = sessionSnapshots.get(sessionId);
        if (previous === undefined) return;
        const descriptor = delta.descriptor;
        const updated = publishSnapshot({
          ...previous,
          session: {
            ...previous.session,
            position: descriptor.currentPosition,
            selection: apiSelection(descriptor.modelSelection),
          },
          runtime: { ...previous.runtime, execution: descriptor.latestExecution ?? null },
          context: descriptor.context,
        }, delta.bytes);
        if (slot?.snapshot.session.id === sessionId) slot.snapshot = updated;
      }).then((watch) => {
        dataWatches.set(sessionId, watch.unsubscribe);
      }).catch((error) => {
        watchedSessions.delete(sessionId);
        throw error;
      });
      watchedSessions.set(sessionId, pending);
    }
    await pending;
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
    );
    const pending = pendingForSession(target.snapshot.session.id, target.service);
    const reservation = target.service.tasks.isPreparing() && pending.activeTask !== undefined
      ? {
        executionId: pending.activeTask.executionId,
        commandId: pending.activeTask.commandId,
        phase: 'preparing' as const,
      }
      : undefined;
    const updated: SessionControlSnapshot = {
      ...projected,
      context: {
        ...projected.context,
        ...(previous.context.latestRequest === undefined ? {} : {
          latestRequest: previous.context.latestRequest,
        }),
      },
      pending,
      runtime: {
        ...projected.runtime,
        ...(reservation === undefined ? {} : { reservation }),
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
        : (await data.sessionDescriptor(fromSessionId)).modelSelection;
      initialModelSelection = structuredClone(source);
    }
    if (
      activation.rootProvider !== undefined &&
      (selection.kind === 'new' || selection.kind === 'none')
    ) {
      const declaration = providerById.get(activation.rootProvider);
      if (declaration === undefined) throw new CoreServiceError(404, 'provider_not_found');
      initialModelSelection = selectionForDeclaration(
        declaration,
        declaration.defaults.modelId,
        await modelCatalog.defaultEffort(declaration.providerId, declaration.defaults.modelId),
      );
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
      const record = await data.sessionDescriptor(selection.sessionId);
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
      data,
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
    );
    if (!sessionSnapshots.has(sessionId)) {
      sessionSnapshots.set(sessionId, initial);
    }
    const next: CoreSlot = {
      service,
      options: invocation,
      snapshot: initial,
    };
    await ensureWatch(sessionId);
    knownServices.set(service.query.currentSession().sessionId, service);
    allServices.add(service);
    next.unsubscribeObservations = service.subscribe(() => refreshSlotSnapshot(next));
    return next;
  };

  const openSlot = async (
    selection: CoreInitialSession,
    activation?: SessionActivation,
    fromSessionId?: string,
  ): Promise<SessionControlSnapshot> => {
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
    const previous = slot;
    slot = next;
    refreshSlotSnapshot(next);
    if (previous !== undefined) {
      previous.unsubscribeObservations?.();
      await previous.service.close();
    }
    return structuredClone(next.snapshot);
  };

  const sessionRead = async (sessionId: string): Promise<EncodedDataReply> => {
    if (!isSessionId(sessionId)) {
      throw new CoreServiceError(400, 'invalid_session_id', 'invalid session id');
    }
    if (slot?.snapshot.session.id !== sessionId) {
      const descriptor = await readData(() => data.sessionDescriptor(sessionId));
      const candidate = savedControl(
        descriptor,
        coreEpoch,
        sessionSnapshots.get(sessionId)?.cursor.revision ?? 0,
        workspace.root,
      );
      publishSnapshot({
        ...candidate,
        pending: pendingForSession(sessionId),
        runtime: {
          ...candidate.runtime,
          activeSessionId: slot?.snapshot.session.id ?? null,
          operations: operations(),
        },
      });
    }
    await ensureWatch(sessionId);
    // Last await: Data's snapshot reply and later deltas share one ordered port.
    const conversation = await readData(() => data.conversationSnapshot(sessionId));
    const control = sessionSnapshots.get(sessionId);
    if (control === undefined) throw sessionNotFound();
    return { bytes: encodedSessionSnapshot(control, conversation.bytes) };
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

  const readData = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof DataServiceError) {
        throw new CoreServiceError(error.status, error.code, error.message);
      }
      throw error;
    }
  };

  const executionRead = async (
    executionId: string,
  ): Promise<ExecutionReadResult> => {
    const result = await readData(() => data.executionRead(executionId));
    const tracked = executions.get(executionId);
    if (tracked === undefined) return result;
    const runtime = slot?.snapshot.session.id === tracked.sessionId
      ? slot.snapshot.runtime
      : undefined;
    return {
      execution: {
        ...result.execution,
        submittedByCommandId: tracked.submittedByCommandId,
        processSettlement: tracked.processSettlement === 'running' &&
            runtime?.active && runtime.phase === 'settling'
          ? 'settling'
          : tracked.processSettlement,
      },
    };
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
    async catalogRead(input: CatalogReadInput): Promise<CatalogReadResult> {
      if (input.kind === 'providers') {
        return {
          kind: 'providers',
          providers: await Promise.all(providerDeclarations.map(async (declaration) => ({
            provider: declaration.providerId,
            defaultSelection: {
              provider: declaration.providerId,
              modelId: declaration.defaults.modelId,
              effort: await modelCatalog.defaultEffort(
                declaration.providerId,
                declaration.defaults.modelId,
              ),
            },
          }))),
        };
      }
      if (input.kind === 'models' || input.kind === 'efforts') {
        if (!providerById.has(input.provider)) {
          throw new CoreServiceError(404, 'provider_not_found');
        }
        try {
          if (input.kind === 'models') {
            return await modelCatalog.models(input.provider, input.sessionId, input.registrationId);
          }
          const current = slot?.snapshot.session.selection;
          return await modelCatalog.efforts(
            input.provider,
            input.modelId,
            current?.provider === input.provider && current.modelId === input.modelId &&
              isReasoningEffort(current.effort)
              ? current.effort
              : undefined,
          );
        } catch (error) {
          if (error instanceof LiveModelCatalogError && error.authCode !== undefined) {
            throw new CoreServiceError(502, error.authCode);
          }
          throw new CoreServiceError(502, 'model_catalog_unavailable');
        } finally {
          await persistCatalogFacts();
        }
      }
      if (input.kind === 'credentials') {
        return { kind: 'credentials', profiles: credentialRegistration.targets() };
      }
      throw new CoreServiceError(400, 'invalid_catalog_kind');
    },
    async modelFavorite(input): Promise<ModelCatalogResult> {
      if (!providerById.has(input.provider)) throw new CoreServiceError(404, 'provider_not_found');
      try {
        return await modelCatalog.favorite(input.provider, input.modelId, input.favorite);
      } catch {
        throw new CoreServiceError(500, 'model_favorite_failed');
      }
    },
    async credentialPresenceRead(): Promise<CredentialPresenceReadResult> {
      const profiles = await Promise.all(
        credentialRegistration.targets().map(async (profile) => ({
          ...profile,
          status: profile.authProfile === 'openai-chatgpt'
            ? await chatgpt.presence()
            : await credentialFilePresenceAt(credentialFileFor(profile.authProfile, configRoot)),
        })),
      );
      const active = slot;
      if (active !== undefined) {
        await active.service.currentSession().refreshCredentialAvailability();
        if (slot === active) refreshSlotSnapshot(active);
      }
      return { profiles };
    },
    chatgptAuth(input: ChatGPTOperation): Promise<ChatGPTAuthResult> {
      if (admissionClosed) {
        return Promise.reject(new CoreServiceError(503, 'core_stopping', 'Core is stopping'));
      }
      const operation = (async (): Promise<ChatGPTAuthResult> => {
        try {
          let attempt;
          switch (input.kind) {
            case 'status':
              break;
            case 'begin':
              attempt = await chatgpt.begin(input.registrationId);
              break;
            case 'complete':
              await chatgpt.complete(input.attemptId, input.callbackUrl);
              break;
            case 'cancel':
              await chatgpt.cancel(input.attemptId);
              break;
            case 'select':
              await chatgpt.select(input.registrationId);
              break;
          }
          if (input.kind === 'complete' || input.kind === 'select') {
            const active = slot;
            if (active !== undefined) {
              await active.service.currentSession().refreshCredentialAvailability();
              if (slot === active) refreshSlotSnapshot(active);
            }
          }
          return {
            kind: 'chatgpt',
            state: await chatgpt.status(),
            ...(attempt === undefined ? {} : {
              attempt,
            }),
          };
        } catch (error) {
          return {
            kind: 'rejected',
            reason: error instanceof ChatGPTAuthError ? error.code : 'chatgpt_auth_failed',
          };
        }
      })();
      chatgptOperations.add(operation);
      void operation.then(
        () => chatgptOperations.delete(operation),
        () => chatgptOperations.delete(operation),
      );
      return operation;
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
    async sessionsList(): Promise<SessionsListResult> {
      const listed = await data.sessionsList();
      const byId = new Map(listed.sessions.map((item) => [item.id, item]));
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
            if (selection.kind === 'continue') {
              const latest = (await data.sessionsList()).sessions[0];
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
              value: { sessionId: slot!.snapshot.session.id },
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
    async sessionDelete(sessionId, input): Promise<CommandResult<SessionDeleteValue>> {
      const target: CommandTarget = { kind: 'session', sessionId };
      return await registerCommand(
        input.commandId,
        JSON.stringify({ kind: 'session.delete', sessionId }),
        target,
        async () => {
          if (openingSlot || slot?.snapshot.session.id === sessionId) {
            return rejected(input.commandId, target, 'busy');
          }
          try {
            await data.deleteSession(sessionId);
            dataWatches.get(sessionId)?.();
            dataWatches.delete(sessionId);
            watchedSessions.delete(sessionId);
            sessionSnapshots.delete(sessionId);
            for (const sink of [...(sessionSubscribers.get(sessionId) ?? [])]) sink(undefined);
            sessionSubscribers.delete(sessionId);
            return {
              kind: 'accepted',
              commandId: input.commandId,
              target,
              value: { deleted: sessionId },
            };
          } catch (error) {
            const reason: CoreRejection = error instanceof SessionStoreError
              ? error.code === 'session_busy'
                ? 'busy'
                : error.code === 'session_not_found'
                ? 'notFound'
                : error.code === 'session_invalid'
                ? 'invalid'
                : 'failed'
              : 'failed';
            return rejected(input.commandId, target, reason);
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
          if (
            declaration === undefined || input.selection.modelId.trim().length === 0 ||
            input.selection.modelId.trim() !== input.selection.modelId ||
            !isReasoningEffort(input.selection.effort)
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
            await modelCatalog.remember(selection.provider, selection.modelId, selection.effort);
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
                cleared: await active.service.session.clearPendingRecall(),
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
    async contextRead(sessionId): Promise<EncodedDataReply> {
      if (!isSessionId(sessionId)) {
        throw new CoreServiceError(400, 'invalid_session_id', 'invalid session id');
      }
      const active = slot?.snapshot.session.id === sessionId ? slot : undefined;
      const pendingRecall = active?.snapshot.context.pendingRecall;
      return await readData(() => data.contextRead(sessionId, pendingRecall, active !== undefined));
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
          const active = slot;
          const reserved = active?.snapshot.session.id === sessionId &&
            active.service.tasks.activeExecutionId() === executionId;
          if (reserved) {
            const result = active!.service.tasks.cancel(executionId);
            return {
              kind: 'accepted',
              commandId: input.commandId,
              target,
              cursor: structuredClone(active!.snapshot.cursor),
              value: { executionId, result },
            };
          }
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
          const accepted = await owner.tasks.steer(
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
    async historyRead(input: HistoryReadInput): Promise<EncodedDataReply> {
      return await readData(() => data.historyRead(input));
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
      const snapshot = await sessionRead(sessionId);
      if (admissionClosed) throw new CoreServiceError(503, 'core_stopping', 'Core is stopping');
      liveSubscriptions.add(closeStream);
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
        await Promise.allSettled([...chatgptOperations]);
        try {
          await chatgpt.close();
          const active = slot;
          if (active !== undefined) {
            active.unsubscribeObservations?.();
            await active.service.close();
            if (slot === active) slot = undefined;
          }
        } finally {
          for (const unwatch of dataWatches.values()) unwatch();
          dataWatches.clear();
          await data.close();
        }
      })();
      await closePromise;
    },
  };

  const data = await createDataClient({ stateRoot, workspaceRoot: workspace.root });
  try {
    if (initialSession !== undefined) await openSlot(initialSession);
    return service;
  } catch (error) {
    await Promise.allSettled([service.close()]);
    throw error;
  }
};
