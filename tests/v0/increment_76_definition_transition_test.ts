import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import type { DefinitionRevisionRef } from '../../v0/agent/session/session_store.ts';
import {
  type StoredSessionRecord,
  type WorkerSessionHandle,
} from '../../v0/agent/session/session_store.ts';
import {
  workerBuiltinModulePath,
  type WorkerHostCapsule,
  WorkerHostSession,
} from '../../v0/agent/worker/worker_host.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const definition = (digest: string): DefinitionRevisionRef => ({
  schemaVersion: 1,
  resourceKind: 'agent-definition',
  resourceId: 'builtin/default',
  revision: { algorithm: 'sha256', digest },
});

class ReadyCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<(message: WorkerToHostMessage) => void>();

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      this.emit({
        kind: 'ready',
        correlation: command.correlation,
        manifest: {
          role: 'parent',
          maxSteps: 8,
          profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
          resources: [],
          rootModel: ROOT_DEFAULT_MODEL_SELECTION,
        },
        startupSnapshot: { skillNames: [] },
        credentialAvailability: {
          authProfile: ROOT_DEFAULT_MODEL_SELECTION.authProfile,
          status: 'unknown',
        },
      });
    } else if (command.kind === 'close') {
      this.emit({ kind: 'closed', correlation: command.correlation });
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {}
}

const recordFor = (
  workspaceRoot: string,
  sessionId: string,
  storedDefinition: DefinitionRevisionRef,
): StoredSessionRecord => {
  const createdAt = '2026-09-18T00:00:00.000Z';
  return {
    schemaVersion: 6,
    sessionId,
    workspaceRoot,
    agent: 'default',
    createdAt,
    updatedAt: createdAt,
    title: null,
    stateRevision: 1,
    nextTurn: 1,
    transcript: [],
    definition: storedDefinition,
    activeModel: ROOT_DEFAULT_MODEL_SELECTION,
    modelChanges: [{
      effectiveFromTurn: 1,
      changedAt: createdAt,
      selection: ROOT_DEFAULT_MODEL_SELECTION,
    }],
    turnModels: [],
    turnExecutions: [],
  };
};

const handleFor = (
  record: StoredSessionRecord,
): WorkerSessionHandle => ({
  id: record.sessionId,
  record,
  commit() {},
  rollback() {},
  installCheckpoint() {},
  rollbackCheckpoint() {},
  close: () => Promise.resolve(),
});

const openWith = (
  handle: WorkerSessionHandle,
  workspaceRoot: string,
  selected: DefinitionRevisionRef,
  agent: 'default' | 'planner' = 'default',
): Promise<WorkerHostSession> =>
  WorkerHostSession.open({
    handle,
    workspaceRoot,
    agent,
    definition: selected,
    modulePath: workerBuiltinModulePath(agent),
    physicalIoMode: 'provider-free',
    capsuleFactory: () => new ReadyCapsule(),
  });

Deno.test('Increment 76 opens a stored session under the current Definition revision', async () => {
  const workspaceRoot = await Deno.makeTempDir({ prefix: 'henji-i76-open-' });
  try {
    const stored = definition('a'.repeat(64));
    const current = definition('b'.repeat(64));
    const record = recordFor(workspaceRoot, '00000000-0000-4000-8000-000000000076', stored);
    const host = await openWith(handleFor(record), workspaceRoot, current);
    try {
      assert(
        host.definition.revision.digest === current.revision.digest,
        'generation must use the current Definition revision',
      );
    } finally {
      await host.close();
    }
  } finally {
    await Deno.remove(workspaceRoot, { recursive: true });
  }
});

Deno.test('Increment 76 still rejects a workspace or agent binding mismatch', async () => {
  const workspaceRoot = await Deno.makeTempDir({ prefix: 'henji-i76-open-' });
  try {
    const stored = definition('a'.repeat(64));
    const current = definition('b'.repeat(64));
    const record = recordFor(workspaceRoot, '00000000-0000-4000-8000-000000000077', stored);

    let workspaceRejected = false;
    try {
      await openWith(handleFor(record), `${workspaceRoot}/other`, current);
    } catch {
      workspaceRejected = true;
    }
    assert(workspaceRejected, 'a workspace mismatch must still fail');

    let agentRejected = false;
    try {
      await openWith(handleFor(record), workspaceRoot, current, 'planner');
    } catch {
      agentRejected = true;
    }
    assert(agentRejected, 'an agent mismatch must still fail');
  } finally {
    await Deno.remove(workspaceRoot, { recursive: true });
  }
});

class TurnCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<(message: WorkerToHostMessage) => void>();
  private nextTurn = 1;
  private transcript: StoredSessionRecord['transcript'] = [];

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      this.nextTurn = command.nextTurn ?? 1;
      this.transcript = [...(command.initialTranscript ?? [])];
      this.emit({
        kind: 'ready',
        correlation: command.correlation,
        manifest: {
          role: 'parent',
          maxSteps: 8,
          profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
          resources: [],
          rootModel: ROOT_DEFAULT_MODEL_SELECTION,
          ...(command.baseInstruction === undefined ? {} : {
            baseInstruction: {
              slot: command.baseInstruction.slot,
              selectionSource: command.baseInstruction.selectionSource,
              ref: command.baseInstruction.ref,
              contentDigest: command.baseInstruction.contentDigest,
            },
          }),
        },
        startupSnapshot: { skillNames: [] },
        credentialAvailability: {
          authProfile: ROOT_DEFAULT_MODEL_SELECTION.authProfile,
          status: 'unknown',
        },
      });
    } else if (command.kind === 'turn') {
      const nextTurn = this.nextTurn + 1;
      const transcript = [
        ...this.transcript,
        { role: 'user' as const, content: { kind: 'text' as const, text: command.task } },
        { role: 'assistant' as const, content: { kind: 'text' as const, text: 'ok' } },
      ];
      this.nextTurn = nextTurn;
      this.transcript = transcript;
      queueMicrotask(() =>
        this.emit({
          kind: 'commit_proposal',
          correlation: command.correlation,
          nextTurn,
          transcript,
        })
      );
    } else if (command.kind === 'commit_acknowledgement' && command.accepted) {
      queueMicrotask(() =>
        this.emit({
          kind: 'runtime_event',
          correlation: command.correlation,
          sequence: 1,
          event: {
            kind: 'agent_event',
            event: { kind: 'turn_end', turn: 1, outcome: 'final', committed: true },
          },
        })
      );
    } else if (command.kind === 'close') {
      this.emit({ kind: 'closed', correlation: command.correlation });
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {}
}

Deno.test('Increment 76 opens a stored session lazily and starts the Worker on first submit', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i76-lazy-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  let storedId = '';
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
    await store.initialize();
    const handle = await store.allocateWorker('default', definition('a'.repeat(64)));
    storedId = handle.id;
    handle.commit(recordFor(workspaceRoot, storedId, definition('a'.repeat(64))));
    await handle.close();

    let capsules = 0;
    const capsuleCount = () => capsules;
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'session',
      sessionId: storedId,
      lazyInitialHost: true,
      physicalIoMode: 'provider-free',
      capsuleFactory: () => {
        capsules += 1;
        return new TurnCapsule();
      },
    });
    assert(capsuleCount() === 0, 'opening a stored session must not start a Worker');
    assert(created.session.currentPosition().committedTurn === 0);
    assert(created.session.currentPosition().messageCount === 0);

    const outcome = await created.session.submit('lazy turn');
    assert(capsuleCount() === 1, 'the first submit starts the Worker');
    assert(outcome.ok, outcome.error);

    const reopened = await store.readWorker(storedId);
    assert(reopened.nextTurn === 2, 'the lazy turn was committed to the stored session');
    assert(
      reopened.definition.revision.digest !== 'a'.repeat(64),
      'the stored binding advanced to the current Definition revision',
    );
  } finally {
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 113 rename starts a lazy resumed Worker and saves the title', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i113-lazy-rename-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
    let capsuleCount = 0;
    const countCapsules = () => capsuleCount;
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
      capsuleFactory: (url) => {
        capsuleCount += 1;
        return new WorkerCapsule(url);
      },
    });
    const firstId = created.session.currentPosition().sessionId;
    assert((await created.session.submit('save the first session')).ok);
    assertEquals(countCapsules(), 1);
    await created.close();
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'session',
      sessionId: firstId,
      lazyInitialHost: true,
      physicalIoMode: 'provider-free',
      capsuleFactory: (url) => {
        capsuleCount += 1;
        return new WorkerCapsule(url);
      },
    });
    assert(countCapsules() === 1, 'opening a stored Session remains lazy');
    assertEquals(await created.session.renameTitle('Resumed notes'), 'renamed');
    assert(countCapsules() === 2, 'the first live rename starts the Worker');
    assertEquals((await store.readWorker(firstId)).title, 'Resumed notes');
  } finally {
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});
