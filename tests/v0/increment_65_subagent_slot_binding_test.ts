import {
  AgentBindingError,
  agentSlotBindingsPath,
  parseAgentSlot,
  readAgentSlotBindings,
  resolveAgentSlotBindings,
} from '../../v0/agent/definitions/agent_slot_binding.ts';
import {
  type ManagedDefinitionRevision,
  ManagedDefinitionStore,
} from '../../v0/agent/definitions/managed_definition_store.ts';
import { ManagedDefinitionError } from '../../v0/agent/definitions/managed_definition_importer.ts';
import {
  DefinitionStartupError,
  resolveRequestedDefinition,
} from '../../v0/agent/definitions/definition_selection.ts';
import { main as runtimeMain } from '../../v0/agent/cli/runtime_cli.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import {
  roleDefaultModelSelection,
  selectModelFor,
} from '../../v0/agent/provider/model_catalog.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';

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

const installDefinition = async (
  store: ManagedDefinitionStore,
  root: string,
  resourceId: string,
): Promise<ManagedDefinitionRevision> => {
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}/entry.ts`,
    "import type {} from '@henji/agent';\n" +
      'export default function (input: unknown): unknown { return input; }\n',
  );
  return await store.install({
    entryPath: `${root}/entry.ts`,
    resourceId,
    declaredRole: 'parent',
  });
};

const definitionSelector = (revision: ManagedDefinitionRevision): string =>
  `${revision.manifest.logicalRef.resourceId}@sha256:${revision.manifest.logicalRef.revision.digest}`;

const assertBindingError = async (
  action: () => Promise<unknown>,
  code: AgentBindingError['code'],
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    assert(error instanceof AgentBindingError, `expected AgentBindingError, got ${error}`);
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
};

const writeBindings = async (
  configRoot: string,
  bindings: unknown,
): Promise<void> => {
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(agentSlotBindingsPath(configRoot), `${JSON.stringify(bindings)}\n`);
};

Deno.test('Increment 65 parses the root slot and async agent catalog names', () => {
  assertEquals(parseAgentSlot('agent:default'), { kind: 'root', slot: 'agent:default' });
  assertEquals(parseAgentSlot('agent:planner'), {
    kind: 'agent',
    slot: 'agent:planner',
    name: 'planner',
  });
  for (
    const value of [
      'subagent:planner',
      'subagent:',
      'subagent:Bad Name',
      'agent:',
      'agent:Bad Name',
      42,
      undefined,
    ]
  ) {
    assertEquals(parseAgentSlot(value), undefined);
  }
});

Deno.test('Increment 65 resolves an agent:<name> async catalog entry', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-async-' });
  try {
    const store = new ManagedDefinitionStore({ dataRoot: `${root}/data` });
    const agent = await installDefinition(store, `${root}/agent`, 'example/async-agent');
    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'agent:researcher': definitionSelector(agent) },
    });
    const resolved = await resolveAgentSlotBindings(`${root}/config`, `${root}/data`);
    assertEquals(resolved.get('agent:researcher')?.slot, {
      kind: 'agent',
      slot: 'agent:researcher',
      name: 'researcher',
    });
    assertEquals(resolved.get('agent:researcher')?.ref, agent.manifest.logicalRef);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 65 treats a missing agents.json as no bindings', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-missing-' });
  try {
    assertEquals(await readAgentSlotBindings(`${root}/config`), {
      schemaVersion: 1,
      bindings: {},
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 65 rejects the abolished subagent slot with a typed diagnostic', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-abolished-' });
  try {
    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'subagent:planner': 'example/planner@sha256:' + 'a'.repeat(64) },
    });
    await assertBindingError(
      () => readAgentSlotBindings(`${root}/config`),
      'binding_slot_abolished',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 65 rejects a new subagent Definition install', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-install-' });
  try {
    const store = new ManagedDefinitionStore({ dataRoot: `${root}/data` });
    await Deno.mkdir(`${root}/planner`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/planner/entry.ts`,
      "import type {} from '@henji/agent';\n" +
        'export default function (input: unknown): unknown { return input; }\n',
    );
    try {
      await store.install({
        entryPath: `${root}/planner/entry.ts`,
        resourceId: 'example/planner',
        declaredRole: 'subagent',
        subagentName: 'planner',
      });
      throw new Error('expected module_invalid');
    } catch (error) {
      assert(
        error instanceof ManagedDefinitionError,
        `expected ManagedDefinitionError, got ${error}`,
      );
      assertEquals(error.code, 'module_invalid');
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const writeParentModule = async (root: string): Promise<string> => {
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}/composition.ts`,
    "import { createDefaultAgentComposition, type ExecutableAgentDefinitionInput } from '@henji/agent';\n" +
      'export const compose = (input: ExecutableAgentDefinitionInput) =>\n' +
      '  createDefaultAgentComposition(input);\n',
  );
  await Deno.writeTextFile(
    `${root}/entry.ts`,
    "import type { ExecutableAgentDefinition } from '@henji/agent';\n" +
      "import { compose } from './composition.ts';\n" +
      'const definition: ExecutableAgentDefinition = (input) => compose(input);\n' +
      'export default definition;\n',
  );
  return `${root}/entry.ts`;
};

Deno.test('Increment 65 resolves the agent:default binding as the root Definition', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-root-resolve-' });
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  try {
    const store = new ManagedDefinitionStore({ dataRoot });
    const bound = await installDefinition(store, `${root}/bound`, 'example/root-bound');
    await writeBindings(configRoot, {
      schemaVersion: 1,
      bindings: { 'agent:default': definitionSelector(bound) },
    });

    const resolved = await resolveRequestedDefinition(undefined, undefined, dataRoot, configRoot);
    assertEquals(resolved.kind, 'managed');
    assertEquals(resolved.id, 'default');
    assertEquals(resolved.ref, bound.manifest.logicalRef);

    const explicit = await installDefinition(store, `${root}/explicit`, 'example/root-explicit');
    const overridden = await resolveRequestedDefinition(
      undefined,
      definitionSelector(explicit),
      dataRoot,
      configRoot,
    );
    assertEquals(overridden.ref, explicit.manifest.logicalRef);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 115 headless default selection uses the runtime XDG roots', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-115-headless-root-' });
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  const emptyConfigRoot = `${root}/empty-config`;
  try {
    const store = new ManagedDefinitionStore({ dataRoot });
    const bound = await installDefinition(store, `${root}/bound`, 'example/headless-bound');
    await writeBindings(configRoot, {
      schemaVersion: 1,
      bindings: { 'agent:default': definitionSelector(bound) },
    });
    const selected: { kind: string; ref: unknown }[] = [];
    let selectedConfigRoot = configRoot;
    const dependencies = {
      stdinIsTerminal: () => false,
      readStdin: () => Promise.resolve(new TextEncoder().encode('headless task')),
      runtimePaths: () => ({ dataRoot, configRoot: selectedConfigRoot }),
      run: (task: string, selection: { kind: string; ref: unknown }) => {
        selected.push({ kind: selection.kind, ref: selection.ref });
        return Promise.resolve({
          outcome: {
            ok: true as const,
            task,
            outcome: 'final' as const,
            stopReason: 'final' as const,
            finalText: 'done',
            steps: 1,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
          },
          requestCount: 0,
        });
      },
      writeStdout: () => {},
      writeStderr: () => {},
    };
    assertEquals(await runtimeMain([], dependencies), 0);
    assertEquals(selected[0], { kind: 'managed', ref: bound.manifest.logicalRef });

    assertEquals(await runtimeMain(['--agent', 'default'], dependencies), 0);
    assertEquals(selected[1]?.kind, 'builtin');

    selectedConfigRoot = emptyConfigRoot;
    assertEquals(await runtimeMain([], dependencies), 0);
    assertEquals(selected[2]?.kind, 'builtin');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 65 fails typed on an invalid agent:default binding', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-root-invalid-' });
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  try {
    await writeBindings(configRoot, {
      schemaVersion: 1,
      bindings: { 'agent:default': `example/absent@sha256:${'a'.repeat(64)}` },
    });
    try {
      await resolveRequestedDefinition(undefined, undefined, dataRoot, configRoot);
      throw new Error('expected definition_not_found');
    } catch (error) {
      assert(error instanceof DefinitionStartupError);
      assertEquals(error.code, 'definition_not_found');
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 65 starts a new session with the bound root Definition', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-root-run-' });
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  const stateRoot = `${root}/state`;
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  try {
    const store = new ManagedDefinitionStore({ dataRoot });
    const bound = await store.install({
      entryPath: await writeParentModule(`${root}/bound`),
      resourceId: 'example/root-parent',
      declaredRole: 'parent',
    });
    await writeBindings(configRoot, {
      schemaVersion: 1,
      bindings: { 'agent:default': definitionSelector(bound) },
    });

    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot,
      configRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    try {
      const outcome = await created.session.submit('ordinary parent task');
      assert(outcome.ok, JSON.stringify(outcome));
      assertEquals(outcome.finalText, 'worker answer: ordinary parent task');
    } finally {
      await created.close();
    }
    const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
    await history.initialize();
    const artifact = (await history.executionArtifacts.list()).find((item) =>
      item.sessionId === created.session.sessionId
    );
    assert(artifact !== undefined);
    assertEquals(artifact.definition, bound.manifest.logicalRef);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 65 supplies the planner default from bundled roleDefaults data', async () => {
  const defaults = JSON.parse(
    await Deno.readTextFile(
      new URL(
        '../../v0/agent/provider/defaults/provider-defaults.json',
        import.meta.url,
      ),
    ),
  );
  const entry = defaults.roleDefaults?.['subagent:planner'];
  assert(entry !== undefined, 'bundled subagent:planner roleDefault is missing');
  assertEquals(
    roleDefaultModelSelection('subagent:planner'),
    selectModelFor(entry.providerId, entry.modelId, entry.effort),
  );
});

Deno.test('Increment 65 fails typed on unknown slots and malformed files', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-invalid-' });
  try {
    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'other:thing': 'example/parent@sha256:' + 'a'.repeat(64) },
    });
    await assertBindingError(
      () => readAgentSlotBindings(`${root}/config`),
      'binding_slot_unknown',
    );

    await writeBindings(`${root}/config`, {
      schemaVersion: 2,
      bindings: { 'agent:default': 'example/parent@sha256:' + 'a'.repeat(64) },
    });
    await assertBindingError(
      () => readAgentSlotBindings(`${root}/config`),
      'binding_invalid',
    );

    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'agent:default': 'not-a-selector' },
    });
    const dataRoot = `${root}/data`;
    try {
      await resolveRequestedDefinition(undefined, undefined, dataRoot, `${root}/config`);
      throw new Error('expected definition_invalid');
    } catch (error) {
      assert(error instanceof DefinitionStartupError);
      assertEquals(error.code, 'definition_invalid');
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
