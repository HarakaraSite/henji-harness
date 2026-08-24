import { type DefinitionContentV1, normalizeDefinitionContent } from './definition_content.ts';
import { contentHash } from './canonical_content.ts';

export interface RevisionViewV1 {
  readonly source: DefinitionContentV1['source'];
  readonly manifest: DefinitionContentV1['manifest'];
  readonly pluginOwnedTests: DefinitionContentV1['pluginOwnedTests'];
  readonly config: DefinitionContentV1['config'];
}

const clone = <T>(value: T): T => structuredClone(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const requireExactKeys = (value: unknown, keys: readonly string[], path: string) => {
  if (!isPlainObject(value)) throw new Error(`${path}: requires a plain object`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) throw new Error(`${path}: requires exactly ${keys.join(', ')}`);
  return value;
};

const validateFullViewShape = (value: unknown): Record<string, unknown> => {
  const view = requireExactKeys(
    value,
    ['source', 'manifest', 'pluginOwnedTests', 'config'],
    '$view',
  );
  requireExactKeys(view.source, ['mediaType', 'text'], '$view.source');
  requireExactKeys(view.manifest, ['displayName', 'description'], '$view.manifest');
  if (!Array.isArray(view.pluginOwnedTests)) {
    throw new Error('$view.pluginOwnedTests: requires array');
  }
  for (let index = 0; index < view.pluginOwnedTests.length; index++) {
    requireExactKeys(
      view.pluginOwnedTests[index],
      ['name', 'input', 'expectedOutput'],
      `$view.pluginOwnedTests[${index}]`,
    );
  }
  if (!isPlainObject(view.config)) throw new Error('$view.config: requires a plain object');
  return view;
};

export const projectRevisionView = (base: DefinitionContentV1): RevisionViewV1 => ({
  source: clone(base.source),
  manifest: clone(base.manifest),
  pluginOwnedTests: clone(base.pluginOwnedTests),
  config: clone(base.config),
});

export const resolveRevisionView = async (
  baseInput: unknown,
  expectedBaseHash: string,
  viewInput: unknown,
): Promise<DefinitionContentV1> => {
  const base = normalizeDefinitionContent(baseInput);
  if (await contentHash(base) !== expectedBaseHash) {
    throw new Error('exact base content hash mismatch');
  }
  const view = validateFullViewShape(viewInput);
  return normalizeDefinitionContent({
    schemaVersion: base.schemaVersion,
    identity: clone(base.identity),
    source: clone(view.source),
    manifest: clone(view.manifest),
    publicContract: clone(base.publicContract),
    pluginOwnedTests: clone(view.pluginOwnedTests),
    config: clone(view.config),
    requestedCapabilities: clone(base.requestedCapabilities),
  });
};
