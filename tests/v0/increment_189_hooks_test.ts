import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { HOOK_API_CONTRACT } from '@henji/hooks';
import { resolveWorkerConfiguration } from '../../v0/agent/configuration/configuration_resolver.ts';
import { createBashOutputStore } from '../../v0/agent/tools/bash_output.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import type { HookContextSnapshot } from '../../v0/agent/hook_api.ts';
import { createConfiguredWorkerComposition } from '../../v0/agent/worker/worker_configuration.ts';
import { loadWorkerHooks } from '../../v0/hooks/hook_loader.ts';
import { runHookPhase } from '../../v0/hooks/hook_runner.ts';

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await Deno.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(file, JSON.stringify(value));
};

const writeAgentCatalog = async (configRoot: string): Promise<void> => {
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: { reviewer: 'agents/reviewer.json' },
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'root',
    tools: [],
    agents: [],
  });
  await writeJson(`${configRoot}/agents/reviewer.json`, {
    name: 'reviewer',
    tools: [],
    agents: [],
    hooks: ['explicit'],
  });
};

Deno.test('Increment 189 resolves shared hook defaults and Agent overrides', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-hook-select-' });
  const configRoot = `${root}/config`;
  try {
    await writeAgentCatalog(configRoot);
    await writeJson(`${configRoot}/hooks.json`, {
      schemaVersion: 1,
      default: ['common-a', 'common-b'],
      hooks: {
        'common-a': 'hooks/common-a/index.ts',
        'common-b': 'hooks/common-b/index.ts',
        explicit: 'hooks/explicit/index.ts',
      },
    });

    const rootAgent = await resolveWorkerConfiguration(configRoot);
    const genericAgent = await resolveWorkerConfiguration(configRoot, { name: 'generic' });
    const reviewer = await resolveWorkerConfiguration(configRoot, { name: 'reviewer' });
    deepStrictEqual(rootAgent.hooks.map((hook) => hook.name), ['common-a', 'common-b']);
    deepStrictEqual(genericAgent.hooks.map((hook) => hook.name), ['common-a', 'common-b']);
    deepStrictEqual(reviewer.hooks.map((hook) => hook.name), ['explicit']);
    ok(rootAgent.hooks.every((hook) => hook.path?.startsWith(configRoot)));

    await writeJson(`${configRoot}/agents/reviewer.json`, {
      name: 'reviewer',
      tools: [],
      agents: [],
      hooks: [],
    });
    const disabled = await resolveWorkerConfiguration(configRoot, { name: 'reviewer' });
    deepStrictEqual(disabled.hooks, []);

    const noCatalog = await resolveWorkerConfiguration(`${root}/empty-config`);
    deepStrictEqual(noCatalog.hooks, []);
    deepStrictEqual(noCatalog.rejections.filter((entry) => entry.target === 'hook'), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 awaits local-import hook factories and ordered handlers', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-hook-runner-' });
  const configRoot = `${root}/config`;
  const workspace = { root: `${root}/workspace`, trace: [] as string[] };
  try {
    await writeAgentCatalog(configRoot);
    await writeJson(`${configRoot}/hooks.json`, {
      schemaVersion: 1,
      default: ['async-first', 'sync-second'],
      hooks: {
        'async-first': 'hooks/first/index.ts',
        'sync-second': 'hooks/second/index.ts',
      },
    });
    await Deno.mkdir(workspace.root, { recursive: true });
    await Deno.mkdir(`${configRoot}/hooks/first`, { recursive: true });
    await Deno.mkdir(`${configRoot}/hooks/second`, { recursive: true });
    await Deno.writeTextFile(
      `${configRoot}/hooks/first/local.ts`,
      "export const marker = 'from local import';\n",
    );
    await Deno.writeTextFile(
      `${configRoot}/hooks/first/index.ts`,
      `import { marker } from './local.ts';
export default async ({ workspace }) => {
  const trace = workspace.trace;
  trace.push('async factory completed');
  return {
    before_turn: async ({ task }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      trace.push('first handler completed');
      return { context: [marker, task] };
    },
  };
};
`,
    );
    await Deno.writeTextFile(
      `${configRoot}/hooks/second/index.ts`,
      `export default ({ workspace }) => ({
  before_turn: ({ context, task }) => {
    if (workspace.trace.at(-1) !== 'async-first result applied') {
      throw new Error('the first result was not applied before the next handler');
    }
    workspace.trace.push('second handler completed');
    return { context: [task, context.systemInstruction] };
  },
});
`,
    );

    const selection = await resolveWorkerConfiguration(configRoot);
    const loaded = await loadWorkerHooks(selection.hooks, {
      workspace,
      workTools: {},
    });
    deepStrictEqual(loaded.rejections, []);
    strictEqual(loaded.accepted.length, 2);
    deepStrictEqual(workspace.trace, ['async factory completed']);

    const context: HookContextSnapshot = {
      systemInstruction: 'base instruction',
      instructionComponents: [],
      tools: [],
      transcript: {
        turns: [],
        nextTurn: 1,
        messageCount: 0,
        range: {
          basis: 'session-canonical',
          retainedFromTurn: 1,
          omittedThroughTurn: 0,
          executionLocators: [],
          budget: { historyTokens: 0, inputLimit: 0, profile: 'test' },
        },
      },
      projectedContext: { retainedTurns: [] },
    };
    const runtime = {
      component: 'agent' as const,
      agentName: 'root',
      role: 'root' as const,
      workspaceRoot: workspace.root,
      workerGeneration: 'test-generation',
      executionId: 'execution-1',
      turnNumber: 1,
    };
    let effectiveInstruction = context.systemInstruction;
    const outcomes = await runHookPhase(
      loaded.accepted,
      'before_turn',
      () => ({
        runtime,
        task: 'current input',
        context: { ...context, systemInstruction: effectiveInstruction },
      }),
      (outcome) => {
        const result = outcome.result;
        if (result !== undefined && 'context' in result) {
          effectiveInstruction = `${effectiveInstruction} | ${result.context.join(' + ')}`;
        }
        workspace.trace.push(`${outcome.name} result applied`);
      },
    );
    deepStrictEqual(workspace.trace, [
      'async factory completed',
      'first handler completed',
      'async-first result applied',
      'second handler completed',
      'sync-second result applied',
    ]);
    deepStrictEqual(outcomes.map((entry) => entry.name), ['async-first', 'sync-second']);
    deepStrictEqual(outcomes.map((entry) => entry.result), [
      { context: ['from local import', 'current input'] },
      { context: ['current input', 'base instruction | from local import + current input'] },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 snapshots registered handlers and failed imports', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-hook-snapshot-' });
  const configRoot = `${root}/config`;
  const outputStore = createBashOutputStore();
  try {
    await writeAgentCatalog(configRoot);
    await writeJson(`${configRoot}/hooks.json`, {
      schemaVersion: 1,
      default: ['working', 'missing'],
      hooks: {
        working: 'hooks/working/index.ts',
        missing: 'hooks/missing/index.ts',
      },
    });
    await Deno.mkdir(`${configRoot}/hooks/working`, { recursive: true });
    await Deno.writeTextFile(
      `${configRoot}/hooks/working/index.ts`,
      `export default () => ({ runtime_start: () => ({ context: ['startup'] }) });\n`,
    );

    const selection = await resolveWorkerConfiguration(configRoot);
    const result = await createConfiguredWorkerComposition(selection, {
      workspace: { root: `${root}/workspace` },
      skillCatalog: emptySkillCatalog(),
      physicalIo: {
        createModel: () => ({
          generate: () => Promise.resolve({ kind: 'final' as const, text: 'unused' }),
        }),
        workTools: { bashOutputStore: outputStore },
      },
    });
    ok(result.ok);
    deepStrictEqual(result.snapshot.hooks, [{
      name: 'working',
      path: `${configRoot}/hooks/working/index.ts`,
      contract: HOOK_API_CONTRACT,
      handlers: ['runtime_start'],
    }]);
    strictEqual(result.snapshot.rejections.length, 1);
    strictEqual(result.snapshot.rejections[0].target, 'hook');
    strictEqual(result.snapshot.rejections[0].name, 'missing');
    ok(result.snapshot.rejections[0].reason.length > 0);
  } finally {
    await outputStore.close();
    await Deno.remove(root, { recursive: true });
  }
});
