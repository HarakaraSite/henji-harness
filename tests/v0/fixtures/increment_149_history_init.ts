import { readSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { builtinDefinitionRef } from '../../../v0/agent/definitions/managed_resource_ref.ts';
import { createCoreService } from '../../../v0/agent/host/core_service.ts';
import { SqliteHistoryV7Store } from '../../../v0/agent/history/sqlite_history_v7_store.ts';
import { withHistorySchemaOpen } from '../../../v0/agent/history/history_schema_open.ts';
import { SqliteHistoryV7ProductionStore } from '../../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { defaultModelSelectionFor } from '../../../v0/agent/provider/model_catalog.ts';
import { buildManifest } from '../../../v0/agent/runtime/build_manifest.ts';
import type { StoredSessionRecord } from '../../../v0/agent/session/session_store.ts';
import { sessionPaths } from '../../../v0/agent/session/session_store_paths.ts';

const [mode, stateRoot, workspaceRoot, label] = Deno.args;
if (stateRoot === undefined || workspaceRoot === undefined) {
  throw new Error('stateRoot and workspaceRoot are required');
}

const emit = (value: string): void => {
  Deno.stdout.writeSync(new TextEncoder().encode(`${value}\n`));
};

const watchSchemaLockAttempt = (directoryPath: string, marker: string): () => void => {
  const descriptor = Object.getOwnPropertyDescriptor(Deno, 'open');
  const originalOpen = Deno.open.bind(Deno);
  Object.defineProperty(Deno, 'open', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: async (path: string | URL, options?: Deno.OpenOptions): Promise<Deno.FsFile> => {
      const file = await originalOpen(path, options);
      if (path !== directoryPath) return file;
      return new Proxy(file, {
        get(target, property) {
          if (property === 'lock') {
            return async (exclusive?: boolean): Promise<void> => {
              emit(marker);
              await target.lock(exclusive);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as Deno.FsFile;
    },
  });
  return () => {
    if (descriptor === undefined) throw new Error('Deno.open property descriptor is missing');
    Object.defineProperty(Deno, 'open', descriptor);
  };
};

const installDataWorkerSchemaLockProbe = (directoryPath: string): () => void => {
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  if (workerDescriptor === undefined || typeof workerDescriptor.value !== 'function') {
    throw new Error('Worker constructor is unavailable');
  }
  const originalWorker = workerDescriptor.value as typeof Worker;
  const productionBootstrap = new URL('../../../v0/agent/data/data_bootstrap.ts', import.meta.url);
  const fixtureBootstrap = new URL('./increment_149_data_bootstrap.ts', import.meta.url);
  const workerWithDataProbe = new Proxy(originalWorker, {
    construct(target, args: [string | URL, WorkerOptions?], newTarget) {
      const [scriptUrl, options] = args;
      const resolvedUrl = new URL(scriptUrl, import.meta.url);
      if (resolvedUrl.href === productionBootstrap.href) {
        fixtureBootstrap.searchParams.set('root', directoryPath);
        return Reflect.construct(target, [fixtureBootstrap, options], newTarget);
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  Object.defineProperty(globalThis, 'Worker', {
    ...workerDescriptor,
    value: workerWithDataProbe,
  });
  return () => Object.defineProperty(globalThis, 'Worker', workerDescriptor);
};

if (mode === 'create-session') {
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const restoreOpen = watchSchemaLockAttempt(paths.root, 'writer-lock-attempt');
  try {
    await store.initialize();
  } finally {
    restoreOpen();
  }
  const definition = await builtinDefinitionRef('default', buildManifest());
  const handle = await store.allocateWorker('default', definition);
  const createdAt = new Date().toISOString();
  const activeModel = defaultModelSelectionFor('openrouter-chat');
  const record: StoredSessionRecord = {
    schemaVersion: 6,
    sessionId: handle.id,
    workspaceRoot,
    agent: 'default',
    createdAt,
    updatedAt: createdAt,
    title: label ?? null,
    stateRevision: 1,
    nextTurn: 1,
    transcript: [],
    definition,
    activeModel,
    modelChanges: [{ effectiveFromTurn: 1, changedAt: createdAt, selection: activeModel }],
    turnModels: [],
    turnExecutions: [],
  };
  try {
    handle.commit(record);
    const readback = await store.readWorker(handle.id);
    if (readback.sessionId !== handle.id || readback.title !== (label ?? null)) {
      throw new Error('created Session was not readable in its writer process');
    }
  } finally {
    await handle.close();
    store.close();
  }
  emit(JSON.stringify({ sessionId: handle.id }));
  Deno.exit(0);
}

if (mode === 'prepare-schema-barrier') {
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const databasePath = `${paths.root}/history-v7.sqlite3`;
  await Deno.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await withHistorySchemaOpen(paths.root, () => {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('BEGIN IMMEDIATE;');
      emit('database-created');
      const gate = new Uint8Array(1);
      const count = readSync(0, gate, 0, gate.byteLength, null);
      if (count !== 1 || gate[0] !== 10) throw new Error('schema barrier was not released');
      db.exec('COMMIT;');
    } finally {
      db.close();
    }
    const store = new SqliteHistoryV7Store(databasePath);
    store.close();
  });
  emit('schema-ready');
  Deno.exit(0);
}

if (mode === 'open-core') {
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const restoreWorker = installDataWorkerSchemaLockProbe(paths.root);
  emit('core-opening');
  try {
    const core = await createCoreService({
      stateRoot,
      workspaceRoot,
      physicalIoMode: 'provider-free',
    });
    try {
      const reply = await core.historyRead({ view: 'session' });
      const history = JSON.parse(new TextDecoder().decode(reply.bytes));
      if (history.sessionId !== null || history.text !== '') {
        throw new Error('new schema should have empty history');
      }
      const opened = await core.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'new' },
      });
      if (opened.kind !== 'accepted') {
        throw new Error(`Core could not open a new Session: ${JSON.stringify(opened)}`);
      }
      await core.sessionRead(opened.value.sessionId);
      emit(JSON.stringify({ sessionId: opened.value.sessionId, phase: 'ready' }));
    } finally {
      await core.close();
    }
  } finally {
    restoreWorker();
  }
  Deno.exit(0);
}

throw new Error(`unknown fixture mode: ${mode}`);
