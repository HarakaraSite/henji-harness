import { createDataClient } from '../../../v0/agent/data/client.ts';
import type { DataService } from '../../../v0/agent/data/data_contract.ts';
import type { SqliteHistoryV7ProductionStore } from '../../../v0/agent/history/sqlite_history_v7_production_store.ts';
import {
  type ChildRunDeps,
  ChildRunRegistry,
} from '../../../v0/agent/worker/worker_host_children.ts';
import { builtinDefinitionRef } from '../../../v0/agent/definitions/managed_resource_ref.ts';
import { buildManifest } from '../../../v0/agent/runtime/build_manifest.ts';

const resources = new Set<
  { readonly store?: SqliteHistoryV7ProductionStore; close(): Promise<void> }
>();

export const closeChildDataTests = async (
  store?: SqliteHistoryV7ProductionStore,
): Promise<void> => {
  for (const resource of [...resources]) {
    if (store !== undefined && resource.store !== store) continue;
    resources.delete(resource);
    await resource.close();
  }
};

export const childDataTest = (name: string, run: () => Promise<void> | void): void => {
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
    readonly options: Omit<ChildRunDeps['options'], 'data' | 'descriptor' | 'workspaceRoot'>;
    readonly store?: SqliteHistoryV7ProductionStore;
    readonly workspaceRoot?: string;
    readonly transformData?: (data: DataService) => DataService;
  },
): Promise<{ readonly registry: ChildRunRegistry; readonly data: DataService }> => {
  const root = input.store === undefined
    ? await Deno.makeTempDir({ prefix: 'henji-i170-child-test-' })
    : undefined;
  const workspaceRoot = input.workspaceRoot ?? input.store?.workspaceRoot ?? root!;
  const data = await createDataClient({
    stateRoot: input.store?.stateRoot ?? `${root}/state`,
    workspaceRoot,
  });
  try {
    const definition = await builtinDefinitionRef('default', buildManifest());
    const descriptor = await data.openSession({
      persistence: 'none',
      agent: 'default',
      definition,
    });
    const registry = new ChildRunRegistry({
      options: {
        ...input.options,
        data: input.transformData?.(data) ?? data,
        descriptor,
        workspaceRoot,
      },
      catalog: input.catalog,
      ...(input.resolveManagedModule === undefined
        ? {}
        : { resolveManagedModule: input.resolveManagedModule }),
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
          await data.close();
          if (root !== undefined) await Deno.remove(root, { recursive: true });
        }
      },
    });
    return { registry, data };
  } catch (error) {
    await data.close();
    if (root !== undefined) await Deno.remove(root, { recursive: true });
    throw error;
  }
};
