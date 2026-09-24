import {
  builtinDefinitionRef,
  isDefinitionRevisionRef,
} from '../../v0/agent/definitions/managed_resource_ref.ts';
import { discoverSkills, MAX_SKILL_DESCRIPTION_BYTES } from '../../v0/agent/definitions/skills.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { resolveRuntimePaths } from '../../v0/agent/runtime/runtime_paths.ts';
import { parseTuiInvocation } from '../../v0/agent/cli/tui_cli.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { stagedCompileInputs } from '../../scripts/build_henji.ts';
import packageConfig from '../../jsr.json' with { type: 'json' };

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

Deno.test('Increment 32 resolves binary, workspace, and XDG authorities independently', () => {
  assertEquals(
    resolveRuntimePaths({
      executable: '/opt/henji/bin/henji',
      workspace: '/work/project',
      env: {
        HOME: '/users/example',
        XDG_CONFIG_HOME: '/xdg/config',
        XDG_DATA_HOME: '/xdg/data',
        XDG_STATE_HOME: '/xdg/state',
      },
    }),
    {
      executable: '/opt/henji/bin/henji',
      workspace: '/work/project',
      configRoot: '/xdg/config/henji-harness',
      dataRoot: '/xdg/data/henji-harness',
      stateRoot: '/xdg/state/henji-harness/v1',
    },
  );
  assertEquals(
    resolveRuntimePaths({
      executable: '/usr/local/bin/henji',
      workspace: '/workspace',
      env: { HOME: '/users/example' },
    }),
    {
      executable: '/usr/local/bin/henji',
      workspace: '/workspace',
      configRoot: '/users/example/.config/henji-harness',
      dataRoot: '/users/example/.local/share/henji-harness',
      stateRoot: '/users/example/.local/state/henji-harness/v1',
    },
  );
  assertEquals(
    resolveRuntimePaths({
      executable: '/opt/henji',
      workspace: '/workspace',
      env: {
        XDG_CONFIG_HOME: '/config',
        XDG_DATA_HOME: '/data',
        XDG_STATE_HOME: '/state',
      },
    }),
    {
      executable: '/opt/henji',
      workspace: '/workspace',
      configRoot: '/config/henji-harness',
      dataRoot: '/data/henji-harness',
      stateRoot: '/state/henji-harness/v1',
    },
  );
});

Deno.test('Increment 32/77 built-in Definition ref is logical and resource-bound', async () => {
  const manifest = buildManifest();
  assertEquals(manifest.productVersion, packageConfig.version);
  const first = await builtinDefinitionRef('default', manifest);
  const second = await builtinDefinitionRef('default', manifest);
  assert(isDefinitionRevisionRef(first));
  assertEquals(first, second);
  assertEquals(first.resourceId, 'builtin/default');
  assert(!JSON.stringify(first).includes('file:///'));
  assert(!JSON.stringify(first).includes(Deno.cwd()));
});

const skillText = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`;

const installSkill = async (
  root: string,
  name: string,
  description: string,
): Promise<void> => {
  const directory = `${root}/${name}`;
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    `${directory}/SKILL.md`,
    skillText(name, description),
  );
};

Deno.test('Increment 32 discovers workspace and user Skills in Zot-compatible precedence', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-32-skills-' });
  const workspace = `${root}/workspace`;
  const home = `${root}/home`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  try {
    await installSkill(`${workspace}/.zot/skills`, 'shared', 'workspace zot');
    await installSkill(`${state}/zot/skills`, 'shared', 'user zot');
    await installSkill(`${home}/.claude/skills`, 'claude-user', 'user claude');
    await installSkill(
      `${workspace}/.agents/skills`,
      'agent-workspace',
      'workspace agent',
    );
    await installSkill(`${home}/.agents/skills`, 'agent-user', 'user agent');
    const catalog = await discoverSkills(workspace, undefined, {
      HOME: home,
      XDG_STATE_HOME: state,
    });
    assertEquals(
      catalog.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      [
        { name: 'agent-user', description: 'user agent' },
        { name: 'agent-workspace', description: 'workspace agent' },
        { name: 'claude-user', description: 'user claude' },
        { name: 'shared', description: 'workspace zot' },
      ],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 45 accepts a one KiB native Skill description', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-45-skill-description-',
  });
  const workspace = `${root}/workspace`;
  const description = 'a'.repeat(MAX_SKILL_DESCRIPTION_BYTES);
  await Deno.mkdir(workspace);
  try {
    await installSkill(
      `${workspace}/.agents/skills`,
      'long-description',
      description,
    );
    const catalog = await discoverSkills(workspace, undefined, {});
    assertEquals(catalog.skills.map((skill) => skill.name), [
      'long-description',
    ]);
    assertEquals(catalog.skills[0].description, description);
    assert(catalog.manifest?.includes(description));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 32 removes unmanaged Definition invocation', () => {
  let rejected = false;
  try {
    parseTuiInvocation(['--definition', './agent.ts']);
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test('Increment 32 compiles runtime modules from an ephemeral staging tree', () => {
  const checkout = '/work/henji-harness';
  const staging = '/tmp/henji-compile-example/runtime';
  const inputs = stagedCompileInputs(staging);
  assertEquals(inputs.entry, `${staging}/henji_entry.ts`);
  assertEquals(inputs.manifestModule, './v0/agent/runtime/build_manifest.ts');
  assertEquals(inputs.cliModule, './v0/agent/cli/henji_cli.ts');
  assertEquals(inputs.config, `${staging}/deno.v0.json`);
  assert(inputs.includes.length > 0);
  assert(inputs.includes.every((path) => path.startsWith(`${staging}/`)));
  assert(!JSON.stringify(inputs).includes(checkout));
});

Deno.test('Increment 32 projects the Worker generation startup snapshot', async () => {
  const workspace = await Deno.makeTempDir({
    prefix: 'henji-increment-32-worker-snapshot-',
  });
  await Deno.writeTextFile(`${workspace}/AGENTS.md`, '# Worker snapshot\n');
  await installSkill(
    `${workspace}/.zot/skills`,
    'worker-snapshot',
    'worker-owned snapshot',
  );
  const created = await createWorkerSession({
    workspaceRoot: workspace,
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
  });
  try {
    assertEquals(created.displayState.productVersion, packageConfig.version);
    assertEquals(created.displayState.instructions, {
      loaded: true,
      source: 'AGENTS.md',
    });
    assert(created.displayState.skills.names.includes('worker-snapshot'));
  } finally {
    await created.close();
    await Deno.remove(workspace, { recursive: true });
  }
});
