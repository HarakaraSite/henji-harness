import type { SessionSnapshot } from '../api/contract.ts';
import type { SessionClientState } from '../api/reducer.ts';
import { freezeUiLogEntry, presentationFailureReason, type UiLogEntry } from './state.ts';
import { KeyedConversationStore, type KeyedNoticePlacement } from './keyed_conversation_store.ts';

interface RetainedNotice {
  entry: UiLogEntry;
  anchor?: string;
  afterExecutionId?: string;
  steeringText?: string;
}

interface SessionNotices {
  readonly notices: Map<string, RetainedNotice>;
  readonly dirtyNoticeIds: Set<string>;
  semanticIds: readonly string[];
  readonly appliedSteeringByEntityId: Map<string, string>;
  readonly appliedSteeringEntitiesByKey: Map<string, Set<string>>;
  readonly steeringNoticeIdsByKey: Map<string, Set<string>>;
  pending: SessionSnapshot['pending'] | undefined;
}

interface NoticeSyncResult {
  readonly changed: boolean;
  readonly changedIds: ReadonlySet<string>;
  readonly structureChanged: boolean;
}

const steeringKey = (executionId: string, text: string): string =>
  JSON.stringify([executionId, text]);

const placementOf = (notice: RetainedNotice): KeyedNoticePlacement => ({
  entry: notice.entry,
  ...(notice.anchor === undefined ? {} : { anchor: notice.anchor }),
  ...(notice.afterExecutionId === undefined ? {} : {
    afterExecutionId: notice.afterExecutionId,
  }),
});

/** UI-local receipts keyed by session and source identity; semantic rows stay in Data order. */
export class RemoteSystemNotices {
  private readonly sessions = new Map<string, SessionNotices>();

  retain(
    sessionId: string,
    identity: string,
    text: string,
    failureWord?: string,
    executionId?: string,
  ): void {
    const state = this.forSession(sessionId);
    const id = `system:${sessionId}:${identity}`;
    const previous = state.notices.get(id);
    if (
      previous?.entry.text === text && previous.entry.failureWord === failureWord &&
      (executionId === undefined || previous.afterExecutionId === executionId)
    ) return;
    const anchor = previous === undefined
      ? executionId === undefined ? state.semanticIds.at(-1) : undefined
      : previous.anchor;
    const retained: RetainedNotice = {
      ...previous,
      ...(anchor === undefined ? {} : { anchor }),
      ...(executionId === undefined ? {} : { afterExecutionId: executionId }),
      entry: freezeUiLogEntry({
        id,
        kind: 'system',
        label: 'system>',
        text,
        ...(failureWord === undefined ? {} : { failureWord }),
        ...(executionId === undefined ? {} : { executionId }),
        revision: (previous?.entry.revision ?? 0) + 1,
        live: false,
      }),
    };
    state.notices.set(id, retained);
    this.reindexSteeringNotice(state, id, previous, retained);
    state.dirtyNoticeIds.add(id);
  }

  /** Apply only changed execution entities and changed Core pending state. */
  sync(
    client: SessionClientState,
    store: KeyedConversationStore,
    options: Readonly<{ reset?: boolean; structureChanged?: boolean }> = {},
  ): NoticeSyncResult {
    const snapshot = client.snapshot;
    const sessionId = snapshot.session.id;
    const state = this.forSession(sessionId);
    const configuration = snapshot.runtime.effectiveConfig?.configuration;
    if (
      configuration !== null && typeof configuration === 'object' && !Array.isArray(configuration)
    ) {
      const facts = configuration as { [key: string]: unknown };
      if (Array.isArray(facts.rejections)) {
        for (const value of facts.rejections) {
          if (value === null || typeof value !== 'object') continue;
          const rejection = value as Record<string, unknown>;
          const detail = `${String(rejection.target ?? 'configuration')} ${
            String(rejection.name ?? '')
          }${typeof rejection.file === 'string' ? ` (${rejection.file})` : ''}: ${
            String(rejection.reason ?? 'rejected')
          }`;
          this.retain(
            sessionId,
            `configuration:${String(facts.configurationId ?? facts.status)}:${detail}`,
            `CONFIGURATION REJECTED · ${detail}`,
            'REJECTED',
          );
        }
      }
    }
    const semanticIds = store.semanticIds();
    const pendingChanged = options.reset === true || state.pending !== snapshot.pending;
    if (options.reset === true || options.structureChanged === true) {
      this.rebaseAnchors(state, semanticIds);
      state.semanticIds = semanticIds;
    }

    if (options.reset === true) {
      state.appliedSteeringByEntityId.clear();
      state.appliedSteeringEntitiesByKey.clear();
      for (const entityId of snapshot.conversation.order) {
        this.addAppliedSteering(
          state,
          entityId,
          snapshot.conversation.entities[entityId],
        );
      }
    }

    for (const entityId of client.dirtyEntityIds) {
      const entity = snapshot.conversation.entities[entityId];
      if (entity?.kind === 'execution') this.retainExecution(sessionId, entity.execution);
      if (options.reset !== true) {
        this.removeAppliedSteering(state, entityId);
        this.addAppliedSteering(state, entityId, entity);
      }
      if (
        entity?.kind === 'message' && entity.role === 'user' && entity.position.requestOrder >= 0
      ) {
        const noticeIds = state.steeringNoticeIdsByKey.get(
          steeringKey(entity.executionId, entity.text),
        );
        for (const id of noticeIds ?? []) this.deleteNotice(state, id);
      }
    }

    if (pendingChanged) {
      this.syncPending(state, snapshot);
      state.pending = snapshot.pending;
    }

    const changedIds = new Set<string>();
    let structureChanged = false;
    if (options.reset === true) {
      store.replaceNotices([...state.notices.values()].map(placementOf));
      for (const id of state.notices.keys()) changedIds.add(id);
      structureChanged = state.notices.size > 0;
      state.dirtyNoticeIds.clear();
    } else {
      for (const id of state.dirtyNoticeIds) {
        const notice = state.notices.get(id);
        const update = notice === undefined
          ? store.removeNotice(id)
          : store.upsertNotice(placementOf(notice));
        if (update.changed) changedIds.add(id);
        structureChanged ||= update.structureChanged;
      }
      state.dirtyNoticeIds.clear();
    }
    state.semanticIds = semanticIds;
    return Object.freeze({
      changed: changedIds.size > 0,
      changedIds,
      structureChanged,
    });
  }

  /** Reapply a newly retained local receipt to the active keyed store. */
  refresh(sessionId: string, store: KeyedConversationStore): NoticeSyncResult {
    const state = this.forSession(sessionId);
    if (state.dirtyNoticeIds.size === 0) {
      return { changed: false, changedIds: new Set(), structureChanged: false };
    }
    const changedIds = new Set<string>();
    let structureChanged = false;
    for (const id of state.dirtyNoticeIds) {
      const notice = state.notices.get(id);
      const update = notice === undefined
        ? store.removeNotice(id)
        : store.upsertNotice(placementOf(notice));
      if (update.changed) changedIds.add(id);
      structureChanged ||= update.structureChanged;
    }
    state.dirtyNoticeIds.clear();
    return Object.freeze({
      changed: changedIds.size > 0,
      changedIds,
      structureChanged,
    });
  }

  private forSession(sessionId: string): SessionNotices {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        notices: new Map(),
        dirtyNoticeIds: new Set(),
        semanticIds: [],
        appliedSteeringByEntityId: new Map(),
        appliedSteeringEntitiesByKey: new Map(),
        steeringNoticeIdsByKey: new Map(),
        pending: undefined,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private retainExecution(
    sessionId: string,
    execution: import('../conversation/model.ts').ConversationExecutionMetadata,
  ): void {
    if (execution.lifecycle !== 'settled' || execution.outcome === 'completed') return;
    const word = execution.outcome.toUpperCase();
    const reason = execution.diagnostic === undefined
      ? execution.stopReason === 'max_steps'
        ? 'step limit reached'
        : execution.outcome === 'failed'
        ? 'execution failed'
        : execution.outcome === 'unknown'
        ? 'execution result unavailable'
        : execution.outcome
      : presentationFailureReason(execution.diagnostic);
    const recallHint = execution.outcome === 'failed' &&
        (execution.diagnostic?.code === 'response_error' ||
          execution.diagnostic?.code === 'transport_error' ||
          execution.diagnostic?.code === 'provider_timeout')
      ? ' · try /recall'
      : '';
    this.retain(
      sessionId,
      `execution:${execution.executionId}`,
      (reason === execution.outcome ? word : `${word} · ${reason}`) + recallHint,
      word,
      execution.executionId,
    );
  }

  private syncPending(state: SessionNotices, snapshot: SessionSnapshot): void {
    const sessionId = snapshot.session.id;
    const records = [
      ...(snapshot.pending.followUp === undefined ? [] : [snapshot.pending.followUp]),
      ...snapshot.pending.followUps,
    ];
    for (const record of records) {
      const word = record.status === 'queued'
        ? 'RESERVED'
        : record.status === 'started'
        ? 'STARTED'
        : 'NOT STARTED';
      const reason = record.reason?.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);
      this.retain(
        sessionId,
        `queue:${record.queueId}`,
        `${word} · ${record.text}${reason === undefined ? '' : ` · ${reason}`}`,
        word === 'NOT STARTED' ? word : undefined,
        record.afterExecutionId,
      );
    }
    const steering = snapshot.pending.steering;
    if (steering !== undefined) {
      const id = `system:${sessionId}:steering:${steering.commandId}`;
      const key = steeringKey(steering.executionId, steering.text);
      const applied = state.appliedSteeringEntitiesByKey.has(key);
      if (applied) {
        this.deleteNotice(state, id);
      } else {
        this.retain(
          sessionId,
          `steering:${steering.commandId}`,
          `Additional instruction received · ${steering.text}`,
          undefined,
          steering.executionId,
        );
        const notice = state.notices.get(id);
        if (notice !== undefined && notice.steeringText !== steering.text) {
          const previous = { ...notice };
          notice.steeringText = steering.text;
          this.reindexSteeringNotice(state, id, previous, notice);
        }
        this.addSteeringNoticeId(state, key, id);
      }
    }
  }

  private rebaseAnchors(state: SessionNotices, nextIds: readonly string[]): void {
    const next = new Set(nextIds);
    for (const notice of state.notices.values()) {
      if (notice.afterExecutionId !== undefined) continue;
      if (notice.anchor === undefined || next.has(notice.anchor)) continue;
      const boundary = state.semanticIds.indexOf(notice.anchor);
      for (
        let index = Math.min(boundary - 1, state.semanticIds.length - 1);
        index >= 0;
        index -= 1
      ) {
        const candidate = state.semanticIds[index];
        if (candidate !== undefined && next.has(candidate)) {
          notice.anchor = candidate;
          state.dirtyNoticeIds.add(notice.entry.id);
          break;
        }
      }
    }
  }

  private addAppliedSteering(
    state: SessionNotices,
    entityId: string,
    entity: SessionSnapshot['conversation']['entities'][string] | undefined,
  ): void {
    if (
      entity?.kind !== 'message' || entity.role !== 'user' || entity.position.requestOrder < 0
    ) return;
    const key = steeringKey(entity.executionId, entity.text);
    state.appliedSteeringByEntityId.set(entityId, key);
    const entities = state.appliedSteeringEntitiesByKey.get(key) ?? new Set<string>();
    entities.add(entityId);
    state.appliedSteeringEntitiesByKey.set(key, entities);
  }

  private removeAppliedSteering(state: SessionNotices, entityId: string): void {
    const key = state.appliedSteeringByEntityId.get(entityId);
    if (key === undefined) return;
    state.appliedSteeringByEntityId.delete(entityId);
    const entities = state.appliedSteeringEntitiesByKey.get(key);
    entities?.delete(entityId);
    if (entities?.size === 0) state.appliedSteeringEntitiesByKey.delete(key);
  }

  private addSteeringNoticeId(state: SessionNotices, key: string, id: string): void {
    const ids = state.steeringNoticeIdsByKey.get(key) ?? new Set<string>();
    ids.add(id);
    state.steeringNoticeIdsByKey.set(key, ids);
  }

  private removeSteeringNoticeId(state: SessionNotices, key: string, id: string): void {
    const ids = state.steeringNoticeIdsByKey.get(key);
    ids?.delete(id);
    if (ids?.size === 0) state.steeringNoticeIdsByKey.delete(key);
  }

  private reindexSteeringNotice(
    state: SessionNotices,
    id: string,
    previous: RetainedNotice | undefined,
    current: RetainedNotice | undefined,
  ): void {
    const previousKey = previous?.steeringText === undefined ||
        previous.entry.executionId === undefined
      ? undefined
      : steeringKey(previous.entry.executionId, previous.steeringText);
    const currentKey =
      current?.steeringText === undefined || current.entry.executionId === undefined
        ? undefined
        : steeringKey(current.entry.executionId, current.steeringText);
    if (previousKey !== currentKey) {
      if (previousKey !== undefined) this.removeSteeringNoticeId(state, previousKey, id);
      if (currentKey !== undefined) this.addSteeringNoticeId(state, currentKey, id);
    }
  }

  private deleteNotice(state: SessionNotices, id: string): void {
    const notice = state.notices.get(id);
    if (notice === undefined) return;
    state.notices.delete(id);
    state.dirtyNoticeIds.add(id);
    this.reindexSteeringNotice(state, id, notice, undefined);
  }
}
