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
} from '../../conversation/model.ts';
import { applyObservation, conversationJson } from '../../conversation/normalizer.ts';

interface ConversationWriterChange {
  readonly sessionId: string;
  /** Data-local save cut. Core assigns the public stream cursor. */
  readonly cut: number;
  readonly storeRevision: number;
}

export interface ConversationWriterDelta extends ConversationWriterChange {
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
  readonly deltas: readonly ConversationWriterChange[];
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
  readonly listeners: Set<ConversationWriterListener>;
  nextExecutionOrder: number;
}

interface SessionSaveCursor {
  cut: number;
  storeRevision: number;
  view?: SessionConversation;
}

interface LoadedSessionConversation {
  readonly view: SessionConversation;
  readonly storeRevision: number;
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
  const entities = Object.fromEntries(state.entities);
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
    entities,
    order,
  } as const;
};

const executionEntity = (
  session: SessionConversation,
  input: BeginExecutionInput,
): readonly ConversationChange[] => {
  const executionOrder = session.nextExecutionOrder++;
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
  readonly #sessions = new Map<string, SessionSaveCursor>();
  readonly #executionSessions = new Map<string, string>();
  readonly #closedSessions = new Set<string>();
  #closed = false;

  constructor(
    readonly store: SqliteHistoryStore,
    private readonly options: Readonly<{ ownsStore?: boolean }> = {},
  ) {}

  async beginExecution(
    input: BeginExecutionInput,
  ): Promise<ConversationWriterWriteResult<void>> {
    this.#assertOpen();
    const cursor = this.#ensureCursor(input.sessionCorrelation);
    await this.store.beginExecution(input);

    this.#executionSessions.set(input.executionId, input.sessionCorrelation);
    cursor.storeRevision = Math.max(cursor.storeRevision, input.baseStateRevision);
    const changes = cursor.view === undefined ? [] : executionEntity(cursor.view, input);
    const delta = this.#publish(
      input.sessionCorrelation,
      cursor,
      changes,
    );
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
      this.#ensureCursor(sessionId);
    }

    const results = this.store.appendExecutionEventsWithSemanticIds(inputs);
    const changesBySession = new Map<string, ConversationChange[]>();
    for (const result of results) {
      const sessionId = sessionsByExecution.get(result.event.executionId);
      if (sessionId === undefined) continue;
      const view = this.#sessions.get(sessionId)?.view;
      if (view === undefined) continue;
      const changes = applyHistoryAppendResults(
        view.state,
        view.normalizer,
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
        this.#ensureCursor(sessionId),
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
    const cursor = this.#ensureCursor(sessionId);
    const result = this.store.appendPostSettlementSemanticEvent(input);
    const changes = cursor.view === undefined ? [] : applyHistoryAppendResults(
      cursor.view.state,
      cursor.view.normalizer,
      [result],
    );
    return {
      result,
      deltas: [this.#publish(sessionId, cursor, changes)],
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
    const cursor = this.#ensureCursor(sessionId);
    const result = this.store.commitCanonicalTurn(input);
    const delta = result.commitDelta;
    if (delta === undefined) return { result, deltas: [] };
    cursor.storeRevision = Math.max(
      cursor.storeRevision,
      delta.committedRevision ?? 0,
    );
    return {
      result,
      deltas: [
        this.#publish(
          sessionId,
          cursor,
          cursor.view === undefined ? [] : applyHistoryCommitDelta(
            cursor.view.state,
            cursor.view.normalizer,
            delta,
          ),
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
    const cursor = this.#ensureCursor(sessionId);
    const result = this.store.settleNonCanonicalExecution(input);
    const delta = result.commitDelta;
    if (delta === undefined) return { result, deltas: [] };
    cursor.storeRevision = Math.max(
      cursor.storeRevision,
      delta.committedRevision ?? 0,
    );
    return {
      result,
      deltas: [
        this.#publish(
          sessionId,
          cursor,
          cursor.view === undefined ? [] : applyHistoryCommitDelta(
            cursor.view.state,
            cursor.view.normalizer,
            delta,
          ),
        ),
      ],
    };
  }

  reconcileExecution(
    input: ReconcileExecutionInput,
  ): ConversationWriterWriteResult<HistoryCommitDelta | undefined> {
    this.#assertOpen();
    const sessionId = this.#sessionIdForExecution(input.executionId);
    const cursor = this.#ensureCursor(sessionId);
    const result = this.store.reconcileExecution(input);
    if (result === undefined) return { result, deltas: [] };
    cursor.storeRevision = Math.max(
      cursor.storeRevision,
      result.committedRevision ?? 0,
    );
    return {
      result,
      deltas: [
        this.#publish(
          sessionId,
          cursor,
          cursor.view === undefined ? [] : applyHistoryCommitDelta(
            cursor.view.state,
            cursor.view.normalizer,
            result,
          ),
        ),
      ],
    };
  }

  /** Register the lifetime owner without materializing its conversation view. */
  openSession(sessionId: string): void {
    this.#assertOpen();
    this.#ensureCursor(sessionId);
    this.#closedSessions.delete(sessionId);
  }

  snapshotSession(sessionId: string): ConversationWriterSnapshot {
    this.#assertOpen();
    const cursor = this.#ensureCursor(sessionId);
    const view = this.#ensureView(sessionId, cursor);
    const snapshot = this.#snapshot(sessionId, cursor, view);
    if (this.#closedSessions.has(sessionId) && view.listeners.size === 0) {
      cursor.view = undefined;
    }
    return snapshot;
  }

  /** Snapshot creation and watch registration run synchronously at the same cut. */
  watchSession(
    sessionId: string,
    listener: ConversationWriterListener,
  ): ConversationWriterWatch {
    this.#assertOpen();
    const cursor = this.#ensureCursor(sessionId);
    const view = this.#ensureView(sessionId, cursor);
    const snapshot = this.#snapshot(sessionId, cursor, view);
    view.listeners.add(listener);
    let active = true;
    return {
      snapshot,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        view.listeners.delete(listener);
        if (this.#closedSessions.has(sessionId) && view.listeners.size === 0) {
          cursor.view = undefined;
        }
      },
    };
  }

  closeSession(sessionId: string): void {
    this.#assertOpen();
    const cursor = this.#ensureCursor(sessionId);
    this.#closedSessions.add(sessionId);
    if (cursor.view?.listeners.size === 0) cursor.view = undefined;
  }

  releaseSession(sessionId: string): void {
    const cursor = this.#sessions.get(sessionId);
    cursor?.view?.listeners.clear();
    this.#sessions.delete(sessionId);
    this.#closedSessions.delete(sessionId);
    for (const [executionId, executionSessionId] of this.#executionSessions) {
      if (executionSessionId === sessionId) {
        this.#executionSessions.delete(executionId);
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.#sessions.values()) session.view?.listeners.clear();
    this.#sessions.clear();
    this.#closedSessions.clear();
    this.#executionSessions.clear();
    if (this.options.ownsStore === true) this.store.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('conversation writer closed');
  }

  #loadSession(sessionId: string): LoadedSessionConversation {
    const facts = this.store.readSessionConversationFacts(sessionId);
    let storeRevision = 0;
    let nextExecutionOrder = 0;
    function* trackedFacts() {
      for (const item of facts) {
        nextExecutionOrder += 1;
        storeRevision = Math.max(
          storeRevision,
          item.execution.committedRevision ?? item.execution.baseRevision,
        );
        yield item;
      }
    }
    const replay = replaySessionConversation(sessionId, trackedFacts());
    return {
      view: {
        state: replay.state,
        normalizer: replay.normalizer,
        listeners: new Set(),
        nextExecutionOrder,
      },
      storeRevision,
    };
  }

  #ensureCursor(sessionId: string): SessionSaveCursor {
    let current = this.#sessions.get(sessionId);
    if (current === undefined) {
      current = { cut: 0, storeRevision: 0 };
      this.#sessions.set(sessionId, current);
    }
    return current;
  }

  #ensureView(
    sessionId: string,
    cursor: SessionSaveCursor,
  ): SessionConversation {
    if (cursor.view !== undefined) return cursor.view;
    const loaded = this.#loadSession(sessionId);
    cursor.storeRevision = Math.max(cursor.storeRevision, loaded.storeRevision);
    cursor.view = loaded.view;
    return loaded.view;
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
    cursor: SessionSaveCursor,
    view: SessionConversation,
  ): ConversationWriterSnapshot {
    return {
      sessionId,
      cut: cursor.cut,
      storeRevision: cursor.storeRevision,
      bytes: encode(
        snapshotValue(
          sessionId,
          view.state,
          cursor.cut,
          cursor.storeRevision,
        ),
      ),
    };
  }

  #publish(
    sessionId: string,
    cursor: SessionSaveCursor,
    changes: readonly ConversationChange[],
  ): ConversationWriterChange {
    cursor.cut += 1;
    const change: ConversationWriterChange = {
      sessionId,
      cut: cursor.cut,
      storeRevision: cursor.storeRevision,
    };
    const view = cursor.view;
    if (view !== undefined && view.listeners.size > 0) {
      const delta: ConversationWriterDelta = {
        ...change,
        bytes: encode({
          schemaVersion: 2,
          kind: 'delta',
          sessionId,
          cut: cursor.cut,
          storeRevision: cursor.storeRevision,
          changes: coalesceEntityUpdates(changes),
        }),
      };
      for (const listener of view.listeners) listener(delta);
    }
    return change;
  }
}
