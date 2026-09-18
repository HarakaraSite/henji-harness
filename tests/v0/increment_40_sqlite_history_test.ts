import { DatabaseSync } from 'node:sqlite';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import {
  type HistoryPersistencePort,
  HistoryStoreError,
} from '../../v0/agent/history/history_store_contract.ts';
import { sessionPaths } from '../../v0/agent/session/session_store.ts';
import {
  createWorkerSession,
  readDefinitionRevision,
  workerBuiltinModulePath,
  type WorkerHostCapsule,
  WorkerHostSession,
} from '../../v0/agent/worker/worker_host.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { roleDefaultModelSelection } from '../../v0/agent/provider/model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { selectModelFor } from '../../v0/agent/provider/model_catalog.ts';
import { main as sessionCliMain } from '../../v0/agent/cli/session_cli.ts';
import { main as diagnosticCliMain } from '../../v0/agent/cli/failure_diagnostic_cli.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';

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

const openHistoryHost = async (
  store: SqliteHistoryStore,
  workspaceRoot: string,
  sessionId?: string,
) => {
  const modulePath = workerBuiltinModulePath('default');
  const definition = await readDefinitionRevision(
    modulePath,
    'builtin',
    'default',
  );
  const handle = sessionId === undefined
    ? await store.allocateWorker('default', definition)
    : await store.openExistingWorker(sessionId);
  const host = await WorkerHostSession.open({
    handle,
    workspaceRoot,
    agent: 'default',
    definition,
    modulePath,
    physicalIoMode: 'provider-free',
    providerEvidenceStore: store.providerEvidence,
    executionArtifactStore: store.executionArtifacts,
    historyPersistence: store,
    durableCanonicalHistory: true,
  });
  return { host, id: handle.id };
};

const settledOutcome = (task: string) => ({
  ok: false,
  task,
  outcome: 'cancelled' as const,
  stopReason: 'cancelled' as const,
  error: 'cancelled',
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

const nonCanonicalInput = (ordinal: number) => {
  const suffix = ordinal.toString(16).padStart(12, '0');
  const task = `non-canonical ${ordinal}`;
  return {
    taskId: `10000000-0000-4000-8000-${suffix}`,
    executionId: `20000000-0000-4000-8000-${suffix}`,
    createdAt: '2026-09-12T00:00:00.000Z',
    sessionCorrelation: 'no-session-correlation',
    turn: ordinal,
    task,
    baseStateRevision: 1,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    definition: {
      schemaVersion: 1 as const,
      resourceKind: 'agent-definition' as const,
      resourceId: 'builtin/default',
      revision: { algorithm: 'sha256' as const, digest: '0'.repeat(64) },
    },
    outcome: settledOutcome(task),
  };
};

class ScriptedCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();
  private turnCount = 0;

  constructor(
    private readonly failFirst = false,
    private readonly failAcceptedAcknowledgement = false,
    private readonly rejectModelSelection = false,
  ) {}

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
          plannerModel: roleDefaultModelSelection('subagent:planner'),
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
          authProfile: 'openrouter-api-key',
          status: 'unknown',
        },
      });
      return;
    }
    if (command.kind === 'turn') {
      this.turnCount += 1;
      const current = this.turnCount;
      queueMicrotask(() => {
        if (this.failFirst && current === 1) {
          const diagnostic = {
            schemaVersion: 1 as const,
            diagnosticId: '30000000-0000-4000-8000-000000000040',
            stage: 'turn_control' as const,
            code: 'turn_cancelled' as const,
            lane: 'parent' as const,
            providerRequestCount: 0,
            occurredAt: '2026-09-12T00:00:00.000Z',
            turnNumber: 1,
            modelStep: 0,
            retryCount: 0,
          };
          this.emit({
            kind: 'turn_failed',
            correlation: command.correlation,
            outcome: { ...settledOutcome(command.task), diagnostic },
            diagnostic,
            providerEvidence: {
              schemaVersion: 1,
              evidenceId: '40000000-0000-4000-8000-000000000040',
              turnNumber: 1,
              createdAt: '2026-09-12T00:00:00.000Z',
              requests: [],
              runtimeEvents: [],
              outcome: 'cancelled',
              diagnosticId: diagnostic.diagnosticId,
            },
          });
          return;
        }
        this.emit({
          kind: 'commit_proposal',
          correlation: command.correlation,
          nextTurn: 2,
          transcript: [
            { role: 'user', content: { kind: 'text', text: command.task } },
            {
              role: 'assistant',
              content: { kind: 'text', text: 'SQLite answer' },
            },
          ],
        });
      });
      return;
    }
    if (command.kind === 'select_model') {
      queueMicrotask(() => {
        this.emit({
          kind: 'model_selected',
          correlation: command.correlation,
          accepted: !this.rejectModelSelection,
          ...(this.rejectModelSelection ? {} : {
            manifest: {
              role: 'parent' as const,
              maxSteps: 8,
              profileId: modelRouteProfileId(command.selection),
              resources: [],
              rootModel: command.selection,
              plannerModel: roleDefaultModelSelection('subagent:planner'),
            },
            credentialAvailability: {
              authProfile: command.selection.authProfile,
              status: 'unknown' as const,
            },
          }),
        });
      });
      return;
    }
    if (command.kind === 'commit_acknowledgement' && command.accepted) {
      if (this.failAcceptedAcknowledgement) {
        throw new Error('ack delivery failed');
      }
      queueMicrotask(() =>
        this.emit({
          kind: 'runtime_event',
          correlation: command.correlation,
          sequence: 1,
          event: {
            kind: 'agent_event',
            event: {
              kind: 'turn_end',
              turn: 1,
              outcome: 'final',
              committed: true,
            },
          },
        })
      );
      return;
    }
    if (command.kind === 'close') {
      this.emit({ kind: 'closed', correlation: command.correlation });
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {}
}

Deno.test('Increment 40 ignores old JSON and starts with an empty SQLite authority', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-destructive-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const oldId = '00000000-0000-4000-8000-000000000040';
  const oldBytes = new TextEncoder().encode('{"old":"session"}\n');
  try {
    await Deno.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await Deno.chmod(stateRoot, 0o700);
    await Deno.mkdir(paths.root, { recursive: true, mode: 0o700 });
    await Deno.chmod(paths.root, 0o700);
    await Deno.mkdir(`${paths.sessions}/${oldId}`, {
      recursive: true,
      mode: 0o700,
    });
    await Deno.writeFile(`${paths.sessions}/${oldId}/session.json`, oldBytes);
    await Deno.mkdir(paths.contexts, { recursive: true });
    await Deno.writeTextFile(
      `${paths.contexts}/${oldId}.json`,
      '{"old":"checkpoint"}\n',
    );

    const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    await store.initialize();
    assertEquals(await store.listWorker(), { sessions: [], skippedInvalid: 0 });
    let notFound = false;
    try {
      await store.readWorker(oldId);
    } catch (error) {
      notFound = typeof error === 'object' && error !== null &&
        (error as { readonly code?: unknown }).code === 'session_not_found';
    }
    assert(notFound);
    let cliStderr = '';
    assertEquals(
      await sessionCliMain(
        ['delete', '--session', oldId, '--yes'],
        {
          workspaceRoot,
          stateRoot,
          writeStderr: (text) => {
            cliStderr += text;
          },
        },
      ),
      1,
    );
    assertEquals(JSON.parse(cliStderr).error.code, 'session_not_found');
    let diagnosticStderr = '';
    assertEquals(
      await diagnosticCliMain(
        ['delete', '--id', oldId, '--yes'],
        {
          workspaceRoot,
          stateRoot,
          writeStderr: (text) => {
            diagnosticStderr += text;
          },
        },
      ),
      1,
    );
    assertEquals(JSON.parse(diagnosticStderr).error.code, 'diagnostic_not_found');
    assertEquals(
      [...await Deno.readFile(`${paths.sessions}/${oldId}/session.json`)],
      [...oldBytes],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 commits and reopens canonical history through SQLite', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-canonical-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let first: Awaited<ReturnType<typeof openHistoryHost>> | undefined;
  let second: Awaited<ReturnType<typeof openHistoryHost>> | undefined;
  try {
    await store.initialize();
    first = await openHistoryHost(store, workspaceRoot);
    assertEquals(
      await first.host.selectModel(
        selectModelFor('openai-responses', 'gpt-5.6-terra', 'high'),
      ),
      'selected',
    );
    assertEquals(first.host.renameTitle('SQLite session'), 'renamed');
    const outcome = await first.host.submit('first SQLite turn');
    assert(outcome.ok);
    assertEquals(outcome.executionArtifactDurability, 'yes');
    const sessionId = first.id;
    await first.host.close();
    first = undefined;

    const stored = await store.readWorker(sessionId);
    assertEquals(stored.stateRevision, 4);
    assertEquals(stored.nextTurn, 2);
    assertEquals(stored.title, 'SQLite session');
    const checkpointHandle = await store.openExistingWorker(sessionId);
    checkpointHandle.installCheckpoint({
      contextSchemaVersion: 1,
      sessionId,
      createdAt: '2026-09-12T00:00:00.000Z',
      sourceProfileId: modelRouteProfileId(
        selectModelFor('openai-responses', 'gpt-5.6-terra', 'high'),
      ),
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
      summary: 'first turn summary',
    });
    await checkpointHandle.close();
    assertEquals((await store.executionArtifacts.list()).length, 1);

    second = await openHistoryHost(store, workspaceRoot, sessionId);
    assertEquals(
      second.host.checkpointSnapshot()?.summary,
      'first turn summary',
    );
    assert((await second.host.submit('second SQLite turn')).ok);
    await second.host.close();
    second = undefined;
    const reopened = await store.readWorker(sessionId);
    assertEquals(reopened.stateRevision, 5);
    assertEquals(reopened.nextTurn, 3);

    const path = `${(await sessionPaths(stateRoot, workspaceRoot)).root}/history-v4.sqlite3`;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assertEquals(
        db.prepare(`
          SELECT
            (SELECT count(*) FROM tasks) AS tasks,
            (SELECT count(*) FROM executions) AS executions,
            (SELECT count(*) FROM canonical_turns) AS turns,
            (SELECT count(*) FROM execution_artifacts) AS artifacts
        `).get(),
        { tasks: 2, executions: 2, turns: 2, artifacts: 2 },
      );
    } finally {
      db.close();
    }
  } finally {
    await second?.host.close();
    await first?.host.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 production composition creates and reopens a persistent SQLite Session', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-composition-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let reopened: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot: `${root}/data`,
      configRoot: `${root}/config`,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'production',
      capsuleFactory: () => new ScriptedCapsule(),
    });
    const sessionId = created.session.sessionId;
    assert((await created.session.submit('production composition turn')).ok);
    await created.close();
    created = undefined;

    reopened = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot: `${root}/data`,
      configRoot: `${root}/config`,
      persistence: 'session',
      sessionId,
      physicalIoMode: 'production',
      capsuleFactory: () => new ScriptedCapsule(),
    });
    assertEquals(reopened.session.currentPosition().committedTurn, 1);
    assertEquals(reopened.session.transcriptSnapshot().at(-1), {
      role: 'assistant',
      content: { kind: 'text', text: 'SQLite answer' },
    });
  } finally {
    await reopened?.close();
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 rolls back a rejected model selection in SQLite', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-model-rollback-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
      historyPersistence: store,
      durableCanonicalHistory: true,
      capsuleFactory: () => new ScriptedCapsule(false, false, true),
    });
    assertEquals(host.renameTitle('before rejected model'), 'renamed');
    let rejected = false;
    try {
      await host.selectModel(selectModelFor('openai-responses', 'gpt-5.6-terra', 'high'));
    } catch {
      rejected = true;
    }
    assert(rejected);
    const record = await store.readWorker(handle.id);
    assertEquals(record.title, 'before rejected model');
    assertEquals(record.stateRevision, 2);
    assertEquals(record.activeModel, ROOT_DEFAULT_MODEL_SELECTION);
    assertEquals(record.modelChanges.length, 1);
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 preserves canonical commit when accepted acknowledgement delivery fails', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-ack-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
      providerEvidenceStore: store.providerEvidence,
      executionArtifactStore: store.executionArtifacts,
      historyPersistence: store,
      durableCanonicalHistory: true,
      capsuleFactory: () => new ScriptedCapsule(false, true),
    });
    const outcome = await host.submit('commit before ack failure');
    assert(outcome.ok);
    assertEquals(outcome.executionArtifactDurability, 'yes');
    const stored = await store.readWorker(handle.id);
    assertEquals(
      { revision: stored.stateRevision, nextTurn: stored.nextTurn },
      {
        revision: 2,
        nextTurn: 2,
      },
    );
    const artifact = (await store.executionArtifacts.list())[0];
    assertEquals(artifact?.acknowledgement, 'delivery_failed');
    assertEquals(artifact?.settlement, 'committed_generation_unavailable');
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 exposes a canonical execution while post-commit observation is pending', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i40-observation-pending-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const handle = await store.allocateWorker('default', definition);
    const observationFails: HistoryPersistencePort = {
      beginExecution: (input) => store.beginExecution(input),
      appendExecutionEvent: (input) => store.appendExecutionEvent(input),
      reconcileExecution: (input) => store.reconcileExecution(input),
      listExecutions: () => store.listExecutions(),
      readExecution: (id) => store.readExecution(id),
      listExecutionEvents: (id) => store.listExecutionEvents(id),
      listExecutionEffects: (id) => store.listExecutionEffects(id),
      listExecutionContext: (id) => store.listExecutionContext(id),
      readExecutionRequest: (id, ordinal) => store.readExecutionRequest(id, ordinal),
      commitCanonicalTurn: (input) => store.commitCanonicalTurn(input),
      settleNonCanonicalExecution: (input) => store.settleNonCanonicalExecution(input),
      recordPostCommitObservation: () => {
        throw new HistoryStoreError('history_io_failure');
      },
    };
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
      providerEvidenceStore: store.providerEvidence,
      executionArtifactStore: store.executionArtifacts,
      historyPersistence: observationFails,
      durableCanonicalHistory: true,
      capsuleFactory: () => new ScriptedCapsule(),
    });

    const outcome = await host.submit('commit before post observation failure');
    assert(outcome.ok);
    assertEquals(outcome.executionArtifactDurability, 'failed');
    const stored = await store.readWorker(handle.id);
    assertEquals(
      { revision: stored.stateRevision, nextTurn: stored.nextTurn },
      {
        revision: 2,
        nextTurn: 2,
      },
    );
    const artifact = (await store.executionArtifacts.list())[0];
    assertEquals(artifact?.storeResult, 'committed');
    assertEquals(artifact?.committedStateRevision, 2);
    assertEquals(artifact?.acknowledgement, 'not_sent');
    assertEquals(artifact?.settlement, 'committed_observation_pending');
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 enforces Session writer ownership and preserves execution evidence on delete', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-session-lock-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let first: Awaited<ReturnType<typeof openHistoryHost>> | undefined;
  let other: Awaited<ReturnType<typeof openHistoryHost>> | undefined;
  try {
    await store.initialize();
    first = await openHistoryHost(store, workspaceRoot);
    assert((await first.host.submit('retained after Session delete')).ok);
    let busy = false;
    try {
      await new SqliteHistoryStore(stateRoot, workspaceRoot).openExistingWorker(
        first.id,
      );
    } catch (error) {
      busy = error instanceof Error &&
        (error as { readonly code?: unknown }).code === 'session_busy';
    }
    assert(busy);

    other = await openHistoryHost(store, workspaceRoot);
    assert(first.id !== other.id);
    await other.host.close();
    other = undefined;
    const sessionId = first.id;
    await first.host.close();
    first = undefined;
    await store.delete(sessionId);

    assertEquals((await store.listWorker()).sessions.length, 0);
    assertEquals((await store.executionArtifacts.list()).length, 1);
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history-v4.sqlite3`, {
      readOnly: true,
    });
    try {
      assertEquals(
        db.prepare(`
          SELECT canonical_session_id, adoption
          FROM executions
        `).get(),
        { canonical_session_id: null, adoption: 'canonical' },
      );
    } finally {
      db.close();
    }
  } finally {
    await other?.host.close();
    await first?.host.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 rejects an unknown SQLite schema without reading old JSON', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-schema-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const oldId = '00000000-0000-4000-8000-000000000041';
  try {
    await Deno.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await Deno.chmod(stateRoot, 0o700);
    await Deno.mkdir(paths.root, { recursive: true, mode: 0o700 });
    await Deno.chmod(paths.root, 0o700);
    await Deno.mkdir(`${paths.sessions}/${oldId}`, { recursive: true });
    await Deno.writeTextFile(
      `${paths.sessions}/${oldId}/session.json`,
      '{"old":true}\n',
    );
    const db = new DatabaseSync(`${paths.root}/history-v4.sqlite3`);
    db.exec('PRAGMA user_version = 99');
    db.close();

    const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    let invalid = false;
    try {
      await store.initialize();
    } catch (error) {
      invalid = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(invalid);
    let stderr = '';
    assertEquals(
      await sessionCliMain(['list'], {
        workspaceRoot,
        stateRoot,
        writeStderr: (text) => {
          stderr += text;
        },
      }),
      1,
    );
    assertEquals(JSON.parse(stderr).error.code, 'session_invalid');
    assertEquals(
      await Deno.readTextFile(`${paths.sessions}/${oldId}/session.json`),
      '{"old":true}\n',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 persists no-session execution without a canonical Session row', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-no-session-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot: `${root}/data`,
      configRoot: `${root}/config`,
      persistence: 'none',
      agent: 'default',
      physicalIoMode: 'production',
      capsuleFactory: () => new ScriptedCapsule(),
    });
    const outcome = await created.session.submit('headless SQLite turn');
    assert(outcome.ok);
    assertEquals(outcome.executionArtifactDurability, 'yes');
    await created.close();
    created = undefined;

    const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    await store.initialize();
    assertEquals((await store.listWorker()).sessions.length, 0);
    assertEquals((await store.executionArtifacts.list()).length, 1);

    let sessionStdout = '';
    assertEquals(
      await sessionCliMain(['list'], {
        workspaceRoot,
        stateRoot,
        writeStdout: (text) => {
          sessionStdout += text;
        },
      }),
      0,
    );
    assertEquals(JSON.parse(sessionStdout).sessions, []);
    let executionStdout = '';
    assertEquals(
      await diagnosticCliMain(['executions', 'list'], {
        workspaceRoot,
        stateRoot,
        writeStdout: (text) => {
          executionStdout += text;
        },
      }),
      0,
    );
    assertEquals(JSON.parse(executionStdout).executions.length, 1);
  } finally {
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 recalls a post-cutover non-canonical execution only', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-recall-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
      providerEvidenceStore: store.providerEvidence,
      executionArtifactStore: store.executionArtifacts,
      historyPersistence: store,
      durableCanonicalHistory: true,
      capsuleFactory: () => new ScriptedCapsule(true),
    });
    const failed = await host.submit('stopped task');
    assert(!failed.ok);
    const source = (await store.executionArtifacts.list())[0];
    assert(source !== undefined && source.settlement === 'uncommitted');
    assertEquals(await host.prepareRecall(source.executionId), {
      sourceExecutionId: source.executionId,
      evidence: 'available',
    });
    assertEquals((await store.providerEvidence.list()).length, 1);
    assertEquals((await store.diagnostics.list()).length, 1);
    assertEquals(
      await store.providerEvidence.readDiagnosticLink(
        '30000000-0000-4000-8000-000000000040',
      ),
      '40000000-0000-4000-8000-000000000040',
    );
    assert((await host.submit('use recalled task')).ok);
    const artifacts = await store.executionArtifacts.list();
    assertEquals(artifacts.length, 2);
    const target = artifacts[1];
    assert(target?.schemaVersion === 7);
    assertEquals(target.recall?.sourceExecutionId, source.executionId);
    const record = await store.readWorker(handle.id);
    assert(
      !JSON.stringify(record.transcript).includes(
        '[henji-recalled-execution:v1]',
      ),
    );
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 rolls back a failed canonical SQL statement without partial rows', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-rollback-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let opened: Awaited<ReturnType<typeof openHistoryHost>> | undefined;
  try {
    await store.initialize();
    opened = await openHistoryHost(store, workspaceRoot);
    assertEquals(opened.host.renameTitle('rollback baseline'), 'renamed');
    const path = `${(await sessionPaths(stateRoot, workspaceRoot)).root}/history-v4.sqlite3`;
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TRIGGER fail_canonical_turn BEFORE INSERT ON canonical_turns
      BEGIN SELECT RAISE(ABORT, 'forced canonical statement failure'); END;
    `);
    db.close();

    const outcome = await opened.host.submit('must roll back');
    assert(!outcome.ok);
    const saved = await store.readWorker(opened.id);
    assertEquals(
      { revision: saved.stateRevision, nextTurn: saved.nextTurn, title: saved.title },
      { revision: 2, nextTurn: 1, title: 'rollback baseline' },
    );
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      assertEquals(
        verify.prepare(`
          SELECT
            (SELECT count(*) FROM tasks) AS tasks,
            (SELECT count(*) FROM executions) AS executions,
            (SELECT count(*) FROM canonical_turns) AS turns,
            (SELECT count(*) FROM execution_messages) AS messages,
            (SELECT count(*) FROM provider_evidence) AS evidence,
            (SELECT count(*) FROM execution_artifacts) AS artifacts,
            (SELECT adoption FROM executions LIMIT 1) AS adoption
        `).get(),
        {
          tasks: 1,
          executions: 1,
          turns: 0,
          messages: 2,
          evidence: 1,
          artifacts: 1,
          adoption: 'non_canonical',
        },
      );
    } finally {
      verify.close();
    }
  } finally {
    await opened?.host.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 settles non-canonical execution and artifact in one transaction', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i40-noncanonical-rollback-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
      providerEvidenceStore: store.providerEvidence,
      executionArtifactStore: store.executionArtifacts,
      historyPersistence: store,
      durableCanonicalHistory: true,
      capsuleFactory: () => new ScriptedCapsule(true),
    });
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const path = `${paths.root}/history-v4.sqlite3`;
    const fault = new DatabaseSync(path);
    fault.exec(`
      CREATE TRIGGER fail_noncanonical_artifact BEFORE INSERT ON execution_artifacts
      BEGIN SELECT RAISE(ABORT, 'forced artifact statement failure'); END;
    `);
    fault.close();

    const outcome = await host.submit('all non-canonical rows roll back');
    assert(!outcome.ok);
    assertEquals(outcome.executionArtifactDurability, 'failed');
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      assertEquals(
        verify.prepare(`
          SELECT
            (SELECT count(*) FROM tasks) AS tasks,
            (SELECT count(*) FROM executions) AS executions,
            (SELECT count(*) FROM provider_evidence) AS evidence,
            (SELECT count(*) FROM failure_diagnostics) AS diagnostics,
            (SELECT count(*) FROM execution_artifacts) AS artifacts
        `).get(),
        { tasks: 1, executions: 1, evidence: 0, diagnostics: 0, artifacts: 0 },
      );
      assertEquals(
        verify.prepare('SELECT lifecycle, outcome FROM executions').get(),
        { lifecycle: 'active', outcome: 'unknown' },
      );
    } finally {
      verify.close();
    }
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 keeps diagnostic capacity local to diagnostic capture', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-diagnostics-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  try {
    await store.initialize();
    for (let ordinal = 1; ordinal <= 17; ordinal += 1) {
      const input = nonCanonicalInput(ordinal);
      const suffix = ordinal.toString(16).padStart(12, '0');
      await store.beginExecution({ ...input, sessionMode: 'no_session' });
      const result = store.settleNonCanonicalExecution({
        ...input,
        diagnostic: {
          schemaVersion: 1,
          diagnosticId: `30000000-0000-4000-8000-${suffix}`,
          stage: 'turn_control',
          code: 'turn_cancelled',
          lane: 'parent',
          providerRequestCount: 0,
          occurredAt: `2026-09-12T00:00:${ordinal.toString().padStart(2, '0')}.000Z`,
          turnNumber: ordinal,
          modelStep: 0,
          retryCount: 0,
        },
      });
      assertEquals(
        result.diagnosticPersistenceError,
        ordinal === 17 ? 'diagnostic_capacity' : undefined,
      );
    }
    assertEquals((await store.diagnostics.list()).length, 16);
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history-v4.sqlite3`, {
      readOnly: true,
    });
    try {
      assertEquals(
        db.prepare(`
          SELECT
            count(*) AS count,
            max(CASE WHEN execution_id = ? THEN diagnostic_capture END) AS capacity_capture
          FROM executions
        `).get('20000000-0000-4000-8000-000000000011'),
        { count: 17, capacity_capture: 'diagnostic_capacity' },
      );
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 40 waits briefly and returns typed busy after 250 ms', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i40-busy-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  try {
    await store.initialize();
    const path = `${(await sessionPaths(stateRoot, workspaceRoot)).root}/history-v4.sqlite3`;
    const run = async (holdMs: number, ordinal: number) => {
      const worker = new Worker(
        new URL('./fixtures/increment_40_busy_worker.ts', import.meta.url).href,
        { type: 'module', deno: { permissions: 'inherit' } },
      );
      let resolveLocked: () => void = () => {};
      let resolveReleased: () => void = () => {};
      const locked = new Promise<void>((resolve) => {
        resolveLocked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        resolveReleased = resolve;
      });
      worker.onmessage = (event) => {
        if (event.data === 'locked') resolveLocked();
        if (event.data === 'released') resolveReleased();
      };
      worker.postMessage({ database: path, holdMs });
      await locked;
      try {
        const input = nonCanonicalInput(ordinal);
        await store.beginExecution({ ...input, sessionMode: 'no_session' });
        return store.settleNonCanonicalExecution(input);
      } finally {
        await released;
        worker.terminate();
      }
    };

    assertEquals(await run(100, 40).then(() => 'committed'), 'committed');
    let busy = false;
    try {
      await run(600, 41);
    } catch (error) {
      busy = error instanceof HistoryStoreError &&
        error.code === 'history_busy';
    }
    assert(busy);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
