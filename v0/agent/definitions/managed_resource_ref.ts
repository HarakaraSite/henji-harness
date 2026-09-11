import { AGENT_DEFINITION_API_CONTRACT, type BuildManifestV1 } from '../runtime/build_manifest.ts';

export interface ManagedResourceRefV1 {
  readonly schemaVersion: 1;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly revision: {
    readonly algorithm: 'sha256';
    readonly digest: string;
  };
}

export type DefinitionRevisionRef = ManagedResourceRefV1 & {
  readonly resourceKind: 'agent-definition';
  readonly resourceId: 'builtin/default' | 'builtin/planner';
};

const encoder = new TextEncoder();
const SHA256 = /^[0-9a-f]{64}$/u;

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const builtinDefinitionRef = async (
  agent: 'default' | 'planner',
  manifest: BuildManifestV1,
): Promise<DefinitionRevisionRef> => {
  const resourceId = `builtin/${agent}` as const;
  const identity = JSON.stringify({
    resourceId,
    role: agent === 'planner' ? 'planner' : 'parent',
    apiContract: AGENT_DEFINITION_API_CONTRACT,
    embeddedRuntimeSha256: manifest.embeddedRuntimeSha256,
  });
  return {
    schemaVersion: 1,
    resourceKind: 'agent-definition',
    resourceId,
    revision: { algorithm: 'sha256', digest: await sha256Hex(encoder.encode(identity)) },
  };
};

export const isDefinitionRevisionRef = (value: unknown): value is DefinitionRevisionRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const revision = ref.revision;
  return ref.schemaVersion === 1 && ref.resourceKind === 'agent-definition' &&
    (ref.resourceId === 'builtin/default' || ref.resourceId === 'builtin/planner') &&
    typeof revision === 'object' && revision !== null && !Array.isArray(revision) &&
    (revision as Record<string, unknown>).algorithm === 'sha256' &&
    typeof (revision as Record<string, unknown>).digest === 'string' &&
    SHA256.test((revision as Record<string, string>).digest);
};

export const sameDefinitionRevisionRef = (
  left: DefinitionRevisionRef,
  right: DefinitionRevisionRef,
): boolean =>
  left.resourceKind === right.resourceKind && left.resourceId === right.resourceId &&
  left.revision.algorithm === right.revision.algorithm &&
  left.revision.digest === right.revision.digest;
