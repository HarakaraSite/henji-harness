import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type {
  WorkerReadyMessage,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import {
  processProbeCall as processCall,
  processProbeChoice as choice,
  writeProcessProbeConfiguration,
} from './helpers/increment_133_process_probe.ts';

const assert = (value: unknown, message = 'assertion failed'): void => {
  if (!value) throw new Error(message);
};

const dataSession = async (
  root: string,
  observed?: WorkerToHostMessage[],
  cancelSettlementGraceMs?: number,
) => {
  const configRoot = `${root}/config`;
  await writeProcessProbeConfiguration(configRoot);
  const data = await createDataClient({
    stateRoot: `${root}/state`,
    workspaceRoot: root,
  });
  const descriptor = await data.openSession({
    persistence: 'none',
    agent: choice.name,
    agentChoice: choice,
  });
  let ready: WorkerReadyMessage | undefined;
  const session = await WorkerHostSession.open({
    data,
    descriptor,
    workspaceRoot: root,
    configRoot,
    credentialRoot: `${root}/credentials`,
    agentChoice: choice,
    physicalIoMode: 'provider-free',
    ...(cancelSettlementGraceMs === undefined ? {} : { cancelSettlementGraceMs }),
    capsuleFactory: (url) => {
      const capsule = new WorkerCapsule(url);
      capsule.subscribe((message) => {
        if (message.kind === 'ready') ready = message;
        if (message.kind !== 'process_request') observed?.push(message);
      });
      return capsule;
    },
  });
  return {
    data,
    descriptor,
    session,
    configRoot,
    credentialRoot: `${root}/credentials`,
    async seedParentExecution(executionId: string): Promise<void> {
      if (ready === undefined) {
        throw new Error('parent Worker did not report ready');
      }
      await data.executionAdmit(descriptor.id, {
        executionId,
        taskId: executionId,
        task: 'process probe parent fixture',
        correlation: ready.correlation,
        createdAt: new Date().toISOString(),
      });
    },
  };
};

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
  const state = await dataSession(root, observed);
  try {
    const outcome = await state.session.submit(processCall('background'));
    assert(outcome.ok, JSON.stringify(outcome));
    const child = await pid(root);
    assert(await alive(child), 'normal return killed background process');
    assert(
      !JSON.stringify(observed).includes('raw-process-'),
      'raw output entered semantic messages',
    );
    await state.session.close();
    assert(!await alive(child), 'Session close returned with live process');
  } finally {
    await state.session.close();
    await state.data.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Host cancellation and replacement await physical cleanup after an uncooperative Worker tool', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-replace-' });
  const state = await dataSession(root, undefined, 30);
  try {
    const submitted = state.session.submit(processCall('uncooperative'));
    const command = await pid(root);
    assert(await alive(command));
    state.session.cancelActiveTurn();
    try {
      await submitted;
    } catch { /* Cancelled outcome may use the existing cancellation error. */ }
    assert(!await alive(command), 'cancel settled before physical cleanup');
    assert(
      (await state.session.submit(processCall('answer'))).ok,
      'replacement generation did not start',
    );
  } finally {
    await state.session.close();
    await state.data.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Child collect joins its Supervisor process cleanup before returning completion', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-child-' });
  const state = await dataSession(root);
  const registry = new ChildRunRegistry({
    options: {
      data: state.data,
      descriptor: state.descriptor,
      workspaceRoot: root,
      configRoot: state.configRoot,
      credentialRoot: state.credentialRoot,
      agentChoice: choice,
      physicalIoMode: 'provider-free',
    },
    currentCatalog: () => [choice.name],
  });
  const parent = crypto.randomUUID();
  await state.seedParentExecution(parent);
  registry.openParent(parent);
  try {
    const spawned = await registry.handle(
      { kind: 'spawn', agent: choice.name, task: processCall('background') },
      'spawn-call',
      parent,
    );
    if (!spawned.ok || spawned.kind !== 'spawn') {
      throw new Error(JSON.stringify(spawned));
    }
    const result = await registry.handle(
      { kind: 'collect', runId: spawned.runId },
      'collect-call',
      parent,
    );
    assert(
      result.ok && result.kind === 'collect' &&
        result.result.state === 'completed',
      JSON.stringify(result),
    );
    assert(
      !await alive(await pid(root)),
      'collect returned with live child process',
    );
  } finally {
    await registry.cleanupAll();
    await state.session.close();
    await state.data.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Cancelling a running call preserves the same generation’s normally returned background work', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-soft-cancel-' });
  const state = await dataSession(root);
  try {
    assert((await state.session.submit(processCall('background'))).ok);
    const background = await pid(root);
    await Deno.remove(`${root}/pid`);
    const submitted = state.session.submit(processCall('cancellable'));
    const running = await pid(root);
    state.session.cancelActiveTurn();
    try {
      await submitted;
    } catch { /* Existing cancellation API. */ }
    assert(!await alive(running), 'running call survived cancellation');
    assert(
      await alive(background),
      'normal background call was cancelled with a later call',
    );
    await state.session.close();
    assert(!await alive(background));
  } finally {
    await state.session.close();
    await state.data.close();
    await Deno.remove(root, { recursive: true });
  }
});
