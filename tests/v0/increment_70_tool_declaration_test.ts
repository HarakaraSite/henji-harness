import {
  createAgentResourceIdentity,
  createDefaultAgentComposition,
  createProviderFreeWebSearchBackend,
  type PhysicalIoBindings,
  type ToolComponent,
} from '../../v0/agent/worker_agent_api.ts';
import type { Model } from '../../v0/agent/core/contracts.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { ManagedToolDefinitionStore } from '../../v0/agent/definitions/managed_tool_definition_store.ts';
import {
  resolveToolDefinitionBindings,
  toolBindingsPath,
} from '../../v0/agent/definitions/tool_binding.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message ?? 'assertion failed');
};

const assertEquals = (left: unknown, right: unknown): void => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
  }
};

const probeModel: Model = { generate: () => ({ kind: 'final', text: 'probe' }) };

const toolModuleSource = (identity: string, name: string): string =>
  `import { createAgentResourceIdentity, type ExecutableToolDefinition } from '@henji/agent';\n` +
  `const definition: ExecutableToolDefinition = () => ({\n` +
  `  identity: createAgentResourceIdentity(${JSON.stringify(identity)}),\n` +
  `  materialize: () => ({\n` +
  `    name: ${JSON.stringify(name)},\n` +
  `    description: 'test tool',\n` +
  `    inputSchema: { type: 'object' },\n` +
  `    execute: () => 'ok',\n` +
  `  }),\n` +
  `});\n` +
  `export default definition;\n`;

Deno.test('Increment 70 composes an additional Definition-declared tool identity', () => {
  const identity = createAgentResourceIdentity('tool:custom_fetch');
  const component: ToolComponent = {
    identity,
    materialize: () => ({
      name: 'custom_fetch',
      description: 'custom fetch',
      inputSchema: { type: 'object' },
      execute: () => 'custom fetch result',
    }),
  };
  const physicalIo: PhysicalIoBindings = {
    createModel: () => probeModel,
    webSearchBackend: createProviderFreeWebSearchBackend(),
  };
  const composition = createDefaultAgentComposition({
    workspace: { root: '/increment-70' },
    skillCatalog: emptySkillCatalog(),
    physicalIo,
    toolDefinitions: [component],
  }, {
    additionalTools: [identity],
  });
  const names = composition.registry.definitions().map((tool) => tool.name);
  assert(names.includes('custom_fetch'));
  assert(composition.manifest.resources.includes('tool:custom_fetch'));
  assert(composition.resolved.capabilities.tools.map(String).includes('tool:custom_fetch'));
});

Deno.test('Increment 70 resolves a bound non-bundled tool identity to an exact revision', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i70-' });
  try {
    const entryPath = `${root}/custom_fetch.ts`;
    await Deno.writeTextFile(entryPath, toolModuleSource('tool:custom_fetch', 'custom_fetch'));
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    const revision = await new ManagedToolDefinitionStore({ dataRoot }).install({
      entryPath,
      resourceId: 'example/custom-fetch',
      toolIdentity: 'tool:custom_fetch',
    });
    await Deno.mkdir(configRoot, { recursive: true });
    await Deno.writeTextFile(
      toolBindingsPath(configRoot),
      JSON.stringify({
        schemaVersion: 1,
        bindings: {
          'tool:custom_fetch':
            `example/custom-fetch@sha256:${revision.manifest.logicalRef.revision.digest}`,
        },
      }),
    );
    const resolved = await resolveToolDefinitionBindings(configRoot, dataRoot);
    const bound = resolved.get('tool:custom_fetch');
    assert(bound !== undefined);
    assertEquals(bound.revision.manifest.toolIdentity, 'tool:custom_fetch');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
