import {
  compareUtf8,
  isCanonicalRelativeDefinitionPath,
  isManagedDefinitionManifest,
  isManagedDefinitionOriginLineage,
  type ManagedDefinitionManifestV1,
  type ManagedDefinitionOriginLineageV1,
} from './managed_definition_manifest.ts';
import {
  type ImportedManagedDefinition,
  ManagedDefinitionError,
} from './managed_definition_importer.ts';
import { validateManagedDefinitionRevision } from './managed_definition_revision_validator.ts';
import type { DefinitionRevisionRef } from './managed_resource_ref.ts';

export const MANAGED_DEFINITION_TRANSPORT_SCHEMA_VERSION = 1 as const;
export const MANAGED_RESOURCE_TRANSPORT_KIND = 'henji-managed-resource-transport' as const;

export interface ManagedDefinitionTransportFileV1 {
  readonly path: string;
  readonly bytesBase64: string;
}

export interface ManagedDefinitionTransportV1 {
  readonly schemaVersion: 1;
  readonly packageKind: typeof MANAGED_RESOURCE_TRANSPORT_KIND;
  readonly resourceKind: 'agent-definition';
  readonly manifest: ManagedDefinitionManifestV1;
  readonly originLineage: ManagedDefinitionOriginLineageV1;
  readonly files: readonly ManagedDefinitionTransportFileV1[];
}

export interface DecodeManagedDefinitionTransportOptions {
  readonly artifactPath: string;
  readonly now?: () => Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const invalid = (message: string, definition?: DefinitionRevisionRef): ManagedDefinitionError =>
  new ManagedDefinitionError(
    'module_invalid',
    `Managed Definition transport is invalid: ${message}`,
    definition,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(compareUtf8);
  const sortedExpected = [...expected].sort(compareUtf8);
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
};

export const createManagedDefinitionTransport = (
  manifest: ManagedDefinitionManifestV1,
  originLineage: ManagedDefinitionOriginLineageV1,
  files: ReadonlyMap<string, Uint8Array>,
): ManagedDefinitionTransportV1 => {
  const payloadFiles = manifest.files.map((descriptor) => {
    const bytes = files.get(descriptor.path);
    if (bytes === undefined) throw invalid(`closure file is missing: ${descriptor.path}`);
    return Object.freeze({ path: descriptor.path, bytesBase64: bytes.toBase64() });
  });
  return Object.freeze({
    schemaVersion: MANAGED_DEFINITION_TRANSPORT_SCHEMA_VERSION,
    packageKind: MANAGED_RESOURCE_TRANSPORT_KIND,
    resourceKind: 'agent-definition',
    manifest: structuredClone(manifest),
    originLineage: structuredClone(originLineage),
    files: Object.freeze(payloadFiles),
  });
};

export const encodeManagedDefinitionTransport = (
  transport: ManagedDefinitionTransportV1,
): Uint8Array => encoder.encode(`${JSON.stringify(transport)}\n`);

export const decodeManagedDefinitionTransport = async (
  bytes: Uint8Array,
  options: DecodeManagedDefinitionTransportOptions,
): Promise<ImportedManagedDefinition> => {
  if (!options.artifactPath.startsWith('/')) throw invalid('artifact path is not absolute');
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw invalid(
      `JSON could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const decodedDefinition = isRecord(value) && isManagedDefinitionManifest(value.manifest)
    ? structuredClone(value.manifest.logicalRef)
    : undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'packageKind',
      'resourceKind',
      'manifest',
      'originLineage',
      'files',
    ]) ||
    value.schemaVersion !== MANAGED_DEFINITION_TRANSPORT_SCHEMA_VERSION ||
    value.packageKind !== MANAGED_RESOURCE_TRANSPORT_KIND ||
    value.resourceKind !== 'agent-definition' ||
    !isManagedDefinitionManifest(value.manifest) ||
    !isManagedDefinitionOriginLineage(value.originLineage) ||
    !Array.isArray(value.files)
  ) {
    throw invalid('envelope does not match schema version 1', decodedDefinition);
  }
  const manifest = value.manifest;
  const definition = structuredClone(manifest.logicalRef);
  if (value.files.length !== manifest.files.length) {
    throw invalid('closure file count mismatch', definition);
  }
  const decodedFiles = new Map<string, Uint8Array>();
  for (let index = 0; index < manifest.files.length; index += 1) {
    const descriptor = manifest.files[index];
    const payload = value.files[index];
    if (
      !isRecord(payload) || !hasExactKeys(payload, ['path', 'bytesBase64']) ||
      !isCanonicalRelativeDefinitionPath(payload.path) ||
      typeof payload.bytesBase64 !== 'string' || payload.path !== descriptor.path
    ) {
      throw invalid(`closure file order or shape mismatch at index ${index}`, definition);
    }
    let fileBytes: Uint8Array;
    try {
      fileBytes = Uint8Array.fromBase64(payload.bytesBase64);
    } catch {
      throw invalid(`closure file base64 is invalid: ${descriptor.path}`, definition);
    }
    if (fileBytes.toBase64() !== payload.bytesBase64) {
      throw invalid(`closure file base64 is not canonical: ${descriptor.path}`, definition);
    }
    decodedFiles.set(descriptor.path, fileBytes);
  }
  try {
    await validateManagedDefinitionRevision(manifest, decodedFiles);
  } catch (error) {
    if (error instanceof ManagedDefinitionError) {
      throw new ManagedDefinitionError(error.code, error.message, definition);
    }
    throw error;
  }
  return {
    manifest: structuredClone(manifest),
    custody: {
      schemaVersion: 1,
      originLineage: structuredClone(value.originLineage),
      localCustody: {
        kind: 'imported',
        importedAt: (options.now ?? (() => new Date()))().toISOString(),
        artifactPath: options.artifactPath,
      },
    },
    files: decodedFiles,
  };
};
