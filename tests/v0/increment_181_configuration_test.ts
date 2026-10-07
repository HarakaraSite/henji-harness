import {
  bundledAgentConfiguration,
  parseAgentConfiguration,
} from '../../v0/agent/configuration/agent_configuration.ts';
import {
  type AgentConfigurationChoice,
  resolveWorkerConfiguration,
} from '../../v0/agent/configuration/configuration_resolver.ts';
import type { WorkerConfigurationSnapshot } from '../../v0/agent/worker/worker_configuration.ts';
import type { JsonValue, ToolDefinition } from '../../v0/agent/core/contracts.ts';
import { activateRepositoryExternalToolBindings } from './helpers/external_web_tools.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};
const equal = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};
const writeJson = async (file: string, value: unknown): Promise<void> => {
  await Deno.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(file, JSON.stringify(value));
};

class ConfigurationWorker {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private readonly worker: Worker;
  constructor() {
    this.worker = new Worker(
      new URL('./fixtures/increment_181_configuration_worker.ts', import.meta.url).href,
      {
        type: 'module',
      },
    );
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.requestId);
      this.pending.delete(data.requestId);
      if (data.error !== undefined) pending?.reject(new Error(data.error));
      else pending?.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      for (const pending of this.pending.values()) pending.reject(new Error(event.message));
      this.pending.clear();
    };
  }
  private request(data: object): Promise<any> {
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...data, requestId });
    });
  }
  start(root: string, choice?: AgentConfigurationChoice, toolFilter?: readonly string[]): Promise<{
    ok: boolean;
    snapshot: WorkerConfigurationSnapshot;
    definitions: readonly ToolDefinition[];
    rejections?: readonly { reason: string }[];
  }> {
    return this.request({ kind: 'start', root, configRoot: `${root}/config`, choice, toolFilter });
  }
  async dispatch(name: string, args: JsonValue): Promise<string> {
    const result = await this.request({
      kind: 'dispatch',
      call: { callId: String(++this.sequence), name, arguments: args },
    });
    return result.content.text;
  }
  async close(): Promise<void> {
    try {
      await this.request({ kind: 'close' });
    } finally {
      this.worker.terminate();
    }
  }
}

Deno.test('181 JSON omissions use bundled values, explicit empty arrays and generic remain distinct', () => {
  const declared = parseAgentConfiguration({
    name: 'reviewer',
    revision: 'my label',
    instruction: '',
    tools: [],
    agents: [],
  });
  equal(declared, {
    name: 'reviewer',
    revision: 'my label',
    instruction: '',
    tools: [],
    agents: [],
  });
  const standard = bundledAgentConfiguration(['reviewer']);
  assert(standard.configuration.tools.includes('bash_output'));
  equal(standard.configuration.agents, ['generic', 'reviewer']);
  const generic = bundledAgentConfiguration(['reviewer'], true);
  equal(generic.configuration.instruction, standard.configuration.instruction);
  equal(parseAgentConfiguration({ name: 'reviewer' }).tools, standard.configuration.tools);
});

Deno.test('181 a real Worker dispatches the basic five tools including retained bash output', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-tools-' });
  const worker = new ConfigurationWorker();
  try {
    await activateRepositoryExternalToolBindings(`${root}/config`);
    const ready = await worker.start(root);
    assert(ready.ok);
    equal(ready.snapshot.rejections, []);
    for (const name of ['read', 'write', 'edit', 'bash', 'bash_output']) {
      assert(ready.definitions.some((tool) => tool.name === name));
    }
    await worker.dispatch('write', { path: 'note.txt', content: 'before' });
    await worker.dispatch('edit', {
      path: 'note.txt',
      edits: [{ oldText: 'before', newText: 'after' }],
    });
    assert((await worker.dispatch('read', { path: 'note.txt' })).includes('after'));
    const shell = JSON.parse(
      await worker.dispatch('bash', {
        command:
          "cat note.txt; printf '\\n'; head -c 70000 /dev/zero | tr '\\0' x; printf retained-marker",
      }),
    );
    equal(shell.exitCode, 0);
    assert(shell.stdoutTruncated);
    assert(typeof shell.outputId === 'string');
    const tail = JSON.parse(
      await worker.dispatch('bash_output', {
        outputId: shell.outputId,
        stream: 'stdout',
        offset: 69950,
      }),
    );
    assert(tail.text.endsWith('retained-marker'));
    equal(tail.complete, true);
  } finally {
    await worker.close();
    await Deno.remove(root, { recursive: true });
  }
});

const externalTool = async (root: string, marker: string): Promise<void> => {
  const folder = `${root}/config/tools/marker`;
  await writeJson(`${folder}/tool.json`, {
    name: 'marker',
    revision: 'same-label',
    apiContract: 'henji-tool/v1',
    entry: 'index.ts',
  });
  await Deno.writeTextFile(
    `${folder}/helper.ts`,
    `export const marker = ${JSON.stringify(marker)};\n`,
  );
  await Deno.writeTextFile(
    `${folder}/index.ts`,
    "import { ToolInputError, type ToolFactory } from '@henji/tool';\n" +
      "import { marker } from './helper.ts';\n" +
      "const factory: ToolFactory = (input) => { let calls = 0; return { name:'marker', fileAccess:'none', description:marker, inputSchema:{type:'object'}, promptGuidelines:[marker], async execute(args) { if (args === null) throw new ToolInputError('marker arguments'); await Deno.writeTextFile(input.workspace.root+'/executed', marker); return marker+':'+(++calls); } }; };\nexport default factory;\n",
  );
};

Deno.test('181 JSON and local-import tool edits affect a new Worker while the current Worker keeps its state', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-current-' });
  const first = new ConfigurationWorker();
  const second = new ConfigurationWorker();
  try {
    await writeJson(`${root}/config/agents.json`, {
      schemaVersion: 1,
      default: 'agents/root.json',
      agents: {},
    });
    const settings = {
      name: 'my-root',
      revision: 'same-label',
      instruction: 'role-before',
      tools: ['read', 'marker'],
      agents: [],
    };
    await writeJson(`${root}/config/agents/root.json`, settings);
    await writeJson(`${root}/config/tools.json`, {
      schemaVersion: 1,
      tools: { marker: 'tools/marker' },
    });
    await Deno.writeTextFile(`${root}/AGENTS.md`, 'workspace instruction marker');
    await externalTool(root, 'module-before');
    const ready = await first.start(root);
    assert(ready.ok);
    assert(ready.snapshot.systemInstruction.includes('role-before'));
    assert(ready.snapshot.systemInstruction.includes('workspace instruction marker'));
    await Deno.stat(`${root}/executed`).then(() => {
      throw new Error('loader executed tool');
    }, (error) => assert(error instanceof Deno.errors.NotFound));
    equal(await first.dispatch('marker', {}), 'module-before:1');
    assert((await first.dispatch('marker', null)).includes('invalid arguments: marker arguments'));
    await writeJson(`${root}/config/agents/root.json`, { ...settings, instruction: 'role-after' });
    await externalTool(root, 'module-after');
    equal(await first.dispatch('marker', {}), 'module-before:2');
    const changed = await second.start(root);
    assert(changed.ok);
    equal(await second.dispatch('marker', {}), 'module-after:1');
    assert(changed.snapshot.systemInstruction.includes('role-after'));
    assert(!changed.snapshot.systemInstruction.includes('role-before'));
    equal(changed.snapshot.agent.revision, ready.snapshot.agent.revision);
    assert(changed.snapshot.configurationId !== ready.snapshot.configurationId);
    equal(
      ready.snapshot.tools.find((tool) => tool.name === 'marker')?.contract.description,
      'module-before',
    );
    equal(
      changed.snapshot.tools.find((tool) => tool.name === 'marker')?.contract.description,
      'module-after',
    );
  } finally {
    await first.close();
    await second.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('181 a rejected replacement is absent from declaration and dispatch; other tools still work', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-reject-' });
  const worker = new ConfigurationWorker();
  try {
    await writeJson(`${root}/config/agents.json`, {
      schemaVersion: 1,
      agents: { reviewer: 'agents/reviewer.json', unavailable: 'agents/missing.json' },
    });
    await writeJson(`${root}/config/agents/reviewer.json`, {
      name: 'reviewer',
      instruction: 'reviewer role',
      tools: ['read', 'write', 'edit'],
      agents: [],
    });
    await writeJson(`${root}/config/tools.json`, {
      schemaVersion: 1,
      tools: { write: 'tools/write', edit: 'tools/edit' },
    });
    await writeJson(`${root}/config/tools/write/tool.json`, {
      name: 'write',
      revision: 'broken',
      apiContract: 'henji-tool/v1',
      entry: 'index.ts',
    });
    await Deno.writeTextFile(
      `${root}/config/tools/write/index.ts`,
      "import './missing.ts';\nexport default () => ({});\n",
    );
    await writeJson(`${root}/config/tools/edit/tool.json`, {
      name: 'edit',
      revision: 'broken',
      apiContract: 'henji-tool/v1',
      entry: 'index.ts',
    });
    await Deno.writeTextFile(`${root}/config/tools/edit/index.ts`, 'export default 42;\n');
    await Deno.writeTextFile(`${root}/note.txt`, 'readable');
    await Deno.mkdir(`${root}/.agents/skills/check`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/.agents/skills/check/SKILL.md`,
      '---\nname: check\ndescription: Check the selected work\n---\nNative skill body marker\n',
    );
    const ready = await worker.start(root, { name: 'reviewer' });
    assert(ready.ok);
    equal(ready.definitions.map((tool) => tool.name), ['read']);
    assert(
      ready.snapshot.rejections.some((rejection) =>
        rejection.name === 'write' && rejection.file?.endsWith('index.ts')
      ),
    );
    assert(
      ready.snapshot.rejections.some((rejection) =>
        rejection.name === 'edit' && rejection.reason.includes('default export')
      ),
    );
    assert(ready.snapshot.systemInstruction.includes('Unavailable configuration entries'));
    assert(!ready.snapshot.systemInstruction.includes('Available project skills.'));
    assert((await worker.dispatch('read', { path: 'note.txt' })).includes('readable'));
    equal(
      await worker.dispatch('write', { path: 'should-not-exist', content: 'bad' }),
      'unknown tool: write',
    );
  } finally {
    await worker.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('181 invalid selected JSON is returned as a rejected Agent without bundled fallback', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-agent-reject-' });
  try {
    await writeJson(`${root}/config/agents.json`, {
      schemaVersion: 1,
      default: 'agents/root.json',
      agents: {},
    });
    await writeJson(`${root}/config/agents/root.json`, { name: 'default', tools: 'read' });
    const selected = await resolveWorkerConfiguration(`${root}/config`);
    equal(selected.agent, undefined);
    assert(
      selected.rejections.some((rejection) =>
        rejection.target === 'agent' && rejection.field === 'tools'
      ),
    );
    await writeJson(`${root}/config/agents/root.json`, {
      name: 'default',
      instruction: '',
      tools: [],
      agents: [],
    });
    const worker = new ConfigurationWorker();
    try {
      const ready = await worker.start(root);
      assert(ready.ok);
      equal(ready.definitions, []);
      assert(
        !ready.snapshot.instructionComponents.some((component) =>
          component.identity === 'instruction:external-agent-role'
        ),
      );
      assert(
        ready.snapshot.instructionComponents.some((component) =>
          component.identity === 'instruction:henji-base'
        ),
      );
    } finally {
      await worker.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('181 generic uses the bundled role, a spawn tool filter and native skills in its own Worker', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-generic-' });
  const worker = new ConfigurationWorker();
  try {
    await writeJson(`${root}/config/agents.json`, {
      schemaVersion: 1,
      default: 'agents/root.json',
      agents: {},
    });
    await writeJson(`${root}/config/agents/root.json`, {
      name: 'parent',
      instruction: 'parent role must not leak',
      tools: ['bash'],
      agents: [],
    });
    await Deno.mkdir(`${root}/.agents/skills/check`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/.agents/skills/check/SKILL.md`,
      '---\nname: check\ndescription: Check the selected work\n---\nNative skill body marker\n',
    );
    const ready = await worker.start(root, { name: 'generic' }, ['read']);
    assert(ready.ok);
    equal(ready.definitions.map((tool) => tool.name), ['read', 'skill', 'submit_json_result']);
    assert(!ready.snapshot.systemInstruction.includes('parent role must not leak'));
    assert(ready.snapshot.systemInstruction.includes('Check the selected work'));
    assert(
      (await worker.dispatch('skill', { name: 'check' })).includes('Native skill body marker'),
    );
  } finally {
    await worker.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('181 a named catalog entry preserves its JSON name without breaking the default Worker', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-named-' });
  const worker = new ConfigurationWorker();
  try {
    await activateRepositoryExternalToolBindings(`${root}/config`);
    await writeJson(`${root}/config/agents.json`, {
      schemaVersion: 1,
      agents: { Reviewer: 'agents/reviewer.json' },
    });
    await writeJson(`${root}/config/agents/reviewer.json`, {
      name: 'Reviewer',
      tools: ['read'],
      agents: [],
    });
    const ready = await worker.start(root);
    assert(ready.ok);
    equal(ready.snapshot.agent.agents, ['generic', 'Reviewer']);
    equal(ready.snapshot.rejections, []);
  } finally {
    await worker.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('181 omitted root choice and a named default catalog entry resolve independently', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-default-name-' });
  const first = new ConfigurationWorker();
  const second = new ConfigurationWorker();
  const third = new ConfigurationWorker();
  try {
    await writeJson(`${root}/config/agents/root.json`, {
      name: 'root-role',
      instruction: 'root instruction',
      tools: [],
      agents: [],
    });
    await writeJson(`${root}/config/agents/named.json`, {
      name: 'default',
      instruction: 'named instruction',
      tools: [],
      agents: [],
    });
    await writeJson(`${root}/config/agents.json`, {
      schemaVersion: 1,
      default: 'agents/root.json',
      agents: { default: 'agents/named.json' },
    });
    const omitted = await first.start(root, {});
    const named = await second.start(root, { name: 'default' });
    assert(omitted.ok && named.ok);
    equal(omitted.snapshot.agent.name, 'root-role');
    equal(named.snapshot.agent.name, 'default');
    assert(named.snapshot.systemInstruction.includes('named instruction'));
    assert(!named.snapshot.systemInstruction.includes('root instruction'));
    await writeJson(`${root}/config/agents.json`, {
      schemaVersion: 1,
      agents: { default: 'agents/named.json' },
    });
    const bundled = await third.start(root, {});
    assert(bundled.ok);
    equal(bundled.snapshot.source.kind, 'bundled');
    assert(!bundled.snapshot.systemInstruction.includes('named instruction'));
  } finally {
    await first.close();
    await second.close();
    await third.close();
    await Deno.remove(root, { recursive: true });
  }
});
