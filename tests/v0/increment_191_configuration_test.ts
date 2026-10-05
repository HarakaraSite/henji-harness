import { deepStrictEqual, strictEqual } from 'node:assert';
import { applyToolNameFilter } from '../../v0/agent/definitions/tool_filter.ts';
import { bundledAgentConfiguration } from '../../v0/agent/configuration/agent_configuration.ts';
import { resolveWorkerConfiguration } from '../../v0/agent/configuration/configuration_resolver.ts';
import { configurationMain } from '../../v0/agent/cli/configuration_cli.ts';
import { loadWorkerTools } from '../../v0/agent/worker/worker_tool_loader.ts';
import { createBashOutputStore } from '../../v0/agent/tools/bash_output.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import {
  LinuxProcessExecutor,
  sourceProcessRunnerLaunch,
} from '../../v0/agent/runtime/process_executor.ts';

Deno.test('191 builtin declaration, default/generic, explicit tool lists and CLI use the existing selection route', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-191-config-' });
  const output = createBashOutputStore();
  const processes = new LinuxProcessExecutor(sourceProcessRunnerLaunch());
  try {
    strictEqual(bundledAgentConfiguration().configuration.tools.includes('run_typescript'), true);
    strictEqual(
      bundledAgentConfiguration([], true).configuration.tools.includes('run_typescript'),
      true,
    );
    const selected = await resolveWorkerConfiguration(root);
    const tool = selected.tools.find((t) => t.name === 'run_typescript')!;
    strictEqual(tool.source, 'bundled');
    const loaded = await loadWorkerTools([tool], {
      workspace: { root },
      processExecutor: processes,
      workTools: {},
      bashOutputStore: output,
      skillCatalog: emptySkillCatalog(),
    });
    deepStrictEqual(loaded.rejections, []);
    strictEqual(loaded.accepted[0].tool.name, 'run_typescript');
    let stdout = '';
    const io = {
      configRoot: root,
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: () => {},
    };
    strictEqual(await configurationMain('tool', ['list'], io), 0);
    strictEqual(stdout.includes('run_typescript'), true);
    stdout = '';
    strictEqual(await configurationMain('tool', ['inspect', '--name', 'run_typescript'], io), 0);
    strictEqual(JSON.parse(stdout).source, 'bundled');
    const file = `${root}/explicit.json`;
    await Deno.writeTextFile(file, JSON.stringify({ name: 'explicit', tools: ['run_typescript'] }));
    deepStrictEqual((await resolveWorkerConfiguration(root, { file })).tools.map((t) => t.name), [
      'run_typescript',
    ]);
    await Deno.writeTextFile(file, JSON.stringify({ name: 'explicit', tools: [] }));
    deepStrictEqual((await resolveWorkerConfiguration(root, { file })).tools, []);
    strictEqual(
      applyToolNameFilter(bundledAgentConfiguration().configuration.tools, ['read']).includes(
        'run_typescript',
      ),
      false,
    );
  } finally {
    await output.close();
    await processes.close();
    await Deno.remove(root, { recursive: true });
  }
});
