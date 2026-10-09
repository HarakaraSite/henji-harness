import type {
  ConversationContentChunk,
  ConversationContentLocator,
} from '../../conversation/model.ts';
import type { DataCommandReceipt } from '../data/data_contract.ts';
import { projectApplicationControl } from './api_projection.ts';
import { type ApplicationService, createApplicationService } from './application_service.ts';
import type { ExecutionTrackingChange } from './application_port.ts';
import { createDataClient, DataServiceError, type EncodedDataReply } from '../data/client.ts';
import type { DataConversationSnapshot, DataConversationUpdate } from '../data/data_contract.ts';
import type { DataSessionDescriptor } from '../data/session_data_owner.ts';
import {
  encodedSessionSnapshot,
  encodedSessionSnapshotFrame,
  encodedSessionUpdate,
} from './encoded_public_frame.ts';
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
  FollowUpPage,
  FollowUpPageCursor,
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
import { CoreServiceError } from './core_service_error.ts';

const IMPLEMENTED_OPERATIONS: readonly CoreOperationName[] = CORE_OPERATION_NAMES;

export { CoreServiceError } from './core_service_error.ts';

export type CoreInitialSession = Readonly<
  | { kind: 'new' | 'continue' | 'none' }
  | { kind: 'exact'; sessionId: string }
>;

type CoreServiceOptions =
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
) => void | Promise<void>;

interface CoreSessionSubscription {
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
  followUpPageRead(
    sessionId: string,
    cursor?: FollowUpPageCursor,
  ): Promise<FollowUpPage>;
  commandRead(commandId: string): Promise<CommandState<CoreCommandValue>>;
  executionRead(executionId: string): Promise<ExecutionReadResult>;
  historyRead(input: HistoryReadInput): Promise<EncodedDataReply>;
  historyStreamOpen(
    input: HistoryReadInput,
  ): Promise<
    {
      readonly streamId: string;
      readonly sessionId: string | null;
      readonly view: HistoryReadInput['view'];
    }
  >;
  historyStreamRead(
    streamId: string,
  ): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly done: boolean }>;
  historyStreamClose(streamId: string): Promise<void>;
  conversationPageRead(
    sessionId: string,
    cursor?: number,
    direction?: 'older' | 'newer' | 'latest',
  ): Promise<EncodedDataReply>;
  conversationContentRead(
    locator: ConversationContentLocator,
    offset: number,
    length: number,
  ): Promise<ConversationContentChunk>;
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
  unsubscribeDescriptor?: () => void;
}

interface PublishedSessionFrame {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly previous: SessionControlSnapshot;
  readonly current: SessionControlSnapshot;
  readonly changes: readonly SessionChange[];
  readonly conversationCut?: number;
}

interface SessionSubscriber {
  readonly receive: (frame: PublishedSessionFrame) => void;
  readonly close: () => void;
  readonly resync: () => void;
}

interface SessionConversationWatch {
  ready: Promise<void>;
  active: boolean;
  initializing: boolean;
  cut: number;
  initial?: DataConversationSnapshot;
  unsubscribe?: () => void;
  readonly pending: DataConversationUpdate[];
  pendingBytes: number;
  overflowed: boolean;
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
  readonly owner: ApplicationService;
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
  const workspace = await resolveWorkspace(options.workspaceRoot);
  const stateRoot = options.stateRoot ?? launcherStateRoot();
  const credentialRoot = options.credentialRoot ?? `${stateRoot}/credentials`;
  const hostOptions = {
    ...workerOptions,
    ...(configRoot === undefined ? {} : { configRoot }),
    credentialRoot,
    providerDeclarations,
  };
  const statePaths = await sessionPaths(stateRoot, workspace.root);
  const coreEpoch = requestedCoreEpoch ?? crypto.randomUUID().toLowerCase();
  let slot: CoreSlot | undefined;
  let closePromise: Promise<void> | undefined;
  let admissionClosed = false;
  let openingSlot = false;
  const commands = new Map<string, TrackedCommand>();
  const completedCommands = new Map<string, DataCommandReceipt>();
  let completedCommandBytes = 0;
  let preflight: Promise<void> = Promise.resolve();
  const executions = new Map<string, TrackedExecution>();
  const followUpPages = new Map<string, FollowUpPage>();
  const servicesBySession = new Map<string, ApplicationService[]>();
  const liveSubscriptions = new Set<() => void>();
  const credentialRegistrations = new Set<Promise<CredentialRegisterResult>>();
  const chatgptOperations = new Set<Promise<ChatGPTAuthResult>>();
  const sessionSubscribers = new Map<string, Set<SessionSubscriber>>();
  const sessionSnapshots = new Map<string, SessionControlSnapshot>();
  let readOnlyRuntime: {
    readonly activeSessionId: string | null;
    readonly operations: readonly CoreOperationName[];
  } | undefined;
  let sessionEvictions: Promise<void> = Promise.resolve();
  const trimInactiveSnapshots = (readingSessionId?: string): Promise<void> => {
    const trim = sessionEvictions.catch(() => {}).then(async () => {
      const inactive = [...sessionSnapshots.entries()].filter(([sessionId]) =>
        sessionId !== slot?.snapshot.session.id &&
        sessionId !== readingSessionId &&
        (sessionSubscribers.get(sessionId)?.size ?? 0) === 0
      );
      const sizes = inactive.map(([sessionId, snapshot]) =>
        new TextEncoder().encode(
          JSON.stringify({ snapshot, followUps: followUpPages.get(sessionId) }),
        ).byteLength
      );
      let bytes = sizes.reduce((sum, size) => sum + size, 0);
      let count = inactive.length;
      for (
        let index = 0;
        index < inactive.length && (count > 32 || bytes > 2 * 1024 * 1024);
        index++
      ) {
        const [sessionId, snapshot] = inactive[index];
        await data.coreSessionCursorSave(
          coreEpoch,
          sessionId,
          snapshot.cursor.revision,
        );
        if (
          sessionId === slot?.snapshot.session.id ||
          (sessionSubscribers.get(sessionId)?.size ?? 0) > 0 ||
          sessionSnapshots.get(sessionId) !== snapshot
        ) continue;
        sessionSnapshots.delete(sessionId);
        followUpPages.delete(sessionId);
        bytes -= sizes[index];
        count--;
      }
    });
    sessionEvictions = trim;
    return trim;
  };
  const providerById = new Map(
    providerDeclarations.map((
      declaration,
    ) => [declaration.providerId, declaration]),
  );
  const modelCatalog = new LiveModelCatalog({
    configRoot: configRoot ?? `${stateRoot}/config`,
    credentialRoot,
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
    credentialRoot,
    providerDeclarations,
    credentialDeclarations,
  });
  const chatgpt = createChatGPTAuthService({
    credentialRoot,
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

  const conversationWatches = new Map<string, SessionConversationWatch>();

  const stopConversationWatch = (sessionId: string): void => {
    const watch = conversationWatches.get(sessionId);
    if (watch === undefined) return;
    watch.active = false;
    conversationWatches.delete(sessionId);
    watch.pending.length = 0;
    watch.initial = undefined;
    watch.unsubscribe?.();
  };

  const publishSnapshot = (
    candidate: SessionControlSnapshot,
    dataDelta?: Uint8Array<ArrayBuffer>,
    conversationCut?: number,
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
                candidate.runtime.active &&
                candidate.runtime.phase === 'settling'
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
    const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
    if (!same(previous.session, candidate.session)) {
      changes.push({ kind: 'session.replace', session: candidate.session });
    }
    if (!same(previous.runtime, candidate.runtime)) {
      changes.push({ kind: 'runtime.replace', runtime: candidate.runtime });
    }
    if (!same(previous.pending, candidate.pending)) {
      changes.push({ kind: 'pending.replace', pending: candidate.pending });
    }
    if (
      !same(previous.credentialAvailability, candidate.credentialAvailability)
    ) {
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
    const subscribers = sessionSubscribers.get(sessionId);
    if (subscribers === undefined || subscribers.size === 0) return updated;
    const bytes = encodedSessionUpdate(
      updated.cursor,
      previous.cursor.revision,
      changes,
      dataDelta,
    );
    const frame: PublishedSessionFrame = {
      bytes,
      previous,
      current: updated,
      changes,
      ...(conversationCut === undefined ? {} : { conversationCut }),
    };
    for (const subscriber of [...subscribers]) subscriber.receive(frame);
    return updated;
  };

  const applyDataDescriptor = (
    sessionId: string,
    descriptor: DataSessionDescriptor,
    delta?: Uint8Array<ArrayBuffer>,
    cut?: number,
  ): void => {
    const previous = sessionSnapshots.get(sessionId);
    if (previous === undefined) return;
    const updated = publishSnapshot(
      {
        ...previous,
        session: {
          ...previous.session,
          position: descriptor.currentPosition,
          selection: apiSelection(descriptor.modelSelection),
        },
        runtime: {
          ...previous.runtime,
          execution: descriptor.latestExecution ?? null,
        },
        context: descriptor.context,
      },
      delta,
      cut,
    );
    if (slot?.snapshot.session.id === sessionId) slot.snapshot = updated;
  };

  const applyConversationUpdate = (
    watch: SessionConversationWatch,
    update: DataConversationUpdate,
  ): void => {
    if (!watch.active || update.cut <= watch.cut) return;
    watch.cut = update.cut;
    if (update.snapshot === true) {
      applyDataDescriptor(update.sessionId, update.descriptor);
      for (const subscriber of sessionSubscribers.get(update.sessionId) ?? []) subscriber.resync();
    } else applyDataDescriptor(update.sessionId, update.descriptor, update.bytes, update.cut);
  };

  const startConversationWatch = (
    sessionId: string,
  ): { watch: SessionConversationWatch; first: boolean } => {
    const current = conversationWatches.get(sessionId);
    if (current !== undefined) return { watch: current, first: false };
    const watch: SessionConversationWatch = {
      ready: Promise.resolve(),
      active: true,
      initializing: true,
      cut: 0,
      pending: [],
      pendingBytes: 0,
      overflowed: false,
    };
    conversationWatches.set(sessionId, watch);
    watch.ready = readData(() =>
      data.watchConversation(sessionId, (update) => {
        if (!watch.active) return;
        if (watch.initializing) {
          watch.pendingBytes += update.bytes.byteLength;
          if (
            watch.pendingBytes > 2 * 1024 * 1024 && watch.pending.length > 0
          ) {
            watch.pending.length = 0;
            watch.pendingBytes = update.bytes.byteLength;
            watch.overflowed = true;
          }
          watch.pending.push(update);
        } else applyConversationUpdate(watch, update);
      })
    ).then((subscription) => {
      if (!watch.active) {
        subscription.unsubscribe();
        return;
      }
      watch.unsubscribe = subscription.unsubscribe;
      watch.initial = subscription.snapshot;
      watch.cut = subscription.snapshot.cut;
    });
    return { watch, first: true };
  };

  const pendingForSession = (
    sessionId: string,
    activeOwner?: ApplicationService,
    activeView?: PendingView,
  ): PendingView => {
    const active = activeOwner ??
      (slot?.snapshot.session.id === sessionId ? slot.service : undefined);
    const visible = activeView ?? active?.tasks.pendingView(sessionId) ?? {
      kind: 'core-owned' as const,
      followUps: [] as readonly FollowUpRecord[],
    };
    const savedPage = followUpPages.get(sessionId);
    const retained = new Map<string, FollowUpRecord>();
    for (const record of savedPage?.followUps ?? []) {
      if (record.status !== 'queued') retained.set(record.queueId, record);
    }
    return {
      kind: 'core-owned',
      ...(visible.activeTask === undefined ? {} : { activeTask: visible.activeTask }),
      ...(visible.steering === undefined ? {} : { steering: visible.steering }),
      ...(visible.followUp === undefined ? {} : { followUp: visible.followUp }),
      followUps: [...retained.values()],
      ...(savedPage === undefined ? {} : {
        followUpPage: {
          hasMore: savedPage.hasMore,
          ...(savedPage.nextCursor === undefined ? {} : { nextCursor: savedPage.nextCursor }),
        },
      }),
    };
  };

  const slotBusy = (target: CoreSlot): boolean =>
    target.service.tasks.isBusy() ||
    target.service.currentSession().runtimeSnapshot().active;

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
    const busy = slot !== undefined && slotBusy(slot);
    if (!openingSlot && !busy) {
      result.push('session.open', 'credential.register');
    }
    if (target !== undefined && target === slot && !openingSlot) {
      if (!busy && target.service.session.isAvailable()) {
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

  const applyExecutionChanges = (
    owner: ApplicationService,
    changes: readonly ExecutionTrackingChange[],
  ): void => {
    for (const change of changes) {
      if (change.kind === 'remove') {
        if (executions.get(change.executionId)?.owner === owner) {
          executions.delete(change.executionId);
        }
        continue;
      }
      executions.set(change.executionId, {
        sessionId: change.sessionId,
        submittedByCommandId: change.submittedByCommandId,
        processSettlement: change.processSettlement,
        owner,
      });
    }
  };

  const refreshSlotSnapshot = (target: CoreSlot): void => {
    const previous = target.snapshot;
    const projected = currentSnapshot(
      target.service,
      coreEpoch,
      previous.cursor.revision + 1,
    );
    const pending = pendingForSession(
      target.snapshot.session.id,
      target.service,
      projected.pending,
    );
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
    const activeSessionId = slot?.snapshot.session.id ?? null;
    const readOnlyOperations = operations();
    if (
      readOnlyRuntime?.activeSessionId === activeSessionId &&
      readOnlyRuntime.operations.length === readOnlyOperations.length &&
      readOnlyRuntime.operations.every((name, index) => name === readOnlyOperations[index])
    ) return;
    readOnlyRuntime = { activeSessionId, operations: readOnlyOperations };
    for (const [sessionId, viewed] of sessionSnapshots) {
      if (sessionId === target.snapshot.session.id) continue;
      publishSnapshot({
        ...viewed,
        runtime: {
          active: false,
          activeSessionId,
          phase: 'idle',
          execution: viewed.runtime.execution,
          operations: readOnlyOperations,
        },
      });
    }
  };

  const makeSlot = async (
    selection: CoreInitialSession,
    activation: SessionActivation = {},
    fromSessionId?: string,
  ): Promise<CoreSlot> => {
    if (selection.kind === 'continue') {
      const latest = (await data.sessionsList()).sessions[0];
      if (latest !== undefined) {
        selection = { kind: 'exact', sessionId: latest.id };
      }
    }
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
      if (declaration === undefined) {
        throw new CoreServiceError(404, 'provider_not_found');
      }
      initialModelSelection = selectionForDeclaration(
        declaration,
        declaration.defaults.modelId,
        await modelCatalog.defaultEffort(
          declaration.providerId,
          declaration.defaults.modelId,
        ),
      );
    }
    let agentChoice = inherited.agentChoice;
    let agent = inherited.agent;
    if (activation.agent !== undefined || activation.agentFile !== undefined) {
      if (
        activation.agent !== undefined && activation.agentFile !== undefined
      ) {
        throw new CoreServiceError(400, 'invalid_agent_choice');
      }
      agentChoice = activation.agentFile === undefined
        ? { name: activation.agent }
        : { file: activation.agentFile };
      agent = activation.agent;
    } else if (selection.kind === 'exact') {
      const record = await data.sessionDescriptor(selection.sessionId);
      agentChoice = record.agentChoice;
      agent = record.agent;
    }
    const activationMetadata = {
      ...(inherited.activation ?? {}),
      ...activation,
    };
    if (activation.agent !== undefined) {
      delete activationMetadata.agentFile;
    }
    if (activation.agentFile !== undefined) {
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
      agentChoice,
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
    const service = await createApplicationService({
      ...invocation,
      persistFollowUp: async (record) => {
        await data.followUpSave(coreEpoch, record.sessionId, record);
        const page = await data.followUpPageRead(record.sessionId);
        followUpPages.set(record.sessionId, {
          ...page,
          followUps: page.followUps.map((receipt) => receipt.followUp),
        });
      },
      persistTaskCompletion: (control) =>
        data.saveExecutionCompletionControl({
          ...control,
          processSettlement: 'complete',
        }),
    });
    const sessionId = service.query.currentSession().sessionId;
    const initial = currentSnapshot(
      service,
      coreEpoch,
      sessionSnapshots.get(sessionId)?.cursor.revision ??
        await data.coreSessionCursorRead(coreEpoch, sessionId) ?? 0,
    );
    if (!sessionSnapshots.has(sessionId)) {
      sessionSnapshots.set(sessionId, initial);
    }
    const next: CoreSlot = {
      service,
      options: invocation,
      snapshot: initial,
    };
    let descriptorSequence = -1;
    const acceptDescriptor = (
      update: { sequence: number; descriptor: DataSessionDescriptor },
    ) => {
      if (update.sequence <= descriptorSequence) return;
      descriptorSequence = update.sequence;
      applyDataDescriptor(sessionId, update.descriptor);
    };
    const descriptorWatch = await readData(() =>
      data.watchSessionDescriptor(sessionId, acceptDescriptor)
    );
    next.unsubscribeDescriptor = descriptorWatch.unsubscribe;
    acceptDescriptor(descriptorWatch.snapshot);
    const owners = servicesBySession.get(sessionId) ?? [];
    owners.push(service);
    servicesBySession.set(sessionId, owners);
    next.unsubscribeObservations = service.subscribe((observation) => {
      if (observation.kind === 'task_state') {
        applyExecutionChanges(service, observation.executionChanges);
      }
      refreshSlotSnapshot(next);
    });
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
      previous.unsubscribeDescriptor?.();
      await previous.service.close();
      const owners = servicesBySession.get(previous.snapshot.session.id);
      if (owners !== undefined) {
        const remaining = owners.filter((owner) => owner !== previous.service);
        if (remaining.length === 0) {
          servicesBySession.delete(previous.snapshot.session.id);
        } else servicesBySession.set(previous.snapshot.session.id, remaining);
      }
    }
    await trimInactiveSnapshots();
    return structuredClone(next.snapshot);
  };

  const refreshReadControl = async (sessionId: string): Promise<void> => {
    if (!isSessionId(sessionId)) {
      throw new CoreServiceError(
        400,
        'invalid_session_id',
        'invalid session id',
      );
    }
    if (slot?.snapshot.session.id !== sessionId) {
      const descriptor = await readData(() => data.sessionDescriptor(sessionId));
      const page = await readData(() => data.followUpPageRead(sessionId));
      followUpPages.set(sessionId, {
        ...page,
        followUps: page.followUps.map((receipt) => receipt.followUp),
      });
      const candidate = savedControl(
        descriptor,
        coreEpoch,
        sessionSnapshots.get(sessionId)?.cursor.revision ??
          await data.coreSessionCursorRead(coreEpoch, sessionId) ?? 0,
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
  };

  const sessionRead = async (sessionId: string): Promise<EncodedDataReply> => {
    await refreshReadControl(sessionId);
    const conversation = await readData(() => data.conversationSnapshot(sessionId));
    const control = sessionSnapshots.get(sessionId);
    if (control === undefined) throw sessionNotFound();
    await trimInactiveSnapshots();
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

  const signatureDigest = async (signature: string): Promise<string> => {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(signature),
      ),
    );
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  };
  const commandConflict = (): never => {
    throw new CoreServiceError(
      409,
      'command_id_conflict',
      'commandId was reused',
    );
  };
  const receiptBytes = (receipt: DataCommandReceipt): number =>
    new TextEncoder().encode(JSON.stringify(receipt)).byteLength;
  const cacheReceipt = (receipt: DataCommandReceipt): void => {
    const size = receiptBytes(receipt);
    if (size > 2 * 1024 * 1024) return;
    while (
      completedCommands.size >= 32 ||
      completedCommandBytes + size > 2 * 1024 * 1024
    ) {
      const first = completedCommands.entries().next().value!;
      completedCommands.delete(first[0]);
      completedCommandBytes -= receiptBytes(first[1]);
    }
    completedCommands.set(receipt.commandId, receipt);
    completedCommandBytes += size;
  };
  const registerCommand = <T extends CoreCommandValue>(
    commandId: string,
    signature: string,
    target: CommandTarget,
    work: () => Promise<CommandResult<T>>,
    onRegistered?: () => void,
  ): Promise<CommandResult<T>> => {
    const existing = commands.get(commandId);
    if (existing !== undefined) {
      if (existing.signature !== signature) commandConflict();
      return existing.result.then((value) => structuredClone(value) as CommandResult<T>);
    }
    const cached = completedCommands.get(commandId);
    if (cached !== undefined) {
      return signatureDigest(signature).then((digest) => {
        if (cached.signatureDigest !== digest) commandConflict();
        return structuredClone(cached.result) as CommandResult<T>;
      });
    }
    if (admissionClosed) {
      return Promise.resolve(rejected(commandId, target, 'unavailable'));
    }
    let resolve!: (value: CommandResult<T>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<CommandResult<T>>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const tracked: TrackedCommand = {
      signature,
      state: { kind: 'processing', commandId },
      result,
    };
    // No await before registration: simultaneous copies join this one Promise.
    commands.set(commandId, tracked);
    onRegistered?.();
    const predecessor = preflight;
    let release!: () => void;
    preflight = new Promise<void>((done) => {
      release = done;
    });
    void (async () => {
      let digest = '';
      let receipt: DataCommandReceipt | null;
      let pendingWork: Promise<CommandResult<T>>;
      try {
        await predecessor;
        digest = await signatureDigest(signature);
        receipt = await data.commandReceiptRead(coreEpoch, commandId);
        if (receipt !== null) {
          if (receipt.signatureDigest !== digest) commandConflict();
          cacheReceipt(receipt);
          commands.delete(commandId);
          resolve(receipt.result as CommandResult<T>);
          return;
        }
        // work reserves the live slot synchronously; release FIFO before admission await.
        pendingWork = work();
      } catch (error) {
        if (
          error instanceof CoreServiceError &&
          error.code === 'command_id_conflict'
        ) {
          commands.delete(commandId);
          reject(error);
          return;
        }
        pendingWork = Promise.resolve(rejected<T>(commandId, target, 'failed'));
      } finally {
        release();
      }
      try {
        const value = await pendingWork.catch(() => rejected<T>(commandId, target, 'failed'));
        const saved: DataCommandReceipt = {
          coreEpoch,
          commandId,
          operation: (JSON.parse(signature).kind === 'recall'
            ? JSON.parse(signature).action === 'clear' ? 'recall.clear' : 'recall.prepare'
            : JSON.parse(signature).kind) as CoreOperationName,
          signatureDigest: digest,
          result: value,
          completedAt: new Date().toISOString(),
        };
        await data.commandReceiptSave(saved);
        cacheReceipt(saved);
        commands.delete(commandId);
        resolve(value);
      } catch (error) {
        // A completed operation without a durable receipt still owns this ID.
        // Retain the registered Promise so a retry cannot execute the task again.
        reject(error);
      }
    })();
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
        conversationSchema: 3,
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
          providers: await Promise.all(
            providerDeclarations.map(async (declaration) => ({
              provider: declaration.providerId,
              defaultSelection: {
                provider: declaration.providerId,
                modelId: declaration.defaults.modelId,
                effort: await modelCatalog.defaultEffort(
                  declaration.providerId,
                  declaration.defaults.modelId,
                ),
              },
            })),
          ),
        };
      }
      if (input.kind === 'models' || input.kind === 'efforts') {
        if (!providerById.has(input.provider)) {
          throw new CoreServiceError(404, 'provider_not_found');
        }
        try {
          if (input.kind === 'models') {
            return await modelCatalog.models(
              input.provider,
              input.sessionId,
              input.registrationId,
            );
          }
          const current = slot?.snapshot.session.selection;
          return await modelCatalog.efforts(
            input.provider,
            input.modelId,
            current?.provider === input.provider &&
              current.modelId === input.modelId &&
              isReasoningEffort(current.effort)
              ? current.effort
              : undefined,
          );
        } catch (error) {
          if (
            error instanceof LiveModelCatalogError &&
            error.authCode !== undefined
          ) {
            throw new CoreServiceError(502, error.authCode);
          }
          throw new CoreServiceError(502, 'model_catalog_unavailable');
        } finally {
          await persistCatalogFacts();
        }
      }
      if (input.kind === 'credentials') {
        return {
          kind: 'credentials',
          profiles: credentialRegistration.targets(),
        };
      }
      throw new CoreServiceError(400, 'invalid_catalog_kind');
    },
    async modelFavorite(input): Promise<ModelCatalogResult> {
      if (!providerById.has(input.provider)) {
        throw new CoreServiceError(404, 'provider_not_found');
      }
      try {
        return await modelCatalog.favorite(
          input.provider,
          input.modelId,
          input.favorite,
        );
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
            : await credentialFilePresenceAt(
              credentialFileFor(profile.authProfile, credentialRoot),
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
    chatgptAuth(input: ChatGPTOperation): Promise<ChatGPTAuthResult> {
      if (admissionClosed) {
        return Promise.reject(
          new CoreServiceError(503, 'core_stopping', 'Core is stopping'),
        );
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
              await active.service.currentSession()
                .refreshCredentialAvailability();
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
            credentialFileFor(input.authProfile, credentialRoot),
          );
          const active = slot;
          if (active !== undefined) {
            await active.service.currentSession()
              .refreshCredentialAvailability();
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
            // Existing streams retain their conversation watch across slot changes.
            // Refresh only the control state for a Session that is now read-only.
            for (const [sessionId, subscribers] of sessionSubscribers) {
              if (subscribers.size === 0) continue;
              try {
                await refreshReadControl(sessionId);
              } catch (error) {
                if (
                  !(error instanceof CoreServiceError && error.status === 404)
                ) throw error;
                for (const subscriber of [...subscribers]) subscriber.close();
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
            if (openingSlot) {
              openingSlot = false;
              if (slot !== undefined) refreshSlotSnapshot(slot);
            }
          }
        },
      );
    },
    async sessionDelete(
      sessionId,
      input,
    ): Promise<CommandResult<SessionDeleteValue>> {
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
            for (
              const subscriber of [...(sessionSubscribers.get(sessionId) ?? [])]
            ) {
              subscriber.close();
            }
            stopConversationWatch(sessionId);
            sessionSnapshots.delete(sessionId);
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
            if (openingSlot) {
              openingSlot = false;
              refreshSlotSnapshot(active);
            }
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
            declaration === undefined ||
            input.selection.modelId.trim().length === 0 ||
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
            await modelCatalog.remember(
              selection.provider,
              selection.modelId,
              selection.effort,
            );
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
            if (openingSlot) {
              openingSlot = false;
              refreshSlotSnapshot(active);
            }
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
            if (openingSlot) {
              openingSlot = false;
              refreshSlotSnapshot(active);
            }
          }
        },
      );
    },
    async contextRead(sessionId): Promise<EncodedDataReply> {
      if (!isSessionId(sessionId)) {
        throw new CoreServiceError(
          400,
          'invalid_session_id',
          'invalid session id',
        );
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
            const configuration = active.snapshot.runtime.effectiveConfig
              ?.configuration;
            const rejectedConfiguration = typeof configuration === 'object' &&
              configuration !== null && !Array.isArray(configuration) &&
              (configuration as { readonly [key: string]: unknown }).status ===
                'rejected';
            return rejected(
              input.commandId,
              target,
              rejectedConfiguration ? 'configurationRejected' : 'admissionFailed',
            );
          }
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
            await active!.service.tasks.flushFollowUps();
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
          await active?.service.tasks.flushFollowUps();
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
          const owner = servicesBySession.get(sessionId)?.at(-1);
          const tracked = executions.get(executionId);
          if (
            tracked?.sessionId !== sessionId || tracked.owner !== owner
          ) {
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
          const owner = servicesBySession.get(sessionId)?.at(-1);
          const tracked = executions.get(input.afterExecutionId);
          if (
            tracked?.sessionId !== sessionId || tracked.owner !== owner
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
          const accepted = await owner.tasks.queueFollowUp(
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
    async followUpPageRead(sessionId, cursor) {
      const page = await readData(() => data.followUpPageRead(sessionId, cursor));
      return {
        ...page,
        followUps: page.followUps.map((receipt) => receipt.followUp),
      };
    },
    async followUpRead(sessionId, queueId): Promise<FollowUpReadResult> {
      const found = await readData(() => data.followUpRead(queueId));
      if (found === null || found.sessionId !== sessionId) {
        throw new CoreServiceError(
          404,
          'follow_up_not_found',
          'follow-up not found',
        );
      }
      return { followUp: found.followUp };
    },
    async commandRead(commandId): Promise<CommandState<CoreCommandValue>> {
      const command = commands.get(commandId);
      if (command !== undefined) return structuredClone(command.state);
      const cached = completedCommands.get(commandId);
      const receipt = cached ??
        await readData(() => data.commandReceiptRead(coreEpoch, commandId));
      if (receipt === null) {
        throw new CoreServiceError(
          404,
          'command_not_found',
          'command not found',
        );
      }
      return structuredClone(receipt.result);
    },
    executionRead,
    async conversationPageRead(sessionId, cursor, direction) {
      return await readData(() => data.conversationPageRead(sessionId, cursor, direction));
    },
    async conversationContentRead(locator, offset, length) {
      return await readData(() => data.conversationContentRead(locator, offset, length));
    },
    async historyStreamOpen(input) {
      return await readData(() => data.historyStreamOpen(input));
    },
    async historyStreamRead(streamId) {
      return await readData(() => data.historyStreamRead(streamId));
    },
    async historyStreamClose(streamId) {
      await readData(() => data.historyStreamClose(streamId));
    },
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
      await refreshReadControl(sessionId);
      const subscribers = sessionSubscribers.get(sessionId) ??
        new Set<SessionSubscriber>();
      sessionSubscribers.set(sessionId, subscribers);
      let closed = false;
      let pending: PublishedSessionFrame[] | undefined = [];
      let conversationCut = 0;
      let bufferedBytes = 0;
      let needsResync = false;
      let delivering = false;
      let initialized = false;
      const delivery: PublishedSessionFrame[] = [];
      const release = (): void => {
        if (closed) return;
        closed = true;
        pending = undefined;
        delivery.length = 0;
        subscribers.delete(subscriber);
        liveSubscriptions.delete(closeStream);
        if (subscribers.size === 0) {
          sessionSubscribers.delete(sessionId);
          stopConversationWatch(sessionId);
          void trimInactiveSnapshots().catch(() => {});
        }
      };
      const closeStream = (): void => {
        if (closed) return;
        try {
          void Promise.resolve(sink(undefined)).catch(() => {});
        } finally {
          release();
        }
      };
      const deliver = async (frame: PublishedSessionFrame): Promise<void> => {
        if (closed) return;
        if (frame.conversationCut !== undefined) {
          if (frame.conversationCut <= conversationCut) {
            await sink(encodedSessionUpdate(
              frame.current.cursor,
              frame.previous.cursor.revision,
              frame.changes,
            ));
            return;
          }
          conversationCut = frame.conversationCut;
        }
        await sink(frame.bytes);
      };
      const resnapshot = async (): Promise<void> => {
        while (!closed) {
          needsResync = false;
          delivery.length = 0;
          bufferedBytes = 0;
          const conversation = await readData(() => data.conversationSnapshot(sessionId));
          if (closed) return;
          if (needsResync) continue;
          const after = delivery.find((frame) =>
            frame.conversationCut !== undefined &&
            frame.conversationCut > conversation.cut
          );
          const control = after?.previous ?? sessionSnapshots.get(sessionId);
          if (control === undefined) throw sessionNotFound();
          conversationCut = conversation.cut;
          while (
            delivery[0]?.current.cursor.revision <= control.cursor.revision
          ) {
            bufferedBytes -= delivery.shift()!.bytes.byteLength;
          }
          await sink(encodedSessionSnapshotFrame(control, conversation.bytes));
          return;
        }
      };
      const pump = async (): Promise<void> => {
        if (delivering || !initialized || closed) return;
        delivering = true;
        try {
          while (!closed && (needsResync || delivery.length > 0)) {
            if (needsResync) await resnapshot();
            else {
              const frame = delivery.shift()!;
              bufferedBytes -= frame.bytes.byteLength;
              await deliver(frame);
            }
          }
        } catch {
          closeStream();
        } finally {
          delivering = false;
        }
      };
      const buffer = (
        queue: PublishedSessionFrame[],
        frame: PublishedSessionFrame,
      ): void => {
        if (needsResync) return;
        if (
          bufferedBytes + frame.bytes.byteLength > 2 * 1024 * 1024 &&
          queue.length > 0
        ) {
          queue.length = 0;
          bufferedBytes = 0;
          needsResync = true;
          return;
        }
        queue.push(frame);
        bufferedBytes += frame.bytes.byteLength;
      };
      const subscriber: SessionSubscriber = {
        receive(frame) {
          if (closed) return;
          buffer(pending ?? delivery, frame);
          void pump();
        },
        close: closeStream,
        resync() {
          needsResync = true;
          pending?.splice(0);
          delivery.length = 0;
          bufferedBytes = 0;
          void pump();
        },
      };
      subscribers.add(subscriber);
      liveSubscriptions.add(closeStream);
      const { watch, first } = startConversationWatch(sessionId);
      try {
        await watch.ready;
        if (closed || admissionClosed) {
          throw new CoreServiceError(503, 'core_stopping', 'Core is stopping');
        }
        const conversation = first && !watch.overflowed
          ? watch.initial!
          : await readData(() => data.conversationSnapshot(sessionId));
        if (closed || admissionClosed) {
          throw new CoreServiceError(503, 'core_stopping', 'Core is stopping');
        }
        // Only this subscriber may need the interval between its snapshot's Data cut
        // and the RPC reply. Existing streams keep receiving their ordinary updates.
        const buffered = pending!;
        const afterSnapshot = buffered.find((frame) =>
          frame.conversationCut !== undefined &&
          frame.conversationCut > conversation.cut
        );
        const control = afterSnapshot?.previous ??
          sessionSnapshots.get(sessionId);
        if (control === undefined) throw sessionNotFound();
        conversationCut = conversation.cut;
        pending = undefined;
        bufferedBytes = 0;
        for (const frame of buffered) {
          if (frame.current.cursor.revision > control.cursor.revision) {
            delivery.push(frame);
            bufferedBytes += frame.bytes.byteLength;
          }
        }
        // Start the first frame before returning readiness, without waiting for HTTP demand.
        delivering = true;
        void Promise.resolve(
          sink(encodedSessionSnapshotFrame(control, conversation.bytes)),
        )
          .then(() => {
            delivering = false;
            void pump();
          }, () => closeStream());
        initialized = true;
        if (watch.initializing) {
          watch.initial = undefined;
          watch.cut = conversation.cut;
          watch.initializing = false;
          watch.pendingBytes = 0;
          for (const update of watch.pending.splice(0)) {
            applyConversationUpdate(watch, update);
          }
          if (watch.overflowed) {
            needsResync = true;
            void pump();
          }
        }
        return { unsubscribe: release };
      } catch (error) {
        release();
        throw error;
      }
    },
    async close(): Promise<void> {
      beginShutdown();
      if (closePromise !== undefined) return await closePromise;
      closePromise = (async () => {
        await Promise.allSettled(
          [...commands.values()].map((command) => command.result),
        );
        await Promise.allSettled([...credentialRegistrations]);
        await Promise.allSettled([...chatgptOperations]);
        try {
          await chatgpt.close();
          const active = slot;
          if (active !== undefined) {
            active.unsubscribeObservations?.();
            active.unsubscribeDescriptor?.();
            await active.service.close();
            if (slot === active) slot = undefined;
          }
        } finally {
          for (const sessionId of conversationWatches.keys()) {
            stopConversationWatch(sessionId);
          }
          await sessionEvictions.catch(() => {});
          servicesBySession.clear();
          sessionSnapshots.clear();
          followUpPages.clear();
          await data.close();
        }
      })();
      await closePromise;
    },
  };

  const data = await createDataClient({
    stateRoot,
    workspaceRoot: workspace.root,
  });
  try {
    if (initialSession !== undefined) await openSlot(initialSession);
    return service;
  } catch (error) {
    await Promise.allSettled([service.close()]);
    throw error;
  }
};
