import { readSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteHistoryStore } from '../../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../../v0/agent/provider/openrouter_model_catalog.ts';
import type { StoredSessionRecord } from '../../../v0/agent/session/session_store.ts';
import { workerConfigurationFixture } from '../helpers/worker_configuration_fixture.ts';
import { buildManifest } from '../../../v0/agent/runtime/build_manifest.ts';

const [mode, stateRoot, workspaceRoot, executionId] = Deno.args;
const emit = (value: string) => Deno.stdout.writeSync(new TextEncoder().encode(`${value}\n`));
const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
const configuration = workerConfigurationFixture();
const input = {
  executionId,
  taskId: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  sessionCorrelation: executionId,
  turn: 1,
  task: 'write wait',
  baseStateRevision: 0,
  agent: 'default' as const,
  model: ROOT_DEFAULT_MODEL_SELECTION,
  build: buildManifest(),
  configuration,
  configurationId: configuration.configurationId,
  maxSteps: 128,
  command: 'write-wait',
  sessionMode: 'no_session' as const,
};
let handle: Awaited<ReturnType<typeof store.allocateWorker>> | undefined;
try {
  await store.initialize();
  if (mode === 'begin') handle = await store.allocateWorker('default', {});
  if (mode === 'append') await store.beginExecution(input);
  emit('ready');
  const gate = new Uint8Array(1);
  if (readSync(0, gate, 0, 1, null) !== 1) throw new Error('missing gate');
  const originalExec = DatabaseSync.prototype.exec;
  let observed = false;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (!observed && sql.includes('BEGIN IMMEDIATE')) {
      observed = true;
      emit('write-attempt');
    }
    return originalExec.call(this, sql);
  };
  try {
    if (mode === 'begin') {
      const record: StoredSessionRecord = {
        schemaVersion: 1,
        sessionId: handle!.id,
        workspaceRoot,
        agent: 'default',
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        title: null,
        stateRevision: 1,
        nextTurn: 1,
        transcript: [],
        agentChoice: {},
        activeModel: input.model,
        modelChanges: [{
          effectiveFromTurn: 1,
          changedAt: input.createdAt,
          selection: input.model,
        }],
        turnModels: [],
        turnExecutions: [],
      };
      // Initial persistent admission materializes the Session via the short-lived helper.
      await store.beginExecution({
        ...input,
        sessionCorrelation: handle!.id,
        canonicalSessionId: handle!.id,
        sessionMode: 'persistent',
        baseStateRevision: 1,
        sessionRecord: record,
      });
    } else if (mode === 'append') {
      store.appendExecutionEvents([{
        executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: 1,
        payload: {
          kind: 'provider_observation',
          correlation: {
            session: executionId,
            instanceCorrelation: 'wait-instance',
            workerGeneration: 'wait-generation',
            baseStateRevision: 0,
            command: 'wait-turn',
          },
          sequence: 1,
          turn: 1,
          observation: {
            kind: 'runtime_event',
            event: {
              kind: 'assistant_progress',
              text: 'saved after wait',
              modelStep: 1,
              requestOrdinal: 1,
              lane: 'parent',
            },
          },
        },
      }]);
    } else throw new Error('unknown mode');
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  store.reconcileExecution({ executionId, settlement: 'interrupted' });
  emit('done');
} finally {
  await handle?.close();
  store.close();
}
