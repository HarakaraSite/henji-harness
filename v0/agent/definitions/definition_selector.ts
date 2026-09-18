import {
  type DefinitionRevisionRef,
  isExternalDefinitionResourceId,
} from './managed_resource_ref.ts';

const REVISION_MARKER = '@sha256:';
const SHA256 = /^[0-9a-f]{64}$/u;

/** Invalid `<moduleId>@sha256:<digest>` selector. */
export class DefinitionSelectorError extends Error {
  constructor() {
    super('invalid Definition selector');
    this.name = 'DefinitionSelectorError';
  }
}

export const parseRevisionSelectorParts = (
  value: string,
): { readonly resourceId: string; readonly digest: string } | undefined => {
  const marker = value.lastIndexOf(REVISION_MARKER);
  const resourceId = marker < 0 ? '' : value.slice(0, marker);
  const digest = marker < 0 ? '' : value.slice(marker + REVISION_MARKER.length);
  if (resourceId.length === 0 || !SHA256.test(digest)) return undefined;
  return { resourceId, digest };
};

export const parseDefinitionRevisionSelector = (value: string): DefinitionRevisionRef => {
  const parts = parseRevisionSelectorParts(value);
  if (parts === undefined || !isExternalDefinitionResourceId(parts.resourceId)) {
    throw new DefinitionSelectorError();
  }
  return {
    schemaVersion: 1,
    resourceKind: 'agent-definition',
    resourceId: parts.resourceId,
    revision: { algorithm: 'sha256', digest: parts.digest },
  };
};
