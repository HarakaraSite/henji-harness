import {
  builtinDefinitionRef,
  isDefinitionRevisionRef,
} from '../../v0/agent/definitions/managed_resource_ref.ts';
import { discoverSkills } from '../../v0/agent/definitions/skills.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { resolveRuntimePaths } from '../../v0/agent/runtime/runtime_paths.ts';
import { parseTuiInvocation } from '../../v0/agent/cli/tui_cli.ts';
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

Deno.test('Increment 32 built-in Definition ref is logical and build-bound', async () => {
  const manifest = buildManifest();
  const first = await builtinDefinitionRef('default', manifest);
  const second = await builtinDefinitionRef('default', manifest);
  const planner = await builtinDefinitionRef('planner', manifest);
  assert(isDefinitionRevisionRef(first));
  assertEquals(first, second);
  assert(first.revision.digest !== planner.revision.digest);
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
  await Deno.writeTextFile(`${directory}/SKILL.md`, skillText(name, description));
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
    await installSkill(`${workspace}/.agents/skills`, 'agent-workspace', 'workspace agent');
    await installSkill(`${home}/.agents/skills`, 'agent-user', 'user agent');
    const catalog = await discoverSkills(workspace, undefined, {
      HOME: home,
      XDG_STATE_HOME: state,
    });
    assertEquals(
      catalog.skills.map((skill) => ({ name: skill.name, description: skill.description })),
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

Deno.test('Increment 32 removes unmanaged Definition invocation', () => {
  let rejected = false;
  try {
    parseTuiInvocation(['--definition', './agent.ts']);
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test('Increment 32 projects the Worker generation startup snapshot', async () => {
  const workspace = await Deno.makeTempDir({ prefix: 'henji-increment-32-worker-snapshot-' });
  await Deno.writeTextFile(`${workspace}/AGENTS.md`, '# Worker snapshot\n');
  await installSkill(`${workspace}/.zot/skills`, 'worker-snapshot', 'worker-owned snapshot');
  const created = await createWorkerSession({
    workspaceRoot: workspace,
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
  });
  try {
    assertEquals(created.displayState.instructions, { loaded: true, source: 'AGENTS.md' });
    assert(created.displayState.skills.names.includes('worker-snapshot'));
  } finally {
    await created.close();
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test('Increment 32 headless artifacts leave the state root ready for durable TUI', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-32-shared-state-' });
  const stateRoot = `${root}/state-home/henji-harness/v1`;
  const workspace = `${root}/workspace`;
  await Deno.mkdir(workspace);
  const headless = await createWorkerSession({
    workspaceRoot: workspace,
    stateRoot,
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
  });
  try {
    assert((await headless.session.submit('create execution artifact')).ok);
  } finally {
    await headless.close();
  }
  assertEquals((await Deno.lstat(stateRoot)).mode! & 0o777, 0o700);
  const durable = await createWorkerSession({
    workspaceRoot: workspace,
    stateRoot,
    persistence: 'new',
    agent: 'default',
    physicalIoMode: 'provider-free',
  });
  try {
    assert(durable.navigation?.persistent);
  } finally {
    await durable.close();
    await Deno.remove(root, { recursive: true });
  }
});
