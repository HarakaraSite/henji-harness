import { HOOK_API_CONTRACT } from '../../v0/agent/hook_api.ts';
import { buildManifest, isBuildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { packageHenji } from '../../scripts/package_henji.ts';
import { buildInputFiles } from '../../scripts/build_henji.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (
  actual: unknown,
  expected: unknown,
  message?: string,
): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(message ? `${message}: ${left} !== ${right}` : `${left} !== ${right}`);
  }
};

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Deno.readTextFile(path));

Deno.test('Increment 189 distributes the public hook API in the build contract', async () => {
  const manifest = buildManifest();
  assertEquals(manifest.supportedHookApiContracts, [HOOK_API_CONTRACT]);
  assert(isBuildManifest(manifest));
  const { supportedHookApiContracts: _, ...oldManifest } = manifest;
  assert(!isBuildManifest(oldManifest), 'a manifest without the hook contract is not current');

  const deno = await readJson('deno.v0.json');
  const imports = deno.imports as Record<string, string>;
  assertEquals(imports['@henji/hooks'], './v0/agent/hook_api.ts');
  const jsr = await readJson('jsr.json');
  const exports = jsr.exports as Record<string, string>;
  assertEquals(exports['./hooks'], './v0/agent/hook_api.ts');
  const publish = jsr.publish as { include: string[] };
  const graph = await new Deno.Command(Deno.execPath(), {
    args: ['info', '--json', '--config', 'deno.v0.json', 'v0/agent/hook_api.ts'],
    stdout: 'piped',
  }).output();
  assert(graph.success);
  const modules = JSON.parse(new TextDecoder().decode(graph.stdout)) as {
    modules: Array<{ local?: string }>;
  };
  const root = `${Deno.cwd()}/`;
  const localDependencies = modules.modules.flatMap(({ local }) =>
    local?.startsWith(root) ? [local.slice(root.length)] : []
  );
  for (const path of localDependencies) {
    assert(
      publish.include.includes(path),
      `JSR hook API dependency is not published: ${path}`,
    );
  }

  const inputs = await buildInputFiles(Deno.cwd());
  assert(inputs.includes('v0/agent/hook_api.ts'));
});

Deno.test('Increment 189 packages and installs editable hooks while retaining user edits', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-189-package-' });
  const activationLog = `${root}/activations.txt`;
  const build = {
    productVersion: '0.8.0',
    target: 'x86_64-unknown-linux-gnu',
    buildId: 'test-build-id',
  };
  const fakeBinary = `${root}/hjh`;
  const fakeBinarySource = [
    '#!/bin/sh',
    'if [ "$1" = "diagnostics" ] && [ "$2" = "runtime" ]; then',
    `  printf '%s\\n' '${JSON.stringify({ build })}'`,
    '  exit 0',
    'fi',
    `printf '%s\\n' "$*" >> "${activationLog}"`,
    'exit 0',
    '',
  ].join('\n');

  try {
    await Deno.writeTextFile(fakeBinary, fakeBinarySource);
    await Deno.chmod(fakeBinary, 0o755);
    const packaged = await packageHenji(fakeBinary, `${root}/dist`);
    const packagedHook = `${packaged.folder}/hooks/runtime-start-time/index.ts`;
    const repositoryHook = new URL(
      '../../external-hooks/runtime-start-time/index.ts',
      import.meta.url,
    );
    const packagedHookSource = await Deno.readTextFile(packagedHook);
    assertEquals(packagedHookSource, await Deno.readTextFile(repositoryHook));
    assert(
      await Deno.readTextFile(`${packaged.folder}/HOOKS.md`).then((text) =>
        text.includes('@henji/hooks')
      ),
    );

    const packageManifest = await readJson(`${packaged.folder}/manifest.json`);
    const tools = packageManifest.tools as Array<{ name: string }>;
    const expectedTools = ['search', 'git_inspect', 'web_search', 'web_fetch'];
    assertEquals(
      tools.map(({ name }) => name),
      expectedTools,
      'the hook package preserves the existing external tool package',
    );
    for (const name of expectedTools) {
      assert(await Deno.stat(`${packaged.folder}/tools/${name}/tool.json`));
    }
    const hooks = packageManifest.hooks as Array<{
      name: string;
      contract: string;
      files: Record<string, string>;
    }>;
    assertEquals(hooks.map(({ name, contract }) => ({ name, contract })), [{
      name: 'runtime-start-time',
      contract: HOOK_API_CONTRACT,
    }]);
    assertEquals(Object.keys(hooks[0].files), ['index.ts']);
    const archive = await new Deno.Command('tar', {
      args: ['-tzf', packaged.archive],
      stdout: 'piped',
    }).output();
    assert(archive.success);
    const archiveEntries = new TextDecoder().decode(archive.stdout).split('\n');
    assert(archiveEntries.some((path) => path.endsWith('/hjh')));
    assert(!archiveEntries.some((path) => path.endsWith('/henji')));
    assert(
      archiveEntries.some((path) => path.endsWith('/hooks/runtime-start-time/index.ts')),
      'the archive includes the default hook source',
    );

    const home = `${root}/home`;
    const configHome = `${root}/xdg-config`;
    const configRoot = `${configHome}/henji-harness`;
    const binDir = `${root}/bin`;
    const otherApplication = '#!/bin/sh\necho other-henji-application\n';
    await Deno.mkdir(binDir);
    await Deno.writeTextFile(`${binDir}/henji`, otherApplication);
    const agentFile = `${configRoot}/agents/reviewer.json`;
    const agentSource = '{"name":"reviewer","hooks":[]}\n';
    await Deno.mkdir(`${configRoot}/agents`, { recursive: true });
    await Deno.writeTextFile(agentFile, agentSource);

    const install = async (...options: string[]): Promise<void> => {
      const result = await new Deno.Command('/usr/bin/bash', {
        args: [
          `${packaged.folder}/install.sh`,
          '--bin-dir',
          binDir,
          '--config-root',
          configRoot,
          ...options,
        ],
        env: { HOME: home, XDG_CONFIG_HOME: configHome },
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
    };

    await install();
    assertEquals(await Deno.readTextFile(`${binDir}/hjh`), fakeBinarySource);
    assertEquals(await Deno.readTextFile(`${binDir}/henji`), otherApplication);
    const hooksConfig = `${configRoot}/hooks.json`;
    const initialCatalogSource = await Deno.readTextFile(hooksConfig);
    assertEquals(JSON.parse(initialCatalogSource), {
      schemaVersion: 1,
      default: ['runtime-start-time'],
      hooks: {
        'runtime-start-time': 'hooks/runtime-start-time/index.ts',
      },
    });
    const installedHook = `${configRoot}/hooks/runtime-start-time/index.ts`;
    const toolFile = `${configRoot}/tools/search/index.ts`;
    const toolEdit = '// retained local tool edit\n';
    const localHookEdit = '// retained local hook edit\n';
    await Deno.writeTextFile(toolFile, toolEdit);
    await Deno.writeTextFile(installedHook, localHookEdit);

    const customCatalogSource =
      '{"schemaVersion":1,"default":[],"hooks":{"runtime-start-time":"hooks/runtime-start-time/index.ts","custom":"hooks/custom/index.ts"}}\n';
    await Deno.writeTextFile(hooksConfig, customCatalogSource);
    await install();
    assertEquals(await Deno.readTextFile(installedHook), localHookEdit);
    assertEquals(await Deno.readTextFile(toolFile), toolEdit);
    assertEquals(await Deno.readTextFile(hooksConfig), customCatalogSource);

    await install('--replace-hooks');
    assertEquals(await Deno.readTextFile(installedHook), packagedHookSource);
    assertEquals(await Deno.readTextFile(hooksConfig), customCatalogSource);
    assertEquals(await Deno.readTextFile(toolFile), toolEdit);
    assertEquals(await Deno.readTextFile(agentFile), agentSource);

    const activations = await Deno.readTextFile(activationLog);
    assertEquals(
      activations.trim().split('\n').length,
      12,
      'each install registers the four packaged tools',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
