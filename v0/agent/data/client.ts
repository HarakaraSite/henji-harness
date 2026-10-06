import type { ContextView, ExecutionReadResult, HistoryReadInput } from '../../api/contract.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { LiveModelCatalogFact } from '../provider/live_model_catalog.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCorrelation,
} from '../worker/worker_protocol.ts';
import {
  type DataAgentEventListener,
  type DataCommitDecision,
  type DataConversationDeltaListener,
  type DataConversationSnapshot,
  type DataConversationUpdate,
  type DataExecutionAdmissionResult,
  type DataExecutionAdmitRequest,
  type DataExecutionArtifactMetadataInput,
  type DataExecutionControlInput,
  type DataExecutionStartupAdmitRequest,
  type DataPrepareProposalRequest,
  type DataProposalToken,
  type DataSealGenerationRequest,
  type DataService,
  DataServiceError,
  type DataSessionDescriptor,
  type DataSessionDescriptorListener,
  type DataSessionDescriptorUpdate,
  type DataSessionMutationResult,
  type DataSessionOpenInput,
  type DataSessionTerminalResult,
  type DataSettleChildExecutionRequest,
  type DataSettleFailureRequest,
  type DataWorkerRequest,
  type DataWorkerResponse,
  type EncodedDataReply,
} from './data_contract.ts';
import type { SessionsListResult } from '../../api/contract.ts';

export { DataServiceError } from './data_contract.ts';
export type { EncodedDataReply } from './data_contract.ts';

type PendingRequest = {
  readonly resolve: (response: DataWorkerResponse) => void;
  readonly reject: (error: Error) => void;
};

type DataWorkerCall = DataWorkerRequest extends infer Request
  ? Request extends { readonly id: number } ? Omit<Request, 'id'> : never
  : never;

type DataWorker = Worker & {
  postMessage(message: DataWorkerRequest, transfer?: Transferable[]): void;
};

interface LocalWatchListener {
  readonly callback: DataConversationDeltaListener;
  initializing: boolean;
  afterCut: number;
  readonly buffered: DataConversationUpdate[];
}

interface LocalWatch {
  readonly listeners: Set<LocalWatchListener>;
  initializing?: Promise<DataConversationSnapshot>;
  remoteReady: boolean;
  unwatching?: Promise<void>;
}

interface LocalDescriptorWatchListener {
  readonly callback: DataSessionDescriptorListener;
  initializing: boolean;
  afterSequence: number;
  readonly buffered: DataSessionDescriptorUpdate[];
}

interface LocalDescriptorWatch {
  readonly listeners: Set<LocalDescriptorWatchListener>;
  initializing?: Promise<DataSessionDescriptorUpdate>;
  remoteReady: boolean;
  unwatching?: Promise<void>;
}

class DataClient implements DataService {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly conversationWatches = new Map<string, LocalWatch>();
  private readonly descriptorWatches = new Map<string, LocalDescriptorWatch>();
  private readonly agentEventListeners = new Set<DataAgentEventListener>();
  private failed = false;
  private closing = false;
  private closed = false;
  private closeTask: Promise<void> | undefined;

  constructor(private readonly worker: DataWorker) {
    worker.onmessage = (event: MessageEvent<DataWorkerResponse>): void => {
      const response = event.data;
      if (response.kind === 'conversation_delta') {
        this.receiveConversationUpdate(response.update);
        return;
      }
      if (response.kind === 'session_descriptor_delta') {
        this.receiveSessionDescriptorUpdate(response.update);
        return;
      }
      if (response.kind === 'agent_event') {
        for (const listener of [...this.agentEventListeners]) {
          listener(response.sessionId, response.eventBytes);
        }
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      if (response.kind === 'error') {
        pending.reject(
          new DataServiceError(
            response.error.status,
            response.error.code,
            response.error.message,
            response.error.details,
          ),
        );
      } else pending.resolve(response);
    };
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      this.fail(new Error(event.message || 'Data Worker failed'));
    };
    worker.onmessageerror = (): void => {
      this.fail(new Error('Data Worker response could not be cloned'));
    };
  }

  private fail(error: Error): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request(
    request: DataWorkerCall,
    allowClosing = false,
    transfer?: Transferable[],
  ): Promise<DataWorkerResponse> {
    if (this.failed || this.closed || (this.closing && !allowClosing)) {
      return Promise.reject(new DataServiceError(503, 'data_worker_closed'));
    }
    const id = this.nextId++;
    return new Promise<DataWorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage(
          { ...request, id } as DataWorkerRequest,
          transfer,
        );
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async value<T>(request: DataWorkerCall): Promise<T> {
    const response = await this.request(request);
    if (response.kind !== 'value') {
      throw new Error('unexpected Data Worker response');
    }
    return response.value as T;
  }

  private receiveConversationUpdate(update: DataConversationUpdate): void {
    const watch = this.conversationWatches.get(update.sessionId);
    if (watch === undefined) return;
    for (const subscriber of [...watch.listeners]) {
      if (subscriber.initializing) subscriber.buffered.push(update);
      else if (update.cut > subscriber.afterCut) subscriber.callback(update);
    }
  }

  private receiveSessionDescriptorUpdate(
    update: DataSessionDescriptorUpdate,
  ): void {
    const watch = this.descriptorWatches.get(update.descriptor.id);
    if (watch === undefined) return;
    for (const subscriber of [...watch.listeners]) {
      if (subscriber.initializing) subscriber.buffered.push(update);
      else if (update.sequence > subscriber.afterSequence) {
        subscriber.callback(update);
      }
    }
  }

  private async initializeConversationWatch(
    sessionId: string,
    watch: LocalWatch,
  ): Promise<DataConversationSnapshot> {
    if (watch.initializing !== undefined) return await watch.initializing;
    watch.initializing = this.value<DataConversationSnapshot>({
      kind: 'watch_conversation',
      sessionId,
    }).then((snapshot) => {
      watch.remoteReady = true;
      return snapshot;
    });
    try {
      return await watch.initializing;
    } finally {
      watch.initializing = undefined;
    }
  }

  private async stopRemoteConversationWatch(
    sessionId: string,
    watch: LocalWatch,
  ): Promise<void> {
    if (watch.unwatching !== undefined) return await watch.unwatching;
    watch.unwatching = (async () => {
      if (!watch.remoteReady && watch.initializing !== undefined) {
        try {
          await watch.initializing;
        } catch {
          // The initial watch request failed, so there is nothing to unregister.
        }
      }
      if (watch.remoteReady) {
        try {
          await this.value<void>({ kind: 'unwatch_conversation', sessionId });
        } catch {
          // Worker close owns final watch cleanup if unregistration cannot be delivered.
        }
      }
    })().finally(() => {
      if (
        watch.listeners.size === 0 &&
        this.conversationWatches.get(sessionId) === watch
      ) {
        this.conversationWatches.delete(sessionId);
      }
      watch.unwatching = undefined;
    });
    return await watch.unwatching;
  }

  private async initializeDescriptorWatch(
    sessionId: string,
    watch: LocalDescriptorWatch,
  ): Promise<DataSessionDescriptorUpdate> {
    if (watch.initializing !== undefined) return await watch.initializing;
    watch.initializing = this.value<DataSessionDescriptorUpdate>({
      kind: 'watch_session_descriptor',
      sessionId,
    }).then((snapshot) => {
      watch.remoteReady = true;
      return snapshot;
    });
    try {
      return await watch.initializing;
    } finally {
      watch.initializing = undefined;
    }
  }

  private async stopRemoteDescriptorWatch(
    sessionId: string,
    watch: LocalDescriptorWatch,
  ): Promise<void> {
    if (watch.unwatching !== undefined) return await watch.unwatching;
    watch.unwatching = (async () => {
      if (!watch.remoteReady && watch.initializing !== undefined) {
        try {
          await watch.initializing;
        } catch {
          // A failed initial request left no remote descriptor watch.
        }
      }
      if (watch.remoteReady) {
        try {
          await this.value<void>({
            kind: 'unwatch_session_descriptor',
            sessionId,
          });
        } catch {
          // Worker close owns final watch cleanup if unregistration cannot be delivered.
        }
      }
    })().finally(() => {
      if (
        watch.listeners.size === 0 &&
        this.descriptorWatches.get(sessionId) === watch
      ) this.descriptorWatches.delete(sessionId);
      watch.unwatching = undefined;
    });
    return await watch.unwatching;
  }

  async historyRead(input: HistoryReadInput): Promise<EncodedDataReply> {
    const response = await this.request({ kind: 'history_read', input });
    if (response.kind !== 'encoded') {
      throw new Error('unexpected Data Worker response');
    }
    return { bytes: response.bytes };
  }

  async contextRead(
    sessionId: string,
    pendingRecall?: ContextView['pendingRecall'],
    activeSession = false,
  ): Promise<EncodedDataReply> {
    const response = await this.request({
      kind: 'context_read',
      sessionId,
      ...(pendingRecall === undefined ? {} : { pendingRecall }),
      activeSession,
    });
    if (response.kind !== 'encoded') {
      throw new Error('unexpected Data Worker response');
    }
    return { bytes: response.bytes };
  }

  async executionRead(executionId: string): Promise<ExecutionReadResult> {
    const response = await this.request({
      kind: 'execution_read',
      executionId,
    });
    if (response.kind !== 'execution') {
      throw new Error('unexpected Data Worker response');
    }
    return response.result;
  }

  openSession(input: DataSessionOpenInput): Promise<DataSessionDescriptor> {
    return this.value({ kind: 'session_open', input });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.value<void>({ kind: 'session_close', sessionId });
  }

  sessionDescriptor(sessionId: string): Promise<DataSessionDescriptor> {
    return this.value({ kind: 'session_descriptor', sessionId });
  }

  sessionsList(): Promise<SessionsListResult> {
    return this.value({ kind: 'sessions_list' });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.value<void>({ kind: 'session_delete', sessionId });
  }

  conversationSnapshot(sessionId: string): Promise<DataConversationSnapshot> {
    return this.value({ kind: 'conversation_snapshot', sessionId });
  }

  async watchConversation(
    sessionId: string,
    listener: DataConversationDeltaListener,
  ): Promise<
    {
      readonly snapshot: DataConversationSnapshot;
      readonly unsubscribe: () => void;
    }
  > {
    let watch: LocalWatch | undefined;
    for (;;) {
      watch = this.conversationWatches.get(sessionId);
      if (watch?.unwatching !== undefined) {
        await watch.unwatching;
        continue;
      }
      if (watch === undefined) {
        watch = { listeners: new Set(), remoteReady: false };
        this.conversationWatches.set(sessionId, watch);
      }
      break;
    }
    const subscriber: LocalWatchListener = {
      callback: listener,
      initializing: true,
      afterCut: -1,
      buffered: [],
    };
    watch.listeners.add(subscriber);
    try {
      const snapshot = watch.remoteReady
        ? await this.value<DataConversationSnapshot>({
          kind: 'conversation_snapshot',
          sessionId,
        })
        : await this.initializeConversationWatch(sessionId, watch);
      subscriber.afterCut = snapshot.cut;
      subscriber.initializing = false;
      for (const update of subscriber.buffered) {
        if (update.cut > subscriber.afterCut) listener(update);
      }
      subscriber.buffered.length = 0;
      let active = true;
      return {
        snapshot,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          watch!.listeners.delete(subscriber);
          if (watch!.listeners.size === 0) {
            void this.stopRemoteConversationWatch(sessionId, watch!);
          }
        },
      };
    } catch (error) {
      watch.listeners.delete(subscriber);
      if (watch.listeners.size === 0) this.conversationWatches.delete(sessionId);
      throw error;
    }
  }

  async watchSessionDescriptor(
    sessionId: string,
    listener: DataSessionDescriptorListener,
  ): Promise<{
    readonly snapshot: DataSessionDescriptorUpdate;
    readonly unsubscribe: () => void;
  }> {
    let watch: LocalDescriptorWatch | undefined;
    for (;;) {
      watch = this.descriptorWatches.get(sessionId);
      if (watch?.unwatching !== undefined) {
        await watch.unwatching;
        continue;
      }
      if (watch === undefined) {
        watch = { listeners: new Set(), remoteReady: false };
        this.descriptorWatches.set(sessionId, watch);
      }
      break;
    }
    const subscriber: LocalDescriptorWatchListener = {
      callback: listener,
      initializing: true,
      afterSequence: -1,
      buffered: [],
    };
    watch.listeners.add(subscriber);
    try {
      const snapshot = watch.remoteReady
        ? await this.value<DataSessionDescriptorUpdate>({
          kind: 'watch_session_descriptor',
          sessionId,
        })
        : await this.initializeDescriptorWatch(sessionId, watch);
      subscriber.afterSequence = snapshot.sequence;
      subscriber.initializing = false;
      for (const update of subscriber.buffered) {
        if (update.sequence > subscriber.afterSequence) listener(update);
      }
      subscriber.buffered.length = 0;
      let active = true;
      return {
        snapshot,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          watch!.listeners.delete(subscriber);
          if (watch!.listeners.size === 0) {
            void this.stopRemoteDescriptorWatch(sessionId, watch!);
          }
        },
      };
    } catch (error) {
      watch.listeners.delete(subscriber);
      if (watch.listeners.size === 0) this.descriptorWatches.delete(sessionId);
      throw error;
    }
  }

  async attachGeneration(
    sessionId: string,
    correlation: WorkerCorrelation,
  ): Promise<MessagePort> {
    const response = await this.request({
      kind: 'attach_generation',
      sessionId,
      correlation,
    });
    if (response.kind !== 'attached_generation') {
      throw new Error('unexpected Data Worker generation response');
    }
    return response.port;
  }

  executionAdmit(sessionId: string, input: DataExecutionAdmitRequest) {
    return this.value<DataExecutionAdmissionResult>({
      kind: 'execution_admit',
      sessionId,
      input,
    });
  }

  executionAdmitStartup(
    sessionId: string,
    input: DataExecutionStartupAdmitRequest,
  ) {
    return this.value<DataExecutionAdmissionResult>({
      kind: 'execution_admit_startup',
      sessionId,
      input,
    });
  }

  recordExecutionControl(
    sessionId: string,
    executionId: string,
    input: DataExecutionControlInput,
  ): Promise<DataSessionDescriptor> {
    return this.value({
      kind: 'execution_control',
      sessionId,
      executionId,
      input,
    });
  }

  prepareProposal(
    sessionId: string,
    input: DataPrepareProposalRequest,
  ): Promise<DataProposalToken> {
    return this.value({ kind: 'prepare_proposal', sessionId, input });
  }

  authorizeCommit(
    sessionId: string,
    token: DataProposalToken,
    decision: DataCommitDecision,
  ): Promise<DataSessionTerminalResult> {
    return this.value({ kind: 'authorize_commit', sessionId, token, decision });
  }

  settleFailure(
    sessionId: string,
    input: DataSettleFailureRequest,
  ): Promise<DataSessionTerminalResult> {
    return this.value({ kind: 'settle_failure', sessionId, input });
  }

  sealGeneration(
    sessionId: string,
    input: DataSealGenerationRequest,
  ): Promise<DataSessionTerminalResult> {
    return this.value({ kind: 'seal_generation', sessionId, input });
  }

  settleChildExecution(
    sessionId: string,
    input: DataSettleChildExecutionRequest,
  ): Promise<DataSessionTerminalResult> {
    return this.value({ kind: 'settle_child', sessionId, input });
  }

  async updateExecutionArtifactMetadata(
    sessionId: string,
    executionId: string,
    metadata: DataExecutionArtifactMetadataInput,
  ): Promise<void> {
    await this.value<void>({
      kind: 'execution_artifact_metadata',
      sessionId,
      executionId,
      metadata,
    });
  }

  installCheckpoint(
    sessionId: string,
    message: WorkerCheckpointProposalMessage,
  ): Promise<boolean> {
    return this.value({ kind: 'install_checkpoint', sessionId, message });
  }

  updateModelSelection(
    sessionId: string,
    selection: ModelSelection,
  ): Promise<DataSessionMutationResult<'selected' | 'unchanged'>> {
    return this.value({ kind: 'update_model_selection', sessionId, selection });
  }

  updateTitle(
    sessionId: string,
    title: string,
  ): Promise<DataSessionMutationResult<'renamed' | 'unchanged'>> {
    return this.value({ kind: 'update_title', sessionId, title });
  }

  prepareRecall(
    sessionId: string,
    executionIdPrefix?: string,
  ): Promise<
    {
      readonly sourceExecutionId: string;
      readonly evidence: 'available' | 'unavailable';
    }
  > {
    return this.value({
      kind: 'prepare_recall',
      sessionId,
      ...(executionIdPrefix === undefined ? {} : { executionIdPrefix }),
    });
  }

  clearPendingRecall(sessionId: string): Promise<boolean> {
    return this.value({ kind: 'clear_recall', sessionId });
  }

  consumeAutoCompactionNotice(sessionId: string): Promise<
    {
      readonly coveredThroughTurn: number;
      readonly retainedFromTurn: number;
    } | null
  > {
    return this.value({ kind: 'consume_compaction_notice', sessionId });
  }

  async persistCatalogFacts(facts: readonly LiveModelCatalogFact[]): Promise<void> {
    await this.value<void>({ kind: 'persist_catalog_facts', facts });
  }

  subscribeAgentEvents(listener: DataAgentEventListener): () => void {
    this.agentEventListeners.add(listener);
    if (this.agentEventListeners.size === 1) {
      void this.value<void>({ kind: 'agent_events_enabled', enabled: true })
        .catch(() => undefined);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.agentEventListeners.delete(listener);
      if (
        this.agentEventListeners.size === 0 && !this.closed && !this.closing
      ) {
        void this.value<void>({ kind: 'agent_events_enabled', enabled: false })
          .catch(() => undefined);
      }
    };
  }

  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask;
    if (this.closed || this.failed) {
      this.closed = true;
      this.worker.terminate();
      return Promise.resolve();
    }
    this.closing = true;
    this.closeTask = this.request({ kind: 'close' }, true)
      .then((response) => {
        if (response.kind !== 'closed') {
          throw new Error('unexpected Data Worker close response');
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.closed = true;
        this.agentEventListeners.clear();
        this.conversationWatches.clear();
        this.descriptorWatches.clear();
        this.worker.terminate();
      });
    return this.closeTask;
  }

  abort(): void {
    this.fail(new Error('Data Worker terminated'));
    this.closed = true;
    this.worker.terminate();
  }

  async initialize(
    input: {
      readonly stateRoot: string;
      readonly workspaceRoot: string;
      readonly build: ReturnType<typeof buildManifest>;
    },
  ): Promise<void> {
    const response = await this.request({
      kind: 'initialize',
      stateRoot: input.stateRoot,
      workspaceRoot: input.workspaceRoot,
      build: input.build,
    });
    if (response.kind !== 'initialized') {
      throw new Error('unexpected Data Worker initialize response');
    }
  }
}

export const createDataClient = async (input: {
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}): Promise<DataService> => {
  const worker = new Worker(new URL('./data_bootstrap.ts', import.meta.url), {
    type: 'module',
  }) as DataWorker;
  const client = new DataClient(worker);
  try {
    await client.initialize({ ...input, build: buildManifest() });
    return client;
  } catch (error) {
    client.abort();
    throw error;
  }
};
