import {
  compareUtf8,
  type DefinitionClosureFileV1,
  definitionFileSha256,
  type DefinitionLocalDependencyV1,
  isCanonicalRelativeDefinitionPath,
  isManagedDefinitionCustody,
  type ManagedDefinitionCustodyV1,
} from './managed_definition_manifest.ts';
import {
  isExternalToolDefinitionResourceId,
  isToolDefinitionRevisionRef,
  type ToolDefinitionRevisionRef,
} from './managed_resource_ref.ts';

export const TOOL_DEFINITION_REVISION_DOMAIN = 'henji-tool-definition-revision-v1';
export const TOOL_DEFINITION_CLOSURE_SCHEMA_VERSION = 1 as const;

const TOOL_COMPONENT_NAME = /^[a-z][a-z0-9_]{0,127}$/u;

export const isToolComponentName = (value: unknown): value is string =>
  typeof value === 'string' && TOOL_COMPONENT_NAME.test(value);

/** A tool identity is `tool:<component name>` and maps to one model-facing tool name. */
export const isToolIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('tool:') &&
  isToolComponentName(value.slice('tool:'.length));

export const toolComponentName = (identity: string): string => identity.slice('tool:'.length);

export interface ManagedToolDefinitionManifestV1 {
  readonly schemaVersion: 1;
  readonly closureSchemaVersion: typeof TOOL_DEFINITION_CLOSURE_SCHEMA_VERSION;
  readonly logicalRef: ToolDefinitionRevisionRef;
  readonly toolIdentity: string;
  readonly apiContract: string;
  readonly entry: string;
  readonly files: readonly DefinitionClosureFileV1[];
}

export interface ToolDefinitionRevisionContent {
  readonly resourceId: string;
  readonly toolIdentity: string;
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

export const canonicalToolDefinitionRevisionBytes = (
  content: Pick<ToolDefinitionRevisionContent, 'toolIdentity' | 'apiContract' | 'entry' | 'files'>,
): Uint8Array => {
  const files = [...content.files].sort((left, right) => compareUtf8(left.path, right.path));
  const chunks: Uint8Array[] = [];
  append(chunks, TOOL_DEFINITION_REVISION_DOMAIN);
  append(chunks, 'tool-definition');
  append(chunks, content.toolIdentity);
  append(chunks, content.apiContract);
  append(chunks, content.entry);
  append(chunks, 'closure-files');
  chunks.push(u64(files.length));
  for (const file of files) {
    append(chunks, file.path);
    append(chunks, file.bytes);
  }
  return join(chunks);
};

export const createManagedToolDefinitionManifest = async (
  content: ToolDefinitionRevisionContent,
): Promise<ManagedToolDefinitionManifestV1> => {
  const digest = await definitionFileSha256(canonicalToolDefinitionRevisionBytes(content));
  const files = await Promise.all(
    [...content.files]
      .sort((left, right) => compareUtf8(left.path, right.path))
      .map(async (file): Promise<DefinitionClosureFileV1> => ({
        path: file.path,
        byteLength: file.bytes.byteLength,
        sha256: await definitionFileSha256(file.bytes),
        dependencies: Object.freeze(structuredClone(file.dependencies)),
      })),
  );
  return Object.freeze({
    schemaVersion: 1,
    closureSchemaVersion: TOOL_DEFINITION_CLOSURE_SCHEMA_VERSION,
    logicalRef: Object.freeze({
      schemaVersion: 1,
      resourceKind: 'tool-definition',
      resourceId: content.resourceId,
      revision: Object.freeze({ algorithm: 'sha256', digest }),
    }),
    toolIdentity: content.toolIdentity,
    apiContract: content.apiContract,
    entry: content.entry,
    files: Object.freeze(files),
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

export const isManagedToolDefinitionManifest = (
  value: unknown,
): value is ManagedToolDefinitionManifestV1 => {
  if (
    !isRecord(value) || value.schemaVersion !== 1 ||
    value.closureSchemaVersion !== TOOL_DEFINITION_CLOSURE_SCHEMA_VERSION ||
    !isToolDefinitionRevisionRef(value.logicalRef) ||
    !isExternalToolDefinitionResourceId(value.logicalRef.resourceId) ||
    !isToolIdentity(value.toolIdentity) ||
    typeof value.apiContract !== 'string' || value.apiContract.length === 0 ||
    !isCanonicalRelativeDefinitionPath(value.entry) ||
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

export {
  isManagedDefinitionCustody as isManagedToolDefinitionCustody,
  type ManagedDefinitionCustodyV1 as ManagedToolDefinitionCustodyV1,
};

export const toolDefinitionFileSha256 = definitionFileSha256;
