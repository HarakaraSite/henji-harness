import { main as moduleMain, parseModuleArgs } from '../../v0/agent/cli/module_cli.ts';
import { resolveRequestedDefinition } from '../../v0/agent/definitions/definition_selection.ts';
import {
  createManagedDefinitionManifest,
  type DefinitionLocalDependencyV1,
} from '../../v0/agent/definitions/managed_definition_manifest.ts';
import { ManagedDefinitionError } from '../../v0/agent/definitions/managed_definition_importer.ts';
import { ManagedDefinitionStore } from '../../v0/agent/definitions/managed_definition_store.ts';
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

const assertThrows = (action: () => unknown): void => {
  try {
    action();
  } catch {
    return;
  }
  throw new Error('expected rejection');
};

const writeModule = async (root: string): Promise<string> => {
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(`${root}/dependency.ts`, "export const label = 'transported';\n");
  await Deno.writeTextFile(
    `${root}/entry.ts`,
    "import type { ExecutableAgentDefinition } from '@henji/agent';\n" +
      "import { label } from './dependency.ts';\n" +
      'const definition = { label } satisfies Partial<ExecutableAgentDefinition>;\n' +
      'export default definition;\n',
  );
  return `${root}/entry.ts`;
};

const fixturePath = (relative: string): string =>
  new URL(`./fixtures/increment_33/${relative}`, import.meta.url).pathname;

const copyExecutableFixture = async (
  role: 'parent' | 'planner',
  destination: string,
): Promise<string> => {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(fixturePath(role))) {
    if (entry.isFile) {
      await Deno.copyFile(fixturePath(`${role}/${entry.name}`), `${destination}/${entry.name}`);
    }
  }
  return `${destination}/entry.ts`;
};

const jsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const transportValue = (bytes: Uint8Array): Record<string, any> =>
  JSON.parse(new TextDecoder().decode(bytes));

Deno.test('Increment 34 transports one exact revision across data roots and retains first custody', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-34-roundtrip-' });
  try {
    const sourceRoot = `${root}/source`;
    const sourceStore = new ManagedDefinitionStore({
      dataRoot: `${root}/xdg-source`,
      now: () => new Date('2026-09-12T01:00:00.000Z'),
    });
    const installed = await sourceStore.install({
      entryPath: await writeModule(sourceRoot),
      resourceId: 'example/transported',
      declaredRole: 'parent',
      moduleRoot: sourceRoot,
    });
    const artifact = await sourceStore.exportTransport(installed.manifest.logicalRef);
    const envelope = transportValue(artifact);
    assertEquals(envelope.schemaVersion, 1);
    assertEquals(envelope.packageKind, 'henji-managed-resource-transport');
    assertEquals(envelope.resourceKind, 'agent-definition');
    assert(!('localCustody' in envelope));
    assert(!('custody' in envelope));

    await Deno.remove(sourceRoot, { recursive: true });
    const targetStore = new ManagedDefinitionStore({
      dataRoot: `${root}/xdg-target`,
      now: () => new Date('2026-09-12T02:00:00.000Z'),
    });
    const artifactPath = `${root}/artifacts/definition.json`;
    const imported = await targetStore.importTransport(artifact, artifactPath);
    assertEquals(imported.manifest, installed.manifest);
    assertEquals(imported.custody.originLineage, installed.custody.originLineage);
    assertEquals(imported.custody.localCustody, {
      kind: 'imported',
      importedAt: '2026-09-12T02:00:00.000Z',
      artifactPath,
    });
    assertEquals((await targetStore.list()).map((item) => item.logicalRef), [
      installed.manifest.logicalRef,
    ]);
    assertEquals(
      (await targetStore.inspect(
        installed.manifest.logicalRef.resourceId,
        installed.manifest.logicalRef.revision.digest,
      )).manifest,
      installed.manifest,
    );

    const laterStore = new ManagedDefinitionStore({
      dataRoot: `${root}/xdg-target`,
      now: () => new Date('2026-09-12T03:00:00.000Z'),
    });
    const duplicate = await laterStore.importTransport(artifact, `${root}/other.json`);
    assertEquals(duplicate.custody.localCustody, imported.custody.localCustody);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 34 module CLI exports and imports one provider-free artifact', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-34-cli-' });
  try {
    const sourceRoot = `${root}/source`;
    const sourceDataRoot = `${root}/source-data`;
    const sourceOutput: string[] = [];
    assertEquals(
      await moduleMain([
        'install',
        await writeModule(sourceRoot),
        '--id',
        'example/cli-transport',
      ], {
        dataRoot: sourceDataRoot,
        writeStdout: (text) => {
          sourceOutput.push(text);
        },
      }),
      0,
    );
    const installed = JSON.parse(sourceOutput.pop()!);
    const selector =
      `${installed.manifest.logicalRef.resourceId}@sha256:${installed.manifest.logicalRef.revision.digest}`;
    const artifactPath = `${root}/definition.json`;
    assertEquals(
      await moduleMain(['export', selector, '--output', artifactPath], {
        dataRoot: sourceDataRoot,
        writeStdout: (text) => {
          sourceOutput.push(text);
        },
      }),
      0,
    );
    const exported = JSON.parse(sourceOutput.pop()!);
    assert(exported.ok);
    assertEquals(exported.operation, 'export');
    assertEquals(exported.artifact.path, artifactPath);
    assertEquals(exported.manifest, installed.manifest);
    assertEquals((await Deno.readFile(artifactPath)).byteLength, exported.artifact.byteLength);

    await Deno.remove(sourceRoot, { recursive: true });
    const targetOutput: string[] = [];
    const targetDataRoot = `${root}/target-data`;
    assertEquals(
      await moduleMain(['import', artifactPath], {
        dataRoot: targetDataRoot,
        now: () => new Date('2026-09-12T04:00:00.000Z'),
        writeStdout: (text) => {
          targetOutput.push(text);
        },
      }),
      0,
    );
    const imported = JSON.parse(targetOutput.pop()!);
    assert(imported.ok);
    assertEquals(imported.operation, 'import');
    assertEquals(imported.manifest, installed.manifest);
    assertEquals(imported.originLineage, installed.originLineage);
    assertEquals(imported.localCustody, {
      kind: 'imported',
      importedAt: '2026-09-12T04:00:00.000Z',
      artifactPath,
    });
    assertEquals(
      await moduleMain(['list'], {
        dataRoot: targetDataRoot,
        writeStdout: (text) => {
          targetOutput.push(text);
        },
      }),
      0,
    );
    assertEquals(
      JSON.parse(targetOutput.pop()!).modules[0].logicalRef,
      installed.manifest.logicalRef,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 34 transported parent executes from the same exact refs without source', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-34-product-' });
  const sourceDataRoot = `${root}/source-data`;
  const targetDataRoot = `${root}/target-data`;
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  try {
    for (const role of ['parent'] as const) {
      const sourceRoot = `${root}/source-${role}`;
      const output: string[] = [];
      assertEquals(
        await moduleMain([
          'install',
          await copyExecutableFixture(role, sourceRoot),
          '--id',
          `transport/${role}`,
          '--role',
          role,
        ], {
          dataRoot: sourceDataRoot,
          writeStdout: (text) => {
            output.push(text);
          },
        }),
        0,
      );
      const installed = JSON.parse(output.pop()!);
      const selector =
        `${installed.manifest.logicalRef.resourceId}@sha256:${installed.manifest.logicalRef.revision.digest}`;
      const artifactPath = `${root}/${role}.json`;
      assertEquals(
        await moduleMain(['export', selector, '--output', artifactPath], {
          dataRoot: sourceDataRoot,
          writeStdout: (text) => {
            output.push(text);
          },
        }),
        0,
      );
      output.pop();
      await Deno.remove(sourceRoot, { recursive: true });
      assertEquals(
        await moduleMain(['import', artifactPath], {
          dataRoot: targetDataRoot,
          writeStdout: (text) => {
            output.push(text);
          },
        }),
        0,
      );
      const imported = JSON.parse(output.pop()!);
      assertEquals(imported.manifest.logicalRef, installed.manifest.logicalRef);

      const selection = await resolveRequestedDefinition(undefined, selector, targetDataRoot);
      const created = await createWorkerSession({
        workspaceRoot,
        stateRoot,
        dataRoot: targetDataRoot,
        persistence: 'new',
        selection,
        physicalIoMode: 'provider-free',
      });
      try {
        const outcome = await created.session.submit(`transported ${role} turn`);
        assert(outcome.ok);
        assertEquals(outcome.finalText, `worker answer: transported ${role} turn`);
      } finally {
        await created.close();
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 34 module CLI preserves outputs and reports artifact failures with identity', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-34-cli-failure-' });
  try {
    const sourceRoot = `${root}/source`;
    const dataRoot = `${root}/data`;
    const revision = await new ManagedDefinitionStore({ dataRoot }).install({
      entryPath: await writeModule(sourceRoot),
      resourceId: 'example/cli-failure',
      declaredRole: 'parent',
    });
    const selector =
      `${revision.manifest.logicalRef.resourceId}@sha256:${revision.manifest.logicalRef.revision.digest}`;
    assertEquals(parseModuleArgs(['export', selector, '--output', `${root}/out.json`]), {
      kind: 'export',
      definition: revision.manifest.logicalRef,
      outputPath: `${root}/out.json`,
    });
    assertEquals(parseModuleArgs(['import', `${root}/out.json`]), {
      kind: 'import',
      artifactPath: `${root}/out.json`,
    });
    assertThrows(() => parseModuleArgs(['export', 'example/cli-failure', '--output', 'out.json']));
    assertThrows(() => parseModuleArgs(['export', selector]));
    assertThrows(() => parseModuleArgs(['import']));

    const existingPath = `${root}/existing.json`;
    await Deno.writeTextFile(existingPath, 'keep\n');
    const exportErrors: string[] = [];
    assertEquals(
      await moduleMain(['export', selector, '--output', existingPath], {
        dataRoot,
        writeStderr: (text) => {
          exportErrors.push(text);
        },
      }),
      1,
    );
    const exportError = JSON.parse(exportErrors.pop()!);
    assertEquals(exportError.error.code, 'module_artifact_exists');
    assertEquals(exportError.error.definition, revision.manifest.logicalRef);
    assertEquals(await Deno.readTextFile(existingPath), 'keep\n');

    const missingErrors: string[] = [];
    assertEquals(
      await moduleMain(['import', `${root}/missing.json`], {
        dataRoot: `${root}/missing-target`,
        writeStderr: (text) => {
          missingErrors.push(text);
        },
      }),
      1,
    );
    assertEquals(JSON.parse(missingErrors.pop()!).error.code, 'module_artifact_not_found');

    const artifact = transportValue(
      await new ManagedDefinitionStore({ dataRoot }).exportTransport(
        revision.manifest.logicalRef,
      ),
    );
    artifact.files[0].bytesBase64 = '*';
    const invalidPath = `${root}/invalid.json`;
    await Deno.writeFile(invalidPath, jsonBytes(artifact));
    const importErrors: string[] = [];
    const invalidTarget = `${root}/invalid-target`;
    assertEquals(
      await moduleMain(['import', invalidPath], {
        dataRoot: invalidTarget,
        writeStderr: (text) => {
          importErrors.push(text);
        },
      }),
      1,
    );
    const importError = JSON.parse(importErrors.pop()!);
    assertEquals(importError.error.code, 'module_invalid');
    assertEquals(importError.error.definition, revision.manifest.logicalRef);
    assertEquals(await new ManagedDefinitionStore({ dataRoot: invalidTarget }).list(), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 34 rejects transport tampering before publishing a revision', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-34-tampering-' });
  try {
    const sourceRoot = `${root}/source`;
    const sourceStore = new ManagedDefinitionStore({ dataRoot: `${root}/source-data` });
    const installed = await sourceStore.install({
      entryPath: await writeModule(sourceRoot),
      resourceId: 'example/tampering',
      declaredRole: 'parent',
      moduleRoot: sourceRoot,
    });
    const artifact = await sourceStore.exportTransport(installed.manifest.logicalRef);
    const cases: readonly [string, (value: Record<string, any>) => void][] = [
      ['base64', (value) => value.files[0].bytesBase64 = '*'],
      ['file hash', (value) => value.manifest.files[0].sha256 = '0'.repeat(64)],
      [
        'dependency lineage',
        (value) => {
          const entry = value.manifest.files.find((file: Record<string, any>) =>
            file.path === value.manifest.entry
          );
          entry.dependencies[0].specifier = '@henji/different';
        },
      ],
      ['revision digest', (value) => value.manifest.logicalRef.revision.digest = '0'.repeat(64)],
    ];
    for (const [name, mutate] of cases) {
      const value = transportValue(artifact);
      mutate(value);
      const targetStore = new ManagedDefinitionStore({ dataRoot: `${root}/target-${name}` });
      await assertRejectCode(
        () => targetStore.importTransport(jsonBytes(value), `${root}/${name}.json`),
        'module_invalid',
      );
      assertEquals(await targetStore.list(), []);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 34 keeps incompatible revisions inspectable and rejects only resolution', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-34-api-' });
  try {
    const sourceRoot = `${root}/source`;
    const sourceStore = new ManagedDefinitionStore({ dataRoot: `${root}/source-data` });
    const installed = await sourceStore.install({
      entryPath: await writeModule(sourceRoot),
      resourceId: 'example/future-api',
      declaredRole: 'subagent',
      subagentName: 'planner',
      moduleRoot: sourceRoot,
    });
    const value = transportValue(await sourceStore.exportTransport(installed.manifest.logicalRef));
    const apiContract = 'henji-agent-definition-v999';
    const files = value.manifest.files.map((descriptor: Record<string, any>, index: number) => ({
      path: descriptor.path,
      bytes: Uint8Array.fromBase64(value.files[index].bytesBase64),
      dependencies: descriptor.dependencies.map((dependency: DefinitionLocalDependencyV1) =>
        dependency.target.kind === 'embedded-api'
          ? { ...dependency, target: { ...dependency.target, contract: apiContract } }
          : dependency
      ),
    }));
    value.manifest = await createManagedDefinitionManifest({
      resourceId: installed.manifest.logicalRef.resourceId,
      declaredRole: installed.manifest.declaredRole,
      ...(installed.manifest.subagentName === undefined
        ? {}
        : { subagentName: installed.manifest.subagentName }),
      apiContract,
      entry: installed.manifest.entry,
      files,
    });

    const targetStore = new ManagedDefinitionStore({ dataRoot: `${root}/target-data` });
    const imported = await targetStore.importTransport(jsonBytes(value), `${root}/future.json`);
    assertEquals(imported.manifest.apiContract, apiContract);
    assertEquals((await targetStore.list())[0].apiContract, apiContract);
    assertEquals(
      (await targetStore.inspect(
        imported.manifest.logicalRef.resourceId,
        imported.manifest.logicalRef.revision.digest,
      )).manifest.logicalRef,
      imported.manifest.logicalRef,
    );
    const reexported = transportValue(
      await targetStore.exportTransport(imported.manifest.logicalRef),
    );
    assertEquals(reexported.manifest, imported.manifest);
    await assertRejectCode(
      () => targetStore.resolve(imported.manifest.logicalRef),
      'module_api_unsupported',
    );
    try {
      await resolveRequestedDefinition(
        undefined,
        `${imported.manifest.logicalRef.resourceId}@sha256:${imported.manifest.logicalRef.revision.digest}`,
        `${root}/target-data`,
      );
      throw new Error('expected definition_api_unsupported');
    } catch (error) {
      assert(error instanceof Error && 'code' in error);
      assertEquals(error.code, 'definition_api_unsupported');
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
