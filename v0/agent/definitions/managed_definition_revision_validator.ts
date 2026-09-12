import {
  compareUtf8,
  createManagedDefinitionManifest,
  definitionFileSha256,
  type ManagedDefinitionManifestV1,
} from './managed_definition_manifest.ts';
import {
  analyzeDefinitionSourceDependencies,
  ManagedDefinitionError,
} from './managed_definition_importer.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
const validationRoot = new URL('file:///henji-managed-definition-validation/');

const invalid = (message: string): ManagedDefinitionError =>
  new ManagedDefinitionError(
    'module_invalid',
    `Managed Definition revision is invalid: ${message}`,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const definitionMetadataEquals = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => definitionMetadataEquals(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(compareUtf8);
  const rightKeys = Object.keys(right).sort(compareUtf8);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && definitionMetadataEquals(left[key], right[key])
    );
};

const validationFileUrl = (path: string): URL => {
  const url = new URL(validationRoot);
  url.pathname = `${validationRoot.pathname}${path}`;
  return url;
};

export const validateManagedDefinitionRevision = async (
  manifest: ManagedDefinitionManifestV1,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> => {
  const sortedPaths = [...manifest.files.map((file) => file.path)].sort(compareUtf8);
  if (sortedPaths.some((path, index) => path !== manifest.files[index].path)) {
    throw invalid('manifest file order mismatch');
  }
  if (files.size !== manifest.files.length) throw invalid('closure file count mismatch');
  const revisionFiles = [];
  for (const descriptor of manifest.files) {
    const bytes = files.get(descriptor.path);
    if (bytes === undefined) throw invalid(`closure file is missing: ${descriptor.path}`);
    if (
      bytes.byteLength !== descriptor.byteLength ||
      await definitionFileSha256(bytes) !== descriptor.sha256
    ) {
      throw invalid(`closure file content mismatch: ${descriptor.path}`);
    }
    let source: string;
    try {
      source = decoder.decode(bytes);
    } catch {
      throw invalid(`closure file is not UTF-8: ${descriptor.path}`);
    }
    const dependencies = analyzeDefinitionSourceDependencies(
      source,
      validationFileUrl(descriptor.path),
      validationRoot,
      manifest.apiContract,
    );
    if (!definitionMetadataEquals(dependencies, descriptor.dependencies)) {
      throw invalid(`dependency lineage mismatch: ${descriptor.path}`);
    }
    revisionFiles.push({ path: descriptor.path, bytes, dependencies });
  }
  const rebuilt = await createManagedDefinitionManifest({
    resourceId: manifest.logicalRef.resourceId,
    declaredRole: manifest.declaredRole,
    apiContract: manifest.apiContract,
    entry: manifest.entry,
    files: revisionFiles,
  });
  if (!definitionMetadataEquals(rebuilt, manifest)) throw invalid('manifest identity mismatch');
};
