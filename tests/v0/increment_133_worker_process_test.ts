import { ManagedDefinitionStore } from '../../v0/agent/definitions/managed_definition_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import { readWorkerModuleRevision } from '../../v0/agent/worker/worker_capsule.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import type { WorkerSessionHandle } from '../../v0/agent/session/session_store_contract.ts';
import type { WorkerToHostMessage } from '../../v0/agent/worker/worker_protocol.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';

const assert = (value: unknown, message = 'assertion failed'): void => {
  if (!value) throw new Error(message);
};
const modulePath =
  new URL('./fixtures/increment_133_process_definition.ts', import.meta.url).pathname;
const ref = {
  schemaVersion: 1,
  resourceKind: 'agent-definition',
  resourceId: 'test/process-probe',
  revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
} as const;
const handle = (): WorkerSessionHandle => ({
  id: crypto.randomUUID(),
  commit: () => {},
  rollback: () => {},
  installCheckpoint: () => {},
  rollbackCheckpoint: () => {},
  close: () => Promise.resolve(),
});
const pid = async (root: string): Promise<number> => {
  for (let i = 0; i < 300; i++) {
    try {
      const value = Number(await Deno.readTextFile(`${root}/pid`));
      if (value > 0) return value;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('process did not start');
};
const alive = async (value: number): Promise<boolean> => {
  const probe = await new Deno.Command('/bin/bash', {
    args: [
      '-c',
      'if read -r stat < /proc/$1/stat; then rest=${stat##*) }; [[ ${rest%% *} != Z ]]; else exit 1; fi',
      'probe',
      String(value),
    ],
    stdout: 'null',
    stderr: 'null',
  }).output();
  return probe.success;
};

Deno.test('Worker process proxy retains returned background work until Session close', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-host-' });
  const observed: WorkerToHostMessage[] = [];
  const session = await WorkerHostSession.open({
    handle: handle(),
    agent: 'default',
    definition: ref,
    modulePath,
    workspaceRoot: root,
    physicalIoMode: 'provider-free',
    capsuleFactory: (url) => {
      const capsule = new WorkerCapsule(url);
      capsule.subscribe((message) => {
        if (message.kind !== 'process_request') observed.push(message);
      });
      return capsule;
    },
  });
  try {
    const outcome = await session.submit('background');
    assert(outcome.ok, JSON.stringify(outcome));
    const child = await pid(root);
    assert(await alive(child), 'normal return killed background process');
    assert(
      !JSON.stringify(observed).includes('raw-process-'),
      'raw output entered semantic messages',
    );
    await session.close();
    assert(!await alive(child), 'Session close returned with live process');
  } finally {
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Host cancellation and replacement await physical cleanup after an uncooperative Worker tool', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-replace-' });
  const session = await WorkerHostSession.open({
    handle: handle(),
    agent: 'default',
    definition: ref,
    modulePath,
    workspaceRoot: root,
    physicalIoMode: 'provider-free',
    cancelSettlementGraceMs: 30,
  });
  try {
    const submitted = session.submit('uncooperative');
    const command = await pid(root);
    assert(await alive(command));
    session.cancelActiveTurn();
    try {
      await submitted;
    } catch { /* Cancelled outcome may use the existing cancellation error. */ }
    assert(!await alive(command), 'cancel settled before physical cleanup');
    assert((await session.submit('answer')).ok, 'replacement generation did not start');
  } finally {
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Child collect joins its Supervisor process cleanup before returning completion', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-child-' });
  const registry = new ChildRunRegistry({
    options: {
      handle: handle(),
      agent: 'default',
      definition: ref,
      workspaceRoot: root,
      physicalIoMode: 'provider-free',
    },
    catalog: [{ name: 'probe', ref }],
    resolveManagedModule: () => readWorkerModuleRevision(modulePath),
    build: buildManifest(),
  });
  const parent = crypto.randomUUID();
  registry.openParent(parent);
  try {
    const spawned = await registry.handle(
      { kind: 'spawn', agent: 'probe', task: 'background' },
      'spawn-call',
      parent,
    );
    if (!spawned.ok || spawned.kind !== 'spawn') throw new Error(JSON.stringify(spawned));
    const result = await registry.handle(
      { kind: 'collect', runId: spawned.runId },
      'collect-call',
      parent,
    );
    assert(
      result.ok && result.kind === 'collect' && result.result.state === 'completed',
      JSON.stringify(result),
    );
    assert(!await alive(await pid(root)), 'collect returned with live child process');
  } finally {
    await registry.cleanupAll();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Cancelling a running call preserves the same generation’s normally returned background work', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-soft-cancel-' });
  const session = await WorkerHostSession.open({
    handle: handle(),
    agent: 'default',
    definition: ref,
    modulePath,
    workspaceRoot: root,
    physicalIoMode: 'provider-free',
    cancelSettlementGraceMs: 2_000,
  });
  try {
    assert((await session.submit('background')).ok);
    const background = await pid(root);
    await Deno.remove(`${root}/pid`);
    const submitted = session.submit('cancellable');
    const running = await pid(root);
    session.cancelActiveTurn();
    try {
      await submitted;
    } catch { /* Existing cancellation API. */ }
    assert(!await alive(running), 'running call survived cancellation');
    assert(await alive(background), 'normal background call was cancelled with a later call');
    await session.close();
    assert(!await alive(background));
  } finally {
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('/new adopts after old process cleanup and preserves old work when target preparation fails', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-new-' });
  const revision = await new ManagedDefinitionStore({ dataRoot: `${root}/data` }).install({
    entryPath: modulePath,
    resourceId: 'test/process-navigation',
    declaredRole: 'parent',
  });
  const created = await createWorkerSession({
    workspaceRoot: root,
    stateRoot: `${root}/state`,
    dataRoot: `${root}/data`,
    configRoot: `${root}/config`,
    persistence: 'new',
    physicalIoMode: 'provider-free',
    selection: { kind: 'managed', id: 'default', ref: revision.manifest.logicalRef, revision },
  });
  try {
    assert((await created.session.submit('background')).ok);
    const oldProcess = await pid(root);
    const next = await created.navigation!.createNew!();
    assert(!await alive(oldProcess), 'new binding adopted before old process cleanup');
    await Deno.remove(`${root}/pid`);
    assert((await next.session.submit('background')).ok);
    const retained = await pid(root);
    const oldId = created.navigation!.currentPosition().sessionId;
    await Deno.writeTextFile(revision.entryPath, '\n');
    let failed = false;
    try {
      await created.navigation!.createNew!();
    } catch {
      failed = true;
    }
    assert(failed, 'target integrity failure did not reach navigation');
    assert(created.navigation!.currentPosition().sessionId === oldId);
    assert(await alive(retained), 'failed target preparation closed the old process owner');
    await created.close();
    assert(!await alive(retained));
  } finally {
    await created.close();
    await Deno.remove(root, { recursive: true });
  }
});
