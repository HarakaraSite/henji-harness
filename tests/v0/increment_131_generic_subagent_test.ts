import {
  type AsyncAgentRequest,
  type AsyncAgentResponse,
  createAsyncAgentTools,
} from '../../v0/agent/tools/async_agents.ts';
import { ToolInputError } from '../../v0/agent/tools/tools.ts';
import { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import {
  bundledToolDefinitionLoadRequests,
} from '../../v0/agent/worker/worker_definition_revision.ts';
import { managedChildModule, managedChildRef } from './managed_child_fixture.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type { WorkerAsyncAgentCatalogEntry } from '../../v0/agent/worker/worker_protocol.ts';
import type { WorkerSessionHandle } from '../../v0/agent/session/session_store_contract.ts';
import type { HistoryPersistencePort } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import {
  AgentBindingError,
  readAgentSlotBindings,
} from '../../v0/agent/definitions/agent_slot_binding.ts';
import {
  defaultModelSelectionFor,
  modelCatalogEntryFor,
  selectModelFor,
} from '../../v0/agent/provider/model_catalog.ts';
import {
  type ModelSelection,
  type ReasoningEffort,
  sameModelSelection,
} from '../../v0/agent/provider/model_selection.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { setActiveProviderDeclarations } from '../../v0/agent/provider/provider_runtime.ts';

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

const handle = (): WorkerSessionHandle => ({
  id: crypto.randomUUID().toLowerCase(),
  commit: () => {},
  rollback: () => {},
  installCheckpoint: () => {},
  rollbackCheckpoint: () => {},
  close: () => Promise.resolve(),
});

setActiveProviderDeclarations(builtinProviderDeclarations());

const currentSelection = (): ModelSelection => defaultModelSelectionFor('openrouter-chat');

const alternateSelection = (): ModelSelection => {
  const current = currentSelection();
  const entry = modelCatalogEntryFor(current.provider, current.modelId);
  const effort = entry?.efforts.find((candidate) => candidate !== current.effort);
  if (effort !== undefined) {
    return selectModelFor(current.provider, current.modelId, effort as ReasoningEffort);
  }
  throw new Error('no alternate effort in the active model catalog');
};

const registry = async (
  history?: HistoryPersistencePort,
  currentModel?: () => ModelSelection,
): Promise<ChildRunRegistry> => {
  const childRef = managedChildRef();
  return new ChildRunRegistry({
    options: {
      handle: handle(),
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition: childRef,
      physicalIoMode: 'provider-free',
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
    },
    catalog: [{ name: 'probe-child', ref: childRef }],
    resolveManagedModule: managedChildModule,
    ...(history === undefined ? {} : { history }),
    ...(currentModel === undefined ? {} : { currentModelSelection: currentModel }),
    build: buildManifest(),
  });
};

const withStore = async (
  name: string,
  run: (store: SqliteHistoryV7ProductionStore) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: `henji-i131-${name}-` });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(`${root}/state`, workspaceRoot);
  await store.initialize();
  try {
    await run(store);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
};

const toolInputError = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof ToolInputError, `expected ToolInputError, got ${error}`);
    return error.message;
  }
  throw new Error('expected ToolInputError');
};

Deno.test('Increment 131 spawn_subagent carries model and tools and rejects malformed input', async () => {
  const requests: AsyncAgentRequest[] = [];
  const rpc = (
    request: AsyncAgentRequest,
  ): Promise<AsyncAgentResponse> => {
    requests.push(request);
    return Promise.resolve({ ok: true, kind: 'spawn', runId: 'run-1' });
  };
  const registryTools = createAsyncAgentTools(['probe-child'], rpc);
  const spawn = registryTools.find((tool) => tool.name === 'spawn_subagent')!;
  const result = await spawn.execute({
    agent: 'probe-child',
    task: 'investigate X',
    model: { provider: 'openrouter-chat', modelId: 'some-model', effort: 'high' },
    tools: ['read', 'bash'],
  }, { callId: 'c1', signal: undefined });
  assertEquals(JSON.parse(result as string), { ok: true, runId: 'run-1' });
  assertEquals(requests[0], {
    kind: 'spawn',
    agent: 'probe-child',
    task: 'investigate X',
    model: { provider: 'openrouter-chat', modelId: 'some-model', effort: 'high' },
    tools: ['read', 'bash'],
  });

  await toolInputError(() =>
    Promise.resolve(spawn.execute({
      agent: 'probe-child',
      task: 'x',
      tools: [],
    }, { callId: 'c2', signal: undefined }))
  );
  await toolInputError(() =>
    Promise.resolve(spawn.execute({
      agent: 'probe-child',
      task: 'x',
      tools: 'read',
    }, { callId: 'c3', signal: undefined }))
  );
  await toolInputError(() =>
    Promise.resolve(spawn.execute({
      agent: 'probe-child',
      task: 'x',
      tools: ['read', 5],
    }, { callId: 'c4', signal: undefined }))
  );

  for (
    const model of [5, { provider: 'openrouter-chat' }, {
      provider: 'openrouter-chat',
      modelId: 'm',
      effort: 5,
    }]
  ) {
    const failed = await spawn.execute({
      agent: 'probe-child',
      task: 'x',
      model: model as never,
    }, { callId: 'c5', signal: undefined });
    const parsed = JSON.parse(failed as string);
    assertEquals(parsed.ok, false);
    assert(`${parsed.error}`.includes('model must be an object'), parsed.error);
  }
  assertEquals(requests.length, 1);
});

Deno.test('Increment 131 rejects a model outside the active catalog without a runId', async () => {
  const children = await registry();
  const parentExecutionId = 'parent-i131-model-value';
  children.openParent(parentExecutionId);
  const spawned = await children.handle(
    {
      kind: 'spawn',
      agent: 'probe-child',
      task: 'x',
      model: { provider: 'no-such-provider', modelId: 'no-such-model' },
    },
    'spawn-i131-model-value',
    parentExecutionId,
  );
  assert(!spawned.ok, JSON.stringify(spawned));
  assert(`${spawned.error}`.includes('unknown provider'), spawned.error);
});

Deno.test('Increment 131 applies the spawn-time tool filter and records it in evidence', async () => {
  await withStore('tools', async (store) => {
    const alternate = alternateSelection();
    const children = await registry(store, currentSelection);
    const parentExecutionId = 'parent-i131-tools';
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      {
        kind: 'spawn',
        agent: 'probe-child',
        task: 'use the filtered tools',
        model: {
          provider: alternate.provider,
          modelId: alternate.modelId,
          effort: alternate.effort,
        },
        tools: ['read', 'bash'],
      },
      'spawn-i131-tools',
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    assertEquals(collected.result.state, 'completed');

    const row = store.readExecution(spawned.runId);
    const resources: readonly string[] = row.manifest?.resources ?? [];
    assert(resources.includes('tool:read'), JSON.stringify(resources));
    assert(resources.includes('tool:bash'), JSON.stringify(resources));
    assert(!resources.includes('tool:write'), JSON.stringify(resources));
    assert(!resources.includes('tool:web_search'), JSON.stringify(resources));
    assert(sameModelSelection(row.model, alternate), JSON.stringify(row.model));
  });
});

Deno.test('Increment 131 spawns without a model using the current session selection', async () => {
  await withStore('model-default', async (store) => {
    const current = currentSelection();
    const children = await registry(store, () => current);
    const parentExecutionId = 'parent-i131-model-default';
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      {
        kind: 'spawn',
        agent: 'probe-child',
        task: 'inherit the current session model',
      },
      'spawn-i131-model-default',
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    const row = store.readExecution(spawned.runId);
    assert(sameModelSelection(row.model, current), JSON.stringify(row.model));
  });
});

Deno.test('Increment 131 turns tool filter value errors into a failed run with a runId', async () => {
  const children = await registry();
  const parentExecutionId = 'parent-i131-filter-value';
  children.openParent(parentExecutionId);
  for (const tools of [['no-such-tool'], ['skill']]) {
    const spawned = await children.handle(
      {
        kind: 'spawn',
        agent: 'probe-child',
        task: 'x',
        tools,
      },
      `spawn-i131-filter-${tools[0]}`,
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    assertEquals(collected.result.state, 'failed');
    assert(
      `${collected.result.error}`.includes('tool_filter_invalid'),
      collected.result.error,
    );
  }
});

Deno.test('Increment 131 spawns the bundled generic child without install or bind', async () => {
  await withStore('generic', async (store) => {
    const genericRef = await builtinDefinitionRef('generic', buildManifest());
    const alternate = alternateSelection();
    const children = new ChildRunRegistry({
      options: {
        handle: handle(),
        workspaceRoot: Deno.cwd(),
        agent: 'default',
        definition: genericRef,
        physicalIoMode: 'provider-free',
        toolDefinitions: await bundledToolDefinitionLoadRequests(),
      },
      catalog: [{ name: 'generic', ref: genericRef }],
      history: store,
      build: buildManifest(),
    });
    const parentExecutionId = 'parent-i131-generic';
    children.openParent(parentExecutionId);
    const spawned = await children.handle(
      {
        kind: 'spawn',
        agent: 'generic',
        task: 'run as the generic child',
        model: {
          provider: alternate.provider,
          modelId: alternate.modelId,
          effort: alternate.effort,
        },
        tools: ['read'],
      },
      'spawn-i131-generic',
      parentExecutionId,
    );
    assert(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    assert(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    assertEquals(collected.result.state, 'completed');

    const row = store.readExecution(spawned.runId);
    assertEquals(row.definition.resourceId, 'builtin/generic');
    assert(sameModelSelection(row.model, alternate), JSON.stringify(row.model));
    const resources: readonly string[] = row.manifest?.resources ?? [];
    assert(resources.includes('tool:read'), JSON.stringify(resources));
    assert(!resources.includes('tool:write'), JSON.stringify(resources));
    assert(
      !resources.some((resource) => resource.startsWith('agent:')),
      JSON.stringify(resources),
    );
    assert(
      !resources.includes('instruction:external-agent-role'),
      JSON.stringify(resources),
    );
  });
});

Deno.test('Increment 131 the Host resolves agent:generic into the parent catalog without bindings', async () => {
  let startCatalog: readonly WorkerAsyncAgentCatalogEntry[] | undefined;
  const result = await createWorkerSession({
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
    capsuleFactory: (url) => {
      const created = new WorkerCapsule(url);
      return {
        send: (command) => {
          if (command.kind === 'start') {
            startCatalog = command.asyncAgents;
          }
          created.send(command);
        },
        subscribe: (listener) => created.subscribe(listener),
        terminate: () => created.terminate(),
      };
    },
  });
  try {
    assert(startCatalog !== undefined, 'parent start command must carry an async catalog');
    assertEquals(
      startCatalog.map((entry) => [entry.name, entry.ref.resourceId]),
      [['generic', 'builtin/generic']],
    );
  } finally {
    await result.close();
  }
});

Deno.test('Increment 131 rejects an agent:generic binding as a reserved slot', async () => {
  const configRoot = await Deno.makeTempDir({ prefix: 'henji-i131-binding-' });
  try {
    await Deno.writeTextFile(
      `${configRoot}/agents.json`,
      JSON.stringify({
        schemaVersion: 1,
        bindings: {
          'agent:generic': `builtin/generic@sha256:${'a'.repeat(64)}`,
        },
      }),
    );
    try {
      await readAgentSlotBindings(configRoot);
    } catch (error) {
      assert(error instanceof AgentBindingError, `${error}`);
      assertEquals(error.code, 'binding_slot_abolished');
      return;
    }
    throw new Error('expected AgentBindingError');
  } finally {
    await Deno.remove(configRoot, { recursive: true });
  }
});
