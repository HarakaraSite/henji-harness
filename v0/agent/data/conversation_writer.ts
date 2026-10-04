import type {
  BeginExecutionInput,
  CanonicalTurnCommitInput,
  ExecutionControlEventInput,
  ExecutionEventInput,
  HistoryAppendResult,
  HistoryCaptureResult,
  HistoryCommitDelta,
  HistoryPostSettlementSemanticEventInput,
  NonCanonicalExecutionInput,
  ReconcileExecutionInput,
  StoredExecutionEvent,
} from '../history/history_store_contract.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import {
  applyHistoryAppendResults,
  applyHistoryCommitDelta,
  replaySessionConversation,
} from '../../conversation/history_adapter.ts';
import {
  compareConversationPositions,
  type ConversationChange,
  type ConversationState,
  orderedConversationEntities,
} from '../../conversation/model.ts';
import { applyObservation, conversationJson } from '../../conversation/normalizer.ts';

export interface ConversationWriterDelta {
  readonly sessionId: string;
  /** Data-local save cut. Core assigns the public stream cursor. */
  readonly cut: number;
  readonly storeRevision: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface ConversationWriterSnapshot {
  readonly sessionId: string;
  readonly cut: number;
  readonly storeRevision: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

interface ConversationWriterWriteResult<T> {
  readonly result: T;
  readonly deltas: readonly ConversationWriterDelta[];
}

type ConversationWriterListener = (
  delta: ConversationWriterDelta,
) => void;

export interface ConversationWriterWatch {
  readonly snapshot: ConversationWriterSnapshot;
  readonly unsubscribe: () => void;
}

interface SessionConversation {
  readonly state: ConversationState;
  readonly normalizer: ReturnType<
    typeof replaySessionConversation
  >['normalizer'];
  readonly executionOrders: Map<string, number>;
  readonly listeners: Set<ConversationWriterListener>;
  cut: number;
  storeRevision: number;
  nextExecutionOrder: number;
}

const encode = (value: unknown): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(JSON.stringify(value));

const coalesceEntityUpdates = (
  changes: readonly ConversationChange[],
): readonly ConversationChange[] => {
  const result: ConversationChange[] = [];
  const upsertIndex = new Map<string, number>();
  for (const change of changes) {
    if (change.kind === 'upsert') {
      const priorIndex = upsertIndex.get(change.entity.id);
      if (priorIndex === undefined) {
        upsertIndex.set(change.entity.id, result.length);
        result.push(change);
      } else {
        result[priorIndex] = change;
      }
      continue;
    }
    result.push(change);
    if (
      change.kind === 'remove' ||
      (change.kind === 'order' && change.action === 'remove')
    ) {
      upsertIndex.delete(change.id);
    }
  }
  return result;
};

const snapshotValue = (
  sessionId: string,
  state: ConversationState,
  cut: number,
  storeRevision: number,
) => {
  const entities = orderedConversationEntities(state);
  const order = [...state.order.entries()]
    .sort((left, right) =>
      compareConversationPositions(left[1], right[1]) ||
      left[0].localeCompare(right[0])
    )
    .map(([id]) => id);
  return {
    schemaVersion: 2,
    sessionId,
    cut,
    storeRevision,
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    order,
  } as const;
};

const executionEntity = (
  session: SessionConversation,
  input: BeginExecutionInput,
): readonly ConversationChange[] => {
  const executionOrder = session.nextExecutionOrder++;
  session.executionOrders.set(input.executionId, executionOrder);
  return applyObservation(session.state, session.normalizer, {
    kind: 'execution',
    execution: {
      executionId: input.executionId,
      taskId: input.taskId,
      task: input.task,
      sessionId: input.sessionCorrelation,
      ...(input.canonicalSessionId === undefined
        ? {}
        : { canonicalSessionId: input.canonicalSessionId }),
      ...(input.parentExecutionId === undefined
        ? {}
        : { parentExecutionId: input.parentExecutionId }),
      ...(input.spawnCallId === undefined ? {} : { spawnCallId: input.spawnCallId }),
      turn: input.turn,
      createdAt: input.createdAt,
      lifecycle: 'active',
      outcome: 'unknown',
      adoption: 'non_canonical',
      baseRevision: input.baseStateRevision,
      agent: input.agent,
      model: conversationJson(input.model),
    },
    executionOrder,
  });
};

/**
 * Data-local owner for saved ConversationState. It applies only COMMIT results and never
 * reconstructs a Session during an append or terminal write.
 */
export class ConversationWriter {
  readonly #sessions = new Map<string, SessionConversation>();
  readonly #executionSessions = new Map<string, string>();
  #closed = false;

  constructor(
    readonly store: SqliteHistoryStore,
    private readonly options: Readonly<{ ownsStore?: boolean }> = {},
  ) {}

  async beginExecution(
    input: BeginExecutionInput,
  ): Promise<ConversationWriterWriteResult<void>> {
    this.#assertOpen();
    let session = this.#sessions.get(input.sessionCorrelation);
    if (session === undefined) {
      session = input.sessionRecord !== undefined || input.sessionMode === 'no_session'
        ? this.#emptySession(input.sessionCorrelation)
        : this.#loadSession(input.sessionCorrelation);
      // Read/watch may run while durable admission awaits a lock. Keep one shared instance.
      this.#sessions.set(input.sessionCorrelation, session);
    }
    await this.store.beginExecution(input);

    this.#executionSessions.set(input.executionId, input.sessionCorrelation);
    const changes = executionEntity(session, input);
    session.storeRevision = Math.max(
      session.storeRevision,
      input.baseStateRevision,
    );
    const delta = this.#publish(input.sessionCorrelation, session, changes);
    return { result: undefined, deltas: [delta] };
  }

  appendExecutionEvents(
    inputs: readonly ExecutionEventInput[],
  ): ConversationWriterWriteResult<readonly HistoryAppendResult[]> {
    this.#assertOpen();
    if (inputs.length === 0) return { result: [], deltas: [] };

    const sessionsByExecution = new Map<string, string>();
    for (const input of inputs) {
      if (sessionsByExecution.has(input.executionId)) continue;
      const sessionId = this.#sessionIdForExecution(input.executionId);
      sessionsByExecution.set(input.executionId, sessionId);
      this.#ensureSession(sessionId);
    }

    const results = this.store.appendExecutionEventsWithSemanticIds(inputs);
    const changesBySession = new Map<string, ConversationChange[]>();
    for (const result of results) {
      const sessionId = sessionsByExecution.get(result.event.executionId);
      if (sessionId === undefined) continue;
      const session = this.#sessions.get(sessionId)!;
      const changes = applyHistoryAppendResults(
        session.state,
        session.normalizer,
        [result],
      );
      const group = changesBySession.get(sessionId) ?? [];
      group.push(...changes);
      changesBySession.set(sessionId, group);
    }

    const touched = new Set(
      results.map((result) => sessionsByExecution.get(result.event.executionId))
        .filter((
          sessionId,
        ): sessionId is string => sessionId !== undefined),
    );
    const deltas = [...touched].map((sessionId) =>
      this.#publish(
        sessionId,
        this.#sessions.get(sessionId)!,
        changesBySession.get(sessionId) ?? [],
      )
    );
    return { result: results, deltas };
  }

  appendPostSettlementSemanticEvent(
    input: HistoryPostSettlementSemanticEventInput,
  ): ConversationWriterWriteResult<HistoryAppendResult> {
    this.#assertOpen();
    const sessionId = this.#sessionIdForExecution(input.event.executionId);
    const session = this.#ensureSession(sessionId);
    const result = this.store.appendPostSettlementSemanticEvent(input);
    const changes = applyHistoryAppendResults(
      session.state,
      session.normalizer,
      [result],
    );
    return {
      result,
      deltas: [this.#publish(sessionId, session, changes)],
    };
  }

  appendExecutionControlEvents(
    inputs: readonly ExecutionControlEventInput[],
  ): readonly StoredExecutionEvent[] {
    this.#assertOpen();
    return this.store.appendExecutionControlEvents(inputs);
  }

  commitCanonicalTurn(
    input: CanonicalTurnCommitInput,
  ): ConversationWriterWriteResult<HistoryCaptureResult> {
    this.#assertOpen();
    const sessionId = this.#sessionForTerminal(
      input.executionId,
      input.sessionCorrelation,
    );
    const session = this.#ensureSession(sessionId);
    const result = this.store.commitCanonicalTurn(input);
    const delta = result.commitDelta;
    if (delta === undefined) return { result, deltas: [] };
    session.storeRevision = Math.max(
      session.storeRevision,
      delta.committedRevision ?? 0,
    );
    return {
      result,
      deltas: [
        this.#publish(
          sessionId,
          session,
          applyHistoryCommitDelta(session.state, session.normalizer, delta),
        ),
      ],
    };
  }

  settleNonCanonicalExecution(
    input: NonCanonicalExecutionInput,
  ): ConversationWriterWriteResult<HistoryCaptureResult> {
    this.#assertOpen();
    const sessionId = this.#sessionForTerminal(
      input.executionId,
      input.sessionCorrelation,
    );
    const session = this.#ensureSession(sessionId);
    const result = this.store.settleNonCanonicalExecution(input);
    const delta = result.commitDelta;
    if (delta === undefined) return { result, deltas: [] };
    return {
      result,
      deltas: [
        this.#publish(
          sessionId,
          session,
          applyHistoryCommitDelta(session.state, session.normalizer, delta),
        ),
      ],
    };
  }

  reconcileExecution(
    input: ReconcileExecutionInput,
  ): ConversationWriterWriteResult<HistoryCommitDelta | undefined> {
    this.#assertOpen();
    const sessionId = this.#sessionIdForExecution(input.executionId);
    const session = this.#ensureSession(sessionId);
    const result = this.store.reconcileExecution(input);
    if (result === undefined) return { result, deltas: [] };
    return {
      result,
      deltas: [
        this.#publish(
          sessionId,
          session,
          applyHistoryCommitDelta(session.state, session.normalizer, result),
        ),
      ],
    };
  }

  /** Register a new, not-yet-persisted Session at cut zero without reading nonexistent rows. */
  initializeEmptySession(sessionId: string): ConversationWriterSnapshot {
    this.#assertOpen();
    if (!this.#sessions.has(sessionId)) {
      this.#sessions.set(sessionId, this.#emptySession(sessionId));
    }
    return this.#snapshot(sessionId, this.#sessions.get(sessionId)!);
  }

  snapshotSession(sessionId: string): ConversationWriterSnapshot {
    this.#assertOpen();
    const session = this.#ensureSession(sessionId);
    return this.#snapshot(sessionId, session);
  }

  /** Snapshot creation and watch registration run synchronously at the same cut. */
  watchSession(
    sessionId: string,
    listener: ConversationWriterListener,
  ): ConversationWriterWatch {
    this.#assertOpen();
    const session = this.#ensureSession(sessionId);
    const snapshot = this.#snapshot(sessionId, session);
    session.listeners.add(listener);
    let active = true;
    return {
      snapshot,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        session.listeners.delete(listener);
      },
    };
  }

  releaseSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    session.listeners.clear();
    this.#sessions.delete(sessionId);
    for (const [executionId, executionSessionId] of this.#executionSessions) {
      if (executionSessionId === sessionId) {
        this.#executionSessions.delete(executionId);
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.#sessions.values()) session.listeners.clear();
    this.#sessions.clear();
    this.#executionSessions.clear();
    if (this.options.ownsStore === true) this.store.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('conversation writer closed');
  }

  #emptySession(sessionId: string): SessionConversation {
    const replay = replaySessionConversation(sessionId, []);
    return {
      state: replay.state,
      normalizer: replay.normalizer,
      executionOrders: new Map(),
      listeners: new Set(),
      cut: 0,
      storeRevision: 0,
      nextExecutionOrder: 0,
    };
  }

  #loadSession(sessionId: string): SessionConversation {
    const facts = this.store.readSessionConversationFacts(sessionId);
    const replay = replaySessionConversation(sessionId, facts);
    const executionOrders = new Map<string, number>();
    let storeRevision = 0;
    for (const [index, item] of facts.entries()) {
      executionOrders.set(item.execution.executionId, index);
      storeRevision = Math.max(
        storeRevision,
        item.execution.committedRevision ?? item.execution.baseRevision,
      );
    }
    return {
      state: replay.state,
      normalizer: replay.normalizer,
      executionOrders,
      listeners: new Set(),
      cut: 0,
      storeRevision,
      nextExecutionOrder: facts.length,
    };
  }

  #ensureSession(sessionId: string): SessionConversation {
    const current = this.#sessions.get(sessionId);
    if (current !== undefined) return current;
    const loaded = this.#loadSession(sessionId);
    this.#sessions.set(sessionId, loaded);
    for (const executionId of loaded.executionOrders.keys()) {
      this.#executionSessions.set(executionId, sessionId);
    }
    return loaded;
  }

  #sessionIdForExecution(executionId: string): string {
    const known = this.#executionSessions.get(executionId);
    if (known !== undefined) return known;
    const sessionId = this.store.readExecutionMetadata(executionId).sessionCorrelation;
    this.#executionSessions.set(executionId, sessionId);
    return sessionId;
  }

  #sessionForTerminal(executionId: string, expectedSessionId: string): string {
    const sessionId = this.#sessionIdForExecution(executionId);
    if (sessionId !== expectedSessionId) {
      throw new Error('execution session mismatch');
    }
    return sessionId;
  }

  #snapshot(
    sessionId: string,
    session: SessionConversation,
  ): ConversationWriterSnapshot {
    return {
      sessionId,
      cut: session.cut,
      storeRevision: session.storeRevision,
      bytes: encode(
        snapshotValue(
          sessionId,
          session.state,
          session.cut,
          session.storeRevision,
        ),
      ),
    };
  }

  #publish(
    sessionId: string,
    session: SessionConversation,
    changes: readonly ConversationChange[],
  ): ConversationWriterDelta {
    session.cut += 1;
    const delta: ConversationWriterDelta = {
      sessionId,
      cut: session.cut,
      storeRevision: session.storeRevision,
      bytes: encode({
        schemaVersion: 2,
        kind: 'delta',
        sessionId,
        cut: session.cut,
        storeRevision: session.storeRevision,
        changes: coalesceEntityUpdates(changes),
      }),
    };
    for (const listener of session.listeners) listener(delta);
    return delta;
  }
}
