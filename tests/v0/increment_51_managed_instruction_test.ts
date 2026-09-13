import { main as instructionMain } from '../../v0/agent/cli/instruction_cli.ts';
import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/core/execution_context.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { HENJI_COMMON_INSTRUCTION } from '../../v0/agent/instructions/henji_common.ts';
import {
  activateHenjiBaseInstruction,
  builtinHenjiBaseInstruction,
  deactivateHenjiBaseInstruction,
  HENJI_BASE_INSTRUCTION_SLOT,
  HenjiInstructionError,
  ManagedHenjiInstructionStore,
  resolveActiveHenjiBaseInstruction,
  verifyBuiltinHenjiBaseInstructionIdentity,
} from '../../v0/agent/instructions/managed_instruction.ts';
import {
  finalizeWorkerInstructionComposition,
  selectWorkerHenjiBaseInstruction,
} from '../../v0/agent/instructions/worker_core_finalizer.ts';
import type { WebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import {
  createDefaultAgentComposition,
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

Deno.test('Increment 51 instruction CLI separates install, inspect, active binding, and deactivate', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-51-cli-' });
  try {
    const source = `${root}/source`;
    const dataRoot = `${root}/data`;
    const configRoot = `${root}/config`;
    await writePackage(source, 'CLI EXTERNAL BASE');
    const invoke = async (args: string[]) => {
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
        stdout: stdout === '' ? undefined : JSON.parse(stdout),
        stderr: stderr === '' ? undefined : JSON.parse(stderr),
      };
    };

    const before = await invoke(['active']);
    assertEquals(before.code, 0);
    assertEquals(before.stdout.selectionSource, 'built-in');

    const installed = await invoke(['install', source]);
    assertEquals(installed.code, 0);
    const ref = installed.stdout.manifest.logicalRef;
    assertEquals((await invoke(['active'])).stdout.selectionSource, 'built-in');
    assertEquals((await invoke(['list'])).stdout.instructions.length, 1);
    const selector = [
      '--id',
      ref.resourceId,
      '--revision',
      `sha256:${ref.revision.digest}`,
    ];
    assertEquals(
      (await invoke(['inspect', ...selector])).stdout.content,
      'CLI EXTERNAL BASE',
    );

    const activated = await invoke(['activate', ...selector]);
    assertEquals(activated.stdout.selectionSource, 'external');
    assertEquals((await invoke(['active'])).stdout.ref, ref);

    const deactivated = await invoke(['deactivate']);
    assertEquals(deactivated.stdout.selectionSource, 'built-in');
    assertEquals((await invoke(['list'])).stdout.instructions.length, 1);
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
    const input = {
      workspace: { root: '/increment-51' },
      skillCatalog: emptySkillCatalog(),
      physicalIo: {
        createModel: (role: 'parent' | 'planner') => ({
          generate: (request: ModelRequest) => {
            if (role === 'planner') plannerRequests.push(request);
            return { kind: 'final' as const, text: 'done' };
          },
        }),
        webSearchBackend: noSearch,
      },
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
    const history = new SqliteHistoryStore(stateRoot, workspaceRoot);
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
