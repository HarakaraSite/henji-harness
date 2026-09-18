import {
  createManagedToolDefinitionManifest,
  type ManagedToolDefinitionManifestV1,
} from './managed_tool_definition_manifest.ts';
import { compareUtf8, definitionFileSha256 } from './managed_definition_manifest.ts';
import {
  analyzeDefinitionSourceDependencies,
  ManagedDefinitionError,
} from './managed_definition_importer.ts';
import { definitionMetadataEquals } from './managed_definition_revision_validator.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
const validationRoot = new URL('file:///henji-managed-tool-definition-validation/');

const invalid = (message: string): ManagedDefinitionError =>
  new ManagedDefinitionError(
    'module_invalid',
    `Managed tool Definition revision is invalid: ${message}`,
  );

const validationFileUrl = (path: string): URL => {
  const url = new URL(validationRoot);
  url.pathname = `${validationRoot.pathname}${path}`;
  return url;
};

export const validateManagedToolDefinitionRevision = async (
  manifest: ManagedToolDefinitionManifestV1,
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
  const rebuilt = await createManagedToolDefinitionManifest({
    resourceId: manifest.logicalRef.resourceId,
    toolIdentity: manifest.toolIdentity,
    apiContract: manifest.apiContract,
    entry: manifest.entry,
    files: revisionFiles,
  });
  if (!definitionMetadataEquals(rebuilt, manifest)) throw invalid('manifest identity mismatch');
};
