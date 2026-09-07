import {
  MAX_VALID_SESSIONS_PER_WORKSPACE,
  type SemanticContextCheckpointV1,
  type SessionHandle,
  type SessionListResult,
  type SessionRecord,
  SessionStoreError,
  type SessionStorePort,
} from './session_store_contract.ts';
import {
  compareSessionMetadata,
  encodeSemanticContextCheckpoint,
  encodeSessionRecord,
  metadataFromRecord,
} from './session_record_codec.ts';

/** Permission-free store used by direct runtime/TUI tests and fault-injection seams. */
export class FakeSessionStore implements SessionStorePort {
  private readonly records = new Map<string, SessionRecord>();
  private readonly checkpoints = new Map<string, SemanticContextCheckpointV1>();
  private readonly active = new Set<string>();
  private nextId = 1;

  constructor(readonly workspaceRoot = '/workspace') {}

  async read(id: string): Promise<SessionRecord> {
    await Promise.resolve();
    const value = this.records.get(id);
    if (value === undefined) throw new SessionStoreError('session_not_found');
    return structuredClone(value);
  }

  async readCheckpoint(
    id: string,
  ): Promise<SemanticContextCheckpointV1 | undefined> {
    await Promise.resolve();
    const value = this.checkpoints.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }

  async list(): Promise<SessionListResult> {
    await Promise.resolve();
    const sessions = [...this.records.values()].map(metadataFromRecord).sort(
      compareSessionMetadata,
    );
    return { sessions, skippedInvalid: 0 };
  }

  async allocate(agent: SessionRecord['agent']): Promise<SessionHandle> {
    await Promise.resolve();
    if (agent !== 'default' && agent !== 'planner') {
      throw new SessionStoreError('session_invalid');
    }
    if (
      new Set([...this.records.keys(), ...this.active]).size >=
        MAX_VALID_SESSIONS_PER_WORKSPACE
    ) {
      throw new SessionStoreError('session_limit');
    }
    const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
    this.active.add(id);
    return this.fakeHandle(id, agent, undefined);
  }

  async openExisting(id: string): Promise<SessionHandle> {
    await Promise.resolve();
    const record = this.records.get(id);
    if (record === undefined) throw new SessionStoreError('session_not_found');
    if (this.active.has(id)) throw new SessionStoreError('session_busy');
    this.active.add(id);
    return this.fakeHandle(id, record.agent, record);
  }

  async delete(id: string): Promise<void> {
    await Promise.resolve();
    if (this.active.has(id)) throw new SessionStoreError('session_busy');
    if (!this.records.has(id)) throw new SessionStoreError('session_not_found');
    this.records.delete(id);
    this.checkpoints.delete(id);
  }

  private fakeHandle(
    id: string,
    agent: SessionRecord['agent'],
    initial: SessionRecord | undefined,
  ): SessionHandle {
    let current = initial;
    let rollbackRecord = initial;
    const checkpoints = this.checkpoints;
    const initialCheckpoint = checkpoints.get(id);
    let closed = false;
    return {
      id,
      record: initial,
      get checkpoint() {
        const value = checkpoints.get(id);
        return value === undefined ? undefined : structuredClone(value);
      },
      commit: (next) => {
        if (
          closed || next.sessionId !== id ||
          next.workspaceRoot !== this.workspaceRoot
        ) {
          throw new SessionStoreError('session_invalid');
        }
        if (next.agent !== agent) {
          throw new SessionStoreError('session_invalid');
        }
        encodeSessionRecord(next);
        rollbackRecord = current;
        current = structuredClone(next);
        this.records.set(id, structuredClone(next));
      },
      rollback: () => {
        if (rollbackRecord === undefined) this.records.delete(id);
        else this.records.set(id, structuredClone(rollbackRecord));
        current = rollbackRecord;
      },
      installCheckpoint: (next) => {
        if (closed || next.sessionId !== id) {
          throw new SessionStoreError('session_invalid');
        }
        encodeSemanticContextCheckpoint(next);
        checkpoints.set(id, structuredClone(next));
      },
      rollbackCheckpoint: () => {
        // Fake persistence keeps the previous value in the handle-local snapshot below.
        if (initialCheckpoint === undefined) checkpoints.delete(id);
        else checkpoints.set(id, structuredClone(initialCheckpoint));
      },
      close: () => {
        if (closed) return Promise.resolve();
        closed = true;
        this.active.delete(id);
        if (current === undefined) {
          this.records.delete(id);
          checkpoints.delete(id);
        }
        return Promise.resolve();
      },
    };
  }
}
