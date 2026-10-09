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
import type {
  ConversationContentChunk,
  ConversationContentLocator,
  ConversationPageMetadata,
} from '../../conversation/model.ts';
import {
  type DataCommandReceipt,
  type DataExecutionCompletionControl,
  type DataSessionReadCursor,
  HistoryStoreError,
  type StoredExecutionDescriptorSummary,
  type StoredExecutionRow,
} from '../history/history_store_contract.ts';
import {
  HistoryReadTargetError,
  SqliteHistoryStore,
  type SqliteHistoryTextCursor,
} from '../history/sqlite_history_store.ts';
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
  DataFollowUpCursor,
  DataFollowUpPage,
  DataFollowUpReceipt,
  DataHistoryStreamChunk,
  DataHistoryStreamOpenResult,
  DataPrepareProposalRequest,
  DataSealGenerationRequest,
  DataService,
  DataSessionDescriptorListener,
  DataSessionDescriptorUpdate,
  DataSessionOpenInput,
  DataSettleChildExecutionRequest,
  DataSettleFailureRequest,
  EncodedDataReply,
} from './data_contract.ts';
import { DataServiceError as DataServiceErrorClass } from './data_contract.ts';
import type { LiveModelCatalogFact } from '../provider/live_model_catalog.ts';

interface GenerationEntry {
  readonly sessionId: string;
  readonly correlation: WorkerCorrelation;
  readonly endpoint: AgentDataEndpoint;
}

interface ConversationWatchEntry {
  readonly listeners: Set<{
    readonly callback: DataConversationDeltaListener;
    readonly afterCut: number;
  }>;
  readonly unsubscribeWriter: () => void;
  delivery: Promise<void>;
  readonly pending: ConversationWriterDelta[];
  pendingBytes: number;
  needsResync: boolean;
  latestCut: number;
  latestStoreRevision: number;
  lastDeliveredCut: number;
  pumping: boolean;
}

interface DescriptorWatchEntry {
  readonly listeners: Set<DataSessionDescriptorListener>;
}

interface HistoryStreamEntry {
  readonly store: SqliteHistoryStore;
  readonly cursor: SqliteHistoryTextCursor;
}

const sessionNotFound = (): DataServiceErrorClass =>
  new DataServiceErrorClass(404, 'session_not_found', 'session not found');

const CONVERSATION_WATCH_PENDING_BYTES = 2 * 1024 * 1024;

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
  if (error instanceof HistoryReadTargetError) {
    const status = error.code === 'ambiguous_session'
      ? 409
      : error.code === 'session_not_found'
      ? 404
      : 400;
    return new DataServiceErrorClass(status, error.code, error.message);
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

const executionView = (
  row: StoredExecutionRow | StoredExecutionDescriptorSummary,
  history: SqliteHistoryStore,
): ExecutionView => {
  const completionControl = history.readExecutionCompletionControl(
    row.executionId,
  );
  const outcome = 'outcomeJson' in row ? row.outcomeJson : undefined;
  const stopReason = 'stopReason' in row ? row.stopReason : outcome?.stopReason;
  const diagnostic = 'diagnostic' in row ? row.diagnostic : outcome?.diagnostic;
  const requestCount = 'requestCount' in row
    ? row.requestCount
    : history.readExecutionRequestCount(row.executionId);
  return {
    executionId: row.executionId,
    sessionId: row.sessionCorrelation,
    task: row.task,
    turn: row.turn,
    createdAt: row.createdAt,
    ...(completionControl === null ? {} : {
      submittedByCommandId: completionControl.submittedByCommandId,
    }),
    lifecycle: row.lifecycle,
    outcome: row.outcome,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(diagnostic === undefined ? {} : {
      diagnostic: {
        code: diagnostic.code,
        stage: diagnostic.stage,
      },
    }),
    adoption: row.adoption,
    ...(row.committedRevision === undefined ? {} : { committedRevision: row.committedRevision }),
    processSettlement: completionControl?.processSettlement ?? 'unknown',
    requestCount,
    durability: {
      acknowledgement: row.acknowledgement,
      generationAvailability: row.generationAvailability,
      diagnosticCapture: row.diagnosticCapture,
      artifactCapture: row.artifactCapture,
      contextCapture: row.contextCapture,
    },
    ...(row.diagnosticId === undefined ? {} : { diagnosticId: row.diagnosticId }),
  };
};

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
  const dataInstanceId = crypto.randomUUID().toLowerCase();
  let store: SqliteHistoryStore | undefined;
  let writer: ConversationWriter | undefined;
  const historyStreams = new Map<string, HistoryStreamEntry>();
  let storeInitialization: Promise<SqliteHistoryStore> | undefined;
  let closed = false;
  const agentEventListeners = new Set<DataAgentEventListener>();
  const owners = new Map<string, DataSessionOwner>();
  const descriptors = new Map<string, DataSessionDescriptor>();
  const generations = new Map<string, GenerationEntry>();
  const executionGenerations = new Map<string, string>();
  const conversationWatches = new Map<string, ConversationWatchEntry>();
  const descriptorWatches = new Map<string, DescriptorWatchEntry>();
  const descriptorSequences = new Map<string, number>();
  const sessionMutations = new Map<string, Set<Promise<void>>>();
  const sessionReads = new Map<string, Set<Promise<void>>>();
  let nextConversationDeliverySequence = 0;
  const inactiveReadCursors = new Map<
    string,
    { readonly cursor: DataSessionReadCursor; readonly bytes: number }
  >();
  const retiringSessions = new Map<string, Promise<void>>();
  let inactiveReadCursorBytes = 0;

  const rememberInactiveReadCursor = (
    cursor: DataSessionReadCursor,
  ): void => {
    const bytes = new TextEncoder().encode(JSON.stringify(cursor)).byteLength;
    const previous = inactiveReadCursors.get(cursor.sessionCorrelation);
    if (previous !== undefined) {
      inactiveReadCursorBytes -= previous.bytes;
      inactiveReadCursors.delete(cursor.sessionCorrelation);
    }
    if (bytes > 2 * 1024 * 1024) return;
    inactiveReadCursors.set(cursor.sessionCorrelation, { cursor, bytes });
    inactiveReadCursorBytes += bytes;
    while (
      inactiveReadCursors.size > 32 || inactiveReadCursorBytes > 2 * 1024 * 1024
    ) {
      const oldest = inactiveReadCursors.entries().next().value as
        | [string, { readonly bytes: number }]
        | undefined;
      if (oldest === undefined) break;
      inactiveReadCursors.delete(oldest[0]);
      inactiveReadCursorBytes -= oldest[1].bytes;
    }
  };

  const takeInactiveReadCursor = (
    sessionId: string,
  ): DataSessionReadCursor | undefined => {
    const cached = inactiveReadCursors.get(sessionId);
    if (cached === undefined) return undefined;
    inactiveReadCursors.delete(sessionId);
    inactiveReadCursorBytes -= cached.bytes;
    return cached.cursor;
  };

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

  const beginSessionRead = (sessionId: string): () => void => {
    let resolve!: () => void;
    const barrier = new Promise<void>((done) => resolve = done);
    let active = sessionReads.get(sessionId);
    if (active === undefined) {
      active = new Set();
      sessionReads.set(sessionId, active);
    }
    active.add(barrier);
    return () => {
      active!.delete(barrier);
      if (active!.size === 0) sessionReads.delete(sessionId);
      resolve();
    };
  };

  const waitForSessionReads = async (sessionId: string): Promise<void> => {
    for (;;) {
      const active = sessionReads.get(sessionId);
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

  const closeHistoryStream = (streamId: string): void => {
    const entry = historyStreams.get(streamId);
    if (entry === undefined) return;
    historyStreams.delete(streamId);
    entry.cursor.close();
    entry.store.close();
  };

  const openHistoryStream = async (
    request: HistoryReadInput,
  ): Promise<DataHistoryStreamOpenResult> => {
    await currentStore();
    const reader = new SqliteHistoryStore(
      input.stateRoot,
      input.workspaceRoot,
      { readOnly: true },
    );
    try {
      await reader.initialize();
      const cursor = reader.openHistoryText(request, input.workspaceRoot);
      let streamId: string;
      do streamId = crypto.randomUUID().toLowerCase(); while (historyStreams.has(streamId));
      historyStreams.set(streamId, { store: reader, cursor });
      return { streamId, sessionId: cursor.sessionId, view: cursor.view };
    } catch (error) {
      reader.close();
      throw serviceError(error);
    }
  };

  const readHistoryStream = (streamId: string): DataHistoryStreamChunk => {
    const entry = historyStreams.get(streamId);
    if (entry === undefined) {
      throw new DataServiceErrorClass(404, 'history_stream_not_found');
    }
    try {
      const chunk = entry.cursor.read(256 * 1024);
      if (chunk.done) closeHistoryStream(streamId);
      return chunk;
    } catch (error) {
      closeHistoryStream(streamId);
      throw serviceError(error);
    }
  };

  const collectHistoryRead = async (
    request: HistoryReadInput,
  ): Promise<EncodedDataReply> => {
    const opened = await openHistoryStream(request);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text: string[] = [];
    try {
      for (;;) {
        const chunk = readHistoryStream(opened.streamId);
        text.push(decoder.decode(chunk.bytes, { stream: !chunk.done }));
        if (chunk.done) break;
      }
      text.push(decoder.decode());
      return encode(
        {
          sessionId: opened.sessionId,
          view: opened.view,
          text: text.join(''),
        } satisfies HistoryReadResult,
      );
    } finally {
      closeHistoryStream(opened.streamId);
    }
  };

  const requireOwner = (sessionId: string): DataSessionOwner => {
    const owner = owners.get(sessionId);
    if (owner === undefined) throw sessionNotFound();
    return owner;
  };

  const setDescriptor = (
    sessionId: string,
    descriptor: DataSessionDescriptor,
  ): void => {
    const previous = descriptors.get(sessionId);
    descriptors.set(sessionId, descriptor);
    if (
      previous !== undefined &&
      JSON.stringify(previous) === JSON.stringify(descriptor)
    ) return;
    const sequence = (descriptorSequences.get(sessionId) ?? 0) + 1;
    descriptorSequences.set(sessionId, sequence);
    const watch = descriptorWatches.get(sessionId);
    if (watch === undefined) return;
    const update: DataSessionDescriptorUpdate = {
      sequence,
      descriptor: structuredClone(descriptor),
    };
    for (const listener of [...watch.listeners]) listener(update);
  };

  const restoreInactiveCursor = async (sessionId: string): Promise<void> => {
    const current = await currentWriter();
    if (current.sessionCursorState(sessionId) !== undefined) return;
    const history = await currentStore();
    const cursor = takeInactiveReadCursor(sessionId) ??
      history.readDataSessionReadCursor(dataInstanceId, sessionId);
    if (cursor === undefined) return;
    current.restoreSessionCursor(
      sessionId,
      cursor.cut,
      cursor.storeRevision,
    );
    descriptorSequences.set(
      sessionId,
      Math.max(descriptorSequences.get(sessionId) ?? 0, cursor.descriptorSequence),
    );
  };

  const cachedOrReadDescriptor = async (
    sessionId: string,
  ): Promise<DataSessionDescriptor> => {
    const owner = owners.get(sessionId);
    if (owner !== undefined) {
      const descriptor = owner.descriptor();
      setDescriptor(sessionId, descriptor);
      return structuredClone(descriptor);
    }
    const cached = descriptors.get(sessionId);
    if (cached !== undefined) return structuredClone(cached);
    if (!isSessionId(sessionId)) throw sessionNotFound();
    await restoreInactiveCursor(sessionId);
    const history = await currentStore();
    let metadata;
    try {
      metadata = await history.readSessionMetadataSnapshot(sessionId);
    } catch (error) {
      throw serviceError(error);
    }
    const checkpoint = metadata.checkpoint === undefined ? undefined : {
      summary: metadata.checkpoint.summary,
      coveredThroughTurn: metadata.checkpoint.coveredThroughTurn,
      retainedFromTurn: metadata.checkpoint.retainedFromTurn,
    };
    const latestRequest = history.readLatestRequestForSession(sessionId);
    const latestExecutionRow = history.readLatestExecutionForSession(sessionId);
    const descriptor: DataSessionDescriptor = {
      id: sessionId,
      persistence: 'persistent',
      agent: metadata.agent,
      agentChoice: metadata.agentChoice,
      modelSelection: metadata.activeModel,
      stateRevision: metadata.stateRevision,
      nextTurn: metadata.nextTurn,
      privateStateFromTurn: metadata.privateStateFromTurn,
      currentPosition: {
        sessionId,
        createdAt: metadata.createdAt,
        ...(metadata.title === null ? {} : { title: metadata.title }),
        agent: metadata.agent,
        committedTurn: metadata.nextTurn - 1,
        messageCount: metadata.messageCount,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      },
      ...(latestExecutionRow === undefined
        ? {}
        : { latestExecution: executionView(latestExecutionRow, history) }),
      context: {
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(latestRequest === undefined ? {} : { latestRequest }),
      },
      ...(metadata.checkpoint === undefined ? {} : {
        checkpoint: {
          coveredThroughTurn: metadata.checkpoint.coveredThroughTurn,
          retainedFromTurn: metadata.checkpoint.retainedFromTurn,
        },
      }),
    };
    setDescriptor(sessionId, descriptor);
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

  const pruneUnretainedExecutionGenerations = (
    sessionId: string,
    owner: DataSessionOwner,
  ): void => {
    for (const [executionId, key] of executionGenerations) {
      if (owner.hasRetainedExecution(executionId)) continue;
      const generation = generations.get(key);
      if (generation?.sessionId !== sessionId) continue;
      generation.endpoint.releaseExecution(executionId);
      executionGenerations.delete(executionId);
    }
  };

  const publicUpdate = async (
    sessionId: string,
    delta: ConversationWriterDelta,
    deliverySequence: number,
  ): Promise<DataConversationUpdate> => {
    await waitForSessionMutations(sessionId);
    let descriptor = owners.get(sessionId)?.descriptor() ??
      descriptors.get(sessionId);
    if (descriptor === undefined) {
      descriptor = await cachedOrReadDescriptor(sessionId);
    }
    setDescriptor(sessionId, descriptor);
    return {
      sessionId,
      cut: delta.cut,
      storeRevision: delta.storeRevision,
      bytes: delta.bytes,
      descriptor: structuredClone(descriptor),
      deliverySequence,
    };
  };

  const publicSnapshotUpdate = async (
    sessionId: string,
    deliverySequence: number,
  ): Promise<DataConversationUpdate> => {
    await waitForSessionMutations(sessionId);
    let descriptor = owners.get(sessionId)?.descriptor() ??
      descriptors.get(sessionId);
    if (descriptor === undefined) descriptor = await cachedOrReadDescriptor(sessionId);
    setDescriptor(sessionId, descriptor);
    const snapshot = writer!.snapshotSession(sessionId);
    return {
      ...publicSnapshot(snapshot),
      descriptor: structuredClone(descriptor),
      deliverySequence,
      snapshot: true,
    };
  };

  const pumpConversationWatch = (
    sessionId: string,
    entry: ConversationWatchEntry,
  ): void => {
    if (entry.pumping) return;
    entry.pumping = true;
    const delivery = (async () => {
      try {
        while (
          entry.listeners.size > 0 &&
          (entry.needsResync || entry.pending.length > 0)
        ) {
          let update: DataConversationUpdate;
          if (entry.needsResync) {
            entry.needsResync = false;
            entry.pending.length = 0;
            entry.pendingBytes = 0;
            update = await publicSnapshotUpdate(
              sessionId,
              ++nextConversationDeliverySequence,
            );
            entry.latestCut = update.cut;
            entry.latestStoreRevision = update.storeRevision;
          } else {
            const delta = entry.pending.shift()!;
            entry.pendingBytes -= delta.bytes.byteLength;
            if (delta.cut <= entry.lastDeliveredCut) continue;
            entry.latestCut = delta.cut;
            entry.latestStoreRevision = delta.storeRevision;
            update = await publicUpdate(
              sessionId,
              delta,
              ++nextConversationDeliverySequence,
            );
          }
          const listeners = [...entry.listeners].filter((target) => update.cut > target.afterCut);
          await Promise.all(
            listeners.map((target) => target.callback(update)),
          );
          entry.lastDeliveredCut = Math.max(entry.lastDeliveredCut, update.cut);
        }
      } catch {
        // A failed delivery cannot be followed by deltas as if the missing update
        // had been applied. Retain only the resync marker until the next producer
        // update (or unsubscribe) lets the current finite snapshot be retried.
        entry.pending.length = 0;
        entry.pendingBytes = 0;
        entry.needsResync = true;
      } finally {
        entry.pumping = false;
      }
    })();
    entry.delivery = delivery.catch(() => undefined);
  };

  const enqueueConversationDelta = (
    sessionId: string,
    entry: ConversationWatchEntry,
    delta: ConversationWriterDelta,
  ): void => {
    entry.latestCut = delta.cut;
    entry.latestStoreRevision = delta.storeRevision;
    if (!entry.needsResync) {
      const bytes = delta.bytes.byteLength;
      const startsDelivery = !entry.pumping && entry.pending.length === 0;
      if (
        !startsDelivery &&
        entry.pendingBytes + bytes > CONVERSATION_WATCH_PENDING_BYTES
      ) {
        entry.pending.length = 0;
        entry.pendingBytes = 0;
        entry.needsResync = true;
      } else {
        entry.pending.push(delta);
        entry.pendingBytes += bytes;
      }
    }
    pumpConversationWatch(sessionId, entry);
  };

  const drainConversationDelivery = async (
    entry: ConversationWatchEntry,
  ): Promise<void> => {
    for (;;) {
      const pending = entry.delivery;
      await pending;
      if (pending === entry.delivery) return;
    }
  };

  const releaseInactiveSession = async (
    sessionId: string,
    pendingDelivery?: Promise<void>,
  ): Promise<void> => {
    const existing = retiringSessions.get(sessionId);
    if (existing !== undefined) {
      await existing;
      if (!retiringSessions.has(sessionId)) {
        await releaseInactiveSession(sessionId, pendingDelivery);
      }
      return;
    }
    const retirement = (async () => {
      if (pendingDelivery !== undefined) await pendingDelivery;
      await waitForSessionMutations(sessionId);
      await waitForSessionReads(sessionId);
      if (
        owners.has(sessionId) || conversationWatches.has(sessionId) ||
        (descriptorWatches.get(sessionId)?.listeners.size ?? 0) > 0
      ) return;

      const current = await currentWriter();
      let cursor = current.sessionCursorState(sessionId);
      const descriptor = descriptors.get(sessionId);
      if (cursor === undefined && descriptor === undefined) return;
      const history = await currentStore();
      if (cursor === undefined) {
        current.restoreSessionCursor(sessionId, 0, 0);
        cursor = current.sessionCursorState(sessionId);
      }
      if (cursor === undefined) return;

      let anchor: DataSessionReadCursor['anchor'];
      let latestExecutionId = descriptor?.latestExecution?.executionId;
      if (descriptor !== undefined) {
        anchor = {
          persistence: descriptor.persistence,
          stateRevision: descriptor.stateRevision,
          nextTurn: descriptor.nextTurn,
          privateStateFromTurn: descriptor.privateStateFromTurn,
          session: {
            id: descriptor.currentPosition.sessionId,
            createdAt: descriptor.currentPosition.createdAt,
            committedTurn: descriptor.currentPosition.committedTurn,
            messageCount: descriptor.currentPosition.messageCount,
          },
        };
      } else if (isSessionId(sessionId)) {
        let metadata;
        try {
          metadata = await history.readSessionMetadataSnapshot(sessionId);
        } catch (error) {
          if (
            error instanceof SessionStoreError &&
            error.code === 'session_not_found'
          ) {
            current.releaseSession(sessionId);
            descriptors.delete(sessionId);
            descriptorSequences.delete(sessionId);
            return;
          }
          throw error;
        }
        anchor = {
          persistence: 'persistent',
          stateRevision: metadata.stateRevision,
          nextTurn: metadata.nextTurn,
          privateStateFromTurn: metadata.privateStateFromTurn,
          session: {
            id: sessionId,
            createdAt: metadata.createdAt,
            committedTurn: metadata.nextTurn - 1,
            messageCount: metadata.messageCount,
          },
        };
        latestExecutionId ??= history.readLatestExecutionForSession?.(sessionId)
          ?.executionId;
      } else {
        current.releaseSession(sessionId);
        descriptors.delete(sessionId);
        descriptorSequences.delete(sessionId);
        return;
      }

      // A read may have started while the cursor anchor was being reconstructed.
      // Keep the owner until that read has completed and then retry from its finally.
      if (
        owners.has(sessionId) || conversationWatches.has(sessionId) ||
        (descriptorWatches.get(sessionId)?.listeners.size ?? 0) > 0 ||
        sessionMutations.has(sessionId) || sessionReads.has(sessionId)
      ) return;

      const saved: DataSessionReadCursor = {
        dataInstanceId,
        sessionCorrelation: sessionId,
        cut: cursor.cut,
        storeRevision: cursor.storeRevision,
        descriptorSequence: descriptorSequences.get(sessionId) ?? 0,
        anchor,
        ...(latestExecutionId === undefined ? {} : { latestExecutionId }),
      };
      history.writeDataSessionReadCursor(saved);
      rememberInactiveReadCursor(saved);
      current.releaseSession(sessionId);
      descriptors.delete(sessionId);
      descriptorSequences.delete(sessionId);
    })();
    const settled = retirement.finally(() => {
      if (retiringSessions.get(sessionId) === settled) {
        retiringSessions.delete(sessionId);
      }
    });
    retiringSessions.set(sessionId, settled);
    await settled;
  };

  const withSessionRead = async <T>(
    sessionId: string,
    action: () => T | Promise<T>,
  ): Promise<T> => {
    const finish = beginSessionRead(sessionId);
    let result: T;
    try {
      result = await action();
    } catch (error) {
      finish();
      try {
        await releaseInactiveSession(sessionId);
      } catch {
        // Preserve the read's original error.
      }
      throw error;
    }
    finish();
    try {
      await releaseInactiveSession(sessionId);
    } catch (error) {
      throw serviceError(error);
    }
    return result;
  };

  const installConversationWatch = (
    sessionId: string,
    listener: DataConversationDeltaListener,
  ): {
    readonly snapshot: DataConversationSnapshot;
    readonly unsubscribe: () => void;
  } => {
    let entry = conversationWatches.get(sessionId);
    if (entry === undefined) {
      const listeners = new Set<{
        readonly callback: DataConversationDeltaListener;
        readonly afterCut: number;
      }>();
      const writerWatch = writer!.watchSession(sessionId, (delta) => {
        const current = conversationWatches.get(sessionId);
        if (current === undefined) return;
        enqueueConversationDelta(sessionId, current, delta);
      });
      const snapshot = publicSnapshot(writerWatch.snapshot);
      const installed: ConversationWatchEntry = {
        listeners,
        unsubscribeWriter: writerWatch.unsubscribe,
        delivery: Promise.resolve(),
        pending: [],
        pendingBytes: 0,
        needsResync: false,
        latestCut: snapshot.cut,
        latestStoreRevision: snapshot.storeRevision,
        lastDeliveredCut: snapshot.cut,
        pumping: false,
      };
      entry = installed;
      conversationWatches.set(sessionId, installed);
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
            installed.pending.length = 0;
            installed.pendingBytes = 0;
            installed.needsResync = false;
            conversationWatches.delete(sessionId);
            void releaseInactiveSession(sessionId, installed.delivery).catch(
              () => undefined,
            );
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
          entry!.pending.length = 0;
          entry!.pendingBytes = 0;
          entry!.needsResync = false;
          conversationWatches.delete(sessionId);
          void releaseInactiveSession(sessionId, entry!.delivery).catch(
            () => undefined,
          );
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
      return await collectHistoryRead(request);
    },

    async historyStreamOpen(
      request: HistoryReadInput,
    ): Promise<DataHistoryStreamOpenResult> {
      return await openHistoryStream(request);
    },

    historyStreamRead(
      streamId: string,
    ): Promise<DataHistoryStreamChunk> {
      return Promise.resolve(readHistoryStream(streamId));
    },

    historyStreamClose(streamId: string): Promise<void> {
      return Promise.resolve(closeHistoryStream(streamId));
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
        const request = history.readLatestRequestForSession(sessionId);
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
        return await withSessionRead(row.sessionCorrelation, () => {
          const live = owners.get(row.sessionCorrelation)?.descriptor()
            .latestExecution;
          return {
            execution: live?.executionId === executionId ? live : executionView(row, history),
          };
        });
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

    async commandReceiptRead(
      coreEpoch: string,
      commandId: string,
    ): Promise<DataCommandReceipt | null> {
      const history = await currentStore();
      try {
        return history.readCommandReceipt(coreEpoch, commandId);
      } catch (error) {
        throw serviceError(error);
      }
    },

    async commandReceiptSave(receipt: DataCommandReceipt): Promise<void> {
      const history = await currentStore();
      try {
        history.writeCommandReceipt(receipt);
      } catch (error) {
        throw serviceError(error);
      }
    },

    async coreSessionCursorRead(
      coreEpoch: string,
      sessionId: string,
    ): Promise<number | null> {
      const history = await currentStore();
      try {
        return history.readCoreSessionCursor(coreEpoch, sessionId);
      } catch (error) {
        throw serviceError(error);
      }
    },

    async coreSessionCursorSave(
      coreEpoch: string,
      sessionId: string,
      revision: number,
    ): Promise<void> {
      const history = await currentStore();
      try {
        history.writeCoreSessionCursor(coreEpoch, sessionId, revision);
      } catch (error) {
        throw serviceError(error);
      }
    },

    async saveExecutionCompletionControl(
      control: DataExecutionCompletionControl,
    ): Promise<void> {
      await withSessionMutation(control.sessionId, async () => {
        const history = await currentStore();
        try {
          history.writeExecutionCompletionControl(control);
        } catch (error) {
          throw serviceError(error);
        }
        const owner = owners.get(control.sessionId);
        if (owner?.applyExecutionCompletionControl(control) === true) {
          setDescriptor(control.sessionId, owner.descriptor());
          return;
        }
        const descriptor = descriptors.get(control.sessionId);
        if (descriptor?.latestExecution?.executionId === control.executionId) {
          setDescriptor(control.sessionId, {
            ...descriptor,
            latestExecution: {
              ...descriptor.latestExecution,
              submittedByCommandId: control.submittedByCommandId,
              processSettlement: control.processSettlement,
            },
          });
        }
      });
    },

    async openSession(
      value: DataSessionOpenInput,
    ): Promise<DataSessionDescriptor> {
      const history = await currentStore();
      if (value.sessionId !== undefined) {
        const existing = owners.get(value.sessionId);
        if (existing !== undefined) return existing.descriptor();
        if (value.persistence !== 'new') {
          return await withSessionMutation(value.sessionId, async () => {
            const opened = owners.get(value.sessionId!);
            if (opened !== undefined) return opened.descriptor();
            await restoreInactiveCursor(value.sessionId!);
            const owner = await DataSessionOwner.open(
              await ownerOpenInput(value),
            );
            const descriptor = owner.descriptor();
            owners.set(descriptor.id, owner);
            setDescriptor(descriptor.id, descriptor);
            return structuredClone(descriptor);
          });
        }
      }
      if (value.persistence === 'continue') {
        const candidate = (await history.listWorker()).sessions.find((entry) =>
          entry.agent === value.agent
        );
        if (candidate !== undefined && owners.has(candidate.id)) {
          return owners.get(candidate.id)!.descriptor();
        }
        if (candidate !== undefined) {
          return await withSessionMutation(candidate.id, async () => {
            const opened = owners.get(candidate.id);
            if (opened !== undefined) return opened.descriptor();
            await restoreInactiveCursor(candidate.id);
            const owner = await DataSessionOwner.open(
              await ownerOpenInput(value),
            );
            const descriptor = owner.descriptor();
            owners.set(descriptor.id, owner);
            setDescriptor(descriptor.id, descriptor);
            return structuredClone(descriptor);
          });
        }
      }
      const owner = await DataSessionOwner.open(await ownerOpenInput(value));
      const descriptor = owner.descriptor();
      owners.set(descriptor.id, owner);
      setDescriptor(descriptor.id, descriptor);
      return structuredClone(descriptor);
    },

    async closeSession(sessionId: string): Promise<void> {
      await waitForSessionMutations(sessionId);
      const owner = owners.get(sessionId);
      if (owner === undefined) {
        await releaseInactiveSession(sessionId);
        return;
      }
      for (const [key, generation] of generations) {
        if (generation.sessionId === sessionId) closeGeneration(key);
      }
      await waitForSessionMutations(sessionId);
      setDescriptor(sessionId, owner.descriptor());
      const watch = conversationWatches.get(sessionId);
      if (watch !== undefined) await drainConversationDelivery(watch);
      await owner.close();
      owners.delete(sessionId);
      await releaseInactiveSession(sessionId, watch?.delivery);
    },

    async sessionDescriptor(sessionId: string): Promise<DataSessionDescriptor> {
      return await withSessionRead(
        sessionId,
        () => cachedOrReadDescriptor(sessionId),
      );
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
      const watch = conversationWatches.get(sessionId);
      if (watch !== undefined) {
        watch.unsubscribeWriter();
        conversationWatches.delete(sessionId);
      }
      try {
        await history.delete(sessionId);
      } catch (error) {
        throw serviceError(error);
      }
      writer!.releaseSession(sessionId);
      descriptors.delete(sessionId);
      descriptorSequences.delete(sessionId);
      descriptorWatches.get(sessionId)?.listeners.clear();
      descriptorWatches.delete(sessionId);
    },

    async conversationSnapshot(
      sessionId: string,
    ): Promise<DataConversationSnapshot> {
      return await withSessionRead(sessionId, async () => {
        const current = await currentWriter();
        try {
          await restoreInactiveCursor(sessionId);
          const watch = conversationWatches.get(sessionId);
          if (watch !== undefined) await drainConversationDelivery(watch);
          if (!owners.has(sessionId)) current.closeSession(sessionId);
          return publicSnapshot(current.snapshotSession(sessionId));
        } catch (error) {
          if (
            error instanceof HistoryStoreError &&
            error.code === 'history_invalid'
          ) {
            throw sessionNotFound();
          }
          throw serviceError(error);
        }
      });
    },

    async conversationPageRead(
      sessionId: string,
      cursor?: number,
      direction: ConversationPageMetadata['direction'] = 'latest',
    ): Promise<EncodedDataReply> {
      return await withSessionRead(sessionId, async () => {
        const current = await currentWriter();
        try {
          await restoreInactiveCursor(sessionId);
          const snapshot = current.snapshotPage(sessionId, cursor, direction);
          return { bytes: snapshot.bytes };
        } catch (error) {
          if (
            error instanceof HistoryStoreError &&
            error.code === 'history_invalid'
          ) {
            throw sessionNotFound();
          }
          throw serviceError(error);
        }
      });
    },

    async conversationContentRead(
      locator: ConversationContentLocator,
      offset: number,
      length: number,
    ): Promise<ConversationContentChunk> {
      return await withSessionRead(locator.sessionId, async () => {
        const history = await currentStore();
        try {
          return history.readConversationContent(locator, offset, length);
        } catch (error) {
          throw serviceError(error);
        }
      });
    },

    async followUpSave(
      coreEpoch: string,
      sessionId: string,
      followUp: import('../../api/contract.ts').FollowUpRecord,
    ): Promise<void> {
      await withSessionMutation(sessionId, async () => {
        const history = await currentStore();
        try {
          history.writeFollowUpReceipt({ coreEpoch, sessionId, followUp });
        } catch (error) {
          throw serviceError(error);
        }
      });
    },

    async followUpRead(
      queueId: string,
    ): Promise<DataFollowUpReceipt | null> {
      const history = await currentStore();
      try {
        return history.readFollowUpReceipt(queueId);
      } catch (error) {
        throw serviceError(error);
      }
    },

    async followUpPageRead(
      sessionId: string,
      cursor?: DataFollowUpCursor,
    ): Promise<DataFollowUpPage> {
      const history = await currentStore();
      try {
        return history.readFollowUpPage(sessionId, cursor);
      } catch (error) {
        throw serviceError(error);
      }
    },

    async watchConversation(
      sessionId: string,
      listener: DataConversationDeltaListener,
    ): Promise<
      {
        readonly snapshot: DataConversationSnapshot;
        readonly unsubscribe: () => void;
      }
    > {
      return await withSessionRead(sessionId, async () => {
        await currentWriter();
        try {
          await restoreInactiveCursor(sessionId);
          const watch = conversationWatches.get(sessionId);
          if (watch !== undefined) await drainConversationDelivery(watch);
          if (!owners.has(sessionId)) writer!.closeSession(sessionId);
          return installConversationWatch(sessionId, listener);
        } catch (error) {
          throw serviceError(error);
        }
      });
    },

    async watchSessionDescriptor(
      sessionId: string,
      listener: DataSessionDescriptorListener,
    ): Promise<{
      readonly snapshot: DataSessionDescriptorUpdate;
      readonly unsubscribe: () => void;
    }> {
      return await withSessionRead(sessionId, async () => {
        try {
          const descriptor = await cachedOrReadDescriptor(sessionId);
          const current = owners.get(sessionId)?.descriptor() ??
            descriptors.get(sessionId) ?? descriptor;
          setDescriptor(sessionId, current);
          let entry = descriptorWatches.get(sessionId);
          if (entry === undefined) {
            entry = { listeners: new Set() };
            descriptorWatches.set(sessionId, entry);
          }
          entry.listeners.add(listener);
          const snapshot: DataSessionDescriptorUpdate = {
            sequence: descriptorSequences.get(sessionId) ?? 0,
            descriptor: structuredClone(current),
          };
          let active = true;
          return {
            snapshot,
            unsubscribe: () => {
              if (!active) return;
              active = false;
              entry!.listeners.delete(listener);
              if (entry!.listeners.size === 0) {
                descriptorWatches.delete(sessionId);
                void releaseInactiveSession(sessionId).catch(() => undefined);
              }
            },
          };
        } catch (error) {
          throw serviceError(error);
        }
      });
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
        readContextTurn: (requestCorrelation, beforeTurn) =>
          withSessionMutation(
            sessionId,
            () => owner.readContextTurn(requestCorrelation, beforeTurn),
          ),
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
            if (
              accepted === 'accepted' &&
              (data.message.kind === 'provider_observation' &&
                  data.message.observation.kind === 'request_start' ||
                data.message.kind === 'context_observation' &&
                  data.message.observation.kind === 'model_request_delta')
            ) setDescriptor(sessionId, owner.descriptor());
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
        checkpoint: (message) => {
          const accepted = owner.installCheckpoint(message);
          if (accepted) setDescriptor(sessionId, owner.descriptor());
          return accepted;
        },
        afterTurn: async (update, sequence) => {
          const accepted = await withSessionMutation(
            sessionId,
            () => owner.installAfterTurnContext(update, sequence),
          );
          if (accepted) setDescriptor(sessionId, owner.descriptor());
          return accepted;
        },
        postSettlementHook: async (
          update: AgentPostSettlementHookUpdate,
          sequence,
        ) => {
          const accepted = await withSessionMutation(
            sessionId,
            () => owner.installPostSettlementHook(update, sequence),
          );
          if (accepted) setDescriptor(sessionId, owner.descriptor());
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
      setDescriptor(sessionId, admitted.descriptor);
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
      setDescriptor(sessionId, admitted.descriptor);
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
      setDescriptor(sessionId, descriptor);
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
      const owner = requireOwner(sessionId);
      const result = await withSessionMutation(
        sessionId,
        () => owner.authorizeCommit(token, decision),
      );
      setDescriptor(sessionId, result.descriptor);
      executionEndpoint(token.executionId)?.releaseExecution(token.executionId);
      pruneUnretainedExecutionGenerations(sessionId, owner);
      return result;
    },

    async settleFailure(
      sessionId: string,
      value: DataSettleFailureRequest,
    ) {
      const owner = requireOwner(sessionId);
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
          owner.settleFailure({
            executionId: value.executionId,
            finalDataSequence: value.finalDataSequence,
            message: failure.message,
          }),
      );
      setDescriptor(sessionId, result.descriptor);
      endpoint.releaseExecution(value.executionId);
      pruneUnretainedExecutionGenerations(sessionId, owner);
      return result;
    },

    async sealGeneration(
      sessionId: string,
      value: DataSealGenerationRequest,
    ) {
      const owner = requireOwner(sessionId);
      const endpoint = executionEndpoint(value.executionId);
      endpoint?.seal();
      const result = await withSessionMutation(
        sessionId,
        () => owner.sealGeneration(value),
      );
      setDescriptor(sessionId, result.descriptor);
      const key = executionGenerations.get(value.executionId);
      if (key !== undefined) closeGeneration(key);
      pruneUnretainedExecutionGenerations(sessionId, owner);
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
      setDescriptor(sessionId, result.descriptor);
      pruneUnretainedExecutionGenerations(sessionId, owner);
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
      setDescriptor(sessionId, result.descriptor);
      return Promise.resolve(result);
    },

    updateTitle(sessionId, title) {
      const result = requireOwner(sessionId).updateTitle(title);
      setDescriptor(sessionId, result.descriptor);
      return Promise.resolve(result);
    },

    async prepareRecall(sessionId, executionIdPrefix) {
      try {
        const owner = requireOwner(sessionId);
        const result = await owner.prepareRecall(executionIdPrefix);
        setDescriptor(sessionId, owner.descriptor());
        return result;
      } catch (error) {
        throw serviceError(error);
      }
    },

    clearPendingRecall(sessionId) {
      const result = requireOwner(sessionId).clearPendingRecall();
      setDescriptor(sessionId, requireOwner(sessionId).descriptor());
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
      for (const key of [...generations.keys()]) closeGeneration(key);
      const sessionIds = new Set([
        ...owners.keys(),
        ...descriptors.keys(),
        ...conversationWatches.keys(),
        ...descriptorWatches.keys(),
        ...sessionMutations.keys(),
        ...sessionReads.keys(),
      ]);
      await Promise.all(
        [...sessionIds].map((sessionId) => waitForSessionMutations(sessionId)),
      );
      await Promise.all(
        [...conversationWatches.values()].map((watch) => drainConversationDelivery(watch)),
      );
      await Promise.all(
        [...sessionIds].map((sessionId) => waitForSessionReads(sessionId)),
      );
      await Promise.all([...owners.values()].map((owner) => owner.close()));
      owners.clear();
      for (const streamId of [...historyStreams.keys()]) {
        closeHistoryStream(streamId);
      }
      for (const watch of conversationWatches.values()) {
        watch.unsubscribeWriter();
      }
      conversationWatches.clear();
      descriptorWatches.clear();
      await Promise.all(
        [...sessionIds].map((sessionId) => releaseInactiveSession(sessionId)),
      );
      closed = true;
      descriptors.clear();
      descriptorSequences.clear();
      inactiveReadCursors.clear();
      inactiveReadCursorBytes = 0;
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
