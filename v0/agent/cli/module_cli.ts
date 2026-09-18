import {
  ManagedDefinitionError,
  type ManagedDefinitionErrorCode,
} from '../definitions/managed_definition_importer.ts';
import {
  type ManagedDefinitionRevision,
  ManagedDefinitionStore,
} from '../definitions/managed_definition_store.ts';
import { parseDefinitionRevisionSelector } from '../definitions/definition_selection.ts';
import { isSubagentName } from '../definitions/managed_definition_manifest.ts';
import type { DefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const encoder = new TextEncoder();
const FULL_REVISION = /^sha256:([0-9a-f]{64})$/u;

const ERROR_MESSAGES: Readonly<Record<ManagedDefinitionErrorCode | 'invalid_invocation', string>> =
  {
    invalid_invocation: 'invalid invocation',
    module_not_found: 'managed Definition revision not found',
    module_invalid: 'managed Definition revision invalid',
    module_api_unsupported: 'managed Definition API contract is unsupported',
    module_io_failure: 'managed Definition I/O failure',
    module_import_unsupported: 'Definition import is not supported',
    module_artifact_not_found: 'Definition transport artifact not found',
    module_artifact_exists: 'Definition transport output already exists',
    module_artifact_io_failure: 'Definition transport artifact I/O failure',
  };

export type ModuleCliCommand =
  | {
    readonly kind: 'install';
    readonly entryPath: string;
    readonly resourceId: string;
    readonly declaredRole: 'parent' | 'subagent';
    readonly subagentName?: string;
    readonly moduleRoot?: string;
  }
  | { readonly kind: 'list' }
  | { readonly kind: 'inspect'; readonly resourceId: string; readonly digest: string }
  | {
    readonly kind: 'export';
    readonly definition: DefinitionRevisionRef;
    readonly outputPath: string;
  }
  | { readonly kind: 'import'; readonly artifactPath: string };

export class ModuleCliInvocationError extends Error {
  constructor() {
    super('invalid invocation');
    this.name = 'ModuleCliInvocationError';
  }
}

const parsePairs = (
  args: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  if (args.length % 2 !== 0) throw new ModuleCliInvocationError();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || values.has(flag) || value.length === 0) {
      throw new ModuleCliInvocationError();
    }
    values.set(flag, value);
  }
  return values;
};

export const parseModuleArgs = (args: readonly string[]): ModuleCliCommand => {
  if (args.length === 1 && args[0] === 'list') return { kind: 'list' };
  if (args[0] === 'export' && args.length === 4 && args[2] === '--output') {
    if (args[3].length === 0) throw new ModuleCliInvocationError();
    try {
      return {
        kind: 'export',
        definition: parseDefinitionRevisionSelector(args[1]),
        outputPath: args[3],
      };
    } catch {
      throw new ModuleCliInvocationError();
    }
  }
  if (args[0] === 'import' && args.length === 2 && args[1].length > 0) {
    return { kind: 'import', artifactPath: args[1] };
  }
  if (args[0] === 'install' && args.length >= 4) {
    const entryPath = args[1];
    if (entryPath.length === 0) throw new ModuleCliInvocationError();
    const values = parsePairs(
      args.slice(2),
      new Set(['--id', '--role', '--subagent-name', '--root']),
    );
    const resourceId = values.get('--id');
    const rawRole = values.get('--role') ?? 'parent';
    const rawSubagentName = values.get('--subagent-name');
    if (resourceId === undefined || (rawRole !== 'parent' && rawRole !== 'subagent')) {
      throw new ModuleCliInvocationError();
    }
    if (
      (rawRole === 'parent' && rawSubagentName !== undefined) ||
      (rawRole === 'subagent' && !isSubagentName(rawSubagentName))
    ) {
      throw new ModuleCliInvocationError();
    }
    return {
      kind: 'install',
      entryPath,
      resourceId,
      declaredRole: rawRole,
      ...(rawSubagentName === undefined ? {} : { subagentName: rawSubagentName }),
      ...(values.get('--root') === undefined ? {} : { moduleRoot: values.get('--root') }),
    };
  }
  if (args[0] === 'inspect' && args.length === 5) {
    const values = parsePairs(args.slice(1), new Set(['--id', '--revision']));
    const resourceId = values.get('--id');
    const revision = values.get('--revision');
    const matched = revision === undefined ? undefined : FULL_REVISION.exec(revision);
    if (resourceId === undefined || matched === undefined || matched === null) {
      throw new ModuleCliInvocationError();
    }
    return { kind: 'inspect', resourceId, digest: matched[1] };
  }
  throw new ModuleCliInvocationError();
};

export interface ModuleCliDependencies {
  readonly dataRoot?: string;
  readonly now?: () => Date;
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
}

const write = async (
  writer: ((text: string) => void | PromiseLike<void>) | undefined,
  stream: typeof Deno.stdout | typeof Deno.stderr,
  value: unknown,
): Promise<void> => {
  const text = `${JSON.stringify(value)}\n`;
  if (writer !== undefined) await writer(text);
  else await stream.write(encoder.encode(text));
};

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;
const isAlreadyExists = (error: unknown): boolean => error instanceof Deno.errors.AlreadyExists;

const artifactError = (
  code: 'module_artifact_not_found' | 'module_artifact_exists' | 'module_artifact_io_failure',
  message: string,
): ManagedDefinitionError => new ManagedDefinitionError(code, message);

const pathParts = (path: string): { readonly parent: string; readonly name: string } => {
  const separator = path.lastIndexOf('/');
  const parent = separator < 0 ? '.' : separator === 0 ? '/' : path.slice(0, separator);
  const name = separator < 0 ? path : path.slice(separator + 1);
  if (name.length === 0 || name === '.' || name === '..') {
    throw artifactError('module_artifact_io_failure', 'Artifact output path is not a file path');
  }
  return { parent, name };
};

const absoluteOutputPath = async (path: string): Promise<string> => {
  const parts = pathParts(path);
  try {
    const parent = await Deno.realPath(parts.parent);
    return parent === '/' ? `/${parts.name}` : `${parent}/${parts.name}`;
  } catch (error) {
    throw artifactError(
      'module_artifact_io_failure',
      `Artifact output directory could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const writeArtifactAtomic = async (
  outputPath: string,
  bytes: Uint8Array,
): Promise<string> => {
  const target = await absoluteOutputPath(outputPath);
  const parts = pathParts(target);
  const staging = `${parts.parent}/.${parts.name}.staging-${crypto.randomUUID().toLowerCase()}`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(staging, { write: true, createNew: true, mode: 0o600 });
    let offset = 0;
    while (offset < bytes.byteLength) offset += await file.write(bytes.subarray(offset));
    await file.sync();
    file.close();
    file = undefined;
    const readback = await Deno.readFile(staging);
    if (!sameBytes(readback, bytes)) {
      throw artifactError(
        'module_artifact_io_failure',
        'Artifact temporary file readback did not match export bytes',
      );
    }
    try {
      await Deno.link(staging, target);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw artifactError(
          'module_artifact_exists',
          `Definition transport output already exists: ${target}`,
        );
      }
      throw error;
    }
    return target;
  } catch (error) {
    if (error instanceof ManagedDefinitionError) throw error;
    throw artifactError(
      'module_artifact_io_failure',
      `Definition transport output could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    try {
      file?.close();
    } catch {
      // Preserve the primary artifact result.
    }
    try {
      await Deno.remove(staging);
    } catch (error) {
      if (!isNotFound(error)) {
        // A successfully linked target remains the complete artifact.
      }
    }
  }
};

const readArtifact = async (
  artifactPath: string,
): Promise<{ readonly path: string; readonly bytes: Uint8Array }> => {
  let path: string;
  try {
    path = await Deno.realPath(artifactPath);
  } catch (error) {
    if (isNotFound(error)) {
      throw artifactError(
        'module_artifact_not_found',
        `Definition transport artifact not found: ${artifactPath}`,
      );
    }
    throw artifactError(
      'module_artifact_io_failure',
      `Definition transport artifact path could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile) {
      throw artifactError(
        'module_artifact_io_failure',
        `Definition transport artifact is not a file: ${path}`,
      );
    }
    return { path, bytes: await Deno.readFile(path) };
  } catch (error) {
    if (error instanceof ManagedDefinitionError) throw error;
    if (isNotFound(error)) {
      throw artifactError(
        'module_artifact_not_found',
        `Definition transport artifact not found: ${path}`,
      );
    }
    throw artifactError(
      'module_artifact_io_failure',
      `Definition transport artifact could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const detail = (revision: ManagedDefinitionRevision) => ({
  schemaVersion: 1,
  manifest: revision.manifest,
  originLineage: revision.custody.originLineage,
  localCustody: revision.custody.localCustody,
  physicalStore: {
    root: revision.physicalRoot,
    entry: revision.entryPath,
  },
});

const errorPayload = (
  code: ManagedDefinitionErrorCode | 'invalid_invocation',
  message?: string,
  definition?: DefinitionRevisionRef,
) => ({
  ok: false,
  error: {
    code,
    message: message ?? ERROR_MESSAGES[code],
    ...(definition === undefined ? {} : { definition: structuredClone(definition) }),
  },
});

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: ModuleCliDependencies = {},
): Promise<number> => {
  let command: ModuleCliCommand;
  try {
    command = parseModuleArgs(args);
  } catch {
    await write(
      dependencies.writeStderr,
      Deno.stderr,
      errorPayload('invalid_invocation'),
    );
    return 1;
  }
  try {
    const store = new ManagedDefinitionStore({
      dataRoot: dependencies.dataRoot ?? resolveRuntimePaths().dataRoot,
      now: dependencies.now,
    });
    if (command.kind === 'install') {
      const revision = await store.install({
        entryPath: command.entryPath,
        resourceId: command.resourceId,
        declaredRole: command.declaredRole,
        ...(command.subagentName === undefined ? {} : { subagentName: command.subagentName }),
        ...(command.moduleRoot === undefined ? {} : { moduleRoot: command.moduleRoot }),
      });
      await write(dependencies.writeStdout, Deno.stdout, { ok: true, ...detail(revision) });
    } else if (command.kind === 'list') {
      await write(dependencies.writeStdout, Deno.stdout, {
        schemaVersion: 1,
        modules: await store.list(),
      });
    } else if (command.kind === 'inspect') {
      const revision = await store.inspect(command.resourceId, command.digest);
      await write(dependencies.writeStdout, Deno.stdout, detail(revision));
    } else if (command.kind === 'export') {
      const revision = await store.inspect(
        command.definition.resourceId,
        command.definition.revision.digest,
      );
      const bytes = await store.exportTransport(command.definition);
      const path = await writeArtifactAtomic(command.outputPath, bytes);
      await write(dependencies.writeStdout, Deno.stdout, {
        ok: true,
        operation: 'export',
        artifact: { path, byteLength: bytes.byteLength },
        ...detail(revision),
      });
    } else {
      const artifact = await readArtifact(command.artifactPath);
      const revision = await store.importTransport(artifact.bytes, artifact.path);
      await write(dependencies.writeStdout, Deno.stdout, {
        ok: true,
        operation: 'import',
        artifact: { path: artifact.path, byteLength: artifact.bytes.byteLength },
        ...detail(revision),
      });
    }
    return 0;
  } catch (error) {
    const code = error instanceof ManagedDefinitionError ? error.code : 'module_io_failure';
    const message = error instanceof ManagedDefinitionError ? error.message : ERROR_MESSAGES[code];
    const definition = error instanceof ManagedDefinitionError && error.definition !== undefined
      ? error.definition
      : command.kind === 'export'
      ? command.definition
      : undefined;
    await write(
      dependencies.writeStderr,
      Deno.stderr,
      errorPayload(code, message, definition),
    );
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
