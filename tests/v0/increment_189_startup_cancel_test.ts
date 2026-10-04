import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { createApplicationService } from '../../v0/agent/host/application_service.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { DataService } from '../../v0/agent/data/data_contract.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import {
  closeChildDataTests,
  createChildDataTestRegistry,
} from './helpers/increment_170_child_data.ts';

const within = async <T>(promise: Promise<T>, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const waitFor = async (
  predicate: () => boolean,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value));
};

Deno.test('Increment 189 explicit root cancellation settles a lazy Worker startup', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i189-root-start-cancel-',
  });
  const configRoot = `${root}/config`;
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  const startupMarker = `${root}/startup-marker`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: {},
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'root',
    instruction: 'startup cancellation fixture',
    tools: [],
    agents: [],
  });
  await writeJson(`${configRoot}/hooks.json`, {
    schemaVersion: 1,
    default: ['wait-for-cancel'],
    hooks: { 'wait-for-cancel': 'hooks/wait-for-cancel/index.ts' },
  });
  await Deno.mkdir(`${configRoot}/hooks/wait-for-cancel`, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/hooks/wait-for-cancel/index.ts`,
    `const marker = ${JSON.stringify(startupMarker)};\n` +
      `export default () => ({\n` +
      `  runtime_start: async () => {\n` +
      `    try { await Deno.stat(marker); return; } catch {}\n` +
      `    await Deno.writeTextFile(marker, 'started');\n` +
      `    await new Promise(() => {});\n` +
      `  },\n` +
      `});\n`,
  );

  let starts = 0;
  let turns = 0;
  let terminations = 0;
  let service: Awaited<ReturnType<typeof createApplicationService>> | undefined;
  const dataClient = await createDataClient({ stateRoot, workspaceRoot });
  let holdNextAdmission = false;
  let resolveSecondAdmission!: () => void;
  const secondAdmissionRequested = new Promise<void>((resolve) => {
    resolveSecondAdmission = resolve;
  });
  let releaseNextAdmission!: () => void;
  const nextAdmissionGate = new Promise<void>((resolve) => {
    releaseNextAdmission = resolve;
  });
  const data = new Proxy(dataClient, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'executionAdmit' && typeof value === 'function') {
        return (...args: Parameters<DataService['executionAdmit']>) => {
          if (holdNextAdmission) {
            holdNextAdmission = false;
            resolveSecondAdmission();
            return nextAdmissionGate.then(() => value.apply(target, args));
          }
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DataService;
  const admissionPromises: Promise<unknown>[] = [];
  try {
    service = await createApplicationService({
      workspaceRoot,
      stateRoot,
      configRoot,
      data,
      persistence: 'new',
      lazyInitialHost: true,
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 40,
      capsuleFactory: (url): WorkerHostCapsule => {
        const capsule = new WorkerCapsule(url);
        return {
          send(command, transfer) {
            if (command.kind === 'start') starts++;
            if (command.kind === 'turn') turns++;
            capsule.send(command, transfer);
          },
          subscribe: (listener) => capsule.subscribe(listener),
          terminate() {
            terminations++;
            capsule.terminate();
          },
        };
      },
    });
    const admissionPromise = service.tasks.admit(
      'cancel while runtime_start waits',
      'i189-cancel-root',
    );
    admissionPromises.push(admissionPromise);
    await waitFor(
      () => starts > 0,
      'root Worker did not receive its start command',
    );
    await within(
      (async () => {
        while (true) {
          try {
            await Deno.stat(startupMarker);
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      })(),
      'root runtime_start hook did not begin waiting',
    );
    const executionId = service.tasks.activeExecutionId();
    ok(executionId);
    strictEqual(service.query.currentSession().runtime.phase, 'preparing');
    strictEqual(service.tasks.cancel(executionId), 'requested');

    const admission = await within(
      admissionPromise,
      'cancelled root admission did not settle',
    );
    const outcome = await within(
      admission.completion,
      'cancelled root outcome did not settle',
    );
    strictEqual(outcome.outcome, 'cancelled');
    strictEqual(outcome.stopReason, 'cancelled');
    const persisted = await dataClient.executionRead(admission.executionId);
    strictEqual(persisted.execution.executionId, admission.executionId);
    strictEqual(persisted.execution.lifecycle, 'settled');
    strictEqual(persisted.execution.outcome, 'cancelled');
    strictEqual(persisted.execution.stopReason, 'cancelled');
    await waitFor(
      () => !service!.tasks.isBusy(),
      'root task service remained busy after cancellation',
    );
    strictEqual(service.query.currentSession().runtime.phase, 'idle');
    strictEqual(turns, 0);
    ok(
      terminations > 0,
      'explicit cancellation did not terminate the stalled startup Worker',
    );

    holdNextAdmission = true;
    const nextAdmissionPromise = service.tasks.admit(
      'cancel after the replacement Worker becomes ready',
      'i189-cancel-root-next',
    );
    admissionPromises.push(nextAdmissionPromise);
    await within(
      secondAdmissionRequested,
      'a new Worker was not started for the next task',
    );
    const nextExecutionId = service.tasks.activeExecutionId();
    ok(nextExecutionId);
    strictEqual(service.tasks.cancel(nextExecutionId), 'requested');
    releaseNextAdmission();
    const nextAdmission = await within(
      nextAdmissionPromise,
      'the next task admission did not settle after cancellation',
    );
    const nextOutcome = await within(
      nextAdmission.completion,
      'the next task cancellation result did not settle',
    );
    strictEqual(nextOutcome.outcome, 'cancelled');
    strictEqual(nextOutcome.stopReason, 'cancelled');
    await waitFor(
      () => !service!.tasks.isBusy(),
      'next task remained busy after cancellation',
    );
    strictEqual(starts, 2);
    strictEqual(turns, 0);
  } finally {
    const executionId = service?.tasks.activeExecutionId();
    if (executionId !== undefined) service?.tasks.cancel(executionId);
    releaseNextAdmission();
    await Promise.allSettled(admissionPromises);
    await service?.close();
    await dataClient.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 public Core execution readback records a cancelled startup', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i189-core-start-cancel-',
  });
  const configRoot = `${root}/config`;
  const workspaceRoot = `${root}/workspace`;
  const startupMarker = `${root}/startup-marker`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: {},
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'root',
    instruction: 'public startup cancellation fixture',
    tools: [],
    agents: [],
  });
  await writeJson(`${configRoot}/hooks.json`, {
    schemaVersion: 1,
    default: ['wait-for-cancel'],
    hooks: { 'wait-for-cancel': 'hooks/wait-for-cancel/index.ts' },
  });
  await Deno.mkdir(`${configRoot}/hooks/wait-for-cancel`, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/hooks/wait-for-cancel/index.ts`,
    `const marker = ${JSON.stringify(startupMarker)};\n` +
      `export default () => ({ runtime_start: async () => {\n` +
      `  await Deno.writeTextFile(marker, 'started');\n` +
      `  await new Promise(() => {});\n` +
      `} });\n`,
  );

  let starts = 0;
  let turns = 0;
  let terminations = 0;
  const core = await createCoreService({
    workspaceRoot,
    stateRoot: `${root}/state`,
    configRoot,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
    cancelSettlementGraceMs: 40,
    capsuleFactory: (url): WorkerHostCapsule => {
      const capsule = new WorkerCapsule(url);
      return {
        send(command, transfer) {
          if (command.kind === 'start') starts++;
          if (command.kind === 'turn') turns++;
          capsule.send(command, transfer);
        },
        subscribe: (listener) => capsule.subscribe(listener),
        terminate() {
          terminations++;
          capsule.terminate();
        },
      };
    },
  });
  const sessionId = core.coreRead().activeSessionId!;
  const commandId = 'i189-core-cancel-root';
  try {
    const taskReceipt = core.taskSubmit(sessionId, {
      commandId,
      text: 'cancel while runtime_start waits',
    });
    await waitFor(
      () => starts > 0,
      'Core root Worker did not receive its start command',
    );
    await within(
      (async () => {
        while (true) {
          try {
            await Deno.stat(startupMarker);
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      })(),
      'Core root runtime_start hook did not begin waiting',
    );
    const session = JSON.parse(
      new TextDecoder().decode((await core.sessionRead(sessionId)).bytes),
    );
    const executionId = session.runtime.reservation?.executionId;
    ok(executionId, 'Core did not publish the preparing execution id');
    const cancellation = await core.executionCancel(
      sessionId,
      executionId,
      { commandId: 'i189-core-cancel-command' },
    );
    strictEqual(cancellation.kind, 'accepted');
    if (cancellation.kind !== 'accepted') throw new Error('Cancellation was rejected');
    strictEqual(cancellation.value.result, 'requested');

    const receipt = await within(taskReceipt, 'Core task did not finish admission');
    strictEqual(receipt.kind, 'accepted');
    if (receipt.kind !== 'accepted') throw new Error('Cancelled task admission failed');
    strictEqual(receipt.value.executionId, executionId);
    const deadline = Date.now() + 5_000;
    let execution = (await core.executionRead(executionId)).execution;
    while (execution.processSettlement !== 'complete') {
      if (Date.now() > deadline) throw new Error('Core execution did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
      execution = (await core.executionRead(executionId)).execution;
    }
    strictEqual(execution.outcome, 'cancelled');
    strictEqual(execution.stopReason, 'cancelled');
    strictEqual(execution.processSettlement, 'complete');
    strictEqual(turns, 0);
    ok(terminations > 0, 'Core cancellation did not terminate the startup Worker');
  } finally {
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 child cleanup terminates a startup hook after cancellation grace', async () => {
  let resolveChildStart!: () => void;
  const childStarted = new Promise<void>((resolve) => resolveChildStart = resolve);
  let childTerminations = 0;
  let childTurns = 0;
  const parentExecutionId = 'i189-child-start-cancel-parent';
  const context = await createChildDataTestRegistry({
    options: {
      physicalIoMode: 'provider-free',
      cancelSettlementGraceMs: 40,
      capsuleFactory: (url): WorkerHostCapsule => {
        const capsule = new WorkerCapsule(url);
        return {
          send(command, transfer) {
            if (
              command.kind === 'start' &&
              command.runtimeIdentity?.role === 'child'
            ) {
              resolveChildStart();
            }
            if (command.kind === 'turn') childTurns++;
            capsule.send(command, transfer);
          },
          subscribe: (listener) => capsule.subscribe(listener),
          terminate() {
            childTerminations++;
            capsule.terminate();
          },
        };
      },
    },
    currentCatalog: () => ['reviewer'],
    setupConfiguration: async (configRoot) => {
      await writeJson(`${configRoot}/agents.json`, {
        schemaVersion: 1,
        default: 'agents/root.json',
        agents: { reviewer: 'agents/reviewer.json' },
      });
      await writeJson(`${configRoot}/agents/root.json`, {
        name: 'root',
        instruction: 'root fixture',
        tools: [],
        agents: [],
        hooks: [],
      });
      await writeJson(`${configRoot}/agents/reviewer.json`, {
        name: 'reviewer',
        instruction: 'child fixture',
        tools: [],
        agents: [],
      });
      await writeJson(`${configRoot}/hooks.json`, {
        schemaVersion: 1,
        default: ['wait-for-cancel'],
        hooks: { 'wait-for-cancel': 'hooks/wait-for-cancel/index.ts' },
      });
      await Deno.mkdir(`${configRoot}/hooks/wait-for-cancel`, {
        recursive: true,
      });
      await Deno.writeTextFile(
        `${configRoot}/hooks/wait-for-cancel/index.ts`,
        `export default () => ({\n` +
          `  runtime_start: () => new Promise(() => {}),\n` +
          `});\n`,
      );
    },
  });

  try {
    await context.seedParentExecution(parentExecutionId);
    context.registry.openParent(parentExecutionId);
    const spawnPromise = context.registry.handle(
      { kind: 'spawn', agent: 'reviewer', task: 'wait during child startup' },
      'i189-child-start-cancel-call',
      parentExecutionId,
    );
    await within(
      childStarted,
      'child Worker did not receive its start command',
    );
    const cleanup = await within(
      context.registry.cleanupParent(parentExecutionId),
      'parent child-cleanup did not finish after startup cancellation',
    );
    ok(cleanup);
    strictEqual(cleanup.runs.length, 1);
    strictEqual(cleanup.runs[0].state, 'cancelled');
    strictEqual(cleanup.runs[0].durability, 'yes');
    const spawn = await within(
      spawnPromise,
      'cancelled child spawn did not unwind',
    );
    strictEqual(spawn.ok, false);
    ok(
      childTerminations > 0,
      'child startup Worker was not terminated after grace',
    );
    strictEqual(childTurns, 0);
  } finally {
    context.registry.releaseParent(parentExecutionId);
    await closeChildDataTests();
  }
});
