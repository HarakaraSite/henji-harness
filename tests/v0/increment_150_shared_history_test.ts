import { deepStrictEqual, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store.ts';
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const fixture = async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i150-shared-' });
  const workspace = `${root}/workspace`, state = `${root}/state`;
  await Deno.mkdir(workspace);
  return { root, workspace, state };
};
const child = (state: string, workspace: string, task: string, barrier = false) =>
  new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--no-prompt',
      '--cached-only',
      '--no-check',
      '--unstable-worker-options',
      '--allow-read=.,/tmp',
      '--allow-write=/tmp',
      '--config',
      'deno.v0.json',
      'tests/v0/fixtures/increment_150_shared_history.ts',
      state,
      workspace,
      task,
      ...(barrier ? ['barrier'] : []),
    ],
    stdin: barrier ? 'piped' : 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
Deno.test('Increment 150 an existing HTTP Core discovers a DB created by another process', async () => {
  const f = await fixture();
  const core = await createCoreService({
    stateRoot: f.state,
    workspaceRoot: f.workspace,
    physicalIoMode: 'provider-free',
  });
  const server = await startCoreServer(core, { hostname: '127.0.0.1', port: 0 });
  try {
    const client = new HenjiApiClient(server.url);
    strictEqual((await client.sessionsList()).sessions.length, 0);
    const output = await child(f.state, f.workspace, 'saved by A').output();
    strictEqual(output.code, 0, decode(output.stderr));
    const saved = JSON.parse(decode(output.stdout));
    strictEqual((await client.sessionsList()).sessions[0].id, saved.sessionId);
    const history = await client.historyRead({ sessionRef: saved.sessionId, view: 'session' });
    strictEqual(history.text.includes('saved by A'), true);
    strictEqual(core.coreRead().activeSessionId, null);
  } finally {
    await server.shutdown();
    await Deno.remove(f.root, { recursive: true });
  }
});
Deno.test('Increment 150 two process Sessions submit and save separate canonical turns', async () => {
  const f = await fixture();
  const children = [
    child(f.state, f.workspace, 'writer A', true),
    child(f.state, f.workspace, 'writer B', true),
  ];
  const readers = children.map((p) => p.stdout.getReader());
  try {
    for (const reader of readers) strictEqual(decode((await reader.read()).value!).trim(), 'ready');
    await Promise.all(children.map(async (p) => {
      const w = p.stdin!.getWriter();
      await w.write(new Uint8Array([10]));
      await w.close();
    }));
    const outputs = await Promise.all(children.map(async (p, index) => {
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await readers[index].read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      const stderr = await new Response(p.stderr).text();
      strictEqual((await p.status).code, 0, stderr);
      return JSON.parse(chunks.map(decode).join('')) as { sessionId: string };
    }));
    strictEqual(outputs[0].sessionId === outputs[1].sessionId, false);
    const store = new SqliteHistoryV7ProductionStore(f.state, f.workspace, { readOnly: true });
    try {
      await store.initialize();
      for (const [index, saved] of outputs.entries()) {
        const record = await store.readWorker(saved.sessionId);
        strictEqual(record.nextTurn, 2);
        strictEqual(
          record.transcript.some((m) =>
            m.role === 'user' && m.content.kind === 'text' &&
            m.content.text === `writer ${index === 0 ? 'A' : 'B'}`
          ),
          true,
        );
        strictEqual(
          store.listExecutionsForSession(saved.sessionId)[0].adoption,
          'canonical',
        );
      }
    } finally {
      store.close();
    }
  } finally {
    for (const p of children) {
      try {
        p.kill('SIGKILL');
      } catch { /* Already stopped. */ }
      await p.status;
    }
    await Deno.remove(f.root, { recursive: true });
  }
});
const admission = (id: string, correlation = id) => ({
  executionId: id,
  taskId: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  sessionCorrelation: correlation,
  turn: 1,
  task: 'recovery ownership',
  baseStateRevision: 0,
  agent: 'default' as const,
  model: ROOT_DEFAULT_MODEL_SELECTION,
  build: buildManifest(),
  definition: {
    schemaVersion: 1 as const,
    resourceKind: 'agent-definition' as const,
    resourceId: 'builtin/default',
    revision: { algorithm: 'sha256' as const, digest: '1'.repeat(64) },
  },
  sessionMode: 'no_session' as const,
});
Deno.test('Increment 150 recovery respects live parent/child owners and releases acquired locks', async () => {
  const f = await fixture();
  const owner = new SqliteHistoryV7ProductionStore(f.state, f.workspace);
  const observer = new SqliteHistoryV7ProductionStore(f.state, f.workspace);
  const recovery = new SqliteHistoryV7ProductionStore(f.state, f.workspace);
  const parent = crypto.randomUUID(), childId = crypto.randomUUID();
  try {
    await owner.beginExecution(admission(parent));
    await owner.beginExecution({
      ...admission(childId),
      parentExecutionId: parent,
      spawnCallId: 'spawn-child',
    });
    await observer.initialize();
    deepStrictEqual([parent, childId].map((id) => observer.readExecution(id).lifecycle), [
      'active',
      'active',
    ]);
    owner.close();
    await recovery.initialize();
    for (const id of [parent, childId]) {
      strictEqual(recovery.readExecution(id).outcome, 'interrupted');
      const file = await Deno.open(
        `${(await sessionPaths(f.state, f.workspace)).root}/locks-v7/.execution-${id}.lock`,
        { read: true, write: true },
      );
      try {
        strictEqual(await file.tryLock(true), true);
        await file.unlock();
      } finally {
        file.close();
      }
    }
  } finally {
    owner.close();
    observer.close();
    recovery.close();
    await Deno.remove(f.root, { recursive: true });
  }
});
Deno.test('Increment 150 early-settled recovery releases the Session lock for explicit resume', async () => {
  const f = await fixture();
  const owner = new SqliteHistoryV7ProductionStore(f.state, f.workspace);
  const settler = new SqliteHistoryV7ProductionStore(f.state, f.workspace);
  const recovery = new SqliteHistoryV7ProductionStore(f.state, f.workspace);
  const definition = await builtinDefinitionRef('default', buildManifest());
  const handle = await owner.allocateWorker('default', definition);
  const createdAt = new Date().toISOString();
  const record: StoredSessionRecord = {
    schemaVersion: 6,
    sessionId: handle.id,
    workspaceRoot: f.workspace,
    agent: 'default',
    createdAt,
    updatedAt: createdAt,
    title: null,
    stateRevision: 1,
    nextTurn: 1,
    transcript: [],
    definition,
    activeModel: ROOT_DEFAULT_MODEL_SELECTION,
    modelChanges: [{
      effectiveFromTurn: 1,
      changedAt: createdAt,
      selection: ROOT_DEFAULT_MODEL_SELECTION,
    }],
    turnModels: [],
    turnExecutions: [],
  };
  const id = crypto.randomUUID();
  try {
    handle.commit(record);
    await owner.beginExecution({
      ...admission(id, handle.id),
      definition,
      baseStateRevision: 1,
      canonicalSessionId: handle.id,
      sessionMode: 'persistent',
    });
    await settler.initialize();
    strictEqual(settler.readExecution(id).lifecycle, 'active');
    owner.close();
    await handle.close();
    const original = recovery.reconcileExecution.bind(recovery);
    recovery.reconcileExecution = (input) => {
      settler.reconcileExecution(input);
      original(input);
    };
    await recovery.initialize();
    strictEqual(recovery.readExecution(id).lifecycle, 'settled');
    const resumed = await settler.openExistingWorker(handle.id);
    await resumed.close();
  } finally {
    await handle.close();
    owner.close();
    settler.close();
    recovery.close();
    await Deno.remove(f.root, { recursive: true });
  }
});
