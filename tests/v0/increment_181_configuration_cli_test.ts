import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { configurationMain } from '../../v0/agent/cli/configuration_cli.ts';
import { resolveWorkerConfiguration } from '../../v0/agent/configuration/configuration_resolver.ts';
import { activateRepositoryExternalToolBindings } from './helpers/external_web_tools.ts';

Deno.test('181 CLI selects external Agent files and tool folders without archiving source', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-config-cli-' });
  const configRoot = `${root}/config`;
  const file = `${root}/reviewer.json`;
  const folder = `${root}/read`;
  let output = '';
  const invoke = async (kind: 'agent' | 'tool', args: string[]) => {
    output = '';
    return await configurationMain(kind, args, {
      configRoot,
      writeStdout: (text) => {
        output += text;
      },
      writeStderr: (text) => {
        output += text;
      },
    });
  };
  try {
    await activateRepositoryExternalToolBindings(configRoot);
    await Deno.writeTextFile(
      file,
      JSON.stringify({ name: 'Reviewer', revision: 'stable', instruction: 'first' }),
    );
    strictEqual(
      await invoke('agent', ['activate', '--name', 'Reviewer', '--file', file]),
      0,
      output,
    );
    let selection = await resolveWorkerConfiguration(configRoot, { name: 'Reviewer' });
    strictEqual(selection.agent?.configuration.instruction, 'first');
    await Deno.writeTextFile(
      file,
      JSON.stringify({ name: 'Reviewer', revision: 'stable', instruction: 'changed' }),
    );
    selection = await resolveWorkerConfiguration(configRoot, { name: 'Reviewer' });
    strictEqual(selection.agent?.configuration.instruction, 'changed');
    strictEqual(await invoke('agent', ['activate', '--file', file]), 0, output);
    selection = await resolveWorkerConfiguration(configRoot);
    strictEqual(selection.agent?.configuration.name, 'Reviewer');
    await Deno.mkdir(folder);
    await Deno.writeTextFile(
      `${folder}/tool.json`,
      JSON.stringify({
        name: 'read',
        revision: 'local',
        apiContract: 'henji-tool/v1',
        entry: 'main.ts',
      }),
    );
    await Deno.writeTextFile(
      `${folder}/main.ts`,
      'export default () => { throw new Error("not executed by catalog edit"); };',
    );
    strictEqual(
      await invoke('tool', ['activate', '--name', 'read', '--folder', folder]),
      0,
      output,
    );
    strictEqual(await invoke('tool', ['inspect', '--name', 'read']), 0, output);
    strictEqual(JSON.parse(output).source, 'external');
    strictEqual(await invoke('tool', ['deactivate', '--name', 'read']), 0, output);
    strictEqual(await invoke('agent', ['deactivate', '--name', 'Reviewer']), 0, output);
    strictEqual(await invoke('agent', ['deactivate']), 0, output);
    deepStrictEqual(JSON.parse(await Deno.readTextFile(`${configRoot}/agents.json`)).agents, {});
    ok((await Deno.readTextFile(file)).includes('changed'));
    ok((await Deno.readTextFile(`${folder}/main.ts`)).includes('not executed'));
    strictEqual(await invoke('tool', ['inspect', '--name', 'missing']), 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
