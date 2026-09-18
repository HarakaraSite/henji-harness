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

export const parseDefinitionRevisionSelector = (value: string): DefinitionRevisionRef => {
  const marker = value.lastIndexOf(REVISION_MARKER);
  const resourceId = marker < 0 ? '' : value.slice(0, marker);
  const digest = marker < 0 ? '' : value.slice(marker + REVISION_MARKER.length);
  if (!isExternalDefinitionResourceId(resourceId) || !SHA256.test(digest)) {
    throw new DefinitionSelectorError();
  }
  return {
    schemaVersion: 1,
    resourceKind: 'agent-definition',
    resourceId,
    revision: { algorithm: 'sha256', digest },
  };
};
