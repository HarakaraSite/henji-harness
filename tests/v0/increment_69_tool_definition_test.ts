import { ManagedToolDefinitionStore } from '../../v0/agent/definitions/managed_tool_definition_store.ts';
import {
  resolveToolDefinitionBinding,
  toolBindingsPath,
} from '../../v0/agent/definitions/tool_binding.ts';
import { ManagedDefinitionError } from '../../v0/agent/definitions/managed_definition_importer.ts';
import {
  createDefaultAgentComposition,
  createProviderFreeWebSearchBackend,
} from '../../v0/agent/worker_agent_api.ts';
import type { PhysicalIoBindings } from '../../v0/agent/worker_agent_api.ts';
import type { Model } from '../../v0/agent/core/contracts.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { main as toolMain } from '../../v0/agent/cli/tool_cli.ts';

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

const WORKSPACE = { root: '/increment-69' };

const probeModel: Model = {
  generate: () => ({ kind: 'final', text: 'probe' }),
};

const toolModuleSource = (identity: string): string =>
  `import { createAgentResourceIdentity, type ExecutableToolDefinition } from '@henji/agent';\n` +
  `const definition: ExecutableToolDefinition = () => ({\n` +
  `  identity: createAgentResourceIdentity(${JSON.stringify(identity)}),\n` +
  `  materialize: () => ({\n` +
  `    name: 'web_search',\n` +
  `    description: 'test web search',\n` +
  `    inputSchema: { type: 'object' },\n` +
  `    execute: () => 'external web search result',\n` +
  `  }),\n` +
  `});\n` +
  `export default definition;\n`;

const writeToolModule = async (root: string, name: string, identity: string): Promise<string> => {
  const path = `${root}/${name}.ts`;
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(path, toolModuleSource(identity));
  return path;
};

Deno.test('Increment 69 installs and resolves an exact tool Definition revision', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i69-store-' });
  try {
    const entryPath = await writeToolModule(`${root}/src`, 'web_search', 'tool:web_search');
    const store = new ManagedToolDefinitionStore({ dataRoot: `${root}/data` });
    const revision = await store.install({
      entryPath,
      resourceId: 'example/web-search',
      toolIdentity: 'tool:web_search',
    });
    assertEquals(revision.manifest.logicalRef.resourceKind, 'tool-definition');
    assertEquals(revision.manifest.toolIdentity, 'tool:web_search');

    const again = await store.install({
      entryPath,
      resourceId: 'example/web-search',
      toolIdentity: 'tool:web_search',
    });
    assertEquals(
      again.manifest.logicalRef.revision.digest,
      revision.manifest.logicalRef.revision.digest,
    );

    const resolved = await store.resolve(revision.manifest.logicalRef);
    assertEquals(resolved.manifest.toolIdentity, 'tool:web_search');
    const listed = await store.list();
    assertEquals(listed.length, 1);
    assertEquals(listed[0].toolIdentity, 'tool:web_search');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 69 binds a tool identity to an exact managed revision', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i69-binding-' });
  try {
    const entryPath = await writeToolModule(`${root}/src`, 'web_search', 'tool:web_search');
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    const revision = await new ManagedToolDefinitionStore({ dataRoot }).install({
      entryPath,
      resourceId: 'example/web-search',
      toolIdentity: 'tool:web_search',
    });
    await Deno.mkdir(configRoot, { recursive: true });
    await Deno.writeTextFile(
      toolBindingsPath(configRoot),
      JSON.stringify({
        schemaVersion: 1,
        bindings: {
          'tool:web_search':
            `example/web-search@sha256:${revision.manifest.logicalRef.revision.digest}`,
        },
      }),
    );
    const bound = await resolveToolDefinitionBinding(configRoot, dataRoot, 'tool:web_search');
    assert(bound !== undefined);
    assertEquals(bound.ref.resourceId, 'example/web-search');
    assertEquals(bound.revision.manifest.toolIdentity, 'tool:web_search');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 69 fails typed on missing, mismatched, and malformed tool bindings', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i69-binding-errors-' });
  try {
    const entryPath = await writeToolModule(`${root}/src`, 'other', 'tool:other');
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    await Deno.mkdir(configRoot, { recursive: true });

    await Deno.writeTextFile(
      toolBindingsPath(configRoot),
      JSON.stringify({
        schemaVersion: 1,
        bindings: { 'tool:web_search': `example/missing@sha256:${'a'.repeat(64)}` },
      }),
    );
    const missing = await resolveToolDefinitionBinding(configRoot, dataRoot, 'tool:web_search')
      .then(() => undefined, (error: unknown) => error);
    assert(missing instanceof Error);
    assertEquals((missing as { code?: string }).code, 'binding_definition_not_found');

    const revision = await new ManagedToolDefinitionStore({ dataRoot }).install({
      entryPath,
      resourceId: 'example/other',
      toolIdentity: 'tool:other',
    });
    await Deno.writeTextFile(
      toolBindingsPath(configRoot),
      JSON.stringify({
        schemaVersion: 1,
        bindings: {
          'tool:web_search': `example/other@sha256:${revision.manifest.logicalRef.revision.digest}`,
        },
      }),
    );
    const mismatch = await resolveToolDefinitionBinding(configRoot, dataRoot, 'tool:web_search')
      .then(() => undefined, (error: unknown) => error);
    assert(mismatch instanceof Error);
    assertEquals((mismatch as { code?: string }).code, 'binding_definition_invalid');

    await Deno.writeTextFile(toolBindingsPath(configRoot), '{ not json');
    const malformed = await resolveToolDefinitionBinding(configRoot, dataRoot, 'tool:web_search')
      .then(() => undefined, (error: unknown) => error);
    assert(malformed instanceof Error);
    assertEquals((malformed as { code?: string }).code, 'binding_invalid');
    assert(!(malformed instanceof ManagedDefinitionError));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 69 materializes the declared web_search tool from a Definition component', () => {
  const physicalIo: PhysicalIoBindings = {
    createModel: () => probeModel,
    webSearchBackend: createProviderFreeWebSearchBackend(),
  };
  const composition = createDefaultAgentComposition({
    workspace: WORKSPACE,
    skillCatalog: emptySkillCatalog(),
    physicalIo,
  });
  const names = composition.registry.definitions().map((tool) => tool.name);
  assert(names.includes('web_search'));
});

Deno.test('Increment 69 CLI installs, activates, lists, and deactivates a tool binding', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i69-cli-' });
  try {
    const entryPath = await writeToolModule(`${root}/src`, 'web_search', 'tool:web_search');
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      dataRoot,
      configRoot,
      writeStdout: (text: string) => {
        out.push(text);
      },
      writeStderr: (text: string) => {
        err.push(text);
      },
    };
    assertEquals(
      await toolMain([
        'install',
        '--id',
        'example/web-search',
        '--tool',
        'tool:web_search',
        '--entry',
        entryPath,
      ], deps),
      0,
    );
    assert(out.join('').includes('Installed'));

    out.length = 0;
    assertEquals(await toolMain(['list', '--json'], deps), 0);
    const listed = JSON.parse(out.join('')) as {
      tools: { logicalRef: { revision: { digest: string } } }[];
    };
    assertEquals(listed.tools.length, 1);
    const digest = listed.tools[0].logicalRef.revision.digest;

    out.length = 0;
    assertEquals(
      await toolMain([
        'activate',
        '--id',
        'example/web-search',
        '--revision',
        digest.slice(0, 8),
      ], deps),
      0,
    );
    assert(
      (await resolveToolDefinitionBinding(configRoot, dataRoot, 'tool:web_search')) !== undefined,
    );

    out.length = 0;
    assertEquals(await toolMain(['active', '--json'], deps), 0);
    const active = JSON.parse(out.join('')) as { bindings: Record<string, string> };
    assert(active.bindings['tool:web_search'] !== undefined);

    out.length = 0;
    assertEquals(await toolMain(['deactivate', '--tool', 'tool:web_search', '--json'], deps), 0);
    assertEquals(
      await resolveToolDefinitionBinding(configRoot, dataRoot, 'tool:web_search'),
      undefined,
    );
    assertEquals(err.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
