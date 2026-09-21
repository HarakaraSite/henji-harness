import { main as instructionMain } from '../../v0/agent/cli/instruction_cli.ts';
import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/core/execution_context.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { HENJI_COMMON_INSTRUCTION } from '../../v0/agent/instructions/henji_common.ts';
import {
  activateHenjiBaseInstruction,
  builtinHenjiBaseInstruction,
  deactivateHenjiBaseInstruction,
  HENJI_BASE_INSTRUCTION_SLOT,
  HenjiInstructionError,
  ManagedHenjiInstructionStore,
  resolveActiveHenjiBaseInstruction,
  resolveInstructionRevisionDigest,
  verifyBuiltinHenjiBaseInstructionIdentity,
} from '../../v0/agent/instructions/managed_instruction.ts';
import {
  finalizeWorkerInstructionComposition,
  selectWorkerHenjiBaseInstruction,
} from '../../v0/agent/instructions/worker_core_finalizer.ts';
import { createWebSearchTool, type WebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import { createWebFetchTool } from '../../v0/agent/tools/web_fetch.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../../v0/agent/tools/work_tools.ts';
import { createBashOutputTool } from '../../v0/agent/tools/bash_output.ts';
import {
  createAgentResourceIdentity,
  createDefaultAgentComposition,
  type PhysicalIoBindings,
  type ToolComponent,
  type WorkerAgentComposition,
} from '../../v0/agent/worker_agent_api.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import type { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';

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

const bundledToolComponents = (physicalIo: PhysicalIoBindings): readonly ToolComponent[] => [
  {
    identity: createAgentResourceIdentity('tool:bash'),
    materialize: (bindings) =>
      createBashTool(bindings.workspace, bindings.bashOutputStore, bindings.workTools.bash ?? {}),
  },
  {
    identity: createAgentResourceIdentity('tool:bash_output'),
    materialize: (bindings) => createBashOutputTool(bindings.bashOutputStore),
  },
  {
    identity: createAgentResourceIdentity('tool:edit'),
    materialize: (bindings) => createEditTool(bindings.workspace, bindings.workTools),
  },
  {
    identity: createAgentResourceIdentity('tool:read'),
    materialize: (bindings) => createReadTool(bindings.workspace),
  },
  {
    identity: createAgentResourceIdentity('tool:write'),
    materialize: (bindings) => createWriteTool(bindings.workspace, bindings.workTools),
  },
  {
    identity: createAgentResourceIdentity('tool:web_search'),
    materialize: () => createWebSearchTool(physicalIo.webSearchBackend!),
  },
  {
    identity: createAgentResourceIdentity('tool:web_fetch'),
    materialize: () => createWebFetchTool(),
  },
];

const packageManifest = (resourceId = 'example/henji-base') => ({
  schemaVersion: 1,
  resourceKind: 'henji-instruction',
  resourceId,
  slot: 'instruction:henji-base',
  apiContract: 'henji-instruction-v1',
  format: 'text/markdown',
  entry: 'instruction.md',
  metadata: {
    title: 'Increment 51 external base',
    description: 'Identifiable external instruction for product verification',
  },
});

const writePackage = async (
  root: string,
  content: string,
  resourceId = 'example/henji-base',
): Promise<void> => {
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}/henji-resource.json`,
    JSON.stringify(packageManifest(resourceId)),
  );
  await Deno.writeFile(
    `${root}/instruction.md`,
    new TextEncoder().encode(content),
  );
};

const noSearch: WebSearchBackend = {
  search: () => ({ answer: 'unused', sources: [] }),
};

Deno.test('Increment 51 installs an exact instruction revision independently of source and activation', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-51-store-' });
  try {
    const source = `${root}/source`;
    const dataRoot = `${root}/data`;
    const content = 'EXTERNAL BASE EXACT\r\n';
    await writePackage(source, content);
    let now = 0;
    const store = new ManagedHenjiInstructionStore({
      dataRoot,
      now: () => new Date(Date.UTC(2026, 8, 13, 0, 0, now++)),
    });
    const first = await store.install(source);
    const second = await store.install(source);
    assertEquals(second.manifest.logicalRef, first.manifest.logicalRef);
    assertEquals(second.custody, first.custody);
    assertEquals(second.content, content);
    assertEquals(second.contentBytes, new TextEncoder().encode(content));
    assertEquals(await store.list(), [first.manifest]);

    await Deno.remove(source, { recursive: true });
    const resolved = await store.resolve(first.manifest.logicalRef);
    assertEquals(resolved.content, content);
    assertEquals(resolved.contentBytes, first.contentBytes);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 52 instruction install returns a short human receipt before inspect and activate', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-51-cli-' });
  try {
    const source = `${root}/source`;
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    const resourceId = "example/o'henji";
    await writePackage(source, 'CLI EXTERNAL BASE', resourceId);
    const invokeRaw = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await instructionMain(args, {
        dataRoot,
        configRoot,
        now: () => new Date('2026-09-13T00:00:00.000Z'),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });
      return {
        code,
        stdout,
        stderr,
      };
    };
    const invoke = async (args: string[]) => {
      const result = await invokeRaw(args);
      return {
        code: result.code,
        stdout: result.stdout === '' ? undefined : JSON.parse(result.stdout),
        stderr: result.stderr === '' ? undefined : JSON.parse(result.stderr),
      };
    };

    const before = await invoke(['active', '--json']);
    assertEquals(before.code, 0);
    assertEquals(before.stdout.selectionSource, 'built-in');

    const installed = await invokeRaw(['install', source]);
    assertEquals(installed.code, 0);
    assertEquals((await invoke(['active', '--json'])).stdout.selectionSource, 'built-in');
    const listed = await invoke(['list', '--json']);
    assertEquals(listed.stdout.instructions.length, 1);
    const ref = listed.stdout.instructions[0].logicalRef;
    const shortRevision = ref.revision.digest.slice(0, 8);
    const expectedSelector = `--id 'example/o'"'"'henji' --revision '${shortRevision}'`;
    assertEquals(
      installed.stdout,
      `Installed: ${JSON.stringify(resourceId)}\n` +
        `Revision:  sha256:${shortRevision}\n\n` +
        `Inspect:\n` +
        `henji instruction inspect ${expectedSelector}\n\n` +
        `Activate:\n` +
        `henji instruction activate ${expectedSelector}\n\n` +
        `Uninstall:\n` +
        `henji instruction uninstall ${expectedSelector}\n`,
    );
    assert(!installed.stdout.includes('CLI EXTERNAL BASE'));
    assert(!installed.stdout.includes(dataRoot));
    const selector = [
      '--id',
      ref.resourceId,
      '--revision',
      shortRevision,
    ];
    assertEquals(
      (await invoke(['inspect', ...selector])).stdout.content,
      'CLI EXTERNAL BASE',
    );

    const activated = await invoke(['activate', ...selector]);
    assertEquals(activated.stdout.selectionSource, 'external');
    assertEquals((await invoke(['active', '--json'])).stdout.ref, ref);

    const deactivatedHuman = await invokeRaw(['deactivate']);
    assertEquals(
      deactivatedHuman.stdout,
      `deactivated · builtin/henji-base · built-in · sha256:${
        builtinHenjiBaseInstruction().ref.revision.digest.slice(0, 8)
      }\n`,
    );
    const deactivated = await invoke(['deactivate', '--json']);
    assertEquals(deactivated.stdout.selectionSource, 'built-in');
    assertEquals((await invoke(['list', '--json'])).stdout.instructions.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 54 instruction uninstall removes inactive revisions and refuses the active one', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-54-cli-' });
  try {
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    const sourceA = `${root}/a`;
    const sourceB = `${root}/b`;
    await writePackage(sourceA, 'BASE A', 'example/a');
    await writePackage(sourceB, 'BASE B', 'example/b');
    const invokeRaw = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await instructionMain(args, {
        dataRoot,
        configRoot,
        now: () => new Date('2026-09-17T00:00:00.000Z'),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });
      return { code, stdout, stderr };
    };
    const invoke = async (args: string[]) => {
      const result = await invokeRaw(args);
      return {
        code: result.code,
        stdout: result.stdout === '' ? undefined : JSON.parse(result.stdout),
        stderr: result.stderr === '' ? undefined : JSON.parse(result.stderr),
      };
    };
    assertEquals((await invokeRaw(['install', sourceA])).code, 0);
    assertEquals((await invokeRaw(['install', sourceB])).code, 0);
    const listed = await invoke(['list', '--json']);
    assertEquals(listed.stdout.instructions.length, 2);
    const refA = listed.stdout.instructions.find(
      (item: { logicalRef: { resourceId: string } }) => item.logicalRef.resourceId === 'example/a',
    ).logicalRef;
    const refB = listed.stdout.instructions.find(
      (item: { logicalRef: { resourceId: string } }) => item.logicalRef.resourceId === 'example/b',
    ).logicalRef;
    const selectorA = ['--id', refA.resourceId, '--revision', `sha256:${refA.revision.digest}`];
    const selectorB = ['--id', refB.resourceId, '--revision', `sha256:${refB.revision.digest}`];

    assertEquals((await invoke(['activate', ...selectorB])).code, 0);

    const removed = await invokeRaw(['uninstall', ...selectorA]);
    assertEquals(removed.code, 0);
    assertEquals(
      removed.stdout,
      `Uninstalled: "example/a"\nRevision:    sha256:${refA.revision.digest.slice(0, 8)}\n`,
    );
    assertEquals(
      (await invoke(['inspect', ...selectorA])).stderr.error.code,
      'instruction_not_found',
    );
    assertEquals(
      (await invoke(['list', '--json'])).stdout.instructions.map(
        (item: { logicalRef: { resourceId: string } }) => item.logicalRef.resourceId,
      ),
      ['example/b'],
    );

    const refused = await invoke(['uninstall', ...selectorB]);
    assertEquals(refused.code, 1);
    assertEquals(refused.stderr.error.code, 'instruction_active');
    assertEquals(refused.stderr.error.instruction.revision.digest, refB.revision.digest);
    assertEquals((await invoke(['active', '--json'])).stdout.ref, refB);
    assertEquals((await invoke(['inspect', ...selectorB])).stdout.content, 'BASE B');

    assertEquals((await invoke(['deactivate', '--json'])).stdout.selectionSource, 'built-in');
    assertEquals((await invokeRaw(['uninstall', ...selectorB])).code, 0);
    assertEquals((await invoke(['list', '--json'])).stdout.instructions.length, 0);
    assertEquals(
      (await invoke(['uninstall', ...selectorA])).stderr.error.code,
      'instruction_not_found',
    );
    assertEquals(
      (await invoke([
        'uninstall',
        '--id',
        'builtin/henji-base',
        '--revision',
        `sha256:${'0'.repeat(64)}`,
      ])).stderr.error.code,
      'instruction_invalid',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 55 revision resolution reports ambiguous prefixes', () => {
  const d1 = '11'.repeat(32);
  const d2 = '11'.repeat(4) + '22'.repeat(28);
  const d3 = '33'.repeat(32);
  const installed = [
    { resourceId: 'example/a', digest: d1 },
    { resourceId: 'example/a', digest: d2 },
    { resourceId: 'example/b', digest: d3 },
  ];
  assertEquals(resolveInstructionRevisionDigest(installed, 'example/a', '1111111111'), d1);
  assertEquals(resolveInstructionRevisionDigest(installed, 'example/b'), d3);
  const codeOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      if (error instanceof HenjiInstructionError) return error.code;
      throw error;
    }
    throw new Error('expected a HenjiInstructionError');
  };
  assertEquals(
    codeOf(() => resolveInstructionRevisionDigest(installed, 'example/a', '11111111')),
    'instruction_ambiguous',
  );
  assertEquals(
    codeOf(() => resolveInstructionRevisionDigest(installed, 'example/a', '1111')),
    'instruction_invalid',
  );
  assertEquals(
    codeOf(() => resolveInstructionRevisionDigest(installed, 'builtin/henji-base')),
    'instruction_invalid',
  );
  assertEquals(
    codeOf(() => resolveInstructionRevisionDigest(installed, 'example/c')),
    'instruction_not_found',
  );
});

Deno.test('Increment 55 resolves short revisions and prints human list/active lines', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-55-cli-' });
  try {
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    const sourceA = `${root}/a`;
    const sourceA2 = `${root}/a2`;
    const sourceB = `${root}/b`;
    await writePackage(sourceA, 'BASE A', 'example/a');
    await writePackage(sourceA2, 'BASE A2', 'example/a');
    await writePackage(sourceB, 'BASE B', 'example/b');
    const invokeRaw = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await instructionMain(args, {
        dataRoot,
        configRoot,
        now: () => new Date('2026-09-17T00:00:00.000Z'),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });
      return { code, stdout, stderr };
    };
    const invoke = async (args: string[]) => {
      const result = await invokeRaw(args);
      return {
        code: result.code,
        stdout: result.stdout === '' ? undefined : JSON.parse(result.stdout),
        stderr: result.stderr === '' ? undefined : JSON.parse(result.stderr),
      };
    };
    assertEquals((await invokeRaw(['install', sourceA])).code, 0);
    assertEquals((await invokeRaw(['install', sourceA2])).code, 0);
    assertEquals((await invokeRaw(['install', sourceB])).code, 0);

    const listed = await invoke(['list', '--json']);
    assertEquals(listed.stdout.instructions.length, 3);
    const refs = listed.stdout.instructions.map(
      (item: { logicalRef: { resourceId: string } }) => item.logicalRef,
    );
    const refB = refs.find(
      (ref: { resourceId: string }) => ref.resourceId === 'example/b',
    );
    let refA: { resourceId: string; revision: { digest: string } } | undefined;
    let refA2: { resourceId: string; revision: { digest: string } } | undefined;
    for (
      const ref of refs.filter(
        (item: { resourceId: string }) => item.resourceId === 'example/a',
      )
    ) {
      const content = (await invoke([
        'inspect',
        '--id',
        ref.resourceId,
        '--revision',
        `sha256:${ref.revision.digest}`,
      ])).stdout.content;
      if (content === 'BASE A') refA = ref;
      else refA2 = ref;
    }
    assert(refA !== undefined && refA2 !== undefined);
    const shortA = refA.revision.digest.slice(0, 8);
    const shortB = refB.revision.digest.slice(0, 8);

    assertEquals(
      (await invoke(['inspect', '--id', 'example/a', '--revision', shortA])).stdout.content,
      'BASE A',
    );
    assertEquals(
      (await invoke(['inspect', '--id', 'example/a', '--revision', `sha256:${shortA}`])).stdout
        .content,
      'BASE A',
    );
    assertEquals(
      (await invoke(['inspect', '--id', 'example/a', '--revision', shortA.slice(0, 4)])).stderr
        .error.code,
      'instruction_invalid',
    );

    const human = await invokeRaw(['list']);
    assertEquals(human.code, 0);
    assert(human.stdout.startsWith('instructions: 3\n'));
    assert(human.stdout.includes(`example/b · sha256:${shortB} · inactive`));
    assert(human.stdout.includes(`example/a · sha256:${shortA} · inactive`));

    assertEquals(
      (await invokeRaw(['activate', '--id', 'example/b', '--revision', shortB])).code,
      0,
    );
    const activeHuman = await invokeRaw(['active']);
    assertEquals(activeHuman.stdout, `example/b · external · sha256:${shortB}\n`);
    assertEquals(
      (await invoke(['active', '--json'])).stdout.ref.revision.digest,
      refB.revision.digest,
    );
    const listWithActive = await invokeRaw(['list']);
    assert(listWithActive.stdout.includes(`example/b · sha256:${shortB} · active`));

    assertEquals(
      (await invoke(['uninstall', '--id', 'example/b'])).stderr.error.code,
      'instruction_active',
    );
    assertEquals((await invoke(['deactivate', '--json'])).stdout.selectionSource, 'built-in');
    const removedB = await invokeRaw(['uninstall', '--id', 'example/b']);
    assertEquals(removedB.code, 0);
    assert(removedB.stdout.includes('Uninstalled: "example/b"'));
    assertEquals(
      (await invoke(['inspect', '--id', 'example/b', '--revision', shortB])).stderr.error.code,
      'instruction_not_found',
    );

    assertEquals(
      (await invoke(['uninstall', '--id', 'example/a'])).stderr.error.code,
      'instruction_ambiguous',
    );
    assertEquals(
      (await invokeRaw(['uninstall', '--id', 'example/a', '--revision', shortA])).code,
      0,
    );
    assertEquals((await invoke(['list', '--json'])).stdout.instructions.length, 1);
    assertEquals((await invokeRaw(['uninstall', '--id', 'example/a'])).code, 0);
    assertEquals((await invokeRaw(['list'])).stdout, 'no instructions\n');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 51 finalizer replaces only the base slot for root, opaque Definition, and delegated planner', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-51-finalizer-',
  });
  try {
    const source = `${root}/source`;
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    const externalText = 'EXTERNAL FINALIZER BASE\n';
    await writePackage(source, externalText);
    const revision = await new ManagedHenjiInstructionStore({ dataRoot })
      .install(source);
    const selected = await activateHenjiBaseInstruction(
      dataRoot,
      configRoot,
      revision.manifest.logicalRef,
    );
    selectWorkerHenjiBaseInstruction(selected);

    const plannerRequests: ModelRequest[] = [];
    const physicalIo = {
      createModel: (role: 'parent' | 'planner') => ({
        generate: (request: ModelRequest) => {
          if (role === 'planner') plannerRequests.push(request);
          return { kind: 'final' as const, text: 'done' };
        },
      }),
      webSearchBackend: noSearch,
    };
    const input = {
      workspace: { root: '/increment-51' },
      skillCatalog: emptySkillCatalog(),
      physicalIo,
      toolDefinitions: bundledToolComponents(physicalIo),
    };
    const finalized = finalizeWorkerInstructionComposition(
      createDefaultAgentComposition(input),
    );
    assert(finalized.systemInstruction?.startsWith(`${externalText}\n\n`));
    assert(!finalized.systemInstruction?.includes(HENJI_COMMON_INSTRUCTION));
    assertEquals(
      String(finalized.instructionComponents?.[0].identity),
      HENJI_BASE_INSTRUCTION_SLOT,
    );
    assertEquals(finalized.instructionComponents?.[0].text, externalText);
    assertEquals(
      finalized.manifest.baseInstruction?.ref,
      revision.manifest.logicalRef,
    );
    assert(finalized.manifest.resources.includes(HENJI_BASE_INSTRUCTION_SLOT));

    const delegated = await finalized.registry.dispatch(
      {
        callId: 'increment-51-planner',
        name: 'delegate_to_planner',
        arguments: { task: 'return the instruction' },
      },
      new ParentTurnExecutionContext(1),
    );
    assertEquals(delegated.content.outcome, 'success');
    assertEquals(plannerRequests.length, 1);
    assert(
      plannerRequests[0].systemInstruction?.startsWith(`${externalText}\n\n`),
    );
    assert(
      !plannerRequests[0].systemInstruction?.includes(HENJI_COMMON_INSTRUCTION),
    );

    const opaque = {
      ...createDefaultAgentComposition(input),
      systemInstruction: 'OPAQUE DEFINITION CONTRIBUTION',
      instructionComponents: undefined,
    } as WorkerAgentComposition;
    const opaqueFinal = finalizeWorkerInstructionComposition(opaque);
    assertEquals(
      opaqueFinal.systemInstruction,
      `${externalText}\n\nOPAQUE DEFINITION CONTRIBUTION`,
    );
    assertEquals(
      opaqueFinal.instructionComponents?.map((component) => String(component.identity)),
      [HENJI_BASE_INSTRUCTION_SLOT, 'instruction:definition-contribution'],
    );

    let rejected = false;
    try {
      finalizeWorkerInstructionComposition({
        ...createDefaultAgentComposition(input),
        instructionComponents: [{
          identity: HENJI_BASE_INSTRUCTION_SLOT as never,
          text: 'Definition-owned duplicate base',
        }],
        systemInstruction: 'Definition-owned duplicate base',
      });
    } catch {
      rejected = true;
    }
    assert(rejected);
  } finally {
    selectWorkerHenjiBaseInstruction(builtinHenjiBaseInstruction());
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 51 applies external base on the real Worker path and retains exact request attribution', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-51-worker-' });
  const source = `${root}/source`;
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  const stateRoot = `${root}/state`;
  const workspaceRoot = `${root}/workspace`;
  const externalText = 'EXTERNAL WORKER BASE\r\n';
  try {
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await writePackage(source, externalText);
    const store = new ManagedHenjiInstructionStore({ dataRoot });
    const revision = await store.install(source);
    await activateHenjiBaseInstruction(
      dataRoot,
      configRoot,
      revision.manifest.logicalRef,
    );
    await Deno.remove(source, { recursive: true });

    const created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot,
      configRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    let executionId: string | undefined;
    try {
      const startup = created.session.startupSnapshot();
      assertEquals(
        startup.context?.instructionComponents[0].text,
        externalText,
      );
      assert(
        startup.context?.instructionComponents[0].sourceLocator?.startsWith(
          'external:',
        ),
      );
      const outcome = await created.session.submit(
        'return active tool guidelines',
      );
      assert(outcome.ok, JSON.stringify(outcome));
      assert(outcome.finalText?.startsWith(`${externalText}\n\n`));
      assert(!outcome.finalText?.includes(HENJI_COMMON_INSTRUCTION));
      executionId = outcome.executionArtifactId;
      await deactivateHenjiBaseInstruction(configRoot);
      assertEquals(
        created.session.startupSnapshot().context?.instructionComponents[0].text,
        externalText,
      );
      const createNew = created.navigation?.createNew;
      assert(createNew !== undefined);
      const nextGeneration = await createNew();
      assertEquals(
        (nextGeneration.session as WorkerHostSession).startupSnapshot().context
          ?.instructionComponents[0].text,
        HENJI_COMMON_INSTRUCTION,
      );
    } finally {
      await created.close();
    }
    assert(executionId !== undefined);
    const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
    await history.initialize();
    const context = history.listExecutionContext(executionId);
    const base = context.snapshot?.instructionComponents[0];
    assertEquals(base?.text, externalText);
    assert(
      base?.sourceLocator?.includes(
        revision.manifest.logicalRef.revision.digest,
      ),
    );
    const system = context.requests[0].items.find((item) => item.kind === 'system');
    const projectedBase = system?.sourceRelations?.find((relation) =>
      relation.logicalIdentity === HENJI_BASE_INSTRUCTION_SLOT
    );
    assertEquals(
      projectedBase?.contentDigest,
      `sha256:${revision.manifest.content.sha256}`,
    );
    assert(projectedBase?.sourceLocator?.includes('#bytes=0-'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 51 deactivation restores built-in and a missing active exact ref fails before Session state', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-51-binding-',
  });
  const source = `${root}/source`;
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  const stateRoot = `${root}/state`;
  const workspaceRoot = `${root}/workspace`;
  try {
    assert(await verifyBuiltinHenjiBaseInstructionIdentity());
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await writePackage(source, 'BOUND EXTERNAL BASE');
    const revision = await new ManagedHenjiInstructionStore({ dataRoot })
      .install(source);
    await activateHenjiBaseInstruction(
      dataRoot,
      configRoot,
      revision.manifest.logicalRef,
    );
    await Deno.remove(revision.entryPath);
    let failure: unknown;
    try {
      await createWorkerSession({
        workspaceRoot,
        stateRoot,
        dataRoot,
        configRoot,
        persistence: 'new',
        physicalIoMode: 'provider-free',
      });
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof HenjiInstructionError);
    assertEquals(failure.code, 'instruction_invalid');
    assertEquals(failure.instruction, revision.manifest.logicalRef);
    let stateExists = true;
    try {
      await Deno.lstat(stateRoot);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) stateExists = false;
      else throw error;
    }
    assertEquals(stateExists, false);

    await deactivateHenjiBaseInstruction(configRoot);
    assertEquals(
      (await resolveActiveHenjiBaseInstruction(dataRoot, configRoot))
        .selectionSource,
      'built-in',
    );
    const builtIn = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot,
      configRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    try {
      const startup = builtIn.session.startupSnapshot();
      assertEquals(
        startup.context?.instructionComponents[0].text,
        HENJI_COMMON_INSTRUCTION,
      );
      assert(
        startup.context?.instructionComponents[0].sourceLocator?.startsWith(
          'built-in:',
        ),
      );
      const outcome = await builtIn.session.submit(
        'return active tool guidelines',
      );
      assert(outcome.ok, JSON.stringify(outcome));
      assert(outcome.finalText?.startsWith(`${HENJI_COMMON_INSTRUCTION}\n\n`));
    } finally {
      await builtIn.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
