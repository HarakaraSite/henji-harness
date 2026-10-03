import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { DefinitionRevisionRef } from '../../v0/agent/session/session_store.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store.ts';
import { Increment170FoundationDataPortAgent } from './helpers/increment_170_foundation_data.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { DataService, DataSessionDescriptor } from '../../v0/agent/data/data_contract.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { workerBuiltinModulePath } from '../../v0/agent/worker/worker_definition_revision.ts';

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

const openWith = (
  data: DataService,
  descriptor: DataSessionDescriptor,
  workspaceRoot: string,
): Promise<WorkerHostSession> =>
  WorkerHostSession.open({
    data,
    descriptor,
    workspaceRoot,
    modulePath: workerBuiltinModulePath('default'),
    physicalIoMode: 'provider-free',
    capsuleFactory: () =>
      new Increment170FoundationDataPortAgent(() => {
        throw new Error('definition revision probe does not submit a turn');
      }),
  });

Deno.test('Increment 76 opens a stored session under the current Definition revision', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i76-open-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const stored = definition('a'.repeat(64));
  const current = definition('b'.repeat(64));
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  let data: DataService | undefined;
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const handle = await store.allocateWorker('default', stored);
    handle.commit(recordFor(workspaceRoot, handle.id, stored));
    await handle.close();
    data = await createDataClient({ stateRoot, workspaceRoot });
    const descriptor = await data.openSession({
      persistence: 'session',
      sessionId: handle.id,
      agent: 'default',
      definition: current,
    });
    host = await openWith(data, descriptor, workspaceRoot);
    assertEquals(host.definition.revision.digest, current.revision.digest);
  } finally {
    await host?.close();
    await data?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 76 still rejects a workspace or agent binding mismatch', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i76-binding-' });
  const workspaceRoot = `${root}/workspace`;
  const otherWorkspace = `${root}/other-workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(otherWorkspace);
  const stored = definition('a'.repeat(64));
  const current = definition('b'.repeat(64));
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  let otherData: DataService | undefined;
  let data: DataService | undefined;
  try {
    await store.initialize();
    const handle = await store.allocateWorker('default', stored);
    handle.commit(recordFor(workspaceRoot, handle.id, stored));
    await handle.close();
    otherData = await createDataClient({
      stateRoot,
      workspaceRoot: otherWorkspace,
    });
    let workspaceRejected = false;
    try {
      await otherData.openSession({
        persistence: 'session',
        sessionId: handle.id,
        agent: 'default',
        definition: current,
      });
    } catch {
      workspaceRejected = true;
    }
    assert(workspaceRejected, 'a workspace mismatch must still fail');

    let agentRejected = false;
    try {
      data = await createDataClient({ stateRoot, workspaceRoot });
      await data.openSession({
        persistence: 'session',
        sessionId: handle.id,
        agent: 'planner',
        definition: current,
      });
    } catch {
      agentRejected = true;
    }
    assert(agentRejected, 'an agent mismatch must still fail');
  } finally {
    await otherData?.close();
    await data?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

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
    const handle = await store.allocateWorker(
      'default',
      definition('a'.repeat(64)),
    );
    storedId = handle.id;
    handle.commit(
      recordFor(workspaceRoot, storedId, definition('a'.repeat(64))),
    );
    await handle.close();
    store.close();

    let capsules = 0;
    const capsuleCount = () => capsules;
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'session',
      sessionId: storedId,
      lazyInitialHost: true,
      physicalIoMode: 'provider-free',
      capsuleFactory: (url) => {
        capsules += 1;
        return new WorkerCapsule(url);
      },
    });
    assert(
      capsuleCount() === 0,
      'opening a stored session must not start a Worker',
    );
    assert(created.session.currentPosition().committedTurn === 0);
    assert(created.session.currentPosition().messageCount === 0);

    const outcome = await created.session.submit('lazy turn');
    assert(capsuleCount() === 1, 'the first submit starts the Worker');
    assert(outcome.ok, outcome.error);

    const readStore = new SqliteHistoryV7ProductionStore(
      stateRoot,
      workspaceRoot,
    );
    await readStore.initialize();
    const reopened = await readStore.readWorker(storedId);
    readStore.close();
    assert(
      reopened.nextTurn === 2,
      'the lazy turn was committed to the stored session',
    );
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
