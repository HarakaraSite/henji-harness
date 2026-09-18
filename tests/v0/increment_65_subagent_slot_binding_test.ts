import {
  AgentBindingError,
  agentSlotBindingsPath,
  parseAgentSlot,
  readAgentSlotBindings,
  resolveAgentSlotBindings,
} from '../../v0/agent/definitions/agent_slot_binding.ts';
import { ManagedDefinitionStore } from '../../v0/agent/definitions/managed_definition_store.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { roleDefaultModelSelection } from '../../v0/agent/provider/model_catalog.ts';
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

const writeDefinition = async (
  store: ManagedDefinitionStore,
  root: string,
  resourceId: string,
  role: 'parent' | 'subagent',
  subagentName?: string,
): Promise<string> => {
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}/entry.ts`,
    "import type {} from '@henji/agent';\n" +
      'export default function (input: unknown): unknown { return input; }\n',
  );
  const revision = await store.install({
    entryPath: `${root}/entry.ts`,
    resourceId,
    declaredRole: role,
    ...(subagentName === undefined ? {} : { subagentName }),
  });
  return `${revision.manifest.logicalRef.resourceId}@sha256:${revision.manifest.logicalRef.revision.digest}`;
};

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

Deno.test('Increment 65 parses only the root and named subagent slots', () => {
  assertEquals(parseAgentSlot('agent:default'), { kind: 'root', slot: 'agent:default' });
  assertEquals(parseAgentSlot('subagent:planner'), {
    kind: 'subagent',
    slot: 'subagent:planner',
    name: 'planner',
  });
  for (const value of ['agent:planner', 'subagent:', 'subagent:Bad Name', 42, undefined]) {
    assertEquals(parseAgentSlot(value), undefined);
  }
});

Deno.test('Increment 65 treats a missing agents.json as no bindings', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-missing-' });
  try {
    assertEquals(await readAgentSlotBindings(`${root}/config`), {
      schemaVersion: 1,
      bindings: {},
    });
    assertEquals(await resolveAgentSlotBindings(`${root}/config`, `${root}/data`), new Map());
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 65 resolves a bound subagent Definition and a parent root slot', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-resolve-' });
  try {
    const store = new ManagedDefinitionStore({ dataRoot: `${root}/data` });
    const planner = await writeDefinition(
      store,
      `${root}/planner`,
      'example/planner',
      'subagent',
      'planner',
    );
    const parent = await writeDefinition(store, `${root}/parent`, 'example/parent', 'parent');
    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: {
        'subagent:planner': planner,
        'agent:default': parent,
      },
    });

    const resolved = await resolveAgentSlotBindings(`${root}/config`, `${root}/data`);
    assertEquals([...resolved.keys()].sort(), ['agent:default', 'subagent:planner']);
    assertEquals(resolved.get('subagent:planner')?.revision.manifest.subagentName, 'planner');
    assertEquals(resolved.get('agent:default')?.revision.manifest.declaredRole, 'parent');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 65 fails typed on role and name mismatch', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-role-' });
  try {
    const store = new ManagedDefinitionStore({ dataRoot: `${root}/data` });
    const parent = await writeDefinition(store, `${root}/parent`, 'example/parent', 'parent');
    const researcher = await writeDefinition(
      store,
      `${root}/researcher`,
      'example/researcher',
      'subagent',
      'researcher',
    );

    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'subagent:planner': parent },
    });
    await assertBindingError(
      () => resolveAgentSlotBindings(`${root}/config`, `${root}/data`),
      'binding_role_mismatch',
    );

    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'subagent:planner': researcher },
    });
    await assertBindingError(
      () => resolveAgentSlotBindings(`${root}/config`, `${root}/data`),
      'binding_role_mismatch',
    );

    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'agent:default': researcher },
    });
    await assertBindingError(
      () => resolveAgentSlotBindings(`${root}/config`, `${root}/data`),
      'binding_role_mismatch',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const writePlannerModule = async (root: string): Promise<string> => {
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}/composition.ts`,
    "import { createPlannerAgentComposition, type ExecutableAgentDefinitionInput } from '@henji/agent';\n" +
      'export const compose = (input: ExecutableAgentDefinitionInput) =>\n' +
      '  createPlannerAgentComposition(input);\n',
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

Deno.test('Increment 65 composes a bound external planner into the root composition', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-compose-' });
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  const stateRoot = `${root}/state`;
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  try {
    const store = new ManagedDefinitionStore({ dataRoot });
    const planner = await store.install({
      entryPath: await writePlannerModule(`${root}/planner`),
      resourceId: 'example/runtime-planner',
      declaredRole: 'subagent',
      subagentName: 'planner',
    });
    const selector =
      `${planner.manifest.logicalRef.resourceId}@sha256:${planner.manifest.logicalRef.revision.digest}`;
    await writeBindings(configRoot, {
      schemaVersion: 1,
      bindings: { 'subagent:planner': selector },
    });
    await Deno.remove(`${root}/planner`, { recursive: true });

    const events: AgentEvent[] = [];
    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot,
      configRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
      eventSink: (event) => events.push(event),
    });
    try {
      const outcome = await created.session.submit('delegate to planner');
      assert(outcome.ok, JSON.stringify(outcome));
      assertEquals(outcome.finalText, 'worker answer: delegate to planner');
    } finally {
      await created.close();
    }
    const delegation = events.find((event) => event.kind === 'tool_result');
    assert(delegation?.kind === 'tool_result');
    assertEquals(
      delegation.result.text,
      JSON.stringify({
        ok: true,
        agent: 'planner',
        output: { kind: 'text', text: 'worker planner result' },
        usage: { modelRequests: 1, externalRequests: 0 },
      }),
    );

    const history = new SqliteHistoryStore(stateRoot, workspaceRoot);
    await history.initialize();
    const artifact = (await history.executionArtifacts.list()).find((item) =>
      item.sessionId === created.session.sessionId
    );
    assert(artifact !== undefined);
    assertEquals(artifact.manifest.subagents, [{
      subagentName: 'planner',
      ref: planner.manifest.logicalRef,
    }]);
    assert(artifact.schemaVersion === 6);
    assertEquals(artifact.subagents, [{
      subagentName: 'planner',
      ref: planner.manifest.logicalRef,
    }]);
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
  assertEquals(entry.providerId, 'openrouter-chat');
  assertEquals(roleDefaultModelSelection('subagent:planner'), {
    provider: entry.providerId,
    api: 'openrouter-chat-completions',
    authProfile: 'openrouter-api-key',
    modelId: entry.modelId,
    effort: entry.effort,
  });
});

Deno.test('Increment 65 fails typed on unknown slots, malformed files, and missing revisions', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-65-invalid-' });
  try {
    const store = new ManagedDefinitionStore({ dataRoot: `${root}/data` });
    const planner = await writeDefinition(
      store,
      `${root}/planner`,
      'example/planner',
      'subagent',
      'planner',
    );
    const missing = `example/absent@sha256:${'a'.repeat(64)}`;

    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'agent:other': planner },
    });
    await assertBindingError(
      () => resolveAgentSlotBindings(`${root}/config`, `${root}/data`),
      'binding_slot_unknown',
    );

    await writeBindings(`${root}/config`, {
      schemaVersion: 2,
      bindings: { 'subagent:planner': planner },
    });
    await assertBindingError(
      () => resolveAgentSlotBindings(`${root}/config`, `${root}/data`),
      'binding_invalid',
    );

    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'subagent:planner': 'not-a-selector' },
    });
    await assertBindingError(
      () => resolveAgentSlotBindings(`${root}/config`, `${root}/data`),
      'binding_invalid',
    );

    await writeBindings(`${root}/config`, {
      schemaVersion: 1,
      bindings: { 'subagent:planner': missing },
    });
    await assertBindingError(
      () => resolveAgentSlotBindings(`${root}/config`, `${root}/data`),
      'binding_definition_not_found',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
