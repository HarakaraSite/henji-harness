export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface DefinitionContentV1 {
  readonly schemaVersion: 'definition-content/v1';
  readonly identity: {
    readonly pluginId: string;
    readonly namespace: string;
    readonly kind: 'text-transform';
  };
  readonly source: {
    readonly mediaType: 'application/typescript';
    readonly text: string;
  };
  readonly manifest: {
    readonly displayName: string;
    readonly description: string;
  };
  readonly publicContract: {
    readonly input: 'text';
    readonly output: 'text';
  };
  readonly pluginOwnedTests: readonly {
    readonly name: string;
    readonly input: string;
    readonly expectedOutput: string;
  }[];
  readonly config: JsonObject;
  readonly requestedCapabilities: readonly [];
}

export class DefinitionContentError extends Error {
  override readonly name = 'DefinitionContentError';
}

const fail = (path: string, message: string): never => {
  throw new DefinitionContentError(`${path}: ${message}`);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const objectAt = (value: unknown, path: string): Record<string, unknown> =>
  isPlainObject(value) ? value : fail(path, 'requires a plain object');

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
) => {
  const allowed = new Set([...required, ...optional]);
  for (const rawKey of Reflect.ownKeys(value)) {
    if (typeof rawKey !== 'string' || !allowed.has(rawKey)) {
      fail(path, `unknown field ${String(rawKey)}`);
    }
    const key = rawKey as string;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail(`${path}.${key}`, 'requires an enumerable data property');
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
};

export const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
};

const stringAt = (value: unknown, path: string, normalizeNfc = false): string => {
  if (typeof value !== 'string') fail(path, 'requires a string');
  const text = value as string;
  if (hasLoneSurrogate(text)) fail(path, 'contains a lone surrogate');
  return normalizeNfc ? text.normalize('NFC') : text;
};

const literalAt = <T extends string>(value: unknown, literal: T, path: string): T =>
  value === literal ? literal : fail(path, `requires literal ${JSON.stringify(literal)}`);

const normalizeJsonValue = (
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue => {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return stringAt(value, path);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'requires a finite IEEE 754 number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || value === null) fail(path, 'requires a JSON value');
  const container = value as object;
  if (ancestors.has(container)) fail(path, 'contains a cycle');
  ancestors.add(container);
  try {
    if (Array.isArray(value)) {
      const items: JsonValue[] = [];
      const allowedKeys = new Set<PropertyKey>(['length']);
      for (let index = 0; index < value.length; index++) allowedKeys.add(String(index));
      for (const key of Reflect.ownKeys(value)) {
        if (!allowedKeys.has(key)) fail(path, `array has non-JSON property ${String(key)}`);
      }
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) fail(`${path}[${index}]`, 'sparse arrays are not supported');
        const itemDescriptor = descriptor as PropertyDescriptor;
        if (!itemDescriptor.enumerable || !('value' in itemDescriptor)) {
          fail(`${path}[${index}]`, 'requires an enumerable data property');
        }
        items.push(normalizeJsonValue(itemDescriptor.value, `${path}[${index}]`, ancestors));
      }
      return items;
    }
    const object = objectAt(value, path);
    const result: Record<string, JsonValue> = {};
    for (const rawKey of Reflect.ownKeys(object)) {
      if (typeof rawKey !== 'string') fail(path, 'symbol keys are not supported');
      const key = rawKey as string;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail(`${path}.${key}`, 'requires an enumerable data property');
      }
      const dataDescriptor = descriptor as PropertyDescriptor & { value: unknown };
      stringAt(key, `${path} key`);
      result[key] = normalizeJsonValue(dataDescriptor.value, `${path}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(container);
  }
};

export const normalizeJsonObject = (value: unknown, path = 'config'): JsonObject => {
  const normalized = normalizeJsonValue(objectAt(value, path), path, new WeakSet());
  return normalized as JsonObject;
};

export const normalizeDefinitionContent = (value: unknown): DefinitionContentV1 => {
  const root = objectAt(value, '$');
  exactKeys(
    root,
    ['schemaVersion', 'identity', 'source', 'manifest', 'publicContract'],
    ['pluginOwnedTests', 'config', 'requestedCapabilities'],
    '$',
  );

  const identity = objectAt(root.identity, '$.identity');
  exactKeys(identity, ['pluginId', 'namespace', 'kind'], [], '$.identity');

  const source = objectAt(root.source, '$.source');
  exactKeys(source, ['mediaType', 'text'], [], '$.source');

  const manifest = objectAt(root.manifest, '$.manifest');
  exactKeys(manifest, ['displayName'], ['description'], '$.manifest');

  const publicContract = objectAt(root.publicContract, '$.publicContract');
  exactKeys(publicContract, ['input', 'output'], [], '$.publicContract');

  const rawTests = root.pluginOwnedTests ?? [];
  if (!Array.isArray(rawTests)) fail('$.pluginOwnedTests', 'requires an array');
  const tests = rawTests as unknown[];
  const pluginOwnedTests = tests.map((rawTest, index) => {
    const path = `$.pluginOwnedTests[${index}]`;
    const test = objectAt(rawTest, path);
    exactKeys(test, ['name', 'input', 'expectedOutput'], [], path);
    return {
      name: stringAt(test.name, `${path}.name`, true),
      input: stringAt(test.input, `${path}.input`, true),
      expectedOutput: stringAt(test.expectedOutput, `${path}.expectedOutput`, true),
    };
  });

  const rawCapabilities = root.requestedCapabilities ?? [];
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length !== 0) {
    fail('$.requestedCapabilities', 'must be an empty array in Spike 0');
  }

  const sourceText = stringAt(source.text, '$.source.text').replace(/^\uFEFF/, '').replace(
    /\r\n?/g,
    '\n',
  );

  return {
    schemaVersion: literalAt(root.schemaVersion, 'definition-content/v1', '$.schemaVersion'),
    identity: {
      pluginId: stringAt(identity.pluginId, '$.identity.pluginId'),
      namespace: stringAt(identity.namespace, '$.identity.namespace'),
      kind: literalAt(identity.kind, 'text-transform', '$.identity.kind'),
    },
    source: {
      mediaType: literalAt(source.mediaType, 'application/typescript', '$.source.mediaType'),
      text: sourceText,
    },
    manifest: {
      displayName: stringAt(manifest.displayName, '$.manifest.displayName', true),
      description: stringAt(manifest.description ?? '', '$.manifest.description', true),
    },
    publicContract: {
      input: literalAt(publicContract.input, 'text', '$.publicContract.input'),
      output: literalAt(publicContract.output, 'text', '$.publicContract.output'),
    },
    pluginOwnedTests,
    config: normalizeJsonObject(root.config ?? {}, '$.config'),
    requestedCapabilities: [],
  };
};
