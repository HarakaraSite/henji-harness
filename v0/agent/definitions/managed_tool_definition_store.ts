import {
  isManagedToolDefinitionCustody,
  isManagedToolDefinitionManifest,
  isToolIdentity,
  type ManagedToolDefinitionCustodyV1,
  type ManagedToolDefinitionManifestV1,
  toolDefinitionFileSha256,
} from './managed_tool_definition_manifest.ts';
import { compareUtf8 } from './managed_definition_manifest.ts';
import { importManagedModule, ManagedDefinitionError } from './managed_definition_importer.ts';
import { validateManagedToolDefinitionRevision } from './managed_tool_definition_revision_validator.ts';
import {
  isExternalToolDefinitionResourceId,
  isToolDefinitionRevisionRef,
  type ToolDefinitionRevisionRef,
} from './managed_resource_ref.ts';
import { buildManifest, HENJI_TOOL_DEFINITION_API_CONTRACT } from '../runtime/build_manifest.ts';
import { createManagedToolDefinitionManifest } from './managed_tool_definition_manifest.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/u;

export interface ManagedToolDefinitionRevision {
  readonly manifest: ManagedToolDefinitionManifestV1;
  readonly custody: ManagedToolDefinitionCustodyV1;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly physicalRoot: string;
  readonly entryPath: string;
}

export interface ManagedToolDefinitionSummary {
  readonly logicalRef: ManagedToolDefinitionManifestV1['logicalRef'];
  readonly toolIdentity: string;
  readonly entry: string;
  readonly apiContract: string;
  readonly fileCount: number;
  readonly originLineage: ManagedToolDefinitionCustodyV1['originLineage'];
  readonly localCustody: ManagedToolDefinitionCustodyV1['localCustody'];
}

export interface ManagedToolDefinitionStoreOptions {
  readonly dataRoot: string;
  readonly now?: () => Date;
}

export interface ManagedToolDefinitionInstallOptions {
  readonly entryPath: string;
  readonly resourceId: string;
  readonly toolIdentity: string;
  readonly moduleRoot?: string;
  readonly now?: () => Date;
}

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;
const isAlreadyExists = (error: unknown): boolean => error instanceof Deno.errors.AlreadyExists;

const storeError = (error: unknown): ManagedDefinitionError =>
  error instanceof ManagedDefinitionError ? error : new ManagedDefinitionError(
    'module_io_failure',
    `Managed tool Definition store I/O failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );

const ensureDirectory = async (path: string): Promise<void> => {
  try {
    await Deno.mkdir(path, { recursive: true, mode: 0o700 });
    await Deno.chmod(path, 0o700);
  } catch (error) {
    throw storeError(error);
  }
};

const resourceDirectoryKey = async (resourceId: string): Promise<string> =>
  await toolDefinitionFileSha256(encoder.encode(resourceId));

export const managedToolDefinitionStoreRoot = (dataRoot: string): string =>
  `${dataRoot}/managed/tool-definition/v1`;

const revisionPath = async (
  root: string,
  resourceId: string,
  digest: string,
): Promise<string> => `${root}/${await resourceDirectoryKey(resourceId)}/${digest}`;

const parentPath = (path: string): string => {
  const separator = path.lastIndexOf('/');
  return separator <= 0 ? '/' : path.slice(0, separator);
};

const writeBytes = async (path: string, bytes: Uint8Array): Promise<void> => {
  await ensureDirectory(parentPath(path));
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(path, { write: true, createNew: true, mode: 0o600 });
    let offset = 0;
    while (offset < bytes.byteLength) offset += await file.write(bytes.subarray(offset));
    await file.sync();
    file.close();
    file = undefined;
    await Deno.chmod(path, 0o600);
  } catch (error) {
    throw storeError(error);
  } finally {
    try {
      file?.close();
    } catch {
      // Preserve the primary store result.
    }
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> =>
  await writeBytes(path, encoder.encode(`${JSON.stringify(value)}\n`));

const readJson = async (path: string): Promise<unknown> => {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch (error) {
    if (isNotFound(error)) {
      throw new ManagedDefinitionError(
        'module_invalid',
        'Managed tool Definition metadata is missing',
      );
    }
    throw storeError(error);
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new ManagedDefinitionError(
      'module_invalid',
      `Managed tool Definition metadata is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const summary = (
  revision: ManagedToolDefinitionRevision,
): ManagedToolDefinitionSummary => ({
  logicalRef: structuredClone(revision.manifest.logicalRef),
  toolIdentity: revision.manifest.toolIdentity,
  entry: revision.manifest.entry,
  apiContract: revision.manifest.apiContract,
  fileCount: revision.manifest.files.length,
  originLineage: structuredClone(revision.custody.originLineage),
  localCustody: structuredClone(revision.custody.localCustody),
});

const readRevisionAt = async (
  path: string,
  expectedResourceId?: string,
  expectedDigest?: string,
): Promise<ManagedToolDefinitionRevision> => {
  try {
    const info = await Deno.lstat(path);
    if (!info.isDirectory) {
      throw new ManagedDefinitionError(
        'module_invalid',
        'Managed tool Definition revision is invalid',
      );
    }
  } catch (error) {
    if (isNotFound(error)) {
      throw new ManagedDefinitionError(
        'module_not_found',
        'Managed tool Definition revision not found',
      );
    }
    if (error instanceof ManagedDefinitionError) throw error;
    throw storeError(error);
  }
  const manifestValue = await readJson(`${path}/manifest.json`);
  const custodyValue = await readJson(`${path}/custody.json`);
  if (
    !isManagedToolDefinitionManifest(manifestValue) ||
    !isManagedToolDefinitionCustody(custodyValue)
  ) {
    throw new ManagedDefinitionError(
      'module_invalid',
      'Managed tool Definition metadata is invalid',
    );
  }
  const manifest = manifestValue;
  const custody = custodyValue;
  if (
    (expectedResourceId !== undefined && manifest.logicalRef.resourceId !== expectedResourceId) ||
    (expectedDigest !== undefined && manifest.logicalRef.revision.digest !== expectedDigest)
  ) {
    throw new ManagedDefinitionError(
      'module_invalid',
      'Managed tool Definition identity does not match custody',
    );
  }
  const sortedPaths = [...manifest.files.map((file) => file.path)].sort(compareUtf8);
  if (sortedPaths.some((value, index) => value !== manifest.files[index].path)) {
    throw new ManagedDefinitionError(
      'module_invalid',
      'Managed tool Definition file order is invalid',
    );
  }
  const files = [];
  for (const descriptor of manifest.files) {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(`${path}/files/${descriptor.path}`);
    } catch (error) {
      if (isNotFound(error)) {
        throw new ManagedDefinitionError(
          'module_invalid',
          'Managed tool Definition closure file is missing',
        );
      }
      throw storeError(error);
    }
    if (
      bytes.byteLength !== descriptor.byteLength ||
      await toolDefinitionFileSha256(bytes) !== descriptor.sha256
    ) {
      throw new ManagedDefinitionError(
        'module_invalid',
        'Managed tool Definition closure file mismatch',
      );
    }
    files.push({ path: descriptor.path, bytes, dependencies: descriptor.dependencies });
  }
  const revisionFiles = new Map(files.map((file) => [file.path, file.bytes] as const));
  await validateManagedToolDefinitionRevision(manifest, revisionFiles);
  return {
    manifest: structuredClone(manifest),
    custody: structuredClone(custody),
    files: revisionFiles,
    physicalRoot: path,
    entryPath: `${path}/files/${manifest.entry}`,
  };
};

export class ManagedToolDefinitionStore {
  readonly root: string;

  constructor(private readonly options: ManagedToolDefinitionStoreOptions) {
    this.root = managedToolDefinitionStoreRoot(options.dataRoot);
  }

  async install(
    options: ManagedToolDefinitionInstallOptions,
  ): Promise<ManagedToolDefinitionRevision> {
    if (!isExternalToolDefinitionResourceId(options.resourceId)) {
      throw new ManagedDefinitionError(
        'module_invalid',
        'Managed tool Definition module ID is invalid',
      );
    }
    if (!isToolIdentity(options.toolIdentity)) {
      throw new ManagedDefinitionError(
        'module_invalid',
        'Managed tool Definition tool identity is invalid',
      );
    }
    const imported = await importManagedModule({
      entryPath: options.entryPath,
      ...(options.moduleRoot === undefined ? {} : { moduleRoot: options.moduleRoot }),
      apiContract: HENJI_TOOL_DEFINITION_API_CONTRACT,
    });
    const manifest = await createManagedToolDefinitionManifest({
      resourceId: options.resourceId,
      toolIdentity: options.toolIdentity,
      apiContract: HENJI_TOOL_DEFINITION_API_CONTRACT,
      entry: imported.entry,
      files: imported.files,
    });
    const custody: ManagedToolDefinitionCustodyV1 = Object.freeze({
      schemaVersion: 1,
      originLineage: Object.freeze({
        kind: 'source',
        entryPath: imported.entryPath,
        moduleRoot: imported.moduleRoot,
      }),
      localCustody: Object.freeze({
        kind: 'installed',
        installedAt: (options.now ?? this.options.now ?? (() => new Date()))().toISOString(),
      }),
    });
    return await this.publish({
      manifest,
      custody,
      files: new Map(imported.files.map((file) => [file.path, file.bytes] as const)),
    });
  }

  private async publish(
    imported: {
      readonly manifest: ManagedToolDefinitionManifestV1;
      readonly custody: ManagedToolDefinitionCustodyV1;
      readonly files: ReadonlyMap<string, Uint8Array>;
    },
  ): Promise<ManagedToolDefinitionRevision> {
    const ref = imported.manifest.logicalRef;
    const target = await revisionPath(this.root, ref.resourceId, ref.revision.digest);
    try {
      return await readRevisionAt(target, ref.resourceId, ref.revision.digest);
    } catch (error) {
      if (!(error instanceof ManagedDefinitionError) || error.code !== 'module_not_found') {
        throw error;
      }
    }
    await ensureDirectory(this.root);
    await ensureDirectory(parentPath(target));
    const staging = `${this.root}/.staging-${crypto.randomUUID().toLowerCase()}`;
    try {
      await ensureDirectory(`${staging}/files`);
      for (const [path, bytes] of imported.files) {
        await writeBytes(`${staging}/files/${path}`, bytes);
      }
      await writeJson(`${staging}/manifest.json`, imported.manifest);
      await writeJson(`${staging}/custody.json`, imported.custody);
      await readRevisionAt(staging, ref.resourceId, ref.revision.digest);
      try {
        await Deno.rename(staging, target);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        return await readRevisionAt(target, ref.resourceId, ref.revision.digest);
      }
      return await readRevisionAt(target, ref.resourceId, ref.revision.digest);
    } catch (error) {
      throw storeError(error);
    } finally {
      try {
        await Deno.remove(staging, { recursive: true });
      } catch {
        // The revision was already published or remains invisible as staging.
      }
    }
  }

  async inspect(resourceId: string, digest: string): Promise<ManagedToolDefinitionRevision> {
    if (!isExternalToolDefinitionResourceId(resourceId) || !SHA256.test(digest)) {
      throw new ManagedDefinitionError(
        'module_invalid',
        'Managed tool Definition selector is invalid',
      );
    }
    const path = await revisionPath(this.root, resourceId, digest);
    return await readRevisionAt(path, resourceId, digest);
  }

  async resolve(ref: ToolDefinitionRevisionRef): Promise<ManagedToolDefinitionRevision> {
    if (!isToolDefinitionRevisionRef(ref) || !isExternalToolDefinitionResourceId(ref.resourceId)) {
      throw new ManagedDefinitionError('module_invalid', 'Managed tool Definition ref is invalid');
    }
    const revision = await this.inspect(ref.resourceId, ref.revision.digest);
    const supported = buildManifest().supportedToolDefinitionApiContracts ??
      [HENJI_TOOL_DEFINITION_API_CONTRACT];
    if (!supported.includes(revision.manifest.apiContract)) {
      throw new ManagedDefinitionError(
        'module_api_unsupported',
        `Managed tool Definition API contract is unsupported: ${revision.manifest.apiContract}`,
      );
    }
    return revision;
  }

  async list(): Promise<readonly ManagedToolDefinitionSummary[]> {
    const revisions: ManagedToolDefinitionSummary[] = [];
    let resources: Deno.DirEntry[];
    try {
      resources = [];
      for await (const entry of Deno.readDir(this.root)) resources.push(entry);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw storeError(error);
    }
    for (const resource of resources) {
      if (resource.name.startsWith('.staging-')) continue;
      if (!resource.isDirectory || !SHA256.test(resource.name)) {
        throw new ManagedDefinitionError(
          'module_invalid',
          'Managed tool Definition store entry is invalid',
        );
      }
      const resourcePath = `${this.root}/${resource.name}`;
      const entries: Deno.DirEntry[] = [];
      try {
        for await (const entry of Deno.readDir(resourcePath)) entries.push(entry);
      } catch (error) {
        throw storeError(error);
      }
      for (const entry of entries) {
        if (!entry.isDirectory || !SHA256.test(entry.name)) {
          throw new ManagedDefinitionError(
            'module_invalid',
            'Managed tool Definition revision entry is invalid',
          );
        }
        const revision = await readRevisionAt(
          `${resourcePath}/${entry.name}`,
          undefined,
          entry.name,
        );
        if (await resourceDirectoryKey(revision.manifest.logicalRef.resourceId) !== resource.name) {
          throw new ManagedDefinitionError(
            'module_invalid',
            'Managed tool Definition resource directory mismatch',
          );
        }
        revisions.push(summary(revision));
      }
    }
    return revisions.sort((left, right) =>
      left.logicalRef.resourceId === right.logicalRef.resourceId
        ? compareUtf8(left.logicalRef.revision.digest, right.logicalRef.revision.digest)
        : compareUtf8(left.logicalRef.resourceId, right.logicalRef.resourceId)
    );
  }

  /** Remove one exact revision from local custody. Active bindings are the caller's concern. */
  async remove(
    resourceId: string,
    digest: string,
  ): Promise<ManagedToolDefinitionManifestV1> {
    if (!isExternalToolDefinitionResourceId(resourceId) || !SHA256.test(digest)) {
      throw new ManagedDefinitionError(
        'module_invalid',
        'Managed tool Definition selector is invalid',
      );
    }
    const revision = await this.inspect(resourceId, digest);
    const path = await revisionPath(this.root, resourceId, digest);
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (isNotFound(error)) {
        throw new ManagedDefinitionError(
          'module_not_found',
          'Managed tool Definition revision not found',
        );
      }
      throw storeError(error);
    }
    return structuredClone(revision.manifest);
  }
}
