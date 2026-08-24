export type FieldOwner = 'host' | 'definition-author' | 'host-policy';
export type FieldVisibility = 'hidden' | 'visible';

export interface FieldOwnership {
  readonly path: string;
  readonly owner: FieldOwner;
  readonly visibility: FieldVisibility;
}

export const FIELD_OWNERSHIP: readonly FieldOwnership[] = [
  { path: 'schemaVersion', owner: 'host', visibility: 'hidden' },
  { path: 'identity.pluginId', owner: 'host', visibility: 'hidden' },
  { path: 'identity.namespace', owner: 'host', visibility: 'hidden' },
  { path: 'identity.kind', owner: 'host', visibility: 'hidden' },
  { path: 'source', owner: 'definition-author', visibility: 'visible' },
  { path: 'manifest', owner: 'definition-author', visibility: 'visible' },
  { path: 'publicContract', owner: 'host', visibility: 'hidden' },
  { path: 'pluginOwnedTests', owner: 'definition-author', visibility: 'visible' },
  { path: 'config', owner: 'definition-author', visibility: 'visible' },
  { path: 'requestedCapabilities', owner: 'host-policy', visibility: 'hidden' },
];

export const DEFINITION_CONTENT_V1_OWNERSHIP_PATHS = [
  'schemaVersion',
  'identity.pluginId',
  'identity.namespace',
  'identity.kind',
  'source',
  'manifest',
  'publicContract',
  'pluginOwnedTests',
  'config',
  'requestedCapabilities',
] as const;

const SCHEMA_OWNERSHIP_PATHS = new Set<string>(DEFINITION_CONTENT_V1_OWNERSHIP_PATHS);

export const validateFieldOwnership = (entries: readonly FieldOwnership[]): void => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`duplicate ownership path: ${entry.path}`);
    for (const previous of seen) {
      if (previous.startsWith(`${entry.path}.`) || entry.path.startsWith(`${previous}.`)) {
        throw new Error(`parent/child ownership conflict: ${previous} and ${entry.path}`);
      }
    }
    if (!SCHEMA_OWNERSHIP_PATHS.has(entry.path)) {
      throw new Error(`ownership path is not in DefinitionContent v1: ${entry.path}`);
    }
    if (
      (entry.owner === 'definition-author' && entry.visibility !== 'visible') ||
      (entry.owner !== 'definition-author' && entry.visibility !== 'hidden')
    ) throw new Error(`owner and visibility conflict: ${entry.path}`);
    seen.add(entry.path);
  }
  for (const path of SCHEMA_OWNERSHIP_PATHS) {
    if (!seen.has(path)) throw new Error(`missing ownership path: ${path}`);
  }
};
