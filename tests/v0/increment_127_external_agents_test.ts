import { createSkillTool } from '../../v0/agent/definitions/skills.ts';
import { resolveWorkerConfiguration } from '../../v0/agent/configuration/configuration_resolver.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { finalizeWorkerInstructionComposition } from '../../v0/agent/instructions/worker_core_finalizer.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import { selectOpenRouterModel } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { createProviderFreePhysicalIo } from '../../v0/agent/worker/worker_probe_physical_io.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { createWorkerComposition, type ToolComponent } from '../../v0/agent/worker_agent_api.ts';
import { runHeadlessWorker } from '../../v0/agent/worker/worker_headless_runner.ts';
import { bundledToolComponents } from './bundled_tool_components.ts';
import { activateRepositoryExternalToolBindings } from './helpers/external_web_tools.ts';

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

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await Deno.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(file, JSON.stringify(value));
};

const writeReviewerConfiguration = async (
  configRoot: string,
  rootAgents: readonly string[] = ['reviewer'],
): Promise<void> => {
  const reviewer = JSON.parse(
    await Deno.readTextFile(new URL('../../agents/reviewer.json', import.meta.url)),
  ) as Record<string, unknown>;
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/default.json',
    agents: { reviewer: 'agents/reviewer.json' },
  });
  await writeJson(`${configRoot}/agents/default.json`, {
    name: 'default',
    revision: '1',
    agents: rootAgents,
  });
  await writeJson(`${configRoot}/agents/reviewer.json`, reviewer);
  await activateRepositoryExternalToolBindings(configRoot);
};

Deno.test('Increment 127 keeps the bundled JSON default and has no bundled planner', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-default-' });
  try {
    const selected = await resolveWorkerConfiguration(`${root}/config`);
    assert(selected.agent !== undefined);
    assertEquals(selected.agent.source.kind, 'bundled');
    assertEquals(selected.agent.configuration.name, 'default');
    assertEquals(selected.agent.configuration.agents, ['generic']);
    assert(!selected.agent.configuration.agents.includes('planner'));
    assertEquals(buildManifest().agentConfigurationSchemaVersion, 1);
    assertEquals(buildManifest().supportedToolApiContracts, ['henji-tool/v1']);
    assertEquals(buildManifest().supportedHookApiContracts, ['henji-hooks/v2']);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 127 named reviewer JSON retains its role and investigation tools', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-reviewer-config-' });
  const configRoot = `${root}/config`;
  try {
    await writeReviewerConfiguration(configRoot, []);
    const selected = await resolveWorkerConfiguration(configRoot, { name: 'reviewer' });
    assert(selected.agent !== undefined);
    const agent = selected.agent.configuration;
    assertEquals(agent.name, 'reviewer');
    assert(agent.instruction.includes('You are a reviewer.'));
    assert(agent.instruction.includes('Do not edit the workspace.'));
    assertEquals(agent.tools, ['git_inspect', 'read', 'ls', 'find', 'grep', 'wc', 'skill']);
    assertEquals(agent.agents, []);

    const physicalIo = createProviderFreePhysicalIo();
    const skillCatalog = {
      manifest: '## Project skills\n\n- review-checklist: Use the review checklist.',
      skills: [{
        name: 'review-checklist',
        description: 'Use the review checklist.',
        sourceDirectory: '.agents/skills/review-checklist',
        body: 'Check changed code and user-visible behavior.',
        toolResult: 'Check changed code and user-visible behavior.',
      }],
    };
    const configuredTools = new Set(agent.tools);
    const components: readonly ToolComponent[] = [
      ...bundledToolComponents(),
      {
        identity: createAgentResourceIdentity('tool:skill'),
        materialize: () => createSkillTool(skillCatalog),
      },
      ...['ls', 'find', 'grep', 'wc'].map((name) => ({
        identity: createAgentResourceIdentity(`tool:${name}`),
        materialize: () => ({
          name,
          fileAccess: 'read' as const,
          description: `${name} inspection`,
          inputSchema: { type: 'object' as const },
          execute: () => '{}',
        }),
      })),
      {
        identity: createAgentResourceIdentity('tool:git_inspect'),
        materialize: () => ({
          name: 'git_inspect',
          fileAccess: 'read' as const,
          description: 'Inspect the repository read-only.',
          inputSchema: { type: 'object' },
          execute: () => '{}',
        }),
      },
    ].filter(({ identity }) => configuredTools.has(String(identity).slice('tool:'.length)));
    const composition = finalizeWorkerInstructionComposition(createWorkerComposition({
      workspace: { root: Deno.cwd() },
      skillCatalog,
      physicalIo,
      toolComponents: components,
      asyncAgentNames: agent.agents,
    }, { roleInstruction: agent.instruction }));
    assert(composition.systemInstruction?.includes(agent.instruction));
    for (const name of ['git_inspect', 'read', 'ls', 'find', 'grep', 'wc', 'skill']) {
      assert(composition.registry.definitions().some((tool) => tool.name === name));
      assert(composition.manifest.resources.includes(`tool:${name}`));
    }
    for (const name of ['bash', 'bash_output', 'edit', 'write', 'web_search', 'run_typescript']) {
      assert(!composition.registry.definitions().some((tool) => tool.name === name));
    }
    assert(composition.manifest.resources.includes('instruction:henji-base'));
    assert(composition.manifest.resources.includes('skill:review-checklist'));
    assert(!composition.manifest.resources.includes('agent:reviewer'));
    assert(!composition.manifest.resources.includes('agent:planner'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 127 reviewer Worker composes read and dedicated inspection guidance without bash', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-reviewer-instruction-' });
  try {
    await writeReviewerConfiguration(`${root}/config`);
    const result = await runHeadlessWorker(
      'return active tool guidelines',
      { name: 'reviewer' },
      {
        workspaceRoot: root,
        stateRoot: `${root}/state`,
        configRoot: `${root}/config`,
        dataRoot: `${root}/data`,
        physicalIoMode: 'provider-free',
      },
    );
    assert(result.outcome.ok, JSON.stringify(result.outcome));
    const instruction = result.outcome.finalText ?? '';
    assert(instruction.includes('no general shell is available'));
    assert(instruction.includes('- read: For file inspection,'));
    for (const name of ['ls', 'find', 'grep', 'wc']) assert(instruction.includes(`- ${name}:`));
    assert(instruction.includes('Current find backend: find'));
    assert(instruction.includes('tool description (rg)'));
    assert(!instruction.includes('- search:'));
    assert(!instruction.includes('- bash:'));
    assert(!instruction.includes('- bash_output:'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 127 rereads named Agent JSON edits on the next startup', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-reviewer-edit-' });
  const configRoot = `${root}/config`;
  try {
    await writeReviewerConfiguration(configRoot, []);
    const first = await resolveWorkerConfiguration(configRoot, { name: 'reviewer' });
    assert(first.agent !== undefined);
    assert(first.agent.configuration.instruction.includes('Do not edit the workspace.'));

    const file = `${configRoot}/agents/reviewer.json`;
    const edited = JSON.parse(await Deno.readTextFile(file)) as Record<string, unknown>;
    edited.revision = '2';
    edited.instruction = 'Review the selected source and return verified findings.';
    await writeJson(file, edited);
    const next = await resolveWorkerConfiguration(configRoot, { name: 'reviewer' });
    assert(next.agent !== undefined);
    assertEquals(next.agent.configuration.revision, '2');
    assertEquals(
      next.agent.configuration.instruction,
      'Review the selected source and return verified findings.',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 127 named reviewer Worker spawns and collects through its parent', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i127-reviewer-worker-' });
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${root}/config`;
  await Deno.mkdir(workspaceRoot);
  await writeReviewerConfiguration(configRoot);
  try {
    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot: `${root}/state`,
      configRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    try {
      const outcome = await created.session.submit('async-spawn reviewer turn');
      assert(outcome.ok, JSON.stringify(outcome));
      assertEquals(outcome.finalText, 'async child: worker child result');
    } finally {
      await created.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
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
      stateRoot: `${root}/state`,
      configRoot,
      persistence: 'none',
      physicalIoMode: 'provider-free',
    });
    try {
      assertEquals(created.session.modelSelectionSnapshot(), selected);
    } finally {
      await created.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
