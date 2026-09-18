import {
  type DefinitionRevisionRef,
  isDefinitionRevisionRef,
  isExternalDefinitionResourceId,
} from './managed_resource_ref.ts';
export const DEFINITION_REVISION_DOMAIN = 'henji-definition-revision-v1';
export const DEFINITION_CLOSURE_SCHEMA_VERSION = 1 as const;

const SUBAGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export const isSubagentName = (value: unknown): value is string =>
  typeof value === 'string' && SUBAGENT_NAME.test(value);

/** Validate the declaredRole/subagentName pair as one coherent role declaration. */
export const isManagedDefinitionRole = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.declaredRole === 'parent') {
    return !Object.hasOwn(value, 'subagentName');
  }
  return value.declaredRole === 'subagent' && isSubagentName(value.subagentName);
};

export interface DefinitionLocalDependencyV1 {
  readonly specifier: string;
  readonly target: {
    readonly kind: 'local';
    readonly path: string;
  } | {
    readonly kind: 'embedded-api';
    readonly contract: string;
  };
  readonly typeOnly: boolean;
}

export interface DefinitionClosureFileV1 {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly dependencies: readonly DefinitionLocalDependencyV1[];
}

export interface ManagedDefinitionManifestV1 {
  readonly schemaVersion: 1;
  readonly closureSchemaVersion: typeof DEFINITION_CLOSURE_SCHEMA_VERSION;
  readonly logicalRef: DefinitionRevisionRef;
  readonly declaredRole: 'parent' | 'subagent';
  /** Present exactly when declaredRole is `subagent`; identifies the delegated slot. */
  readonly subagentName?: string;
  readonly apiContract: string;
  readonly entry: string;
  readonly exactResourceBindings: readonly [];
  readonly files: readonly DefinitionClosureFileV1[];
}

export interface ManagedDefinitionOriginLineageV1 {
  readonly kind: 'source';
  readonly entryPath: string;
  readonly moduleRoot: string;
}

export type ManagedDefinitionLocalCustodyV1 = {
  readonly kind: 'installed';
  readonly installedAt: string;
} | {
  readonly kind: 'imported';
  readonly importedAt: string;
  readonly artifactPath: string;
};

export interface ManagedDefinitionCustodyV1 {
  readonly schemaVersion: 1;
  readonly originLineage: ManagedDefinitionOriginLineageV1;
  readonly localCustody: ManagedDefinitionLocalCustodyV1;
}

export interface DefinitionRevisionContent {
  readonly resourceId: string;
  readonly declaredRole: 'parent' | 'subagent';
  readonly subagentName?: string;
  readonly apiContract: string;
  readonly entry: string;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly dependencies: readonly DefinitionLocalDependencyV1[];
  }[];
}

const encoder = new TextEncoder();
const SHA256 = /^[0-9a-f]{64}$/u;

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.byteLength - right.byteLength;
};

export const compareUtf8 = (left: string, right: string): number =>
  compareBytes(encoder.encode(left), encoder.encode(right));

const u64 = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid canonical length');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
};

const join = (chunks: readonly Uint8Array[]): Uint8Array => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const append = (chunks: Uint8Array[], value: string | Uint8Array): void => {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  chunks.push(u64(bytes.byteLength), bytes);
};

export const canonicalDefinitionRevisionBytes = (
  content: Pick<
    DefinitionRevisionContent,
    'declaredRole' | 'subagentName' | 'apiContract' | 'entry' | 'files'
  >,
): Uint8Array => {
  const files = [...content.files].sort((left, right) => compareUtf8(left.path, right.path));
  const chunks: Uint8Array[] = [];
  append(chunks, DEFINITION_REVISION_DOMAIN);
  append(chunks, 'agent-definition');
  append(chunks, content.declaredRole);
  append(chunks, content.subagentName ?? '');
  append(chunks, content.apiContract);
  append(chunks, content.entry);
  append(chunks, 'exact-resource-bindings');
  chunks.push(u64(0));
  append(chunks, 'closure-files');
  chunks.push(u64(files.length));
  for (const file of files) {
    append(chunks, file.path);
    append(chunks, file.bytes);
  }
  return join(chunks);
};

export const createManagedDefinitionManifest = async (
  content: DefinitionRevisionContent,
): Promise<ManagedDefinitionManifestV1> => {
  const digest = await sha256Hex(canonicalDefinitionRevisionBytes(content));
  const files = await Promise.all(
    [...content.files]
      .sort((left, right) => compareUtf8(left.path, right.path))
      .map(async (file): Promise<DefinitionClosureFileV1> => ({
        path: file.path,
        byteLength: file.bytes.byteLength,
        sha256: await sha256Hex(file.bytes),
        dependencies: Object.freeze(structuredClone(file.dependencies)),
      })),
  );
  const exactResourceBindings: readonly [] = Object.freeze([]);
  return Object.freeze({
    schemaVersion: 1,
    closureSchemaVersion: DEFINITION_CLOSURE_SCHEMA_VERSION,
    logicalRef: Object.freeze({
      schemaVersion: 1,
      resourceKind: 'agent-definition',
      resourceId: content.resourceId,
      revision: Object.freeze({ algorithm: 'sha256', digest }),
    }),
    declaredRole: content.declaredRole,
    ...(content.subagentName === undefined ? {} : { subagentName: content.subagentName }),
    apiContract: content.apiContract,
    entry: content.entry,
    exactResourceBindings,
    files: Object.freeze(files),
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isCanonicalRelativeDefinitionPath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..') &&
    value.endsWith('.ts');
};

const isDependency = (value: unknown): value is DefinitionLocalDependencyV1 => {
  if (
    !isRecord(value) || typeof value.specifier !== 'string' ||
    typeof value.typeOnly !== 'boolean' || !isRecord(value.target)
  ) return false;
  return value.target.kind === 'local'
    ? isCanonicalRelativeDefinitionPath(value.target.path)
    : value.target.kind === 'embedded-api' &&
      typeof value.target.contract === 'string' && value.target.contract.length > 0;
};

export const isManagedDefinitionOriginLineage = (
  value: unknown,
): value is ManagedDefinitionOriginLineageV1 =>
  isRecord(value) && value.kind === 'source' &&
  typeof value.entryPath === 'string' && value.entryPath.startsWith('/') &&
  typeof value.moduleRoot === 'string' && value.moduleRoot.startsWith('/');

export const isManagedDefinitionManifest = (
  value: unknown,
): value is ManagedDefinitionManifestV1 => {
  if (
    !isRecord(value) || value.schemaVersion !== 1 ||
    value.closureSchemaVersion !== DEFINITION_CLOSURE_SCHEMA_VERSION ||
    !isDefinitionRevisionRef(value.logicalRef) ||
    !isExternalDefinitionResourceId(value.logicalRef.resourceId) ||
    !isManagedDefinitionRole(value) ||
    typeof value.apiContract !== 'string' || value.apiContract.length === 0 ||
    !isCanonicalRelativeDefinitionPath(value.entry) ||
    !Array.isArray(value.exactResourceBindings) || value.exactResourceBindings.length !== 0 ||
    !Array.isArray(value.files) || value.files.length === 0
  ) return false;
  const paths = new Set<string>();
  for (const item of value.files) {
    if (
      !isRecord(item) || !isCanonicalRelativeDefinitionPath(item.path) ||
      !Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0 ||
      typeof item.sha256 !== 'string' || !SHA256.test(item.sha256) ||
      !Array.isArray(item.dependencies) || !item.dependencies.every(isDependency) ||
      paths.has(item.path)
    ) return false;
    paths.add(item.path);
  }
  return paths.has(value.entry) &&
    value.files.every((file) =>
      file.dependencies.every((dependency: DefinitionLocalDependencyV1) =>
        dependency.target.kind === 'local'
          ? paths.has(dependency.target.path)
          : dependency.target.contract === value.apiContract
      )
    );
};

export const isManagedDefinitionCustody = (
  value: unknown,
): value is ManagedDefinitionCustodyV1 => {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.originLineage) ||
    !isRecord(value.localCustody)
  ) return false;
  if (!isManagedDefinitionOriginLineage(value.originLineage)) return false;
  if (value.localCustody.kind === 'installed') {
    return typeof value.localCustody.installedAt === 'string' &&
      !Number.isNaN(Date.parse(value.localCustody.installedAt));
  }
  return value.localCustody.kind === 'imported' &&
    typeof value.localCustody.importedAt === 'string' &&
    !Number.isNaN(Date.parse(value.localCustody.importedAt)) &&
    typeof value.localCustody.artifactPath === 'string' &&
    value.localCustody.artifactPath.startsWith('/');
};

export const definitionFileSha256 = sha256Hex;
