import reviewer from '../../agents/reviewer.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import {
  DefinitionStartupError,
  resolveDefinitionRef,
  resolveRequestedDefinition,
} from '../../v0/agent/definitions/definition_selection.ts';
import { ManagedDefinitionStore } from '../../v0/agent/definitions/managed_definition_store.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { selectOpenRouterModel } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { createProviderFreePhysicalIo } from '../../v0/agent/worker/worker_probe_physical_io.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { bundledToolComponents } from './bundled_tool_components.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const binding = async (
  configRoot: string,
  values: Readonly<Record<string, string>>,
): Promise<void> => {
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/agents.json`,
    JSON.stringify({
      schemaVersion: 1,
      bindings: values,
    }),
  );
};

const selector = (
  ref: { resourceId: string; revision: { digest: string } },
): string => `${ref.resourceId}@sha256:${ref.revision.digest}`;

Deno.test('Increment 127 keeps a bundled default and excludes a bundled planner', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-default-' });
  try {
    const selected = await resolveRequestedDefinition(
      undefined,
      undefined,
      `${root}/data`,
      `${root}/config`,
    );
    assert(selected.kind === 'builtin' && selected.id === 'default');
    assert(
      !(buildManifest().builtinResources ?? []).some((entry) =>
        entry.resourceId === 'builtin/planner'
      ),
    );
    const oldPlanner = {
      schemaVersion: 1 as const,
      resourceKind: 'agent-definition' as const,
      resourceId: 'builtin/planner',
      revision: { algorithm: 'sha256' as const, digest: 'a'.repeat(64) },
    };
    let error: unknown;
    try {
      await resolveDefinitionRef(oldPlanner, `${root}/data`);
    } catch (caught) {
      error = caught;
    }
    assert(
      error instanceof DefinitionStartupError &&
        error.code === 'definition_not_found',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 127 external reviewer declares investigation tools and no child agents', () => {
  const physicalIo = createProviderFreePhysicalIo();
  const composition = reviewer({
    workspace: { root: Deno.cwd() },
    skillCatalog: emptySkillCatalog(),
    physicalIo,
    toolDefinitions: bundledToolComponents(physicalIo),
    asyncAgentNames: ['planner'],
  });
  const resources = composition.manifest.resources;
  assert(resources.includes('instruction:external-agent-role'));
  for (const tool of ['bash', 'bash_output', 'read']) {
    assert(resources.includes(`tool:${tool}`));
  }
  for (const tool of ['edit', 'write', 'spawn_subagent']) {
    assert(
      !composition.registry.definitions().some((entry) => entry.name === tool),
    );
  }
  assert(!resources.includes('agent:planner'));
});

Deno.test('Increment 127 headless Worker uses the configured default model selection', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-selection-' });
  const configRoot = `${root}/config`;
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(configRoot);
  await Deno.mkdir(workspaceRoot);
  const selected = selectOpenRouterModel('qwen/qwen3.8-flash');
  await Deno.writeTextFile(`${configRoot}/default-selection.json`, JSON.stringify(selected));
  try {
    const created = await createWorkerSession({
      workspaceRoot,
      dataRoot: `${root}/data`,
      configRoot,
      persistence: 'none',
      physicalIoMode: 'provider-free',
    });
    try {
      assert(
        JSON.stringify(created.session.modelSelectionSnapshot()) === JSON.stringify(selected),
      );
    } finally {
      await created.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 127 managed reviewer spawns and collects through the parent Worker', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-reviewer-' });
  const workspaceRoot = `${root}/workspace`;
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  await Deno.mkdir(workspaceRoot);
  try {
    const installed = await new ManagedDefinitionStore({ dataRoot }).install({
      entryPath: new URL('../../agents/reviewer.ts', import.meta.url).pathname,
      resourceId: 'test/reviewer',
      declaredRole: 'parent',
    });
    const ref = installed.manifest.logicalRef;
    await binding(configRoot, { 'agent:reviewer': selector(ref) });
    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot: `${root}/state`,
      dataRoot,
      configRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    try {
      const outcome = await created.session.submit('async-spawn reviewer turn');
      assert(outcome.ok, JSON.stringify(outcome));
      assert(
        outcome.finalText === 'async child: worker child result',
        outcome.finalText,
      );
    } finally {
      await created.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 127 external planner and external default use managed bindings', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-planner-' });
  const workspaceRoot = `${root}/workspace`;
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  await Deno.mkdir(workspaceRoot);
  try {
    const installed = await new ManagedDefinitionStore({ dataRoot }).install({
      entryPath: new URL('./fixtures/managed_child_definition.ts', import.meta.url)
        .pathname,
      resourceId: 'test/external-planner',
      declaredRole: 'parent',
    });
    const ref = installed.manifest.logicalRef;
    await binding(configRoot, { 'agent:planner': selector(ref) });
    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot: `${root}/state`,
      dataRoot,
      configRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    try {
      const outcome = await created.session.submit('async-spawn planner turn');
      assert(outcome.ok, JSON.stringify(outcome));
      assert(
        outcome.finalText === 'async child: worker child result',
        outcome.finalText,
      );
    } finally {
      await created.close();
    }
    await binding(configRoot, { 'agent:default': selector(ref) });
    const selected = await resolveRequestedDefinition(
      undefined,
      undefined,
      dataRoot,
      configRoot,
    );
    assert(
      selected.kind === 'managed' &&
        selected.ref.revision.digest === ref.revision.digest,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
