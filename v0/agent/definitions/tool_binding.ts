import { ManagedDefinitionError } from './managed_definition_importer.ts';
import {
  isToolIdentity,
  type ManagedToolDefinitionManifestV1,
} from './managed_tool_definition_manifest.ts';
import {
  type ManagedToolDefinitionRevision,
  ManagedToolDefinitionStore,
} from './managed_tool_definition_store.ts';
import { DefinitionSelectorError } from './definition_selector.ts';
import { parseToolDefinitionRevisionSelector } from './tool_definition_selector.ts';
import type { ToolDefinitionRevisionRef } from './managed_resource_ref.ts';

export const TOOL_BINDING_FILE = 'tools.json';

export type ToolBindingErrorCode =
  | 'binding_invalid'
  | 'binding_tool_unknown'
  | 'binding_definition_not_found'
  | 'binding_definition_invalid';

export class ToolBindingError extends Error {
  constructor(
    readonly code: ToolBindingErrorCode,
    message: string,
    readonly toolIdentity?: string,
    readonly definition?: ToolDefinitionRevisionRef,
  ) {
    super(message);
    this.name = 'ToolBindingError';
  }
}

export interface ToolBindingsFileV1 {
  readonly schemaVersion: 1;
  readonly bindings: Readonly<Record<string, string>>;
}

export interface ResolvedToolDefinitionBinding {
  readonly toolIdentity: string;
  readonly ref: ToolDefinitionRevisionRef;
  readonly revision: ManagedToolDefinitionRevision;
}

export const toolBindingsPath = (configRoot: string): string =>
  `${configRoot}/${TOOL_BINDING_FILE}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const invalid = (message: string): ToolBindingError =>
  new ToolBindingError('binding_invalid', message);

const parseBindingsFile = (value: unknown): ToolBindingsFileV1 => {
  if (!isRecord(value)) throw invalid('tool binding file is not an object');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'bindings' || keys[1] !== 'schemaVersion') {
    throw invalid('tool binding file has unexpected keys');
  }
  if (value.schemaVersion !== 1 || !isRecord(value.bindings)) {
    throw invalid('tool binding file is not schema version 1');
  }
  const bindings: Record<string, string> = {};
  for (const [toolIdentity, selector] of Object.entries(value.bindings)) {
    if (!isToolIdentity(toolIdentity)) {
      throw new ToolBindingError(
        'binding_tool_unknown',
        'tool identity is not known',
        toolIdentity,
      );
    }
    if (typeof selector !== 'string' || selector.length === 0) {
      throw invalid('tool binding selector is not a string');
    }
    bindings[toolIdentity] = selector;
  }
  return Object.freeze({ schemaVersion: 1 as const, bindings: Object.freeze(bindings) });
};

/** Read Host-owned tool definition bindings; a missing file means no bindings. */
export const readToolBindings = async (configRoot: string): Promise<ToolBindingsFileV1> => {
  let text: string;
  try {
    text = await Deno.readTextFile(toolBindingsPath(configRoot));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return Object.freeze({ schemaVersion: 1 as const, bindings: Object.freeze({}) });
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('tool binding file is not valid JSON');
  }
  return parseBindingsFile(parsed);
};

const mapStoreError = (
  toolIdentity: string,
  ref: ToolDefinitionRevisionRef,
  error: ManagedDefinitionError,
): ToolBindingError =>
  new ToolBindingError(
    error.code === 'module_not_found'
      ? 'binding_definition_not_found'
      : 'binding_definition_invalid',
    error.message,
    toolIdentity,
    ref,
  );

const resolveBinding = async (
  store: ManagedToolDefinitionStore,
  toolIdentity: string,
  selector: string,
): Promise<ResolvedToolDefinitionBinding> => {
  let ref: ToolDefinitionRevisionRef;
  try {
    ref = parseToolDefinitionRevisionSelector(selector);
  } catch (error) {
    if (error instanceof DefinitionSelectorError) {
      throw invalid(`tool ${toolIdentity} selector is not a managed tool Definition selector`);
    }
    throw error;
  }
  let revision: ManagedToolDefinitionRevision;
  try {
    revision = await store.resolve(ref);
  } catch (error) {
    if (error instanceof ManagedDefinitionError) {
      throw mapStoreError(toolIdentity, ref, error);
    }
    throw error;
  }
  const manifest: ManagedToolDefinitionManifestV1 = revision.manifest;
  if (manifest.toolIdentity !== toolIdentity) {
    throw new ToolBindingError(
      'binding_definition_invalid',
      `tool ${toolIdentity} binding resolved a ${manifest.toolIdentity} Definition`,
      toolIdentity,
      ref,
    );
  }
  return Object.freeze({ toolIdentity, ref: structuredClone(ref), revision });
};

/** Resolve one configured tool identity binding, if any. */
export const resolveToolDefinitionBinding = async (
  configRoot: string,
  dataRoot: string,
  toolIdentity: string,
): Promise<ResolvedToolDefinitionBinding | undefined> => {
  const file = await readToolBindings(configRoot);
  const selector = file.bindings[toolIdentity];
  if (selector === undefined) return undefined;
  return await resolveBinding(new ManagedToolDefinitionStore({ dataRoot }), toolIdentity, selector);
};

/** Resolve every configured tool definition binding to one exact managed revision. */
export const resolveToolDefinitionBindings = async (
  configRoot: string,
  dataRoot: string,
): Promise<ReadonlyMap<string, ResolvedToolDefinitionBinding>> => {
  const file = await readToolBindings(configRoot);
  const store = new ManagedToolDefinitionStore({ dataRoot });
  const resolved = new Map<string, ResolvedToolDefinitionBinding>();
  for (const [toolIdentity, selector] of Object.entries(file.bindings)) {
    resolved.set(toolIdentity, await resolveBinding(store, toolIdentity, selector));
  }
  return resolved;
};

/** Read one configured tool identity binding ref, if any. */
export const readToolBindingRef = async (
  configRoot: string,
  toolIdentity: string,
): Promise<ToolDefinitionRevisionRef | undefined> => {
  const file = await readToolBindings(configRoot);
  const selector = file.bindings[toolIdentity];
  if (selector === undefined) return undefined;
  try {
    return parseToolDefinitionRevisionSelector(selector);
  } catch (error) {
    if (error instanceof DefinitionSelectorError) {
      throw invalid(`tool ${toolIdentity} selector is not a managed tool Definition selector`);
    }
    throw error;
  }
};

const writeBindingsFile = async (
  configRoot: string,
  bindings: Readonly<Record<string, string>>,
): Promise<void> => {
  try {
    await Deno.mkdir(configRoot, { recursive: true, mode: 0o700 });
    const staging = `${configRoot}/.tools-${crypto.randomUUID().toLowerCase()}.json`;
    await Deno.writeTextFile(
      staging,
      `${JSON.stringify({ schemaVersion: 1, bindings }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await Deno.rename(staging, toolBindingsPath(configRoot));
  } catch (error) {
    throw new ToolBindingError(
      'binding_invalid',
      `tool binding file could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/** Bind one tool identity to an exact managed tool Definition revision. */
export const writeToolBindingRef = async (
  configRoot: string,
  toolIdentity: string,
  ref: ToolDefinitionRevisionRef,
): Promise<void> => {
  if (!isToolIdentity(toolIdentity)) {
    throw new ToolBindingError('binding_tool_unknown', 'tool identity is not known', toolIdentity);
  }
  const file = await readToolBindings(configRoot);
  const bindings: Record<string, string> = { ...file.bindings };
  bindings[toolIdentity] = `${ref.resourceId}@sha256:${ref.revision.digest}`;
  await writeBindingsFile(configRoot, bindings);
};

/** Remove one tool identity binding, restoring the bundled default for that identity. */
export const deactivateToolBinding = async (
  configRoot: string,
  toolIdentity: string,
): Promise<void> => {
  if (!isToolIdentity(toolIdentity)) {
    throw new ToolBindingError('binding_tool_unknown', 'tool identity is not known', toolIdentity);
  }
  const file = await readToolBindings(configRoot);
  if (!Object.hasOwn(file.bindings, toolIdentity)) return;
  const bindings: Record<string, string> = { ...file.bindings };
  delete bindings[toolIdentity];
  await writeBindingsFile(configRoot, bindings);
};

const REVISION_PREFIX = /^([0-9a-f]{1,64})$/u;

/** Resolve a revision prefix against installed revisions for one resource id. */
export const resolveToolDefinitionRevisionDigest = (
  installed: readonly { readonly resourceId: string; readonly digest: string }[],
  resourceId: string,
  prefix: string,
): string => {
  const match = REVISION_PREFIX.exec(prefix);
  if (match === null) throw invalid('revision prefix is invalid');
  const matches = installed.filter((item) =>
    item.resourceId === resourceId && item.digest.startsWith(match[1])
  );
  if (matches.length === 0) {
    throw new ToolBindingError(
      'binding_definition_not_found',
      'no installed tool Definition revision matches the selector',
    );
  }
  if (matches.length > 1) throw invalid('revision prefix is ambiguous');
  return matches[0].digest;
};
