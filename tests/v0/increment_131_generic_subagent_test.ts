import {
  childDataTest,
  closeChildDataTests,
  createChildDataTestRegistry,
} from './helpers/increment_170_child_data.ts';
import {
  type AsyncAgentRequest,
  type AsyncAgentResponse,
  createAsyncAgentTools,
} from '../../v0/agent/tools/async_agents.ts';
import { ToolInputError } from '../../v0/agent/tools/tools.ts';
import { writeProbeAgentConfiguration } from './managed_child_fixture.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { resolveWorkerConfiguration } from '../../v0/agent/configuration/configuration_resolver.ts';
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

setActiveProviderDeclarations(builtinProviderDeclarations());

const currentSelection = (): ModelSelection => defaultModelSelectionFor('openrouter-chat');

const alternateSelection = (): ModelSelection => {
  const current = currentSelection();
  const entry = modelCatalogEntryFor(current.provider, current.modelId);
  const effort = entry?.efforts.find((candidate) => candidate !== current.effort);
  if (effort !== undefined) {
    return selectModelFor(
      current.provider,
      current.modelId,
      effort as ReasoningEffort,
    );
  }
  throw new Error('no alternate effort in the active model catalog');
};

const registry = async (
  history?: SqliteHistoryStore,
  currentModel?: () => ModelSelection,
  setupConfiguration: (configRoot: string) => Promise<void> = async (
    configRoot,
  ) => {
    await writeProbeAgentConfiguration(configRoot);
  },
): Promise<Awaited<ReturnType<typeof createChildDataTestRegistry>>> => {
  return await createChildDataTestRegistry({
    options: {
      physicalIoMode: 'provider-free',
    },
    currentCatalog: () => ['probe-child'],
    setupConfiguration,
    ...(history === undefined ? {} : { store: history }),
    ...(currentModel === undefined ? {} : { currentModelSelection: currentModel }),
  });
};

const withStore = async (
  name: string,
  run: (store: SqliteHistoryStore) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: `henji-i131-${name}-` });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(`${root}/state`, workspaceRoot);
  await store.initialize();
  try {
    await run(store);
  } finally {
    await closeChildDataTests(store);
    store.close();
    await Deno.remove(root, { recursive: true });
  }
};

const toolInputError = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    assert(
      error instanceof ToolInputError,
      `expected ToolInputError, got ${error}`,
    );
    return error.message;
  }
  throw new Error('expected ToolInputError');
};

childDataTest(
  'Increment 131 spawn_subagent carries model and tools and rejects malformed input',
  async () => {
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
      model: {
        provider: 'openrouter-chat',
        modelId: 'some-model',
        effort: 'high',
      },
      tools: ['read', 'bash'],
    }, { callId: 'c1', signal: undefined });
    assertEquals(JSON.parse(result as string), { ok: true, runId: 'run-1' });
    assertEquals(requests[0], {
      kind: 'spawn',
      agent: 'probe-child',
      task: 'investigate X',
      model: {
        provider: 'openrouter-chat',
        modelId: 'some-model',
        effort: 'high',
      },
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
      assert(
        `${parsed.error}`.includes('model must be an object'),
        parsed.error,
      );
    }
    assertEquals(requests.length, 1);
  },
);

childDataTest(
  'Increment 131 rejects a model outside the active catalog without a runId',
  async () => {
    const fixture = await registry();
    const { registry: children } = fixture;
    const parentExecutionId = 'parent-i131-model-value';
    await fixture.seedParentExecution(parentExecutionId);
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
  },
);

childDataTest(
  'Increment 131 applies the spawn-time tool filter and records it in evidence',
  async () => {
    await withStore('tools', async (store) => {
      const alternate = alternateSelection();
      const fixture = await registry(
        store,
        currentSelection,
        async (configRoot) => {
          await writeProbeAgentConfiguration(configRoot, 'probe-child', {
            name: 'probe-child',
            revision: 'increment-131-tools',
            instruction: 'Use available tools for the assigned child task.',
            tools: [
              'read',
              'write',
              'bash',
              'bash_output',
              'web_search',
              'web_fetch',
            ],
            agents: [],
          });
        },
      );
      const { registry: children } = fixture;
      const parentExecutionId = 'parent-i131-tools';
      await fixture.seedParentExecution(parentExecutionId);
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
      assert(
        collected.ok && collected.kind === 'collect',
        JSON.stringify(collected),
      );
      assertEquals(collected.result.state, 'completed');

      const row = store.readExecution(spawned.runId);
      const tools = row.configuration.tools.map((tool) => tool.name);
      assert(tools.includes('read'), JSON.stringify(tools));
      assert(tools.includes('bash'), JSON.stringify(tools));
      assert(!tools.includes('write'), JSON.stringify(tools));
      assert(!tools.includes('web_search'), JSON.stringify(tools));
      assert(
        sameModelSelection(row.model, alternate),
        JSON.stringify(row.model),
      );
    });
  },
);

childDataTest(
  'Increment 131 spawns without a model using the current session selection',
  async () => {
    await withStore('model-default', async (store) => {
      const current = currentSelection();
      const fixture = await registry(store, () => current);
      const { registry: children } = fixture;
      const parentExecutionId = 'parent-i131-model-default';
      await fixture.seedParentExecution(parentExecutionId);
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
      assert(
        collected.ok && collected.kind === 'collect',
        JSON.stringify(collected),
      );
      const row = store.readExecution(spawned.runId);
      assert(sameModelSelection(row.model, current), JSON.stringify(row.model));
    });
  },
);

childDataTest(
  'Increment 131 turns tool filter value errors into a failed run with a runId',
  async () => {
    const fixture = await registry();
    const { registry: children } = fixture;
    const parentExecutionId = 'parent-i131-filter-value';
    await fixture.seedParentExecution(parentExecutionId);
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
      assert(
        collected.ok && collected.kind === 'collect',
        JSON.stringify(collected),
      );
      assertEquals(collected.result.state, 'failed');
      assert(
        `${collected.result.error}`.includes('tool_filter_invalid'),
        collected.result.error,
      );
    }
  },
);

childDataTest(
  'Increment 131 spawns the bundled generic child without install or bind',
  async () => {
    await withStore('generic', async (store) => {
      const alternate = alternateSelection();
      const fixture = await createChildDataTestRegistry({
        options: {
          physicalIoMode: 'provider-free',
        },
        currentCatalog: () => ['generic'],
        store,
      });
      const { registry: children } = fixture;
      const parentExecutionId = 'parent-i131-generic';
      await fixture.seedParentExecution(parentExecutionId);
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
      assert(
        collected.ok && collected.kind === 'collect',
        JSON.stringify(collected),
      );
      assertEquals(collected.result.state, 'completed');

      const row = store.readExecution(spawned.runId);
      assertEquals(row.configuration.agent.name, 'generic');
      assert(
        sameModelSelection(row.model, alternate),
        JSON.stringify(row.model),
      );
      const tools = row.configuration.tools.map((tool) => tool.name);
      assert(tools.includes('read'), JSON.stringify(tools));
      assert(!tools.includes('write'), JSON.stringify(tools));
      assert(
        row.configuration.instructionComponents.every((component) =>
          component.identity !== 'instruction:external-agent-role'
        ),
        JSON.stringify(row.configuration.instructionComponents),
      );
      assert(
        row.configuration.source.kind === 'bundled',
        JSON.stringify(row.configuration.source),
      );
    });
  },
);

childDataTest(
  'Increment 131 a bundled root exposes the generic child in its ready configuration',
  async () => {
    const root = await Deno.makeTempDir({ prefix: 'henji-i131-host-' });
    let configuredAgents: readonly string[] | undefined;
    const result = await createWorkerSession({
      workspaceRoot: root,
      stateRoot: `${root}/state`,
      configRoot: `${root}/config`,
      dataRoot: `${root}/data`,
      persistence: 'none',
      physicalIoMode: 'provider-free',
      capsuleFactory: (url) => {
        const created = new WorkerCapsule(url);
        return {
          send: (command, transfer) => {
            created.send(command, transfer);
          },
          subscribe: (listener) =>
            created.subscribe((message) => {
              if (message.kind === 'ready') {
                configuredAgents = message.configuration?.agent.agents;
              }
              listener(message);
            }),
          terminate: () => created.terminate(),
        };
      },
    });
    try {
      assert(
        configuredAgents !== undefined,
        'Worker ready must carry current Agent config',
      );
      assertEquals(configuredAgents, ['generic']);
    } finally {
      await result.close();
      await Deno.remove(root, { recursive: true });
    }
  },
);

childDataTest(
  'Increment 131 generic stays bundled when named in the external catalog',
  async () => {
    const configRoot = await Deno.makeTempDir({
      prefix: 'henji-i131-binding-',
    });
    try {
      await Deno.mkdir(`${configRoot}/agents`, { recursive: true });
      await Deno.writeTextFile(
        `${configRoot}/agents.json`,
        JSON.stringify({
          schemaVersion: 1,
          agents: { generic: 'agents/generic.json' },
        }),
      );
      const selection = await resolveWorkerConfiguration(configRoot, {
        name: 'generic',
      });
      assertEquals(selection.agent?.configuration.name, 'generic');
      assertEquals(selection.agent?.source.kind, 'bundled');
      assert(
        selection.agents[0]?.rejection?.reason.includes(
          'generic uses the bundled configuration',
        ),
      );
    } finally {
      await Deno.remove(configRoot, { recursive: true });
    }
  },
);
