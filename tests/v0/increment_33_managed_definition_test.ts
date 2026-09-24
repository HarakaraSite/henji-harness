import { main as moduleMain } from '../../v0/agent/cli/module_cli.ts';
import { main as runtimeMain, parseRuntimeArgs } from '../../v0/agent/cli/runtime_cli.ts';
import { main as tuiMain, parseTuiInvocation } from '../../v0/agent/cli/tui_cli.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import {
  DefinitionStartupError,
  parseDefinitionRevisionSelector,
  resolveDefinitionRef,
  resolveRequestedDefinition,
} from '../../v0/agent/definitions/definition_selection.ts';
import {
  importManagedDefinition,
  ManagedDefinitionError,
} from '../../v0/agent/definitions/managed_definition_importer.ts';
import type { ManagedDefinitionManifestV1 } from '../../v0/agent/definitions/managed_definition_manifest.ts';
import { ManagedDefinitionStore } from '../../v0/agent/definitions/managed_definition_store.ts';
import { ManagedToolDefinitionStore } from '../../v0/agent/definitions/managed_tool_definition_store.ts';
import {
  isDefinitionRevisionRef,
  isExternalDefinitionResourceId,
} from '../../v0/agent/definitions/managed_resource_ref.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import {
  type DefinitionRevisionRef,
  type StoredSessionRecord,
} from '../../v0/agent/session/session_store.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { runHeadlessWorker } from '../../v0/agent/worker/worker_headless_runner.ts';
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

const writeModule = async (root: string, suffix = ''): Promise<string> => {
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}/dependency.ts`,
    `export const label = 'managed${suffix}';\n`,
  );
  await Deno.writeTextFile(
    `${root}/entry.ts`,
    "import type {} from '@henji/agent';\n" +
      "import { label } from './dependency.ts';\n" +
      'export default { label };\n',
  );
  return `${root}/entry.ts`;
};

const writeExecutableModule = async (
  root: string,
  effectiveRole: 'parent' | 'planner',
): Promise<string> => {
  await Deno.mkdir(root, { recursive: true });
  const composition = effectiveRole === 'planner'
    ? "({ ...createDefaultAgentComposition(input), role: 'planner' }) as unknown as ReturnType<typeof createDefaultAgentComposition>"
    : 'createDefaultAgentComposition(input)';
  await Deno.writeTextFile(
    `${root}/composition.ts`,
    "import { createDefaultAgentComposition, type ExecutableAgentDefinitionInput } from '@henji/agent';\n" +
      `export const compose = (input: ExecutableAgentDefinitionInput) => ${composition};\n`,
  );
  await Deno.writeTextFile(
    `${root}/entry.ts`,
    "import type { ExecutableAgentDefinition } from '@henji/agent';\n" +
      "import { compose } from './composition.ts';\n" +
      'const definition: ExecutableAgentDefinition = (input) => compose(input);\n' +
      'export default definition;\n',
  );
  return `${root}/entry.ts`;
};

const fixturePath = (relative: string): string =>
  new URL(`./fixtures/increment_33/${relative}`, import.meta.url).pathname;

const copyFixture = async (
  name: 'parent' | 'planner' | 'replacement',
  destination: string,
): Promise<string> => {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(fixturePath(name))) {
    if (entry.isFile) {
      await Deno.copyFile(
        fixturePath(`${name}/${entry.name}`),
        `${destination}/${entry.name}`,
      );
    }
  }
  return `${destination}/entry.ts`;
};

const assertRejectCode = async (
  action: () => Promise<unknown>,
  code: ManagedDefinitionError['code'],
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    assert(error instanceof ManagedDefinitionError);
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
};

const assertStartupError = async (
  action: () => Promise<unknown>,
  code: DefinitionStartupError['code'],
  stage: DefinitionStartupError['stage'],
  definition?: DefinitionRevisionRef,
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    assert(error instanceof DefinitionStartupError);
    assertEquals(error.code, code);
    assertEquals(error.stage, stage);
    if (definition !== undefined) assertEquals(error.definition, definition);
    return;
  }
  throw new Error(`expected ${code}`);
};

const assertThrows = (action: () => unknown): void => {
  try {
    action();
  } catch {
    return;
  }
  throw new Error('expected rejection');
};

class StartupProbeTerminal implements TerminalPort {
  rawCalls = 0;

  stdinIsTerminal(): boolean {
    return true;
  }

  stdoutIsTerminal(): boolean {
    return true;
  }

  consoleSize(): { columns: number; rows: number } {
    return { columns: 80, rows: 24 };
  }

  setRaw(): void {
    this.rawCalls += 1;
  }

  read(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  drainAndCloseInput(): Promise<void> {
    return Promise.resolve();
  }

  write(): void {}
  addSignal(): void {}
  removeSignal(): void {}
}

const persistEmptyExternalSession = async (
  stateRoot: string,
  workspaceRoot: string,
  agent: StoredSessionRecord['agent'],
  definition: DefinitionRevisionRef,
): Promise<string> => {
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  const handle = await store.allocateWorker(agent, definition);
  const timestamp = '2026-09-12T01:02:03.000Z';
  const model = defaultModelSelectionFor('openrouter-chat');
  const record: StoredSessionRecord = {
    schemaVersion: 6,
    sessionId: handle.id,
    workspaceRoot,
    agent,
    createdAt: timestamp,
    updatedAt: timestamp,
    title: null,
    stateRevision: 1,
    nextTurn: 1,
    transcript: [],
    definition,
    activeModel: model,
    modelChanges: [{
      effectiveFromTurn: 1,
      changedAt: timestamp,
      selection: model,
    }],
    turnModels: [],
    turnExecutions: [],
  };
  handle.commit(record);
  await handle.close();
  return handle.id;
};

Deno.test('Increment 33 accepts external Definition refs structurally', () => {
  const ref = {
    schemaVersion: 1,
    resourceKind: 'agent-definition',
    resourceId: 'team/回答-agent',
    revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
  };
  assert(isDefinitionRevisionRef(ref));
  assert(isExternalDefinitionResourceId(ref.resourceId));
  assert(!isExternalDefinitionResourceId('builtin/default'));
  assert(!isExternalDefinitionResourceId('\ud800'));
});

Deno.test('Increment 33 installs and retains exact managed Definition revisions', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-33-store-' });
  try {
    const firstSource = `${root}/source-a`;
    const secondSource = `${root}/source-b`;
    const firstEntry = await writeModule(firstSource);
    const secondEntry = await writeModule(secondSource);
    let installedAt = new Date('2026-09-12T01:02:03.000Z');
    const store = new ManagedDefinitionStore({
      dataRoot: `${root}/data`,
      now: () => installedAt,
    });

    const first = await store.install({
      entryPath: firstEntry,
      resourceId: 'example/parent',
      declaredRole: 'parent',
    });
    const sameContentDifferentIdentity = await store.install({
      entryPath: secondEntry,
      resourceId: 'example/copy',
      declaredRole: 'parent',
    });
    assertEquals(
      first.manifest.logicalRef.revision.digest,
      sameContentDifferentIdentity.manifest.logicalRef.revision.digest,
    );
    assertEquals(first.manifest.files.map((file) => file.path), [
      'dependency.ts',
      'entry.ts',
    ]);
    assertEquals(first.manifest.exactResourceBindings, []);
    assert(
      first.manifest.files[1].dependencies.some((dependency) =>
        dependency.target.kind === 'embedded-api'
      ),
    );

    installedAt = new Date('2026-09-12T09:09:09.000Z');
    const duplicate = await store.install({
      entryPath: firstEntry,
      resourceId: 'example/parent',
      declaredRole: 'parent',
    });
    assertEquals(duplicate.custody.localCustody.kind, 'installed');
    assert(duplicate.custody.localCustody.kind === 'installed');
    assertEquals(
      duplicate.custody.localCustody.installedAt,
      '2026-09-12T01:02:03.000Z',
    );

    await assertRejectCode(
      () =>
        store.install({
          entryPath: secondEntry,
          resourceId: 'example/planner',
          declaredRole: 'subagent',
          subagentName: 'planner',
        }),
      'module_invalid',
    );

    await writeModule(firstSource, '-edited');
    const edited = await store.install({
      entryPath: firstEntry,
      resourceId: 'example/parent',
      declaredRole: 'parent',
    });
    assert(
      edited.manifest.logicalRef.revision.digest !==
        first.manifest.logicalRef.revision.digest,
    );
    assertEquals(
      (await store.inspect(
        'example/parent',
        first.manifest.logicalRef.revision.digest,
      )).manifest,
      first.manifest,
    );
    assertEquals(
      (await store.resolve(first.manifest.logicalRef)).manifest,
      first.manifest,
    );
    assertEquals((await store.list()).length, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 33 reports unsupported Definition imports during install', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-33-imports-',
  });
  try {
    const dynamicRoot = `${root}/dynamic`;
    await Deno.mkdir(dynamicRoot);
    await Deno.writeTextFile(
      `${dynamicRoot}/entry.ts`,
      "await import('./dependency.ts');\n",
    );
    await Deno.writeTextFile(`${dynamicRoot}/dependency.ts`, 'export {};\n');
    await assertRejectCode(
      () =>
        importManagedDefinition({
          entryPath: `${dynamicRoot}/entry.ts`,
          resourceId: 'example/dynamic',
          declaredRole: 'parent',
        }),
      'module_import_unsupported',
    );

    const remoteRoot = `${root}/remote`;
    await Deno.mkdir(remoteRoot);
    await Deno.writeTextFile(
      `${remoteRoot}/entry.ts`,
      "import 'https://example.invalid/definition.ts';\n",
    );
    await assertRejectCode(
      () =>
        importManagedDefinition({
          entryPath: `${remoteRoot}/entry.ts`,
          resourceId: 'example/remote',
          declaredRole: 'parent',
        }),
      'module_import_unsupported',
    );

    const boundedRoot = `${root}/bounded`;
    await Deno.mkdir(boundedRoot);
    await Deno.writeTextFile(`${root}/outside.ts`, 'export {};\n');
    await Deno.writeTextFile(
      `${boundedRoot}/entry.ts`,
      "import '../outside.ts';\n",
    );
    await assertRejectCode(
      () =>
        importManagedDefinition({
          entryPath: `${boundedRoot}/entry.ts`,
          moduleRoot: boundedRoot,
          resourceId: 'example/outside',
          declaredRole: 'parent',
        }),
      'module_import_unsupported',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 33 module CLI installs, lists, and inspects without a provider', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-33-cli-' });
  try {
    const entry = await writeModule(`${root}/source`);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const dependencies = {
      dataRoot: `${root}/data`,
      now: () => new Date('2026-09-12T01:02:03.000Z'),
      writeStdout: (text: string) => {
        stdout.push(text);
      },
      writeStderr: (text: string) => {
        stderr.push(text);
      },
    };
    assertEquals(
      await moduleMain(['install', entry, '--id', 'example/cli'], dependencies),
      0,
    );
    const installed = JSON.parse(stdout.pop()!);
    assert(installed.ok);
    assertEquals(installed.manifest.logicalRef.resourceId, 'example/cli');

    assertEquals(await moduleMain(['list'], dependencies), 0);
    const listed = JSON.parse(stdout.pop()!);
    assertEquals(listed.modules.length, 1);
    assertEquals(listed.modules[0].logicalRef, installed.manifest.logicalRef);

    assertEquals(
      await moduleMain([
        'inspect',
        '--id',
        'example/cli',
        '--revision',
        `sha256:${installed.manifest.logicalRef.revision.digest}`,
      ], dependencies),
      0,
    );
    const inspected = JSON.parse(stdout.pop()!);
    assertEquals(inspected.manifest, installed.manifest);
    assertEquals(stderr, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 33 parses only full exact Definition selectors', () => {
  const digest = 'b'.repeat(64);
  assertEquals(parseDefinitionRevisionSelector(`team@blue@sha256:${digest}`), {
    schemaVersion: 1,
    resourceKind: 'agent-definition',
    resourceId: 'team@blue',
    revision: { algorithm: 'sha256', digest },
  });
  assertEquals(
    parseRuntimeArgs([
      '--task',
      'run',
      '--definition-revision',
      `team@blue@sha256:${digest}`,
    ]),
    {
      taskArg: 'run',
      rawAgentName: undefined,
      rawDefinitionRevision: `team@blue@sha256:${digest}`,
    },
  );
  assertEquals(
    parseTuiInvocation([
      '--continue',
      '--definition-revision',
      `team@blue@sha256:${digest}`,
    ]),
    {
      rawAgentName: undefined,
      rawDefinitionRevision: `team@blue@sha256:${digest}`,
      persistence: 'continue',
    },
  );
  for (
    const value of [
      'team@sha256:abc123',
      'team',
      `builtin/default@sha256:${digest}`,
      `team@sha256:${digest.toUpperCase()}`,
    ]
  ) {
    assertThrows(() => parseDefinitionRevisionSelector(value));
    assertThrows(() => parseRuntimeArgs(['--definition-revision', value]));
    assertThrows(() => parseTuiInvocation(['--definition-revision', value]));
  }
  assertThrows(() =>
    parseRuntimeArgs([
      '--agent',
      'default',
      '--definition-revision',
      `team@sha256:${digest}`,
    ])
  );
  assertThrows(() =>
    parseTuiInvocation([
      '--agent',
      'default',
      '--definition-revision',
      `team@sha256:${digest}`,
    ])
  );
});

Deno.test('Increment 33 resolves before stdin and reports evaluation before terminal raw mode', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-33-preflight-',
  });
  try {
    const dataRoot = `${root}/data`;
    const stateRoot = `${root}/state`;
    const entry = await writeModule(`${root}/source`);
    const revision = await new ManagedDefinitionStore({ dataRoot }).install({
      entryPath: entry,
      resourceId: 'example/preflight',
      declaredRole: 'parent',
    });
    const selector = `example/preflight@sha256:${revision.manifest.logicalRef.revision.digest}`;
    const resolved = await resolveRequestedDefinition(
      undefined,
      selector,
      dataRoot,
    );
    assertEquals(resolved.kind, 'managed');
    assertEquals(resolved.id, 'default');
    assertEquals(resolved.ref, revision.manifest.logicalRef);

    let stdinChecks = 0;
    let stdinReads = 0;
    let runs = 0;
    let stderr = '';
    const missingDigest = 'c'.repeat(64);
    assertEquals(
      await runtimeMain([
        '--definition-revision',
        `example/missing@sha256:${missingDigest}`,
      ], {
        dataRoot,
        stdinIsTerminal: () => {
          stdinChecks += 1;
          return false;
        },
        readStdin: () => {
          stdinReads += 1;
          return Promise.resolve(new TextEncoder().encode('must not be read'));
        },
        run: () => {
          runs += 1;
          throw new Error('must not run');
        },
        writeStderr: (text) => {
          stderr += text;
        },
      }),
      1,
    );
    assertEquals({ stdinChecks, stdinReads, runs }, {
      stdinChecks: 0,
      stdinReads: 0,
      runs: 0,
    });
    const failure = JSON.parse(stderr);
    assertEquals(failure.error.code, 'definition_not_found');
    assertEquals(failure.error.stage, 'resolution');
    assertEquals(failure.error.definition.resourceId, 'example/missing');

    await assertStartupError(
      () =>
        createWorkerSession({
          workspaceRoot: root,
          stateRoot,
          dataRoot,
          persistence: 'none',
          selection: resolved,
          physicalIoMode: 'provider-free',
        }),
      'definition_evaluation_failed',
      'worker_start',
      revision.manifest.logicalRef,
    );

    const terminal = new StartupProbeTerminal();
    stderr = '';
    assertEquals(
      await tuiMain(['--no-session', '--definition-revision', selector], {
        terminal,
        dataRoot,
        stateRoot,
        workspaceRoot: root,
        dailyEditor: false,
        createSession: (eventSink, selection) =>
          createWorkerSession({
            workspaceRoot: root,
            stateRoot,
            dataRoot,
            persistence: 'none',
            selection,
            physicalIoMode: 'provider-free',
            eventSink,
          }),
        writeStderr: (text) => {
          stderr += text;
        },
      }),
      1,
    );
    assertEquals(terminal.rawCalls, 0);
    assertEquals(JSON.parse(stderr).error.code, 'definition_evaluation_failed');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 33 reopens a stored Session under the selected Definition revision', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-33-binding-',
  });
  try {
    const dataRoot = `${root}/data`;
    const stateRoot = `${root}/state`;
    const workspaceRoot = `${root}/workspace`;
    await Deno.mkdir(workspaceRoot);
    const entry = await writeModule(`${root}/source`);
    const store = new ManagedDefinitionStore({ dataRoot });
    const revision = await store.install({
      entryPath: entry,
      resourceId: 'example/session',
      declaredRole: 'parent',
    });
    const selected = await resolveRequestedDefinition(
      undefined,
      `example/session@sha256:${revision.manifest.logicalRef.revision.digest}`,
      dataRoot,
    );
    const sessionId = await persistEmptyExternalSession(
      stateRoot,
      workspaceRoot,
      'default',
      revision.manifest.logicalRef,
    );

    // Reopening with an explicit revision evaluates that revision.
    await assertStartupError(
      () =>
        createWorkerSession({
          workspaceRoot,
          stateRoot,
          dataRoot,
          persistence: 'session',
          sessionId,
          selection: selected,
          physicalIoMode: 'provider-free',
        }),
      'definition_evaluation_failed',
      'worker_start',
      revision.manifest.logicalRef,
    );
    // Continuing with the stored revision evaluates it.
    await assertStartupError(
      () =>
        createWorkerSession({
          workspaceRoot,
          stateRoot,
          dataRoot,
          persistence: 'continue',
          selection: selected,
          physicalIoMode: 'provider-free',
        }),
      'definition_evaluation_failed',
      'worker_start',
      revision.manifest.logicalRef,
    );

    await writeModule(`${root}/source`, '-next');
    const next = await store.install({
      entryPath: entry,
      resourceId: 'example/session',
      declaredRole: 'parent',
    });
    const nextSelection = await resolveRequestedDefinition(
      undefined,
      `example/session@sha256:${next.manifest.logicalRef.revision.digest}`,
      dataRoot,
    );
    // A differing stored revision is a transition: the currently selected revision is evaluated, not
    // rejected before evaluation.
    await assertStartupError(
      () =>
        createWorkerSession({
          workspaceRoot,
          stateRoot,
          dataRoot,
          persistence: 'session',
          sessionId,
          selection: nextSelection,
          physicalIoMode: 'provider-free',
        }),
      'definition_evaluation_failed',
      'worker_start',
      next.manifest.logicalRef,
    );

    const roleMismatchId = await persistEmptyExternalSession(
      stateRoot,
      workspaceRoot,
      'planner',
      revision.manifest.logicalRef,
    );
    await assertStartupError(
      () =>
        createWorkerSession({
          workspaceRoot,
          stateRoot,
          dataRoot,
          persistence: 'session',
          sessionId: roleMismatchId,
          physicalIoMode: 'provider-free',
        }),
      'definition_role_mismatch',
      'session_binding',
      revision.manifest.logicalRef,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 33 rejects corrupted managed revision content and identity', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-33-resolution-',
  });
  try {
    const dataRoot = `${root}/data`;
    const entry = await writeModule(`${root}/source`);
    const revision = await new ManagedDefinitionStore({ dataRoot }).install({
      entryPath: entry,
      resourceId: 'example/failure',
      declaredRole: 'parent',
    });
    await Deno.writeTextFile(
      `${revision.physicalRoot}/files/dependency.ts`,
      'changed\n',
    );
    await assertStartupError(
      () =>
        resolveRequestedDefinition(
          undefined,
          `example/failure@sha256:${revision.manifest.logicalRef.revision.digest}`,
          dataRoot,
        ),
      'definition_invalid',
      'resolution',
      revision.manifest.logicalRef,
    );

    const apiRevision = await new ManagedDefinitionStore({ dataRoot }).install({
      entryPath: entry,
      resourceId: 'example/api',
      declaredRole: 'parent',
    });
    const manifest = JSON.parse(
      await Deno.readTextFile(`${apiRevision.physicalRoot}/manifest.json`),
    );
    await Deno.writeTextFile(
      `${apiRevision.physicalRoot}/manifest.json`,
      `${
        JSON.stringify({
          ...manifest,
          apiContract: 'henji-agent-definition-v999',
        })
      }\n`,
    );
    await assertStartupError(
      () =>
        resolveRequestedDefinition(
          undefined,
          `example/api@sha256:${apiRevision.manifest.logicalRef.revision.digest}`,
          dataRoot,
        ),
      'definition_invalid',
      'resolution',
      apiRevision.manifest.logicalRef,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 33 runs a managed parent through one commit path and rejects a subagent ref as root', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-33-worker-' });
  const dataRoot = `${root}/data`;
  const stateRoot = `${root}/state`;
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  try {
    for (const role of ['parent'] as const) {
      const sourceRoot = `${root}/source-${role}`;
      const entry = await writeExecutableModule(sourceRoot, role);
      const revision = await new ManagedDefinitionStore({ dataRoot }).install({
        entryPath: entry,
        resourceId: `example/runtime-${role}`,
        declaredRole: role,
      });
      const selection = await resolveRequestedDefinition(
        undefined,
        `example/runtime-${role}@sha256:${revision.manifest.logicalRef.revision.digest}`,
        dataRoot,
      );
      await Deno.remove(sourceRoot, { recursive: true });

      const created = await createWorkerSession({
        workspaceRoot,
        stateRoot,
        dataRoot,
        persistence: 'new',
        selection,
        physicalIoMode: 'provider-free',
      });
      try {
        const outcome = await created.session.submit(`managed ${role} turn`);
        assert(outcome.ok);
        assertEquals(outcome.finalText, `worker answer: managed ${role} turn`);
      } finally {
        await created.close();
      }

      const session = await history.readWorker(created.session.sessionId);
      const execution = history.listExecutionsForSession(
        created.session.sessionId,
      ).at(-1);
      assert(execution !== undefined);
      assertEquals(session.agent, 'default');
      assertEquals(session.definition, revision.manifest.logicalRef);
      assertEquals(
        session.turnExecutions[0]?.definition,
        revision.manifest.logicalRef,
      );
      assertEquals(execution.definition, revision.manifest.logicalRef);
      assertEquals(execution.build, session.turnExecutions[0]?.build);
      assertEquals(execution.sessionCorrelation, created.session.sessionId);
      assertEquals(execution.turn, 1);
    }

    const plannerEntry = await writeExecutableModule(
      `${root}/source-planner`,
      'planner',
    );
    await assertRejectCode(
      () =>
        new ManagedDefinitionStore({ dataRoot }).install({
          entryPath: plannerEntry,
          resourceId: 'example/runtime-planner',
          declaredRole: 'subagent',
          subagentName: 'planner',
        }),
      'module_invalid',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 33 reports closure mismatch and invalid Definition evaluation at Worker start', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-33-worker-failure-',
  });
  const dataRoot = `${root}/data`;
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  try {
    const closureEntry = await writeExecutableModule(
      `${root}/closure`,
      'parent',
    );
    const closureRevision = await new ManagedDefinitionStore({ dataRoot })
      .install({
        entryPath: closureEntry,
        resourceId: 'example/closure-mismatch',
        declaredRole: 'parent',
      });
    const closureSelection = await resolveDefinitionRef(
      closureRevision.manifest.logicalRef,
      dataRoot,
    );
    await Deno.writeTextFile(
      `${closureRevision.physicalRoot}/files/composition.ts`,
      'export const changed = true;\n',
    );
    await assertStartupError(
      () =>
        createWorkerSession({
          workspaceRoot,
          persistence: 'none',
          selection: closureSelection,
          physicalIoMode: 'provider-free',
        }),
      'definition_invalid',
      'worker_start',
      closureRevision.manifest.logicalRef,
    );

    const roleEntry = await writeExecutableModule(`${root}/role`, 'planner');
    const roleRevision = await new ManagedDefinitionStore({ dataRoot }).install(
      {
        entryPath: roleEntry,
        resourceId: 'example/role-mismatch',
        declaredRole: 'parent',
      },
    );
    await assertStartupError(
      async () =>
        await createWorkerSession({
          workspaceRoot,
          persistence: 'none',
          selection: await resolveDefinitionRef(
            roleRevision.manifest.logicalRef,
            dataRoot,
          ),
          physicalIoMode: 'provider-free',
        }),
      'definition_evaluation_failed',
      'worker_start',
      roleRevision.manifest.logicalRef,
    );

    const invalidEntry = await writeModule(`${root}/evaluation`);
    const invalidRevision = await new ManagedDefinitionStore({ dataRoot })
      .install({
        entryPath: invalidEntry,
        resourceId: 'example/evaluation-failure',
        declaredRole: 'parent',
      });
    await assertStartupError(
      async () =>
        await createWorkerSession({
          workspaceRoot,
          persistence: 'none',
          selection: await resolveDefinitionRef(
            invalidRevision.manifest.logicalRef,
            dataRoot,
          ),
          physicalIoMode: 'provider-free',
        }),
      'definition_evaluation_failed',
      'worker_start',
      invalidRevision.manifest.logicalRef,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 33 product fixtures survive source removal, exact revision selection, and Worker restart', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-33-product-',
  });
  const dataRoot = `${root}/data`;
  const stateRoot = `${root}/state`;
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const install = async (
    entry: string,
    id: string,
  ): Promise<{ readonly manifest: ManagedDefinitionManifestV1 }> => {
    let stdout = '';
    const exitCode = await moduleMain(
      ['install', entry, '--id', id, '--role', 'parent'],
      {
        dataRoot,
        writeStdout: (text) => {
          stdout += text;
        },
      },
    );
    assertEquals(exitCode, 0);
    return JSON.parse(stdout);
  };
  try {
    const parentSource = `${root}/parent-source`;
    const parentEntry = await copyFixture('parent', parentSource);
    const parentFirst = await install(parentEntry, 'fixture/parent');
    let inspected = '';
    assertEquals(
      await moduleMain([
        'inspect',
        '--id',
        'fixture/parent',
        '--revision',
        `sha256:${parentFirst.manifest.logicalRef.revision.digest}`,
      ], {
        dataRoot,
        writeStdout: (text) => {
          inspected += text;
        },
      }),
      0,
    );
    assertEquals(
      JSON.parse(inspected).manifest.logicalRef,
      parentFirst.manifest.logicalRef,
    );

    await Deno.writeTextFile(
      `${parentSource}/composition.ts`,
      `${await Deno.readTextFile(
        `${parentSource}/composition.ts`,
      )}\n// second exact revision\n`,
    );
    const parentSecond = await install(parentEntry, 'fixture/parent');
    assert(
      parentSecond.manifest.logicalRef.revision.digest !==
        parentFirst.manifest.logicalRef.revision.digest,
    );
    await Deno.remove(parentSource, { recursive: true });

    const firstSelection = await resolveDefinitionRef(
      parentFirst.manifest.logicalRef,
      dataRoot,
    );
    const first = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot,
      persistence: 'new',
      selection: firstSelection,
      physicalIoMode: 'provider-free',
    });
    const firstSessionId = first.session.sessionId;
    try {
      assert((await first.session.submit('first managed parent process')).ok);
    } finally {
      await first.close();
    }
    const reopened = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot,
      persistence: 'session',
      sessionId: firstSessionId,
      selection: firstSelection,
      physicalIoMode: 'provider-free',
    });
    try {
      assert(
        (await reopened.session.submit('reopened managed parent process')).ok,
      );
      assertEquals(
        reopened.session.definition,
        parentFirst.manifest.logicalRef,
      );
    } finally {
      await reopened.close();
    }

    let runStdout = '';
    assertEquals(
      await runtimeMain([
        '--task',
        'second exact managed parent',
        '--definition-revision',
        `fixture/parent@sha256:${parentSecond.manifest.logicalRef.revision.digest}`,
      ], {
        dataRoot,
        stdinIsTerminal: () => true,
        run: (task, selection) =>
          runHeadlessWorker(task, selection, {
            workspaceRoot,
            physicalIoMode: 'provider-free',
          }),
        writeStdout: (text) => {
          runStdout += text;
        },
      }),
      0,
    );
    assertEquals(runStdout, 'worker answer: second exact managed parent\n');

    const toolSource = `${root}/replacement_read_tool.ts`;
    await Deno.writeTextFile(
      toolSource,
      [
        "import { createAgentResourceIdentity, type ExecutableToolDefinition } from '@henji/agent';",
        'const definition: ExecutableToolDefinition = () => ({',
        "  identity: createAgentResourceIdentity('tool:read'),",
        '  materialize: () => ({',
        "    name: 'read',",
        "    description: 'managed read replacement',",
        "    inputSchema: { type: 'object' },",
        "    execute: () => 'managed Definition replacement result',",
        '  }),',
        '});',
        'export default definition;',
        '',
      ].join('\n'),
    );
    const toolRevision = await new ManagedToolDefinitionStore({ dataRoot })
      .install({
        entryPath: toolSource,
        resourceId: 'fixture/read-tool',
        toolIdentity: 'tool:read',
      });
    const configRoot = `${root}/config`;
    await Deno.mkdir(configRoot, { recursive: true });
    await Deno.writeTextFile(
      `${configRoot}/tools.json`,
      JSON.stringify({
        schemaVersion: 1,
        bindings: {
          'tool:read':
            `fixture/read-tool@sha256:${toolRevision.manifest.logicalRef.revision.digest}`,
        },
      }),
    );
    const events: AgentEvent[] = [];
    const replacementRun = await createWorkerSession({
      workspaceRoot,
      dataRoot,
      configRoot,
      persistence: 'none',
      agent: 'default',
      physicalIoMode: 'provider-free',
      eventSink: (event) => events.push(event),
    });
    try {
      assert(
        (await replacementRun.session.submit('read with managed replacement'))
          .ok,
      );
    } finally {
      await replacementRun.close();
    }
    const replacementResult = events.find((event) => event.kind === 'tool_result');
    assert(replacementResult?.kind === 'tool_result');
    assertEquals(
      replacementResult.result.text,
      'managed Definition replacement result',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
