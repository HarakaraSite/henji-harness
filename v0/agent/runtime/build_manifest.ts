export const BUILD_MANIFEST_SCHEMA_VERSION = 1 as const;
export const AGENT_DEFINITION_API_CONTRACT = 'henji-agent-definition-v1' as const;

export interface BuildManifestV1 {
  readonly schemaVersion: 1;
  readonly productVersion: string;
  readonly buildId: string;
  readonly sourceRevision: string;
  readonly sourceDirty: boolean;
  readonly denoVersion: string;
  readonly target: string;
  readonly embeddedRuntimeSha256: string;
  readonly supportedAgentDefinitionApiContracts: readonly string[];
}

const DEVELOPMENT_DIGEST = 'c738494fbbf99c577b5c91b957df9f3f0efcfc755442293665f71c8e3bd30179';

const DEVELOPMENT_MANIFEST: BuildManifestV1 = Object.freeze({
  schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
  productVersion: '0.1.1',
  buildId: DEVELOPMENT_DIGEST,
  sourceRevision: 'development',
  sourceDirty: true,
  denoVersion: Deno.version.deno,
  target: Deno.build.target,
  embeddedRuntimeSha256: DEVELOPMENT_DIGEST,
  supportedAgentDefinitionApiContracts: Object.freeze([AGENT_DEFINITION_API_CONTRACT]),
});

let installed: BuildManifestV1 | undefined;

export const installBuildManifest = (manifest: BuildManifestV1): void => {
  if (installed !== undefined) throw new Error('build manifest already installed');
  installed = structuredClone(manifest);
};

export const buildManifest = (): BuildManifestV1 =>
  structuredClone(installed ?? DEVELOPMENT_MANIFEST);

const SHA256 = /^[0-9a-f]{64}$/u;
export const isBuildManifest = (value: unknown): value is BuildManifestV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 && typeof item.productVersion === 'string' &&
    item.productVersion.length > 0 && typeof item.buildId === 'string' &&
    SHA256.test(item.buildId) && typeof item.sourceRevision === 'string' &&
    item.sourceRevision.length > 0 && typeof item.sourceDirty === 'boolean' &&
    typeof item.denoVersion === 'string' && item.denoVersion.length > 0 &&
    typeof item.target === 'string' && item.target.length > 0 &&
    typeof item.embeddedRuntimeSha256 === 'string' &&
    SHA256.test(item.embeddedRuntimeSha256) &&
    Array.isArray(item.supportedAgentDefinitionApiContracts) &&
    item.supportedAgentDefinitionApiContracts.length > 0 &&
    item.supportedAgentDefinitionApiContracts.every((contract) =>
      typeof contract === 'string' && contract.length > 0
    );
};
