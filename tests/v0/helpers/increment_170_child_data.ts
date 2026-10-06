import { createDataClient } from '../../../v0/agent/data/client.ts';
import type { DataService } from '../../../v0/agent/data/data_contract.ts';
import type { SqliteHistoryStore } from '../../../v0/agent/history/sqlite_history_store.ts';
import type { DataSessionDescriptor } from '../../../v0/agent/data/session_data_owner.ts';
import type { AgentConfigurationChoice } from '../../../v0/agent/configuration/configuration_resolver.ts';
import { WorkerCapsule } from '../../../v0/agent/worker/worker_capsule.ts';
import { WorkerHostSession } from '../../../v0/agent/worker/worker_host_session.ts';
import type { WorkerReadyMessage } from '../../../v0/agent/worker/worker_protocol.ts';
import {
  type ChildRunDeps,
  ChildRunRegistry,
} from '../../../v0/agent/worker/worker_host_children.ts';

const resources = new Set<
  { readonly store?: SqliteHistoryStore; close(): Promise<void> }
>();

export const closeChildDataTests = async (
  store?: SqliteHistoryStore,
): Promise<void> => {
  for (const resource of [...resources]) {
    if (store !== undefined && resource.store !== store) continue;
    resources.delete(resource);
    await resource.close();
  }
};

export const childDataTest = (
  name: string,
  run: () => Promise<void> | void,
): void => {
  Deno.test(name, async () => {
    try {
      await run();
    } finally {
      await closeChildDataTests();
    }
  });
};

export const createChildDataTestRegistry = async (
  input: Omit<ChildRunDeps, 'options'> & {
    readonly options:
      & Omit<
        ChildRunDeps['options'],
        'data' | 'descriptor' | 'workspaceRoot' | 'agentChoice' | 'configRoot' | 'credentialRoot'
      >
      & {
        readonly agentChoice?: ChildRunDeps['options']['agentChoice'];
        readonly configRoot?: string;
        readonly credentialRoot?: string;
        readonly initialModelSelection?:
          import('../../../v0/agent/provider/model_selection.ts').ModelSelection;
      };
    readonly store?: SqliteHistoryStore;
    readonly workspaceRoot?: string;
    /** Explicit JSON Agent fixture setup for tests that spawn a named child. */
    readonly setupConfiguration?: (configRoot: string) => Promise<void>;
    readonly transformData?: (data: DataService) => DataService;
  },
): Promise<{
  readonly registry: ChildRunRegistry;
  readonly data: DataService;
  readonly configRoot: string;
  readonly seedParentExecution: (
    executionId: string,
    task?: string,
  ) => Promise<void>;
}> => {
  const root = input.store === undefined
    ? await Deno.makeTempDir({ prefix: 'henji-i170-child-test-' })
    : undefined;
  const workspaceRoot = input.workspaceRoot ?? input.store?.workspaceRoot ??
    root!;
  const configRoot = input.options.configRoot ?? `${workspaceRoot}/config`;
  const stateRoot = input.store?.stateRoot ?? `${root}/state`;
  const credentialRoot = input.options.credentialRoot ?? `${stateRoot}/credentials`;
  const { initialModelSelection, ...workerOptions } = input.options;
  const data = await createDataClient({
    stateRoot,
    workspaceRoot,
  });
  try {
    await input.setupConfiguration?.(configRoot);
    const descriptor = await data.openSession({
      persistence: 'none',
      agent: 'default',
      agentChoice: {},
      ...(initialModelSelection === undefined ? {} : { initialModelSelection }),
    });
    const parentSessions: WorkerHostSession[] = [];
    const seedParentExecution = async (
      executionId: string,
      task = `parent fixture ${executionId}`,
    ): Promise<void> => {
      const parentDescriptor = await data.openSession({
        persistence: 'none',
        agent: 'default',
        agentChoice: {},
        ...(initialModelSelection === undefined ? {} : { initialModelSelection }),
      });
      let ready: WorkerReadyMessage | undefined;
      const parentSession = await WorkerHostSession.open({
        data,
        descriptor: parentDescriptor,
        workspaceRoot,
        configRoot,
        credentialRoot,
        agentChoice: {},
        physicalIoMode: 'provider-free',
        ...(input.options.rootMaxSteps === undefined
          ? {}
          : { rootMaxSteps: input.options.rootMaxSteps }),
        ...(input.options.providerTimeoutMs === undefined
          ? {}
          : { providerTimeoutMs: input.options.providerTimeoutMs }),
        ...(input.options.providerDeclarations === undefined
          ? {}
          : { providerDeclarations: input.options.providerDeclarations }),
        capsuleFactory: (url) => {
          const capsule = new WorkerCapsule(url);
          capsule.subscribe((message) => {
            if (message.kind === 'ready') ready = message;
          });
          return capsule;
        },
      });
      parentSessions.push(parentSession);
      if (ready === undefined) {
        await parentSession.close();
        throw new Error('parent fixture Worker did not become ready');
      }
      await data.executionAdmit(parentDescriptor.id, {
        executionId,
        taskId: `${executionId}-task`,
        task,
        correlation: ready.correlation,
        createdAt: new Date().toISOString(),
      });
    };
    const registry = new ChildRunRegistry({
      options: {
        ...workerOptions,
        data: input.transformData?.(data) ?? data,
        descriptor,
        workspaceRoot,
        agentChoice: input.options.agentChoice ?? {},
        configRoot,
        credentialRoot,
      },
      currentCatalog: input.currentCatalog,
      ...(input.currentModelSelection === undefined
        ? {}
        : { currentModelSelection: input.currentModelSelection }),
      ...(input.chatgptAuth === undefined ? {} : { chatgptAuth: input.chatgptAuth }),
    });
    resources.add({
      store: input.store,
      async close() {
        try {
          await registry.cleanupAll();
        } finally {
          await Promise.all(parentSessions.map((session) => session.close()));
          await data.close();
          if (root !== undefined) await Deno.remove(root, { recursive: true });
        }
      },
    });
    return { registry, data, configRoot, seedParentExecution };
  } catch (error) {
    await data.close();
    if (root !== undefined) await Deno.remove(root, { recursive: true });
    throw error;
  }
};

/** Start a real parent Worker and admit its execution through Data before direct child tests. */
export const seedDataServiceParentExecution = async (input: {
  readonly data: DataService;
  readonly descriptor: DataSessionDescriptor;
  readonly workspaceRoot: string;
  readonly configRoot: string;
  readonly credentialRoot: string;
  readonly agentChoice: AgentConfigurationChoice;
  readonly executionId: string;
}): Promise<WorkerHostSession> => {
  let ready: WorkerReadyMessage | undefined;
  const session = await WorkerHostSession.open({
    data: input.data,
    descriptor: input.descriptor,
    workspaceRoot: input.workspaceRoot,
    configRoot: input.configRoot,
    credentialRoot: input.credentialRoot,
    agentChoice: input.agentChoice,
    physicalIoMode: 'provider-free',
    capsuleFactory: (url) => {
      const capsule = new WorkerCapsule(url);
      capsule.subscribe((message) => {
        if (message.kind === 'ready') ready = message;
      });
      return capsule;
    },
  });
  if (ready === undefined) {
    await session.close();
    throw new Error('parent Worker did not report ready');
  }
  try {
    await input.data.executionAdmit(input.descriptor.id, {
      executionId: input.executionId,
      taskId: input.executionId,
      task: 'parent fixture execution',
      correlation: ready.correlation,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
};
