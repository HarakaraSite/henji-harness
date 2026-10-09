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
  replaySessionConversation,
} from '../../conversation/history_adapter.ts';
import {
  compareConversationPositions,
  type ConversationChange,
  type ConversationEntity,
  type ConversationPageMetadata,
  type ConversationState,
} from '../../conversation/model.ts';

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
  readonly page: ConversationPageMetadata;
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
  readonly executionIds: Set<string>;
  page: ConversationPageMetadata;
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

const samePublishedEntity = (
  left: ConversationEntity,
  right: ConversationEntity,
): boolean => {
  const leftDetails = 'details' in left ? left.details : undefined;
  const rightDetails = 'details' in right ? right.details : undefined;
  const leftEntity = 'details' in left
    ? (({ details: _details, ...entity }) => entity)(left)
    : left;
  const rightEntity = 'details' in right
    ? (({ details: _details, ...entity }) => entity)(right)
    : right;
  if (JSON.stringify(leftEntity) !== JSON.stringify(rightEntity)) return false;
  if (leftDetails === undefined || rightDetails === undefined) {
    return leftDetails === rightDetails;
  }
  return leftDetails.length === rightDetails.length &&
    leftDetails.every((locator, index) => {
      const other = rightDetails[index];
      return other !== undefined && locator.sessionId === other.sessionId &&
        locator.executionId === other.executionId &&
        locator.entityId === other.entityId &&
        locator.field === other.field && locator.digest === other.digest &&
        locator.version === other.version &&
        locator.totalBytes === other.totalBytes &&
        locator.sourceEventOrdinal === other.sourceEventOrdinal &&
        locator.sourceIndex === other.sourceIndex;
    });
};

const snapshotValue = (
  sessionId: string,
  state: ConversationState,
  cut: number,
  storeRevision: number,
  page: ConversationPageMetadata,
) => {
  const entities = Object.fromEntries(state.entities);
  const order = [...state.order.entries()]
    .sort((left, right) =>
      compareConversationPositions(left[1], right[1]) ||
      left[0].localeCompare(right[0])
    )
    .map(([id]) => id);
  return {
    schemaVersion: 3,
    sessionId,
    cut,
    storeRevision,
    entities,
    order,
    page,
  } as const;
};

const stateChanges = (
  previous: ConversationState,
  next: ConversationState,
): readonly ConversationChange[] => {
  const changes: ConversationChange[] = [];
  for (const id of previous.order.keys()) {
    if (!next.order.has(id)) {
      changes.push({ kind: 'order', action: 'remove', id }, {
        kind: 'remove',
        id,
      });
    }
  }
  for (const [id, entity] of next.entities) {
    const previousEntity = previous.entities.get(id);
    if (
      previousEntity === undefined ||
      !samePublishedEntity(previousEntity, entity)
    ) {
      changes.push({ kind: 'upsert', entity });
    }
    const oldPosition = previous.order.get(id);
    const nextPosition = next.order.get(id);
    if (
      nextPosition !== undefined &&
      (oldPosition === undefined ||
        compareConversationPositions(oldPosition, nextPosition) !== 0)
    ) {
      if (oldPosition !== undefined) {
        changes.push({ kind: 'order', action: 'remove', id });
      }
      changes.push({
        kind: 'order',
        action: 'insert',
        id,
        position: nextPosition,
      });
    }
  }
  return changes;
};

/**
 * Data-local owner for saved ConversationState. It applies only COMMIT results and never
 * reconstructs a Session during an append or terminal write.
 */
export class ConversationWriter {
  readonly #sessions = new Map<string, SessionSaveCursor>();
  readonly #executionSessions = new Map<string, string>();
  readonly #sessionExecutions = new Map<string, Set<string>>();
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

    this.#rememberExecution(input.executionId, input.sessionCorrelation);
    cursor.storeRevision = Math.max(
      cursor.storeRevision,
      input.baseStateRevision,
    );
    const changes = cursor.view === undefined
      ? []
      : this.#refreshLatestPage(input.sessionCorrelation, cursor);
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
      if (
        view === undefined || !view.executionIds.has(result.event.executionId)
      ) continue;
      const changes = applyHistoryAppendResults(
        view.state,
        view.normalizer,
        [result],
        this.#sessions.get(sessionId)!.cut + 1,
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
    const changes = cursor.view === undefined ||
        !cursor.view.executionIds.has(input.event.executionId)
      ? []
      : applyHistoryAppendResults(
        cursor.view.state,
        cursor.view.normalizer,
        [result],
        cursor.cut + 1,
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
      deltas: [this.#publish(
        sessionId,
        cursor,
        cursor.view === undefined ? [] : this.#refreshLatestPage(sessionId, cursor),
      )],
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
      deltas: [this.#publish(
        sessionId,
        cursor,
        cursor.view === undefined ? [] : this.#refreshLatestPage(sessionId, cursor),
      )],
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
      deltas: [this.#publish(
        sessionId,
        cursor,
        cursor.view === undefined ? [] : this.#refreshLatestPage(sessionId, cursor),
      )],
    };
  }

  /** Register the lifetime owner without materializing its conversation view. */
  openSession(sessionId: string): void {
    this.#assertOpen();
    this.#ensureCursor(sessionId);
    this.#closedSessions.delete(sessionId);
  }

  sessionCursorState(sessionId: string):
    | Readonly<{
      cut: number;
      storeRevision: number;
    }>
    | undefined {
    const cursor = this.#sessions.get(sessionId);
    return cursor === undefined
      ? undefined
      : { cut: cursor.cut, storeRevision: cursor.storeRevision };
  }

  /** Restore the last acknowledged Data-local cursor before a detached Session is read. */
  restoreSessionCursor(
    sessionId: string,
    cut: number,
    storeRevision: number,
  ): void {
    this.#assertOpen();
    if (
      sessionId.length === 0 || !Number.isSafeInteger(cut) || cut < 0 ||
      !Number.isSafeInteger(storeRevision) || storeRevision < 0
    ) throw new Error('invalid conversation cursor');
    const cursor = this.#ensureCursor(sessionId);
    cursor.cut = Math.max(cursor.cut, cut);
    cursor.storeRevision = Math.max(cursor.storeRevision, storeRevision);
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

  snapshotPage(
    sessionId: string,
    cursorValue?: number,
    direction: ConversationPageMetadata['direction'] = 'latest',
  ): ConversationWriterSnapshot {
    this.#assertOpen();
    const cursor = this.#ensureCursor(sessionId);
    const loaded = this.#loadPage(
      sessionId,
      cursor.cut,
      cursorValue,
      direction,
    );
    cursor.storeRevision = Math.max(cursor.storeRevision, loaded.storeRevision);
    return this.#snapshot(sessionId, cursor, loaded.view);
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
    for (const executionId of this.#sessionExecutions.get(sessionId) ?? []) {
      this.#executionSessions.delete(executionId);
    }
    this.#sessionExecutions.delete(sessionId);
  }

  /** Drop an execution's in-memory Session locator after its live consumer releases it. */
  releaseExecution(executionId: string): void {
    const sessionId = this.#executionSessions.get(executionId);
    if (sessionId === undefined) return;
    this.#executionSessions.delete(executionId);
    const executions = this.#sessionExecutions.get(sessionId);
    executions?.delete(executionId);
    if (executions?.size === 0) this.#sessionExecutions.delete(sessionId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.#sessions.values()) {
      session.view?.listeners.clear();
    }
    this.#sessions.clear();
    this.#closedSessions.clear();
    this.#executionSessions.clear();
    this.#sessionExecutions.clear();
    if (this.options.ownsStore === true) this.store.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('conversation writer closed');
  }

  #loadSession(sessionId: string, cut: number): LoadedSessionConversation {
    return this.#loadPage(sessionId, cut);
  }

  #loadPage(
    sessionId: string,
    cut: number,
    cursor?: number,
    direction: ConversationPageMetadata['direction'] = 'latest',
  ): LoadedSessionConversation {
    const page = this.store.readSessionConversationPageFacts(
      sessionId,
      cursor,
      direction,
    );
    let storeRevision = 0;
    for (const item of page.executions) {
      storeRevision = Math.max(
        storeRevision,
        item.execution.committedRevision ?? item.execution.baseRevision,
      );
    }
    const replay = replaySessionConversation(sessionId, page.executions, cut);
    return {
      view: {
        state: replay.state,
        normalizer: replay.normalizer,
        listeners: new Set(),
        executionIds: new Set(
          page.executions.map((item) => item.execution.executionId),
        ),
        page: page.page,
      },
      storeRevision,
    };
  }

  #refreshLatestPage(
    sessionId: string,
    cursor: SessionSaveCursor,
  ): readonly ConversationChange[] {
    const previous = cursor.view;
    if (previous === undefined) return [];
    const loaded = this.#loadPage(sessionId, cursor.cut + 1);
    for (const listener of previous.listeners) {
      loaded.view.listeners.add(listener);
    }
    cursor.view = loaded.view;
    cursor.storeRevision = Math.max(cursor.storeRevision, loaded.storeRevision);
    return stateChanges(previous.state, loaded.view.state);
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
    const loaded = this.#loadSession(sessionId, cursor.cut);
    cursor.storeRevision = Math.max(cursor.storeRevision, loaded.storeRevision);
    cursor.view = loaded.view;
    return loaded.view;
  }

  #sessionIdForExecution(executionId: string): string {
    const known = this.#executionSessions.get(executionId);
    if (known !== undefined) return known;
    // Historical access uses SQLite without repopulating the live execution index.
    return this.store.readExecutionMetadata(executionId).sessionCorrelation;
  }

  #rememberExecution(executionId: string, sessionId: string): void {
    const previous = this.#executionSessions.get(executionId);
    if (previous === sessionId) return;
    if (previous !== undefined) {
      const previousExecutions = this.#sessionExecutions.get(previous);
      previousExecutions?.delete(executionId);
      if (previousExecutions?.size === 0) {
        this.#sessionExecutions.delete(previous);
      }
    }
    this.#executionSessions.set(executionId, sessionId);
    let executions = this.#sessionExecutions.get(sessionId);
    if (executions === undefined) {
      executions = new Set();
      this.#sessionExecutions.set(sessionId, executions);
    }
    executions.add(executionId);
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
    const page = view.page;
    return {
      sessionId,
      cut: cursor.cut,
      storeRevision: cursor.storeRevision,
      page,
      bytes: encode(
        snapshotValue(
          sessionId,
          view.state,
          cursor.cut,
          cursor.storeRevision,
          page,
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
          schemaVersion: 3,
          kind: 'delta',
          sessionId,
          cut: cursor.cut,
          storeRevision: cursor.storeRevision,
          changes: coalesceEntityUpdates(changes),
          page: view.page,
        }),
      };
      for (const listener of view.listeners) listener(delta);
    }
    return change;
  }
}
