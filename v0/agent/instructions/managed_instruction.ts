import {
  type HenjiInstructionRevisionRef,
  isExternalHenjiInstructionResourceId,
  isHenjiInstructionRevisionRef,
} from '../definitions/managed_resource_ref.ts';
import { HENJI_COMMON_INSTRUCTION } from './henji_common.ts';

export const HENJI_INSTRUCTION_API_CONTRACT = 'henji-instruction-v1' as const;
export const HENJI_BASE_INSTRUCTION_SLOT = 'instruction:henji-base' as const;
export const HENJI_INSTRUCTION_FORMAT = 'text/markdown' as const;
export const HENJI_INSTRUCTION_ENTRY = 'instruction.md' as const;

const BUILTIN_REVISION_DIGEST = 'b7604faeb75d9e2189e9dd4f264deb339deec36a2f61ef239440d366fbed67db';
const BUILTIN_CONTENT_DIGEST = 'afdc5bbcf34dd01f601c130f884b9bec8de0ed0bdcee0130a398cda64a9eee08';
const SHA256 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface HenjiInstructionMetadataV1 {
  readonly title: string;
  readonly description: string;
}

export interface HenjiInstructionAuthoringManifestV1 {
  readonly schemaVersion: 1;
  readonly resourceKind: 'henji-instruction';
  readonly resourceId: string;
  readonly slot: typeof HENJI_BASE_INSTRUCTION_SLOT;
  readonly apiContract: typeof HENJI_INSTRUCTION_API_CONTRACT;
  readonly format: typeof HENJI_INSTRUCTION_FORMAT;
  readonly entry: typeof HENJI_INSTRUCTION_ENTRY;
  readonly metadata: HenjiInstructionMetadataV1;
}

export interface ManagedHenjiInstructionManifestV1 {
  readonly schemaVersion: 1;
  readonly logicalRef: HenjiInstructionRevisionRef;
  readonly slot: typeof HENJI_BASE_INSTRUCTION_SLOT;
  readonly apiContract: typeof HENJI_INSTRUCTION_API_CONTRACT;
  readonly format: typeof HENJI_INSTRUCTION_FORMAT;
  readonly entry: typeof HENJI_INSTRUCTION_ENTRY;
  readonly metadata: HenjiInstructionMetadataV1;
  readonly content: {
    readonly byteLength: number;
    readonly sha256: string;
  };
}

export interface ManagedHenjiInstructionCustodyV1 {
  readonly schemaVersion: 1;
  readonly originLineage: {
    readonly kind: 'source';
    readonly directoryPath: string;
  };
  readonly localCustody: {
    readonly kind: 'installed';
    readonly installedAt: string;
  };
}

export interface ManagedHenjiInstructionRevision {
  readonly manifest: ManagedHenjiInstructionManifestV1;
  readonly custody: ManagedHenjiInstructionCustodyV1;
  readonly contentBytes: Uint8Array;
  readonly content: string;
  readonly physicalRoot: string;
  readonly entryPath: string;
}

export interface SelectedHenjiBaseInstruction {
  readonly schemaVersion: 1;
  readonly slot: typeof HENJI_BASE_INSTRUCTION_SLOT;
  readonly selectionSource: 'built-in' | 'external';
  readonly ref: HenjiInstructionRevisionRef;
  readonly contentDigest: string;
  readonly content: string;
  readonly bytesBase64: string;
}

export type HenjiInstructionErrorCode =
  | 'instruction_not_found'
  | 'instruction_invalid'
  | 'instruction_api_unsupported'
  | 'instruction_io_failure'
  | 'instruction_binding_invalid'
  | 'instruction_active';

export class HenjiInstructionError extends Error {
  constructor(
    readonly code: HenjiInstructionErrorCode,
    message: string,
    readonly instruction?: HenjiInstructionRevisionRef,
  ) {
    super(message);
    this.name = 'HenjiInstructionError';
  }
}

export const henjiInstructionErrorValue = (error: HenjiInstructionError) => ({
  code: error.code,
  message: error.message,
  ...(error.instruction === undefined ? {} : { instruction: structuredClone(error.instruction) }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
};

const validText = (value: unknown, allowEmpty = false): value is string =>
  typeof value === 'string' && !value.includes('\0') &&
  (allowEmpty || value.length > 0);

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        bytes.slice().buffer as ArrayBuffer,
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const u64 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
};

const canonicalRevisionBytes = (
  manifest: HenjiInstructionAuthoringManifestV1,
  contentBytes: Uint8Array,
): Uint8Array => {
  const values: readonly (string | Uint8Array)[] = [
    'henji-instruction-revision-v1',
    manifest.resourceKind,
    manifest.resourceId,
    manifest.slot,
    manifest.apiContract,
    manifest.format,
    manifest.entry,
    manifest.metadata.title,
    manifest.metadata.description,
    contentBytes,
  ];
  const chunks = values.flatMap((value) => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    return [u64(bytes.byteLength), bytes];
  });
  const length = chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const bytes of chunks) {
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return output;
};

const decodeInstruction = (bytes: Uint8Array): string => {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new HenjiInstructionError(
      'instruction_invalid',
      'Henji Instruction content is not valid UTF-8',
    );
  }
  if (
    text.includes('\0') || text.trim().length === 0 ||
    !sameBytes(encoder.encode(text), bytes)
  ) {
    throw new HenjiInstructionError(
      'instruction_invalid',
      'Henji Instruction content is invalid',
    );
  }
  return text;
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);

export const builtinHenjiBaseInstruction = (): SelectedHenjiBaseInstruction => ({
  schemaVersion: 1,
  slot: HENJI_BASE_INSTRUCTION_SLOT,
  selectionSource: 'built-in',
  ref: {
    schemaVersion: 1,
    resourceKind: 'henji-instruction',
    resourceId: 'builtin/henji-base',
    revision: { algorithm: 'sha256', digest: BUILTIN_REVISION_DIGEST },
  },
  contentDigest: `sha256:${BUILTIN_CONTENT_DIGEST}`,
  content: HENJI_COMMON_INSTRUCTION,
  bytesBase64: encoder.encode(HENJI_COMMON_INSTRUCTION).toBase64(),
});

export const validateSelectedHenjiBaseInstruction = (
  value: unknown,
): value is SelectedHenjiBaseInstruction => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'slot',
      'selectionSource',
      'ref',
      'contentDigest',
      'content',
      'bytesBase64',
    ]) || value.schemaVersion !== 1 ||
    value.slot !== HENJI_BASE_INSTRUCTION_SLOT ||
    (value.selectionSource !== 'built-in' &&
      value.selectionSource !== 'external') ||
    !isHenjiInstructionRevisionRef(value.ref) ||
    typeof value.contentDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.contentDigest) ||
    !validText(value.content) || typeof value.bytesBase64 !== 'string'
  ) return false;
  if (
    (value.selectionSource === 'built-in') !==
      (value.ref.resourceId === 'builtin/henji-base')
  ) return false;
  try {
    const bytes = Uint8Array.fromBase64(value.bytesBase64);
    return sameBytes(bytes, encoder.encode(value.content));
  } catch {
    return false;
  }
};

export const verifySelectedHenjiBaseInstruction = async (
  value: unknown,
): Promise<boolean> => {
  if (!validateSelectedHenjiBaseInstruction(value)) return false;
  const bytes = Uint8Array.fromBase64(value.bytesBase64);
  if (value.contentDigest !== `sha256:${await sha256Hex(bytes)}`) return false;
  return value.selectionSource !== 'built-in' ||
    value.ref.revision.digest === BUILTIN_REVISION_DIGEST;
};

const validateAuthoringManifest = (
  value: unknown,
): HenjiInstructionAuthoringManifestV1 => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'resourceKind',
      'resourceId',
      'slot',
      'apiContract',
      'format',
      'entry',
      'metadata',
    ]) || value.schemaVersion !== 1 ||
    value.resourceKind !== 'henji-instruction' ||
    !isExternalHenjiInstructionResourceId(value.resourceId) ||
    value.slot !== HENJI_BASE_INSTRUCTION_SLOT ||
    value.apiContract !== HENJI_INSTRUCTION_API_CONTRACT ||
    value.format !== HENJI_INSTRUCTION_FORMAT ||
    value.entry !== HENJI_INSTRUCTION_ENTRY ||
    !isRecord(value.metadata) ||
    !exactKeys(value.metadata, ['title', 'description']) ||
    !validText(value.metadata.title) ||
    !validText(value.metadata.description, true)
  ) {
    throw new HenjiInstructionError(
      'instruction_invalid',
      'Henji Instruction authoring manifest is invalid',
    );
  }
  return structuredClone(
    value,
  ) as unknown as HenjiInstructionAuthoringManifestV1;
};

const isManagedManifest = (
  value: unknown,
): value is ManagedHenjiInstructionManifestV1 =>
  isRecord(value) &&
  exactKeys(value, [
    'schemaVersion',
    'logicalRef',
    'slot',
    'apiContract',
    'format',
    'entry',
    'metadata',
    'content',
  ]) && value.schemaVersion === 1 &&
  isHenjiInstructionRevisionRef(value.logicalRef) &&
  isExternalHenjiInstructionResourceId(value.logicalRef.resourceId) &&
  value.slot === HENJI_BASE_INSTRUCTION_SLOT &&
  value.apiContract === HENJI_INSTRUCTION_API_CONTRACT &&
  value.format === HENJI_INSTRUCTION_FORMAT &&
  value.entry === HENJI_INSTRUCTION_ENTRY &&
  isRecord(value.metadata) &&
  exactKeys(value.metadata, ['title', 'description']) &&
  validText(value.metadata.title) &&
  validText(value.metadata.description, true) &&
  isRecord(value.content) &&
  exactKeys(value.content, ['byteLength', 'sha256']) &&
  Number.isSafeInteger(value.content.byteLength) &&
  Number(value.content.byteLength) > 0 &&
  typeof value.content.sha256 === 'string' && SHA256.test(value.content.sha256);

const isCustody = (value: unknown): value is ManagedHenjiInstructionCustodyV1 =>
  isRecord(value) &&
  exactKeys(value, ['schemaVersion', 'originLineage', 'localCustody']) &&
  value.schemaVersion === 1 && isRecord(value.originLineage) &&
  exactKeys(value.originLineage, ['kind', 'directoryPath']) &&
  value.originLineage.kind === 'source' &&
  typeof value.originLineage.directoryPath === 'string' &&
  value.originLineage.directoryPath.startsWith('/') &&
  isRecord(value.localCustody) &&
  exactKeys(value.localCustody, ['kind', 'installedAt']) &&
  value.localCustody.kind === 'installed' &&
  typeof value.localCustody.installedAt === 'string' &&
  !Number.isNaN(Date.parse(value.localCustody.installedAt));

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;
const isAlreadyExists = (error: unknown): boolean => error instanceof Deno.errors.AlreadyExists;
const parentPath = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

const ioError = (message: string, error: unknown): HenjiInstructionError =>
  error instanceof HenjiInstructionError ? error : new HenjiInstructionError(
    'instruction_io_failure',
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
  );

const ensureDirectory = async (path: string): Promise<void> => {
  try {
    await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw ioError('Henji Instruction directory could not be created', error);
  }
};

const writeBytes = async (path: string, bytes: Uint8Array): Promise<void> => {
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(path, { createNew: true, write: true, mode: 0o600 });
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
    file.close();
    file = undefined;
  } catch (error) {
    throw ioError('Henji Instruction file could not be written', error);
  } finally {
    try {
      file?.close();
    } catch {
      // Preserve the primary operation result.
    }
  }
};

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeBytes(path, encoder.encode(`${JSON.stringify(value)}\n`));

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(decoder.decode(await Deno.readFile(path)));
  } catch (error) {
    if (isNotFound(error)) {
      throw new HenjiInstructionError(
        'instruction_not_found',
        'Henji Instruction file not found',
      );
    }
    throw ioError('Henji Instruction JSON could not be read', error);
  }
};

const resourceDirectoryKey = (resourceId: string): Promise<string> =>
  sha256Hex(encoder.encode(resourceId));

export const managedHenjiInstructionStoreRoot = (dataRoot: string): string =>
  `${dataRoot}/managed/henji-instruction/v1`;

const revisionPath = async (
  root: string,
  resourceId: string,
  digest: string,
): Promise<string> => `${root}/${await resourceDirectoryKey(resourceId)}/${digest}`;

const createManifest = async (
  authoring: HenjiInstructionAuthoringManifestV1,
  contentBytes: Uint8Array,
): Promise<ManagedHenjiInstructionManifestV1> => ({
  schemaVersion: 1,
  logicalRef: {
    schemaVersion: 1,
    resourceKind: 'henji-instruction',
    resourceId: authoring.resourceId,
    revision: {
      algorithm: 'sha256',
      digest: await sha256Hex(canonicalRevisionBytes(authoring, contentBytes)),
    },
  },
  slot: authoring.slot,
  apiContract: authoring.apiContract,
  format: authoring.format,
  entry: authoring.entry,
  metadata: structuredClone(authoring.metadata),
  content: {
    byteLength: contentBytes.byteLength,
    sha256: await sha256Hex(contentBytes),
  },
});

const readRevisionAt = async (
  path: string,
  expectedResourceId?: string,
  expectedDigest?: string,
): Promise<ManagedHenjiInstructionRevision> => {
  try {
    if (!(await Deno.lstat(path)).isDirectory) {
      throw new HenjiInstructionError(
        'instruction_invalid',
        'Henji Instruction revision is invalid',
      );
    }
  } catch (error) {
    if (isNotFound(error)) {
      throw new HenjiInstructionError(
        'instruction_not_found',
        'Henji Instruction revision not found',
      );
    }
    throw ioError('Henji Instruction revision could not be opened', error);
  }
  const manifestValue = await readJson(`${path}/manifest.json`);
  const custodyValue = await readJson(`${path}/custody.json`);
  if (!isManagedManifest(manifestValue) || !isCustody(custodyValue)) {
    throw new HenjiInstructionError(
      'instruction_invalid',
      'Henji Instruction metadata is invalid',
    );
  }
  const manifest = manifestValue;
  if (
    (expectedResourceId !== undefined &&
      manifest.logicalRef.resourceId !== expectedResourceId) ||
    (expectedDigest !== undefined &&
      manifest.logicalRef.revision.digest !== expectedDigest)
  ) {
    throw new HenjiInstructionError(
      'instruction_invalid',
      'Henji Instruction identity does not match custody',
      manifest.logicalRef,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(`${path}/${HENJI_INSTRUCTION_ENTRY}`);
  } catch (error) {
    throw isNotFound(error)
      ? new HenjiInstructionError(
        'instruction_invalid',
        'Henji Instruction content is missing',
        manifest.logicalRef,
      )
      : ioError('Henji Instruction content could not be read', error);
  }
  const content = decodeInstruction(bytes);
  const authoring: HenjiInstructionAuthoringManifestV1 = {
    schemaVersion: 1,
    resourceKind: 'henji-instruction',
    resourceId: manifest.logicalRef.resourceId,
    slot: manifest.slot,
    apiContract: manifest.apiContract,
    format: manifest.format,
    entry: manifest.entry,
    metadata: structuredClone(manifest.metadata),
  };
  const rebuilt = await createManifest(authoring, bytes);
  if (
    manifest.content.byteLength !== bytes.byteLength ||
    manifest.content.sha256 !== await sha256Hex(bytes) ||
    JSON.stringify(rebuilt) !== JSON.stringify(manifest)
  ) {
    throw new HenjiInstructionError(
      'instruction_invalid',
      'Henji Instruction revision content does not match its manifest',
      manifest.logicalRef,
    );
  }
  return {
    manifest: structuredClone(manifest),
    custody: structuredClone(custodyValue),
    contentBytes: bytes.slice(),
    content,
    physicalRoot: path,
    entryPath: `${path}/${HENJI_INSTRUCTION_ENTRY}`,
  };
};

export interface ManagedHenjiInstructionStoreOptions {
  readonly dataRoot: string;
  readonly now?: () => Date;
}

export class ManagedHenjiInstructionStore {
  readonly root: string;

  constructor(private readonly options: ManagedHenjiInstructionStoreOptions) {
    this.root = managedHenjiInstructionStoreRoot(options.dataRoot);
  }

  async install(
    directoryPath: string,
  ): Promise<ManagedHenjiInstructionRevision> {
    let sourceRoot: string;
    try {
      sourceRoot = await Deno.realPath(directoryPath);
      if (!(await Deno.lstat(sourceRoot)).isDirectory) {
        throw new HenjiInstructionError(
          'instruction_invalid',
          'Henji Instruction source is not a directory',
        );
      }
    } catch (error) {
      if (isNotFound(error)) {
        throw new HenjiInstructionError(
          'instruction_not_found',
          'Henji Instruction source directory not found',
        );
      }
      throw ioError('Henji Instruction source could not be opened', error);
    }
    const authoring = validateAuthoringManifest(
      await readJson(`${sourceRoot}/henji-resource.json`),
    );
    let contentPath: string;
    let contentBytes: Uint8Array;
    try {
      contentPath = await Deno.realPath(`${sourceRoot}/${authoring.entry}`);
      if (contentPath !== `${sourceRoot}/${authoring.entry}`) {
        throw new HenjiInstructionError(
          'instruction_invalid',
          'Henji Instruction entry does not resolve inside its source directory',
        );
      }
      if (!(await Deno.lstat(contentPath)).isFile) {
        throw new HenjiInstructionError(
          'instruction_invalid',
          'Henji Instruction entry is not a file',
        );
      }
      contentBytes = await Deno.readFile(contentPath);
    } catch (error) {
      if (error instanceof HenjiInstructionError) throw error;
      if (isNotFound(error)) {
        throw new HenjiInstructionError(
          'instruction_not_found',
          'Henji Instruction entry not found',
        );
      }
      throw ioError('Henji Instruction entry could not be read', error);
    }
    decodeInstruction(contentBytes);
    const manifest = await createManifest(authoring, contentBytes);
    const custody: ManagedHenjiInstructionCustodyV1 = {
      schemaVersion: 1,
      originLineage: { kind: 'source', directoryPath: sourceRoot },
      localCustody: {
        kind: 'installed',
        installedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      },
    };
    return await this.publish(manifest, custody, contentBytes);
  }

  private async publish(
    manifest: ManagedHenjiInstructionManifestV1,
    custody: ManagedHenjiInstructionCustodyV1,
    contentBytes: Uint8Array,
  ): Promise<ManagedHenjiInstructionRevision> {
    const ref = manifest.logicalRef;
    const target = await revisionPath(
      this.root,
      ref.resourceId,
      ref.revision.digest,
    );
    try {
      return await readRevisionAt(target, ref.resourceId, ref.revision.digest);
    } catch (error) {
      if (
        !(error instanceof HenjiInstructionError) ||
        error.code !== 'instruction_not_found'
      ) {
        throw error;
      }
    }
    await ensureDirectory(parentPath(target));
    const staging = `${this.root}/.staging-${crypto.randomUUID().toLowerCase()}`;
    try {
      await ensureDirectory(staging);
      await writeBytes(`${staging}/${HENJI_INSTRUCTION_ENTRY}`, contentBytes);
      await writeJson(`${staging}/manifest.json`, manifest);
      await writeJson(`${staging}/custody.json`, custody);
      await readRevisionAt(staging, ref.resourceId, ref.revision.digest);
      try {
        await Deno.rename(staging, target);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        return await readRevisionAt(
          target,
          ref.resourceId,
          ref.revision.digest,
        );
      }
      return await readRevisionAt(target, ref.resourceId, ref.revision.digest);
    } catch (error) {
      throw ioError('Henji Instruction revision could not be published', error);
    } finally {
      try {
        await Deno.remove(staging, { recursive: true });
      } catch (error) {
        if (!isNotFound(error)) {
          // A complete revision is already visible, or staging remains isolated.
        }
      }
    }
  }

  async inspect(
    resourceId: string,
    digest: string,
  ): Promise<ManagedHenjiInstructionRevision> {
    if (
      !isExternalHenjiInstructionResourceId(resourceId) || !SHA256.test(digest)
    ) {
      throw new HenjiInstructionError(
        'instruction_invalid',
        'Henji Instruction selector is invalid',
      );
    }
    return await readRevisionAt(
      await revisionPath(this.root, resourceId, digest),
      resourceId,
      digest,
    );
  }

  async resolve(
    ref: HenjiInstructionRevisionRef,
  ): Promise<ManagedHenjiInstructionRevision> {
    if (
      !isHenjiInstructionRevisionRef(ref) ||
      !isExternalHenjiInstructionResourceId(ref.resourceId)
    ) {
      throw new HenjiInstructionError(
        'instruction_invalid',
        'Henji Instruction ref is invalid',
      );
    }
    const revision = await this.inspect(ref.resourceId, ref.revision.digest);
    if (revision.manifest.apiContract !== HENJI_INSTRUCTION_API_CONTRACT) {
      throw new HenjiInstructionError(
        'instruction_api_unsupported',
        `Henji Instruction API contract is unsupported: ${revision.manifest.apiContract}`,
        ref,
      );
    }
    return revision;
  }

  async list(): Promise<readonly ManagedHenjiInstructionManifestV1[]> {
    let resources: Deno.DirEntry[];
    try {
      resources = [];
      for await (const entry of Deno.readDir(this.root)) resources.push(entry);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw ioError('Henji Instruction store could not be listed', error);
    }
    const manifests: ManagedHenjiInstructionManifestV1[] = [];
    for (const resource of resources) {
      if (resource.name.startsWith('.staging-')) continue;
      if (!resource.isDirectory || !SHA256.test(resource.name)) {
        throw new HenjiInstructionError(
          'instruction_invalid',
          'Henji Instruction store is invalid',
        );
      }
      const entries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(`${this.root}/${resource.name}`)) {
        entries.push(entry);
      }
      for (const entry of entries) {
        if (!entry.isDirectory || !SHA256.test(entry.name)) {
          throw new HenjiInstructionError(
            'instruction_invalid',
            'Henji Instruction store is invalid',
          );
        }
        const revision = await readRevisionAt(
          `${this.root}/${resource.name}/${entry.name}`,
        );
        if (
          await resourceDirectoryKey(
            revision.manifest.logicalRef.resourceId,
          ) !== resource.name
        ) {
          throw new HenjiInstructionError(
            'instruction_invalid',
            'Henji Instruction store is invalid',
          );
        }
        manifests.push(revision.manifest);
      }
    }
    return manifests.sort((left, right) => {
      const leftKey = `${left.logicalRef.resourceId}\0${left.logicalRef.revision.digest}`;
      const rightKey = `${right.logicalRef.resourceId}\0${right.logicalRef.revision.digest}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }

  /** Remove one installed external revision while leaving other custody untouched. */
  async remove(
    resourceId: string,
    digest: string,
  ): Promise<ManagedHenjiInstructionManifestV1> {
    if (
      !isExternalHenjiInstructionResourceId(resourceId) || !SHA256.test(digest)
    ) {
      throw new HenjiInstructionError(
        'instruction_invalid',
        'Henji Instruction selector is invalid',
      );
    }
    const path = await revisionPath(this.root, resourceId, digest);
    const revision = await readRevisionAt(path, resourceId, digest);
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (isNotFound(error)) {
        throw new HenjiInstructionError(
          'instruction_not_found',
          'Henji Instruction revision not found',
        );
      }
      throw ioError('Henji Instruction revision could not be removed', error);
    }
    return revision.manifest;
  }
}

export interface HenjiInstructionBindingV1 {
  readonly schemaVersion: 1;
  readonly slot: typeof HENJI_BASE_INSTRUCTION_SLOT;
  readonly ref: HenjiInstructionRevisionRef;
}

export const henjiInstructionBindingPath = (configRoot: string): string =>
  `${configRoot}/instruction/active-v1.json`;

const readBinding = async (
  configRoot: string,
): Promise<HenjiInstructionBindingV1 | undefined> => {
  const path = henjiInstructionBindingPath(configRoot);
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(await Deno.readFile(path)));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new HenjiInstructionError(
      'instruction_binding_invalid',
      'Henji Instruction active binding could not be read',
    );
  }
  if (
    !isRecord(value) || !exactKeys(value, ['schemaVersion', 'slot', 'ref']) ||
    value.schemaVersion !== 1 || value.slot !== HENJI_BASE_INSTRUCTION_SLOT ||
    !isHenjiInstructionRevisionRef(value.ref) ||
    !isExternalHenjiInstructionResourceId(value.ref.resourceId)
  ) {
    throw new HenjiInstructionError(
      'instruction_binding_invalid',
      'Henji Instruction active binding is invalid',
      isRecord(value) && isHenjiInstructionRevisionRef(value.ref) ? value.ref : undefined,
    );
  }
  return structuredClone(value) as unknown as HenjiInstructionBindingV1;
};

/** Read the active binding ref without resolving its stored content. */
export const readHenjiBaseInstructionBindingRef = async (
  configRoot: string,
): Promise<HenjiInstructionRevisionRef | undefined> => {
  const binding = await readBinding(configRoot);
  return binding === undefined ? undefined : structuredClone(binding.ref);
};

const selectedExternal = (
  revision: ManagedHenjiInstructionRevision,
): SelectedHenjiBaseInstruction => ({
  schemaVersion: 1,
  slot: HENJI_BASE_INSTRUCTION_SLOT,
  selectionSource: 'external',
  ref: structuredClone(revision.manifest.logicalRef),
  contentDigest: `sha256:${revision.manifest.content.sha256}`,
  content: revision.content,
  bytesBase64: revision.contentBytes.toBase64(),
});

export const resolveActiveHenjiBaseInstruction = async (
  dataRoot: string,
  configRoot: string,
): Promise<SelectedHenjiBaseInstruction> => {
  const binding = await readBinding(configRoot);
  if (binding === undefined) return builtinHenjiBaseInstruction();
  try {
    return selectedExternal(
      await new ManagedHenjiInstructionStore({ dataRoot }).resolve(binding.ref),
    );
  } catch (error) {
    if (
      error instanceof HenjiInstructionError && error.instruction !== undefined
    ) throw error;
    throw new HenjiInstructionError(
      error instanceof HenjiInstructionError ? error.code : 'instruction_io_failure',
      error instanceof Error ? error.message : String(error),
      binding.ref,
    );
  }
};

export const activateHenjiBaseInstruction = async (
  dataRoot: string,
  configRoot: string,
  ref: HenjiInstructionRevisionRef,
): Promise<SelectedHenjiBaseInstruction> => {
  const revision = await new ManagedHenjiInstructionStore({ dataRoot }).resolve(
    ref,
  );
  const path = henjiInstructionBindingPath(configRoot);
  await ensureDirectory(parentPath(path));
  const staging = `${parentPath(path)}/.active-v1.staging-${crypto.randomUUID().toLowerCase()}`;
  try {
    await writeJson(staging, {
      schemaVersion: 1,
      slot: HENJI_BASE_INSTRUCTION_SLOT,
      ref: structuredClone(ref),
    });
    await Deno.rename(staging, path);
  } catch (error) {
    throw ioError(
      'Henji Instruction active binding could not be written',
      error,
    );
  } finally {
    try {
      await Deno.remove(staging);
    } catch (error) {
      if (!isNotFound(error)) {
        // A successful rename already published the complete binding.
      }
    }
  }
  return selectedExternal(revision);
};

export const deactivateHenjiBaseInstruction = async (
  configRoot: string,
): Promise<void> => {
  try {
    await Deno.remove(henjiInstructionBindingPath(configRoot));
  } catch (error) {
    if (!isNotFound(error)) {
      throw ioError(
        'Henji Instruction active binding could not be removed',
        error,
      );
    }
  }
};

export const verifyBuiltinHenjiBaseInstructionIdentity = async (): Promise<
  boolean
> => {
  const revision = await sha256Hex(
    encoder.encode(
      `${HENJI_INSTRUCTION_API_CONTRACT}\0${HENJI_COMMON_INSTRUCTION}`,
    ),
  );
  const content = await sha256Hex(encoder.encode(HENJI_COMMON_INSTRUCTION));
  return revision === BUILTIN_REVISION_DIGEST &&
    content === BUILTIN_CONTENT_DIGEST;
};
