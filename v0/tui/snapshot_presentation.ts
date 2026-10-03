import type { SessionSnapshot } from '../api/contract.ts';
import type { SessionClientState } from '../api/reducer.ts';
import { KeyedConversationStore, mapConversationEntity } from './keyed_conversation_store.ts';
import type { PresentationPosition, PresentationStartupState } from '../presentation/contract.ts';

/** Display Core-owned orientation without loading workspace resources in the connected UI. */
export const presentationStartupFromSnapshot = (
  snapshot: SessionSnapshot,
  workspace: string,
): PresentationStartupState => ({
  ...snapshot.session.startup,
  startupEvaluation: snapshot.session.startup.status,
  coreEpoch: snapshot.cursor.coreEpoch,
  workspace,
  agentId: snapshot.session.position.agent,
  model: { ...snapshot.session.startup.model, ...snapshot.session.selection },
});

/** Convert the shared session position into the presentation value used by the remote TUI. */
export const presentationPositionFromSnapshot = (
  snapshot: SessionSnapshot,
): PresentationPosition => {
  const { position } = snapshot.session;
  return {
    sessionId: position.sessionId,
    createdAt: position.createdAt,
    ...(position.title === undefined ? {} : { title: position.title }),
    agent: position.agent,
    committedTurn: position.committedTurn,
    messageCount: position.messageCount,
    ...(position.checkpoint === undefined ? {} : {
      checkpoint: {
        coveredThroughTurn: position.checkpoint.coveredThroughTurn,
        retainedFromTurn: position.checkpoint.retainedFromTurn,
      },
    }),
  };
};

export interface KeyedConversationUpdate {
  readonly store: KeyedConversationStore;
  readonly changedIds: ReadonlySet<string>;
  readonly structureChanged: boolean;
  readonly reset: boolean;
  readonly revision: number;
  readonly previousIds?: readonly string[];
}

/** Applies each reducer revision to keyed UI rows before scheduling any terminal redraw. */
export class SnapshotConversationProjector {
  private scope: string | undefined;
  private readonly store = new KeyedConversationStore();
  private revision = -1;

  project(state: SessionClientState, scope: string): KeyedConversationUpdate {
    const reset = this.scope !== scope;
    if (reset) {
      this.scope = scope;
      this.store.clear();
      this.revision = -1;
    }
    const snapshot = state.snapshot;
    const changedIds = new Set<string>();
    let presenceChanged = false;
    let previousIds = !reset && state.structureChanged ? [...this.store.ids()] : undefined;
    for (const entityId of state.dirtyEntityIds) {
      const entity = snapshot.conversation.entities[entityId];
      const rowId = `conversation:${entityId}`;
      const previous = this.store.get(rowId);
      if (entity === undefined) {
        if (previous !== undefined) {
          previousIds ??= [...this.store.ids()];
          this.store.delete(rowId);
          presenceChanged = true;
          changedIds.add(rowId);
        }
        continue;
      }
      const entry = mapConversationEntity(entity, previous);
      if (entry === undefined) {
        if (previous !== undefined) {
          previousIds ??= [...this.store.ids()];
          this.store.delete(rowId);
          presenceChanged = true;
          changedIds.add(rowId);
        }
      } else {
        if (previous === undefined) {
          previousIds ??= [...this.store.ids()];
          presenceChanged = true;
        }
        if (entry !== previous) {
          this.store.set(rowId, entry);
          changedIds.add(rowId);
        }
      }
    }
    const structureChanged = reset || state.structureChanged || presenceChanged;
    if (structureChanged) {
      this.store.replaceSemanticOrder(
        snapshot.conversation.order.map((id) => `conversation:${id}`),
      );
    }
    this.store.setOmittedCount(0);
    this.revision = snapshot.cursor.revision;
    return Object.freeze({
      store: this.store,
      changedIds,
      structureChanged,
      reset,
      revision: this.revision,
      ...(previousIds === undefined ? {} : { previousIds }),
    });
  }
}
