import type { Message } from '../core/contracts.ts';
import type {
  SemanticContextCheckpointV1,
  SessionHandle,
  SessionRecord,
} from './session_store_contract.ts';

/** Adapt a locked handle to AgentSession's provider-neutral durable commit port. */
export const createSessionPersistence = (
  handle: SessionHandle,
  workspaceRoot: string,
  agent: SessionRecord['agent'],
  initial?: SessionRecord,
): {
  readonly id: string;
  readonly record: SessionRecord | undefined;
  readonly checkpoint: SemanticContextCheckpointV1 | undefined;
  commit(
    transcript: readonly Message[],
    nextTurn: number,
    updatedAt: string,
  ): void;
  rollback(): void;
  installCheckpoint(checkpoint: SemanticContextCheckpointV1): void;
  rollbackCheckpoint(): void;
  close(): Promise<void>;
} => {
  let record = initial;
  let rollbackRecord = initial;
  let checkpoint = handle.checkpoint;
  return {
    id: handle.id,
    get record() {
      return record;
    },
    get checkpoint() {
      return checkpoint === undefined ? undefined : structuredClone(checkpoint);
    },
    commit(transcript, nextTurn, updatedAt) {
      rollbackRecord = record;
      const createdAt = record?.createdAt ?? updatedAt;
      const next: SessionRecord = {
        schemaVersion: 1,
        sessionId: handle.id,
        workspaceRoot,
        agent,
        createdAt,
        updatedAt,
        nextTurn,
        transcript: structuredClone(transcript),
      };
      handle.commit(next);
      record = next;
    },
    rollback() {
      handle.rollback();
      record = rollbackRecord;
    },
    installCheckpoint(value) {
      handle.installCheckpoint(value);
      checkpoint = structuredClone(value);
    },
    rollbackCheckpoint() {
      handle.rollbackCheckpoint();
      checkpoint = handle.checkpoint;
    },
    async close() {
      await handle.close();
    },
  };
};
