import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { main } from '../../../v0/agent/cli/henji_cli.ts';
import { createDataClient } from '../../../v0/agent/data/client.ts';
import { ChildRunRegistry } from '../../../v0/agent/worker/worker_host_children.ts';
import { WorkerHostSession } from '../../../v0/agent/worker/worker_host_session.ts';
import { WorkerCapsule } from '../../../v0/agent/worker/worker_capsule.ts';
import type { WorkerReadyMessage } from '../../../v0/agent/worker/worker_protocol.ts';

if (Deno.args[0]?.startsWith('--internal-')) {
  Deno.exit(await main(Deno.args));
}

const root = Deno.args[0];
const configRoot = `${root}/config`;
const choice = { name: 'b12-parent' };
const json = async (path: string, value: unknown) => {
  await Deno.writeTextFile(path, JSON.stringify(value));
};
await Deno.mkdir(`${configRoot}/agents`, { recursive: true });
await json(`${configRoot}/agents.json`, {
  schemaVersion: 1,
  agents: { 'b12-parent': 'agents/parent.json', 'b12-child': 'agents/child.json' },
});
for (
  const [file, name, agents] of [
    ['parent', 'b12-parent', ['b12-child']],
    ['child', 'b12-child', []],
  ] as const
) {
  await json(`${configRoot}/agents/${file}.json`, {
    name,
    revision: 'increment-203',
    instruction: 'Execute the assigned process probe.',
    tools: ['bash', 'run_typescript'],
    agents,
  });
}
const data = await createDataClient({ workspaceRoot: root, stateRoot: `${root}/state` });
const descriptor = await data.openSession({
  persistence: 'none',
  agent: choice.name,
  agentChoice: choice,
});
let ready: WorkerReadyMessage | undefined;
const options = {
  data,
  descriptor,
  workspaceRoot: root,
  configRoot,
  credentialRoot: `${root}/state/credentials`,
  agentChoice: choice,
  physicalIoMode: 'provider-free' as const,
};
const session = await WorkerHostSession.open({
  ...options,
  capsuleFactory: (url) => {
    const capsule = new WorkerCapsule(url);
    capsule.subscribe((message) => {
      if (message.kind === 'ready') ready = message;
    });
    return capsule;
  },
});
const children = new ChildRunRegistry({
  options,
  currentCatalog: () => ['b12-child'],
});
const call = (name: string, args: Record<string, unknown>): string =>
  `bash-tool-call:${JSON.stringify({ name, arguments: args })}`;
const bash = call('bash', { command: 'printf probe-ok' });
const typescript = call('run_typescript', { code: 'return { value: 3 };' });
const verify = (text: string | undefined, kind: 'bash' | 'typescript') => {
  ok(text !== undefined);
  ok(!text.startsWith('tool execution error:'), text);
  const value = JSON.parse(text);
  if (kind === 'bash') {
    strictEqual(value.stdout, 'probe-ok');
    strictEqual(value.exitCode, 0);
  } else deepStrictEqual(value, { value: 3 });
};
const parentCall = async (task: string, kind: 'bash' | 'typescript') => {
  const outcome = await session.submit(task);
  ok(outcome.ok, JSON.stringify(outcome));
  verify(outcome.finalText, kind);
};
try {
  await parentCall(bash, 'bash');
  await parentCall(typescript, 'typescript');
  console.log(JSON.stringify({ stage: 'before-update', parentBash: true, parentTypescript: true }));
  await Deno.writeTextFile(`${root}/ready`, 'ready');
  while (!(await Deno.stat(`${root}/continue`).catch(() => null))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  ok(Deno.execPath().endsWith(' (deleted)'), Deno.execPath());
  await parentCall(bash, 'bash');
  await parentCall(typescript, 'typescript');
  const parent = crypto.randomUUID();
  ok(ready !== undefined);
  await data.executionAdmit(descriptor.id, {
    executionId: parent,
    taskId: parent,
    task: 'binary update process probe',
    correlation: {
      ...ready.correlation,
      baseStateRevision: (await data.sessionDescriptor(descriptor.id)).stateRevision,
    },
    createdAt: new Date().toISOString(),
  });
  children.openParent(parent);
  for (const [task, kind] of [[bash, 'bash'], [typescript, 'typescript']] as const) {
    const spawned = await children.handle(
      { kind: 'spawn', agent: 'b12-child', task },
      `spawn-${kind}`,
      parent,
    );
    ok(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const collected = await children.handle(
      { kind: 'collect', runId: spawned.runId },
      `collect-${kind}`,
      parent,
    );
    ok(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    strictEqual(collected.result.state, 'completed', JSON.stringify(collected));
    verify(collected.result.finalText, kind);
  }
  console.log(JSON.stringify({
    stage: 'after-update',
    deletedExecPath: true,
    parentBash: true,
    parentTypescript: true,
    newChildBash: true,
    newChildTypescript: true,
  }));
} finally {
  await children.cleanupAll();
  await session.close();
  await data.close();
}
