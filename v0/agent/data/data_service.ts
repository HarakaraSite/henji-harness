import { captureFailureDetails } from '../core/failure_details.ts';
import type { AgentEvent, AgentRequestKey } from '../core/events.ts';
import type {
  ContextView,
  ExecutionReadResult,
  ExecutionView,
  HistoryReadInput,
  HistoryReadResult,
  SessionsListResult,
} from '../../api/contract.ts';
import { replaySessionConversation } from '../../conversation/history_adapter.ts';
import { renderCanonicalView, renderConversationTimeline } from '../history/history_view.ts';
import { HistoryStoreError, type StoredExecutionRow } from '../history/history_store_contract.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import { isSessionId, SessionStoreError } from '../session/session_store_contract.ts';
import { sessionPaths } from '../session/session_store_paths.ts';
import type { WorkerCorrelation, WorkerToHostMessage } from '../worker/worker_protocol.ts';
import type { AgentPostSettlementHookUpdate } from './agent_data_contract.ts';
import { AgentDataEndpoint } from './agent_data_endpoint.ts';
import { ConversationWriter, type ConversationWriterDelta } from './conversation_writer.ts';
import {
  DataRecallSelectionError,
  type DataSessionDescriptor,
  DataSessionOwner,
  type DataSessionOwnerOpenInput,
} from './session_data_owner.ts';
import type {
  DataAgentEventListener,
  DataConversationDeltaListener,
  DataConversationSnapshot,
  DataConversationUpdate,
  DataExecutionAdmitRequest,
  DataExecutionControlInput,
  DataExecutionStartupAdmitRequest,
  DataPrepareProposalRequest,
  DataSealGenerationRequest,
  DataService,
  DataSessionOpenInput,
  DataSettleChildExecutionRequest,
  DataSettleFailureRequest,
  EncodedDataReply,
} from './data_contract.ts';
import { DataServiceError as DataServiceErrorClass } from './data_contract.ts';
import type { LiveModelCatalogFact } from '../provider/live_model_catalog.ts';

type StoredContextDelta = Readonly<{
  requestOrdinal: number;
  lane: 'parent' | 'planner';
  purpose: string;
  modelStep: number;
  resultItemCount: number;
}>;

interface GenerationEntry {
  readonly sessionId: string;
  readonly correlation: WorkerCorrelation;
  readonly endpoint: AgentDataEndpoint;
}

interface SessionWatchEntry {
  readonly listeners: Set<{
    readonly callback: DataConversationDeltaListener;
    readonly afterCut: number;
  }>;
  readonly unsubscribeWriter: () => void;
  delivery: Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sessionNotFound = (): DataServiceErrorClass =>
  new DataServiceErrorClass(404, 'session_not_found', 'session not found');

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const serviceError = (error: unknown): DataServiceErrorClass => {
  if (error instanceof DataServiceErrorClass) return error;
  if (error instanceof DataRecallSelectionError) {
    const status = error.code === 'not_found'
      ? 404
      : error.code === 'busy' || error.code === 'ambiguous'
      ? 409
      : error.code === 'unavailable'
      ? 503
      : 500;
    return new DataServiceErrorClass(
      status,
      error.code,
      error.message,
      captureFailureDetails(error),
    );
  }
  if (error instanceof SessionStoreError) {
    const status = error.code === 'session_not_found'
      ? 404
      : error.code === 'session_invalid'
      ? 400
      : error.code === 'session_busy'
      ? 409
      : 500;
    return new DataServiceErrorClass(
      status,
      error.code,
      error.message,
      captureFailureDetails(error),
    );
  }
  if (error instanceof HistoryStoreError) {
    return new DataServiceErrorClass(
      500,
      error.code,
      error.message,
      captureFailureDetails(error),
    );
  }
  return new DataServiceErrorClass(
    500,
    'data_read_failed',
    errorText(error),
    captureFailureDetails(error),
  );
};

const encode = (value: unknown): EncodedDataReply => ({
  bytes: new TextEncoder().encode(JSON.stringify(value)),
});

const contextDelta = (value: unknown): StoredContextDelta | undefined => {
  if (!isRecord(value) || !isRecord(value.event)) return undefined;
  const event = value.event;
  if (event.kind !== 'context_observation' || !isRecord(event.payload)) {
    return undefined;
  }
  const payload = event.payload;
  if (
    !isRecord(payload.observation) ||
    payload.observation.kind !== 'model_request_delta'
  ) {
    return undefined;
  }
  const delta = payload.observation.delta;
  if (
    !isRecord(delta) || !Number.isSafeInteger(delta.requestOrdinal) ||
    typeof delta.requestOrdinal !== 'number' ||
    (delta.lane !== 'parent' && delta.lane !== 'planner') ||
    typeof delta.purpose !== 'string' ||
    !Number.isSafeInteger(delta.modelStep) ||
    typeof delta.modelStep !== 'number' ||
    !Number.isSafeInteger(delta.resultItemCount) ||
    typeof delta.resultItemCount !== 'number'
  ) return undefined;
  return {
    requestOrdinal: delta.requestOrdinal,
    lane: delta.lane,
    purpose: delta.purpose,
    modelStep: delta.modelStep,
    resultItemCount: delta.resultItemCount,
  };
};

const latestRequest = (
  store: SqliteHistoryStore,
  sessionId: string,
): ContextView['latestRequest'] => {
  const executions = [...store.listExecutionsForSession(sessionId)].sort((
    left,
    right,
  ) =>
    right.createdAt.localeCompare(left.createdAt) ||
    right.executionId.localeCompare(left.executionId)
  );
  for (const execution of executions) {
    let latest: StoredContextDelta | undefined;
    for (
      const occurrence of store.listSemanticOccurrences(execution.executionId)
    ) {
      const candidate = contextDelta(occurrence.payload);
      if (
        candidate !== undefined &&
        (latest === undefined ||
          candidate.requestOrdinal > latest.requestOrdinal)
      ) latest = candidate;
    }
    if (latest === undefined) continue;
    return {
      executionId: execution.executionId,
      requestOrdinal: latest.requestOrdinal,
      lane: latest.lane,
      purpose: latest.purpose,
      modelStep: latest.modelStep,
      itemCount: latest.resultItemCount,
    };
  }
  return undefined;
};

const executionView = (
  row: StoredExecutionRow,
  requestCount: number,
): ExecutionView => ({
  executionId: row.executionId,
  sessionId: row.sessionCorrelation,
  task: row.task,
  turn: row.turn,
  createdAt: row.createdAt,
  lifecycle: row.lifecycle,
  outcome: row.outcome,
  ...(row.outcomeJson === undefined ? {} : { stopReason: row.outcomeJson.stopReason }),
  ...(row.outcomeJson?.diagnostic === undefined ? {} : {
    diagnostic: {
      code: row.outcomeJson.diagnostic.code,
      stage: row.outcomeJson.diagnostic.stage,
    },
  }),
  adoption: row.adoption,
  ...(row.committedRevision === undefined ? {} : { committedRevision: row.committedRevision }),
  processSettlement: 'unknown',
  requestCount,
  durability: {
    acknowledgement: row.acknowledgement,
    generationAvailability: row.generationAvailability,
    diagnosticCapture: row.diagnosticCapture,
    artifactCapture: row.artifactCapture,
    contextCapture: row.contextCapture,
  },
  ...(row.diagnosticId === undefined ? {} : { diagnosticId: row.diagnosticId }),
});

const generationKey = (
  sessionId: string,
  correlation: WorkerCorrelation,
): string =>
  `${sessionId}\u0000${correlation.instanceCorrelation}\u0000${correlation.workerGeneration}`;

const sameGeneration = (
  left: WorkerCorrelation,
  right: WorkerCorrelation,
): boolean =>
  left.session === right.session &&
  left.instanceCorrelation === right.instanceCorrelation &&
  left.workerGeneration === right.workerGeneration;

const requestKey = (
  executionId: string,
  event: {
    readonly lane?: 'parent' | 'planner';
    readonly modelStep: number;
    readonly requestOrdinal?: number;
  },
): AgentRequestKey => ({
  executionId,
  ...(event.lane === undefined ? {} : { lane: event.lane }),
  modelStep: event.modelStep,
  ...(event.requestOrdinal === undefined ? {} : { requestOrdinal: event.requestOrdinal }),
});

const projectAgentEvent = (
  executionId: string,
  message: WorkerToHostMessage,
): AgentEvent | undefined => {
  if (
    message.kind === 'runtime_event' && message.event.kind === 'agent_event'
  ) {
    return message.event.event;
  }
  if (message.kind === 'effect_observation') return message.effect;
  if (
    message.kind !== 'provider_observation' ||
    message.observation.kind !== 'runtime_event'
  ) return undefined;
  const event = message.observation.event;
  const turn = message.turn;
  if (event.kind === 'assistant_progress') {
    return {
      kind: 'assistant_progress',
      turn,
      text: event.text,
      requestKey: requestKey(executionId, event),
    };
  }
  if (event.kind === 'model_result') {
    const result = event.result;
    return {
      kind: 'assistant_message',
      turn,
      requestKey: requestKey(executionId, event),
      message: result.kind === 'final'
        ? {
          role: 'assistant',
          content: { kind: 'text', text: result.text },
          ...(result.providerState === undefined ? {} : {
            providerState: structuredClone(result.providerState),
          }),
        }
        : {
          role: 'assistant',
          content: result.calls.map((call) => ({
            kind: 'tool_call' as const,
            ...structuredClone(call),
          })),
          ...(result.text === undefined ? {} : { text: result.text }),
          ...(result.providerState === undefined ? {} : {
            providerState: structuredClone(result.providerState),
          }),
        },
    };
  }
  if (event.kind === 'tool_call') {
    return {
      kind: 'tool_call',
      turn,
      call: structuredClone(event.call),
      ...(event.hookEffect === undefined ? {} : {
        hookEffect: structuredClone(event.hookEffect),
      }),
      executionId,
      workerSequence: message.sequence,
      requestKey: requestKey(executionId, event),
    };
  }
  if (event.kind === 'tool_progress') {
    return {
      kind: 'tool_progress',
      turn,
      callId: event.callId,
      name: event.name,
      text: event.text,
      executionId,
      workerSequence: message.sequence,
      requestKey: requestKey(executionId, event),
    };
  }
  if (event.kind === 'tool_result') {
    return {
      kind: 'tool_result',
      turn,
      result: structuredClone(event.result),
      ...(event.hookEffect === undefined ? {} : {
        hookEffect: structuredClone(event.hookEffect),
      }),
      executionId,
      workerSequence: message.sequence,
      requestKey: requestKey(executionId, event),
    };
  }
  return undefined;
};

const publicSnapshot = (snapshot: {
  readonly sessionId: string;
  readonly cut: number;
  readonly storeRevision: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}): DataConversationSnapshot => ({
  sessionId: snapshot.sessionId,
  cut: snapshot.cut,
  storeRevision: snapshot.storeRevision,
  bytes: snapshot.bytes,
});

export const createDataService = async (input: {
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}): Promise<DataService> => {
  const statePaths = await sessionPaths(input.stateRoot, input.workspaceRoot);
  let store: SqliteHistoryStore | undefined;
  let writer: ConversationWriter | undefined;
  let storeInitialization: Promise<SqliteHistoryStore> | undefined;
  let closed = false;
  const agentEventListeners = new Set<DataAgentEventListener>();
  const owners = new Map<string, DataSessionOwner>();
  const descriptors = new Map<string, DataSessionDescriptor>();
  const generations = new Map<string, GenerationEntry>();
  const executionGenerations = new Map<string, string>();
  const watches = new Map<string, SessionWatchEntry>();
  const sessionMutations = new Map<string, Set<Promise<void>>>();

  const beginSessionMutation = (sessionId: string): () => void => {
    let resolve!: () => void;
    const barrier = new Promise<void>((done) => resolve = done);
    let active = sessionMutations.get(sessionId);
    if (active === undefined) {
      active = new Set();
      sessionMutations.set(sessionId, active);
    }
    active.add(barrier);
    return () => {
      active!.delete(barrier);
      if (active!.size === 0) sessionMutations.delete(sessionId);
      resolve();
    };
  };

  const withSessionMutation = async <T>(
    sessionId: string,
    action: () => T | Promise<T>,
  ): Promise<T> => {
    const finish = beginSessionMutation(sessionId);
    try {
      return await action();
    } finally {
      finish();
    }
  };

  const waitForSessionMutations = async (sessionId: string): Promise<void> => {
    for (;;) {
      const active = sessionMutations.get(sessionId);
      if (active === undefined || active.size === 0) return;
      await Promise.all([...active]);
    }
  };

  const currentStore = async (): Promise<SqliteHistoryStore> => {
    if (closed) throw new DataServiceErrorClass(503, 'data_worker_closed');
    if (store !== undefined) return store;
    if (storeInitialization !== undefined) return await storeInitialization;
    const created = new SqliteHistoryStore(
      input.stateRoot,
      input.workspaceRoot,
    );
    storeInitialization = (async () => {
      try {
        await created.initialize();
        store = created;
        writer = new ConversationWriter(created);
        return created;
      } catch (error) {
        created.close();
        storeInitialization = undefined;
        throw serviceError(error);
      }
    })();
    return await storeInitialization;
  };

  const currentWriter = async (): Promise<ConversationWriter> => {
    await currentStore();
    return writer!;
  };

  const requireOwner = (sessionId: string): DataSessionOwner => {
    const owner = owners.get(sessionId);
    if (owner === undefined) throw sessionNotFound();
    return owner;
  };

  const cachedOrReadDescriptor = async (
    sessionId: string,
  ): Promise<DataSessionDescriptor> => {
    const owner = owners.get(sessionId);
    if (owner !== undefined) {
      const descriptor = owner.descriptor();
      descriptors.set(sessionId, descriptor);
      return structuredClone(descriptor);
    }
    const cached = descriptors.get(sessionId);
    if (cached !== undefined) return structuredClone(cached);
    if (!isSessionId(sessionId)) throw sessionNotFound();
    const history = await currentStore();
    let record;
    try {
      record = await history.readWorker(sessionId);
    } catch (error) {
      throw serviceError(error);
    }
    const readOwner = await DataSessionOwner.open({
      store: history,
      writer: await currentWriter(),
      workspaceRoot: input.workspaceRoot,
      persistence: 'session',
      agent: record.agent,
      agentChoice: record.agentChoice,
      sessionId,
    });
    const descriptor = readOwner.descriptor();
    descriptors.set(sessionId, descriptor);
    await readOwner.close();
    return structuredClone(descriptor);
  };

  const ownerOpenInput = async (
    value: DataSessionOpenInput,
  ): Promise<DataSessionOwnerOpenInput> => ({
    store: await currentStore(),
    writer: await currentWriter(),
    workspaceRoot: input.workspaceRoot,
    persistence: value.persistence,
    agent: value.agent,
    agentChoice: value.agentChoice,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.initialModelSelection === undefined
      ? {}
      : { initialModelSelection: value.initialModelSelection }),
  });

  const endpointFor = (
    sessionId: string,
    correlation: WorkerCorrelation,
  ): AgentDataEndpoint => {
    const endpoint = generations.get(generationKey(sessionId, correlation));
    if (
      endpoint === undefined || endpoint.sessionId !== sessionId ||
      !sameGeneration(endpoint.correlation, correlation)
    ) throw new DataServiceErrorClass(404, 'agent_generation_not_found');
    return endpoint.endpoint;
  };

  const executionEndpoint = (
    executionId: string,
  ): AgentDataEndpoint | undefined => {
    const key = executionGenerations.get(executionId);
    return key === undefined ? undefined : generations.get(key)?.endpoint;
  };

  const publicUpdate = async (
    sessionId: string,
    delta: ConversationWriterDelta,
  ): Promise<DataConversationUpdate> => {
    await waitForSessionMutations(sessionId);
    let descriptor = owners.get(sessionId)?.descriptor() ??
      descriptors.get(sessionId);
    if (descriptor === undefined) {
      descriptor = await cachedOrReadDescriptor(sessionId);
    }
    descriptors.set(sessionId, descriptor);
    return {
      sessionId,
      cut: delta.cut,
      storeRevision: delta.storeRevision,
      bytes: delta.bytes,
      descriptor: structuredClone(descriptor),
    };
  };

  const drainWatchDelivery = async (
    entry: SessionWatchEntry,
  ): Promise<void> => {
    for (;;) {
      const pending = entry.delivery;
      await pending;
      if (pending === entry.delivery) return;
    }
  };

  const installWatch = (
    sessionId: string,
    listener: DataConversationDeltaListener,
  ): {
    readonly snapshot: DataConversationSnapshot;
    readonly unsubscribe: () => void;
  } => {
    let entry = watches.get(sessionId);
    if (entry === undefined) {
      const listeners = new Set<{
        readonly callback: DataConversationDeltaListener;
        readonly afterCut: number;
      }>();
      const writerWatch = writer!.watchSession(sessionId, (delta) => {
        const current = watches.get(sessionId);
        if (current === undefined) return;
        const delivery = current.delivery.then(async () => {
          const update = await publicUpdate(sessionId, delta);
          for (const target of [...current.listeners]) {
            if (delta.cut > target.afterCut) target.callback(update);
          }
        });
        current.delivery = delivery.catch(() => undefined);
      });
      const installed: SessionWatchEntry = {
        listeners,
        unsubscribeWriter: writerWatch.unsubscribe,
        delivery: Promise.resolve(),
      };
      entry = installed;
      watches.set(sessionId, installed);
      const snapshot = publicSnapshot(writerWatch.snapshot);
      const target = { callback: listener, afterCut: snapshot.cut };
      installed.listeners.add(target);
      let active = true;
      return {
        snapshot,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          installed.listeners.delete(target);
          if (installed.listeners.size === 0) {
            installed.unsubscribeWriter();
            watches.delete(sessionId);
          }
        },
      };
    }
    const snapshot = publicSnapshot(writer!.snapshotSession(sessionId));
    const target = { callback: listener, afterCut: snapshot.cut };
    entry.listeners.add(target);
    let active = true;
    return {
      snapshot,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        entry!.listeners.delete(target);
        if (entry!.listeners.size === 0) {
          entry!.unsubscribeWriter();
          watches.delete(sessionId);
        }
      },
    };
  };

  const closeGeneration = (key: string): void => {
    const generation = generations.get(key);
    if (generation === undefined) return;
    for (const [executionId, executionKey] of executionGenerations) {
      if (executionKey === key) executionGenerations.delete(executionId);
    }
    generation.endpoint.close();
    generations.delete(key);
  };

  const service: DataService = {
    async historyRead(request: HistoryReadInput): Promise<EncodedDataReply> {
      if (
        request.latest === true && request.sessionRef !== undefined ||
        request.sessionRef !== undefined && request.sessionRef.length === 0
      ) {
        throw new DataServiceErrorClass(
          400,
          'invalid_history_target',
          'invalid history target',
        );
      }
      if (
        request.view !== 'session' && request.view !== 'canonical' &&
        request.view !== 'detail'
      ) {
        throw new DataServiceErrorClass(
          400,
          'invalid_history_view',
          'invalid history view',
        );
      }
      const history = await currentStore();
      try {
        const sessions = (await history.listWorker()).sessions;
        const targetRef = request.sessionRef?.toLowerCase();
        const matches = targetRef === undefined
          ? sessions.slice(0, 1)
          : sessions.filter((entry) => entry.id.startsWith(targetRef));
        if (matches.length === 0) {
          if (targetRef === undefined) {
            return encode(
              {
                sessionId: null,
                view: request.view,
                text: '',
              } satisfies HistoryReadResult,
            );
          }
          throw sessionNotFound();
        }
        if (matches.length > 1) {
          throw new DataServiceErrorClass(
            409,
            'ambiguous_session',
            'session reference is ambiguous',
          );
        }
        const sessionId = matches[0].id;
        let text: string;
        if (request.view === 'detail') {
          text = [...history.streamHumanHistoryExport(sessionId)].map((
            record,
          ) => `${JSON.stringify(record)}\n`).join('');
        } else if (request.view === 'session') {
          const replay = replaySessionConversation(
            sessionId,
            history.readSessionConversationFacts(sessionId),
          );
          text = renderConversationTimeline(replay.state);
        } else {
          const record = await history.readWorker(sessionId);
          text = renderCanonicalView(record, input.workspaceRoot);
        }
        return encode(
          { sessionId, view: request.view, text } satisfies HistoryReadResult,
        );
      } catch (error) {
        throw serviceError(error);
      }
    },

    async contextRead(
      sessionId: string,
      pendingRecall?: ContextView['pendingRecall'],
      activeSession = false,
    ): Promise<EncodedDataReply> {
      if (!isSessionId(sessionId) && !activeSession) {
        throw new DataServiceErrorClass(
          400,
          'invalid_session_id',
          'invalid session id',
        );
      }
      const history = await currentStore();
      try {
        if (
          !activeSession &&
          !(await history.listWorker()).sessions.some((session) => session.id === sessionId)
        ) throw sessionNotFound();
        const checkpoint = await history.readCheckpoint(sessionId);
        const request = latestRequest(history, sessionId);
        const context: ContextView = {
          ...(checkpoint === undefined ? {} : {
            checkpoint: {
              summary: checkpoint.summary,
              coveredThroughTurn: checkpoint.coveredThroughTurn,
              retainedFromTurn: checkpoint.retainedFromTurn,
            },
          }),
          ...(pendingRecall === undefined ? {} : { pendingRecall }),
          ...(request === undefined ? {} : { latestRequest: request }),
        };
        return encode({ context });
      } catch (error) {
        throw serviceError(error);
      }
    },

    async executionRead(executionId: string): Promise<ExecutionReadResult> {
      const history = await currentStore();
      try {
        const row = history.readExecutionMetadata(executionId);
        const live = owners.get(row.sessionCorrelation)?.descriptor()
          .latestExecution;
        return {
          execution: live?.executionId === executionId ? live : executionView(
            row,
            history.readExecutionRequestCount(executionId),
          ),
        };
      } catch (error) {
        if (
          error instanceof HistoryStoreError && error.code === 'history_invalid'
        ) {
          throw new DataServiceErrorClass(
            404,
            'execution_not_found',
            'execution not found',
          );
        }
        throw serviceError(error);
      }
    },

    async openSession(
      value: DataSessionOpenInput,
    ): Promise<DataSessionDescriptor> {
      const history = await currentStore();
      if (value.sessionId !== undefined) {
        const existing = owners.get(value.sessionId);
        if (existing !== undefined) return existing.descriptor();
      }
      if (value.persistence === 'continue') {
        const candidate = (await history.listWorker()).sessions.find((entry) =>
          entry.agent === value.agent
        );
        if (candidate !== undefined && owners.has(candidate.id)) {
          return owners.get(candidate.id)!.descriptor();
        }
      }
      const owner = await DataSessionOwner.open(await ownerOpenInput(value));
      const descriptor = owner.descriptor();
      owners.set(descriptor.id, owner);
      descriptors.set(descriptor.id, descriptor);
      return structuredClone(descriptor);
    },

    async closeSession(sessionId: string): Promise<void> {
      const owner = owners.get(sessionId);
      if (owner === undefined) return;
      descriptors.set(sessionId, owner.descriptor());
      for (const [key, generation] of generations) {
        if (generation.sessionId === sessionId) closeGeneration(key);
      }
      await owner.close();
      owners.delete(sessionId);
    },

    async sessionDescriptor(sessionId: string): Promise<DataSessionDescriptor> {
      return await cachedOrReadDescriptor(sessionId);
    },

    async sessionsList(): Promise<SessionsListResult> {
      const history = await currentStore();
      const result = await history.listWorker();
      return {
        sessions: result.sessions.map((session) => ({
          id: session.id,
          agent: session.agent,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          ...(session.title === undefined ? {} : { title: session.title }),
          committedTurn: session.turnCount,
          messageCount: session.messageCount,
          persistence: 'persistent' as const,
        })),
      };
    },

    async deleteSession(sessionId: string): Promise<void> {
      const history = await currentStore();
      await service.closeSession(sessionId);
      const watch = watches.get(sessionId);
      if (watch !== undefined) {
        watch.unsubscribeWriter();
        watches.delete(sessionId);
      }
      try {
        await history.delete(sessionId);
      } catch (error) {
        throw serviceError(error);
      }
      writer!.releaseSession(sessionId);
      descriptors.delete(sessionId);
    },

    async conversationSnapshot(
      sessionId: string,
    ): Promise<DataConversationSnapshot> {
      const current = await currentWriter();
      try {
        const watch = watches.get(sessionId);
        if (watch !== undefined) await drainWatchDelivery(watch);
        return publicSnapshot(current.snapshotSession(sessionId));
      } catch (error) {
        if (
          error instanceof HistoryStoreError && error.code === 'history_invalid'
        ) {
          throw sessionNotFound();
        }
        throw serviceError(error);
      }
    },

    async watchSession(
      sessionId: string,
      listener: DataConversationDeltaListener,
    ): Promise<
      {
        readonly snapshot: DataConversationSnapshot;
        readonly unsubscribe: () => void;
      }
    > {
      await currentWriter();
      try {
        const watch = watches.get(sessionId);
        if (watch !== undefined) await drainWatchDelivery(watch);
        return installWatch(sessionId, listener);
      } catch (error) {
        throw serviceError(error);
      }
    },

    attachGeneration(
      sessionId: string,
      correlation: WorkerCorrelation,
    ): Promise<MessagePort> {
      const owner = requireOwner(sessionId);
      const key = generationKey(sessionId, correlation);
      closeGeneration(key);
      const channel = new MessageChannel();
      const endpoint = new AgentDataEndpoint({
        port: channel.port1,
        generationContext: (requestCorrelation) => owner.generationContext(requestCorrelation),
        beginExecution: (
          executionId,
          executionCorrelation,
          diagnosticStageBuffer,
          auxiliaryStageGapMs,
        ) =>
          owner.attachExecutionStageProbe(
            executionId,
            executionCorrelation,
            diagnosticStageBuffer,
            auxiliaryStageGapMs,
          ),
        receiveData: (data) => {
          const finishMutation = beginSessionMutation(sessionId);
          try {
            const accepted = owner.receiveData(data);
            if (accepted === 'accepted' && agentEventListeners.size > 0) {
              const event = projectAgentEvent(data.executionId, data.message);
              if (event !== undefined) {
                const eventBytes = new TextEncoder().encode(
                  JSON.stringify(event),
                );
                for (const listener of [...agentEventListeners]) {
                  listener(sessionId, eventBytes);
                }
              }
            }
            return accepted;
          } finally {
            finishMutation();
          }
        },
        checkpoint: (message) => owner.installCheckpoint(message),
        afterTurn: async (update, sequence) => {
          const accepted = await withSessionMutation(
            sessionId,
            () => owner.installAfterTurnContext(update, sequence),
          );
          if (accepted) descriptors.set(sessionId, owner.descriptor());
          return accepted;
        },
        postSettlementHook: async (update: AgentPostSettlementHookUpdate, sequence) => {
          const accepted = await withSessionMutation(
            sessionId,
            () => owner.installPostSettlementHook(update, sequence),
          );
          if (accepted) descriptors.set(sessionId, owner.descriptor());
          return accepted;
        },
        onFailure: () => {
          // Worker/control ownership reacts to its own process and generation failure.
        },
      });
      channel.port1.start();
      generations.set(key, { sessionId, correlation, endpoint });
      return Promise.resolve(channel.port2);
    },

    async executionAdmit(
      sessionId: string,
      value: DataExecutionAdmitRequest,
    ) {
      const owner = requireOwner(sessionId);
      const endpoint = endpointFor(sessionId, value.correlation);
      const ready = await endpoint.ready();
      if (!sameGeneration(ready.correlation, value.correlation)) {
        throw new DataServiceErrorClass(409, 'agent_generation_mismatch');
      }
      const admitted = await withSessionMutation(sessionId, () =>
        owner.admit({
          ...value,
          configuration: ready.configuration!,
          maxSteps: ready.manifest!.maxSteps,
          ...(ready.startupSnapshot?.context === undefined
            ? {}
            : { contextSnapshot: ready.startupSnapshot.context }),
        }));
      executionGenerations.set(
        value.executionId,
        generationKey(sessionId, value.correlation),
      );
      descriptors.set(sessionId, admitted.descriptor);
      return admitted;
    },

    async executionAdmitStartup(
      sessionId: string,
      value: DataExecutionStartupAdmitRequest,
    ) {
      const owner = requireOwner(sessionId);
      endpointFor(sessionId, value.correlation);
      const admitted = await withSessionMutation(sessionId, () =>
        owner.admit({
          ...value,
          ...(value.contextSnapshot === undefined
            ? {}
            : { contextSnapshot: value.contextSnapshot }),
        }));
      executionGenerations.set(
        value.executionId,
        generationKey(sessionId, value.correlation),
      );
      descriptors.set(sessionId, admitted.descriptor);
      return admitted;
    },

    async recordExecutionControl(
      sessionId: string,
      executionId: string,
      value: DataExecutionControlInput,
    ) {
      const descriptor = await withSessionMutation(
        sessionId,
        () => requireOwner(sessionId).recordExecutionControl(executionId, value),
      );
      descriptors.set(sessionId, descriptor);
      return descriptor;
    },

    async prepareProposal(
      sessionId: string,
      value: DataPrepareProposalRequest,
    ) {
      const owner = requireOwner(sessionId);
      const endpoint = executionEndpoint(value.executionId);
      if (endpoint === undefined) {
        throw new DataServiceErrorClass(404, 'agent_generation_not_found');
      }
      const proposal = await endpoint.proposal(value.proposalId);
      if (
        proposal.executionId !== value.executionId ||
        proposal.sequence !== value.finalDataSequence
      ) throw new DataServiceErrorClass(409, 'proposal_barrier_mismatch');
      const token = await owner.prepareProposal({
        proposalId: value.proposalId,
        executionId: value.executionId,
        finalDataSequence: value.finalDataSequence,
        message: proposal.message,
      });
      endpoint.releaseExecution(value.executionId);
      return token;
    },

    async authorizeCommit(
      sessionId: string,
      token,
      decision,
    ) {
      const result = await withSessionMutation(
        sessionId,
        () => requireOwner(sessionId).authorizeCommit(token, decision),
      );
      descriptors.set(sessionId, result.descriptor);
      executionEndpoint(token.executionId)?.releaseExecution(token.executionId);
      return result;
    },

    async settleFailure(
      sessionId: string,
      value: DataSettleFailureRequest,
    ) {
      const endpoint = executionEndpoint(value.executionId);
      if (endpoint === undefined) {
        throw new DataServiceErrorClass(404, 'agent_generation_not_found');
      }
      const failure = await endpoint.failure(value.executionId);
      if (failure.sequence !== value.finalDataSequence) {
        throw new DataServiceErrorClass(409, 'failure_barrier_mismatch');
      }
      const result = await withSessionMutation(
        sessionId,
        () =>
          requireOwner(sessionId).settleFailure({
            executionId: value.executionId,
            finalDataSequence: value.finalDataSequence,
            message: failure.message,
          }),
      );
      descriptors.set(sessionId, result.descriptor);
      endpoint.releaseExecution(value.executionId);
      return result;
    },

    async sealGeneration(
      sessionId: string,
      value: DataSealGenerationRequest,
    ) {
      const endpoint = executionEndpoint(value.executionId);
      endpoint?.seal();
      const result = await withSessionMutation(
        sessionId,
        () => requireOwner(sessionId).sealGeneration(value),
      );
      descriptors.set(sessionId, result.descriptor);
      const key = executionGenerations.get(value.executionId);
      if (key !== undefined) closeGeneration(key);
      return result;
    },

    async settleChildExecution(
      sessionId: string,
      value: DataSettleChildExecutionRequest,
    ) {
      const owner = requireOwner(sessionId);
      const endpoint = executionEndpoint(value.executionId);
      if (endpoint === undefined) {
        throw new DataServiceErrorClass(404, 'agent_generation_not_found');
      }
      if (value.artifactMetadata !== undefined) {
        owner.updateExecutionArtifactMetadata(
          value.executionId,
          value.artifactMetadata,
        );
      }
      let result;
      if (value.proposalId !== undefined) {
        const proposal = await endpoint.proposal(value.proposalId);
        if (
          proposal.executionId !== value.executionId ||
          proposal.sequence !== value.finalDataSequence
        ) throw new DataServiceErrorClass(409, 'proposal_barrier_mismatch');
        const token = await withSessionMutation(
          sessionId,
          () =>
            owner.prepareProposal({
              proposalId: value.proposalId!,
              executionId: value.executionId,
              finalDataSequence: value.finalDataSequence,
              message: proposal.message,
            }),
        );
        endpoint.releaseExecution(value.executionId);
        result = await withSessionMutation(
          sessionId,
          () => owner.authorizeCommit(token, value.decision ?? { accepted: true }),
        );
      } else {
        const failure = await endpoint.failure(value.executionId);
        if (failure.sequence !== value.finalDataSequence) {
          throw new DataServiceErrorClass(409, 'failure_barrier_mismatch');
        }
        result = await withSessionMutation(
          sessionId,
          () =>
            owner.settleFailure({
              executionId: value.executionId,
              finalDataSequence: value.finalDataSequence,
              message: failure.message,
            }),
        );
        endpoint.releaseExecution(value.executionId);
      }
      descriptors.set(sessionId, result.descriptor);
      return result;
    },

    updateExecutionArtifactMetadata(sessionId, executionId, metadata) {
      requireOwner(sessionId).updateExecutionArtifactMetadata(
        executionId,
        metadata,
      );
      return Promise.resolve();
    },

    installCheckpoint(sessionId, message) {
      return Promise.resolve(
        requireOwner(sessionId).installCheckpoint(message),
      );
    },

    updateModelSelection(sessionId, selection) {
      const result = requireOwner(sessionId).updateModelSelection(selection);
      descriptors.set(sessionId, result.descriptor);
      return Promise.resolve(result);
    },

    updateTitle(sessionId, title) {
      const result = requireOwner(sessionId).updateTitle(title);
      descriptors.set(sessionId, result.descriptor);
      return Promise.resolve(result);
    },

    async prepareRecall(sessionId, executionIdPrefix) {
      try {
        const owner = requireOwner(sessionId);
        const result = await owner.prepareRecall(executionIdPrefix);
        descriptors.set(sessionId, owner.descriptor());
        return result;
      } catch (error) {
        throw serviceError(error);
      }
    },

    clearPendingRecall(sessionId) {
      const result = requireOwner(sessionId).clearPendingRecall();
      descriptors.set(sessionId, requireOwner(sessionId).descriptor());
      return Promise.resolve(result);
    },

    consumeAutoCompactionNotice(sessionId) {
      return Promise.resolve(
        requireOwner(sessionId).authority.consumeAutoCompactionNotice(),
      );
    },

    subscribeAgentEvents(listener: DataAgentEventListener): () => void {
      agentEventListeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        agentEventListeners.delete(listener);
      };
    },

    async persistCatalogFacts(
      facts: readonly LiveModelCatalogFact[],
    ): Promise<void> {
      if (facts.length === 0) return;
      await currentStore();
      try {
        await Deno.mkdir(statePaths.root, { recursive: true, mode: 0o700 });
        await Deno.writeTextFile(
          `${statePaths.root}/catalog-requests.jsonl`,
          `${facts.map((fact) => JSON.stringify(fact)).join('\n')}\n`,
          { append: true },
        );
      } catch (error) {
        throw serviceError(error);
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const key of [...generations.keys()]) closeGeneration(key);
      for (const watch of watches.values()) watch.unsubscribeWriter();
      watches.clear();
      await Promise.all([...owners.values()].map((owner) => owner.close()));
      owners.clear();
      descriptors.clear();
      agentEventListeners.clear();
      writer?.close();
      writer = undefined;
      store?.close();
      store = undefined;
    },
  };

  await currentStore();
  return service;
};
