import { DefinitionSelectorError, parseRevisionSelectorParts } from './definition_selector.ts';
import {
  isExternalToolDefinitionResourceId,
  type ToolDefinitionRevisionRef,
} from './managed_resource_ref.ts';

/** Parse one `<moduleId>@sha256:<digest>` selector into a tool Definition ref. */
export const parseToolDefinitionRevisionSelector = (
  value: string,
): ToolDefinitionRevisionRef => {
  const parts = parseRevisionSelectorParts(value);
  if (parts === undefined || !isExternalToolDefinitionResourceId(parts.resourceId)) {
    throw new DefinitionSelectorError();
  }
  return {
    schemaVersion: 1,
    resourceKind: 'tool-definition',
    resourceId: parts.resourceId,
    revision: { algorithm: 'sha256', digest: parts.digest },
  };
};
