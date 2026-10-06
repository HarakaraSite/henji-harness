import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type { DataService } from '../../v0/agent/data/data_contract.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import type {
  WorkerReadyMessage,
  WorkerRuntimeIdentityInput,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';

interface ObservedWorkers {
  readonly ready: WorkerReadyMessage[];
  readonly errors: Extract<WorkerToHostMessage, { kind: 'worker_error' }>[];
  readonly starts: { readonly runtimeIdentity?: WorkerRuntimeIdentityInput }[];
}

const observedWorkers = (): ObservedWorkers => ({
  ready: [],
  errors: [],
  starts: [],
});

const capsuleFactory = (
  observed: ObservedWorkers,
): (url: URL) => WorkerHostCapsule =>
(url) => {
  const capsule = new WorkerCapsule(url);
  return {
    send(command, transfer): void {
      if (command.kind === 'start') {
        observed.starts.push({ runtimeIdentity: command.runtimeIdentity });
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
    agents: { reviewer: 'agents/reviewer.json' },
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'root',
    instruction: 'root instruction',
    tools: [],
    agents: ['reviewer'],
  });
  await writeJson(`${configRoot}/agents/reviewer.json`, {
    name: 'reviewer',
    instruction: 'reviewer instruction',
    tools: [],
    agents: [],
  });
};

const hookSource = (
  logPath: string,
  version: string,
  rootDelayMs: number,
): string => `
const logPath = ${JSON.stringify(logPath)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = async (event) => {
  await Deno.writeTextFile(logPath, JSON.stringify(event) + '\\n', { append: true });
};
export default () => ({
  runtime_start: async ({ runtime }) => {
    if (runtime.role === 'root' && ${rootDelayMs} > 0) await wait(${rootDelayMs});
    await record({
      event: 'start', version: ${JSON.stringify(version)}, role: runtime.role,
      agentName: runtime.agentName, sessionId: runtime.sessionId,
      workerGeneration: runtime.workerGeneration,
      ...(runtime.role === 'child' ? {
        parentExecutionId: runtime.parentExecutionId,
        spawnCallId: runtime.spawnCallId,
      } : {}),
    });
    return { context: ['startup ' + ${JSON.stringify(version)}] };
  },
  runtime_stop: async ({ runtime, reason }) => {
    if (runtime.role === 'root' && ${rootDelayMs} > 0) await wait(${rootDelayMs});
    await record({
      event: 'stop', version: ${JSON.stringify(version)}, role: runtime.role,
      sessionId: runtime.sessionId, workerGeneration: runtime.workerGeneration, reason,
    });
  },
});
`;

const readLog = async (path: string): Promise<Record<string, unknown>[]> => {
  try {
    return (await Deno.readTextFile(path)).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};

const trackAdmissions = (service: DataService, sessionIds: string[]): DataService =>
  new Proxy(service, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'executionAdmit' && typeof value === 'function') {
        return (...args: Parameters<DataService['executionAdmit']>) => {
          sessionIds.push(String(args[0]));
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DataService;

Deno.test('Increment 189 runs startup/stop hooks in each Worker lifecycle', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-runtime-' });
  const configRoot = `${root}/config`;
  const logPath = `${root}/hook-events.jsonl`;
  const probePath = `${configRoot}/hooks/probe/index.ts`;
  const startDelayMs = 5_150;
  const dataClient = await createDataClient({
    stateRoot: `${root}/data`,
    workspaceRoot: root,
  });
  const admissions: string[] = [];
  const data = trackAdmissions(dataClient, admissions);
  const descriptorIds: string[] = [];
  let session: WorkerHostSession | undefined;
  let children: ChildRunRegistry | undefined;
  let parentExecutionId: string | undefined;

  try {
    await writeConfiguration(configRoot);
    const runtimeStartPath = `${configRoot}/hooks/runtime-start-time/index.ts`;
    await Deno.mkdir(`${configRoot}/hooks/runtime-start-time`, { recursive: true });
    await Deno.copyFile(
      new URL('../../external-hooks/runtime-start-time/index.ts', import.meta.url),
      runtimeStartPath,
    );
    await Deno.mkdir(`${configRoot}/hooks/probe`, { recursive: true });
    await Deno.mkdir(`${configRoot}/hooks/start-fails`, { recursive: true });
    await Deno.mkdir(`${configRoot}/hooks/stop-fails`, { recursive: true });
    await Deno.mkdir(`${configRoot}/hooks/stop-after`, { recursive: true });
    await Deno.writeTextFile(probePath, hookSource(logPath, 'v1', startDelayMs));
    await Deno.writeTextFile(
      `${configRoot}/hooks/start-fails/index.ts`,
      `const logPath = ${JSON.stringify(logPath)};
export default () => ({
  runtime_start: () => { throw new Error('start failure marker'); },
  runtime_stop: () => Deno.writeTextFile(logPath, JSON.stringify({ event: 'start-failure-stop-ran' }) + '\\n', { append: true }),
});
`,
    );
    await Deno.writeTextFile(
      `${configRoot}/hooks/stop-fails/index.ts`,
      `const logPath = ${JSON.stringify(logPath)};
export default () => ({
  runtime_stop: async ({ runtime }) => {
    await Deno.writeTextFile(logPath, JSON.stringify({ event: 'stop-fails', role: runtime.role }) + '\\n', { append: true });
    throw new Error('stop failure marker');
  },
});
`,
    );
    await Deno.writeTextFile(
      `${configRoot}/hooks/stop-after/index.ts`,
      `const logPath = ${JSON.stringify(logPath)};
export default () => ({
  runtime_stop: ({ runtime }) => Deno.writeTextFile(logPath, JSON.stringify({ event: 'stop-after', role: runtime.role }) + '\\n', { append: true }),
});
`,
    );
    await writeJson(`${configRoot}/hooks.json`, {
      schemaVersion: 1,
      default: ['runtime-start-time', 'probe', 'start-fails', 'stop-fails', 'stop-after'],
      hooks: {
        'runtime-start-time': 'hooks/runtime-start-time/index.ts',
        probe: 'hooks/probe/index.ts',
        'start-fails': 'hooks/start-fails/index.ts',
        'stop-fails': 'hooks/stop-fails/index.ts',
        'stop-after': 'hooks/stop-after/index.ts',
      },
    });

    const openedAt = performance.now();
    const observed = observedWorkers();
    const descriptor = await data.openSession({
      persistence: 'none',
      agent: 'root',
      agentChoice: {},
    });
    descriptorIds.push(descriptor.id);
    session = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot: root,
      configRoot,
      credentialRoot: `${root}/credentials`,
      agentChoice: {},
      physicalIoMode: 'provider-free',
      capsuleFactory: capsuleFactory(observed),
    });
    const rootReady = observed.ready[0];
    ok(rootReady, 'root Worker did not report ready');
    ok(performance.now() - openedAt >= 5_000, 'startup hook was cut off at five seconds');
    ok(!observed.errors.length, JSON.stringify(observed.errors));
    deepStrictEqual(observed.starts[0]?.runtimeIdentity, { role: 'root' });

    const rootConfiguration = rootReady.configuration;
    ok(rootConfiguration);
    const timeComponent = rootConfiguration.instructionComponents.find((component) =>
      component.sourceLocator?.includes('runtime-start-time')
    );
    ok(timeComponent);
    ok(/^Worker started at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2} \(.+\)$/u
      .test(timeComponent.text));
    const probeComponent = rootConfiguration.instructionComponents.find((component) =>
      component.identity === 'instruction:runtime-start-hook-2'
    );
    ok(probeComponent);
    strictEqual(probeComponent.text, 'startup v1');
    deepStrictEqual(JSON.parse(probeComponent.sourceLocator ?? 'null'), {
      hook: 'probe',
      path: probePath,
    });
    strictEqual(
      rootConfiguration.systemInstruction,
      rootConfiguration.instructionComponents.map((component) => component.text).join('\n\n'),
    );
    ok(
      rootConfiguration.instructionComponents.some((component) =>
        component.identity === 'instruction:henji-base'
      ),
      'startup contribution replaced the core instruction component',
    );
    ok(rootConfiguration.systemInstruction.includes('startup v1'));
    deepStrictEqual(rootConfiguration.hooks.map((hook) => hook.name), [
      'runtime-start-time',
      'probe',
      'stop-fails',
      'stop-after',
    ]);
    ok(
      rootConfiguration.rejections.some((rejection) =>
        rejection.target === 'hook' && rejection.name === 'start-fails' &&
        rejection.reason.includes('runtime_start')
      ),
    );

    await Deno.writeTextFile(probePath, hookSource(logPath, 'v2', 0));
    parentExecutionId = 'i189-root-execution-for-child';
    await data.executionAdmit(descriptor.id, {
      executionId: parentExecutionId,
      taskId: parentExecutionId,
      task: 'runtime lifecycle fixture parent',
      correlation: rootReady.correlation,
      createdAt: new Date().toISOString(),
    });

    const childRegistry = new ChildRunRegistry({
      options: {
        data,
        descriptor,
        workspaceRoot: root,
        configRoot,
        credentialRoot: `${root}/credentials`,
        agentChoice: {},
        physicalIoMode: 'provider-free',
        cancelSettlementGraceMs: 0,
        capsuleFactory: capsuleFactory(observed),
      },
      currentCatalog: () => ['reviewer'],
      currentModelSelection: () => descriptor.modelSelection,
    });
    children = childRegistry;
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      { kind: 'spawn', agent: 'reviewer', task: 'complete without provider access' },
      'i189-child-spawn-call',
      parentExecutionId,
    );
    ok(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      'i189-child-collect-call',
      parentExecutionId,
    );
    ok(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    strictEqual(collected.result.state, 'completed');
    deepStrictEqual(
      collected.result.runtimeStopFailures?.map(({ name, phase }) => ({
        name,
        phase,
      })),
      [{ name: 'stop-fails', phase: 'runtime_stop' }],
    );

    const childStart = observed.starts.find(({ runtimeIdentity }) =>
      runtimeIdentity?.role === 'child'
    );
    ok(childStart);
    deepStrictEqual(childStart.runtimeIdentity, {
      role: 'child',
      parentExecutionId,
      spawnCallId: 'i189-child-spawn-call',
    });
    const logAfterChild = await readLog(logPath);
    const childStartEntry = logAfterChild.find((event) =>
      event.event === 'start' && event.role === 'child'
    );
    ok(childStartEntry);
    strictEqual(childStartEntry.version, 'v2');
    strictEqual(childStartEntry.parentExecutionId, parentExecutionId);
    strictEqual(childStartEntry.spawnCallId, 'i189-child-spawn-call');
    const childStops = logAfterChild.filter((event) =>
      event.role === 'child' && (event.event === 'stop-fails' || event.event === 'stop-after')
    );
    deepStrictEqual(childStops.map((event) => event.event), ['stop-fails', 'stop-after']);
    ok(!logAfterChild.some((event) => event.event === 'start-failure-stop-ran'));

    await children.cleanupParent(parentExecutionId);
    children.releaseParent(parentExecutionId);
    children = undefined;

    const closedAt = performance.now();
    const closed = await session.close();
    session = undefined;
    ok(closed, 'root Worker did not return its close response');
    ok(performance.now() - closedAt >= 5_000, 'stop hook was cut off at five seconds');
    deepStrictEqual(closed.hookFailures?.map(({ name, phase }) => ({ name, phase })), [
      { name: 'stop-fails', phase: 'runtime_stop' },
    ]);
    const finalLog = await readLog(logPath);
    const rootStart = finalLog.find((event) => event.event === 'start' && event.role === 'root');
    const rootStop = finalLog.find((event) => event.event === 'stop' && event.role === 'root');
    ok(rootStart);
    ok(rootStop);
    strictEqual(rootStart.version, 'v1');
    strictEqual(rootStop.version, 'v1', 'an existing Worker reloaded its hook module');
    strictEqual(rootStart.sessionId, rootStop.sessionId);
    strictEqual(rootStart.workerGeneration, rootStop.workerGeneration);
    strictEqual(rootStop.reason, 'normal_close');
    deepStrictEqual(
      finalLog.filter((event) =>
        event.role === 'root' && (event.event === 'stop-fails' || event.event === 'stop-after')
      ).map((event) => event.event),
      ['stop-fails', 'stop-after'],
    );
    strictEqual(
      finalLog.filter((event) => event.event === 'start-failure-stop-ran').length,
      0,
      'a runtime_start-rejected hook remained registered for runtime_stop',
    );
    strictEqual(admissions.length, 2);
  } finally {
    if (children !== undefined && parentExecutionId !== undefined) {
      await children.cleanupParent(parentExecutionId).catch(() => undefined);
      children.releaseParent(parentExecutionId);
    }
    if (session !== undefined) await session.close().catch(() => undefined);
    for (const sessionId of descriptorIds) await data.closeSession(sessionId).catch(() => {});
    await data.close();
    await Deno.remove(root, { recursive: true });
  }
});
