import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { roleDefaultModelSelection } from '../../v0/agent/provider/model_catalog.ts';
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
          plannerModel: roleDefaultModelSelection('subagent:planner'),
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
