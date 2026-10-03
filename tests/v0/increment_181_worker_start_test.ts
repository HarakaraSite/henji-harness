import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { DataService } from '../../v0/agent/data/data_contract.ts';
import type { DataSessionDescriptor } from '../../v0/agent/data/session_data_owner.ts';
import type { AgentConfigurationChoice } from '../../v0/agent/configuration/configuration_resolver.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import {
  WorkerHostSession,
  WorkerHostStartupError,
} from '../../v0/agent/worker/worker_host_session.ts';
import type {
  WorkerHostCommand,
  WorkerReadyMessage,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';

interface ObservedWorker {
  readonly ready: WorkerReadyMessage[];
  readonly errors: Extract<WorkerToHostMessage, { kind: 'worker_error' }>[];
  readonly startChoices: AgentConfigurationChoice[];
  turnCount: number;
}

const observedWorker = (): ObservedWorker => ({
  ready: [],
  errors: [],
  startChoices: [],
  turnCount: 0,
});

const capsuleFactory = (
  observed: ObservedWorker,
  interceptTurns = false,
): (url: URL) => WorkerHostCapsule =>
(url) => {
  const capsule = new WorkerCapsule(url);
  return {
    send(command: WorkerHostCommand, transfer?: Transferable[]): void {
      if (command.kind === 'start') {
        observed.startChoices.push(structuredClone(command.agentChoice));
      }
      if (command.kind === 'turn') {
        observed.turnCount += 1;
        if (interceptTurns) return;
      }
      capsule.send(command, transfer);
    },
    subscribe(listener): () => void {
      return capsule.subscribe((message) => {
        if (message.kind === 'ready') observed.ready.push(message);
        if (message.kind === 'worker_error') observed.errors.push(message);
        listener(message);
      });
    },
    terminate(): void {
      capsule.terminate();
    },
  };
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await Deno.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(file, JSON.stringify(value));
};

const writeConfiguration = async (configRoot: string): Promise<void> => {
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: {
      reviewer: 'agents/reviewer.json',
      empty: 'agents/empty.json',
    },
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'root-agent',
    revision: 'same-label',
    instruction: '',
    tools: ['read', 'unbundled-tool'],
    agents: [],
  });
  await writeJson(`${configRoot}/agents/reviewer.json`, {
    name: 'reviewer',
    revision: 'named-label',
    instruction: 'reviewer role instruction',
    tools: [],
    agents: [],
  });
  await writeJson(`${configRoot}/agents/empty.json`, {
    name: 'empty',
    revision: 'empty-label',
    instruction: '',
    tools: [],
    agents: [],
  });
};

const trackExecutionAdmissions = (
  service: DataService,
  sessions: string[],
): DataService =>
  new Proxy(service, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'executionAdmit' && typeof value === 'function') {
        return (...args: Parameters<DataService['executionAdmit']>) => {
          sessions.push(String(args[0]));
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DataService;

Deno.test('Increment 181 starts root and child Workers from current JSON configuration', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i181-worker-start-' });
  const configRoot = `${root}/config`;
  await writeConfiguration(configRoot);
  const actualData = await createDataClient({
    stateRoot: `${root}/data`,
    workspaceRoot: root,
  });
  const admissions: string[] = [];
  const data = trackExecutionAdmissions(actualData, admissions);
  const openSessions: string[] = [];
  const openWorker = async (
    choice: AgentConfigurationChoice,
    observed: ObservedWorker,
  ): Promise<{
    readonly session: WorkerHostSession;
    readonly descriptor: DataSessionDescriptor;
    readonly ready: WorkerReadyMessage;
  }> => {
    const descriptor = await data.openSession({
      persistence: 'none',
      agent: choice.name ?? 'default',
      agentChoice: choice,
    });
    openSessions.push(descriptor.id);
    const session = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot: root,
      configRoot,
      agentChoice: choice,
      physicalIoMode: 'provider-free',
      capsuleFactory: capsuleFactory(observed),
    });
    const ready = observed.ready[0];
    ok(ready, 'Worker ready message was not observed');
    return { session, descriptor, ready };
  };

  const opened: WorkerHostSession[] = [];
  try {
    const firstObserved = observedWorker();
    const first = await openWorker({}, firstObserved);
    opened.push(first.session);
    const firstConfiguration = first.ready.configuration;
    ok(firstConfiguration);
    strictEqual(firstConfiguration.agent.name, 'root-agent');
    strictEqual(firstConfiguration.agent.revision, 'same-label');
    strictEqual(firstConfiguration.agent.instruction, '');
    deepStrictEqual(firstConfiguration.agent.tools, ['read', 'unbundled-tool']);
    ok(firstConfiguration.tools.some((tool) => tool.name === 'read'));
    ok(
      !firstConfiguration.tools.some((tool) => tool.name === 'unbundled-tool'),
    );
    ok(
      firstConfiguration.rejections.some((entry) =>
        entry.target === 'tool' && entry.name === 'unbundled-tool'
      ),
    );
    strictEqual(first.ready.manifest?.role, 'parent');
    ok(Number.isSafeInteger(first.ready.manifest?.maxSteps));
    strictEqual(firstObserved.turnCount, 0);

    // Child history rows require an already-admitted parent execution. Seed that
    // durable relation through the ready Worker snapshot, without starting a turn.
    const parentExecution = '181-current-agent-child-catalog';
    await data.executionAdmit(first.descriptor.id, {
      executionId: parentExecution,
      taskId: '181-parent-task',
      task: 'parent fixture execution',
      correlation: first.ready.correlation,
      createdAt: new Date().toISOString(),
    });
    admissions.length = 0;

    await writeJson(`${configRoot}/agents/root.json`, {
      name: 'root-agent',
      revision: 'same-label',
      instruction: 'root role edited in place',
      tools: ['read', 'unbundled-tool'],
      agents: [],
    });
    const secondObserved = observedWorker();
    const second = await openWorker({}, secondObserved);
    opened.push(second.session);
    ok(second.ready.configuration);
    strictEqual(second.ready.configuration.agent.revision, 'same-label');
    ok(
      second.ready.configuration.systemInstruction.includes(
        'root role edited in place',
      ),
    );
    ok(
      !firstConfiguration.systemInstruction.includes(
        'root role edited in place',
      ),
    );
    ok(
      second.ready.configuration.configurationId !==
        firstConfiguration.configurationId,
    );

    const emptyObserved = observedWorker();
    const empty = await openWorker({ name: 'empty' }, emptyObserved);
    opened.push(empty.session);
    ok(empty.ready.configuration);
    strictEqual(empty.ready.configuration.agent.instruction, '');
    deepStrictEqual(empty.ready.configuration.agent.tools, []);
    deepStrictEqual(empty.ready.configuration.tools, []);

    const invalidDescriptor = await data.openSession({
      persistence: 'none',
      agent: 'missing-agent',
      agentChoice: { name: 'missing-agent' },
    });
    openSessions.push(invalidDescriptor.id);
    const invalidObserved = observedWorker();
    let invalidError: unknown;
    try {
      await WorkerHostSession.open({
        data,
        descriptor: invalidDescriptor,
        workspaceRoot: root,
        configRoot,
        agentChoice: { name: 'missing-agent' },
        physicalIoMode: 'provider-free',
        capsuleFactory: capsuleFactory(invalidObserved),
      });
    } catch (error) {
      invalidError = error;
    }
    ok(invalidError instanceof WorkerHostStartupError);
    strictEqual(invalidError.code, 'configuration_rejected');
    ok(
      invalidError.configurationRejections?.some((entry) =>
        entry.target === 'agent' && entry.name === 'missing-agent'
      ),
    );
    strictEqual(invalidObserved.ready.length, 0);
    strictEqual(invalidObserved.turnCount, 0);
    strictEqual(
      admissions.length,
      0,
      'startup rejection must precede execution admission',
    );

    const parentDescriptor = await data.openSession({
      persistence: 'none',
      agent: 'root-agent',
      agentChoice: {},
    });
    openSessions.push(parentDescriptor.id);
    const childObserved = observedWorker();
    const children = new ChildRunRegistry({
      options: {
        data,
        descriptor: parentDescriptor,
        workspaceRoot: root,
        configRoot,
        agentChoice: {},
        physicalIoMode: 'provider-free',
        cancelSettlementGraceMs: 0,
        capsuleFactory: capsuleFactory(childObserved, true),
      },
      currentCatalog: () => ['reviewer', 'generic'],
      currentModelSelection: () => parentDescriptor.modelSelection,
    });
    children.openParent(parentExecution);
    const reviewerSpawn = await children.handle(
      {
        kind: 'spawn',
        agent: 'reviewer',
        task: 'captured before provider turn',
      },
      'reviewer-spawn',
      parentExecution,
    );
    ok(
      reviewerSpawn.ok && reviewerSpawn.kind === 'spawn',
      JSON.stringify(reviewerSpawn),
    );
    const genericSpawn = await children.handle(
      {
        kind: 'spawn',
        agent: 'generic',
        task: 'captured before provider turn',
      },
      'generic-spawn',
      parentExecution,
    );
    ok(genericSpawn.ok && genericSpawn.kind === 'spawn');
    deepStrictEqual(childObserved.startChoices.map((choice) => choice.name), [
      'reviewer',
      'generic',
    ]);
    strictEqual(childObserved.turnCount, 2);
    for (const ready of childObserved.ready) {
      const runtimeToolNames = ready.configuration?.tools.map((tool) => tool.name) ?? [];
      ok(
        !runtimeToolNames.some((name) =>
          [
            'spawn_subagent',
            'subagent_status',
            'collect_subagent',
            'cancel_subagent',
          ].includes(name)
        ),
        'child Worker configuration must omit recursive async child tools',
      );
    }
    await children.cleanupParent(parentExecution);
    children.releaseParent(parentExecution);
    strictEqual(admissions.length, 2);

    await writeJson(`${configRoot}/agents/reviewer.json`, '{');
    children.openParent(parentExecution);
    const invalidChild = await children.handle(
      {
        kind: 'spawn',
        agent: 'reviewer',
        task: 'invalid configuration must stop before turn admission',
      },
      'invalid-reviewer-spawn',
      parentExecution,
    );
    strictEqual(invalidChild.ok, false);
    ok(!invalidChild.ok && invalidChild.error.includes('reviewer'));
    strictEqual(childObserved.turnCount, 2);
    strictEqual(
      admissions.length,
      2,
      'rejected child configuration must not be admitted',
    );
    await children.cleanupParent(parentExecution);
    children.releaseParent(parentExecution);
  } finally {
    for (const session of opened) await session.close().catch(() => {});
    for (const sessionId of openSessions) {
      await data.closeSession(sessionId).catch(() => {});
    }
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});
