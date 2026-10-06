import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createApplicationService } from '../../v0/agent/host/application_service.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import { seedDataServiceParentExecution } from './helpers/increment_170_child_data.ts';
import type { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';

const writeJson = async (path: string, value: unknown) => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value));
};
const readLog = async (path: string): Promise<Record<string, unknown>[]> => {
  try {
    return (await Deno.readTextFile(path)).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};
const waitForCancelHook = async (path: string, role: string) => {
  const deadline = Date.now() + 10_000;
  while (
    !(await readLog(path)).some((event) => event.phase === 'cancel_wait' && event.role === role)
  ) {
    if (Date.now() > deadline) throw new Error(`${role} cancel hook did not start`);
    await new Promise((accept) => setTimeout(accept, 10));
  }
};
const configure = async (root: string) => {
  const configRoot = `${root}/config`;
  const logPath = `${root}/hooks.ndjson`;
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: { named: 'agents/named.json' },
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'root',
    instruction: 'settlement fixture',
    tools: [],
    agents: ['named'],
  });
  await writeJson(`${configRoot}/agents/named.json`, {
    name: 'named',
    instruction: 'named child fixture',
    tools: [],
    agents: [],
  });
  await writeJson(`${configRoot}/hooks.json`, {
    schemaVersion: 1,
    default: ['settlement'],
    hooks: { settlement: 'hooks/settlement.ts' },
  });
  await Deno.mkdir(`${configRoot}/hooks`);
  await Deno.writeTextFile(
    `${configRoot}/hooks/settlement.ts`,
    `
    const record = (value) => Deno.writeTextFile(${JSON.stringify(logPath)},
      JSON.stringify(value) + '\\n', { append: true });
    export default () => ({
      before_turn: async ({ runtime, task }) => {
        if (task !== 'CANCEL') return;
        await record({ phase: 'cancel_wait', role: runtime.role, executionId: runtime.executionId });
        if (!runtime.signal.aborted) await new Promise((accept) =>
          runtime.signal.addEventListener('abort', accept, { once: true }));
      },
      after_turn: async ({ runtime, outcome, settlement, context }) => {
        await new Promise((accept) => setTimeout(accept, 35));
        await record({ phase: 'after_turn', role: runtime.role, agent: runtime.agentName,
          executionId: runtime.executionId, parentExecutionId: runtime.parentExecutionId,
          task: outcome.task, outcome: outcome.outcome, finalText: outcome.finalText, settlement,
          turns: context.transcript.turns.map((turn) => turn.turn),
          canonical: JSON.stringify(context.transcript.turns),
          draft: JSON.stringify(outcome.transcript),
        });
        if (outcome.task === 'child-fail task') throw new Error('post-failure hook marker');
      },
      runtime_stop: ({ runtime, context }) => record({ phase: 'runtime_stop',
        role: runtime.role, agent: runtime.agentName,
        canonical: JSON.stringify(context.transcript.turns) }),
    });
  `,
  );
  return { configRoot, logPath };
};

Deno.test('Increment 189 root failure and cooperative cancellation await after_turn without adopting drafts', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-root-settlement-' });
  const { configRoot, logPath } = await configure(root);
  const service = await createApplicationService({
    workspaceRoot: root,
    stateRoot: `${root}/state`,
    dataRoot: `${root}/data`,
    configRoot,
    persistence: 'new',
    physicalIoMode: 'provider-free',
  });
  const settle = async (task: string) => {
    const admission = await service.tasks.admit(task, crypto.randomUUID());
    const result = await admission.completion;
    const deadline = Date.now() + 5_000;
    while (service.tasks.isBusy()) {
      if (Date.now() > deadline) throw new Error('settled root remained busy');
      await new Promise((accept) => setTimeout(accept, 10));
    }
    return { result, executionId: admission.executionId };
  };
  try {
    await settle('FIRST');
    await settle('SECOND');
    const failed = await settle('child-fail task');
    strictEqual(failed.result.ok, false);
    const failure = (await readLog(logPath)).find((event) =>
      event.phase === 'after_turn' && event.executionId === failed.executionId
    )!;
    ok(failure, 'failure completion preceded after_turn');
    deepStrictEqual(failure.turns, [1, 2]);
    ok(!String(failure.canonical).includes('child-fail task'));
    ok(String(failure.draft).includes('child-fail task'));
    strictEqual((failure.settlement as { accepted: boolean }).accepted, false);
    strictEqual((failure.settlement as { adopted: boolean }).adopted, false);
    const savedFailure = await service.data.executionRead(failed.executionId);
    strictEqual(savedFailure.execution.outcome, 'failed');

    const cancelled = await service.tasks.admit('CANCEL', crypto.randomUUID());
    await waitForCancelHook(logPath, 'root');
    strictEqual(service.tasks.cancel(cancelled.executionId), 'requested');
    const result = await cancelled.completion;
    strictEqual(result.outcome, 'cancelled');
    const cancellation = (await readLog(logPath)).find((event) =>
      event.phase === 'after_turn' && event.executionId === cancelled.executionId
    )!;
    ok(cancellation, 'cooperative cancellation preceded after_turn');
    deepStrictEqual(cancellation.turns, [1, 2]);
    strictEqual((cancellation.settlement as { accepted: boolean }).accepted, false);
    strictEqual(
      (await service.data.executionRead(cancelled.executionId)).execution.outcome,
      'cancelled',
    );
    const history = JSON.parse(new TextDecoder().decode(
      (await service.data.historyRead({
        sessionRef: service.currentSession().sessionId,
        view: 'detail',
      })).bytes,
    )).text as string;
    ok(history.includes('post-failure hook marker'));
    const descriptor = await service.data.sessionDescriptor(service.currentSession().sessionId);
    strictEqual(descriptor.nextTurn, 3, 'failure/cancel adopted an unfinished draft');
  } finally {
    const executionId = service.tasks.activeExecutionId();
    if (executionId) service.tasks.cancel(executionId);
    await service.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 named/generic children publish results after their own settlement hooks', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-child-settlement-' });
  const { configRoot, logPath } = await configure(root);
  const data = await createDataClient({ stateRoot: `${root}/state`, workspaceRoot: root });
  const descriptor = await data.openSession({
    persistence: 'none',
    agent: 'root',
    agentChoice: {},
  });
  const parentExecutionId = 'i189-settlement-parent';
  let parent: WorkerHostSession | undefined;
  const registry = new ChildRunRegistry({
    options: {
      data,
      descriptor,
      workspaceRoot: root,
      configRoot,
      credentialRoot: `${root}/credentials`,
      agentChoice: {},
      physicalIoMode: 'provider-free',
    },
    currentCatalog: () => ['generic', 'named'],
  });
  const spawn = async (agent: string, task: string) => {
    const receipt = await registry.handle(
      { kind: 'spawn', agent, task },
      `spawn-${agent}-${task}`,
      parentExecutionId,
    );
    ok(receipt.ok && receipt.kind === 'spawn', JSON.stringify(receipt));
    return receipt.runId;
  };
  const collect = async (runId: string) => {
    const receipt = await registry.handle(
      { kind: 'collect', runId },
      `collect-${runId}`,
      parentExecutionId,
    );
    ok(receipt.ok && receipt.kind === 'collect', JSON.stringify(receipt));
    const after = (await readLog(logPath)).find((event) =>
      event.phase === 'after_turn' && event.executionId === runId
    )!;
    ok(after, 'child result was published before after_turn');
    return { receipt, after };
  };
  try {
    parent = await seedDataServiceParentExecution({
      data,
      descriptor,
      workspaceRoot: root,
      configRoot,
      credentialRoot: `${root}/credentials`,
      agentChoice: {},
      executionId: parentExecutionId,
    });
    registry.openParent(parentExecutionId);
    for (const agent of ['generic', 'named']) {
      const runId = await spawn(agent, 'child finishes');
      const { receipt, after } = await collect(runId);
      strictEqual(receipt.result.state, 'completed');
      strictEqual(after.role, 'child');
      strictEqual(after.agent, agent);
      strictEqual(after.parentExecutionId, parentExecutionId);
      deepStrictEqual(after.turns, [1]);
      ok(!String(after.canonical).includes('parent fixture execution'));
      strictEqual((after.settlement as { accepted: boolean }).accepted, true);
      strictEqual((after.settlement as { adopted: boolean }).adopted, false);
      ok(
        (await readLog(logPath)).some((event) =>
          event.phase === 'runtime_stop' && event.agent === agent
        ),
      );
    }
    const failedRun = await spawn('named', 'child-fail task');
    const failed = await collect(failedRun);
    strictEqual(failed.receipt.result.state, 'failed');
    deepStrictEqual(failed.after.turns, []);
    ok(String(failed.after.draft).includes('child-fail task'));
    strictEqual((failed.after.settlement as { accepted: boolean }).accepted, false);
    const cancelRun = await spawn('generic', 'CANCEL');
    await waitForCancelHook(logPath, 'child');
    const cancellation = await registry.handle(
      { kind: 'cancel', runId: cancelRun },
      'cancel-child',
      parentExecutionId,
    );
    ok(cancellation.ok && cancellation.kind === 'cancel');
    const cancelled = await collect(cancelRun);
    strictEqual(cancelled.receipt.result.state, 'cancelled');
    strictEqual((cancelled.after.settlement as { accepted: boolean }).accepted, false);
    strictEqual((await data.sessionDescriptor(descriptor.id)).nextTurn, 1);
  } finally {
    await registry.cleanupAll();
    await parent?.close();
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 rejected completed proposal retains draft and Data cancellation outcome for after_turn', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-rejected-draft-' });
  const { configRoot, logPath } = await configure(root);
  let cancelledAtProposal = false;
  const service: Awaited<ReturnType<typeof createApplicationService>> =
    await createApplicationService({
      workspaceRoot: root,
      stateRoot: `${root}/state`,
      dataRoot: `${root}/data`,
      configRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
      capsuleFactory: (url: URL) => {
        const capsule = new WorkerCapsule(url);
        return {
          send: capsule.send.bind(capsule),
          terminate: capsule.terminate.bind(capsule),
          subscribe: (listener: Parameters<WorkerCapsule['subscribe']>[0]) =>
            capsule.subscribe((message) => {
              if (message.kind === 'proposal_ready' && !cancelledAtProposal) {
                cancelledAtProposal = true;
                strictEqual(service.tasks.cancel(service.tasks.activeExecutionId()!), 'requested');
              }
              listener(message);
            }),
        };
      },
    });
  try {
    const admission = await service.tasks.admit('FINISHED_DRAFT', crypto.randomUUID());
    const completion = await admission.completion;
    ok(cancelledAtProposal);
    strictEqual(completion.outcome, 'cancelled');
    strictEqual(
      (await service.data.executionRead(admission.executionId)).execution.outcome,
      'cancelled',
    );
    const after = (await readLog(logPath)).find((event) =>
      event.phase === 'after_turn' && event.executionId === admission.executionId
    )!;
    ok(after, 'public completion preceded after_turn');
    strictEqual(after.outcome, 'cancelled');
    strictEqual(after.finalText, 'worker answer: FINISHED_DRAFT');
    ok(String(after.draft).includes('worker answer: FINISHED_DRAFT'));
    deepStrictEqual(after.turns, []);
    const settlement = after.settlement as {
      accepted: boolean;
      adopted: boolean;
      durable: boolean;
    };
    strictEqual(settlement.accepted, false);
    strictEqual(settlement.adopted, false);
    strictEqual(settlement.durable, true);
    strictEqual(
      (await service.data.sessionDescriptor(service.currentSession().sessionId)).nextTurn,
      1,
    );
  } finally {
    await service.close();
    await Deno.remove(root, { recursive: true });
  }
});
